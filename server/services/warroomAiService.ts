/**
 * War Room AI Service
 * Multi-phase generation: teams+core → time injects → decision injects → locations/seeds.
 * Each phase has its own prompt with explicit schema and fallbacks from templates.
 */

import { logger } from '../lib/logger.js';
import type { OsmVicinity } from './osmVicinityService.js';
import {
  standardsToPromptBlock,
  similarCasesToPromptBlock,
  type SimilarCase,
} from './warroomResearchService.js';

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
  similar_cases?: SimilarCase[];
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
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\n\nSIMILAR REAL INCIDENTS (how events like this have unfolded — use for realistic dynamics):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';
  const researchBlock =
    researchContext?.area_summary || standardsBlock || similarCasesBlock
      ? `\nResearch context:\n${researchContext?.area_summary || ''}${standardsBlock}${similarCasesBlock}`
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

// ---------------------------------------------------------------------------
// Inject timing helpers
// ---------------------------------------------------------------------------

function getPhaseLabelShort(minute: number): string {
  if (minute <= 15) return 'setup';
  if (minute <= 35) return 'escalation';
  if (minute <= 50) return 'peak';
  return 'resolution';
}

/**
 * Pre-assign time slots to universal injects and each team before any AI call fires.
 * Universal always claims anchor points [0, 20, 40, duration-5].
 * Remaining slots are distributed round-robin with per-team jitter so times feel natural.
 * Each team is guaranteed at least one slot.
 */
function buildTimingManifest(
  teamNames: string[],
  durationMinutes = 60,
): { universalSlots: number[]; teamSlots: Record<string, number[]> } {
  const SLOT_STEP = 5;
  const allSlots = Array.from(
    { length: Math.floor(durationMinutes / SLOT_STEP) },
    (_, i) => i * SLOT_STEP,
  );
  const universalSlots = [0, 20, 40, durationMinutes - 5];
  const baseTeamSlots = allSlots.filter((s) => !universalSlots.includes(s));

  // Deterministic per-team jitter (minutes) prevents all teams clustering at exact 5-min multiples
  const JITTER = [0, 2, -1, 3, 1, -2, 2, -1, 1, 0];
  const n = Math.max(1, teamNames.length);
  const teamSlots: Record<string, number[]> = {};

  for (let i = 0; i < teamNames.length; i++) {
    const jitter = JITTER[i % JITTER.length];
    const slots: number[] = [];
    for (let j = i; j < baseTeamSlots.length; j += n) {
      const raw = baseTeamSlots[j] + jitter;
      slots.push(Math.max(1, Math.min(durationMinutes - 1, raw)));
    }
    // Guarantee at least one slot for very large team counts
    if (slots.length === 0) {
      const fallback = ((i * 7) % (durationMinutes - 10)) + 5;
      slots.push(fallback);
    }
    teamSlots[teamNames[i]] = slots;
  }

  return { universalSlots, teamSlots };
}

/**
 * Post-processing safety net: ensures no 5-minute window in [0, durationMinutes) is
 * completely empty of injects. If a gap is found, the nearest inject is shifted up to
 * ±3 minutes to close it. Returns a new sorted array (originals are not mutated).
 */
function normalizeInjectTiming(
  injects: WarroomScenarioPayload['time_injects'],
  durationMinutes = 60,
): WarroomScenarioPayload['time_injects'] {
  if (injects.length === 0) return injects;

  const result = injects.map((inj) => ({ ...inj }));
  result.sort((a, b) => a.trigger_time_minutes - b.trigger_time_minutes);

  const GAP = 5;
  const MAX_SHIFT = 3;
  const numWindows = Math.ceil(durationMinutes / GAP);

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * GAP;
    const wEnd = wStart + GAP;
    const covered = result.some(
      (inj) => inj.trigger_time_minutes >= wStart && inj.trigger_time_minutes < wEnd,
    );
    if (!covered) {
      const midpoint = wStart + GAP / 2;
      let best: (typeof result)[0] | null = null;
      let bestDist = Infinity;
      for (const inj of result) {
        const dist = Math.abs(inj.trigger_time_minutes - midpoint);
        if (dist < bestDist) {
          best = inj;
          bestDist = dist;
        }
      }
      if (best !== null && bestDist <= GAP + MAX_SHIFT) {
        best.trigger_time_minutes = Math.round(
          Math.max(0, Math.min(durationMinutes - 1, midpoint)),
        );
      }
    }
  }

  return result.sort((a, b) => a.trigger_time_minutes - b.trigger_time_minutes);
}

/**
 * Build team pairings for cross-team condition injects, gated by complexity tier.
 * full  → at most the first 3 pairs
 * rich  → all C(N,2) pairs
 */
function buildPairs(
  teamNames: string[],
  tier: WarroomGenerateInput['complexity_tier'],
): [string, string][] {
  if (tier === 'minimal' || tier === 'standard') return [];
  const all: [string, string][] = [];
  for (let i = 0; i < teamNames.length; i++) {
    for (let j = i + 1; j < teamNames.length; j++) {
      all.push([teamNames[i], teamNames[j]]);
    }
  }
  return tier === 'full' ? all.slice(0, 3) : all;
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
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
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
${similarCasesBlock}
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
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';
  const narrativeBlock = narrative
    ? `\nNARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building the world state for a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${standardsBlock}
${similarCasesBlock}

IMPORTANT: This is a ${scenario_type} scenario. Every route, area, and state value you generate MUST be appropriate to how a ${scenario_type} actually unfolds. Do NOT use mass-casualty-incident terminology (triage zones, casualty collection points, stretcher routes, crowd evacuation) unless this scenario genuinely involves those elements.

You must generate 2–3 seed VARIANTS that set a different starting world state for each playthrough. Each variant makes the scenario harder or easier via different route/area conditions and different initial team state values.

MANDATORY team state schema (you MUST include ALL keys below in every variant, varying the VALUES to reflect that variant's difficulty — change values, do NOT change key names):
${stateSchemaJson}

For each variant also include:
- routes[]: named movement corridors, access paths, or communication lines relevant to THIS ${scenario_type}. Name them specifically (e.g. for a kidnapping: "Jungle Extraction Path", "Service Road North"; for a fire: "Stairwell B", "Loading Bay Access").
  Each route: { "label": string, "aliases": string[], "problem": string|null, "managed": boolean, "travel_time_minutes": number, "capacity_per_min": number }
- areas[]: operational areas used by teams in THIS ${scenario_type}. Name them specifically to the scenario (e.g. for a kidnapping: "Negotiation Forward Post", "Sniper Overwatch Position", "Command Post Alpha"; for a fire: "Incident Command Point", "Water Supply Station").
  Each area: { "area_id": string (snake_case), "label": string, "type": string, "at_capacity": boolean, "capacity": number, "aliases": string[], "problems": string[] }

Return ONLY valid JSON:
{
  "environmental_seeds": [
    {
      "variant_label": "string — a short label specific to this variant's key difference (e.g. for kidnapping: 'contact_established', 'hostile_extraction', 'intelligence_gap')",
      "seed_data": {
        "routes": [ { "label": "Scenario-specific route name", "aliases": [], "problem": null, "managed": false, "travel_time_minutes": 5, "capacity_per_min": 10 } ],
        "areas": [ { "area_id": "scenario_specific_area", "label": "Scenario-specific area name", "type": "operational_type", "at_capacity": false, "capacity": 10, "aliases": [], "problems": [] } ],
        ... (all team state keys from schema above with values appropriate for this variant)
      },
      "display_order": 1
    }
  ]
}

RULES:
- 2–3 variants. First = baseline/moderate; second = harder (complication, perimeter breach, intelligence gap, communication failure, etc.); optional third = favourable.
- Vary the team state VALUES per variant to reflect the difficulty (e.g. for kidnapping variant 2: contact_established: false, threat_level: "critical", perimeter_established: false).
- routes and areas must be SPECIFIC to this ${scenario_type} — named realistically for this incident type, not generic MCI/bombing names.
- Every route and area must represent a real game decision point for these teams.
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

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${seedSummary}

IMPORTANT: This is a ${scenario_type} scenario. ALL content — areas, exits, facts, and escalation factors — must be specific to how a ${scenario_type} actually unfolds. Do NOT generate mass-casualty-incident content (triage zones, stretcher routes, secondary explosives, crowd surges, casualty counts) unless this scenario genuinely involves those elements.

Return ONLY valid JSON with these keys:
{
  "layout_ground_truth": {
    "total_capacity": number,
    "exits": [ { "id": "string", "label": "string — name relevant to this ${scenario_type}", "status": "open|blocked|compromised", "throughput": "string — describe flow in terms relevant to this scenario (people/min, vehicles/hour, etc.)" } ],
    "zones": [ { "zone_id": "string", "label": "string — zone name specific to this ${scenario_type}", "description": "string" } ],
    "incident_site": { "description": "string — describes the primary incident location in ${scenario_type} terms", "radius_m": number }
  },
  "site_areas": [
    { "area_id": "string", "label": "string — area name specific to this ${scenario_type}", "capacity": number, "area_m2": number, "hazards": ["string — hazards relevant to this scenario type"], "vehicle_access": boolean, "restricted_access": boolean }
  ],
  "custom_facts": [
    { "topic": "string", "summary": "string", "detail": "string (optional)" }
  ],
  "baseline_escalation_factors": [
    { "id": "string", "name": "string", "description": "string", "severity": "critical|high|medium" }
  ]
}

RULES:
- layout_ground_truth: the physical venue structure as it relates to THIS ${scenario_type}. Zones and exits should reflect the scenario (e.g. for kidnapping: "Perimeter Zone", "Negotiation Approach Corridor"; for fire: "Stairwell B", "Roof Access").
- site_areas: 3–5 operational areas that teams in THIS scenario actually use. Name them for this incident type — NOT generic MCI area names unless this is an MCI.
- custom_facts: 4–6 trainer-only insider facts that are specific to this ${scenario_type} — intelligence gaps, political sensitivities, known perpetrator behaviours, environmental constraints, known unknowns.
- baseline_escalation_factors: 2–4 risks specific to THIS ${scenario_type} that escalate if teams perform poorly. Examples must match the incident type (e.g. for kidnapping: "Hostage Transfer", "Ransom Deadline", "Intelligence Leak"; for fire: "Structural Collapse", "Civilian Entrapment"; for bombing: "Secondary Device", "Crowd Surge"). Do NOT use bombing/MCI examples for non-bombing scenarios.`;

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
// Phase 2a — Universal time-based injects  (1 call · 1 500 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates scene-setting injects visible to ALL teams, anchored to pre-assigned universal slots.
 * These establish the narrative arc: setup → escalation → peak → resolution.
 */
async function generateUniversalTimeInjects(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  universalSlots: number[],
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['time_injects']> {
  onProgress?.('Generating universal time-based injects...');

  const { scenario_type, setting, terrain, venue_name, location, osm_vicinity, researchContext } =
    input;
  const venue = venue_name || location || setting;

  const osmBlock = osm_vicinity
    ? `Real facilities — Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}; Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}; Fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}`
    : '';
  const standardsBlock =
    researchContext?.standards_findings && researchContext.standards_findings.length > 0
      ? `\nStandards:\n${standardsToPromptBlock(researchContext.standards_findings)}`
      : researchContext?.standards_summary
        ? `\nStandards: ${researchContext.standards_summary}`
        : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';
  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';

  const slotDescriptions = universalSlots
    .map((t) => `T+${t} [${getPhaseLabelShort(t)}]`)
    .join(', ');

  const systemPrompt = `You are an expert crisis management scenario designer writing universal scene-setting injects visible to ALL teams simultaneously.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${osmBlock}
${standardsBlock}
${similarCasesBlock}
${narrativeBlock}

Universal injects are shared operational events: breaking news, environmental changes, senior command directives, political pressure, resource status updates affecting the entire operation. Every team sees them at the same moment.

The game must be solvable in 60 minutes if teams perform optimally. Arc the narrative deliberately:
- T+0 [setup]: Establish the crisis — initial situation report, conditions on the ground.
- T+20 [escalation]: A complication or new intelligence that raises the stakes.
- T+40 [peak]: The crisis reaches maximum pressure — a turning point that demands coordinated action.
- T+55 [resolution]: The window closes — decisive outcome or catastrophic failure depending on team performance.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": 0,
      "type": "field_update|media_report|intel_brief|weather_change|political_pressure",
      "title": "string",
      "content": "string — 2-3 sentences, specific to THIS scenario and venue",
      "severity": "critical|high|medium|low",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": false,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${universalSlots.length} injects. Assigned times: ${slotDescriptions}.
- Each inject MUST use its exact assigned trigger_time_minutes — no substitutions.
- inject_scope is always "universal". target_teams is always [].
- Each inject must reference the specific scenario title, venue, and narrative details.
- No generic filler — every inject advances the story.`;

  const userPrompt = `Write ${universalSlots.length} universal injects for "${narrative?.title || scenario_type}" at ${venue} at times: ${slotDescriptions}.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      1500,
    );
    const raw = parsed.time_injects || [];
    return raw.map((inj) => ({
      ...inj,
      trigger_time_minutes: inj.trigger_time_minutes ?? 0,
      type: normalizeInjectType(inj.type || 'field_update'),
      title: inj.title || 'Situation update',
      content: inj.content || '',
      severity: inj.severity || 'high',
      inject_scope: 'universal',
      target_teams: [] as string[],
      requires_response: inj.requires_response ?? false,
      requires_coordination: inj.requires_coordination ?? false,
    }));
  } catch (err) {
    logger.warn({ err }, 'Universal time injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2b — Per-team time-based injects  (1 call per team · 1 200 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates deep team-specific operational injects for a single team.
 * Each call focuses entirely on one team's role, operational challenges, and arc within the scenario.
 */
async function generateTeamTimeInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  assignedSlots: number[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['time_injects']> {
  if (assignedSlots.length === 0) return [];

  const { scenario_type, setting, terrain, venue_name, location, typeSpec, researchContext } =
    input;
  const venue = venue_name || location || setting;
  const injectTemplates =
    (typeSpec.inject_templates as Array<{
      timing: string;
      type: string;
      template: string;
      severity: string;
    }>) || [];

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}\n${(narrative.briefing || '').slice(0, 300)}`
    : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const slotsWithPhase = assignedSlots.map((t) => `T+${t} [${getPhaseLabelShort(t)}]`).join(', ');

  const systemPrompt = `You are an expert crisis management scenario designer writing injects EXCLUSIVELY for the ${teamName} team.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
All teams in this exercise: ${allTeamNames.join(', ')}
THIS inject set is ONLY for: ${teamName}
${narrativeBlock}
${similarCasesBlock}

Inject style reference (tone and specificity):
${JSON.stringify(injectTemplates.slice(0, 3))}

Write DEEP, DETAILED, ROLE-SPECIFIC injects that reflect the real operational challenges of the ${teamName} in THIS exact crisis. Do not write generic status updates — write what a ${teamName} team leader actually receives: a specific field report, resource complication, civilian interaction, or command pressure unique to their role.

The game is solvable in 60 minutes if teams perform optimally. Arc the ${teamName} narrative deliberately:
- Setup (T+0–15): The ${teamName} faces their initial operational challenge in this crisis.
- Escalation (T+15–35): A complication specific to the ${teamName} role raises the stakes.
- Peak (T+35–50): The worst-case pressure on ${teamName} — requires urgent decision.
- Resolution (T+50–60): Consequence or relief based on how ${teamName} has performed.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": <exact value from: ${assignedSlots.join(', ')}>,
      "type": "field_update|citizen_call|intel_brief|resource_shortage|media_report",
      "title": "string — specific to ${teamName}'s operational situation",
      "content": "string — 2-4 sentences, highly specific to ${teamName}'s role and current phase",
      "severity": "critical|high|medium|low",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": false,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${assignedSlots.length} injects using EXACTLY these times: ${slotsWithPhase}.
- inject_scope always "team_specific". target_teams always ["${teamName}"].
- No two injects should address the same challenge — each one advances the ${teamName} sub-story.`;

  const userPrompt = `Write ${assignedSlots.length} deep team-specific injects for ${teamName} at: ${slotsWithPhase} in "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      1200,
    );
    const raw = parsed.time_injects || [];
    return raw.map((inj) => ({
      ...inj,
      trigger_time_minutes: inj.trigger_time_minutes ?? assignedSlots[0],
      type: normalizeInjectType(inj.type || 'field_update'),
      title: inj.title || `${teamName} update`,
      content: inj.content || '',
      severity: inj.severity || 'medium',
      inject_scope: 'team_specific',
      target_teams: [teamName],
      requires_response: inj.requires_response ?? false,
      requires_coordination: inj.requires_coordination ?? false,
    }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Team time injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Per-team decision-based injects  (1 call per team · 1 000 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates decision-branch injects specific to a single team's key operational choices.
 * Skipped for minimal and standard tiers.
 */
async function generateTeamDecisionInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<NonNullable<WarroomScenarioPayload['decision_injects']>> {
  if (input.complexity_tier === 'minimal' || input.complexity_tier === 'standard') return [];

  const { scenario_type, setting, venue_name, location, typeSpec } = input;
  const venue = venue_name || location || setting;
  const decisionBranches =
    (typeSpec.decision_branches as Array<{
      trigger_condition?: string;
      inject_template?: string;
    }>) || [];
  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer writing decision-branch injects for the ${teamName} team.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting}
All teams: ${allTeamNames.join(', ')}
This inject set is EXCLUSIVELY for: ${teamName}
${narrativeBlock}

Decision branch templates (inspiration):
${JSON.stringify(decisionBranches.slice(0, 3))}

Decision injects fire when the ${teamName} makes a specific operational choice. They branch the scenario based on that decision — they are NOT time-based. Write injects that capture the critical decision points a ${teamName} team leader must navigate in this specific crisis.

Return ONLY valid JSON:
{
  "decision_injects": [
    {
      "trigger_condition": "string — exact decision ${teamName} makes, e.g. 'when ${teamName} chooses to [specific action]'",
      "type": "field_update|intel_brief|media_report|citizen_call",
      "title": "string",
      "content": "string — 2-3 sentences: consequence or next challenge arising from that decision",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": true,
      "requires_coordination": false,
      "eligible_after_minutes": 15
    }
  ]
}

RULES:
- Exactly 2 decision injects for ${teamName}.
- trigger_condition must describe a REAL operational decision ${teamName} faces in this crisis — not generic.
- eligible_after_minutes minimum 15 — decisions should not fire in the opening phase.
- Content shows the direct consequence of that decision.`;

  const userPrompt = `Write 2 decision-branch injects for ${teamName} in "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      decision_injects?: WarroomScenarioPayload['decision_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 1000);
    const raw = parsed.decision_injects || [];
    return raw
      .filter((inj) => inj.trigger_condition)
      .map((inj) => ({
        ...inj,
        trigger_condition: inj.trigger_condition,
        type: normalizeInjectType(inj.type || 'field_update'),
        title: inj.title || inj.trigger_condition.slice(0, 80),
        content: inj.content || inj.trigger_condition,
        severity: inj.severity || 'high',
        inject_scope: 'team_specific',
        target_teams: [teamName],
        requires_response: inj.requires_response ?? true,
        requires_coordination: inj.requires_coordination ?? false,
        eligible_after_minutes: inj.eligible_after_minutes ?? 15,
      }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Team decision injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 4d-solo — Per-team condition-driven injects  (1 call per team · 1 200 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates "perfect storm" failure injects for a single team using full world context.
 * Fires only when that team's state keys indicate sustained poor performance.
 * Skipped for minimal and standard tiers.
 */
async function generateTeamConditionInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  seeds?: WarroomScenarioPayload['environmental_seeds'],
  siteAreas?: Array<Record<string, unknown>>,
): Promise<NonNullable<WarroomScenarioPayload['condition_driven_injects']>> {
  const { scenario_type, venue_name, location, typeSpec, researchContext } = input;
  const venue = venue_name || location || input.setting;

  const templateConditionKeys = (typeSpec.condition_keys as Array<{ key: string }>) ?? [];
  const keyNames = templateConditionKeys.map((c) => c.key);
  const conditionKeysHint =
    keyNames.length > 0
      ? `Use ONLY these condition keys (unknown keys evaluate to false at runtime): ${keyNames.join(', ')}`
      : `Use condition keys from the team state schema below (e.g. police_state.perimeter_established, triage_state.supply_level).`;

  const stateSchema = buildTeamStateSchemaHint(allTeamNames);
  const teamStateKey = Object.keys(stateSchema).find((k) =>
    k.toLowerCase().startsWith(teamName.toLowerCase().replace(/\s+/g, '_').split('_')[0]),
  );
  const relevantSchema = teamStateKey ? { [teamStateKey]: stateSchema[teamStateKey] } : stateSchema;

  const locationsBlock = locations?.length
    ? `\nMap pins:\n${locations.map((l) => `- ${l.label} (${l.location_type}): ${l.description || ''}`).join('\n')}`
    : '';
  const areasBlock = siteAreas?.length
    ? `\nSite areas:\n${siteAreas.map((a) => `- ${(a as Record<string, unknown>).label || (a as Record<string, unknown>).area_id}`).join('\n')}`
    : '';
  const seedBlock = seeds?.[0]
    ? `\nBaseline routes: ${JSON.stringify((seeds[0].seed_data as Record<string, unknown>).routes)}`
    : '';
  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const systemPrompt = `You are an expert crisis management scenario designer writing condition-driven failure injects for the ${teamName} team.

Scenario: ${scenario_type} at ${venue}
All teams: ${allTeamNames.join(', ')}
Focus team: ${teamName}
${narrativeBlock}
${similarCasesBlock}
${locationsBlock}
${areasBlock}
${seedBlock}

Team state schema for ${teamName}:
${JSON.stringify(relevantSchema, null, 2)}

${conditionKeysHint}

Condition-driven injects fire automatically when ${teamName}'s performance has been poor — when multiple negative state conditions are simultaneously true. They represent "perfect storm" cascading failures: if ${teamName} fails to manage their responsibilities, these injects compound the consequences.

The game is solvable in 60 minutes if teams play well. These injects should NOT fire on optimal runs — they are the penalty path.

Return ONLY valid JSON:
{
  "condition_driven_injects": [
    {
      "title": "string — names the specific failure mode for ${teamName}",
      "content": "string — 2-3 sentences referencing SPECIFIC location labels from the map pins above",
      "type": "field_update|media_report|intel_brief|citizen_call",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "conditions_to_appear": { "threshold": 2, "conditions": ["key_a", "key_b", "key_c"] },
      "conditions_to_cancel": ["cancellation_key"],
      "eligible_after_minutes": 12,
      "objective_penalty": { "objective_id": "string", "reason": "string", "points": 10 },
      "state_effect": { "state_key": { "counter": 1 } }
    }
  ]
}

RULES:
- 2–3 injects covering distinct ${teamName} failure modes.
- conditions_to_appear keys MUST match the state schema above.
- Reference SPECIFIC location labels from map pins.
- eligible_after_minutes: 10–20.
- objective_penalty only for genuine failure consequences.`;

  const userPrompt = `Write 2-3 condition-driven injects for ${teamName}'s failure modes in "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      condition_driven_injects?: WarroomScenarioPayload['condition_driven_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 1200);
    const raw = parsed.condition_driven_injects || [];
    return raw
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
        inject_scope: 'team_specific',
        target_teams: [teamName],
        conditions_to_appear: inj.conditions_to_appear,
        conditions_to_cancel: inj.conditions_to_cancel,
        eligible_after_minutes: inj.eligible_after_minutes,
        objective_penalty: inj.objective_penalty,
        state_effect: inj.state_effect,
      }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Team condition injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 4d-pair — Cross-team coordination failure injects  (1 call per pair · 1 000 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates cross-team coordination failure injects for a specific team pairing.
 * Fires when BOTH teams have been performing poorly at their operational interface.
 * Skipped for minimal and standard tiers; full tier caps at 3 pairs.
 */
async function generatePairConditionInjects(
  input: WarroomGenerateInput,
  teamA: string,
  teamB: string,
  allTeamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  seeds?: WarroomScenarioPayload['environmental_seeds'],
  siteAreas?: Array<Record<string, unknown>>,
): Promise<NonNullable<WarroomScenarioPayload['condition_driven_injects']>> {
  const { scenario_type, venue_name, location, researchContext } = input;
  const venue = venue_name || location || input.setting;

  const stateSchema = buildTeamStateSchemaHint(allTeamNames);
  const locationsBlock = locations?.length
    ? `\nMap pins:\n${locations.map((l) => `- ${l.label} (${l.location_type})`).join('\n')}`
    : '';
  const areasBlock = siteAreas?.length
    ? `\nSite areas:\n${siteAreas.map((a) => `- ${(a as Record<string, unknown>).label || (a as Record<string, unknown>).area_id}`).join('\n')}`
    : '';
  const seedBlock = seeds?.[0]
    ? `\nBaseline routes: ${JSON.stringify((seeds[0].seed_data as Record<string, unknown>).routes)}`
    : '';
  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS:\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';

  const systemPrompt = `You are an expert crisis management scenario designer writing cross-team coordination failure injects.

Scenario: ${scenario_type} at ${venue}
Team pair: ${teamA} and ${teamB}
All teams: ${allTeamNames.join(', ')}
${narrativeBlock}
${similarCasesBlock}
${locationsBlock}
${areasBlock}
${seedBlock}

Full team state schema:
${JSON.stringify(stateSchema, null, 2)}

Cross-team injects fire when BOTH ${teamA} and ${teamB} have failed to coordinate at their operational interface. They represent cascading failures caused specifically by the breakdown between these two teams — e.g. ${teamA} holding a bottleneck that overwhelms ${teamB}, contradictory instructions to the public, or a critical handover that was missed.

The game is solvable in 60 minutes on the optimal path — these injects fire ONLY if both teams are underperforming.

Return ONLY valid JSON:
{
  "condition_driven_injects": [
    {
      "title": "string — names the coordination failure between ${teamA} and ${teamB}",
      "content": "string — 2-3 sentences: the specific cascading failure from both teams not coordinating, referencing location labels",
      "type": "field_update|media_report|intel_brief|citizen_call",
      "severity": "critical|high",
      "inject_scope": "team_specific",
      "target_teams": ["${teamA}", "${teamB}"],
      "conditions_to_appear": { "threshold": 2, "conditions": ["key_teamA", "key_teamB", "key_third"] },
      "conditions_to_cancel": ["resolution_key"],
      "eligible_after_minutes": 15,
      "objective_penalty": { "objective_id": "obj_coordination", "reason": "string", "points": 15 },
      "state_effect": {}
    }
  ]
}

RULES:
- 1–2 injects for the ${teamA} and ${teamB} interface.
- Each title MUST be unique and specific to the coordination failure — include both team names and the failure type. Never reuse the same title across injects.
- conditions_to_appear must reference state keys from BOTH teams (not just one).
- Content describes the specific interface failure between ${teamA} and ${teamB}.
- eligible_after_minutes: minimum 15.`;

  const userPrompt = `Write 1-2 cross-team coordination failure injects for ${teamA} and ${teamB} in "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      condition_driven_injects?: WarroomScenarioPayload['condition_driven_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 1000);
    const raw = parsed.condition_driven_injects || [];
    return raw
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
        inject_scope: 'team_specific',
        target_teams: [teamA, teamB],
        conditions_to_appear: inj.conditions_to_appear,
        conditions_to_cancel: inj.conditions_to_cancel,
        eligible_after_minutes: inj.eligible_after_minutes ?? 15,
        objective_penalty: inj.objective_penalty,
        state_effect: inj.state_effect,
      }));
  } catch (err) {
    logger.warn({ err, teamA, teamB }, 'Pair condition injects failed; continuing without');
    return [];
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
 *
 * Phase 1  (sequential) : teams + core scenario
 * Batch A  (parallel)   : universal time injects + per-team time injects + per-team decision injects
 * Phase 4a (sequential) : map pins
 * Phase 4b (sequential) : environmental seeds
 * Phase 4c (sequential) : layout + site knowledge
 * Batch B  (parallel)   : per-team condition injects + per-pair condition injects
 * Post-process          : normalizeInjectTiming (gap fill)
 */
export async function warroomGenerateScenario(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
): Promise<WarroomScenarioPayload> {
  const { osm_vicinity } = input;

  // Phase 1 — teams + core (or use pre-computed result from narrative-first flow)
  const phase1 =
    input.phase1Preview ?? (await generateTeamsAndCore(input, openAiApiKey, onProgress));
  const teamNames = phase1.teams.map((t) => t.team_name);
  const narrative = {
    title: phase1.scenario.title,
    description: phase1.scenario.description,
    briefing: phase1.scenario.briefing,
  };

  // Pre-assign timing slots before any AI call fires
  const timingManifest = buildTimingManifest(teamNames);

  // Batch A — time injects + decision injects, all parallel (no world context needed)
  onProgress?.('Generating injects (parallel batch A)...');
  const [universalTimeInjects, perTeamTimeResults, perTeamDecisionResults] = await Promise.all([
    generateUniversalTimeInjects(
      input,
      teamNames,
      openAiApiKey,
      timingManifest.universalSlots,
      undefined,
      narrative,
    ),
    // Per-team time: for standard/full/rich (minimal gets only universal injects)
    Promise.all(
      teamNames.map((t) =>
        input.complexity_tier === 'minimal'
          ? Promise.resolve([] as WarroomScenarioPayload['time_injects'])
          : generateTeamTimeInjects(
              input,
              t,
              teamNames,
              openAiApiKey,
              timingManifest.teamSlots[t] ?? [],
              narrative,
            ),
      ),
    ),
    // Per-team decision: only for full/rich (function gates internally on tier)
    Promise.all(
      teamNames.map((t) =>
        generateTeamDecisionInjects(input, t, teamNames, openAiApiKey, narrative),
      ),
    ),
  ]);

  // Merge and normalise time injects — guarantees no 5-min gap in 0–60
  const rawTimeInjects: WarroomScenarioPayload['time_injects'] = [
    ...universalTimeInjects,
    ...perTeamTimeResults.flat(),
  ];
  const time_injects = normalizeInjectTiming(rawTimeInjects);

  const decisionFlat = perTeamDecisionResults.flat();
  const decision_injects = decisionFlat.length > 0 ? decisionFlat : undefined;

  // World creation phases — each feeds context into the next (unchanged)
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

  // Batch B — condition injects with full world context, all parallel
  const includeCondition = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  let condition_driven_injects: WarroomScenarioPayload['condition_driven_injects'];

  if (includeCondition) {
    onProgress?.('Generating condition-driven injects (parallel batch B)...');
    const pairs = buildPairs(teamNames, input.complexity_tier);
    const condResults = await Promise.all([
      ...teamNames.map((t) =>
        generateTeamConditionInjects(
          input,
          t,
          teamNames,
          openAiApiKey,
          narrative,
          locations,
          environmental_seeds,
          phase4c.site_areas,
        ),
      ),
      ...pairs.map(([a, b]) =>
        generatePairConditionInjects(
          input,
          a,
          b,
          teamNames,
          openAiApiKey,
          narrative,
          locations,
          environmental_seeds,
          phase4c.site_areas,
        ),
      ),
    ]);
    const condFlat = condResults.flat();
    if (condFlat.length > 0) condition_driven_injects = condFlat;
  }

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
