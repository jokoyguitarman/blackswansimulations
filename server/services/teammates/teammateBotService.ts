import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { getWebSocketService, type WebSocketEvent } from '../websocketService.js';
import { ensurePool, getAccount, type BotAccount } from './accounts.js';
import { PlayerBot } from './bot.js';
import { ensurePageHolder, listSessionBots, type SessionBotRow } from './enrol.js';
import {
  clampIntellect,
  DEFAULT_INTELLECT,
  intellectToParams,
  pickSeconds,
  type BotParams,
} from './intellect.js';
import { createBoard, type TeamBoard } from './memory.js';
import { budgetStatus, forgetBudget } from './llmQueue.js';
import { forgetSessionContext, handleFor, loadSessionContext } from './perception.js';
import type { BotStats, BotStatus } from './types.js';

/**
 * Runtime owner for AI teammates (docs/ai-teammate-bots-plan.md §6.1, D2, D10).
 *
 * A 60-second reconciler is the source of truth: every in-progress social
 * session with bot participants gets a runtime; finished sessions lose theirs.
 * Lobby edits and session status changes call `onBotsChanged` for immediacy,
 * but nothing depends on those hooks firing — a restart recovers within a tick.
 */

const TICK_MS = 60_000;
const INTELLECT_TTL_MS = 10_000;

interface ChannelMeta {
  type: string;
  teamName: string | null;
  members: string[];
}

interface SessionRuntime {
  sessionId: string;
  bots: Map<string, PlayerBot>;
  boards: Map<string, TeamBoard>;
  /** Cross-team claims: an email or DM to the whole organisation is answered once. */
  sessionBoard: TeamBoard;
  eventHandler: ((event: WebSocketEvent) => void) | null;
  /**
   * Chat channels we listen to. Chat broadcasts go to `channel:<id>` on the internal bus, not to
   * the session room, so each team / all-teams / 1:1 channel needs its own subscription.
   */
  channelSubs: Map<string, { handler: (event: WebSocketEvent) => void; meta: ChannelMeta }>;
  intellect: { value: number; loadedAt: number } | null;
  startedAt: number;
  /** Order bots were added in; the first bot on a team is that team's lead. */
  order: string[];
}

export interface BotView {
  user_id: string;
  display_name: string;
  team_name: string | null;
  status: BotStatus;
  is_ready: boolean;
  slot: number | null;
  stats: BotStats | null;
}

export interface TeamSeatView {
  team_name: string;
  team_description: string | null;
  max_participants: number | null;
  members: number;
  bots: number;
}

export interface SessionBotsView {
  enabled: boolean;
  running: boolean;
  intellect: number;
  max_per_session: number;
  llm_budget: { used: number; limit: number; resets_in_ms: number };
  teams: TeamSeatView[];
  bots: BotView[];
}

class TeammateBotService {
  private runtimes = new Map<string, SessionRuntime>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  startReconciler(): void {
    if (this.interval || !env.enableTeammateBots) return;
    this.interval = setInterval(() => void this.reconcile(), TICK_MS);
    // Warm the pool and pick up in-flight sessions shortly after boot.
    setTimeout(() => {
      ensurePool().catch((err) => logger.warn({ err }, 'teammates: pool warm-up failed'));
      void this.reconcile();
    }, 5_000);
    logger.info('AI teammate bots: reconciler started (every 60s)');
  }

  stopReconciler(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const id of Array.from(this.runtimes.keys())) this.stopRuntime(id);
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** Immediate reconcile for one session (lobby edit, status change). */
  async onBotsChanged(sessionId: string): Promise<void> {
    if (!env.enableTeammateBots) return;
    try {
      const { data } = await supabaseAdmin
        .from('sessions')
        .select('id, status, sim_mode')
        .eq('id', sessionId)
        .maybeSingle();
      if (!data) return this.stopRuntime(sessionId);
      const row = data as { status: string; sim_mode: string | null };
      if (row.status === 'in_progress' && row.sim_mode === 'social_media') {
        await this.syncSession(sessionId);
      } else {
        this.stopRuntime(sessionId);
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'teammates: onBotsChanged failed');
    }
  }

  /** Slider moved: bots read it on their next turn; nothing else to do but drop the cache. */
  onIntellectChanged(sessionId: string, value: number): void {
    const rt = this.runtimes.get(sessionId);
    if (rt) rt.intellect = { value: clampIntellect(value), loadedAt: Date.now() };
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const { data: sessions, error } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('status', 'in_progress')
        .eq('sim_mode', 'social_media');
      if (error) {
        logger.warn({ error }, 'teammates: reconcile session query failed');
        return;
      }
      const live = new Set((sessions ?? []).map((s) => String((s as { id: string }).id)));
      for (const id of live) await this.syncSession(id);
      for (const id of Array.from(this.runtimes.keys())) if (!live.has(id)) this.stopRuntime(id);
    } catch (err) {
      logger.warn({ err }, 'teammates: reconcile failed');
    } finally {
      this.reconciling = false;
    }
  }

  /** Make the runtime for one in-progress session match its bot participants. */
  private async syncSession(sessionId: string): Promise<void> {
    const rows = await listSessionBots(sessionId);
    if (rows.length === 0) {
      this.stopRuntime(sessionId);
      return;
    }
    await ensurePool();
    let rt = this.runtimes.get(sessionId);
    const fresh = !rt;
    if (!rt) {
      rt = {
        sessionId,
        bots: new Map(),
        boards: new Map(),
        sessionBoard: createBoard('*'),
        eventHandler: null,
        channelSubs: new Map(),
        intellect: null,
        startedAt: Date.now(),
        order: [],
      };
      this.runtimes.set(sessionId, rt);
      this.subscribe(rt);
      await ensurePageHolder(sessionId);
      logger.info({ sessionId, bots: rows.length }, 'teammates: runtime started');
    }
    // New team channels and 1:1 chats appear during a session; pick them up every tick.
    await this.syncChannelSubscriptions(rt);

    // Add missing bots, staggered so they do not all fire at once.
    let added = 0;
    for (const row of rows) {
      if (rt.bots.has(row.user_id)) {
        const bot = rt.bots.get(row.user_id)!;
        if (bot.teamName !== row.team_name) bot.invalidateCharter();
        continue;
      }
      const account = await getAccount(row.user_id);
      if (!account) continue;
      const bot = this.createBot(rt, account);
      rt.bots.set(row.user_id, bot);
      rt.order.push(row.user_id);
      bot.start(8_000 + added * 12_000 + Math.random() * 6_000);
      added++;
    }
    // Remove bots that are no longer participants.
    const wanted = new Set(rows.map((r) => r.user_id));
    for (const [id, bot] of rt.bots) {
      if (!wanted.has(id)) {
        bot.stop();
        rt.bots.delete(id);
        rt.order = rt.order.filter((x) => x !== id);
      }
    }
    if (!fresh && added > 0) await ensurePageHolder(sessionId);
  }

  private createBot(rt: SessionRuntime, account: BotAccount): PlayerBot {
    const sessionId = rt.sessionId;
    return new PlayerBot({
      sessionId,
      account,
      getParams: async () => intellectToParams(await this.getIntellect(sessionId)),
      getSessionCtx: () => loadSessionContext(sessionId),
      getBoard: (teamName) => {
        if (!teamName) return null;
        let board = rt.boards.get(teamName);
        if (!board) {
          board = createBoard(teamName);
          rt.boards.set(teamName, board);
        }
        return board;
      },
      getSessionBoard: () => rt.sessionBoard,
      isLead: () => {
        const bot = rt.bots.get(account.userId);
        if (!bot) return false;
        const sameTeam = rt.order.filter((id) => rt.bots.get(id)?.teamName === bot.teamName);
        return sameTeam[0] === account.userId;
      },
      log: (msg, extra) => logger.info({ sessionId, ...(extra ?? {}) }, `[bots] ${msg}`),
    });
  }

  private stopRuntime(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    for (const bot of rt.bots.values()) bot.stop();
    if (rt.eventHandler) getWebSocketService().offSessionEvent(sessionId, rt.eventHandler);
    for (const [channelId, sub] of rt.channelSubs) {
      getWebSocketService().offChannelEvent(channelId, sub.handler);
    }
    rt.channelSubs.clear();
    this.runtimes.delete(sessionId);
    forgetBudget(sessionId);
    forgetSessionContext(sessionId);
    logger.info({ sessionId }, 'teammates: runtime stopped');
  }

  // ─── Intellect ────────────────────────────────────────────────────────────

  async getIntellect(sessionId: string): Promise<number> {
    const rt = this.runtimes.get(sessionId);
    if (rt?.intellect && Date.now() - rt.intellect.loadedAt < INTELLECT_TTL_MS)
      return rt.intellect.value;
    const { data } = await supabaseAdmin
      .from('sessions')
      .select('bot_intellect')
      .eq('id', sessionId)
      .maybeSingle();
    const raw = (data as { bot_intellect?: number | null } | null)?.bot_intellect;
    const value = raw === null || raw === undefined ? DEFAULT_INTELLECT : clampIntellect(raw);
    if (rt) rt.intellect = { value, loadedAt: Date.now() };
    return value;
  }

  // ─── Events (D10) ─────────────────────────────────────────────────────────

  private subscribe(rt: SessionRuntime): void {
    if (!env.teammateBotsReactive) return;
    const handler = (event: WebSocketEvent) => {
      try {
        void this.handleEvent(rt, event);
      } catch (err) {
        logger.debug({ err, type: event.type }, 'teammates: event handler failed');
      }
    };
    rt.eventHandler = handler;
    getWebSocketService().onSessionEvent(rt.sessionId, handler);
  }

  private async handleEvent(rt: SessionRuntime, event: WebSocketEvent): Promise<void> {
    if (rt.bots.size === 0) return;
    const params: BotParams = intellectToParams(await this.getIntellect(rt.sessionId));
    const delay = () => pickSeconds(params.reactionDelaySec) * 1000;
    const data = event.data ?? {};

    switch (event.type) {
      case 'inject.published': {
        const inject = (data.inject ?? {}) as {
          target_teams?: string[] | null;
          inject_scope?: string;
        };
        const targets = (inject.target_teams ?? []).map((t) => t.toLowerCase());
        for (const bot of rt.bots.values()) {
          const team = (bot.teamName ?? '').toLowerCase();
          if (targets.length === 0 || targets.some((t) => team.includes(t) || t.includes(team))) {
            bot.wake('a new inject', delay());
          }
        }
        return;
      }
      case 'social_post.created': {
        const post = (data.post ?? {}) as {
          content_flags?: Record<string, unknown> | null;
          author_type?: string;
        };
        const flags = post.content_flags ?? {};
        const harmful = Boolean(
          flags.is_misinformation ||
          flags.misinformation ||
          flags.is_hate_speech ||
          flags.hate_speech ||
          flags.is_incitement ||
          flags.incites_violence ||
          flags.is_harmful_narrative ||
          flags.is_inflammatory,
        );
        if (!harmful && post.author_type !== 'official_account') return;
        // Only the public-voice / legal side wakes for hostile content; others see it on cadence.
        for (const bot of rt.bots.values()) bot.wake('hostile content', delay() * 1.5);
        return;
      }
      // NPC / inject mail arrives as sim_email.received; a human's mail to a bot arrives as
      // sim_email.sent (routes/socialMedia.ts POST /emails). Both address concrete recipients.
      case 'sim_email.received':
      case 'sim_email.sent': {
        const email = (data.email ?? {}) as {
          recipient_user_ids?: string[] | null;
          sent_by_player_id?: string | null;
        };
        const recipients = email.recipient_user_ids ?? null;
        for (const bot of rt.bots.values()) {
          if (email.sent_by_player_id === bot.userId) continue;
          if (event.type === 'sim_email.sent' && !recipients?.includes(bot.userId)) continue;
          if (!recipients || recipients.includes(bot.userId)) bot.wake('new email', delay());
        }
        return;
      }
      case 'messenger.received': {
        const message = (data.message ?? {}) as {
          recipient_handle?: string;
          sender_handle?: string;
        };
        const to = (message.recipient_handle ?? '').toLowerCase();
        const from = (message.sender_handle ?? '').toLowerCase();
        for (const bot of rt.bots.values()) {
          const mine = handleFor(bot.name).toLowerCase();
          if (from === mine) continue; // my own outbound message
          // Addressed to me: answer promptly. Anything else (a thread with the organisation
          // page, someone else's DM) is left to perception, which knows who holds the page.
          if (to === mine) bot.wake('a direct message to me', delay() * 0.6);
          else bot.wake('a direct message', delay());
        }
        return;
      }
      case 'team_scores.updated':
        for (const bot of rt.bots.values()) bot.invalidateCharter();
        return;
      default:
        return;
    }
  }

  // ─── Chat channel subscriptions ───────────────────────────────────────────

  /**
   * Chat lines are broadcast per channel (`websocketService.messageSent` → `channel:<id>`), never
   * to the session room, so every channel a bot might be spoken to in gets its own listener:
   * the team channels, "All Teams", and 1:1 chats that include a bot. Re-run every reconcile tick
   * so channels created mid-session (a human opening a chat with a bot) are picked up.
   */
  private async syncChannelSubscriptions(rt: SessionRuntime): Promise<void> {
    if (!env.teammateBotsReactive) return;
    try {
      const { data: channels } = await supabaseAdmin
        .from('chat_channels')
        .select('id, type, team_name, members')
        .eq('session_id', rt.sessionId)
        .in('type', ['team', 'inter_agency', 'direct']);
      const botIds = new Set(rt.bots.keys());
      const live = new Set<string>();
      for (const row of channels ?? []) {
        const c = row as {
          id: string;
          type: string;
          team_name: string | null;
          members: string[] | null;
        };
        const members = Array.isArray(c.members) ? c.members.map(String) : [];
        // 1:1 chats only matter when one side is a bot.
        if (c.type === 'direct' && !members.some((m) => botIds.has(m))) continue;
        live.add(c.id);
        const existing = rt.channelSubs.get(c.id);
        const meta: ChannelMeta = { type: c.type, teamName: c.team_name, members };
        if (existing) {
          existing.meta = meta;
          continue;
        }
        const handler = (event: WebSocketEvent) => {
          try {
            void this.handleChannelEvent(rt, c.id, event);
          } catch (err) {
            logger.debug({ err, channelId: c.id }, 'teammates: channel handler failed');
          }
        };
        rt.channelSubs.set(c.id, { handler, meta });
        getWebSocketService().onChannelEvent(c.id, handler);
      }
      for (const [channelId, sub] of rt.channelSubs) {
        if (live.has(channelId)) continue;
        getWebSocketService().offChannelEvent(channelId, sub.handler);
        rt.channelSubs.delete(channelId);
      }
    } catch (err) {
      logger.debug({ err, sessionId: rt.sessionId }, 'teammates: channel subscription sync failed');
    }
  }

  private async handleChannelEvent(
    rt: SessionRuntime,
    channelId: string,
    event: WebSocketEvent,
  ): Promise<void> {
    if (event.type !== 'message.sent' || rt.bots.size === 0) return;
    const sub = rt.channelSubs.get(channelId);
    if (!sub) return;
    const message = ((event.data ?? {}).message ?? {}) as { content?: string; sender_id?: string };
    if (!message.sender_id || rt.bots.has(message.sender_id)) return; // bots do not wake bots
    const params: BotParams = intellectToParams(await this.getIntellect(rt.sessionId));
    const delay = () => pickSeconds(params.reactionDelaySec) * 1000;
    const content = (message.content ?? '').toLowerCase();
    const { meta } = sub;

    if (meta.type === 'direct') {
      // A private message: wake the bot on the other side, promptly.
      for (const bot of rt.bots.values()) {
        if (meta.members.includes(bot.userId)) bot.wake('a private chat message', delay() * 0.5);
      }
      return;
    }
    for (const bot of rt.bots.values()) {
      const first = bot.name.split(/\s+/)[0]?.toLowerCase() ?? '';
      const named = first.length > 2 && new RegExp(`\\b${first}\\b`).test(content);
      const myTeamChannel = meta.type === 'team' && meta.teamName === bot.teamName;
      if (named) bot.wake('a chat mention', delay() * 0.6);
      else if (myTeamChannel) bot.wake('a line in my team channel', delay());
      // All-Teams lines that name nobody are picked up on cadence.
    }
  }

  // ─── Views and controls (routes) ──────────────────────────────────────────

  private async teamSeats(sessionId: string, bots: SessionBotRow[]): Promise<TeamSeatView[]> {
    const { data: session } = await supabaseAdmin
      .from('sessions')
      .select('scenario_id')
      .eq('id', sessionId)
      .maybeSingle();
    const scenarioId = (session as { scenario_id?: string | null } | null)?.scenario_id;
    if (!scenarioId) return [];
    const [{ data: teams }, { data: assignments }] = await Promise.all([
      supabaseAdmin
        .from('scenario_teams')
        .select('team_name, team_description, max_participants')
        .eq('scenario_id', scenarioId)
        .order('team_name', { ascending: true }),
      supabaseAdmin.from('session_teams').select('user_id, team_name').eq('session_id', sessionId),
    ]);
    const botIds = new Set(bots.map((b) => b.user_id));
    const members = new Map<string, number>();
    const botCount = new Map<string, number>();
    for (const a of assignments ?? []) {
      const r = a as { user_id: string; team_name: string };
      members.set(r.team_name, (members.get(r.team_name) ?? 0) + 1);
      if (botIds.has(r.user_id)) botCount.set(r.team_name, (botCount.get(r.team_name) ?? 0) + 1);
    }
    return (teams ?? []).map((t) => {
      const r = t as {
        team_name: string;
        team_description: string | null;
        max_participants: number | null;
      };
      return {
        team_name: r.team_name,
        team_description: r.team_description,
        max_participants: r.max_participants,
        members: members.get(r.team_name) ?? 0,
        bots: botCount.get(r.team_name) ?? 0,
      };
    });
  }

  async view(sessionId: string): Promise<SessionBotsView> {
    const [rows, intellect] = await Promise.all([
      listSessionBots(sessionId),
      this.getIntellect(sessionId),
    ]);
    const teams = await this.teamSeats(sessionId, rows);
    const rt = this.runtimes.get(sessionId);
    const budget = budgetStatus(sessionId);
    return {
      enabled: env.enableTeammateBots,
      running: Boolean(rt),
      intellect,
      max_per_session: env.teammateBotsMaxPerSession,
      llm_budget: { used: budget.used, limit: budget.limit, resets_in_ms: budget.resetsInMs },
      teams,
      bots: rows.map((r: SessionBotRow) => {
        const bot = rt?.bots.get(r.user_id);
        return {
          user_id: r.user_id,
          display_name: r.display_name,
          team_name: r.team_name,
          status: bot ? bot.status : 'stopped',
          is_ready: r.is_ready,
          slot: r.slot,
          stats: bot ? bot.stats : null,
        };
      }),
    };
  }

  pause(sessionId: string, botUserId: string): boolean {
    const bot = this.runtimes.get(sessionId)?.bots.get(botUserId);
    if (!bot) return false;
    bot.pause();
    return true;
  }

  resume(sessionId: string, botUserId: string): boolean {
    const bot = this.runtimes.get(sessionId)?.bots.get(botUserId);
    if (!bot) return false;
    bot.resume();
    return true;
  }

  nudge(sessionId: string, botUserId: string, text: string): boolean {
    const bot = this.runtimes.get(sessionId)?.bots.get(botUserId);
    if (!bot) return false;
    bot.nudge(text, 3_000 + Math.random() * 7_000);
    return true;
  }

  stopBot(sessionId: string, botUserId: string): void {
    const rt = this.runtimes.get(sessionId);
    const bot = rt?.bots.get(botUserId);
    if (!rt || !bot) return;
    bot.stop();
    rt.bots.delete(botUserId);
    rt.order = rt.order.filter((x) => x !== botUserId);
    if (rt.bots.size === 0) this.stopRuntime(sessionId);
  }
}

let instance: TeammateBotService | null = null;

export function getTeammateBotService(): TeammateBotService {
  if (!instance) instance = new TeammateBotService();
  return instance;
}
