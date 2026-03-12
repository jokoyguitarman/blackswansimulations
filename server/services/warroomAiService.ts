/**
 * War Room AI Service
 * Multi-phase generation: teams+core → time injects → decision injects → locations/seeds.
 * Each phase has its own prompt with explicit schema and fallbacks from templates.
 */

import { logger } from '../lib/logger.js';
import type { OsmVicinity } from './osmVicinityService.js';
import { standardsToPromptBlock } from './warroomResearchService.js';

export interface WarroomScenarioPayload {
  scenario: {
    title: string;
    description: string;
    briefing: string;
    objectives: string[];
    initial_state: Record<string, unknown>;
    role_specific_briefs: Record<string, string>;
    category: string;
    difficulty: string;
    duration_minutes: number;
  };
  teams: Array<{
    team_name: string;
    team_description: string;
    min_participants: number;
    max_participants: number;
  }>;
  objectives: Array<{
    objective_id: string;
    objective_name: string;
    description: string;
    weight: number;
    success_criteria?: Record<string, unknown>;
  }>;
  time_injects: Array<{
    trigger_time_minutes: number;
    type: string;
    title: string;
    content: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    requires_response?: boolean;
    requires_coordination?: boolean;
    conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  condition_driven_injects?: Array<{
    title: string;
    content: string;
    type: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    conditions_to_appear: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  decision_injects?: Array<{
    trigger_condition: string;
    type: string;
    title: string;
    content: string;
    severity: string;
    inject_scope: string;
    target_teams: string[];
    requires_response?: boolean;
    requires_coordination?: boolean;
    conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
    conditions_to_cancel?: string[];
    eligible_after_minutes?: number;
    objective_penalty?: { objective_id: string; reason: string; points: number };
    state_effect?: Record<string, unknown>;
  }>;
  locations?: Array<{
    location_type: string;
    pin_category?: string;
    description?: string;
    label: string;
    coordinates: { lat: number; lng: number };
    conditions?: Record<string, unknown>;
    display_order: number;
  }>;
  environmental_seeds?: Array<{
    variant_label: string;
    seed_data: Record<string, unknown>;
    display_order: number;
  }>;
  insider_knowledge?: {
    osm_vicinity?: OsmVicinity;
    sector_standards?: string;
    sector_standards_structured?: import('./warroomResearchService.js').StandardsFinding[];
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
  };
}

export interface WarroomResearchContext {
  area_summary?: string;
  /** @deprecated use standards_findings instead */
  standards_summary?: string;
  standards_findings?: import('./warroomResearchService.js').StandardsFinding[];
}

export interface WarroomUserTeam {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

export interface Phase1Result {
  scenario: WarroomScenarioPayload['scenario'];
  teams: WarroomScenarioPayload['teams'];
  objectives: WarroomScenarioPayload['objectives'];
}

export interface WarroomGenerateInput {
  scenario_type: string;
  setting: string;
  terrain: string;
  location: string | null;
  venue_name?: string;
  osm_vicinity?: OsmVicinity;
  geocode?: { lat: number; lng: number; display_name: string };
  complexity_tier: 'minimal' | 'standard' | 'full' | 'rich';
  typeSpec: Record<string, unknown>;
  settingSpec: Record<string, unknown>;
  terrainSpec: Record<string, unknown>;
  researchContext?: WarroomResearchContext;
  userTeams?: WarroomUserTeam[];
  /** Pre-computed Phase 1 result; if provided, warroomGenerateScenario skips Phase 1. */
  phase1Preview?: Phase1Result;
}

export type WarroomAiProgressCallback = (message: string) => void;

const VALID_INJECT_TYPES = [
  'media_report',
  'field_update',
  'citizen_call',
  'intel_brief',
  'resource_shortage',
  'weather_change',
  'political_pressure',
];

function normalizeInjectType(type: string): string {
  const t = type?.toLowerCase().replace(/\s+/g, '_') || 'field_update';
  return VALID_INJECT_TYPES.includes(t) ? t : 'field_update';
}

async function callOpenAi<T>(
  systemPrompt: string,
  userPrompt: string,
  openAiApiKey: string,
  maxTokens = 4000,
): Promise<T> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg =
      (err as { error?: { message?: string } }).error?.message ||
      `OpenAI API error: ${response.status}`;
    logger.error({ status: response.status, msg }, 'Warroom AI call failed');
    throw new Error(msg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content from OpenAI');
  }

  return JSON.parse(content) as T;
}

function getRequiredTeamsFromTemplate(
  typeSpec: Record<string, unknown>,
): WarroomScenarioPayload['teams'] {
  const teams = typeSpec.required_teams as
    | Array<{
        team_name: string;
        team_description: string;
        min_participants?: number;
        max_participants?: number;
      }>
    | undefined;
  if (!Array.isArray(teams) || teams.length === 0) return [];
  return teams.map((t) => ({
    team_name: t.team_name,
    team_description: t.team_description || '',
    min_participants: t.min_participants ?? 1,
    max_participants: t.max_participants ?? 10,
  }));
}

/**
 * Phase 1: Generate teams and core scenario (title, description, briefing, objectives).
 * When userTeams provided, only generates core scenario; uses userTeams as teams.
 */
async function generateTeamsAndCore(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<{
  scenario: WarroomScenarioPayload['scenario'];
  teams: WarroomScenarioPayload['teams'];
  objectives: WarroomScenarioPayload['objectives'];
}> {
  const hasUserTeams = input.userTeams && input.userTeams.length > 0;
  onProgress?.(
    hasUserTeams ? 'Generating core scenario...' : 'Generating teams and core scenario...',
  );

  const {
    scenario_type,
    setting,
    terrain,
    location,
    venue_name,
    typeSpec,
    settingSpec,
    terrainSpec,
    researchContext,
    userTeams,
  } = input;
  const venue = venue_name || location || setting;
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\n\nRESPONSE STANDARDS (use these to make injects and objectives realistic):\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : researchContext?.standards_summary
        ? `\nStandards: ${researchContext.standards_summary}`
        : '';
  const researchBlock =
    researchContext?.area_summary || standardsBlock
      ? `\nResearch context:\n${researchContext?.area_summary || ''}${standardsBlock}`
      : '';

  const teamsBlock = hasUserTeams
    ? ''
    : `,
  "teams": [
    { "team_name": "string", "team_description": "string", "min_participants": 2, "max_participants": 8 },
    ...
  ]`;
  const teamsRule = hasUserTeams
    ? ''
    : '\n- You MUST include at least 4 teams. Use required_teams from the scenario type template as a base; you may add or adapt.';

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario type: ${scenario_type}
Setting: ${setting}
Terrain: ${terrain}
Venue: ${venue}
${researchBlock}

Template context:
- Scenario type: ${JSON.stringify(typeSpec)}
- Setting: ${JSON.stringify(settingSpec)}
- Terrain: ${JSON.stringify(terrainSpec)}

Return ONLY valid JSON in this exact structure (no markdown, no explanation):
{
  "scenario": {
    "title": "string - concise scenario title",
    "description": "string - 2-4 sentence overview of the crisis",
    "briefing": "string - 2-3 paragraph operational briefing for participants",
    "objectives": ["string - objective 1", "string - objective 2", "..."],
    "initial_state": {},
    "role_specific_briefs": {},
    "category": "terrorism",
    "difficulty": "advanced",
    "duration_minutes": 60
  }${teamsBlock},
  "objectives": [
    { "objective_id": "id", "objective_name": "name", "description": "string", "weight": 25 },
    ...
  ]
}

RULES:${teamsRule}
- description and briefing MUST be non-empty (2+ sentences each).
- objectives array in scenario: 3-5 high-level objectives as strings.
- objectives array at root: 3-5 detailed objective objects with objective_id, objective_name, description, weight.`;

  const userPrompt = hasUserTeams
    ? `Create the core scenario for a ${input.complexity_tier} complexity ${scenario_type} at ${venue}.`
    : `Create the core scenario and teams for a ${input.complexity_tier} complexity ${scenario_type} at ${venue}.`;

  const parsed = await callOpenAi<{
    scenario?: {
      title?: string;
      description?: string;
      briefing?: string;
      objectives?: string[];
      initial_state?: Record<string, unknown>;
      role_specific_briefs?: Record<string, string>;
      category?: string;
      difficulty?: string;
      duration_minutes?: number;
    };
    teams?: WarroomScenarioPayload['teams'];
    objectives?: WarroomScenarioPayload['objectives'];
  }>(systemPrompt, userPrompt, openAiApiKey, 3000);

  const templateTeams = getRequiredTeamsFromTemplate(typeSpec);
  const teams = hasUserTeams
    ? userTeams!
    : parsed.teams && parsed.teams.length >= 4
      ? parsed.teams
      : templateTeams.length > 0
        ? templateTeams
        : parsed.teams || [];

  const scenarioObjectives =
    Array.isArray(parsed.scenario?.objectives) && parsed.scenario.objectives.length > 0
      ? parsed.scenario.objectives
      : parsed.objectives?.map((o) => o.objective_name) || [];

  const description =
    parsed.scenario?.description?.trim() ||
    parsed.scenario?.briefing?.slice(0, 500) ||
    `${scenario_type} at ${venue}`;
  const briefing = parsed.scenario?.briefing?.trim() || description;

  const objectives =
    parsed.objectives && parsed.objectives.length > 0
      ? parsed.objectives
      : scenarioObjectives.length > 0
        ? scenarioObjectives.map((name, i) => ({
            objective_id: `obj_${i}`,
            objective_name: name,
            description: name,
            weight: 25,
            success_criteria: {},
          }))
        : [
            {
              objective_id: 'obj_0',
              objective_name: 'Coordinate response',
              description: 'Establish effective multi-agency coordination',
              weight: 25,
              success_criteria: {},
            },
            {
              objective_id: 'obj_1',
              objective_name: 'Minimize harm',
              description: 'Protect lives and reduce casualties',
              weight: 25,
              success_criteria: {},
            },
          ];

  const finalScenarioObjectives =
    scenarioObjectives.length > 0 ? scenarioObjectives : objectives.map((o) => o.objective_name);

  return {
    scenario: {
      title: parsed.scenario?.title || `${scenario_type} at ${venue}`,
      description,
      briefing,
      objectives: finalScenarioObjectives,
      initial_state: parsed.scenario?.initial_state || {},
      role_specific_briefs: parsed.scenario?.role_specific_briefs || {},
      category: parsed.scenario?.category || 'terrorism',
      difficulty: parsed.scenario?.difficulty || 'advanced',
      duration_minutes: parsed.scenario?.duration_minutes || 60,
    },
    teams,
    objectives,
  };
}

/**
 * Phase 2: Generate time-based injects.
 */
async function generateTimeInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload['time_injects']> {
  onProgress?.('Generating time-based injects...');

  const {
    scenario_type,
    setting,
    terrain,
    venue_name,
    location,
    osm_vicinity,
    typeSpec,
    researchContext,
  } = input;
  const venue = venue_name || location || setting;
  const injectCount =
    input.complexity_tier === 'minimal'
      ? 4
      : input.complexity_tier === 'standard'
        ? 8
        : input.complexity_tier === 'full'
          ? 12
          : 18;

  const osmBlock = osm_vicinity
    ? `\nReal facilities: Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}; Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}; Fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}`
    : '';
  const injectStandardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\n\nSTANDARDS TO GROUND INJECTS IN:\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : researchContext?.standards_summary
        ? `\nStandards: ${researchContext.standards_summary}`
        : '';
  const researchBlock =
    researchContext?.area_summary || injectStandardsBlock
      ? `\nResearch: ${(researchContext?.area_summary || '').slice(0, 400)}${injectStandardsBlock}`
      : '';

  const injectTemplates =
    (typeSpec.inject_templates as Array<{
      timing: string;
      type: string;
      template: string;
      severity: string;
    }>) || [];

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting}
Terrain: ${terrain}
Team names (use these for target_teams): ${teamNames.join(', ')}
${osmBlock}
${researchBlock}

Inject templates from scenario type (use as inspiration):
${JSON.stringify(injectTemplates)}

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": 0,
      "type": "field_update",
      "title": "string",
      "content": "string - detailed inject content",
      "severity": "critical|high|medium",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": false,
      "requires_coordination": false
    },
    ...
  ]
}

RULES:
- You MUST include exactly ${injectCount} time-based injects.
- trigger_time_minutes: 0, 5, 10, 15, 20, 25, ... (spread evenly).
- type: one of media_report, field_update, citizen_call, intel_brief, resource_shortage, weather_change, political_pressure.
- target_teams: subset of team names or [] for universal.
- inject_scope: "universal" or "team_specific".
- content: 1-3 sentences, realistic and challenging.`;

  const userPrompt = `Create ${injectCount} time-based injects for ${scenario_type} at ${venue}.`;

  const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
    systemPrompt,
    userPrompt,
    openAiApiKey,
    4000,
  );

  let raw = parsed.time_injects || [];
  if (raw.length === 0 && injectTemplates.length > 0) {
    raw = injectTemplates.map((t, i) => {
      const timingMatch = (t.timing || '').match(/T\+(\d+)/);
      const mins = timingMatch ? parseInt(timingMatch[1], 10) : i * 5;
      const content = (t.template || 'Update')
        .replace(/\{venue\}/g, venue)
        .replace(/\{ingress_vector\}/g, 'primary access route');
      return {
        trigger_time_minutes: mins,
        type: t.type || 'field_update',
        title: `T+${mins} update`,
        content,
        severity: t.severity || 'high',
        inject_scope: 'universal',
        target_teams: [] as string[],
        requires_response: false,
        requires_coordination: false,
      };
    });
  }
  const teamSet = new Set(teamNames);
  return raw.map((inj) => ({
    ...inj,
    trigger_time_minutes: inj.trigger_time_minutes ?? 0,
    type: normalizeInjectType(inj.type || 'field_update'),
    title: inj.title || 'Update',
    content: inj.content || '',
    severity: inj.severity || 'high',
    inject_scope: inj.inject_scope || 'universal',
    target_teams: (inj.target_teams || []).filter((t) => teamSet.has(t)),
    requires_response: inj.requires_response ?? false,
    requires_coordination: inj.requires_coordination ?? false,
  }));
}

/**
 * Phase 3: Generate decision-based injects.
 */
async function generateDecisionInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload['decision_injects']> {
  const decisionCount =
    input.complexity_tier === 'minimal'
      ? 0
      : input.complexity_tier === 'standard'
        ? 2
        : input.complexity_tier === 'full'
          ? 4
          : 6;

  if (decisionCount === 0) return undefined;

  onProgress?.('Generating decision-based injects...');

  const { scenario_type, setting, venue_name, location, typeSpec } = input;
  const venue = venue_name || location || setting;
  const decisionBranches =
    (typeSpec.decision_branches as Array<{
      trigger_condition?: string;
      inject_template?: string;
    }>) || [];

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario: ${scenario_type} at ${venue}
Team names: ${teamNames.join(', ')}

Decision branch templates:
${JSON.stringify(decisionBranches)}

Return ONLY valid JSON:
{
  "decision_injects": [
    {
      "trigger_condition": "string - when X happens, e.g. when evacuation team decides to segregate",
      "type": "field_update",
      "title": "string",
      "content": "string",
      "severity": "high",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": true,
      "requires_coordination": false
    },
    ...
  ]
}

RULES:
- You MUST include exactly ${decisionCount} decision-based injects.
- trigger_condition: clear, actionable (e.g. "when police/command decides between negotiation or tactical assault").
- Use decision_branches from template as inspiration.
- target_teams: subset of team names or [] for universal.`;

  const userPrompt = `Create ${decisionCount} decision-based injects for ${scenario_type} at ${venue}.`;

  const parsed = await callOpenAi<{
    decision_injects?: WarroomScenarioPayload['decision_injects'];
  }>(systemPrompt, userPrompt, openAiApiKey, 2500);

  let raw = parsed.decision_injects || [];
  if (raw.length === 0 && decisionBranches.length > 0) {
    raw = decisionBranches.slice(0, decisionCount).map((b) => ({
      trigger_condition: b.trigger_condition || 'when team makes key decision',
      type: 'field_update',
      title: b.trigger_condition?.slice(0, 80) || 'Decision required',
      content: b.inject_template || b.trigger_condition || '',
      severity: 'high' as const,
      inject_scope: 'universal' as const,
      target_teams: [] as string[],
      requires_response: true,
      requires_coordination: false,
    }));
  }
  const teamSet = new Set(teamNames);
  const filtered = raw
    .filter((inj) => inj.trigger_condition)
    .map((inj) => ({
      ...inj,
      trigger_condition: inj.trigger_condition,
      type: normalizeInjectType(inj.type || 'field_update'),
      title: inj.title || inj.trigger_condition?.slice(0, 80) || 'Decision required',
      content: inj.content || inj.trigger_condition || '',
      severity: inj.severity || 'high',
      inject_scope: inj.inject_scope || 'universal',
      target_teams: (inj.target_teams || []).filter((t) => teamSet.has(t)),
      requires_response: inj.requires_response ?? true,
      requires_coordination: inj.requires_coordination ?? false,
    }));

  return filtered.length > 0 ? filtered : undefined;
}

const MCI_CONDITION_KEY_NAMES = [
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
  'media_misinformation_addressed',
  'media_journalist_arrived',
  'no_media_management_decision',
  'no_perimeter_establishment_decision',
  'official_public_statement_issued',
  'prior_social_media_rumour_inject_fired',
  'crowd_density_above_0.6',
];

/**
 * Phase 3b: Generate condition-driven injects (perfect storm).
 * For all scenario types when complexity is full/rich. Uses condition keys from template.
 */
async function generateConditionDrivenInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload['condition_driven_injects']> {
  const includeConditionInjects =
    input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeConditionInjects) return undefined;

  onProgress?.('Generating condition-driven injects...');

  const { scenario_type, venue_name, location, typeSpec } = input;
  const venue = venue_name || location || input.setting;

  const templateConditionKeys = (typeSpec.condition_keys as Array<{ key: string }>) ?? [];
  const keyNames =
    templateConditionKeys.length > 0
      ? templateConditionKeys.map((c) => c.key)
      : MCI_CONDITION_KEY_NAMES;
  const conditionKeysHint = `Use ONLY these condition keys (unknown keys evaluate to false): ${keyNames.join(', ')}`;

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario: ${scenario_type} at ${venue}
Teams: ${teamNames.join(', ')}

Generate condition-driven injects: these fire when conditions_to_appear are met and conditions_to_cancel are not. Use eligible_after_minutes (e.g. 5-10) to avoid firing in first minutes.

${conditionKeysHint}

Return ONLY valid JSON:
{
  "condition_driven_injects": [
    {
      "title": "string",
      "content": "string - detailed inject content",
      "type": "field_update",
      "severity": "critical|high|medium",
      "inject_scope": "universal|team_specific",
      "target_teams": ["evacuation"] or [],
      "conditions_to_appear": { "threshold": 2, "conditions": ["evacuation_exit_bottleneck_active", "evacuation_no_flow_control_decision"] } OR { "all": ["media_no_statement_by_T12"] },
      "conditions_to_cancel": ["evacuation_flow_control_decided"],
      "eligible_after_minutes": 8,
      "objective_penalty": { "objective_id": "triage", "reason": "Death on site", "points": 15 } (optional),
      "state_effect": { "triage_state": { "deaths_on_site": 1 } } (optional)
    }
  ]
}

RULES:
- 2-4 condition-driven injects. Use threshold (N-of-M) or all (every condition must be true).
- target_teams: subset of team names or [] for universal.
- objective_penalty: only when inject represents a failure (e.g. death, supply crisis).
- state_effect: when inject should update session state (e.g. triage_state.deaths_on_site).`;

  const userPrompt = `Create condition-driven injects for ${scenario_type} at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      condition_driven_injects?: WarroomScenarioPayload['condition_driven_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 2000);

    const raw = parsed.condition_driven_injects || [];
    if (raw.length === 0) return undefined;

    const teamSet = new Set(teamNames);
    const filtered = raw
      .filter(
        (inj) =>
          inj.title &&
          inj.conditions_to_appear &&
          (('conditions' in inj.conditions_to_appear &&
            inj.conditions_to_appear.conditions?.length) ||
            ('all' in inj.conditions_to_appear && inj.conditions_to_appear.all?.length)),
      )
      .map((inj) => ({
        title: inj.title,
        content: inj.content || inj.title,
        type: normalizeInjectType(inj.type || 'field_update'),
        severity: inj.severity || 'high',
        inject_scope: inj.inject_scope || 'universal',
        target_teams: (inj.target_teams || []).filter((t) => teamSet.has(t)),
        conditions_to_appear: inj.conditions_to_appear,
        conditions_to_cancel: inj.conditions_to_cancel ?? [],
        eligible_after_minutes: inj.eligible_after_minutes ?? 5,
        objective_penalty: inj.objective_penalty,
        state_effect: inj.state_effect,
      }));

    return filtered.length > 0 ? filtered : undefined;
  } catch (err) {
    logger.warn({ err }, 'Condition-driven injects generation failed; continuing without');
    return undefined;
  }
}

/**
 * Phase 4: Generate locations, environmental seeds, layout_ground_truth, site_areas, custom_facts.
 * Narrative-first: the AI reads the full story and derives map pins organically from it.
 */
async function generateLocationsAndSeeds(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<{
  locations?: WarroomScenarioPayload['locations'];
  environmental_seeds?: WarroomScenarioPayload['environmental_seeds'];
  layout_ground_truth?: Record<string, unknown>;
  site_areas?: Array<Record<string, unknown>>;
  custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
  baseline_escalation_factors?: Array<{
    id: string;
    name: string;
    description: string;
    severity: string;
  }>;
}> {
  const includeLocations = input.complexity_tier !== 'minimal';
  const includeEnvSeeds = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  const includeInsiderKnowledge =
    (input.complexity_tier === 'full' || input.complexity_tier === 'rich') &&
    (includeLocations || includeEnvSeeds);
  if (!includeLocations && !includeEnvSeeds) return {};

  onProgress?.('Generating locations and environmental seeds...');

  const { scenario_type, setting, terrain, venue_name, location, geocode } = input;
  const venue = venue_name || location || setting;
  const coords = geocode ? `Center coordinates: ${geocode.lat}, ${geocode.lng}` : 'No coordinates';

  const isMCI = /bombing|mci|mass.?casualty|evacuation|triage|media/i.test(scenario_type);
  const teamStateKeys = isMCI
    ? 'evacuation_state, triage_state, media_state'
    : teamNames.map((t) => `${t.toLowerCase().replace(/\s+/g, '_')}_state`).join(', ');
  const teamStateHints = isMCI
    ? 'evacuation_state, triage_state, media_state with exits_congested, flow_control_decided, supply_level, surge_active, first_statement_issued, journalist_arrived'
    : 'team state keys: ' + teamStateKeys;

  const narrativeBlock = narrative
    ? `\n\nSCENARIO NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer tasked with mapping out the physical environment for an exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${coords}${narrativeBlock}

Your job is to read the scenario narrative above and derive the map pins organically from the story — do NOT default to a generic checklist.
Ask yourself: "Given this specific incident, what locations would teams actually need to know about, coordinate around, or contest control of?"

Each location pin must have:
- location_type: a short snake_case narrative label specific to this scenario (e.g. "negotiation_perimeter", "press_exclusion_zone", "secondary_device_site", "hostage_holding_wing", "casualty_collection_point"). Do NOT default to generic labels like "area" or "exit".
- pin_category: one of "incident_site" | "access" | "triage" | "command" | "staging" | "poi" | "cordon"
  - incident_site: the primary crisis location and any secondary sites
  - access: entry/exit points, routes, corridors
  - triage: medical treatment, casualty staging
  - command: ICP, forward command post, joint ops center
  - staging: holding areas, resource marshalling points
  - poi: external establishments (hospitals, police HQ, fire station, media pool point)
  - cordon: inner/outer perimeter, exclusion zone
- description: one sentence explaining WHY this location matters to this specific scenario's story
- label: short display name (max 5 words)
- coordinates: {lat, lng} derived from the venue and scenario context
- display_order: integer

Return ONLY valid JSON with these keys:
- locations: array of { location_type, pin_category, description, label, coordinates: {lat,lng}, conditions, display_order }
- environmental_seeds: array of { variant_label, seed_data, display_order }. seed_data MUST include: routes (array of {label, problem?, managed?, travel_time_minutes?}), areas (array of {area_id, label, type?, at_capacity?, capacity?}), and team state: ${teamStateHints}
- layout_ground_truth: { evacuee_count?, exits: [{id, label, flow_per_min, status, width_m}], zones?, blast_site?: {description} }
- site_areas: array of { label, capacity_lying?, capacity_standing?, area_m2?, hazards?, vehicle_access?, stretcher_route? }
- custom_facts: array of { topic, summary, detail? }
- baseline_escalation_factors: array of { id, name, description, severity }

RULES:
- locations: ${includeLocations ? '4-8 pins. Derive them from the narrative. Each pin must be specific to THIS scenario — avoid generic labels.' : 'Empty array []'}
- environmental_seeds: ${includeEnvSeeds ? `2 variants. seed_data MUST include routes, areas, and ${teamStateHints}.` : 'Empty array []'}
- layout_ground_truth: ${includeInsiderKnowledge ? 'Derive from narrative. Include capacity, flow, or key structural details relevant to this incident type.' : 'null'}
- site_areas: ${includeInsiderKnowledge ? 'Areas for team operations derived from the scenario. Include capacity, hazards, access.' : 'Empty array []'}
- custom_facts: ${includeInsiderKnowledge ? '3-6 facts grounded in the narrative: incident details, casualty estimates, information environment, sensitivities.' : 'Empty array []'}
- baseline_escalation_factors: ${includeInsiderKnowledge ? '2-4 escalation risks specific to this scenario (e.g. secondary device, hostage panic, crowd surge, media breach).' : 'Empty array []'}`;

  const userPrompt = `Read the scenario narrative and derive the map pins and environmental data for "${narrative?.title || scenario_type}" at ${venue}. Teams involved: ${teamNames.join(', ')}. Make every location specific to this story.`;

  try {
    const parsed = await callOpenAi<{
      locations?: WarroomScenarioPayload['locations'];
      environmental_seeds?: WarroomScenarioPayload['environmental_seeds'];
      layout_ground_truth?: Record<string, unknown>;
      site_areas?: Array<Record<string, unknown>>;
      custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
      baseline_escalation_factors?: Array<{
        id: string;
        name: string;
        description: string;
        severity: string;
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 3000);

    return {
      locations: includeLocations && parsed.locations?.length ? parsed.locations : undefined,
      environmental_seeds:
        includeEnvSeeds && parsed.environmental_seeds?.length
          ? parsed.environmental_seeds
          : undefined,
      layout_ground_truth:
        includeInsiderKnowledge && parsed.layout_ground_truth
          ? parsed.layout_ground_truth
          : undefined,
      site_areas:
        includeInsiderKnowledge && parsed.site_areas?.length ? parsed.site_areas : undefined,
      custom_facts:
        includeInsiderKnowledge && parsed.custom_facts?.length ? parsed.custom_facts : undefined,
      baseline_escalation_factors:
        includeInsiderKnowledge && parsed.baseline_escalation_factors?.length
          ? parsed.baseline_escalation_factors
          : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Locations/seeds generation failed; continuing without');
    return {};
  }
}

/**
 * Exported alias so warroomService can run Phase 1 before standards research
 * and then pass the result back in via input.phase1Preview.
 */
export const generateTeamsAndCoreForResearch = generateTeamsAndCore;

/**
 * Generate full scenario payload using multi-phase AI (teams+core → injects → decisions → locations).
 */
export async function warroomGenerateScenario(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload> {
  const { osm_vicinity } = input;

  // Use pre-computed Phase 1 if provided (narrative-first flow where standards research runs between P1 and P2)
  const phase1 =
    input.phase1Preview ?? (await generateTeamsAndCore(input, openAiApiKey, onProgress));
  const teamNames = phase1.teams.map((t) => t.team_name);

  const time_injects = await generateTimeInjects(input, teamNames, openAiApiKey, onProgress);
  const decision_injects = await generateDecisionInjects(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
  );
  const condition_driven_injects = await generateConditionDrivenInjects(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
  );
  const phase4 = await generateLocationsAndSeeds(input, teamNames, openAiApiKey, onProgress, {
    title: phase1.scenario.title,
    description: phase1.scenario.description,
    briefing: phase1.scenario.briefing,
  });

  const scenarioWithType = {
    ...phase1.scenario,
    initial_state: {
      ...phase1.scenario.initial_state,
      scenario_type: input.scenario_type,
    },
  };

  const insiderKnowledge: WarroomScenarioPayload['insider_knowledge'] = {};
  if (osm_vicinity) insiderKnowledge.osm_vicinity = osm_vicinity;
  if (
    input.researchContext?.standards_findings &&
    input.researchContext.standards_findings.length > 0
  ) {
    insiderKnowledge.sector_standards_structured = input.researchContext.standards_findings;
    insiderKnowledge.sector_standards = standardsToPromptBlock(
      input.researchContext.standards_findings,
    );
  } else if (input.researchContext?.standards_summary) {
    insiderKnowledge.sector_standards = input.researchContext.standards_summary;
  }
  if (phase4.layout_ground_truth) insiderKnowledge.layout_ground_truth = phase4.layout_ground_truth;
  if (phase4.site_areas?.length) insiderKnowledge.site_areas = phase4.site_areas;
  if (phase4.custom_facts?.length) insiderKnowledge.custom_facts = phase4.custom_facts;
  if (phase4.baseline_escalation_factors?.length) {
    insiderKnowledge.baseline_escalation_factors = phase4.baseline_escalation_factors;
  }

  const hasInsiderKnowledge = Object.keys(insiderKnowledge).length > 0;

  return {
    scenario: scenarioWithType,
    teams: phase1.teams,
    objectives: phase1.objectives,
    time_injects,
    decision_injects,
    condition_driven_injects,
    locations: phase4.locations,
    environmental_seeds: phase4.environmental_seeds,
    insider_knowledge: hasInsiderKnowledge ? insiderKnowledge : undefined,
  };
}
