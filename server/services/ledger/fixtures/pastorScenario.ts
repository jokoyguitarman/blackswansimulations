/**
 * §10.8 A (email → text → call → senior escalation) and §11.7 A (call-back mood).
 * One decision per session minute. A ring shorter than 60s ends in the minute
 * it starts, so the chain's 45s ring (30s default + the final-urgency extra)
 * is a miss at T+28 and the redial, two minutes later, is a miss at T+30.
 */

import { nextAttempt, parseRedial, type RedialGroup, type StopSignals } from '../../calls/callCore.js';
import { parseConditionKey } from '../../conditions/conditionCatalog.js';
import { evaluateCommsKey, selectPublishable } from '../../conditions/commsConditionsCore.js';
import {
  decideChainAction,
  maxUrgencySent,
  nextDueAfterSend,
  resolveStep,
  urgencyEffects,
  type ChainClock,
  type ChainSnapshot,
  type EscalationConfig,
} from '../../escalation/escalationCore.js';
import { buildCommsState, type CommsState, type LedgerDeliveryRow } from '../injectLedgerCore.js';
import {
  buildMoodBlock,
  computeWaitProfile,
  consequencesToFire,
  DEFAULT_MOOD_LADDER,
  renderMoodPlaceholders,
  resolveGaveUpAfter,
  selectRung,
  type MoodDeliveryFact,
  type MoodLadder,
} from '../../mood/moodCore.js';

/** Phone service default when the inject does not set ring_seconds. */
const BASE_RING_SECONDS = 30;
const PUBLISH_CAP = 3;
const CALLBACK_WINDOW_MINUTES = 30;

export const PASTOR_ROOT_MINUTE = 10;
export const PASTOR_ROOT_KEY = 'pastor_welfare_email';
export const PASTOR_PRESS_KEY = 'pastor_goes_public';
export const PASTOR_GAVE_UP_KEY = 'pastor_goes_to_press';
export const PASTOR_STAKEHOLDER = 'stk_pastor';
export const PASTOR_TEAM = 'Stakeholder Engagement';

export const PASTOR_ESCALATION: EscalationConfig = {
  max_steps: 4,
  scope: 'per_team',
  stop_on: 'any_response',
  stop_on_contact: true,
  steps: [
    {
      after_minutes: 5,
      urgency: 'follow_up',
      app: 'same',
      content_mode: 'template',
      template:
        'Following up on my email below. Could you confirm {ask}? It has been {minutes_waiting} minutes.',
    },
    {
      after_minutes: 5,
      urgency: 'urgent',
      app: 'npc_dm',
      content_mode: 'ai',
      brief: 'Short text message. You emailed twice and need an answer before the evening shift change.',
    },
    {
      after_minutes: 8,
      urgency: 'final',
      app: 'phone_call',
      content_mode: 'template',
      redial: { attempts: 2, interval_minutes: 2 },
    },
    {
      after_minutes: 10,
      urgency: 'escalated',
      app: 'email',
      content_mode: 'template',
      sender_stakeholder_id: 'stk_union_rep',
      cc_team: 'Executive',
      template:
        "Subject: Workers still waiting for an answer\nI'm writing on behalf of Pastor Daniel, who has tried to reach {recipient_team} {followups_sent} times since T+{root_minute}.",
    },
  ],
  on_exhausted: { publish_inject_key: PASTOR_PRESS_KEY },
};

const QUIET: StopSignals = {
  called_back: false,
  contacted_elsewhere_at_minute: null,
  chain_stopped: false,
  session_ended: false,
};

export interface ChainStepEvent {
  minute: number;
  step: number;
  urgency: string;
  app: string;
}

export interface AttemptEvent {
  minute: number;
  attempt: number;
  of: number;
  state: 'missed';
}

export interface ChainWalk {
  steps: ChainStepEvent[];
  attempts: AttemptEvent[];
  /** First minute `call_missed_count:<root>:2` is true. Null when the chain never calls. */
  missedCountTrueAt: number | null;
  stopped: { minute: number; reason: string; afterStep: number } | null;
  stoppedByStep1: boolean;
  pressMinute: number | null;
  /** 30s default plus the final step's urgency extra. The spec's ring is 45s. */
  callRingSeconds: number | null;
}

interface MutableClock {
  stepsSent: number;
  lastMinute: number;
  nextDue: number;
  waiting: string | null;
  status: 'active' | 'stopped' | 'exhausted';
  stoppedReason: string | null;
  stoppedMinute: number | null;
  stoppedAfter: number | null;
}

export function walkPastorChain(replyAt: number | null): ChainWalk {
  const clock: MutableClock = {
    stepsSent: 0,
    lastMinute: PASTOR_ROOT_MINUTE,
    nextDue: PASTOR_ROOT_MINUTE + (PASTOR_ESCALATION.steps[0]?.after_minutes ?? 5),
    waiting: null,
    status: 'active',
    stoppedReason: null,
    stoppedMinute: null,
    stoppedAfter: null,
  };
  const steps: ChainStepEvent[] = [];
  const attempts: AttemptEvent[] = [];
  const deliveries: LedgerDeliveryRow[] = [
    {
      id: 'pastor-root',
      inject_id: 'pastor-root-inject',
      inject_key: PASTOR_ROOT_KEY,
      channel: 'email',
      delivered_minute: PASTOR_ROOT_MINUTE,
      recipient_teams: [PASTOR_TEAM],
      stakeholder_id: PASTOR_STAKEHOLDER,
    },
  ];
  let group: RedialGroup | null = null;
  let ringSeconds: number | null = null;
  let missedCountTrueAt: number | null = null;
  let stoppedByStep1 = false;
  let pressMinute: number | null = null;
  const seenAttempts = new Set<number>();

  for (let minute = PASTOR_ROOT_MINUTE; minute <= 60 && clock.status === 'active'; minute += 1) {
    if (group) pump(group, minute, ringSeconds ?? BASE_RING_SECONDS, attempts, deliveries, seenAttempts);
    const decision = decideChainAction({
      chain: toClock(clock),
      responses: [],
      contactMinute: replyAt != null && minute >= replyAt ? replyAt : null,
      callGroup: clock.waiting && group ? factOf(group) : null,
      elapsed: minute,
      sessionStatus: 'in_progress',
      held: false,
    });

    if (decision.kind === 'stop') {
      clock.status = 'stopped';
      clock.stoppedReason = decision.reason;
      clock.stoppedMinute = minute;
      clock.stoppedAfter = decision.stoppedAfterStep;
    } else if (decision.kind === 'wait') {
      if (decision.clearCall) {
        clock.waiting = null;
        if (decision.lastStepMinute != null) clock.lastMinute = decision.lastStepMinute;
        if (decision.nextDueMinute != null) clock.nextDue = decision.nextDueMinute;
      }
    } else if (decision.kind === 'send') {
      const step = resolveStep(PASTOR_ESCALATION, decision.stepNo, 'email');
      if (step) {
        steps.push({ minute, step: step.stepNo, urgency: step.urgency, app: step.appResolved });
        clock.stepsSent = step.stepNo;
        clock.lastMinute = minute;
        if (step.appResolved === 'phone_call') {
          const redial = parseRedial(step.redial);
          ringSeconds = BASE_RING_SECONDS + urgencyEffects(step.urgency).ringSecondsExtra;
          group = {
            max_attempts: redial.attempts,
            interval_minutes: redial.interval_minutes,
            stop_on_contact: redial.stop_on_contact,
            attempts: [],
          };
          clock.waiting = 'pastor-call-group';
          begin(group, minute, ringSeconds, attempts, deliveries, seenAttempts);
        } else {
          const following = resolveStep(PASTOR_ESCALATION, step.stepNo + 1, 'email');
          clock.nextDue = nextDueAfterSend({
            elapsed: minute,
            nextDueMinute: clock.nextDue,
            sentAfterMinutes: step.after_minutes,
            followingAfterMinutes: following?.after_minutes ?? step.after_minutes,
          });
        }
      }
    } else if (decision.kind === 'exhaust') {
      clock.status = 'exhausted';
    }

    const state = chainState(clock, deliveries, minute);
    if (
      missedCountTrueAt == null &&
      commsTrue(state, `call_missed_count:${PASTOR_ROOT_KEY}:2`, minute)
    ) {
      missedCountTrueAt = minute;
    }
    if (
      !stoppedByStep1 &&
      clock.status === 'stopped' &&
      commsTrue(state, `chain_stopped_by_step:${PASTOR_ROOT_KEY}:1`, minute)
    ) {
      stoppedByStep1 = true;
    }
    if (clock.status === 'exhausted' && pressMinute == null) {
      const met = commsTrue(state, `chain_exhausted:${PASTOR_ROOT_KEY}`, minute)
        ? [{ id: 'press', inject_key: PASTOR_PRESS_KEY, eligible_after_minutes: 0, severity: 'high' }]
        : [];
      const picked = selectPublishable(met, PUBLISH_CAP);
      if (picked.publish.some((item) => item.inject_key === PASTOR_PRESS_KEY)) pressMinute = minute;
    }
  }

  return {
    steps,
    attempts,
    missedCountTrueAt,
    stopped:
      clock.status === 'stopped' && clock.stoppedMinute != null && clock.stoppedAfter != null
        ? { minute: clock.stoppedMinute, reason: clock.stoppedReason ?? '', afterStep: clock.stoppedAfter }
        : null,
    stoppedByStep1,
    pressMinute,
    callRingSeconds: ringSeconds,
  };
}

function toClock(clock: MutableClock): ChainClock {
  return {
    scope: 'per_team',
    scope_team: PASTOR_TEAM,
    scope_role: null,
    root_key: PASTOR_ROOT_KEY,
    root_delivery_id: 'pastor-root',
    stakeholder_id: PASTOR_STAKEHOLDER,
    stop_on: 'any_response',
    stop_on_contact: true,
    steps_sent: clock.stepsSent,
    max_steps: PASTOR_ESCALATION.max_steps,
    last_step_delivered_minute: clock.lastMinute,
    next_due_minute: clock.nextDue,
    waiting_on_call_group_id: clock.waiting,
    hold_through_minute: null,
    root_minute: PASTOR_ROOT_MINUTE,
    root_app: 'email',
    config: PASTOR_ESCALATION,
  };
}

function chainState(clock: MutableClock, deliveries: readonly LedgerDeliveryRow[], minute: number): CommsState {
  const snapshot: ChainSnapshot = {
    chain_id: 'pastor-chain',
    scope_team: PASTOR_TEAM,
    scope_role: null,
    status: clock.status,
    steps_sent: clock.stepsSent,
    max_steps: PASTOR_ESCALATION.max_steps,
    max_urgency: maxUrgencySent(PASTOR_ESCALATION, clock.stepsSent, 'email'),
    stopped_reason: clock.stoppedReason,
    stopped_minute: clock.stoppedMinute,
    stopped_after_step: clock.stoppedAfter,
  };
  return {
    ...buildCommsState({ deliveries, responses: [], elapsedMinutes: minute }),
    chains: { [PASTOR_ROOT_KEY]: [snapshot] },
  };
}

function factOf(group: RedialGroup): { finished: boolean; finish_minute: number | null; answered: boolean } {
  const attempts = [...group.attempts].sort((left, right) => left.attempt_no - right.attempt_no);
  const latest = attempts[attempts.length - 1];
  const answered = attempts.some((attempt) => attempt.answered || attempt.status === 'ended');
  const live = attempts.some(
    (attempt) =>
      attempt.status === 'scheduled' ||
      attempt.status === 'ringing' ||
      attempt.status === 'connecting' ||
      attempt.status === 'active',
  );
  const finished =
    !live &&
    !answered &&
    latest != null &&
    (latest.status === 'missed' || latest.status === 'declined') &&
    latest.attempt_no >= group.max_attempts;
  return { finished, finish_minute: latest?.ended_minute ?? null, answered };
}

function begin(
  group: RedialGroup,
  minute: number,
  ringSeconds: number,
  log: AttemptEvent[],
  deliveries: LedgerDeliveryRow[],
  seen: Set<number>,
): void {
  if (ringSeconds >= 60) {
    group.attempts.push({
      attempt_no: 1,
      status: 'ringing',
      ended_minute: null,
      scheduled_for_minute: minute,
    });
    return;
  }
  group.attempts.push({
    attempt_no: 1,
    status: 'missed',
    ended_minute: minute,
    scheduled_for_minute: minute,
  });
  noteAttempt(1, minute, group.max_attempts, log, deliveries, seen);
  pump(group, minute, ringSeconds, log, deliveries, seen);
}

function pump(
  group: RedialGroup,
  minute: number,
  ringSeconds: number,
  log: AttemptEvent[],
  deliveries: LedgerDeliveryRow[],
  seen: Set<number>,
): void {
  for (let guard = 0; guard < 8; guard += 1) {
    const plan = nextAttempt(group, minute, QUIET);
    if (plan.action === 'wait' || plan.action === 'finished' || plan.action === 'cancel') return;
    if (plan.action === 'schedule') {
      group.attempts.push({
        attempt_no: plan.attempt_no,
        status: 'scheduled',
        ended_minute: null,
        scheduled_for_minute: plan.at_minute,
      });
      continue;
    }
    const attempt = group.attempts.find((item) => item.attempt_no === plan.attempt_no);
    if (!attempt || ringSeconds >= 60) return;
    attempt.status = 'missed';
    attempt.ended_minute = minute;
    noteAttempt(attempt.attempt_no, minute, group.max_attempts, log, deliveries, seen);
  }
}

function noteAttempt(
  attempt: number,
  minute: number,
  of: number,
  log: AttemptEvent[],
  deliveries: LedgerDeliveryRow[],
  seen: Set<number>,
): void {
  if (seen.has(attempt)) return;
  seen.add(attempt);
  log.push({ minute, attempt, of, state: 'missed' });
  deliveries.push({
    id: `pastor-attempt-${attempt}`,
    inject_id: 'pastor-step-3',
    inject_key: `${PASTOR_ROOT_KEY}__s3`,
    channel: 'call',
    delivered_minute: minute,
    recipient_teams: [PASTOR_TEAM],
    stakeholder_id: PASTOR_STAKEHOLDER,
    call_state: 'missed',
    call_group_id: 'pastor-call-group',
    attempt_no: attempt,
    chain_root_key: PASTOR_ROOT_KEY,
    chain_step: 3,
    urgency: 'final',
  });
}

export function pastorLadder(): MoodLadder {
  return {
    ...DEFAULT_MOOD_LADDER,
    rungs: DEFAULT_MOOD_LADDER.rungs.map((item) =>
      item.id === 'gave_up'
        ? {
            ...item,
            consequences: [
              { type: 'publish_inject', inject_key: PASTOR_GAVE_UP_KEY },
              ...item.consequences,
            ],
          }
        : item,
    ),
  };
}

export interface CallbackSample {
  rung: string;
  opening: string;
  wait_minutes: number;
  missed_calls: number;
  unanswered_messages: number;
  block: string;
}

export interface MoodWalk {
  attempts: AttemptEvent[];
  pressMinute: number | null;
  gaveUpConsequences: string[];
  callback: (minute: number, unansweredEmails?: number) => CallbackSample;
}

export function walkPastorMood(): MoodWalk {
  const ladder = pastorLadder();
  const gaveUpAfter = resolveGaveUpAfter(ladder, CALLBACK_WINDOW_MINUTES);
  const redial = { attempts: 3, interval: 3, ringSeconds: BASE_RING_SECONDS };
  let pressMinute: number | null = null;
  let gaveUpConsequences: string[] = [];
  let current: { rungId: string } | null = null;
  const fired: string[] = [];

  for (let minute = PASTOR_ROOT_MINUTE; minute <= 45; minute += 1) {
    const attempts = runCall(minute, redial.attempts, redial.interval, redial.ringSeconds);
    const profile = computeWaitProfile({
      stakeholderId: PASTOR_STAKEHOLDER,
      scope: PASTOR_TEAM,
      atMinute: minute,
      deliveries: attemptFacts(attempts),
      gaveUpAfter,
    });
    const selected = selectRung(ladder, profile, current);
    current = { rungId: selected.rung.id };
    if (selected.rung.id === 'gave_up' && gaveUpConsequences.length === 0) {
      gaveUpConsequences = consequencesToFire(selected.rung, fired).map((item) => item.consequence.type);
    }
    const state = moodState(selected.rung.id, selected.rung.terminal === true, minute);
    if (pressMinute == null && commsTrue(state, `stakeholder_gave_up:${PASTOR_STAKEHOLDER}`, minute)) {
      const picked = selectPublishable(
        [{ id: 'gave-up-press', inject_key: PASTOR_GAVE_UP_KEY, eligible_after_minutes: 0, severity: 'high' }],
        PUBLISH_CAP,
      );
      if (picked.publish.some((item) => item.inject_key === PASTOR_GAVE_UP_KEY)) pressMinute = minute;
    }
  }

  return {
    attempts: runCall(45, redial.attempts, redial.interval, redial.ringSeconds),
    pressMinute,
    gaveUpConsequences,
    callback(minute: number, unansweredEmails = 0): CallbackSample {
      const profile = computeWaitProfile({
        stakeholderId: PASTOR_STAKEHOLDER,
        scope: PASTOR_TEAM,
        atMinute: minute,
        deliveries: [
          ...attemptFacts(runCall(minute, redial.attempts, redial.interval, redial.ringSeconds)),
          ...unansweredEmailsAt(unansweredEmails),
        ],
        gaveUpAfter,
      });
      const selected = selectRung(ladder, profile);
      const opening = selected.rung.script.opening
        ? renderMoodPlaceholders(selected.rung.script.opening, profile)
        : '';
      return {
        rung: selected.rung.id,
        opening,
        wait_minutes: profile.wait_minutes,
        missed_calls: profile.missed_calls,
        unanswered_messages: profile.unanswered_messages,
        block: buildMoodBlock(selected.rung, profile, { name: 'Pastor Daniel' }, {
          includeScript: true,
          recovery: ladder.recovery,
        }),
      };
    },
  };
}

function unansweredEmailsAt(count: number): MoodDeliveryFact[] {
  return Array.from({ length: count }, (_, index) => ({
    delivery_id: `pastor-mail-${index}`,
    stakeholder_id: PASTOR_STAKEHOLDER,
    channel: 'email',
    delivered_minute: PASTOR_ROOT_MINUTE + 1 + index,
    recipient_teams: [PASTOR_TEAM],
  }));
}

function attemptFacts(attempts: readonly AttemptEvent[]): MoodDeliveryFact[] {
  return attempts.map((attempt) => ({
    delivery_id: `pastor-mood-call-${attempt.attempt}`,
    stakeholder_id: PASTOR_STAKEHOLDER,
    channel: 'call',
    delivered_minute: attempt.minute,
    call_state: 'missed',
    recipient_teams: [PASTOR_TEAM],
  }));
}

function moodState(rungId: string, terminal: boolean, minute: number): CommsState {
  const ladder = pastorLadder();
  const ids = ladder.rungs
    .filter((item) => item.variant_of !== 'escalated' || item.id === ladder.escalated_variant)
    .map((item) => item.id);
  return {
    ...buildCommsState({ deliveries: [], responses: [], elapsedMinutes: minute }),
    moods: [
      {
        stakeholder_id: PASTOR_STAKEHOLDER,
        scope_team: PASTOR_TEAM,
        rung_id: rungId,
        rung_index: Math.max(0, ids.indexOf(rungId)),
        ladder_ids: ids,
        history: [{ rung: rungId }],
        terminal,
      },
    ],
  };
}

function runCall(until: number, maxAttempts: number, interval: number, ringSeconds: number): AttemptEvent[] {
  const group: RedialGroup = {
    max_attempts: maxAttempts,
    interval_minutes: interval,
    stop_on_contact: true,
    attempts: [],
  };
  const log: AttemptEvent[] = [];
  const seen = new Set<number>();
  for (let minute = PASTOR_ROOT_MINUTE; minute <= until; minute += 1) {
    if (minute === PASTOR_ROOT_MINUTE) begin(group, minute, ringSeconds, log, [], seen);
    else pump(group, minute, ringSeconds, log, [], seen);
  }
  return log;
}

function commsTrue(state: CommsState, key: string, minute: number): boolean {
  const parsed = parseConditionKey(key);
  if ('error' in parsed) throw new Error(parsed.error);
  const met = evaluateCommsKey(parsed, state, minute);
  if (met === undefined) throw new Error(`Not a comms key: ${key}`);
  return met;
}
