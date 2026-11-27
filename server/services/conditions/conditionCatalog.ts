/**
 * Catalogue of every condition key the evaluator understands.
 * The editor, the generator and the evaluator share this allow-list.
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
    reason: 'True when the crisis-standards consistency score is below 40',
    use: 'player_message_inconsistent_across_channels',
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

/** Phrases the trainer panel already shows. The API returns these so the panel can prefer the server label. */
const DISPLAY_LABELS: Record<string, string> = {
  player_acknowledged_victims_and_ongoing_investigation: 'Acknowledged affected parties',
  player_message_includes_no_collective_blame: 'No collective blame',
  player_included_support_resources: 'Included actionable guidance',
  player_avoided_group_targeting_language: 'Avoided harmful amplification',
  player_included_public_safety_guidance: 'Included safety/protective info',
  player_provided_shareable_assets: 'Cited verified sources',
  leader_message_calls_for_unity: 'Stakeholder promotes dialogue',
  leader_message_includes_links_to_sources: 'Stakeholder includes source links',
  leader_has_preexisting_credibility: 'Key stakeholder has credibility',
  player_addressed_fake_news_spiral: 'Addressed false claims',
  player_used_leader_amplification: 'Leader amplification used',
  player_executed_multi_platform_blitz: 'Multi-platform posting (X + Facebook)',
  player_used_strategic_silence: 'Strategic silence (ignoring trolls)',
  player_pinned_verified_update: 'Official statement posted',
  player_is_actively_moderating_hate_speech: 'Actively moderating harmful content',
  player_message_is_consistent_across_channels: 'Consistent messaging across platforms',
  player_message_inconsistent_across_channels: 'Inconsistent messaging across platforms',
  community_leader_contacted: 'Key stakeholder contacted',
  impression_dominance_player: 'Player impressions dominate hostile',
  sentiment_above_60: 'Sentiment above 60',
  sentiment_below_30: 'Sentiment below 30',
  hate_post_unaddressed_count_gt_3: 'Harmful posts unaddressed (>3)',
  misinformation_unaddressed_10min: 'Misinfo unaddressed 10+ min',
  team_published_counter_narrative: 'Counter-narrative published',
  team_flagged_misinformation: 'Misinformation flagged',
  player_post_count_gt_3: 'Player has 3+ posts',
  player_post_count_gt_5: 'Player has 5+ posts',
  official_response_exists: 'Official response exists',
  facts_confirmed: 'Facts confirmed / fact-checked',
  player_posted_creative_format: 'Creative format posted',
  player_posted_official_statement: 'Official statement posted',
  player_posted_infographic: 'Infographic posted',
  player_posted_video_concept: 'Video concept posted',
  player_posted_personal_story: 'Personal story posted',
};

function fixedConditionDef(id: string): ConditionDef {
  const deprecated = DEPRECATED[id];
  const label = DISPLAY_LABELS[id] ?? labelFor(id);
  return {
    id,
    kind: 'fixed',
    label,
    description: deprecated?.reason ?? `${label}.`,
    platform: platformFor(id),
    polarity: polarityFor(id),
    ...(deprecated ? { deprecated } : {}),
  };
}

/**
 * Action types a coverage key may name. Kept in step with
 * ALLOWED_DETECTION_ACTION_TYPES; the catalogue test asserts they match.
 */
export const CATALOG_ACTION_TYPES = [
  'post_created',
  'reply_posted',
  'post_liked',
  'post_reposted',
  'post_flagged',
  'post_reported',
  'dm_sent',
  'dm_read',
  'email_sent',
  'email_read',
  'call_answered',
  'call_declined',
  'news_read',
  'fact_checked',
  'draft_created',
  'draft_submitted_for_approval',
  'draft_approved',
  'draft_published',
  'escalated',
  'chat_message_sent',
  'content_graded',
  'misinfo_flagged',
  'group_post_created',
  'group_joined',
  'event_created',
  'event_responded',
  'event_discussed',
  'dispute_filed',
  'dispute_upheld',
  'dispute_rejected',
  'intel_shared',
  'decision_recorded',
  'call_missed',
  'call_ended',
  'call_returned',
] as const;

const CONTACT_CHANNELS = ['email', 'teamchat', 'messenger', 'phone'] as const;
const VERDICTS = ['keep', 'modify', 'delay', 'cancel'] as const;

const injectParam: ConditionParam = { name: 'inject', type: 'inject_key' };
const minutesParam: ConditionParam = { name: 'N', type: 'minutes', min: 1, max: 240 };
const secondsParam: ConditionParam = { name: 'S', type: 'seconds', min: 5, max: 600 };
const countParam: ConditionParam = { name: 'n', type: 'int', min: 1, max: 10000 };
const countNParam: ConditionParam = { name: 'N', type: 'int', min: 1, max: 10000 };
const stakeholderParam: ConditionParam = { name: 'stakeholder', type: 'stakeholder' };
const actionParam: ConditionParam = {
  name: 'action_type',
  type: 'enum',
  enum: [...CATALOG_ACTION_TYPES],
};
const channelParam: ConditionParam = {
  name: 'channel',
  type: 'enum',
  enum: [...CONTACT_CHANNELS],
};
const verdictParam: ConditionParam = { name: 'verdict', type: 'enum', enum: [...VERDICTS] };

/** Prefix ids that accept `|team=`. Other keys reject a team scope at parse time. */
const TEAM_SCOPED_IDS = new Set<string>();

function comms(
  id: string,
  params: ConditionParam[],
  platform: ConditionDef['platform'],
  polarity: ConditionDef['polarity'],
  label: string,
  description: string,
  teamScope = false,
): ConditionDef {
  if (teamScope) TEAM_SCOPED_IDS.add(id);
  const scopeNote = teamScope ? ' Add |team=<slug> to limit this to one team.' : '';
  return {
    id,
    kind: 'prefix',
    prefix: `${id}:`,
    params,
    label,
    description: `${description}${scopeNote}`,
    platform,
    polarity,
  };
}

const COMMS_CONDITIONS: ConditionDef[] = [
  comms(
    'delivered',
    [injectParam],
    'cross',
    'positive',
    '{inject} was delivered',
    'At least one in-scope delivery exists.',
    true,
  ),
  comms(
    'opened',
    [injectParam],
    'cross',
    'positive',
    'Someone opened {inject}',
    'Any in-scope delivery has been opened.',
    true,
  ),
  comms(
    'unopened',
    [injectParam, minutesParam],
    'cross',
    'negative',
    'Nobody opened {inject} within {N} min',
    'Every in-scope delivery is still unopened after {N} minutes.',
    true,
  ),
  comms(
    'responded',
    [injectParam],
    'cross',
    'positive',
    'Someone replied to {inject}',
    'Any in-scope delivery has a response. A reply to a chain follow-up counts.',
    true,
  ),
  comms(
    'unresponded',
    [injectParam, minutesParam],
    'cross',
    'negative',
    'Nobody replied to {inject} within {N} min',
    'Every in-scope delivery went {N} minutes with no reply. A later reply does not clear it.',
    true,
  ),
  comms(
    'responded_within',
    [injectParam, minutesParam],
    'cross',
    'positive',
    'Someone replied to {inject} within {N} min',
    'The first in-scope reply arrived within {N} minutes of delivery.',
    true,
  ),
  comms(
    'response_count_gte',
    [injectParam, countParam],
    'cross',
    'positive',
    'At least {n} replies to {inject}',
    'The number of in-scope replies is at least {n}.',
    true,
  ),
  comms(
    'responded_by_bot_only',
    [injectParam],
    'cross',
    'negative',
    'Only an AI teammate replied to {inject}',
    'Every in-scope reply is from an AI teammate.',
    true,
  ),
  comms(
    'email_opened',
    [injectParam],
    'email',
    'positive',
    'Someone opened the email {inject}',
    'An email delivery of this inject was opened.',
    true,
  ),
  comms(
    'email_unopened',
    [injectParam, minutesParam],
    'email',
    'negative',
    'Nobody opened the email {inject} within {N} min',
    'Every email delivery is still unopened after {N} minutes.',
    true,
  ),
  comms(
    'email_replied',
    [injectParam],
    'email',
    'positive',
    'Someone replied to the email {inject}',
    'An email delivery has an email reply. A forward does not count.',
    true,
  ),
  comms(
    'email_unreplied',
    [injectParam, minutesParam],
    'email',
    'negative',
    'Nobody replied to {inject} by email within {N} min',
    'Every email delivery went {N} minutes with no email reply.',
    true,
  ),
  comms(
    'email_forwarded',
    [injectParam],
    'email',
    'positive',
    'Someone forwarded the email {inject}',
    'A player forwarded this email. With a team scope, the forward was sent to that team.',
    true,
  ),
  comms(
    'email_sent_to_stakeholder',
    [stakeholderParam],
    'email',
    'positive',
    'Someone emailed {stakeholder}',
    'An email_sent action addressed this stakeholder.',
  ),
  comms(
    'email_not_sent_to_stakeholder',
    [stakeholderParam, minutesParam],
    'email',
    'negative',
    'Nobody emailed {stakeholder} by minute {N}',
    'No email to this stakeholder by session minute {N}.',
  ),
  comms(
    'chat_replied',
    [injectParam],
    'chat',
    'positive',
    'Someone replied in chat to {inject}',
    'A chat delivery, including an interim phone-call chat line, has a reply.',
    true,
  ),
  comms(
    'chat_unanswered',
    [injectParam, minutesParam],
    'chat',
    'negative',
    'Nobody replied in chat to {inject} within {N} min',
    'Every chat delivery went {N} minutes with no reply.',
    true,
  ),
  comms(
    'dm_replied',
    [injectParam],
    'dm',
    'positive',
    'Someone replied to the direct message {inject}',
    'An NPC or Messenger direct-message delivery has a reply.',
    true,
  ),
  comms(
    'dm_unanswered',
    [injectParam, minutesParam],
    'dm',
    'negative',
    'Nobody replied to the direct message {inject} within {N} min',
    'Every direct-message delivery went {N} minutes with no reply.',
    true,
  ),
  comms(
    'call_answered',
    [injectParam],
    'call',
    'positive',
    'Someone answered the call {inject}',
    'Any attempt in a call group was answered. False until phone calls exist.',
    true,
  ),
  comms(
    'call_missed',
    [injectParam],
    'call',
    'negative',
    'The call {inject} was missed',
    'Every call group finished unanswered and the latest attempt was missed.',
    true,
  ),
  comms(
    'call_declined',
    [injectParam],
    'call',
    'negative',
    'Someone declined the call {inject}',
    'An attempt was declined and none was answered.',
    true,
  ),
  comms(
    'call_missed_count',
    [injectParam, countNParam],
    'call',
    'negative',
    '{inject} was missed or declined at least {N} times',
    'Missed and declined attempts, including chain follow-up calls, are at least {N}.',
    true,
  ),
  comms(
    'call_attempts_gte',
    [injectParam, countParam],
    'call',
    'neutral',
    '{inject} rang at least {n} times',
    'The number of ring attempts is at least {n}.',
    true,
  ),
  comms(
    'call_answered_by_attempt',
    [injectParam, countParam],
    'call',
    'positive',
    '{inject} was answered by attempt {n}',
    'The call was answered on attempt {n} or earlier.',
    true,
  ),
  comms(
    'call_unreturned',
    [injectParam, minutesParam],
    'call',
    'negative',
    'Nobody called back {inject} within {N} min',
    'The call was missed or declined and nobody called back within {N} minutes of the first attempt.',
    true,
  ),
  comms(
    'call_answered_within',
    [injectParam, secondsParam],
    'call',
    'positive',
    '{inject} was answered within {S} seconds',
    'The call was answered and the answer took at most {S} seconds.',
    true,
  ),
  comms(
    'stakeholder_missed_calls',
    [stakeholderParam, countNParam],
    'call',
    'negative',
    '{stakeholder} has at least {N} missed or declined calls',
    'Missed or declined attempts from this stakeholder, across every inject, are at least {N}.',
  ),
  comms(
    'contacted',
    [stakeholderParam],
    'stakeholder',
    'positive',
    'Someone contacted {stakeholder}',
    'A player has written to this stakeholder on any channel.',
  ),
  comms(
    'contacted_via',
    [stakeholderParam, channelParam],
    'stakeholder',
    'positive',
    'Someone contacted {stakeholder} by {channel}',
    'A player reached this stakeholder on the named channel.',
  ),
  comms(
    'not_contacted',
    [stakeholderParam, minutesParam],
    'stakeholder',
    'negative',
    'Nobody contacted {stakeholder} by minute {N}',
    'No player contact with this stakeholder by session minute {N}.',
  ),
  comms(
    'stakeholder_verdict',
    [stakeholderParam, verdictParam],
    'stakeholder',
    'neutral',
    "{stakeholder}'s latest verdict is {verdict}",
    'The latest reconsideration verdict for this stakeholder is the named value.',
  ),
  comms(
    'news_opened',
    [injectParam],
    'news',
    'positive',
    'Someone opened the news article {inject}',
    'A news delivery of this inject was opened.',
    true,
  ),
  comms(
    'action_count_gte',
    [actionParam, countParam],
    'cross',
    'positive',
    'At least {n} {action} actions',
    'Player actions of this type are at least {n}.',
    true,
  ),
  comms(
    'action_absent',
    [actionParam, minutesParam],
    'cross',
    'negative',
    'No {action} action by minute {N}',
    'No player action of this type by session minute {N}.',
    true,
  ),
];

export const CONDITION_CATALOG: ConditionDef[] = [
  ...FIXED_CONDITION_KEYS.map(fixedConditionDef),
  ...PREFIX_CONDITIONS,
  ...COMMS_CONDITIONS,
];

const fixedById = new Map(
  CONDITION_CATALOG.filter((def) => def.kind === 'fixed').map((def) => [def.id, def]),
);
const prefixes = CONDITION_CATALOG.filter(
  (def): def is ConditionDef & { prefix: string } => def.kind === 'prefix' && !!def.prefix,
).sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * Scope names the grammar accepts. WP12 adds `role` to this list; the parser
 * already reads any `|name=value` and does not need to change.
 */
export const KNOWN_CONDITION_SCOPES = ['team'] as const;

export interface ConditionScope {
  team?: string;
  [name: string]: string | undefined;
}

export type ParsedCondition =
  { def: ConditionDef; args: string[]; scope?: ConditionScope } | { error: string };

export type ParsedConditionKey = ParsedCondition;

/** Lowercase slug: non-alphanumerics become "_", and leading or trailing "_" is trimmed. */
export function slugifyTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const LEGACY_PREFIX_IDS = new Set([
  'prior_pathway_outcome_fired',
  'inject_fired',
  'objective_not_completed',
  'gate_not_met',
  'gate_met',
  'intel_shared',
  'intel_missing',
  'location_claimed',
  'inject_published',
  'inject_cancelled',
]);

const INJECT_KEY_RE = /^[a-z0-9_]{1,60}$/;
const STAKEHOLDER_RE = /^[a-z0-9_]{1,80}$/;

function parseScope(raw: string): { scope: ConditionScope } | { error: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0) return { error: 'A condition scope must be written as name=value' };
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return { error: `Invalid condition scope name "${name}"` };
  }
  if (!(KNOWN_CONDITION_SCOPES as readonly string[]).includes(name)) {
    return {
      error: `Unknown condition scope "${name}". Supported scopes: ${KNOWN_CONDITION_SCOPES.join(', ')}`,
    };
  }
  if (!value) return { error: `Condition scope ${name}= is missing its value` };
  const scope: ConditionScope = {};
  if (name === 'team') {
    const slug = slugifyTeamName(value);
    if (!slug) return { error: 'Condition scope team= is missing its value' };
    scope.team = slug;
  } else {
    scope[name] = value;
  }
  return { scope };
}

function validateTypedArg(param: ConditionParam, raw: string): string | null {
  if (param.type === 'inject_key') {
    return INJECT_KEY_RE.test(raw) ? null : `Inject key "${raw}" must match ^[a-z0-9_]{1,60}$`;
  }
  if (param.type === 'stakeholder') {
    return STAKEHOLDER_RE.test(raw) ? null : `Stakeholder id "${raw}" must be a lowercase slug`;
  }
  if (param.type === 'minutes' || param.type === 'seconds' || param.type === 'int') {
    if (!/^\d+$/.test(raw)) return `${param.name} must be a whole number`;
    const n = Number(raw);
    const min = param.min ?? 0;
    const max = param.max ?? Number.MAX_SAFE_INTEGER;
    if (n < min || n > max) return `${param.name} must be from ${min} to ${max}`;
    return null;
  }
  if (param.type === 'enum') {
    const allowed = param.enum ?? [];
    return allowed.includes(raw) ? null : `${param.name} must be one of: ${allowed.join(', ')}`;
  }
  return raw.trim() === '' ? 'Argument is empty' : null;
}

function splitTypedArgs(
  rest: string,
  params: readonly ConditionParam[],
): { args: string[] } | { error: string } {
  const args = rest.split(':');
  if (args.length !== params.length) {
    return { error: `Expected ${params.length} argument(s)` };
  }
  for (let i = 0; i < params.length; i++) {
    const problem = validateTypedArg(params[i], args[i] ?? '');
    if (problem) return { error: problem };
  }
  return { args };
}

export function parseConditionKey(key: string): ParsedConditionKey {
  const trimmed = key.trim();
  if (!trimmed) return { error: 'Condition key is empty' };

  const pipe = trimmed.indexOf('|');
  let body = trimmed;
  let scope: ConditionScope | undefined;
  if (pipe >= 0) {
    if (trimmed.indexOf('|', pipe + 1) >= 0) {
      return { error: 'A condition key takes at most one scope' };
    }
    body = trimmed.slice(0, pipe);
    if (!body) return { error: 'Condition key is empty' };
    const parsedScope = parseScope(trimmed.slice(pipe + 1));
    if ('error' in parsedScope) return parsedScope;
    scope = parsedScope.scope;
  }

  const fixed = fixedById.get(body);
  if (fixed) {
    if (scope)
      return { error: `Condition key ${fixed.id} does not accept a ${scopeName(scope)} scope` };
    return { def: fixed, args: [] };
  }

  const match = prefixes.find((def) => body.startsWith(def.prefix));
  if (!match) return { error: `Unknown condition key: ${body}` };
  const rest = body.slice(match.prefix.length);
  if (rest.trim() === '') return { error: `Condition key ${body} is missing its argument` };

  if (scope?.team && !TEAM_SCOPED_IDS.has(match.id)) {
    return { error: `Condition key ${match.id} does not accept a team scope` };
  }

  if (LEGACY_PREFIX_IDS.has(match.id)) {
    return { def: match, args: [rest], ...(scope ? { scope } : {}) };
  }

  const split = splitTypedArgs(rest, match.params ?? []);
  if ('error' in split) return { error: split.error };
  return { def: match, args: split.args, ...(scope ? { scope } : {}) };
}

function scopeName(scope: ConditionScope): string {
  return scope.team ? 'team' : (Object.keys(scope)[0] ?? 'unknown');
}

/** Fill a catalogue label from the parsed arguments. A team scope is appended. */
export function formatConditionLabel(parsed: {
  def: ConditionDef;
  args: string[];
  scope?: ConditionScope;
}): string {
  let label = parsed.def.label;
  const params = parsed.def.params ?? [];
  params.forEach((param, index) => {
    const value = parsed.args[index] ?? '';
    for (const token of placeholderTokens(param)) {
      label = label.split(`{${token}}`).join(value);
    }
  });
  if (parsed.scope?.team) label += ` (team ${parsed.scope.team})`;
  return label;
}

function placeholderTokens(param: ConditionParam): string[] {
  if (param.type === 'inject_key') return ['inject'];
  if (param.type === 'minutes') return ['N'];
  if (param.type === 'seconds') return ['S'];
  if (param.type === 'int') return param.name === 'N' ? ['N'] : ['n'];
  if (param.type === 'stakeholder') return ['stakeholder'];
  if (param.name === 'channel') return ['channel'];
  if (param.name === 'verdict') return ['verdict'];
  if (param.name === 'action_type') return ['action'];
  return [param.name];
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
