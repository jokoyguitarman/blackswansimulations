/**
 * Organic executive decisions — detection (docs/executive-decisions-organic-plan.md §6.1, §6.6).
 *
 * Entry points are called from the email and chat routes (touch points, handover §3) after the
 * player's message is stored. Everything is fire-and-forget from the route's point of view.
 */
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { callSocialCrisisAI } from '../socialCrisisGeneratorService.js';
import { resolveTeamFunction } from '../../lib/stakeholderContract.js';
import { getTeamIdentity } from '../orgRegistryService.js';
import { getSessionPlayerDirectory } from '../playerDirectoryService.js';
import { recordPlayerAction } from '../sopCheckerService.js';
import { emitSessionEvent } from './sessionEventEmitter.js';
import {
  informedFunctions,
  isEligibleAuthor,
  looksLikeFormalNotice,
  normaliseDetection,
  passesPreFilter,
  resolveInformedSet,
  shouldAct,
  slugForDecision,
} from './decisionDetectionCore.js';
import {
  castForPrompt,
  loadDecisionContext,
  type DecisionContextBundle,
} from './decisionContext.js';
import {
  addDecisionEvent,
  existingDecisionKeys,
  getDecision,
  insertDecision,
  listDecisions,
  loadKnowledge,
  saveKnowledge,
  updateDecisionDetail,
} from './decisionLedger.js';
import { expandGroups, learn } from './decisionKnowledgeCore.js';
import type {
  ActorRef,
  DecisionDetail,
  DecisionRecord,
  DecisionSource,
  LearnedVia,
} from './decisionTypes.js';
import { planCascade, applyReversal, cancelPendingCascade } from './decisionPlannerService.js';
import { assessNotice } from './decisionCascadeService.js';

const MAX_DECISIONS_PER_SESSION = 6;
const COALESCE_MS = 20_000;

interface Candidate {
  sessionId: string;
  userId: string;
  threadKey: string;
  texts: string[];
  addresses: string[];
  channelMembers?: Array<{ user_id: string }>;
  directStakeholderId?: string | null;
  sources: DecisionSource[];
  via: LearnedVia;
  timer: NodeJS.Timeout | null;
}
const pending = new Map<string, Candidate>();
/** Threads that produced a non-final candidate (re-evaluated on the next message). */
const threadCandidates = new Set<string>();

// ─── Route entry points ──────────────────────────────────────────────────────

export function onPlayerEmailSent(input: {
  sessionId: string;
  emailId: string;
  userId: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  threadId: string | null;
}): void {
  if (!env.enableExecutiveDecisions) return;
  void enqueue({
    sessionId: input.sessionId,
    userId: input.userId,
    threadKey: `email:${input.threadId || input.emailId}`,
    text: `Subject: ${input.subject}\n${input.bodyText}`,
    addresses: [...input.toAddresses, ...input.ccAddresses],
    source: {
      ref_table: 'sim_emails',
      ref_id: input.emailId,
      excerpt: input.bodyText.slice(0, 280),
    },
    via: 'direct_message',
  }).catch((err) => logger.warn({ err }, 'decision detection (email) failed'));
}

export function onPlayerChatMessage(input: {
  sessionId: string;
  channelId: string;
  channelType: string;
  messageId: string;
  userId: string;
  content: string;
  memberIds: string[];
  stakeholderId?: string | null;
}): void {
  if (!env.enableExecutiveDecisions) return;
  void enqueue({
    sessionId: input.sessionId,
    userId: input.userId,
    threadKey: `chat:${input.channelId}`,
    text: input.content,
    addresses: [],
    channelMembers: input.memberIds.map((user_id) => ({ user_id })),
    directStakeholderId: input.channelType === 'npc_direct' ? (input.stakeholderId ?? null) : null,
    source: {
      ref_table: 'chat_messages',
      ref_id: input.messageId,
      excerpt: input.content.slice(0, 280),
    },
    via: 'direct_message',
  }).catch((err) => logger.warn({ err }, 'decision detection (chat) failed'));
}

async function enqueue(input: {
  sessionId: string;
  userId: string;
  threadKey: string;
  text: string;
  addresses: string[];
  channelMembers?: Array<{ user_id: string }>;
  directStakeholderId?: string | null;
  source: DecisionSource;
  via: LearnedVia;
}): Promise<void> {
  const identity = await getTeamIdentity(input.sessionId, input.userId).catch(() => null);
  const fn = identity ? resolveTeamFunction(identity) : null;
  const ctxLite = await loadDecisionContext(input.sessionId);
  if (
    !ctxLite ||
    ctxLite.session.sim_mode !== 'social_media' ||
    ctxLite.session.status !== 'in_progress'
  )
    return;

  // Formal-notice path (any function; HR-like is the norm): a message to workforce carriers about an
  // active decision is graded and moves knowledge to officially_notified.
  const activeDecisions = (await listDecisions(input.sessionId)).filter(
    (d) => d.status === 'active',
  );
  if (activeDecisions.length > 0) {
    const recipients = recipientStakeholders(ctxLite, input.addresses, input.directStakeholderId);
    for (const d of activeDecisions) {
      if (
        recipients.length > 0 &&
        looksLikeFormalNotice(
          input.text,
          recipients.map((s) => ({
            relationship: s.relationship,
            kind: s.kind === 'group' ? 'group' : 'person',
            title: s.title,
          })),
          d.detail.summary,
        )
      ) {
        await assessNotice(ctxLite, d, {
          userId: input.userId,
          authorFunction: fn,
          recipients,
          text: input.text,
          source: input.source,
        }).catch((err) => logger.warn({ err }, 'notice assessment failed'));
        return; // a notice is not a new decision
      }
    }
  }

  if (!isEligibleAuthor(fn)) return;
  const threadHasCandidate = threadCandidates.has(`${input.sessionId}:${input.threadKey}`);
  if (!passesPreFilter(input.text, threadHasCandidate)) return;

  const key = `${input.sessionId}:${input.userId}:${input.threadKey}`;
  const existing = pending.get(key);
  if (existing) {
    existing.texts.push(input.text);
    existing.addresses.push(...input.addresses);
    existing.sources.push(input.source);
    if (existing.timer) clearTimeout(existing.timer);
  }
  const cand: Candidate = existing ?? {
    sessionId: input.sessionId,
    userId: input.userId,
    threadKey: input.threadKey,
    texts: [input.text],
    addresses: [...input.addresses],
    channelMembers: input.channelMembers,
    directStakeholderId: input.directStakeholderId ?? null,
    sources: [input.source],
    via: input.via,
    timer: null,
  };
  cand.timer = setTimeout(() => {
    pending.delete(key);
    void detectAndRecord(cand, fn).catch((err) =>
      logger.warn({ err, key }, 'decision detection failed'),
    );
  }, COALESCE_MS);
  pending.set(key, cand);
}

function recipientStakeholders(
  ctx: DecisionContextBundle,
  addresses: string[],
  directStakeholderId?: string | null,
) {
  const out = [] as DecisionContextBundle['stakeholders'];
  for (const a of addresses) {
    const s = ctx.stakeholderByEmail.get(a.trim().toLowerCase());
    if (s) out.push(s);
  }
  if (directStakeholderId) {
    const s = ctx.stakeholderById.get(directStakeholderId);
    if (s) out.push(s);
  }
  return out;
}

// ─── Detection ───────────────────────────────────────────────────────────────

async function detectAndRecord(cand: Candidate, authorFunction: string | null): Promise<void> {
  const ctx = await loadDecisionContext(cand.sessionId);
  if (!ctx) return;
  const decisions = await listDecisions(cand.sessionId);
  if (decisions.filter((d) => d.status === 'active').length >= MAX_DECISIONS_PER_SESSION) {
    logger.info({ sessionId: cand.sessionId }, 'decision cap reached; detection skipped');
    return;
  }
  const identity = await getTeamIdentity(cand.sessionId, cand.userId).catch(() => null);
  const text = cand.texts.join('\n---\n').slice(0, 6000);
  const raw = await callSocialCrisisAI(
    `You detect EXECUTIVE DECISIONS in messages written by leaders during a crisis simulation. A decision is a commitment to a course of action that changes the situation for people inside or outside the organisation (close / suspend / recall / lay off / resume / announce / litigate / approve). Floating an idea, asking for options or a conditional ("if X, then we'd...") is NOT final.

Return ONLY valid JSON:
{
  "is_decision": true|false,
  "confidence": 0..1,
  "finality": "final"|"conditional"|"exploratory",
  "summary": "one sentence in the past tense: what was decided (<= 200 chars)",
  "category": "workforce|operations|public_position|legal_action|commercial|governance|other",
  "scope": { "org_key": "<protagonist org_key or null>", "country": "<country or null>", "site_key": "<site or null>", "subject": "<what/where it applies to>" },
  "affected_stakeholder_ids": ["<ids from the cast whose situation this changes>"],
  "should_know_functions": ["<functions that must be told for the organisation to act properly>"],
  "should_know_stakeholder_ids": ["<cast ids who should hear it from the organisation before they hear it elsewhere>"],
  "reverses": "none" | "<decision_key of an earlier decision this undoes>"
}
Use ONLY ids and function names from the lists given. Be conservative: confidence >= 0.7 only when the text commits.`,
    `Author: ${identity?.team_name || 'unknown team'} (${authorFunction || 'unknown function'}), organisation ${identity?.org_key || 'primary'}${identity?.country ? `, ${identity.country}` : ''}.
Crisis: ${ctx.crisisDescription.slice(0, 800)}
Organisations: ${
      ctx.registry
        .filter((o) => o.side === 'protagonist')
        .map((o) => `${o.org_key} = ${o.display_name} (${o.country || '—'})`)
        .join('; ') || 'primary'
    }
Functions in play: ${Array.from(new Set(ctx.teams.map((t) => resolveTeamFunction(t)))).join(', ')}
Earlier decisions this session: ${decisions.map((d) => `${d.decision_key}: ${d.detail.summary}`).join(' | ') || 'none'}

CAST:
${castForPrompt(ctx)}

MESSAGE(S):
${text}`,
    1400,
    0.2,
  );
  const det = normaliseDetection(
    raw,
    new Set(ctx.cast.keys()),
    new Set(ctx.teams.map((t) => resolveTeamFunction(t))),
  );
  if (!shouldAct(det, authorFunction)) {
    if (det.is_decision) threadCandidates.add(`${cand.sessionId}:${cand.threadKey}`);
    logger.info(
      {
        sessionId: cand.sessionId,
        det: { is: det.is_decision, c: det.confidence, f: det.finality },
      },
      'decision not actionable',
    );
    return;
  }
  threadCandidates.delete(`${cand.sessionId}:${cand.threadKey}`);

  const directory = await getSessionPlayerDirectory(cand.sessionId);
  const fnByTeam = new Map(ctx.teams.map((t) => [t.team_name, t.function_key]));
  const informed = resolveInformedSet({
    addresses: cand.addresses,
    players: directory.map((p) => ({
      user_id: p.user_id,
      address: p.address,
      team_name: p.team_name,
      function_key: p.team_name ? (fnByTeam.get(p.team_name) ?? null) : null,
    })),
    stakeholdersByEmail: new Map(
      Array.from(ctx.stakeholderByEmail.entries()).map(([e, s]) => [
        e,
        { id: s.id, kind: s.kind === 'group' ? 'group' : 'person', members: s.members || [] },
      ]),
    ),
    channelMembers: cand.channelMembers?.map((m) => {
      const entry = directory.find((d) => d.user_id === m.user_id);
      return {
        user_id: m.user_id,
        team_name: entry?.team_name ?? null,
        function_key: entry?.team_name ? (fnByTeam.get(entry.team_name) ?? null) : null,
      };
    }),
    directStakeholderId: cand.directStakeholderId,
    authorUserId: cand.userId,
    via: cand.via,
  });

  await recordDecision(ctx, {
    det,
    informed,
    sources: cand.sources,
    authorUserId: cand.userId,
    authorTeam: identity?.team_name ?? null,
    authorFunction,
    orgKey: det.scope.org_key ?? identity?.org_key ?? null,
    byTrainer: false,
  });
}

export async function recordDecision(
  ctx: DecisionContextBundle,
  input: {
    det: ReturnType<typeof normaliseDetection>;
    informed: Array<ActorRef & { via: LearnedVia }>;
    sources: DecisionSource[];
    authorUserId: string;
    authorTeam: string | null;
    authorFunction: string | null;
    orgKey: string | null;
    byTrainer: boolean;
  },
): Promise<DecisionRecord | null> {
  const { det } = input;
  const minute = ctx.elapsedMinutes;
  const taken = await existingDecisionKeys(ctx.session.id);
  const decisionKey = slugForDecision(det.summary, taken);
  let reversesId: string | null = null;
  if (det.reverses) {
    const earlier = (await listDecisions(ctx.session.id)).find(
      (d) => d.decision_key === det.reverses && d.status === 'active',
    );
    reversesId = earlier?.id ?? null;
  }
  const detail: DecisionDetail = {
    summary: det.summary,
    category: det.category,
    confidence: det.confidence,
    finality: det.finality,
    scope: {
      ...det.scope,
      country:
        det.scope.country ?? (input.orgKey ? (ctx.orgCountry.get(input.orgKey) ?? null) : null),
    },
    affected_stakeholder_ids: det.affected_stakeholder_ids,
    should_know_functions: det.should_know_functions,
    should_know_stakeholder_ids: det.should_know_stakeholder_ids,
    informed: input.informed,
    sources: input.sources,
    reverses_decision_id: reversesId,
    detected_at_minute: minute,
    author_user_id: input.authorUserId,
    author_team: input.authorTeam,
    author_function: input.authorFunction,
  };
  const record = await insertDecision({
    sessionId: ctx.session.id,
    orgKey: input.orgKey,
    decisionKey,
    title: det.summary,
    recordedBy: input.authorUserId,
    teamName: input.authorTeam,
    recordedAtMinute: minute,
    recordedByTrainer: input.byTrainer,
    detail,
  });
  if (!record) return null;

  // Knowledge: the author's own team knows; the informed set was told directly.
  const groups = new Map<string, string[]>();
  for (const s of ctx.stakeholders)
    if (s.kind === 'group' && s.members) groups.set(s.id, s.members);
  const knowledge = await loadKnowledge(ctx.session.id, record.id);
  const changed = learn(
    knowledge,
    expandGroups(
      [
        ...(input.authorTeam ? [{ actor_kind: 'team' as const, actor_id: input.authorTeam }] : []),
        ...input.informed.map(({ actor_kind, actor_id }) => ({ actor_kind, actor_id })),
      ],
      groups,
    ),
    'informed',
    'direct_message',
    input.authorUserId,
    minute,
    input.sources[0]
      ? { ref_table: input.sources[0].ref_table, ref_id: input.sources[0].ref_id }
      : undefined,
  );
  await saveKnowledge(ctx.session.id, record.id, changed);

  const detected = await addDecisionEvent({
    session_id: ctx.session.id,
    decision_id: record.id,
    parent_id: null,
    kind: 'detected',
    actor_kind: 'player',
    actor_id: input.authorUserId,
    at_minute: minute,
    ref_table: input.sources[0]?.ref_table ?? null,
    ref_id: input.sources[0]?.ref_id ?? null,
    summary: det.summary,
  });
  for (const a of input.informed) {
    await addDecisionEvent({
      session_id: ctx.session.id,
      decision_id: record.id,
      parent_id: detected.id,
      kind: 'told',
      actor_kind: a.actor_kind,
      actor_id: a.actor_id,
      at_minute: minute,
      ref_table: input.sources[0]?.ref_table ?? null,
      ref_id: input.sources[0]?.ref_id ?? null,
      summary: `Told directly (${a.actor_kind} ${a.actor_id})`,
    });
  }
  const toldFunctions = Array.from(informedFunctions(input.informed, ctx.teams));
  await emitSessionEvent(ctx.session.id, 'decision_detected', 'decision_recorded', {
    description: `Executive decision detected: ${det.summary}`,
    metadata: {
      decision_id: record.id,
      decision_key: decisionKey,
      category: det.category,
      confidence: det.confidence,
      org_key: input.orgKey,
      told_functions: toldFunctions,
      should_know_functions: det.should_know_functions,
      by_trainer: input.byTrainer,
    },
    user_id: input.authorUserId,
  });
  await recordPlayerAction(
    ctx.session.id,
    input.authorUserId,
    'decision_recorded',
    record.id,
    det.summary,
    {
      decision_key: decisionKey,
      category: det.category,
      told_functions: toldFunctions,
      organic: true,
    },
  ).catch(() => undefined);

  // Reversal or cascade.
  if (reversesId) {
    await applyReversal(ctx, record, reversesId).catch((err) =>
      logger.warn({ err }, 'reversal handling failed'),
    );
  }
  await planCascade(ctx, record).catch((err) =>
    logger.warn({ err, decisionId: record.id }, 'cascade planning failed'),
  );
  logger.info(
    { sessionId: ctx.session.id, decisionKey, category: det.category, told: toldFunctions },
    'executive decision recorded',
  );
  return record;
}

// ─── Trainer actions ─────────────────────────────────────────────────────────

/** Trainer records a decision on behalf of an unstaffed executive (v1 answer #2). */
export async function recordManualDecision(
  sessionId: string,
  trainerId: string,
  text: string,
  orgKey?: string | null,
): Promise<DecisionRecord | null> {
  const ctx = await loadDecisionContext(sessionId);
  if (!ctx) return null;
  const raw = await callSocialCrisisAI(
    `Structure a trainer-entered EXECUTIVE DECISION for a crisis simulation. Return ONLY valid JSON with: is_decision (true), confidence (1), finality ("final"), summary (past tense, <= 200 chars), category (workforce|operations|public_position|legal_action|commercial|governance|other), scope {org_key, country, site_key, subject}, affected_stakeholder_ids, should_know_functions, should_know_stakeholder_ids, reverses ("none" or a decision_key). Use ONLY ids / functions from the lists.`,
    `Organisations: ${ctx.registry
      .filter((o) => o.side === 'protagonist')
      .map((o) => `${o.org_key} = ${o.display_name} (${o.country || '—'})`)
      .join('; ')}
Functions: ${Array.from(new Set(ctx.teams.map((t) => resolveTeamFunction(t)))).join(', ')}
Earlier decisions: ${(await listDecisions(sessionId)).map((d) => `${d.decision_key}: ${d.detail.summary}`).join(' | ') || 'none'}
CAST:
${castForPrompt(ctx)}

DECISION TEXT:
${text.slice(0, 3000)}`,
    1200,
    0.2,
  );
  const det = normaliseDetection(
    { ...(raw as Record<string, unknown>), is_decision: true, confidence: 1, finality: 'final' },
    new Set(ctx.cast.keys()),
    new Set(ctx.teams.map((t) => resolveTeamFunction(t))),
  );
  if (det.summary.length < 8) det.summary = text.trim().slice(0, 200);
  const execTeam = ctx.teams.find(
    (t) =>
      resolveTeamFunction(t) === 'Executive' && (!orgKey || !t.org_key || t.org_key === orgKey),
  );
  return recordDecision(ctx, {
    det,
    informed: [],
    sources: [{ ref_table: 'manual', ref_id: null, excerpt: text.slice(0, 280) }],
    authorUserId: trainerId,
    authorTeam: execTeam?.team_name ?? 'Executive',
    authorFunction: 'Executive',
    orgKey: orgKey ?? det.scope.org_key ?? execTeam?.org_key ?? null,
    byTrainer: true,
  });
}

export async function dismissDecision(
  sessionId: string,
  decisionId: string,
  trainerId: string,
): Promise<boolean> {
  const record = await getDecision(decisionId);
  if (!record || record.session_id !== sessionId) return false;
  const cancelled = await cancelPendingCascade(sessionId, record);
  await updateDecisionDetail(decisionId, record.detail, 'dismissed');
  await addDecisionEvent({
    session_id: sessionId,
    decision_id: decisionId,
    parent_id: null,
    kind: 'dismissed',
    actor_kind: 'player',
    actor_id: trainerId,
    at_minute: 0,
    ref_table: null,
    ref_id: null,
    summary: `Dismissed by trainer; ${cancelled} pending reaction(s) withdrawn`,
  });
  await emitSessionEvent(sessionId, 'decision_dismissed', 'decision_recorded', {
    description: `Executive decision dismissed by trainer: ${record.detail.summary}`,
    metadata: { decision_id: decisionId, cancelled_injects: cancelled },
    user_id: trainerId,
  });
  return true;
}
