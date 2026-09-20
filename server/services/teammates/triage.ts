import type { BotParams } from './intellect.js';
import type { BotMemory, TeamBoard } from './memory.js';
import { isClaimedByOther, openCommitments } from './memory.js';
import type { Situation, TaggedPost } from './perception.js';
import type { ActionKind } from './types.js';
import { isHate, isMisinfo } from './perception.js';

/**
 * Deterministic triage (docs/ai-teammate-bots-plan.md §9.2).
 *
 * Builds the prioritised to-do list a competent human would keep in their head:
 * what is on my desk, what is on fire, what my charter expects of me, what my
 * teammates asked for. The LLM only chooses among (and writes copy for) the top
 * items. Lane rules are enforced here, before any model is consulted, and the
 * intellect parameters degrade the list the way an untrained player would.
 *
 * Pure: everything random comes through `rng` so tests can pin it.
 */

export interface TriageItem {
  /** Lower = more urgent. */
  priority: number;
  kind: ActionKind;
  targetId?: string;
  reason: string;
  /** Extra context the brain needs to write copy (email body, DM text, draft text...). */
  context?: string;
  to?: string[];
  subject?: string;
  /** For dm_reply: the counterpart handle. */
  recipientHandle?: string;
  /** Present when the item satisfies a charter expected action. */
  detectionActionType?: string;
}

/**
 * Named random draws so tests can pin each behaviour independently:
 *  - idle:     turn spent monitoring instead of acting (idleRate)
 *  - counter:  whether a harmful post gets countered at all (counterRate)
 *  - neglect:  an untrained bot ignoring something on its desk
 *  - mischief: untrained out-of-lane posting / engaging with harmful content
 */
export interface TriageRolls {
  idle(): number;
  counter(): number;
  neglect(): number;
  mischief(): number;
}

export const randomRolls: TriageRolls = {
  idle: Math.random,
  counter: Math.random,
  neglect: Math.random,
  mischief: Math.random,
};

export interface TriageInput {
  sit: Situation;
  params: BotParams;
  mem: BotMemory;
  board: TeamBoard | null;
  /**
   * Session-wide claims shared by every bot regardless of team, so an email or DM
   * addressed to the whole organisation is answered once, not once per team.
   */
  sessionBoard?: TeamBoard | null;
  /** Is this bot the team lead (first bot on its team)? Drives plan-posting. */
  isLead: boolean;
  rolls?: TriageRolls;
}

const LEGAL_RE = /legal|counsel|compliance/i;

export function functionOf(sit: Situation): 'public_voice' | 'legal' | 'other' {
  const c = sit.charter;
  if (c?.can_post_publicly) return 'public_voice';
  const key = `${c?.function_key ?? ''} ${c?.team_name ?? ''}`;
  if (LEGAL_RE.test(key)) return 'legal';
  if (!c && sit.publicVoiceTeam && sit.me.teamName === sit.publicVoiceTeam) return 'public_voice';
  return 'other';
}

/** The action kinds this bot may use at all, given its lane and discipline. */
export function allowedKinds(sit: Situation, params: BotParams): Set<ActionKind> {
  const fn = functionOf(sit);
  const kinds = new Set<ActionKind>([
    'flag',
    'report',
    'like',
    'dispute',
    'email_read',
    'email_reply',
    'email_forward',
    'dm_reply',
    'draft_create',
    'draft_review',
    'chat',
    'fact_check',
    'escalate',
    'read_news',
    'idle',
  ]);
  const undrilled = params.laneDiscipline < 0.85;
  const untrained = params.laneDiscipline < 0.4;
  if (fn === 'public_voice' || undrilled) kinds.add('reply');
  if (fn === 'public_voice' || untrained) kinds.add('post');
  if (sit.me.isPageHolder) kinds.add('statement');
  if (untrained) kinds.add('repost');
  if (fn === 'legal' && !untrained) {
    kinds.delete('post');
    kinds.delete('repost');
  }
  return kinds;
}

function legalStaffed(sit: Situation): boolean {
  for (const [team, members] of sit.teams) {
    if (LEGAL_RE.test(team) && members.length > 0 && team !== sit.me.teamName) return true;
  }
  return false;
}

function gaugesFalling(sit: Situation): boolean {
  const g = sit.gauges;
  return (
    (g.public_trust !== null && g.public_trust < 45) ||
    (g.narrative_control !== null && g.narrative_control < 45) ||
    (g.escalation_risk !== null && g.escalation_risk > 60)
  );
}

/** Handles are stored with their leading '@'; normalise so we never print '@@'. */
export function at(handle: string): string {
  return `@${String(handle ?? '').replace(/^@+/, '')}`;
}

function shortPost(p: TaggedPost): string {
  return `${at(p.author_handle)} (${p.platform}, virality ${p.virality_score ?? 0}): ${p.content.replace(/\s+/g, ' ').slice(0, 280)}`;
}

export function triage(input: TriageInput): TriageItem[] {
  const { sit, params, mem, board, isLead } = input;
  const rolls = input.rolls ?? randomRolls;
  const allowed = allowedKinds(sit, params);
  const fn = functionOf(sit);
  const items: TriageItem[] = [];
  const untrained = params.laneDiscipline < 0.4;
  const sessionBoard = input.sessionBoard ?? null;
  const claimed = (id: string) =>
    (board ? isClaimedByOther(board, id, sit.me.userId, sit.now) : false) ||
    (sessionBoard ? isClaimedByOther(sessionBoard, id, sit.me.userId, sit.now) : false);

  // 1. Documents waiting for my review.
  for (const d of sit.drafts.toReview) {
    if (claimed(d.id)) continue;
    if (untrained && rolls.neglect() < 0.6) continue;
    items.push({
      priority: 10,
      kind: 'draft_review',
      targetId: d.id,
      reason: `"${d.title}" by ${d.author_name ?? 'a teammate'} is waiting for review`,
      context: d.content_text.slice(0, 1500),
      detectionActionType: 'draft_approved',
    });
  }

  // 2. Trainer nudges and teammate mentions / questions in chat.
  for (const m of sit.chat.nudges) {
    items.push({
      priority: 5,
      kind: 'chat',
      targetId: m.id,
      reason: `trainer instruction: "${m.content.slice(0, 160)}"`,
      context: m.content,
    });
  }
  for (const m of sit.chat.mentions) {
    if (sit.chat.nudges.some((n) => n.id === m.id)) continue;
    if (untrained && rolls.neglect() < 0.5) continue;
    items.push({
      priority: 20,
      kind: 'chat',
      targetId: m.id,
      reason: `${m.sender?.full_name ?? 'a teammate'} said: "${m.content.slice(0, 160)}"`,
      context: m.content,
      detectionActionType: 'chat_message_sent',
    });
  }

  // 2b. Approved document ready to publish (page holder), or changes requested on mine.
  if (sit.me.isPageHolder && allowed.has('statement')) {
    for (const d of sit.drafts.approvedUnpublished) {
      items.push({
        priority: 15,
        kind: 'statement',
        targetId: d.id,
        reason: `approved document "${d.title}" is ready to publish as the official page`,
        context: d.content_text,
        detectionActionType: 'post_created',
      });
    }
  }
  for (const d of sit.drafts.changesRequested) {
    if (untrained && rolls.neglect() < 0.5) continue;
    items.push({
      priority: 18,
      kind: 'draft_create',
      targetId: d.id,
      reason: `reviewer asked for changes on "${d.title}": ${d.review_note ?? 'no note'}`,
      context: `${d.content_text}\n\nREVIEW NOTE: ${d.review_note ?? ''}`,
      subject: d.title,
      detectionActionType: 'draft_submitted_for_approval',
    });
  }

  // 3. Emails on my desk.
  sit.emails.unanswered.forEach((e, i) => {
    if (claimed(e.id)) return;
    if (untrained && rolls.neglect() < 0.5) return;
    const urgent = e.priority === 'urgent' || e.priority === 'high';
    items.push({
      priority: (urgent ? 22 : 30) + Math.min(i, 8),
      kind: 'email_reply',
      targetId: e.id,
      reason: `${urgent ? 'URGENT ' : ''}email from ${e.from_name ?? e.from_address}: "${e.subject}"`,
      context: `FROM: ${e.from_name ?? ''} <${e.from_address}>\nSUBJECT: ${e.subject}\n\n${(e.body_text ?? '').slice(0, 1800)}`,
      to: [e.from_address],
      subject: e.subject,
      detectionActionType: 'email_sent',
    });
  });

  // 4. Direct messages.
  sit.dms.forEach((t, i) => {
    if (claimed(t.thread_id)) return;
    if (untrained && rolls.neglect() < 0.4) return;
    const last = t.latest_message;
    items.push({
      priority: 35 + Math.min(i, 8),
      kind: 'dm_reply',
      targetId: t.thread_id,
      recipientHandle: t.other_participant.handle,
      reason: `DM from ${t.other_participant.display_name || t.other_participant.handle}: "${last.content.slice(0, 140)}"`,
      context: `${t.other_participant.display_name || t.other_participant.handle} wrote${t.is_org_page_thread ? ' to the organisation page' : ''}: ${last.content.slice(0, 900)}`,
      detectionActionType: 'dm_sent',
    });
  });

  // 5. Intel relay.
  if (params.coordination >= 0.5) {
    for (const rel of sit.intelToRelay) {
      if (claimed(`fwd:${rel.email.id}`)) continue;
      items.push({
        priority: 40,
        kind: 'email_forward',
        targetId: rel.email.id,
        to: rel.recipients.map((r) => r.address),
        subject: `Fwd: ${rel.email.subject}`,
        reason: `"${rel.email.subject}" is intel that ${rel.entry.needed_by.join(' / ')} needs`,
        context: `${rel.entry.summary || rel.email.subject}\n\n${(rel.email.body_text ?? '').slice(0, 800)}`,
        detectionActionType: 'email_sent',
      });
    }
  }

  // 6. Harmful content nobody on the team has countered.
  sit.harmful.slice(0, 6).forEach((p, i) => {
    if (claimed(p.id)) return;
    if (rolls.counter() >= params.counterRate) return;
    let kind: ActionKind;
    if (fn === 'public_voice' && allowed.has('reply')) kind = 'reply';
    else if (fn === 'legal') kind = isMisinfo(p) ? 'dispute' : isHate(p) ? 'report' : 'flag';
    else kind = 'flag';
    if (!allowed.has(kind)) kind = 'flag';
    items.push({
      priority: 50 + i,
      kind,
      targetId: p.id,
      reason: `${p.tags.filter((t) => t !== 'HANDLED-BY-TEAM').join('/') || 'hostile'} post uncountered`,
      context: shortPost(p),
      detectionActionType:
        kind === 'reply'
          ? 'reply_posted'
          : kind === 'dispute'
            ? 'dispute_filed'
            : kind === 'report'
              ? 'post_reported'
              : 'post_flagged',
    });
    // Non-public teams also raise it in chat so the voice team sees it.
    if (kind !== 'reply' && params.coordination >= 0.6 && sit.chat.teamChannelId) {
      items.push({
        priority: 52 + i,
        kind: 'chat',
        targetId: `esc:${p.id}`,
        reason: 'escalate a harmful post to the team',
        context: `Flag for the team: ${shortPost(p)}`,
        detectionActionType: 'chat_message_sent',
      });
    }
  });

  // 7. Charter tasks approaching their benchmark (only when the bot knows the rubric).
  if (params.knowsRubric && sit.charter) {
    for (const a of sit.charter.expected_actions) {
      if (a.timing_benchmark_minutes === null) continue;
      if (mem.doneActionTypes.has(a.detection_action_type)) continue;
      if (sit.elapsedMinutes < a.timing_benchmark_minutes - 6) continue;
      const kind = kindForDetection(a.detection_action_type, sit, allowed);
      if (!kind) continue;
      items.push({
        priority: 45,
        kind,
        reason: `charter task due by T+${a.timing_benchmark_minutes}: ${a.description}`,
        context: a.description,
        detectionActionType: a.detection_action_type,
      });
    }
  }

  // 8. Official statement cadence (page holder).
  if (sit.me.isPageHolder) {
    const sinceLast =
      sit.lastOfficialStatementAt === null
        ? Infinity
        : (sit.now - sit.lastOfficialStatementAt) / 60_000;
    const due = openCommitments(mem, sit.now).some((c) => c.dueAt !== null && c.dueAt <= sit.now);
    const none = sit.lastOfficialStatementAt === null;
    const wantStatement =
      (none && sit.elapsedMinutes >= 3) || due || (sinceLast > 15 && gaugesFalling(sit));
    const alreadyInFlight = sit.drafts.mine.some((d) => d.status === 'in_review');
    if (wantStatement && !alreadyInFlight && !untrained) {
      const gate = legalStaffed(sit) && params.coordination >= 0.6;
      // An organisation with no holding statement minutes into a firestorm is the
      // bigger problem, so this outranks even urgent inbox items.
      items.push({
        priority: none ? 21 : 60,
        kind: gate ? 'draft_create' : 'statement',
        reason: none
          ? 'no official statement has been published yet'
          : due
            ? 'a promised update is due'
            : 'gauges are falling and the last statement is stale',
        subject: none ? 'Holding statement' : 'Update statement',
        detectionActionType: 'post_created',
      });
    } else if (wantStatement && untrained && rolls.mischief() < 0.15) {
      items.push({
        priority: 65,
        kind: 'statement',
        reason: 'someone said we should say something',
        subject: 'Statement',
        detectionActionType: 'post_created',
      });
    }
  }

  // 9. Team plan (lead, coordinating) — once early, then refreshed when stale.
  if (isLead && params.coordination >= 0.6 && sit.chat.teamChannelId && board) {
    const stale = sit.now - board.planPostedAt > 12 * 60_000;
    if (stale) {
      items.push({
        priority: board.plan ? 70 : 28,
        kind: 'chat',
        targetId: 'plan',
        reason: board.plan ? 'refresh the team plan in chat' : 'post the initial team plan in chat',
        context: 'TEAM PLAN',
        detectionActionType: 'chat_message_sent',
      });
    }
  }

  // Untrained flavour: out-of-lane posting and engaging with harmful content.
  if (untrained) {
    if (allowed.has('post') && rolls.mischief() < 0.15) {
      items.push({ priority: 55, kind: 'post', reason: 'felt like weighing in publicly' });
    }
    const target = sit.harmful[0] ?? sit.feed.find((p) => p.harmful);
    if (target && rolls.mischief() < 0.2) {
      items.push({
        priority: 58,
        kind: rolls.mischief() < 0.5 && allowed.has('repost') ? 'repost' : 'like',
        targetId: target.id,
        reason: 'engaged without checking',
        context: shortPost(target),
      });
    }
  }

  // Monitoring floor: always something to do.
  const unreadNonReply = sit.emails.unread.filter(
    (e) => !sit.emails.unanswered.some((u) => u.id === e.id),
  );
  if (sit.news[0]) {
    items.push({
      priority: 80,
      kind: 'read_news',
      targetId: sit.news[0].id,
      reason: 'catch up on the newsroom',
      detectionActionType: 'news_read',
    });
  }
  if (unreadNonReply[0]) {
    items.push({
      priority: 85,
      kind: 'email_read',
      targetId: unreadNonReply[0].id,
      reason: `read "${unreadNonReply[0].subject}"`,
      detectionActionType: 'email_read',
    });
  }
  const supportive = sit.feed.find(
    (p) =>
      !p.harmful &&
      (p.tags.includes('OUR-PAGE') || p.tags.includes('TEAMMATE')) &&
      !mem.handled.has(p.id) &&
      p.user_id !== sit.me.userId,
  );
  if (supportive && !untrained) {
    items.push({
      priority: 90,
      kind: 'like',
      targetId: supportive.id,
      reason: 'amplify our own side',
      context: shortPost(supportive),
      detectionActionType: 'post_liked',
    });
  }
  if (sit.chat.teamChannelId && sit.now - mem.lastChatAt > 10 * 60_000) {
    items.push({
      priority: 95,
      kind: 'chat',
      targetId: 'status',
      reason: 'short status line for the team',
      context: 'STATUS UPDATE',
      detectionActionType: 'chat_message_sent',
    });
  }
  items.push({ priority: 100, kind: 'idle', reason: 'monitoring' });

  // Idle bias: at low intellect a turn is often spent scrolling.
  const filtered = items
    .filter((it) => allowed.has(it.kind))
    .filter((it) => !(it.targetId && mem.handled.has(it.targetId) && it.kind !== 'chat'));
  if (rolls.idle() < params.idleRate) {
    // Keep only urgent desk items; drop the rest in favour of monitoring.
    return dedupe(filtered.filter((it) => it.priority <= 20 || it.priority >= 80)).sort(byPriority);
  }
  return dedupe(filtered).sort(byPriority);
}

const byPriority = (a: TriageItem, b: TriageItem) => a.priority - b.priority;

function dedupe(items: TriageItem[]): TriageItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.kind}:${it.targetId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function kindForDetection(
  detection: string,
  sit: Situation,
  allowed: Set<ActionKind>,
): ActionKind | null {
  const map: Record<string, ActionKind> = {
    post_created: sit.me.isPageHolder ? 'statement' : 'post',
    reply_posted: 'reply',
    post_flagged: 'flag',
    misinfo_flagged: 'flag',
    post_reported: 'report',
    dispute_filed: 'dispute',
    email_sent: 'email_reply',
    email_read: 'email_read',
    dm_sent: 'dm_reply',
    chat_message_sent: 'chat',
    fact_checked: 'fact_check',
    escalated: 'escalate',
    draft_created: 'draft_create',
    draft_submitted_for_approval: 'draft_create',
    draft_approved: 'draft_review',
    news_read: 'read_news',
    intel_shared: 'email_forward',
  };
  const kind = map[detection];
  if (!kind || !allowed.has(kind)) return null;
  // Only propose target-bound kinds when a target exists.
  if (kind === 'reply' || kind === 'flag' || kind === 'report' || kind === 'dispute')
    return sit.harmful.length > 0 ? kind : null;
  if (kind === 'email_reply') return sit.emails.unanswered.length > 0 ? kind : null;
  if (kind === 'email_read') return sit.emails.unread.length > 0 ? kind : null;
  if (kind === 'dm_reply') return sit.dms.length > 0 ? kind : null;
  if (kind === 'draft_review') return sit.drafts.toReview.length > 0 ? kind : null;
  if (kind === 'email_forward') return sit.intelToRelay.length > 0 ? kind : null;
  if (kind === 'read_news') return sit.news.length > 0 ? kind : null;
  return kind;
}
