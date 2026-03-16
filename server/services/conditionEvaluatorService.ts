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
    categories?: string[];
    keywords?: string[];
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
  /** When set, decision-semantic condition keys use these values instead of registry (AI precomputed). */
  precomputedDecisionKeys?: Record<string, boolean>;
  /** Keys with state_path for generic resolution from currentState (e.g. police_state.perimeter_established). */
  scenarioConditionKeyDefs?: Array<{ key: string; state_path?: string; negate?: boolean }>;
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

// Team state (from current_state; Phase 2)
function getEvacuationState(ctx: EvaluationContext): Record<string, unknown> {
  return (ctx.currentState?.evacuation_state as Record<string, unknown>) ?? {};
}
function getTriageState(ctx: EvaluationContext): Record<string, unknown> {
  return (ctx.currentState?.triage_state as Record<string, unknown>) ?? {};
}
function getMediaState(ctx: EvaluationContext): Record<string, unknown> {
  return (ctx.currentState?.media_state as Record<string, unknown>) ?? {};
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

// Location-choice conditions: read from claimed_locations in team state, falling back to legacy top-level keys
function getTriageZoneProperties(ctx: EvaluationContext): Record<string, unknown> | null {
  const triageState = ctx.currentState?.triage_state as Record<string, unknown> | undefined;
  const claimed = triageState?.claimed_locations as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (claimed) {
    const first = Object.values(claimed)[0];
    if (first) return first;
  }
  return (ctx.currentState?.triage_zone_properties as Record<string, unknown>) ?? null;
}
function getEvacHoldingProperties(ctx: EvaluationContext): Record<string, unknown> | null {
  const evacState = ctx.currentState?.evacuation_state as Record<string, unknown> | undefined;
  const claimed = evacState?.claimed_locations as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (claimed) {
    const first = Object.values(claimed)[0];
    if (first) return first;
  }
  return (ctx.currentState?.evac_holding_properties as Record<string, unknown>) ?? null;
}
conditionRegistry.triage_zone_unsuitable = (ctx) => {
  const p = getTriageZoneProperties(ctx);
  if (!p) return false;
  return p.suitability === 'low' || p.unsuitable === true;
};
conditionRegistry.triage_zone_no_water = (ctx) => {
  const p = getTriageZoneProperties(ctx);
  if (!p) return false;
  return p.water === false;
};
conditionRegistry.triage_zone_no_power = (ctx) => {
  const p = getTriageZoneProperties(ctx);
  if (!p) return false;
  return p.power === false;
};
conditionRegistry.triage_zone_small_capacity = (ctx) => {
  const p = getTriageZoneProperties(ctx);
  if (!p) return false;
  const lying = (p.capacity_lying as number) ?? 0;
  const standing = (p.capacity_standing as number) ?? 0;
  const total = lying + standing;
  return total < 50;
};
conditionRegistry.triage_zone_close_to_blast = (ctx) => {
  const p = getTriageZoneProperties(ctx);
  if (!p) return false;
  const dist = p.distance_from_blast_m as number | undefined;
  return dist != null && dist < 50;
};
conditionRegistry.evac_holding_small_capacity = (ctx) => {
  const p = getEvacHoldingProperties(ctx);
  if (!p) return false;
  const capacity = (p.capacity as number) ?? 0;
  const evacueeCount =
    (ctx.currentState?.layout_ground_truth as { evacuee_count?: number })?.evacuee_count ?? 150;
  return capacity < evacueeCount;
};
conditionRegistry.evac_holding_no_water = (ctx) => {
  const p = getEvacHoldingProperties(ctx);
  if (!p) return false;
  return p.water === false;
};
conditionRegistry.evac_holding_no_cover = (ctx) => {
  const p = getEvacHoldingProperties(ctx);
  if (!p) return false;
  return p.has_cover === false;
};

// Evacuation (from current_state.evacuation_state)
conditionRegistry.evacuation_no_flow_control_decision = (ctx) =>
  !hasDecisionMatching(ctx, (d) => {
    if (d.categories?.includes('flow_control')) return true;
    const t = (d.decision_type ?? '').toLowerCase();
    const title = (d.title ?? '').toLowerCase();
    const desc = (d.description ?? '').toLowerCase();
    const text = `${t} ${title} ${desc}`;
    return (
      /flow|bottleneck|stagger|exit capacity|congestion|egress|exit width|flow rate|people per minute|capacity per exit/.test(
        text,
      ) ||
      (d.tags ?? []).some((tag) =>
        /flow|bottleneck|congestion|egress|exit capacity|width|flow rate/.test(String(tag)),
      )
    );
  });
conditionRegistry.evacuation_flow_control_decided = (ctx) =>
  getEvacuationState(ctx).flow_control_decided === true;
conditionRegistry.evacuation_exit_bottleneck_active = (ctx) => {
  const arr = getEvacuationState(ctx).exits_congested;
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const state =
    (ctx.currentState as { managed_effects?: Record<string, { managed?: boolean }> }) || {};
  const managed = state.managed_effects ?? {};
  return arr.some((e) => {
    if (typeof e !== 'string' || !e.trim()) return false;
    const key = `evacuation.exits_congested:${e.trim()}`;
    return managed[key]?.managed !== true;
  });
};
conditionRegistry.evacuation_coordination_not_established = (ctx) =>
  getEvacuationState(ctx).coordination_with_triage !== true;
conditionRegistry.evacuation_coordination_established = (ctx) =>
  getEvacuationState(ctx).coordination_with_triage === true;

// Triage (from current_state.triage_state)
conditionRegistry.triage_supply_critical = (ctx) => {
  if (getTriageState(ctx).supply_level !== 'critical') return false;
  const state =
    (ctx.currentState as { managed_effects?: Record<string, { managed?: boolean }> }) || {};
  const managed = state.managed_effects ?? {};
  return managed['triage.supply_level:critical']?.managed !== true;
};
conditionRegistry.triage_supply_low = (ctx) => {
  const level = getTriageState(ctx).supply_level;
  if (level !== 'low' && level !== 'critical') return false;
  const state =
    (ctx.currentState as { managed_effects?: Record<string, { managed?: boolean }> }) || {};
  const managed = state.managed_effects ?? {};
  const key = `triage.supply_level:${String(level)}`;
  return managed[key]?.managed !== true;
};
conditionRegistry.triage_surge_active = (ctx) => {
  if (getTriageState(ctx).surge_active !== true) return false;
  const state =
    (ctx.currentState as { managed_effects?: Record<string, { managed?: boolean }> }) || {};
  const managed = state.managed_effects ?? {};
  return managed['triage.surge_active']?.managed !== true;
};
conditionRegistry.triage_no_supply_management_decision = (ctx) =>
  !hasDecisionMatching(ctx, (d) => {
    if (d.categories?.includes('supply_management')) return true;
    const t = (d.decision_type ?? '').toLowerCase();
    const title = (d.title ?? '').toLowerCase();
    const desc = (d.description ?? '').toLowerCase();
    const text = `${t} ${title} ${desc}`;
    return (
      /supply|supplies|request|ration|equipment|shortage|tourniquet|stretcher|triage tag|triage tags|airway kit|oxygen|iv fluid|trauma kit|gauze|bandage|first aid kit|medical kit/.test(
        text,
      ) ||
      (d.tags ?? []).some((tag) =>
        /supply|ration|shortage|equipment|tourniquet|stretcher|kit/.test(String(tag)),
      )
    );
  });
conditionRegistry.triage_no_prioritisation_decision = (ctx) =>
  !hasDecisionMatching(ctx, (d) => {
    if (d.categories?.includes('prioritisation')) return true;
    const title = (d.title ?? '').toLowerCase();
    const desc = (d.description ?? '').toLowerCase();
    const text = `${title} ${desc}`;
    return (
      /prioritise|prioritize|priority|critical first|severity|triage protocol|red|yellow|green/.test(
        text,
      ) || (d.tags ?? []).some((tag) => /priorit|severity|triage/.test(String(tag)))
    );
  });
conditionRegistry.triage_prioritisation_decided = (ctx) =>
  getTriageState(ctx).prioritisation_decided === true;
conditionRegistry.triage_supply_request_made = (ctx) =>
  getTriageState(ctx).supply_request_made === true;
conditionRegistry.triage_deaths_on_site_positive = (ctx) =>
  ((getTriageState(ctx).deaths_on_site as number | undefined) ?? 0) > 0;

// Media (from current_state.media_state)
conditionRegistry.media_no_statement_by_T12 = (ctx) =>
  ctx.elapsedMinutes >= 12 && getMediaState(ctx).first_statement_issued !== true;
conditionRegistry.media_statement_issued = (ctx) =>
  getMediaState(ctx).first_statement_issued === true;
conditionRegistry.media_misinformation_not_addressed = (ctx) =>
  getMediaState(ctx).misinformation_addressed !== true;
conditionRegistry.media_journalist_arrived = (ctx) => {
  if (getMediaState(ctx).journalist_arrived !== true) return false;
  const state =
    (ctx.currentState as { managed_effects?: Record<string, { managed?: boolean }> }) || {};
  const managed = state.managed_effects ?? {};
  return managed['media.journalist_arrived']?.managed !== true;
};
conditionRegistry.media_misinformation_addressed = (ctx) =>
  getMediaState(ctx).misinformation_addressed === true;
conditionRegistry.media_spokesperson_designated = (ctx) =>
  getMediaState(ctx).spokesperson_designated === true;
conditionRegistry.media_no_spokesperson_designated = (ctx) =>
  getMediaState(ctx).spokesperson_designated !== true;
conditionRegistry.media_regular_updates_planned = (ctx) =>
  getMediaState(ctx).regular_updates_planned === true;
conditionRegistry.media_no_regular_updates_decision = (ctx) =>
  getMediaState(ctx).regular_updates_planned !== true;

// ---------------------------------------------------------------------------
// Internal: resolve one condition key (prefix rules + state_path + registry)
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

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
  const prefixGateMet = 'gate_met:';
  if (key.startsWith(prefixGateMet) && context.gateStatusByGateId) {
    const gateId = key.slice(prefixGateMet.length);
    return context.gateStatusByGateId[gateId] === 'met';
  }

  const prefixLocationClaimed = 'location_claimed:';
  if (key.startsWith(prefixLocationClaimed)) {
    const targetLabel = key.slice(prefixLocationClaimed.length).toLowerCase().replace(/_/g, ' ');
    const locationState = context.currentState?.location_state as
      | Record<string, { claimed_by?: string; label?: string }>
      | undefined;
    if (!locationState) return false;
    return Object.values(locationState).some((entry) => {
      if (!entry?.claimed_by) return false;
      const entryLabel = (entry.label ?? '').toLowerCase().replace(/_/g, ' ');
      return (
        entryLabel === targetLabel ||
        entryLabel.includes(targetLabel) ||
        targetLabel.includes(entryLabel)
      );
    });
  }

  if (context.scenarioConditionKeyDefs?.length) {
    const def = context.scenarioConditionKeyDefs.find((d) => d.key === key);
    if (def?.state_path) {
      const value = getNestedValue(context.currentState, def.state_path);
      const resolved = value === true || value === 'true';
      return def.negate ? !resolved : resolved;
    }
  }

  if (context.precomputedDecisionKeys != null && key in context.precomputedDecisionKeys) {
    return context.precomputedDecisionKeys[key] === true;
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
