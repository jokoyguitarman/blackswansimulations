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

// ---------------------------------------------------------------------------
// Team state schema hint — used by Phase 4b and 4d prompts
// ---------------------------------------------------------------------------

/**
 * Build a canonical initial state shape for each team based on team-name pattern matching.
 * This is passed into the AI prompt so it knows exactly which state keys to populate per variant.
 * The AI fills in the VALUES and may extend with extra scenario-specific keys.
 */
export function buildTeamStateSchemaHint(
  teamNames: string[],
): Record<string, Record<string, unknown>> {
  const schema: Record<string, Record<string, unknown>> = {};
  for (const name of teamNames) {
    const n = name.toLowerCase();
    if (/evacuation|evac/.test(n)) {
      schema['evacuation_state'] = {
        exits_congested: [],
        flow_control_decided: false,
        coordination_with_triage: false,
        evacuated_count: 0,
        total_evacuees: 1000,
      };
    } else if (/triage|medical/.test(n)) {
      schema['triage_state'] = {
        supply_level: 'adequate',
        surge_active: false,
        prioritisation_decided: false,
        supply_request_made: false,
        deaths_on_site: 0,
        critical_pending: 0,
        handed_over_to_hospital: 0,
        patients_being_treated: 0,
        patients_waiting: 0,
        casualties: 0,
      };
    } else if (/media|comm/.test(n)) {
      schema['media_state'] = {
        first_statement_issued: false,
        misinformation_addressed: false,
        journalist_arrived: false,
        statements_issued: 0,
        misinformation_addressed_count: 0,
      };
    } else if (/police|law/.test(n)) {
      schema['police_state'] = {
        perimeter_established: false,
        tactical_team_ready: false,
        armed_units: 0,
        inner_cordon_radius_m: 200,
      };
    } else if (/negotiat/.test(n)) {
      schema['negotiation_state'] = {
        contact_established: false,
        demands_received: false,
        active_session: false,
        sessions_count: 0,
        last_contact_minutes_ago: null,
      };
    } else if (/intel/.test(n)) {
      schema['intelligence_state'] = {
        hostage_count_confirmed: null,
        threat_level: 'high',
        perpetrator_count_known: false,
        inside_intel: false,
      };
    } else if (/fire/.test(n)) {
      schema['fire_state'] = {
        fire_contained: false,
        entry_safe: false,
        units_deployed: 0,
        hotspots: [],
      };
    } else {
      const key = `${n.replace(/\s+/g, '_')}_state`;
      schema[key] = {
        operational_status: 'standby',
        ready: false,
        resources_deployed: 0,
      };
    }
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Phase 4a — Map Pins  (narrative-first, 2 000 tokens)
// ---------------------------------------------------------------------------

async function generateMapPins(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['locations']> {
  if (input.complexity_tier === 'minimal') return undefined;

  onProgress?.('Generating map pins...');

  const {
    scenario_type,
    setting,
    terrain,
    venue_name,
    location,
    geocode,
    osm_vicinity,
    researchContext,
  } = input;
  const venue = venue_name || location || setting;
  const coords = geocode ? `Center coordinates: ${geocode.lat}, ${geocode.lng}` : '';
  const osmBlock = osm_vicinity
    ? `Nearby facilities: hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'none'}; police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'none'}; fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'none'}`
    : '';
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\nResponse standards context:\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : '';
  const narrativeBlock = narrative
    ? `\n\nSCENARIO NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer mapping the physical environment.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${coords}
${osmBlock}
${standardsBlock}
${narrativeBlock}

Read the scenario narrative and derive map pins ORGANICALLY from the story. Ask: "Given this specific incident, what locations would teams actually coordinate around or contest?"

Each pin:
- location_type: short snake_case narrative label SPECIFIC to this scenario (e.g. "negotiation_perimeter", "secondary_device_site", "casualty_collection_point"). Do NOT use generic labels like "area" or "exit".
- pin_category: one of "incident_site" | "access" | "triage" | "command" | "staging" | "poi" | "cordon"
  - incident_site: primary crisis location and secondary sites
  - access: entry/exit points, corridors, evacuation routes
  - triage: medical treatment and casualty staging areas
  - command: ICP, forward command post, joint ops center
  - staging: holding areas, resource marshalling points
  - poi: external establishments (hospitals, police HQ, fire station, media pool point)
  - cordon: inner/outer perimeter, exclusion zones
- description: one sentence explaining WHY this location matters to THIS scenario's story
- label: short display name (max 5 words)
- coordinates: {lat, lng} derived from venue and scenario context
- display_order: integer (1 = most important)

Return ONLY valid JSON:
{ "locations": [ { "location_type": "string", "pin_category": "string", "description": "string", "label": "string", "coordinates": { "lat": 0.0, "lng": 0.0 }, "conditions": {}, "display_order": 1 } ] }

RULES:
- 4–8 pins. Every pin must be specific to THIS scenario — no generic placeholders.
- Cover the primary incident site, at least one command/ICP, and relevant operational/support locations.`;

  const userPrompt = `Derive map pins for "${narrative?.title || scenario_type}" at ${venue}. Teams: ${teamNames.join(', ')}.`;

  try {
    const parsed = await callOpenAi<{ locations?: WarroomScenarioPayload['locations'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      2000,
    );
    return parsed.locations?.length ? parsed.locations : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4a map pins failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b — Environmental Seeds  (rich routes / areas / team states, 5 000 tokens)
// ---------------------------------------------------------------------------

async function generateEnvironmentalSeeds(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
): Promise<WarroomScenarioPayload['environmental_seeds']> {
  const includeSeeds = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeSeeds) return undefined;

  onProgress?.('Generating environmental seeds...');

  const { scenario_type, setting, terrain, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;
  const stateSchema = buildTeamStateSchemaHint(teamNames);
  const stateSchemaJson = JSON.stringify(stateSchema, null, 2);

  const locationsBlock = locations?.length
    ? `\nMap pins for this scenario:\n${locations.map((l) => `- ${l.label} (${l.location_type}, category: ${l.pin_category}): ${l.description || ''}`).join('\n')}`
    : '';
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\nResponse standards:\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : '';
  const narrativeBlock = narrative
    ? `\nNARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building the world state for a training exercise.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${standardsBlock}

You must generate 2–3 seed VARIANTS that set a different starting world state for each playthrough. Each variant makes the scenario harder or easier via different route/area conditions and different initial team state values.

MANDATORY team state schema (you MUST include ALL keys below in every variant, varying the VALUES to reflect that variant's difficulty or situation):
${stateSchemaJson}

For each variant also include:
- routes[]: named routes/corridors/exits in the scenario.
  Each route: { "label": string, "aliases": string[], "problem": string|null, "managed": boolean, "travel_time_minutes": number, "capacity_per_min": number }
- areas[]: operational areas, facilities, hospitals, staging zones.
  Each area: { "area_id": string (snake_case), "label": string, "type": string, "at_capacity": boolean, "capacity": number, "aliases": string[], "problems": string[] }

Return ONLY valid JSON:
{
  "environmental_seeds": [
    {
      "variant_label": "string (e.g. all_clear, north_congested, supply_low)",
      "seed_data": {
        "routes": [ { "label": "...", "aliases": [], "problem": null, "managed": false, "travel_time_minutes": 5, "capacity_per_min": 40 } ],
        "areas": [ { "area_id": "triage_zone_a", "label": "Main Triage Zone", "type": "triage", "at_capacity": false, "capacity": 60, "aliases": [], "problems": [] } ],
        ... (all team state keys from schema above with values appropriate for this variant)
      },
      "display_order": 1
    }
  ]
}

RULES:
- 2–3 variants. First variant = baseline/moderate; second = harder (congestion, supply shortage, perimeter breach etc.); optional third = easier/favourable.
- Vary the team state VALUES per variant (e.g. variant 2 may start with supply_level: "low", exits_congested: ["North Exit"], perimeter_established: false).
- routes and areas must be SPECIFIC to this scenario and narrative — named realistically (e.g. "East Corridor B", "Triage Zone Alpha", "Holding Assembly Area").
- Every route and area must be usable as a game decision point.
- Include ALL team state keys from the schema in every variant.`;

  const userPrompt = `Build ${2} environmental seed variants for "${narrative?.title || scenario_type}" at ${venue}. Teams: ${teamNames.join(', ')}.`;

  try {
    const parsed = await callOpenAi<{
      environmental_seeds?: WarroomScenarioPayload['environmental_seeds'];
    }>(systemPrompt, userPrompt, openAiApiKey, 5000);
    return parsed.environmental_seeds?.length ? parsed.environmental_seeds : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4b environmental seeds failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4c — Layout & Site Knowledge  (3 000 tokens)
// ---------------------------------------------------------------------------

async function generateLayoutAndSiteKnowledge(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  seeds?: WarroomScenarioPayload['environmental_seeds'],
): Promise<{
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
  const includeKnowledge = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeKnowledge) return {};

  onProgress?.('Generating layout and site knowledge...');

  const { scenario_type, setting, terrain, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const locationsBlock = locations?.length
    ? `Map pins:\n${locations.map((l) => `- ${l.label} (${l.location_type})`).join('\n')}`
    : '';
  const seedSummary = seeds?.[0]
    ? `Baseline seed variant "${seeds[0].variant_label}":\n- Routes: ${JSON.stringify((seeds[0].seed_data as Record<string, unknown>).routes)}\n- Areas: ${JSON.stringify((seeds[0].seed_data as Record<string, unknown>).areas)}`
    : '';
  const narrativeBlock = narrative
    ? `NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building insider knowledge for trainers.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${seedSummary}

Return ONLY valid JSON with these keys:
{
  "layout_ground_truth": {
    "total_capacity": number,
    "exits": [ { "id": "string", "label": "string", "flow_per_min": number, "status": "open|blocked|congested", "width_m": number } ],
    "zones": [ { "zone_id": "string", "label": "string", "description": "string" } ],
    "incident_site": { "description": "string", "radius_m": number }
  },
  "site_areas": [
    { "area_id": "string", "label": "string", "capacity_lying": number, "capacity_standing": number, "area_m2": number, "hazards": ["string"], "vehicle_access": boolean, "stretcher_route": boolean }
  ],
  "custom_facts": [
    { "topic": "string", "summary": "string", "detail": "string (optional)" }
  ],
  "baseline_escalation_factors": [
    { "id": "string", "name": "string", "description": "string", "severity": "critical|high|medium" }
  ]
}

RULES:
- layout_ground_truth: physical venue structure. Include realistic capacity, exit widths, and zones relevant to this scenario type.
- site_areas: 3–5 operational areas teams will use (triage zone, assembly area, command post, media pool, etc.).
- custom_facts: 4–6 trainer-only insider facts — casualty estimates, information environment, political sensitivities, known unknowns.
- baseline_escalation_factors: 2–4 risks that could escalate the scenario if teams perform poorly (e.g. secondary device, media breach, crowd surge, supply failure).`;

  const userPrompt = `Build layout and site knowledge for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
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
      layout_ground_truth: parsed.layout_ground_truth || undefined,
      site_areas: parsed.site_areas?.length ? parsed.site_areas : undefined,
      custom_facts: parsed.custom_facts?.length ? parsed.custom_facts : undefined,
      baseline_escalation_factors: parsed.baseline_escalation_factors?.length
        ? parsed.baseline_escalation_factors
        : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Phase 4c layout/site knowledge failed; continuing without');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Phase 4d — Condition-Driven Injects  (world-aware, replaces old Phase 3b, 3 000 tokens)
// ---------------------------------------------------------------------------

/**
 * Phase 4d: Generate condition-driven injects using full world context.
 * Runs AFTER map pins, seeds, and layout are known so injects can reference real locations and state keys.
 */
async function generateConditionInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  seeds?: WarroomScenarioPayload['environmental_seeds'],
  siteAreas?: Array<Record<string, unknown>>,
): Promise<WarroomScenarioPayload['condition_driven_injects']> {
  const includeConditionInjects =
    input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeConditionInjects) return undefined;

  onProgress?.('Generating condition-driven injects...');

  const { scenario_type, venue_name, location, typeSpec } = input;
  const venue = venue_name || location || input.setting;

  const templateConditionKeys = (typeSpec.condition_keys as Array<{ key: string }>) ?? [];
  const keyNames = templateConditionKeys.map((c) => c.key);
  const conditionKeysHint =
    keyNames.length > 0
      ? `Use ONLY these condition keys (unknown keys evaluate to false at runtime): ${keyNames.join(', ')}`
      : 'Use condition keys derived from the team state schema below (e.g. police_state.perimeter_established, triage_state.supply_level).';

  const stateSchema = buildTeamStateSchemaHint(teamNames);
  const stateSchemaJson = JSON.stringify(stateSchema, null, 2);

  const locationsBlock = locations?.length
    ? `\nMap pins in this scenario:\n${locations.map((l) => `- ${l.label} (${l.location_type}): ${l.description || ''}`).join('\n')}`
    : '';

  const areasBlock = siteAreas?.length
    ? `\nSite areas:\n${siteAreas.map((a) => `- ${(a as Record<string, unknown>).label || (a as Record<string, unknown>).area_id}`).join('\n')}`
    : '';

  const seedBlock = seeds?.[0]
    ? `\nBaseline seed variant "${seeds[0].variant_label}" routes: ${JSON.stringify((seeds[0].seed_data as Record<string, unknown>).routes)}`
    : '';

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer creating condition-driven injects.

Scenario: ${scenario_type} at ${venue}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${areasBlock}
${seedBlock}

Team state schema (these are the state keys that exist at runtime):
${stateSchemaJson}

${conditionKeysHint}

Condition-driven injects fire when conditions_to_appear are met AND conditions_to_cancel are not met.
They represent "perfect storm" failures that compound if teams perform badly.
Use eligible_after_minutes (5–12) to avoid triggering in the first minutes.

Where possible, reference SPECIFIC location labels from the map pins above (e.g. content mentioning "Triage Zone Alpha" or "North Exit Corridor").

Return ONLY valid JSON:
{
  "condition_driven_injects": [
    {
      "title": "string",
      "content": "string — 2-3 sentences, specific to THIS scenario, reference real location names",
      "type": "field_update|media_report|intel_brief|citizen_call",
      "severity": "critical|high|medium",
      "inject_scope": "universal|team_specific",
      "target_teams": ["team_name"] or [],
      "conditions_to_appear": { "threshold": 2, "conditions": ["key_a", "key_b", "key_c"] } OR { "all": ["key_a"] },
      "conditions_to_cancel": ["cancellation_key"],
      "eligible_after_minutes": 8,
      "objective_penalty": { "objective_id": "string", "reason": "string", "points": 10 },
      "state_effect": { "triage_state": { "deaths_on_site": 1 } }
    }
  ]
}

RULES:
- 3–6 condition-driven injects covering different team failure modes.
- Mix threshold (N-of-M) and all (every condition) approaches.
- objective_penalty: only for genuine failure injects (death, supply crisis, perimeter breach).
- state_effect: when the inject should increment a counter or flip a state flag.
- target_teams: restrict to the affected team(s) or [] for universal impact.`;

  const userPrompt = `Create condition-driven injects for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      condition_driven_injects?: WarroomScenarioPayload['condition_driven_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 3000);

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
    logger.warn({ err }, 'Phase 4d condition injects failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// DEAD CODE REMOVED — generateLocationsAndSeeds replaced by 4a/4b/4c/4d above
// ---------------------------------------------------------------------------
/**
 * Exported alias so warroomService can run Phase 1 before standards research
 * and then pass the result back in via input.phase1Preview.
 */
export const generateTeamsAndCoreForResearch = generateTeamsAndCore;

/**
 * Generate full scenario payload using multi-phase AI.
 * Order: Phase 1 (teams+core) → Phase 2 (time injects) → Phase 3 (decision injects)
 *        → Phase 4a (map pins) → Phase 4b (env seeds) → Phase 4c (layout+site) → Phase 4d (condition injects)
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
  const narrative = {
    title: phase1.scenario.title,
    description: phase1.scenario.description,
    briefing: phase1.scenario.briefing,
  };

  const time_injects = await generateTimeInjects(input, teamNames, openAiApiKey, onProgress);
  const decision_injects = await generateDecisionInjects(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
  );

  // World creation phases — each feeds context into the next
  const locations = await generateMapPins(input, teamNames, openAiApiKey, onProgress, narrative);
  const environmental_seeds = await generateEnvironmentalSeeds(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
    narrative,
    locations,
  );
  const phase4c = await generateLayoutAndSiteKnowledge(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
    narrative,
    locations,
    environmental_seeds,
  );
  const condition_driven_injects = await generateConditionInjects(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
    narrative,
    locations,
    environmental_seeds,
    phase4c.site_areas,
  );

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
  if (phase4c.layout_ground_truth)
    insiderKnowledge.layout_ground_truth = phase4c.layout_ground_truth;
  if (phase4c.site_areas?.length) insiderKnowledge.site_areas = phase4c.site_areas;
  if (phase4c.custom_facts?.length) insiderKnowledge.custom_facts = phase4c.custom_facts;
  if (phase4c.baseline_escalation_factors?.length) {
    insiderKnowledge.baseline_escalation_factors = phase4c.baseline_escalation_factors;
  }

  const hasInsiderKnowledge = Object.keys(insiderKnowledge).length > 0;

  return {
    scenario: scenarioWithType,
    teams: phase1.teams,
    objectives: phase1.objectives,
    time_injects,
    decision_injects,
    condition_driven_injects,
    locations,
    environmental_seeds,
    insider_knowledge: hasInsiderKnowledge ? insiderKnowledge : undefined,
  };
}
