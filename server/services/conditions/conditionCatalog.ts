/**
 * Catalogue of condition keys the evaluator already understands.
 * WP3 fills in the rest of the platforms; this skeleton is the allow-list
 * the editor, the generator and the evaluator share.
 */

export interface ConditionParam {
  name: string;
  type:
    | 'inject_key'
    | 'minutes'
    | 'seconds'
    | 'team'
    | 'stakeholder'
    | 'tone'
    | 'int'
    | 'enum'
    | 'string';
  enum?: string[];
  min?: number;
  max?: number;
}

export interface ConditionDef {
  id: string;
  kind: 'fixed' | 'prefix';
  prefix?: string;
  params?: ConditionParam[];
  label: string;
  description: string;
  platform:
    | 'social'
    | 'email'
    | 'chat'
    | 'dm'
    | 'call'
    | 'news'
    | 'docs'
    | 'groups'
    | 'stakeholder'
    | 'cross'
    | 'warroom'
    | 'session';
  polarity: 'positive' | 'negative' | 'neutral';
  deprecated?: { reason: string; use?: string };
}

const FIXED_CONDITION_KEYS = [
  'no_media_management_decision',
  'no_perimeter_establishment_decision',
  'no_patient_privacy_or_access_control_decision',
  'no_triage_perimeter_security_decision',
  'official_public_statement_issued',
  'triage_zone_established_as_incident_location',
  'prior_social_media_rumour_inject_fired',
  'civilian_panic_or_rumour_inject_fired',
  'public_comms_channel_inactive',
  'pathway_fired_exit_b_congestion',
  'crowd_density_above_0.6',
  'crowd_density_in_triage_zone_elevated',
  'objective_evacuation_not_completed',
  'placed_asset_exists',
  'evacuation_gate_not_met',
  'triage_zone_unsuitable',
  'triage_zone_no_water',
  'triage_zone_no_power',
  'triage_zone_small_capacity',
  'triage_zone_close_to_blast',
  'evac_holding_small_capacity',
  'evac_holding_no_water',
  'evac_holding_no_cover',
  'evacuation_no_flow_control_decision',
  'evacuation_flow_control_decided',
  'evacuation_exit_bottleneck_active',
  'evacuation_coordination_not_established',
  'evacuation_coordination_established',
  'triage_supply_critical',
  'triage_supply_low',
  'triage_surge_active',
  'triage_no_supply_management_decision',
  'triage_no_prioritisation_decision',
  'triage_prioritisation_decided',
  'triage_supply_request_made',
  'triage_deaths_on_site_positive',
  'media_no_statement_by_T12',
  'media_statement_issued',
  'media_misinformation_not_addressed',
  'media_journalist_arrived',
  'media_misinformation_addressed',
  'media_spokesperson_designated',
  'media_no_spokesperson_designated',
  'media_regular_updates_planned',
  'media_no_regular_updates_decision',
  'media_press_conference_held',
  'media_press_conference_or_statement',
  'media_camera_placement_decided',
  'media_no_camera_placement',
  'media_holding_area_established',
  'media_no_holding_area',
  'casualties_at_assembly_above_20',
  'casualties_at_assembly_above_50',
  'patients_in_treatment_above_5',
  'patients_in_treatment_above_10',
  'active_fires_above_0',
  'convergent_crowd_present',
  'no_zone_identification_decision',
  'perimeter_not_established',
  'exits_congested',
  'deaths_on_site_above_0',
  'still_inside_above_50',
  'awaiting_triage_above_10',
  'transported_above_0',
  'crowd_compliance_below_30',
  'crowd_compliance_below_50',
  'crowd_compliance_above_70',
  'hate_post_unaddressed_count_gt_3',
  'misinformation_unaddressed_10min',
  'sentiment_below_30',
  'sentiment_above_60',
  'team_published_counter_narrative',
  'team_flagged_misinformation',
  'community_leader_contacted',
  'player_post_count_gt_3',
  'player_post_count_gt_5',
  'rally_call_active',
  'sop_step_monitor_completed',
  'sop_step_assess_completed',
  'sop_step_fact_check_completed',
  'sop_step_escalate_completed',
  'sop_step_draft_completed',
  'sop_step_publish_completed',
  'sop_step_monitor_overdue',
  'sop_step_assess_overdue',
  'sop_step_draft_overdue',
  'sop_step_publish_overdue',
  'player_posted_creative_format',
  'player_posted_official_statement',
  'player_posted_infographic',
  'player_posted_video_concept',
  'player_posted_personal_story',
  'official_response_exists',
  'facts_confirmed',
  'impression_dominance_player',
  'player_acknowledged_victims_and_ongoing_investigation',
  'player_message_includes_no_collective_blame',
  'player_included_support_resources',
  'player_avoided_group_targeting_language',
  'player_included_public_safety_guidance',
  'player_provided_shareable_assets',
  'leader_message_calls_for_unity',
  'leader_message_includes_links_to_sources',
  'leader_has_preexisting_credibility',
  'player_addressed_fake_news_spiral',
  'player_used_leader_amplification',
  'player_executed_multi_platform_blitz',
  'player_used_strategic_silence',
  'player_pinned_verified_update',
  'player_is_actively_moderating_hate_speech',
  'player_message_is_consistent_across_channels',
  'player_message_inconsistent_across_channels',
] as const;

const DEPRECATED: Record<string, { reason: string; use: string }> = {
  player_posted_infographic: {
    reason: 'Alias of player_posted_creative_format',
    use: 'player_posted_creative_format',
  },
  player_posted_video_concept: {
    reason: 'Alias of player_posted_creative_format',
    use: 'player_posted_creative_format',
  },
  player_posted_personal_story: {
    reason: 'Alias of player_posted_creative_format',
    use: 'player_posted_creative_format',
  },
  leader_has_preexisting_credibility: {
    reason: 'Alias of community_leader_contacted',
    use: 'community_leader_contacted',
  },
  player_message_inconsistent_across_channels: {
    reason: 'Always false; replaced in WP3',
    use: 'player_message_is_consistent_across_channels',
  },
  player_pinned_verified_update: {
    reason: 'Alias of the official statement',
    use: 'player_posted_official_statement',
  },
};

const PREFIX_CONDITIONS: ConditionDef[] = [
  prefix(
    'prior_pathway_outcome_fired',
    'consequence_key',
    'string',
    'warroom',
    'neutral',
    'A pathway outcome with this key has already fired',
  ),
  prefix(
    'inject_fired',
    'inject_id',
    'string',
    'cross',
    'neutral',
    'The inject with this id has been published',
  ),
  prefix(
    'objective_not_completed',
    'objective_id',
    'string',
    'session',
    'negative',
    'The objective is missing or not completed',
  ),
  prefix('gate_not_met', 'gate_id', 'string', 'warroom', 'negative', 'The gate status is not_met'),
  prefix('gate_met', 'gate_id', 'string', 'warroom', 'positive', 'The gate status is met'),
  prefix(
    'intel_shared',
    'intel_key',
    'string',
    'cross',
    'positive',
    'The intel key has been shared inside the session',
  ),
  prefix(
    'intel_missing',
    'intel_key',
    'string',
    'cross',
    'negative',
    'The intel key has not been shared',
  ),
  prefix(
    'location_claimed',
    'label',
    'string',
    'warroom',
    'neutral',
    'A location whose label matches has been claimed',
  ),
  prefix(
    'inject_published',
    'inject_key',
    'inject_key',
    'cross',
    'positive',
    'An inject carrying this inject_key has been published',
  ),
  prefix(
    'inject_cancelled',
    'inject_key',
    'inject_key',
    'cross',
    'negative',
    'An inject carrying this inject_key has been cancelled',
  ),
];

function prefix(
  id: string,
  param: string,
  type: ConditionParam['type'],
  platform: ConditionDef['platform'],
  polarity: ConditionDef['polarity'],
  description: string,
): ConditionDef {
  return {
    id,
    kind: 'prefix',
    prefix: `${id}:`,
    params: [{ name: param, type }],
    label: labelFor(id),
    description,
    platform,
    polarity,
  };
}

function labelFor(id: string): string {
  const words = id.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function platformFor(id: string): ConditionDef['platform'] {
  if (
    /^(player_|sentiment_|hate_|misinformation_|rally_|community_leader|official_response|facts_confirmed|impression_|leader_|team_|sop_step_)/.test(
      id,
    )
  ) {
    return 'social';
  }
  if (/^media_/.test(id)) return 'news';
  return 'warroom';
}

function polarityFor(id: string): ConditionDef['polarity'] {
  if (
    /^(no_|.*_not_|.*_no_|.*unaddressed|.*_below_|.*_overdue|.*inconsistent|.*_critical|panic|inactive|congestion|bottleneck|unsuitable|small_capacity|surge|hate_|misinformation_)/.test(
      id,
    )
  ) {
    return 'negative';
  }
  if (
    /(issued|established|completed|addressed|decided|published|contacted|above_|exists|confirmed|positive|designated|planned|held)/.test(
      id,
    )
  ) {
    return 'positive';
  }
  return 'neutral';
}

function fixedConditionDef(id: string): ConditionDef {
  const deprecated = DEPRECATED[id];
  return {
    id,
    kind: 'fixed',
    label: labelFor(id),
    description: deprecated?.reason ?? `${labelFor(id)}.`,
    platform: platformFor(id),
    polarity: polarityFor(id),
    ...(deprecated ? { deprecated } : {}),
  };
}

export const CONDITION_CATALOG: ConditionDef[] = [
  ...FIXED_CONDITION_KEYS.map(fixedConditionDef),
  ...PREFIX_CONDITIONS,
];

const fixedById = new Map(
  CONDITION_CATALOG.filter((def) => def.kind === 'fixed').map((def) => [def.id, def]),
);
const prefixes = CONDITION_CATALOG.filter(
  (def): def is ConditionDef & { prefix: string } => def.kind === 'prefix' && !!def.prefix,
).sort((a, b) => b.prefix.length - a.prefix.length);

export type ParsedConditionKey =
  { def: ConditionDef; args: string[]; scope?: { team?: string } } | { error: string };

export function parseConditionKey(key: string): ParsedConditionKey {
  const trimmed = key.trim();
  if (!trimmed) return { error: 'Condition key is empty' };
  const fixed = fixedById.get(trimmed);
  if (fixed) return { def: fixed, args: [] };
  const match = prefixes.find((def) => trimmed.startsWith(def.prefix));
  if (!match) return { error: `Unknown condition key: ${trimmed}` };
  const arg = trimmed.slice(match.prefix.length);
  if (arg.trim() === '') return { error: `Condition key ${trimmed} is missing its argument` };
  return { def: match, args: [arg] };
}

export function isKnownConditionKey(key: string): boolean {
  return !('error' in parseConditionKey(key));
}

/** Catalogue keys plus scenario-defined keys (state_path defs) supplied by the caller. */
export function unknownConditionKeys(
  keys: readonly string[],
  extraKeys: readonly string[] = [],
): string[] {
  const extra = new Set(extraKeys);
  const unknown: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || extra.has(key) || isKnownConditionKey(key)) continue;
    unknown.push(key);
  }
  return unknown;
}

export function collectConditionKeys(appear: unknown, cancel: unknown): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) keys.push(value.trim());
  };
  if (Array.isArray(appear)) {
    for (const key of appear) push(key);
  } else if (appear && typeof appear === 'object') {
    const record = appear as { all?: unknown; conditions?: unknown };
    if (Array.isArray(record.all)) for (const key of record.all) push(key);
    if (Array.isArray(record.conditions)) for (const key of record.conditions) push(key);
  }
  if (Array.isArray(cancel)) {
    for (const key of cancel) push(key);
  }
  return keys;
}

export interface RetainedConditions {
  conditions_to_appear: unknown;
  conditions_to_cancel: string[] | null;
  dropped: string[];
  emptied: boolean;
}

/**
 * Drop unknown keys from a generated inject. `emptied` is true only when
 * conditions_to_appear had keys and every one of them was unknown.
 */
export function retainKnownConditions(
  appear: unknown,
  cancel: unknown,
  extraKeys: readonly string[] = [],
): RetainedConditions {
  const extra = new Set(extraKeys);
  const dropped: string[] = [];
  const keep = (key: unknown): key is string => {
    if (typeof key !== 'string' || !key.trim()) return false;
    if (extra.has(key) || isKnownConditionKey(key)) return true;
    dropped.push(key);
    return false;
  };

  let conditions_to_appear: unknown = appear ?? null;
  let hadAppearKeys = false;
  let keptAppear = 0;
  if (Array.isArray(appear)) {
    hadAppearKeys = appear.some((key) => typeof key === 'string' && key.trim() !== '');
    const kept = appear.filter(keep);
    keptAppear = kept.length;
    conditions_to_appear = kept;
  } else if (appear && typeof appear === 'object') {
    const record = appear as { all?: unknown; conditions?: unknown; threshold?: unknown };
    if (Array.isArray(record.all)) {
      hadAppearKeys = record.all.some((key) => typeof key === 'string' && key.trim() !== '');
      const kept = record.all.filter(keep);
      keptAppear = kept.length;
      conditions_to_appear = { ...record, all: kept };
    } else if (Array.isArray(record.conditions)) {
      hadAppearKeys = record.conditions.some((key) => typeof key === 'string' && key.trim() !== '');
      const kept = record.conditions.filter(keep);
      keptAppear = kept.length;
      conditions_to_appear = { ...record, conditions: kept };
    }
  }

  let conditions_to_cancel: string[] | null = null;
  if (Array.isArray(cancel)) {
    conditions_to_cancel = cancel.filter(keep);
  }

  return {
    conditions_to_appear,
    conditions_to_cancel,
    dropped,
    emptied: hadAppearKeys && keptAppear === 0,
  };
}
