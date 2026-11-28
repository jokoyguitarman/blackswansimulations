/**
 * §8.3 supplier email and its five response branches.
 * The parent lands at T+0. The :10 and :15 windows are measured from that
 * delivery. §9.1's replies are the session minutes T+12 and T+14.
 * One evaluation per session minute, matching the scheduler: a call missed
 * during the minute it is published is visible on the next minute.
 */

import {
  evaluateInjectConditions,
  type EvaluationContext,
} from '../../conditionEvaluatorService.js';
import { selectPublishable, type PublishCandidate } from '../../conditions/commsConditionsCore.js';
import { nextAttempt, type RedialGroup, type StopSignals } from '../../calls/callCore.js';
import {
  buildCommsState,
  type CommsState,
  type JudgementV1,
  type LedgerDeliveryRow,
  type LedgerResponseRow,
} from '../injectLedgerCore.js';

/** The phone service rings for 30s when the inject does not set ring_seconds. A ring this short ends inside the publish minute. */
const BASE_RING_SECONDS = 30;
const PUBLISH_CAP = 3;

export const SUPPLIER_DELIVERED_MINUTE = 0;
export const SUPPLIER_KEY = 'supplier_4471';

export interface SupplierBranch extends PublishCandidate {
  title: string;
  app: string;
  appear: { all: string[] };
  cancel: string[];
}

export const SUPPLIER_BRANCHES: readonly SupplierBranch[] = [
  {
    id: 'chaser',
    inject_key: 'supplier_4471_chaser',
    title: 'Chaser',
    app: 'email',
    appear: { all: ['email_unreplied:supplier_4471:10'] },
    cancel: ['email_replied:supplier_4471'],
    eligible_after_minutes: 0,
  },
  {
    id: 'phones',
    inject_key: 'supplier_4471_call',
    title: 'Supplier phones',
    app: 'phone_call',
    appear: { all: ['email_unreplied:supplier_4471:15'] },
    cancel: ['email_replied:supplier_4471'],
    eligible_after_minutes: 0,
  },
  {
    id: 'public',
    inject_key: 'supplier_4471_public',
    title: 'Public complaint',
    app: 'social_feed',
    appear: { all: ['email_unreplied:supplier_4471:15', 'call_missed:supplier_4471_call'] },
    cancel: [],
    eligible_after_minutes: 0,
  },
  {
    id: 'legal',
    inject_key: 'supplier_4471_legal',
    title: 'Escalates to legal',
    app: 'email',
    appear: { all: ['reply_tone:supplier_4471:defensive'] },
    cancel: ['reply_best_passed:supplier_4471'],
    eligible_after_minutes: 0,
  },
  {
    id: 'thanks',
    inject_key: 'supplier_4471_thanks',
    title: 'Thanks',
    app: 'email',
    appear: { all: ['reply_passed:supplier_4471'] },
    cancel: ['reply_failed:supplier_4471'],
    eligible_after_minutes: 0,
  },
];

export type SupplierBehaviour =
  | { kind: 'none' }
  | { kind: 'defensive'; minute: number }
  | { kind: 'good'; minute: number };

export interface FiredBranch {
  minute: number;
  key: string;
  title: string;
}

const QUIET: StopSignals = {
  called_back: false,
  contacted_elsewhere_at_minute: null,
  chain_stopped: false,
  session_ended: false,
};

const DEFENSIVE: JudgementV1 = {
  v: 1,
  addresses_inject: true,
  tone: 'defensive',
  passed: false,
  tone_ok: false,
};

const GOOD: JudgementV1 = {
  v: 1,
  addresses_inject: true,
  tone: 'professional',
  passed: true,
  tone_ok: true,
};

export function walkSupplier(behaviour: SupplierBehaviour): {
  published: FiredBranch[];
  cancelled: FiredBranch[];
} {
  const deliveries: LedgerDeliveryRow[] = [
    {
      id: 'del-supplier',
      inject_id: 'inj-supplier',
      inject_key: SUPPLIER_KEY,
      channel: 'email',
      delivered_minute: SUPPLIER_DELIVERED_MINUTE,
      recipient_teams: ['Ops'],
      stakeholder_id: 'stk_supplier',
    },
  ];
  const responses: LedgerResponseRow[] = [];
  const published = new Set<string>();
  const cancelled = new Set<string>();
  const fired: FiredBranch[] = [];
  const dropped: FiredBranch[] = [];

  for (let minute = 0; minute <= 30; minute += 1) {
    if (behaviour.kind !== 'none' && behaviour.minute === minute && responses.length === 0) {
      responses.push({
        id: 'resp-supplier',
        delivery_id: 'del-supplier',
        response_minute: minute,
        team_name: 'Ops',
        user_id: 'ops-player',
        attribution: 'email_reply',
        judgement_status: 'done',
        judgement: behaviour.kind === 'defensive' ? DEFENSIVE : GOOD,
      });
    }

    const state = buildCommsState({ deliveries, responses, elapsedMinutes: minute });
    const ready: SupplierBranch[] = [];
    for (const branch of SUPPLIER_BRANCHES) {
      const key = branch.inject_key ?? branch.id;
      if (published.has(key) || cancelled.has(key)) continue;
      const result = evaluateInjectConditions(branch.appear, branch.cancel, context(state, minute));
      if (result.status === 'cancel_met') {
        cancelled.add(key);
        dropped.push({ minute, key, title: branch.title });
        continue;
      }
      if (result.status === 'appear_met') ready.push(branch);
    }

    const picked = selectPublishable(ready, PUBLISH_CAP);
    for (const branch of picked.publish) {
      const key = branch.inject_key ?? branch.id;
      published.add(key);
      fired.push({ minute, key, title: branch.title });
      if (branch.app === 'phone_call') deliveries.push(missedSupplierCall(minute));
    }
  }

  return { published: fired, cancelled: dropped };
}

function context(state: CommsState, minute: number): EvaluationContext {
  return {
    sessionId: 'supplier-fixture',
    scenarioId: 'supplier-fixture',
    elapsedMinutes: minute,
    currentState: { comms_state: state },
    executedDecisions: [],
    publishedScenarioInjectIds: [],
  };
}

/** One attempt, no redial. A 30s ring ends in the publish minute. */
function missedSupplierCall(minute: number): LedgerDeliveryRow {
  const group: RedialGroup = {
    max_attempts: 1,
    interval_minutes: 2,
    stop_on_contact: true,
    attempts: [
      { attempt_no: 1, status: 'missed', ended_minute: minute, scheduled_for_minute: minute },
    ],
  };
  const plan = nextAttempt(group, minute, QUIET);
  const finishedThisMinute = plan.action === 'finished' && BASE_RING_SECONDS < 60;
  return {
    id: 'call-supplier',
    inject_id: 'inj-supplier-call',
    inject_key: 'supplier_4471_call',
    channel: 'call',
    delivered_minute: minute,
    recipient_teams: ['Ops'],
    stakeholder_id: 'stk_supplier',
    call_state: finishedThisMinute ? 'missed' : 'ringing',
    call_group_id: 'supplier-call-group',
    attempt_no: 1,
  };
}
