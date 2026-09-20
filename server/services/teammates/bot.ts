import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { BotAccount } from './accounts.js';
import { BotApi } from './apiClient.js';
import { brainStats, decide } from './brain.js';
import { execute } from './executor.js';
import { pickSeconds, type BotParams } from './intellect.js';
import { createMemory, type BotMemory, type TeamBoard } from './memory.js';
import { loadCharter, perceive, type SessionContext, type Situation } from './perception.js';
import { triage, type TriageItem } from './triage.js';
import type { BotStats, BotStatus, TeamCharterView } from './types.js';

/**
 * One AI teammate (docs/ai-teammate-bots-plan.md §5, §9).
 *
 * The loop is: perceive → triage → decide → execute → remember → sleep. Sleep is
 * the intellect cadence, but events (`wake`) can pull the next turn forward
 * after a human-feeling reaction delay. A turn never throws out of the loop; a
 * failing bot slows down and keeps going.
 */

export interface BotDeps {
  sessionId: string;
  account: BotAccount;
  getParams: () => Promise<BotParams>;
  getSessionCtx: () => Promise<SessionContext | null>;
  getBoard: (teamName: string | null) => TeamBoard | null;
  /** Session-wide claims shared across teams (emails / DMs to the whole organisation). */
  getSessionBoard: () => TeamBoard;
  isLead: () => boolean;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const CHARTER_TTL_MS = 5 * 60_000;
const FAIL_PAUSE_MS = 60_000;
const SHORTLIST = 4;

export class PlayerBot {
  readonly userId: string;
  readonly api: BotApi;
  readonly memory: BotMemory = createMemory();
  status: BotStatus = 'idle';
  readonly stats: BotStats = {
    actions: 0,
    failures: 0,
    byKind: {},
    llmCalls: 0,
    llmFallbacks: 0,
    lastAction: null,
    lastError: null,
  };
  teamName: string | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextTurnAt = 0;
  private turnInFlight = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private charter: {
    value: TeamCharterView | null;
    loadedAt: number;
    knowsRubric: boolean;
  } | null = null;
  private pendingNudge: string | null = null;

  constructor(private readonly deps: BotDeps) {
    this.userId = deps.account.userId;
    this.api = new BotApi(this.userId, deps.sessionId);
  }

  get name(): string {
    return this.deps.account.persona.fullName;
  }

  start(initialDelayMs: number): void {
    this.stopped = false;
    if (this.status === 'paused') return;
    this.status = 'idle';
    this.schedule(initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  pause(): void {
    this.status = 'paused';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    if (this.stopped) return;
    if (this.status !== 'paused') return;
    this.status = 'idle';
    this.schedule(2_000 + Math.random() * 5_000);
  }

  /** Force a charter re-read on the next turn (team reassignment, score update). */
  invalidateCharter(): void {
    this.charter = null;
  }

  /**
   * Pull the next turn forward. Ignored when a sooner turn is already scheduled,
   * so a burst of events collapses into one reaction.
   */
  wake(reason: string, delayMs: number): void {
    if (this.stopped || this.status === 'paused') return;
    const at = Date.now() + delayMs;
    if (this.turnInFlight) return;
    if (this.timer && this.nextTurnAt <= at) return;
    this.deps.log(`${this.name}: waking for ${reason} in ${Math.round(delayMs / 1000)}s`);
    this.schedule(delayMs);
  }

  /** Trainer instruction; handled as the top item on the next turn. */
  nudge(text: string, delayMs: number): void {
    this.pendingNudge = text;
    this.wake('trainer nudge', delayMs);
  }

  /**
   * After a restart the in-memory board is empty; rebuild "we already posted a
   * plan" and "I spoke recently" from the team channel so bots do not repeat
   * themselves.
   */
  private resumeBoardFromChat(board: TeamBoard | null, sit: Situation): void {
    if (this.memory.lastChatAt === 0) {
      const mine = sit.chat.recent.filter((m) => m.sender_id === this.userId);
      const last = mine[mine.length - 1];
      if (last) this.memory.lastChatAt = new Date(last.created_at).getTime();
    }
    if (board && board.planPostedAt === 0) {
      const plan = sit.chat.recent
        .filter(
          (m) =>
            /\bplan\b/i.test(m.content ?? '') &&
            (m.sender?.team_name ?? sit.me.teamName) === sit.me.teamName,
        )
        .pop();
      if (plan) {
        board.plan = plan.content;
        board.planPostedAt = new Date(plan.created_at).getTime();
      }
    }
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextTurnAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.turn();
    }, ms);
  }

  private async turn(): Promise<void> {
    if (this.stopped || this.status === 'paused' || this.turnInFlight) return;
    this.turnInFlight = true;
    this.status = 'acting';
    let cadenceMs = 90_000;
    try {
      const params = await this.deps.getParams();
      cadenceMs = pickSeconds(params.cadenceSec) * 1000;

      const sessionCtx = await this.deps.getSessionCtx();
      if (!sessionCtx) {
        this.deps.log(`${this.name}: session context unavailable, retrying later`);
        return;
      }

      if (
        !this.charter ||
        Date.now() - this.charter.loadedAt > CHARTER_TTL_MS ||
        this.charter.knowsRubric !== params.knowsRubric
      ) {
        const value = await loadCharter(this.deps.sessionId, this.userId, params.knowsRubric);
        this.charter = { value, loadedAt: Date.now(), knowsRubric: params.knowsRubric };
        this.teamName = value?.team_name ?? null;
      }

      const sit = await perceive({
        api: this.api,
        userId: this.userId,
        displayName: this.name,
        memory: this.memory,
        params,
        charter: this.charter.value,
        sessionCtx,
      });
      const board = this.deps.getBoard(sit.me.teamName);
      const sessionBoard = this.deps.getSessionBoard();
      this.resumeBoardFromChat(board, sit);

      let items: TriageItem[] = triage({
        sit,
        params,
        mem: this.memory,
        board,
        sessionBoard,
        isLead: this.deps.isLead(),
      });
      if (!env.teammateBotsPlanner) {
        // Legacy behaviour: feed-only reactions, no desk work.
        const feedKinds = new Set([
          'reply',
          'flag',
          'like',
          'repost',
          'chat',
          'read_news',
          'statement',
          'idle',
        ]);
        items = items.filter((it) => feedKinds.has(it.kind));
      }
      if (this.pendingNudge) {
        items.unshift({
          priority: 0,
          kind: 'chat',
          targetId: `nudge:${Date.now()}`,
          reason: `the trainer asked: "${this.pendingNudge.slice(0, 200)}"`,
          context: this.pendingNudge,
        });
        this.pendingNudge = null;
      }
      const shortlist = items.slice(0, SHORTLIST);

      const before = { calls: brainStats.calls, fallbacks: brainStats.fallbacks };
      const action = await decide({
        sit,
        params,
        mem: this.memory,
        persona: this.deps.account.persona,
        shortlist,
        plannerOn: env.teammateBotsPlanner,
        sessionId: this.deps.sessionId,
      });
      this.stats.llmCalls += brainStats.calls - before.calls;
      this.stats.llmFallbacks += brainStats.fallbacks - before.fallbacks;

      // Every mention considered this turn is now "seen", answered or not.
      for (const m of sit.chat.mentions) this.memory.seenChat.add(m.id);
      for (const m of sit.chat.nudges) this.memory.seenChat.add(m.id);

      const result = await execute(action, {
        api: this.api,
        sit,
        mem: this.memory,
        board,
        sessionBoard,
        persona: this.deps.account.persona,
        userId: this.userId,
      });

      if (result.ok) {
        this.consecutiveFailures = 0;
        if (action.kind !== 'idle') {
          this.stats.actions++;
          this.stats.byKind[action.kind] = (this.stats.byKind[action.kind] ?? 0) + 1;
          this.stats.lastAction = {
            kind: action.kind,
            at: new Date().toISOString(),
            summary: result.summary,
          };
        }
        this.deps.log(
          `${this.name} (${sit.me.teamName ?? 'no team'}): ${action.kind} — ${result.summary}${action.reason ? ` [${action.reason.slice(0, 100)}]` : ''}`,
        );
      } else {
        this.stats.failures++;
        this.stats.lastError = result.error ?? result.summary;
        this.consecutiveFailures++;
        this.deps.log(`${this.name}: ${action.kind} skipped — ${result.error ?? result.summary}`);
        if (this.consecutiveFailures >= 3) {
          cadenceMs = Math.max(cadenceMs, FAIL_PAUSE_MS);
          this.consecutiveFailures = 0;
        }
      }
    } catch (err) {
      this.stats.failures++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, bot: this.name, sessionId: this.deps.sessionId },
        'teammates: turn failed',
      );
      cadenceMs = Math.max(cadenceMs, FAIL_PAUSE_MS);
    } finally {
      this.turnInFlight = false;
      // pause() may have run while we were awaiting; read the live value, not the narrowed one.
      const current = this.status as BotStatus;
      if (!this.stopped && current !== 'paused') {
        this.status = 'idle';
        this.schedule(cadenceMs);
      }
    }
  }
}
