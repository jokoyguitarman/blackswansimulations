/**
 * Condition evaluator service — Step 3
 * Evaluates conditions_to_appear and conditions_to_cancel against current game state.
 * Used by the inject engine (Step 4) every 5-minute cycle. No DB calls; all data from context.
 * See docs/roadmap/step-03-condition-evaluator.md.
 */

import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Types (contract with inject engine)
// ---------------------------------------------------------------------------

export type ConditionsToAppear = { threshold: number; conditions: string[] } | { all: string[] };

export type ConditionsToCancel = string[];

export interface EvaluationContext {
  sessionId: string;
  scenarioId: string;
  elapsedMinutes: number;
  currentState: Record<string, unknown>;
  executedDecisions: Array<{
    id: string;
    decision_type?: string;
    title?: string;
    description?: string;
    tags?: string[];
  }>;
  publishedScenarioInjectIds: string[];
  publishedInjectKeysOrTags?: string[];
  pathwayOutcomeKeysFired?: string[];
  objectiveProgress?: Array<{
    objective_id: string;
    objective_name?: string;
    status: string;
    progress_percentage?: number;
  }>;
  gateStatusByGateId?: Record<string, 'pending' | 'met' | 'not_met'>;
}

export type EvaluatorResult =
  | { status: 'appear_met' }
  | { status: 'cancel_met' }
  | { status: 'not_eligible' };

type ConditionFn = (ctx: EvaluationContext) => boolean;

// ---------------------------------------------------------------------------
// Condition registry: key -> (context) => boolean
// ---------------------------------------------------------------------------

function hasDecisionMatching(
  ctx: EvaluationContext,
  predicate: (d: EvaluationContext['executedDecisions'][0]) => boolean,
): boolean {
  return ctx.executedDecisions.some(predicate);
}

const conditionRegistry: Record<string, ConditionFn> = {
  // Decision not made
  no_media_management_decision: (ctx) =>
    !hasDecisionMatching(ctx, (d) => {
      const t = (d.decision_type ?? '').toLowerCase();
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        t.includes('media') ||
        t.includes('statement') ||
        title.includes('media') ||
        desc.includes('media') ||
        (d.tags ?? []).some((tag) => /media|statement/.test(String(tag)))
      );
    }),
  no_perimeter_establishment_decision: (ctx) =>
    !hasDecisionMatching(ctx, (d) => {
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        title.includes('perimeter') ||
        desc.includes('perimeter') ||
        (d.tags ?? []).some((tag) => /perimeter|cordon/.test(String(tag)))
      );
    }),
  no_patient_privacy_or_access_control_decision: (ctx) =>
    !hasDecisionMatching(ctx, (d) => {
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        title.includes('privacy') ||
        desc.includes('privacy') ||
        title.includes('access control') ||
        desc.includes('access control')
      );
    }),
  no_triage_perimeter_security_decision: (ctx) =>
    !hasDecisionMatching(ctx, (d) => {
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        (title.includes('triage') && (title.includes('perimeter') || title.includes('security'))) ||
        (desc.includes('triage') && (desc.includes('perimeter') || desc.includes('security')))
      );
    }),

  // Decision made
  official_public_statement_issued: (ctx) =>
    hasDecisionMatching(ctx, (d) => {
      const t = (d.decision_type ?? '').toLowerCase();
      const title = (d.title ?? '').toLowerCase();
      return t.includes('statement') || title.includes('statement') || title.includes('public');
    }),
  triage_zone_established_as_incident_location: (ctx) =>
    hasDecisionMatching(ctx, (d) => {
      const title = (d.title ?? '').toLowerCase();
      const desc = (d.description ?? '').toLowerCase();
      return (
        title.includes('triage') ||
        desc.includes('triage') ||
        (d.tags ?? []).some((tag) => /triage/.test(String(tag)))
      );
    }),

  // Prior inject fired (by key/tag; engine populates publishedInjectKeysOrTags or we match by scenario inject id)
  prior_social_media_rumour_inject_fired: (ctx) =>
    (ctx.publishedInjectKeysOrTags ?? []).some((k) =>
      /social_media|rumour|rumor|viral|misinformation/.test(String(k)),
    ),
  civilian_panic_or_rumour_inject_fired: (ctx) =>
    (ctx.publishedInjectKeysOrTags ?? []).some((k) =>
      /panic|rumour|rumor|civilian|misinformation/.test(String(k)),
    ),
  public_comms_channel_inactive: (ctx) =>
    !hasDecisionMatching(ctx, (d) => {
      const t = (d.decision_type ?? '').toLowerCase();
      const title = (d.title ?? '').toLowerCase();
      return t.includes('statement') || t.includes('comms') || title.includes('communication');
    }),

  // Pathway outcome fired (no double-hit)
  pathway_fired_exit_b_congestion: (ctx) =>
    (ctx.pathwayOutcomeKeysFired ?? []).some(
      (k) => k === 'exit_b_congestion' || /exit_b|congestion/.test(String(k)),
    ),
};

// ---------------------------------------------------------------------------
// Env state helpers (crowd density from currentState.environmental_state)
// ---------------------------------------------------------------------------

function getEnvAreas(
  ctx: EvaluationContext,
): Array<{ area_id?: string; label?: string; crowd_density?: number }> {
  const env = ctx.currentState?.environmental_state as
    | { areas?: Array<{ area_id?: string; label?: string; crowd_density?: number }> }
    | undefined;
  return Array.isArray(env?.areas) ? env.areas : [];
}

conditionRegistry['crowd_density_above_0.6'] = (ctx) =>
  getEnvAreas(ctx).some((a) => (a.crowd_density ?? 0) >= 0.6);

conditionRegistry.crowd_density_in_triage_zone_elevated = (ctx) =>
  getEnvAreas(ctx).some(
    (a) =>
      (a.label ?? '').toLowerCase().includes('triage') ||
      (a.area_id ?? '').toLowerCase().includes('triage'),
  ) && getEnvAreas(ctx).some((a) => (a.crowd_density ?? 0) >= 0.5);

// Objective progress
conditionRegistry.objective_evacuation_not_completed = (ctx) => {
  const progress = ctx.objectiveProgress ?? [];
  const evac = progress.find(
    (o) =>
      (o.objective_id ?? '').toLowerCase().includes('evacuation') ||
      (o.objective_name ?? '').toLowerCase().includes('evacuation'),
  );
  return evac ? evac.status !== 'completed' : false;
};

// Gate (optional)
conditionRegistry.evacuation_gate_not_met = (ctx) => {
  if (!ctx.gateStatusByGateId) return false;
  return Object.entries(ctx.gateStatusByGateId).some(
    ([id, status]) =>
      (String(id).toLowerCase().includes('evacuation') && status === 'not_met') || false,
  );
};

// ---------------------------------------------------------------------------
// Internal: resolve one condition key (prefix rules + registry)
// ---------------------------------------------------------------------------

function evaluateKey(key: string, context: EvaluationContext): boolean {
  const prefixPathway = 'prior_pathway_outcome_fired:';
  if (key.startsWith(prefixPathway)) {
    const consequenceKey = key.slice(prefixPathway.length);
    return (context.pathwayOutcomeKeysFired ?? []).includes(consequenceKey);
  }
  const prefixInject = 'inject_fired:';
  if (key.startsWith(prefixInject)) {
    const id = key.slice(prefixInject.length);
    return context.publishedScenarioInjectIds.includes(id);
  }
  const prefixObjective = 'objective_not_completed:';
  if (key.startsWith(prefixObjective)) {
    const objectiveId = key.slice(prefixObjective.length);
    const obj = (context.objectiveProgress ?? []).find((o) => o.objective_id === objectiveId);
    return obj ? obj.status !== 'completed' : false;
  }
  const prefixGate = 'gate_not_met:';
  if (key.startsWith(prefixGate) && context.gateStatusByGateId) {
    const gateId = key.slice(prefixGate.length);
    return context.gateStatusByGateId[gateId] === 'not_met';
  }

  const fn = conditionRegistry[key];
  if (fn) return fn(context);

  if (process.env.NODE_ENV !== 'production') {
    logger.debug({ key, sessionId: context.sessionId }, 'Unknown condition key, treating as false');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate one condition key against context. Used by evaluateInjectConditions; exposed for tests.
 */
export function evaluateConditionKey(key: string, context: EvaluationContext): boolean {
  return evaluateKey(key, context);
}

/**
 * Evaluate conditions_to_appear and conditions_to_cancel; return appear_met | cancel_met | not_eligible.
 * Cancel is evaluated first. No DB or API calls.
 */
export function evaluateInjectConditions(
  conditionsToAppear: ConditionsToAppear | null | undefined,
  conditionsToCancel: ConditionsToCancel | null | undefined,
  context: EvaluationContext,
): EvaluatorResult {
  // 1) Cancel first
  const cancelList = Array.isArray(conditionsToCancel) ? conditionsToCancel : [];
  for (const key of cancelList) {
    if (evaluateKey(key, context)) return { status: 'cancel_met' };
  }

  // 2) Empty appear -> not_eligible
  if (conditionsToAppear == null) return { status: 'not_eligible' };
  if (typeof conditionsToAppear !== 'object') return { status: 'not_eligible' };

  const allKeys =
    'all' in conditionsToAppear ? conditionsToAppear.all : conditionsToAppear.conditions;
  if (!Array.isArray(allKeys) || allKeys.length === 0) return { status: 'not_eligible' };

  // 3) Appear: all or N-of-M
  if ('all' in conditionsToAppear) {
    const allMet = allKeys.every((k) => evaluateKey(k, context));
    return allMet ? { status: 'appear_met' } : { status: 'not_eligible' };
  }

  // N-of-M: require at least threshold conditions true; threshold 0 is treated as 1 to avoid "always appear"
  const rawThreshold = (conditionsToAppear as { threshold: number }).threshold ?? 0;
  const threshold = Math.max(1, rawThreshold);
  const metCount = allKeys.filter((k) => evaluateKey(k, context)).length;
  return metCount >= threshold ? { status: 'appear_met' } : { status: 'not_eligible' };
}
