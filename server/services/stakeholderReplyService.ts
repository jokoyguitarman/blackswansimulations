/**
 * Stakeholder reply service (runtime plan §3.4).
 *
 * Owns the cross-channel conversation log and the character prompt, and drives one model call per
 * player message (via the reconsideration engine) that yields the in-character reply AND the
 * verdicts on the stakeholder's pending injects. Channel adapters (TeamChat here; email and
 * Messenger in their own services) persist the reply in their own tables.
 */
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { getSessionScenarioId, getScenarioSnapshot } from '../lib/scenarioCache.js';
import type { Stakeholder, TeamIdentity } from '../lib/stakeholderContract.js';
import { getTeamIdentity } from './orgRegistryService.js';
import { findById } from './stakeholderService.js';
import { decideAndReply, type ReplyPlan } from './stakeholderReconsiderationService.js';
import { getWebSocketService } from './websocketService.js';
import { createNotification } from './notificationService.js';
import { recordPlayerAction } from './sopCheckerService.js';

export type ConversationChannel = 'email' | 'teamchat' | 'messenger' | 'phone';

export interface ConversationRow {
  id: string;
  channel: ConversationChannel;
  direction: 'player' | 'npc';
  user_id: string | null;
  team_name: string | null;
  function_key: string | null;
  org_key: string | null;
  content: string;
  created_at: string;
}

// ─── Conversation log ────────────────────────────────────────────────────────

export async function getConversationLog(
  sessionId: string,
  stakeholderId: string,
  limit = 40,
): Promise<ConversationRow[]> {
  const { data, error } = await supabaseAdmin
    .from('stakeholder_conversations')
    .select(
      'id, channel, direction, user_id, team_name, function_key, org_key, content, created_at',
    )
    .eq('session_id', sessionId)
    .eq('stakeholder_id', stakeholderId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    logger.warn({ error, sessionId, stakeholderId }, 'getConversationLog failed');
    return [];
  }
  return ((data ?? []) as ConversationRow[]).reverse();
}

export async function appendConversation(row: {
  sessionId: string;
  stakeholderId: string;
  channel: ConversationChannel;
  direction: 'player' | 'npc';
  userId?: string | null;
  identity?: TeamIdentity | null;
  content: string;
  refTable?: string;
  refId?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('stakeholder_conversations').insert({
    session_id: row.sessionId,
    stakeholder_id: row.stakeholderId,
    channel: row.channel,
    direction: row.direction,
    user_id: row.userId ?? null,
    team_name: row.identity?.team_name ?? null,
    function_key: row.identity?.function_key ?? null,
    org_key: row.identity?.org_key ?? null,
    content: row.content,
    ref_table: row.refTable ?? null,
    ref_id: row.refId ?? null,
  });
  if (error) logger.warn({ error, sessionId: row.sessionId }, 'appendConversation failed');
}

/** Has any player written to this stakeholder in this session? */
export async function wasContacted(sessionId: string, stakeholderId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('stakeholder_conversations')
    .select('id')
    .eq('session_id', sessionId)
    .eq('stakeholder_id', stakeholderId)
    .eq('direction', 'player')
    .limit(1);
  return !!data && data.length > 0;
}

// ─── Character prompt ────────────────────────────────────────────────────────

export interface ScenarioCtx {
  description: string;
  org_name: string;
  fact_sheet: Record<string, unknown> | null;
}

export async function loadScenarioCtx(scenarioId: string): Promise<ScenarioCtx> {
  const snapshot = await getScenarioSnapshot(scenarioId);
  return {
    description: snapshot?.description ?? '',
    org_name: String(snapshot?.initial_state.org_name ?? ''),
    fact_sheet: (snapshot?.initial_state.fact_sheet as Record<string, unknown> | undefined) ?? null,
  };
}

// ─── Situational context provider (handover §10.5 R3) ────────────────────────

/**
 * Lets a runtime engine (e.g. the organic executive-decision engine's knowledge state) tell a
 * stakeholder what they currently know and feel about events that are not in their authored
 * record — "you were told this morning that the Johor plant is being suspended; you are angry
 * that HR has not briefed the shift leads". Returned text is appended to the character prompt.
 * Registered once at boot by the owning module; nothing registers by default.
 */
export type StakeholderContextProvider = (
  sessionId: string,
  stakeholder: Stakeholder,
) => Promise<string | null>;

let contextProvider: StakeholderContextProvider | null = null;

export function registerStakeholderContextProvider(
  provider: StakeholderContextProvider | null,
): void {
  contextProvider = provider;
}

/** Merged situational context for a stakeholder: explicit text (if any) + registered provider. */
export async function resolveContext(
  sessionId: string,
  stakeholder: Stakeholder,
  explicit?: string,
): Promise<string> {
  const parts: string[] = [];
  if (explicit?.trim()) parts.push(explicit.trim());
  if (contextProvider) {
    try {
      const provided = await contextProvider(sessionId, stakeholder);
      if (provided?.trim()) parts.push(provided.trim());
    } catch (err) {
      logger.debug({ err, sessionId, stakeholderId: stakeholder.id }, 'Context provider failed');
    }
  }
  return parts.join('\n');
}

export function buildCharacterPrompt(
  s: Stakeholder,
  _log: ConversationRow[],
  ctx: ScenarioCtx,
  extra?: { context?: string },
): string {
  const facts = ctx.fact_sheet as {
    confirmed_facts?: string[];
    unconfirmed_claims?: Array<{ claim: string; status: string }>;
  } | null;
  const confirmed = (facts?.confirmed_facts ?? []).slice(0, 8).join('; ');
  const claims = (facts?.unconfirmed_claims ?? [])
    .slice(0, 5)
    .map((c) => `"${c.claim}" (${c.status})`)
    .join('; ');

  return `You are ${s.name}, ${s.title ? `${s.title} at ` : ''}${s.organisation}. You are a ${s.relationship} of the organisation under crisis${ctx.org_name ? ` (${ctx.org_name})` : ''}. You are an NPC in a crisis-response training simulation; players are staff of that organisation.

Personality and register: ${s.personality || 'professional, realistic, concise'}
Your current posture toward the organisation: ${s.stance || 'neutral, waiting to see how they handle this'}
Things you know and will share if asked:
${s.knowledge.length ? s.knowledge.map((k) => `- ${k}`).join('\n') : '- (nothing beyond public knowledge)'}
Things you will NOT disclose or do, however asked:
${s.will_not_disclose.length ? s.will_not_disclose.map((k) => `- ${k}`).join('\n') : '- (none)'}

Crisis context: ${ctx.description.slice(0, 600)}
${confirmed ? `Confirmed facts (do not contradict): ${confirmed}` : ''}
${claims ? `Unverified public claims: ${claims}` : ''}
${extra?.context ? `\nWhat you currently know and feel about recent events (this overrides your default posture where they conflict):\n${extra.context}\n` : ''}
Conduct rules:
- Stay in character as this specific person on every channel; you remember every previous exchange listed below regardless of channel.
- ${s.relationship === 'internal' ? 'You are ground-level operational staff. Share verified facts, request status, flag constraints. NEVER draft public statements, talking points, suggested messaging or PR strategy for the players — they must craft their own response.' : 'Reflect your own interests and concerns; you are not on the response team and do not coach them on messaging.'}
- ${s.relationship === 'media' ? 'You are a journalist: professional, guarded, you publish when you have something usable.' : 'Be authentic: a real person with limited time and their own agenda.'}
${s.tier === 'roster' ? '- You are one member of a larger workforce, not a spokesperson: reply briefly and personally (2-4 sentences), about your own situation, shift and family; you do not speak for colleagues or negotiate.' : ''}
- Do not invent facts that contradict the confirmed facts. Do not reveal anything from your private situation.`;
}

// ─── Coalescing (≤ 1 judge call per stakeholder per window) ─────────────────

const WINDOW_MS = 45_000;
const SESSION_CAP = 30;
const SESSION_CAP_WINDOW_MS = 10 * 60_000;

const lastRunAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

async function coalesce(key: string, run: () => Promise<void>): Promise<void> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const wait = Math.max(0, (lastRunAt.get(key) ?? 0) + WINDOW_MS - Date.now());
  const p = (async () => {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await run();
    } finally {
      lastRunAt.set(key, Date.now());
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function underSessionCap(sessionId: string): Promise<boolean> {
  const since = new Date(Date.now() - SESSION_CAP_WINDOW_MS).toISOString();
  const { count } = await supabaseAdmin
    .from('stakeholder_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('direction', 'npc')
    .gte('created_at', since);
  return (count ?? 0) < SESSION_CAP;
}

// ─── Core: player message → plan ─────────────────────────────────────────────

export interface PlayerMessageCtx {
  sessionId: string;
  stakeholder: Stakeholder;
  channel: ConversationChannel;
  userId: string;
  content: string;
  subject?: string;
  refTable: string;
  refId: string | null;
  /** Situational context appended to the character prompt (handover §10.5 R3); merged with
   *  whatever the registered context provider returns. */
  context?: string;
}

/**
 * Record a player's message in a stakeholder's conversation log WITHOUT asking for a reply.
 * Used for recipients beyond the reply sample (mass notices, cc'd principals, roster members):
 * they "know" from now on, `wasContacted()` is true, and a later reply of theirs sees the message.
 */
export async function appendPlayerMessage(
  ctx: Omit<PlayerMessageCtx, 'context'>,
  identity?: TeamIdentity | null,
): Promise<void> {
  const resolved =
    identity === undefined
      ? await getTeamIdentity(ctx.sessionId, ctx.userId).catch(() => null)
      : identity;
  await appendConversation({
    sessionId: ctx.sessionId,
    stakeholderId: ctx.stakeholder.id,
    channel: ctx.channel,
    direction: 'player',
    userId: ctx.userId,
    identity: resolved,
    content: ctx.subject ? `Subject: ${ctx.subject}\n${ctx.content}` : ctx.content,
    refTable: ctx.refTable,
    refId: ctx.refId,
  });
}

/**
 * Append the player's message, run ONE coalesced judge call (reply + verdicts) and return the
 * reply plan. The CALLER persists the reply in its channel table and then calls
 * `recordNpcReply`. Returns `should_reply: false` when the engine is disabled, capped, or the
 * model declined. Distribution lists (`kind: 'group'`) never reply — expand them to members first.
 */
export async function handlePlayerMessage(ctx: PlayerMessageCtx): Promise<ReplyPlan> {
  const identity = await getTeamIdentity(ctx.sessionId, ctx.userId).catch(() => null);
  await appendPlayerMessage(ctx, identity);

  const none: ReplyPlan = { should_reply: false, text: '', delay_seconds: 30 };
  if (ctx.stakeholder.kind === 'group') return none;
  if (!env.enableStakeholderEngine || !env.openAiApiKey) return none;
  if (!(await underSessionCap(ctx.sessionId))) {
    logger.debug({ sessionId: ctx.sessionId }, 'Stakeholder engine session cap reached');
    return none;
  }

  const scenarioId = await getSessionScenarioId(ctx.sessionId);
  if (!scenarioId) return none;

  let plan: ReplyPlan = none;
  await coalesce(`${ctx.sessionId}:${ctx.stakeholder.id}`, async () => {
    const log = await getConversationLog(ctx.sessionId, ctx.stakeholder.id);
    const scenarioCtx = await loadScenarioCtx(scenarioId);
    const context = await resolveContext(ctx.sessionId, ctx.stakeholder, ctx.context);
    const result = await decideAndReply({
      sessionId: ctx.sessionId,
      stakeholder: ctx.stakeholder,
      characterPrompt: buildCharacterPrompt(ctx.stakeholder, log, scenarioCtx, { context }),
      log,
      channel: ctx.channel,
      latestPlayerMessage: ctx.content,
      latestSubject: ctx.subject,
      teamIdentity: identity,
    });
    plan = result.plan;
  });
  return plan;
}

/** Call after the reply has been persisted in its channel table. */
export async function recordNpcReply(row: {
  sessionId: string;
  stakeholderId: string;
  channel: ConversationChannel;
  content: string;
  refTable: string;
  refId: string | null;
}): Promise<void> {
  await appendConversation({
    sessionId: row.sessionId,
    stakeholderId: row.stakeholderId,
    channel: row.channel,
    direction: 'npc',
    content: row.content,
    refTable: row.refTable,
    refId: row.refId,
  });
}

// ─── TeamChat adapter (runtime plan §3.3) ────────────────────────────────────

export async function onTeamChatMessage(input: {
  sessionId: string;
  channelId: string;
  stakeholderId: string;
  userId: string;
  content: string;
  messageId: string;
}): Promise<void> {
  const scenarioId = await getSessionScenarioId(input.sessionId);
  if (!scenarioId) return;
  const stakeholder = await findById(scenarioId, input.stakeholderId);
  if (!stakeholder) return;

  // Scoring: a DM to a stakeholder is a detectable player action.
  void recordPlayerAction(
    input.sessionId,
    input.userId,
    'dm_sent',
    input.channelId,
    input.content,
    { channel: 'teamchat', stakeholder_id: stakeholder.id, stakeholder_name: stakeholder.name },
  ).catch(() => undefined);

  const plan = await handlePlayerMessage({
    sessionId: input.sessionId,
    stakeholder,
    channel: 'teamchat',
    userId: input.userId,
    content: input.content,
    refTable: 'chat_messages',
    refId: input.messageId,
  });
  if (!plan.should_reply) return;

  const delayMs = Math.min(45, Math.max(5, plan.delay_seconds)) * 1000;
  setTimeout(async () => {
    try {
      const { data: inserted, error } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          channel_id: input.channelId,
          session_id: input.sessionId,
          sender_id: null,
          sender_stakeholder_id: stakeholder.id,
          sender_display_name: stakeholder.name,
          content: plan.text,
          type: 'text',
        })
        .select('*')
        .single();
      if (error || !inserted) {
        logger.warn(
          { error, channelId: input.channelId },
          'Failed to insert stakeholder chat reply',
        );
        return;
      }
      const message = {
        ...(inserted as Record<string, unknown>),
        sender: { id: `stk:${stakeholder.id}`, full_name: stakeholder.name, role: 'npc' },
      };
      getWebSocketService().messageSent(input.channelId, message);
      await recordNpcReply({
        sessionId: input.sessionId,
        stakeholderId: stakeholder.id,
        channel: 'teamchat',
        content: plan.text,
        refTable: 'chat_messages',
        refId: String(inserted.id),
      });
      await createNotification({
        sessionId: input.sessionId,
        userId: input.userId,
        type: 'chat_message',
        title: stakeholder.name,
        message: plan.text.slice(0, 100) + (plan.text.length > 100 ? '…' : ''),
        priority: 'low',
        metadata: {
          channel_id: input.channelId,
          channel_type: 'npc_direct',
          stakeholder_id: stakeholder.id,
          message_id: inserted.id,
        },
        actionUrl: `/sessions/${input.sessionId}#chat`,
      });
    } catch (err) {
      logger.warn({ err, channelId: input.channelId }, 'Stakeholder chat reply delivery failed');
    }
  }, delayMs);
}
