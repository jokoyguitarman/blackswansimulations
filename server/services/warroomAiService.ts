/**
 * War Room AI Service
 * Multi-phase generation: teams+core → time injects → decision injects → locations/seeds.
 * Each phase has its own prompt with explicit schema and fallbacks from templates.
 */

import { logger } from '../lib/logger.js';
import type { OsmVicinity } from './osmVicinityService.js';

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
  }>;
  locations?: Array<{
    location_type: string;
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
    layout_ground_truth?: Record<string, unknown>;
    custom_facts?: Record<string, unknown>;
  };
}

export interface WarroomResearchContext {
  area_summary?: string;
  standards_summary?: string;
}

export interface WarroomUserTeam {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
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
  const researchBlock =
    researchContext?.area_summary || researchContext?.standards_summary
      ? `\nResearch context:\n${researchContext?.area_summary || ''}\n${researchContext?.standards_summary || ''}`
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
  const researchBlock =
    researchContext?.area_summary || researchContext?.standards_summary
      ? `\nResearch: ${(researchContext.area_summary || '').slice(0, 500)}`
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

/**
 * Phase 4: Generate locations and environmental seeds (optional).
 */
async function generateLocationsAndSeeds(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<{
  locations?: WarroomScenarioPayload['locations'];
  environmental_seeds?: WarroomScenarioPayload['environmental_seeds'];
}> {
  const includeLocations = input.complexity_tier !== 'minimal';
  const includeEnvSeeds = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeLocations && !includeEnvSeeds) return {};

  onProgress?.('Generating locations and environmental seeds...');

  const { scenario_type, setting, terrain, venue_name, location, geocode } = input;
  const venue = venue_name || location || setting;
  const coords = geocode ? `Center: ${geocode.lat}, ${geocode.lng}` : 'No coordinates';

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting}
Terrain: ${terrain}
${coords}

Return ONLY valid JSON:
{
  "locations": [
    { "location_type": "blast_site", "label": "string", "coordinates": { "lat": 0, "lng": 0 }, "conditions": {}, "display_order": 0 },
    ...
  ],
  "environmental_seeds": [
    { "variant_label": "string", "seed_data": {}, "display_order": 0 },
    ...
  ]
}

RULES:
- locations: ${includeLocations ? 'Include blast_site, exits, triage_sites; add hospitals/police if coordinates available. 4-8 locations.' : 'Empty array []'}
- environmental_seeds: ${includeEnvSeeds ? '2 variants with seed_data (e.g. guest_density, weather, perimeter)' : 'Empty array []'}`;

  const userPrompt = `Create locations and environmental seeds for ${scenario_type} at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      locations?: WarroomScenarioPayload['locations'];
      environmental_seeds?: WarroomScenarioPayload['environmental_seeds'];
    }>(systemPrompt, userPrompt, openAiApiKey, 2000);

    return {
      locations: includeLocations && parsed.locations?.length ? parsed.locations : undefined,
      environmental_seeds:
        includeEnvSeeds && parsed.environmental_seeds?.length
          ? parsed.environmental_seeds
          : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Locations/seeds generation failed; continuing without');
    return {};
  }
}

/**
 * Generate full scenario payload using multi-phase AI (teams+core → injects → decisions → locations).
 */
export async function warroomGenerateScenario(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload> {
  const { osm_vicinity } = input;

  const phase1 = await generateTeamsAndCore(input, openAiApiKey, onProgress);
  const teamNames = phase1.teams.map((t) => t.team_name);

  const time_injects = await generateTimeInjects(input, teamNames, openAiApiKey, onProgress);
  const decision_injects = await generateDecisionInjects(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
  );
  const phase4 = await generateLocationsAndSeeds(input, openAiApiKey, onProgress);

  return {
    scenario: phase1.scenario,
    teams: phase1.teams,
    objectives: phase1.objectives,
    time_injects,
    decision_injects,
    locations: phase4.locations,
    environmental_seeds: phase4.environmental_seeds,
    insider_knowledge: osm_vicinity ? { osm_vicinity } : undefined,
  };
}
