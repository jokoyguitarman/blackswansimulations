/**
 * Deterministic per-inject condition keys. No database access.
 * `undefined` from the evaluator means the key belongs to another family.
 */

import { slugifyTeamName, type ConditionDef, type ConditionScope } from './conditionCatalog.js';
import {
  emptyCommsState,
  sessionMinuteAt,
  type ActionCountBucket,
  type CommsDelivery,
  type CommsState,
  type JudgementV1,
} from '../ledger/injectLedgerCore.js';
import { evaluateChainKey, type ChainSnapshot } from '../escalation/escalationCore.js';

export interface ParsedCommsKey {
  def: ConditionDef;
  args: string[];
  scope?: ConditionScope;
}

type ResponseRow = CommsDelivery['responses'][number];

interface KeyInput {
  args: string[];
  team?: string;
  role?: string;
  state: CommsState;
  elapsed: number;
}

interface KeyResult {
  met: boolean;
  detail: string;
}

const CALL_KEY_IDS = new Set([
  'call_answered',
  'call_missed',
  'call_declined',
  'call_missed_count',
  'call_attempts_gte',
  'call_answered_by_attempt',
  'call_unreturned',
  'call_answered_within',
  'stakeholder_missed_calls',
]);

const ANSWERED_STATES = new Set(['answered', 'ended']);
const MISS_STATES = new Set(['missed', 'declined']);
const PENDING_STATES = new Set(['ringing', 'scheduled']);

export function evaluateCommsKey(
  parsed: ParsedCommsKey,
  commsState: CommsState | null | undefined,
  elapsedMinutes: number,
): boolean | undefined {
  const explained = explainCommsKey(parsed, commsState, elapsedMinutes);
  return explained?.met;
}

export function explainCommsKey(
  parsed: ParsedCommsKey,
  commsState: CommsState | null | undefined,
  elapsedMinutes: number,
): KeyResult | undefined {
  const resolve = RESOLVERS[parsed.def.id];
  if (!resolve) return undefined;
  const state = commsState ?? emptyCommsState(elapsedMinutes);
  if (CALL_KEY_IDS.has(parsed.def.id) && state.calls_available === false) {
    return { met: false, detail: 'Phone calls are not available yet' };
  }
  // Role scope is read by the filters below. Evaluation does not await, so
  // concurrent tests cannot observe another key's scope.
  const previousRole = scopeRole;
  scopeRole = parsed.scope?.role;
  try {
    return resolve({
      args: parsed.args,
      team: parsed.scope?.team,
      role: parsed.scope?.role,
      state,
      elapsed: elapsedMinutes,
    });
  } finally {
    scopeRole = previousRole;
  }
}

let scopeRole: string | undefined;

function emailChannel(channel: string): boolean {
  return channel === 'email';
}

function chatChannel(channel: string): boolean {
  return channel === 'chat';
}

function dmChannel(channel: string): boolean {
  return channel === 'npc_dm' || channel === 'messenger_dm';
}

function newsChannel(channel: string): boolean {
  return channel === 'news';
}

const RESOLVERS: Record<string, (input: KeyInput) => KeyResult> = {
  delivered: ({ args, team, state }) => presence(viewFor(state, args[0] ?? '', team)),
  opened: ({ args, team, state, elapsed }) =>
    openedResult(viewFor(state, args[0] ?? '', team), elapsed),
  unopened: ({ args, team, state, elapsed }) =>
    unopenedResult(viewFor(state, args[0] ?? '', team), elapsed, numberArg(args, 1)),
  responded: ({ args, team, state, elapsed }) =>
    respondedResult(viewFor(state, args[0] ?? '', team), elapsed, acceptResponses(team)),
  unresponded: ({ args, team, state, elapsed }) =>
    windowResult(
      viewFor(state, args[0] ?? '', team),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team),
    ),
  responded_within: ({ args, team, state, elapsed }) =>
    respondedWithin(
      viewFor(state, args[0] ?? '', team),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team),
    ),
  response_count_gte: ({ args, team, state, elapsed }) =>
    countResult(
      viewFor(state, args[0] ?? '', team),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team),
    ),
  responded_by_bot_only: ({ args, team, state, elapsed }) =>
    botsOnly(viewFor(state, args[0] ?? '', team), elapsed, acceptResponses(team)),
  email_opened: ({ args, team, state, elapsed }) =>
    openedResult(viewFor(state, args[0] ?? '', team, emailChannel), elapsed),
  email_unopened: ({ args, team, state, elapsed }) =>
    unopenedResult(viewFor(state, args[0] ?? '', team, emailChannel), elapsed, numberArg(args, 1)),
  email_replied: ({ args, team, state, elapsed }) =>
    respondedResult(
      viewFor(state, args[0] ?? '', team, emailChannel),
      elapsed,
      acceptResponses(team, ['email_reply']),
    ),
  email_unreplied: ({ args, team, state, elapsed }) =>
    windowResult(
      viewFor(state, args[0] ?? '', team, emailChannel),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team, ['email_reply']),
    ),
  email_forwarded: ({ args, team, state, elapsed }) =>
    forwardedResult(state, args[0] ?? '', team, elapsed),
  email_sent_to_stakeholder: ({ args, state, elapsed }) => {
    const blocked = factBlock(state, 'email', false);
    if (blocked) return { met: false, detail: blocked };
    const minute = state.email_sent_minutes?.[args[0] ?? ''];
    const met = minute != null;
    return {
      met,
      detail: met ? `Emailed at T+${minute}` : `Not emailed (T+${elapsed})`,
    };
  },
  email_not_sent_to_stakeholder: ({ args, state, elapsed }) => {
    const blocked = factBlock(state, 'email', true);
    if (blocked) return { met: false, detail: blocked };
    const minute = state.email_sent_minutes?.[args[0] ?? ''];
    const n = numberArg(args, 1);
    const met = elapsed >= n && (minute == null || minute > n);
    return {
      met,
      detail: minute == null ? `Not emailed by T+${n}` : `Emailed at T+${minute}`,
    };
  },
  chat_replied: ({ args, team, state, elapsed }) =>
    respondedResult(
      viewFor(state, args[0] ?? '', team, chatChannel),
      elapsed,
      acceptResponses(team),
    ),
  chat_unanswered: ({ args, team, state, elapsed }) =>
    windowResult(
      viewFor(state, args[0] ?? '', team, chatChannel),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team),
    ),
  dm_replied: ({ args, team, state, elapsed }) =>
    respondedResult(viewFor(state, args[0] ?? '', team, dmChannel), elapsed, acceptResponses(team)),
  dm_unanswered: ({ args, team, state, elapsed }) =>
    windowResult(
      viewFor(state, args[0] ?? '', team, dmChannel),
      elapsed,
      numberArg(args, 1),
      acceptResponses(team),
    ),
  call_answered: ({ args, team, state }) => {
    const attempts = callAttempts(state, args[0] ?? '', team);
    const met = attempts.some(isAnsweredAttempt);
    return {
      met,
      detail: met ? 'Answered' : attempts.length === 0 ? 'No call yet' : 'Not answered',
    };
  },
  call_missed: ({ args, team, state }) => {
    const groups = groupAttempts(callAttempts(state, args[0] ?? '', team));
    const met = groups.length > 0 && groups.every(groupMissed);
    return {
      met,
      detail: met ? 'Missed' : groups.length === 0 ? 'No call yet' : 'Not a completed miss',
    };
  },
  call_declined: ({ args, team, state }) => {
    const attempts = callAttempts(state, args[0] ?? '', team);
    const met =
      attempts.some((attempt) => attempt.call_state === 'declined') &&
      !attempts.some(isAnsweredAttempt);
    return { met, detail: met ? 'Declined' : 'Not declined' };
  },
  call_missed_count: ({ args, team, state }) => {
    const attempts = callAttempts(state, args[0] ?? '', team);
    const count = attempts.filter((attempt) => MISS_STATES.has(attempt.call_state ?? '')).length;
    const n = numberArg(args, 1);
    return { met: count >= n, detail: `${count} missed or declined` };
  },
  call_attempts_gte: ({ args, team, state }) => {
    const count = callAttempts(state, args[0] ?? '', team).length;
    return { met: count >= numberArg(args, 1), detail: `${count} attempts` };
  },
  call_answered_by_attempt: ({ args, team, state }) => {
    const n = numberArg(args, 1);
    const met = callAttempts(state, args[0] ?? '', team).some(
      (attempt) => isAnsweredAttempt(attempt) && attempt.attempt_no <= n,
    );
    return { met, detail: met ? `Answered by attempt ${n}` : `Not answered by attempt ${n}` };
  },
  call_unreturned: ({ args, team, state, elapsed }) =>
    unreturnedResult(callAttempts(state, args[0] ?? '', team), elapsed, numberArg(args, 1)),
  call_answered_within: ({ args, team, state }) => {
    const limit = numberArg(args, 1);
    const met = callAttempts(state, args[0] ?? '', team).some((attempt) =>
      attempt.responses.some((response) => {
        if (response.attribution !== 'call_answered') return false;
        const seconds = response.meta?.answer_seconds;
        return typeof seconds === 'number' && seconds <= limit;
      }),
    );
    return { met, detail: met ? `Answered within ${limit}s` : `Not answered within ${limit}s` };
  },
  stakeholder_missed_calls: ({ args, state }) => {
    const count = missedCallsForStakeholder(state, args[0] ?? '');
    const n = numberArg(args, 1);
    return { met: count >= n, detail: `${count} missed or declined` };
  },
  contacted: ({ args, state, elapsed }) => {
    const blocked = factBlock(state, 'contacts', false);
    if (blocked) return { met: false, detail: blocked };
    const contact = state.stakeholder_contacts?.[args[0] ?? ''];
    return {
      met: contact != null,
      detail: contact ? `Contacted at T+${contact.first_minute}` : `Not contacted (T+${elapsed})`,
    };
  },
  contacted_via: ({ args, state }) => {
    const blocked = factBlock(state, 'contacts', false);
    if (blocked) return { met: false, detail: blocked };
    const contact = state.stakeholder_contacts?.[args[0] ?? ''];
    const channel = args[1] ?? '';
    const met = contact?.channels.includes(channel) === true;
    return { met, detail: met ? `Contacted by ${channel}` : `Not contacted by ${channel}` };
  },
  not_contacted: ({ args, state, elapsed }) => {
    const blocked = factBlock(state, 'contacts', true);
    if (blocked) return { met: false, detail: blocked };
    const contact = state.stakeholder_contacts?.[args[0] ?? ''];
    const n = numberArg(args, 1);
    const met = elapsed >= n && (contact == null || contact.first_minute > n);
    return {
      met,
      detail: contact ? `Contacted at T+${contact.first_minute}` : `Not contacted by T+${n}`,
    };
  },
  stakeholder_verdict: ({ args, state }) => {
    const actual = state.stakeholder_verdicts?.[args[0] ?? ''] ?? null;
    const expected = args[1] ?? '';
    return {
      met: actual === expected,
      detail: actual ? `Latest verdict ${actual}` : 'No verdict yet',
    };
  },
  news_opened: ({ args, team, state, elapsed }) =>
    openedResult(viewFor(state, args[0] ?? '', team, newsChannel), elapsed),
  action_count_gte: ({ args, team, state }) => {
    const blocked = factBlock(state, 'actions', false);
    if (blocked) return { met: false, detail: blocked };
    const stats = actionStats(state, args[0] ?? '', team);
    const n = numberArg(args, 1);
    return { met: stats.count >= n, detail: `${stats.count} so far` };
  },
  action_absent: ({ args, team, state, elapsed }) => {
    const blocked = factBlock(state, 'actions', true);
    if (blocked) return { met: false, detail: blocked };
    const stats = actionStats(state, args[0] ?? '', team);
    const n = numberArg(args, 1);
    const met = elapsed >= n && (stats.first == null || stats.first > n);
    return {
      met,
      detail: stats.first == null ? `None by T+${n}` : `First at T+${stats.first}`,
    };
  },
  duty_missed: (input) => dutyResult('missed', input),
  duty_done: (input) => dutyResult('done', input),
  duty_late: (input) => dutyResult('late', input),
  team_silent: (input) => teamSilentResult(input),
  content_failed: (input) => contentFailedResult(input),
  decision_made: (input) => decisionMadeResult(input),
  reply_passed: (input) => replyKey('passed', input),
  reply_failed: (input) => replyKey('failed', input),
  reply_best_passed: (input) => replyKey('best_passed', input),
  reply_criterion: (input) => replyKey('criterion', input),
  reply_missing_criterion: (input) => replyKey('missing_criterion', input),
  reply_answered_ask: (input) => replyKey('answered_ask', input),
  reply_missed_ask: (input) => replyKey('missed_ask', input),
  reply_tone: (input) => replyKey('tone', input),
  reply_tone_off: (input) => replyKey('tone_off', input),
  reply_score_below: (input) => replyKey('score_below', input),
  reply_score_at_least: (input) => replyKey('score_at_least', input),
  reply_factual_error: (input) => replyKey('factual_error', input),
  reply_risky_admission: (input) => replyKey('risky', input),
  reply_irrelevant: (input) => replyKey('irrelevant', input),
  responded_relevant: (input) => replyKey('relevant', input),
  line_missed_calls_gte: ({ args, state }) =>
    lineMissCount(state, args[0] ?? '', null, numberArg(args, 1)),
  line_busy_missed_gte: ({ args, state }) =>
    lineMissCount(state, args[0] ?? '', 'line_busy', numberArg(args, 1)),
  line_unattended: ({ args, state }) =>
    lineFact(state, args[0] ?? '', (fact) => fact.online_holders === 0),
  line_unattended_minutes_gte: ({ args, state }) =>
    lineFact(state, args[0] ?? '', (fact) => (fact.unattended_minutes ?? -1) >= numberArg(args, 1)),
  line_reassigned: ({ args, state }) => lineFact(state, args[0] ?? '', (fact) => fact.reassigned),
  role_missed_calls_gte: ({ args, state }) => {
    const count = allDeliveries(state).filter(
      (row) => isRoleMiss(row) && row.target_role_id === args[0],
    ).length;
    return { met: count >= numberArg(args, 1), detail: `${count} role misses` };
  },
  role_unassigned: ({ args, state }) => {
    const fact = (state.role_runtime ?? []).find((row) => row.role_id === args[0]);
    return {
      met: fact != null && !fact.assigned,
      detail: fact?.assigned ? 'Assigned' : 'Unassigned',
    };
  },
  role_fallback_used: ({ args, state }) => {
    const fact = (state.role_runtime ?? []).find((row) => row.role_id === args[0]);
    const fromDelivery = allDeliveries(state).some(
      (row) => row.target_role_id === args[0] && Boolean(row.fallback_reason),
    );
    const met = fact?.fallback_used === true || fromDelivery;
    return { met, detail: met ? 'Fallback used' : 'No fallback' };
  },
  role_offline_minutes_gte: ({ args, state }) => {
    const fact = (state.role_runtime ?? []).find((row) => row.role_id === args[0]);
    const minutes = fact?.offline_minutes ?? -1;
    return {
      met: minutes >= numberArg(args, 1),
      detail: `${Math.max(minutes, 0)} minutes offline`,
    };
  },
  chain_active: (input) => chainKey('chain_active', input),
  chain_stopped: (input) => chainKey('chain_stopped', input),
  chain_exhausted: (input) => chainKey('chain_exhausted', input),
  chain_step_reached: (input) => chainKey('chain_step_reached', input),
  followups_sent_gte: (input) => chainKey('followups_sent_gte', input),
  chain_stopped_by_step: (input) => chainKey('chain_stopped_by_step', input),
  urgency_reached: (input) => chainKey('urgency_reached', input),
  mood_is: ({ args, team, role, state }) => moodIs(state, args[0] ?? '', args[1] ?? '', team, role),
  mood_at_least: ({ args, team, role, state }) =>
    moodAtLeast(state, args[0] ?? '', args[1] ?? '', team, role),
  mood_reached: ({ args, team, role, state }) =>
    moodReached(state, args[0] ?? '', args[1] ?? '', team, role),
  stakeholder_gave_up: ({ args, team, role, state }) =>
    moodGaveUp(state, args[0] ?? '', team, role),
  replied_late: ({ args, team, role, state }) =>
    lateReply(state, args[0] ?? '', numberArg(args, 1), team, role),
  mood_at_reply: ({ args, team, role, state }) =>
    replyMood(state, args[0] ?? '', args[1] ?? '', team, role),
};

type MoodRow = NonNullable<CommsState['moods']>[number];

function moodRows(
  state: CommsState,
  stakeholderId: string,
  team: string | undefined,
  role: string | undefined,
): MoodRow[] {
  return (state.moods ?? []).filter((row) => {
    if (row.stakeholder_id !== stakeholderId) return false;
    if (role) return row.scope_team === `role:${role}`;
    if (team) return slugifyTeamName(row.scope_team) === team;
    return true;
  });
}

function moodIs(
  state: CommsState,
  stakeholderId: string,
  rung: string,
  team?: string,
  role?: string,
): KeyResult {
  if (!state.moods) return { met: false, detail: 'Moods are not available yet' };
  const rows = moodRows(state, stakeholderId, team, role);
  const met = rows.some((row) => row.rung_id === rung);
  return { met, detail: met ? `${stakeholderId} is ${rung}` : `${stakeholderId} is not ${rung}` };
}

function moodAtLeast(
  state: CommsState,
  stakeholderId: string,
  rung: string,
  team?: string,
  role?: string,
): KeyResult {
  if (!state.moods) return { met: false, detail: 'Moods are not available yet' };
  const met = moodRows(state, stakeholderId, team, role).some((row) => {
    const target = row.ladder_ids.indexOf(rung);
    if (target < 0) return false;
    const current = row.ladder_ids.indexOf(row.rung_id);
    return current >= target;
  });
  return {
    met,
    detail: met ? `${stakeholderId} is at least ${rung}` : `${stakeholderId} is below ${rung}`,
  };
}

function moodReached(
  state: CommsState,
  stakeholderId: string,
  rung: string,
  team?: string,
  role?: string,
): KeyResult {
  if (!state.moods) return { met: false, detail: 'Moods are not available yet' };
  const met = moodRows(state, stakeholderId, team, role).some(
    (row) => row.rung_id === rung || row.history.some((item) => item.rung === rung),
  );
  return {
    met,
    detail: met ? `${stakeholderId} reached ${rung}` : `${stakeholderId} has not reached ${rung}`,
  };
}

function moodGaveUp(
  state: CommsState,
  stakeholderId: string,
  team?: string,
  role?: string,
): KeyResult {
  if (!state.moods) return { met: false, detail: 'Moods are not available yet' };
  const met = moodRows(state, stakeholderId, team, role).some((row) => row.terminal);
  return { met, detail: met ? `${stakeholderId} gave up` : `${stakeholderId} is still waiting` };
}

function firstScopedResponse(
  state: CommsState,
  injectKey: string,
  team: string | undefined,
  role: string | undefined,
): ResponseRow | null {
  const view = viewFor(state, injectKey, team);
  let best: ResponseRow | null = null;
  for (const root of view.roots) {
    for (const delivery of bundleOf(view, root)) {
      if (role && delivery.target_role_id !== role) continue;
      for (const response of delivery.responses) {
        if (team && slugifyTeamName(response.team ?? '') !== team) continue;
        if (
          !best ||
          response.minute < best.minute ||
          (response.minute === best.minute && (response.id ?? '') < (best.id ?? ''))
        ) {
          best = response;
        }
      }
    }
  }
  return best;
}

function lateReply(
  state: CommsState,
  injectKey: string,
  minutes: number,
  team?: string,
  role?: string,
): KeyResult {
  const first = firstScopedResponse(state, injectKey, team, role);
  const wait = first?.wait_minutes;
  const met = first != null && wait != null && Number.isFinite(minutes) && wait >= minutes;
  return {
    met,
    detail: wait == null ? 'No timed reply yet' : `First reply waited ${wait} minutes`,
  };
}

function replyMood(
  state: CommsState,
  injectKey: string,
  rung: string,
  team?: string,
  role?: string,
): KeyResult {
  const first = firstScopedResponse(state, injectKey, team, role);
  const met = first?.mood_rung === rung;
  return {
    met,
    detail: met ? `First reply on ${rung}` : `First reply was ${first?.mood_rung ?? 'unrecorded'}`,
  };
}

function chainKey(id: string, input: KeyInput): KeyResult {
  const rows = (input.state.chains?.[input.args[0] ?? ''] ?? []) as ChainSnapshot[];
  return evaluateChainKey({
    id,
    args: input.args,
    team: input.team,
    role: input.role,
    chains: rows,
  });
}

type ReplyKind =
  | 'passed'
  | 'failed'
  | 'best_passed'
  | 'criterion'
  | 'missing_criterion'
  | 'answered_ask'
  | 'missed_ask'
  | 'tone'
  | 'tone_off'
  | 'score_below'
  | 'score_at_least'
  | 'factual_error'
  | 'risky'
  | 'irrelevant'
  | 'relevant';

function replyKey(kind: ReplyKind, input: KeyInput): KeyResult {
  const view = viewFor(input.state, input.args[0] ?? '', input.team);
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const judged = judgedResponses(view, acceptResponses(input.team));
  if (judged.length === 0) return { met: false, detail: 'No judgement yet' };
  const latest = judged[judged.length - 1];
  const judgement = latest?.judgement;
  if (!latest || !judgement) return { met: false, detail: 'No judgement yet' };
  const line = repliedLine(latest);
  switch (kind) {
    case 'passed':
      return { met: judgement.passed === true, detail: line };
    case 'failed':
      return { met: judgement.passed === false, detail: line };
    case 'best_passed':
      return { met: judged.some((row) => row.judgement?.passed === true), detail: line };
    case 'criterion':
      return {
        met: slotAt(judgement.criteria, numberArg(input.args, 1), 'met') === true,
        detail: line,
      };
    case 'missing_criterion':
      return {
        met: slotAt(judgement.criteria, numberArg(input.args, 1), 'met') === false,
        detail: line,
      };
    case 'answered_ask':
      return {
        met: slotAt(judgement.asks_answered, numberArg(input.args, 1), 'answered') === true,
        detail: line,
      };
    case 'missed_ask':
      return {
        met: slotAt(judgement.asks_answered, numberArg(input.args, 1), 'answered') === false,
        detail: line,
      };
    case 'tone':
      return { met: judgement.tone === (input.args[1] ?? ''), detail: line };
    case 'tone_off':
      return { met: judgement.tone_ok === false, detail: line };
    case 'score_below':
      return {
        met: scoreCompare(judgement, input.args[1], numberArg(input.args, 2), 'below'),
        detail: line,
      };
    case 'score_at_least':
      return {
        met: scoreCompare(judgement, input.args[1], numberArg(input.args, 2), 'at_least'),
        detail: line,
      };
    case 'factual_error':
      return { met: (judgement.factual_errors?.length ?? 0) > 0, detail: line };
    case 'risky':
      return {
        met: judged.some((row) => (row.judgement?.risky_admissions?.length ?? 0) > 0),
        detail: line,
      };
    case 'irrelevant':
      return {
        met: judged.every((row) => row.judgement?.addresses_inject === false),
        detail: line,
      };
    case 'relevant':
      return {
        met: judged.some((row) => row.judgement?.addresses_inject === true),
        detail: line,
      };
    default:
      return { met: false, detail: line };
  }
}

function judgedResponses(
  view: DeliveryView,
  accept: (response: ResponseRow) => boolean,
): ResponseRow[] {
  return eachDelivery(view)
    .flatMap((delivery) => delivery.responses)
    .filter((response) => accept(response) && isJudged(response))
    .sort(compareJudged);
}

function compareJudged(a: ResponseRow, b: ResponseRow): number {
  const minute = a.minute - b.minute;
  if (minute !== 0) return minute;
  const created = (a.created_at ?? '').localeCompare(b.created_at ?? '');
  if (created !== 0) return created;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

function isJudged(response: ResponseRow): boolean {
  return response.judgement_status === 'done' && response.judgement != null;
}

function latestJudged(
  view: DeliveryView,
  accept: (response: ResponseRow) => boolean,
): ResponseRow | null {
  const rows = judgedResponses(view, accept);
  return rows.length === 0 ? null : (rows[rows.length - 1] ?? null);
}

function withJudgement(
  view: DeliveryView,
  accept: (response: ResponseRow) => boolean,
  detail: string,
): string {
  const latest = latestJudged(view, accept);
  if (!latest?.judgement) return detail;
  return `${detail} — ${judgementSummary(latest.judgement)}`;
}

function repliedLine(response: ResponseRow): string {
  const team = response.team?.trim() || 'Someone';
  const summary = response.judgement ? judgementSummary(response.judgement) : 'judged';
  return `${team} replied T+${response.minute} — ${summary}`;
}

function judgementSummary(judgement: JudgementV1): string {
  const tone = judgement.tone ? `tone ${judgement.tone}` : 'judged';
  const list = judgement.criteria ?? [];
  const total = list.length || judgement.criteria_text?.length || 0;
  if (total === 0) return tone;
  const met = list.filter((item) => item.met === true).length;
  return `${tone}, ${met}/${total} criteria`;
}

/** `true` met, `false` present and unmet, `null` when that slot was not in the judgement. */
function slotAt(
  items: ReadonlyArray<{ met?: boolean; answered?: boolean }> | undefined,
  index: number,
  field: 'met' | 'answered',
): boolean | null {
  if (!Number.isInteger(index) || index < 1) return null;
  const item = items?.[index - 1];
  if (!item) return null;
  return item[field] === true;
}

function scoreCompare(
  judgement: JudgementV1,
  dimension: string | undefined,
  threshold: number,
  mode: 'below' | 'at_least',
): boolean {
  if (!dimension || !Number.isFinite(threshold)) return false;
  const value = judgement.scores?.[dimension];
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return mode === 'below' ? value < threshold : value >= threshold;
}

interface DeliveryView {
  roots: CommsDelivery[];
  bundles: Map<string, CommsDelivery[]>;
}

function viewFor(
  state: CommsState,
  injectKey: string,
  team: string | undefined,
  channel?: (channel: string) => boolean,
): DeliveryView {
  const all = state.by_key[injectKey] ?? [];
  const roots = all.filter(
    (delivery) =>
      isRoot(delivery, injectKey) &&
      includesTeam(delivery, team) &&
      includesRole(delivery) &&
      channelOk(delivery, channel),
  );
  const followUps = all.filter(
    (delivery) => isFollowUp(delivery, injectKey) && channelOk(delivery, channel),
  );
  return { roots, bundles: attachFollowUps(roots, followUps) };
}

function isRoot(delivery: CommsDelivery, injectKey: string): boolean {
  return delivery.inject_key === injectKey && delivery.chain_step == null;
}

function isFollowUp(delivery: CommsDelivery, injectKey: string): boolean {
  return (
    delivery.chain_step != null &&
    (delivery.chain_root_key === injectKey || delivery.inject_key === injectKey)
  );
}

function includesTeam(delivery: CommsDelivery, team: string | undefined): boolean {
  if (!team) return true;
  return delivery.recipient_teams.some((name) => slugifyTeamName(name) === team);
}

function includesRole(delivery: CommsDelivery): boolean {
  if (!scopeRole) return true;
  return delivery.target_role_id === scopeRole;
}

function channelOk(
  delivery: CommsDelivery,
  channel: ((channel: string) => boolean) | undefined,
): boolean {
  return channel ? channel(delivery.channel) : true;
}

function teamsOverlap(left: CommsDelivery, right: CommsDelivery): boolean {
  const slugs = new Set(left.recipient_teams.map((name) => slugifyTeamName(name)));
  return right.recipient_teams.some((name) => slugs.has(slugifyTeamName(name)));
}

function attachFollowUps(
  roots: CommsDelivery[],
  followUps: CommsDelivery[],
): Map<string, CommsDelivery[]> {
  const bundles = new Map<string, CommsDelivery[]>();
  for (const root of roots) bundles.set(root.delivery_id, [root]);
  for (const follow of followUps) {
    const linked = follow.chain_root_delivery_id
      ? roots.filter((root) => root.delivery_id === follow.chain_root_delivery_id)
      : [];
    const overlapped = roots.filter(
      (root) =>
        follow.session_wide || follow.recipient_teams.length === 0 || teamsOverlap(root, follow),
    );
    const targets =
      linked.length > 0
        ? linked
        : overlapped.length > 0
          ? overlapped
          : roots.length === 1
            ? roots
            : [];
    for (const root of targets) bundles.get(root.delivery_id)?.push(follow);
  }
  return bundles;
}

function acceptResponses(team: string | undefined, attributions?: readonly string[]) {
  return (response: ResponseRow): boolean => {
    if (team && slugifyTeamName(response.team ?? '') !== team) return false;
    if (attributions && !attributions.includes(response.attribution)) return false;
    return true;
  };
}

function bundleOf(view: DeliveryView, root: CommsDelivery): CommsDelivery[] {
  return view.bundles.get(root.delivery_id) ?? [root];
}

function numberArg(args: string[], index: number): number {
  const value = Number(args[index]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function presence(view: DeliveryView): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const first = view.roots[0];
  const who =
    first && first.recipient_teams.length > 0 ? first.recipient_teams.join(', ') : 'everyone';
  const extra = view.roots.length > 1 ? ` (+${view.roots.length - 1} more)` : '';
  return { met: true, detail: `delivered T+${first?.delivered_minute ?? 0} to ${who}${extra}` };
}

function respondedResult(
  view: DeliveryView,
  elapsed: number,
  accept: (response: ResponseRow) => boolean,
): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.some((root) => anyResponse(bundleOf(view, root), accept));
  return { met, detail: withJudgement(view, accept, deliveryPhrase(view.roots, elapsed, met)) };
}

function windowResult(
  view: DeliveryView,
  elapsed: number,
  within: number,
  accept: (response: ResponseRow) => boolean,
): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.every((root) => {
    if (elapsed - root.delivered_minute < within) return false;
    return !repliedBy(bundleOf(view, root), root.delivered_minute + within, accept);
  });
  const satisfied = view.roots.some((root) =>
    repliedBy(bundleOf(view, root), root.delivered_minute + within, accept),
  );
  return {
    met,
    detail: withJudgement(view, accept, deliveryPhrase(view.roots, elapsed, satisfied)),
  };
}

function respondedWithin(
  view: DeliveryView,
  elapsed: number,
  within: number,
  accept: (response: ResponseRow) => boolean,
): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.some((root) => {
    const first = earliest(bundleOf(view, root), accept);
    return first != null && first - root.delivered_minute <= within;
  });
  return { met, detail: withJudgement(view, accept, deliveryPhrase(view.roots, elapsed, met)) };
}

function eachDelivery(view: DeliveryView): CommsDelivery[] {
  const seen = new Set<string>();
  const deliveries: CommsDelivery[] = [];
  for (const root of view.roots) {
    for (const delivery of bundleOf(view, root)) {
      if (seen.has(delivery.delivery_id)) continue;
      seen.add(delivery.delivery_id);
      deliveries.push(delivery);
    }
  }
  return deliveries;
}

function countResult(
  view: DeliveryView,
  elapsed: number,
  minimum: number,
  accept: (response: ResponseRow) => boolean,
): KeyResult {
  const count = eachDelivery(view).reduce(
    (sum, delivery) => sum + delivery.responses.filter(accept).length,
    0,
  );
  return { met: count >= minimum, detail: `${count} replies (T+${elapsed})` };
}

function botsOnly(
  view: DeliveryView,
  elapsed: number,
  accept: (response: ResponseRow) => boolean,
): KeyResult {
  const responses = eachDelivery(view).flatMap((delivery) => delivery.responses.filter(accept));
  if (responses.length === 0) return { met: false, detail: `No replies yet (T+${elapsed})` };
  const met = responses.every((response) => response.is_bot);
  return { met, detail: met ? 'Only AI teammates replied' : 'A human replied' };
}

function openedResult(view: DeliveryView, elapsed: number): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.some((root) => openMinutes(bundleOf(view, root)).length > 0);
  return { met, detail: deliveryPhrase(view.roots, elapsed, met, 'opened', 'not opened yet') };
}

function unopenedResult(view: DeliveryView, elapsed: number, within: number): KeyResult {
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.every((root) => {
    if (elapsed - root.delivered_minute < within) return false;
    const opens = openMinutes(bundleOf(view, root));
    if (opens.length === 0) return true;
    return Math.min(...opens) - root.delivered_minute > within;
  });
  const opened = view.roots.some((root) => {
    const opens = openMinutes(bundleOf(view, root));
    return opens.some((minute) => minute - root.delivered_minute <= within);
  });
  return {
    met,
    detail: deliveryPhrase(view.roots, elapsed, opened, 'opened', 'not opened yet'),
  };
}

function forwardedResult(
  state: CommsState,
  injectKey: string,
  team: string | undefined,
  elapsed: number,
): KeyResult {
  const view = viewFor(state, injectKey, undefined, emailChannel);
  if (view.roots.length === 0) return { met: false, detail: 'Not delivered' };
  const met = view.roots.some((root) =>
    bundleOf(view, root).some((delivery) =>
      delivery.responses.some((response) => forwardReaches(response, team)),
    ),
  );
  return { met, detail: deliveryPhrase(view.roots, elapsed, met) };
}

function forwardReaches(response: ResponseRow, team: string | undefined): boolean {
  if (response.attribution !== 'email_forward') return false;
  if (!team) return true;
  const raw = response.meta?.recipient_teams;
  if (!Array.isArray(raw)) return false;
  return raw.some((name) => typeof name === 'string' && slugifyTeamName(name) === team);
}

function anyResponse(bundle: CommsDelivery[], accept: (response: ResponseRow) => boolean): boolean {
  return bundle.some((delivery) => delivery.responses.some(accept));
}

function repliedBy(
  bundle: CommsDelivery[],
  deadline: number,
  accept: (response: ResponseRow) => boolean,
): boolean {
  return bundle.some((delivery) =>
    delivery.responses.some((response) => accept(response) && response.minute <= deadline),
  );
}

function earliest(
  bundle: CommsDelivery[],
  accept: (response: ResponseRow) => boolean,
): number | null {
  let best: number | null = null;
  for (const delivery of bundle) {
    for (const response of delivery.responses) {
      if (!accept(response)) continue;
      if (best == null || response.minute < best) best = response.minute;
    }
  }
  return best;
}

function openMinutes(bundle: CommsDelivery[]): number[] {
  const minutes: number[] = [];
  for (const delivery of bundle) {
    if (delivery.opened_minute != null) minutes.push(delivery.opened_minute);
  }
  return minutes;
}

function deliveryPhrase(
  roots: CommsDelivery[],
  elapsed: number,
  satisfied: boolean,
  satisfiedText = 'replied',
  waitingText = 'no reply yet',
): string {
  if (roots.length === 0) return 'Not delivered';
  const first = roots[0];
  const who =
    first && first.recipient_teams.length > 0 ? first.recipient_teams.join(', ') : 'everyone';
  const extra = roots.length > 1 ? ` (+${roots.length - 1} more)` : '';
  const head = `delivered T+${first?.delivered_minute ?? 0} to ${who}${extra}`;
  const status = satisfied ? satisfiedText : waitingText;
  return `${head}; ${status} (T+${elapsed})`;
}

function callAttempts(
  state: CommsState,
  injectKey: string,
  team: string | undefined,
): CommsDelivery[] {
  return (state.by_key[injectKey] ?? []).filter(
    (delivery) =>
      delivery.channel === 'call' && includesTeam(delivery, team) && includesRole(delivery),
  );
}

function allDeliveries(state: CommsState): CommsDelivery[] {
  const seen = new Set<string>();
  const rows: CommsDelivery[] = [];
  for (const list of Object.values(state.by_key)) {
    for (const delivery of list) {
      if (seen.has(delivery.delivery_id)) continue;
      seen.add(delivery.delivery_id);
      rows.push(delivery);
    }
  }
  return rows;
}

function isMissedAttempt(delivery: CommsDelivery): boolean {
  return delivery.channel === 'call' && MISS_STATES.has(delivery.call_state ?? '');
}

function isRoleMiss(delivery: CommsDelivery): boolean {
  if (!isMissedAttempt(delivery) || !delivery.target_role_id) return false;
  if (delivery.fallback_reason) return false;
  if (delivery.missed_reason === 'line_busy' || delivery.missed_reason === 'line_unattended')
    return false;
  return true;
}

function lineMissCount(
  state: CommsState,
  teamSlug: string,
  reason: string | null,
  minimum: number,
): KeyResult {
  const count = allDeliveries(state).filter((delivery) => {
    if (!isMissedAttempt(delivery) || isRoleMiss(delivery)) return false;
    if (slugifyTeamName(delivery.line_team ?? '') !== teamSlug) return false;
    if (delivery.missed_reason === 'role_busy' || delivery.missed_reason === 'role_offline')
      return false;
    if (reason && delivery.missed_reason !== reason) return false;
    return true;
  }).length;
  return { met: count >= minimum, detail: `${count} line misses` };
}

function lineFact(
  state: CommsState,
  teamSlug: string,
  pred: (fact: NonNullable<CommsState['line_runtime']>[number]) => boolean,
): KeyResult {
  const fact = (state.line_runtime ?? []).find((row) => slugifyTeamName(row.team) === teamSlug);
  return { met: fact != null && pred(fact), detail: fact ? 'Line fact' : 'No line fact' };
}

function groupAttempts(attempts: readonly CommsDelivery[]): CommsDelivery[][] {
  const groups = new Map<string, CommsDelivery[]>();
  for (const attempt of attempts) {
    const id = attempt.call_group_id ?? attempt.delivery_id;
    const list = groups.get(id) ?? [];
    list.push(attempt);
    groups.set(id, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.attempt_no - b.attempt_no || a.delivered_minute - b.delivered_minute);
  }
  return [...groups.values()];
}

function isAnsweredAttempt(delivery: CommsDelivery): boolean {
  if (!delivery.call_state || !ANSWERED_STATES.has(delivery.call_state)) return false;
  return delivery.responses.some((response) => response.attribution === 'call_answered');
}

function isPending(delivery: CommsDelivery): boolean {
  return delivery.call_state == null || PENDING_STATES.has(delivery.call_state);
}

function groupMissed(group: readonly CommsDelivery[]): boolean {
  if (group.length === 0) return false;
  if (group.some(isAnsweredAttempt)) return false;
  if (group.some(isPending)) return false;
  return group[group.length - 1]?.call_state === 'missed';
}

function unreturnedResult(
  attempts: readonly CommsDelivery[],
  elapsed: number,
  within: number,
): KeyResult {
  if (attempts.length === 0) return { met: false, detail: 'No call yet' };
  if (attempts.some(isAnsweredAttempt)) return { met: false, detail: 'Answered' };
  if (!attempts.some((attempt) => MISS_STATES.has(attempt.call_state ?? ''))) {
    return { met: false, detail: 'Call still in progress' };
  }
  const first = Math.min(...attempts.map((attempt) => attempt.delivered_minute));
  if (elapsed - first < within) return { met: false, detail: `Waiting until T+${first + within}` };
  const returned = attempts.some((attempt) =>
    attempt.responses.some(
      (response) => response.attribution === 'call_returned' && response.minute <= first + within,
    ),
  );
  return { met: !returned, detail: returned ? 'Called back' : `No call-back within ${within} min` };
}

function missedCallsForStakeholder(state: CommsState, stakeholderId: string): number {
  const seen = new Set<string>();
  let count = 0;
  for (const list of Object.values(state.by_key)) {
    for (const delivery of list) {
      if (seen.has(delivery.delivery_id)) continue;
      seen.add(delivery.delivery_id);
      if (delivery.stakeholder_id !== stakeholderId) continue;
      if (delivery.channel !== 'call') continue;
      if (!MISS_STATES.has(delivery.call_state ?? '')) continue;
      count += 1;
    }
  }
  return count;
}

/** A failed or truncated read must not look like "nothing happened". */
function titleFromSlug(slug: string): string {
  return slug
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function signalTeam(input: KeyInput): { slug: string; label: string } | { detail: string } {
  if (input.role && !input.team) {
    const slug = input.state.role_teams?.[input.role];
    if (!slug) return { detail: `Role ${input.role} is not on a team` };
    return { slug, label: input.state.team_labels?.[slug] ?? titleFromSlug(slug) };
  }
  if (!input.team) return { detail: 'MO-COND-010: a team or role scope is required' };
  return {
    slug: input.team,
    label: input.state.team_labels?.[input.team] ?? titleFromSlug(input.team),
  };
}

function signalUnavailable(kind: string): KeyResult {
  return { met: false, detail: `${kind} is unavailable` };
}

function dutyResult(mode: 'missed' | 'done' | 'late', input: KeyInput): KeyResult {
  const team = signalTeam(input);
  if (!('slug' in team)) return { met: false, detail: team.detail };
  if (input.state.duties_known === false || input.state.duties == null) {
    return signalUnavailable('Duty history');
  }
  const actionId = input.args[0] ?? '';
  const duty =
    (input.state.duties[team.slug] ?? []).find((row) => row.action_id === actionId) ?? null;
  if (!duty) return { met: false, detail: `${team.label} has no duty ${actionId}` };
  const completed = duty.completed_minute;
  if (mode === 'done') {
    const met = completed != null && completed <= input.elapsed;
    return {
      met,
      detail: met
        ? `${team.label} completed ${actionId} at T+${completed}`
        : `${team.label} has not completed ${actionId}`,
    };
  }
  if (mode === 'late') {
    const benchmark = duty.benchmark_minute;
    const met =
      completed != null && benchmark != null && completed > benchmark && completed <= input.elapsed;
    return {
      met,
      detail: met
        ? `${team.label} completed ${actionId} at T+${completed}, after T+${benchmark}`
        : `${team.label} did not complete ${actionId} late`,
    };
  }
  if (input.state.duties_truncated) return { met: false, detail: 'Duty history is incomplete' };
  const override = input.args.length > 1 ? numberArg(input.args, 1) : null;
  const deadline = override != null && Number.isFinite(override) ? override : duty.benchmark_minute;
  if (deadline == null) return { met: false, detail: `${team.label}: ${actionId} has no deadline` };
  const met = input.elapsed > deadline && (completed == null || completed > deadline);
  return {
    met,
    detail: met
      ? `${team.label} missed ${actionId} (due T+${deadline})`
      : `${team.label}: ${actionId} due at T+${deadline}`,
  };
}

function teamSilentResult(input: KeyInput): KeyResult {
  const team = signalTeam(input);
  if (!('slug' in team)) return { met: false, detail: team.detail };
  if (input.state.team_activity_known === false || input.state.team_activity == null) {
    return signalUnavailable('Team activity');
  }
  if (input.state.team_activity_truncated)
    return { met: false, detail: 'Team activity is incomplete' };
  const n = numberArg(input.args, 0);
  const last = input.state.team_activity[team.slug]?.last_minute ?? null;
  const quiet = last == null ? input.elapsed : input.elapsed - last;
  const met = input.elapsed >= n && quiet >= n;
  const since = last == null ? 'the start' : `T+${last}`;
  return { met, detail: `${team.label}: no action since ${since} (${quiet} min)` };
}

function contentFailedResult(input: KeyInput): KeyResult {
  const team = signalTeam(input);
  if (!('slug' in team)) return { met: false, detail: team.detail };
  if (input.state.content_grades_known === false || input.state.content_grades == null) {
    return signalUnavailable('Content grades');
  }
  const n = numberArg(input.args, 0);
  const score = numberArg(input.args, 1);
  const grades = input.state.content_grades[team.slug] ?? [];
  const below = grades.filter((grade) => grade < score).length;
  return {
    met: below >= n,
    detail: `${team.label}: ${below} graded items scored below ${score}`,
  };
}

function decisionMadeResult(input: KeyInput): KeyResult {
  const team = signalTeam(input);
  if (!('slug' in team)) return { met: false, detail: team.detail };
  if (input.state.decisions_enabled === false) {
    return { met: false, detail: 'Executive decisions are off' };
  }
  if (input.state.decisions_known === false) return signalUnavailable('Decision history');
  const category = input.args[0] ?? '';
  const hit = (input.state.decisions ?? []).find(
    (row) =>
      row.team_slug === team.slug && row.category === category && row.minute <= input.elapsed,
  );
  const label = category.replace(/_/g, ' ');
  return {
    met: hit != null,
    detail: hit
      ? `${team.label}: ${label} decision at T+${hit.minute}`
      : `${team.label}: no ${label} decision`,
  };
}

function factBlock(
  state: CommsState,
  source: 'actions' | 'email' | 'contacts',
  absence: boolean,
): string | null {
  if (source === 'actions') {
    if (state.action_facts_known === false) return 'Action history is unavailable';
    if (absence && state.action_counts_truncated) return 'Action history is incomplete';
  } else if (source === 'email') {
    if (state.email_facts_known === false) return 'Email history is unavailable';
    if (absence && state.email_facts_truncated) return 'Email history is incomplete';
  } else if (state.contact_facts_known === false) {
    return 'Contact history is unavailable';
  } else if (absence && state.contact_facts_truncated) {
    return 'Contact history is incomplete';
  }
  return null;
}

function actionStats(
  state: CommsState,
  actionType: string,
  team: string | undefined,
): { count: number; first: number | null } {
  const rows = (state.action_counts ?? []).filter(
    (row) => row.action_type === actionType && (team == null || row.team_slug === team),
  );
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  const first = rows.length === 0 ? null : Math.min(...rows.map((row) => row.first_minute));
  return { count, first };
}

export interface PublishCandidate {
  id: string;
  severity?: string | null;
  eligible_after_minutes?: number | null;
  inject_key?: string | null;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function severityRank(value: string | null | undefined): number {
  if (!value) return 0;
  return SEVERITY_RANK[value.toLowerCase()] ?? 0;
}

/** Highest severity first, then earliest eligibility, then inject key. */
export function orderPublishCandidates<T extends PublishCandidate>(met: readonly T[]): T[] {
  return [...met].sort((a, b) => {
    const severity = severityRank(b.severity) - severityRank(a.severity);
    if (severity !== 0) return severity;
    const eligible = (a.eligible_after_minutes ?? 0) - (b.eligible_after_minutes ?? 0);
    if (eligible !== 0) return eligible;
    return (a.inject_key ?? '').localeCompare(b.inject_key ?? '');
  });
}

/**
 * Fill the per-tick cap from the ordered list.
 * `skip` is a gate or delay: it does not consume a slot, and the walk continues,
 * so a held inject cannot keep the slots at the head of the queue.
 */
export function selectPublishable<T extends PublishCandidate>(
  met: readonly T[],
  maxPerTick: number,
  skip?: (item: T) => boolean,
): { publish: T[]; deferred: T[]; skipped: T[] } {
  const limit = Number.isFinite(maxPerTick) && maxPerTick > 0 ? Math.floor(maxPerTick) : 0;
  const publish: T[] = [];
  const deferred: T[] = [];
  const skipped: T[] = [];
  for (const item of orderPublishCandidates(met)) {
    if (skip?.(item)) {
      skipped.push(item);
      continue;
    }
    if (publish.length < limit) publish.push(item);
    else deferred.push(item);
  }
  return { publish, deferred, skipped };
}

export interface StakeholderContactRow {
  stakeholder_id: string;
  channel: string;
  created_at: string;
}

export function summariseStakeholderContacts(
  rows: readonly StakeholderContactRow[],
  startTime: string | null,
): Record<string, { first_minute: number; latest_minute: number; channels: string[] }> {
  const out: Record<string, { first_minute: number; latest_minute: number; channels: string[] }> =
    {};
  for (const row of rows) {
    const minute = sessionMinuteAt(startTime, row.created_at);
    const current = out[row.stakeholder_id];
    if (!current) {
      out[row.stakeholder_id] = {
        first_minute: minute,
        latest_minute: minute,
        channels: [row.channel],
      };
      continue;
    }
    if (minute < current.first_minute) current.first_minute = minute;
    if (minute > current.latest_minute) current.latest_minute = minute;
    if (!current.channels.includes(row.channel)) current.channels.push(row.channel);
  }
  return out;
}

export interface PlayerActionFact {
  action_type: string;
  team_at_action?: string | null;
  created_at: string;
  metadata?: unknown;
}

export function summariseActionCounts(
  rows: readonly PlayerActionFact[],
  startTime: string | null,
): ActionCountBucket[] {
  const buckets = new Map<string, ActionCountBucket>();
  for (const row of rows) {
    const teamSlug = row.team_at_action ? slugifyTeamName(row.team_at_action) || null : null;
    const key = `${row.action_type}\0${teamSlug ?? ''}`;
    const minute = sessionMinuteAt(startTime, row.created_at);
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        action_type: row.action_type,
        team_slug: teamSlug,
        count: 1,
        first_minute: minute,
      });
      continue;
    }
    bucket.count += 1;
    if (minute < bucket.first_minute) bucket.first_minute = minute;
  }
  return [...buckets.values()];
}

export function firstEmailMinuteByStakeholder(
  rows: readonly PlayerActionFact[],
  stakeholders: readonly { id: string; email?: string | null }[],
  startTime: string | null,
): Record<string, number> {
  const byEmail = new Map<string, string>();
  for (const stakeholder of stakeholders) {
    const email = stakeholder.email?.trim().toLowerCase();
    if (email) byEmail.set(email, stakeholder.id);
  }
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.action_type !== 'email_sent') continue;
    if (!row.metadata || typeof row.metadata !== 'object') continue;
    const record = row.metadata as { to_addresses?: unknown; cc_addresses?: unknown };
    const addresses = [...stringList(record.to_addresses), ...stringList(record.cc_addresses)];
    const minute = sessionMinuteAt(startTime, row.created_at);
    for (const address of addresses) {
      const id = byEmail.get(address.trim().toLowerCase());
      if (!id) continue;
      if (out[id] == null || minute < out[id]) out[id] = minute;
    }
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
