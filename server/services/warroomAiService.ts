/**
 * War Room AI Service
 * Multi-phase generation: teams+core → time injects → decision injects → locations/seeds.
 * Each phase has its own prompt with explicit schema and fallbacks from templates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../lib/logger.js';
import type {
  OsmVicinity,
  OsmOpenSpace,
  OsmBuilding,
  OsmRouteGeometry,
} from './osmVicinityService.js';
import {
  standardsToPromptBlock,
  similarCasesToPromptBlock,
  crowdDynamicsToPromptBlock,
  mapStandardsToTeams,
  researchTeamWorkflows,
  type SimilarCase,
} from './warroomResearchService.js';
import type { CounterDefinition } from '../counterDefinitions.js';
import {
  pointInPolygon,
  circleToPolygon,
  scalePolygonFromCentroid,
  polygonCentroid,
  haversineM as geoHaversineM,
} from './geoUtils.js';

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
    counter_definitions?: CounterDefinition[];
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
    requires_response?: boolean;
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
  floor_plans?: Array<{
    floor_level: string;
    floor_label: string;
    plan_svg?: string;
    plan_image_url?: string;
    bounds?: Record<string, unknown>;
    features: Array<{
      id: string;
      type: string;
      label: string;
      geometry?: Record<string, unknown>;
      properties?: Record<string, unknown>;
    }>;
    environmental_factors: Array<Record<string, unknown>>;
  }>;
  hazards?: Array<{
    hazard_type: string;
    location_lat: number;
    location_lng: number;
    floor_level: string;
    properties: Record<string, unknown>;
    assessment_criteria: string[];
    image_url?: string;
    image_sequence?: Array<{ at_minutes: number; image_url: string; description: string }>;
    status: string;
    appears_at_minutes: number;
    resolution_requirements?: Record<string, unknown>;
    personnel_requirements?: Record<string, unknown>;
    equipment_requirements?: Array<Record<string, unknown>>;
    deterioration_timeline?: Record<string, unknown>;
    enriched_description?: string;
    fire_class?: string;
    debris_type?: string;
    zones?: Array<{
      zone_type: string;
      radius_m: number;
      ppe_required: string[];
      allowed_teams: string[];
      activities: string[];
    }>;
  }>;
  casualties?: Array<{
    casualty_type: 'patient' | 'crowd' | 'evacuee_group' | 'convergent_crowd';
    location_lat: number;
    location_lng: number;
    floor_level: string;
    headcount: number;
    conditions: Record<string, unknown>;
    status: string;
    appears_at_minutes: number;
    destination_lat?: number;
    destination_lng?: number;
    destination_label?: string;
    movement_speed_mpm?: number;
  }>;
  equipment?: Array<{
    equipment_type: string;
    label: string;
    icon?: string;
    properties: Record<string, unknown>;
    applicable_teams?: string[];
  }>;
  insider_knowledge?: {
    osm_vicinity?: OsmVicinity;
    sector_standards?: string;
    sector_standards_structured?: import('./warroomResearchService.js').StandardsFinding[];
    team_doctrines?: Record<string, import('./warroomResearchService.js').StandardsFinding[]>;
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
    team_intelligence_dossiers?: Record<
      string,
      Array<{
        question: string;
        category: string;
        answer: string;
      }>
    >;
    team_workflows?: Record<
      string,
      {
        endgame: string;
        steps: string[];
        personnel_ratios?: Record<string, string>;
        sop_checklist?: string[];
      }
    >;
  };
}

export interface WarroomResearchContext {
  area_summary?: string;
  /** @deprecated use standards_findings instead */
  standards_summary?: string;
  standards_findings?: import('./warroomResearchService.js').StandardsFinding[];
  similar_cases?: SimilarCase[];
  crowd_dynamics?: import('./warroomResearchService.js').CrowdDynamicsResearch;
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

/**
 * Load counter definitions from the scenario type JSON template.
 * Returns null if the template doesn't exist or has no team_counter_definitions.
 */
function loadTemplateCounterDefs(scenarioType: string): Record<string, CounterDefinition[]> | null {
  try {
    const filePath = path.join(
      process.cwd(),
      'scenario_templates/scenario_types',
      `${scenarioType}.json`,
    );
    if (fs.existsSync(filePath)) {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (
        content.team_counter_definitions &&
        typeof content.team_counter_definitions === 'object'
      ) {
        return content.team_counter_definitions as Record<string, CounterDefinition[]>;
      }
    }
  } catch {
    // Template loading is best-effort
  }
  return null;
}

export interface WarroomGenerateInput {
  scenario_type: string;
  setting: string;
  terrain: string;
  location: string | null;
  venue_name?: string;
  /** The user's original free-text prompt, preserved for AI narrative generation. */
  original_prompt?: string;
  /** Nearby landmarks the user mentioned (e.g. "Ateneo de Davao University"). */
  landmarks?: string[];
  osm_vicinity?: OsmVicinity;
  osmOpenSpaces?: OsmOpenSpace[];
  osmBuildings?: OsmBuilding[];
  osmRouteGeometries?: OsmRouteGeometry[];
  geocode?: { lat: number; lng: number; display_name: string };
  complexity_tier: 'minimal' | 'standard' | 'full' | 'rich';
  /** Game duration in minutes (20–240, default 60). Drives inject volume and timing. */
  duration_minutes?: number;
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
    original_prompt,
    landmarks,
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

  const originalPromptBlock = original_prompt
    ? `\nUser's original request: "${original_prompt}"\nIMPORTANT: The scenario title, description, and briefing MUST reference the specific venue/location the user described. Do NOT substitute a different venue type or name.`
    : '';
  const landmarksBlock =
    landmarks && landmarks.length > 0
      ? `\nNearby landmarks mentioned by user: ${landmarks.join(', ')}\nIncorporate these landmarks into the scenario narrative where appropriate.`
      : '';

  const systemPrompt = `You are an expert crisis management scenario designer.

Scenario type: ${scenario_type}
Setting: ${setting}
Terrain: ${terrain}
Venue: ${venue}${originalPromptBlock}${landmarksBlock}
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
    "duration_minutes": ${input.duration_minutes ?? 60}
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
      duration_minutes: input.duration_minutes ?? parsed.scenario?.duration_minutes ?? 60,
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
): {
  universalSlots: number[];
  teamSlots: Record<string, number[]>;
  chaosSlots: Record<string, number[]>;
} {
  const SLOT_STEP = 5;
  const allSlots = Array.from(
    { length: Math.floor(durationMinutes / SLOT_STEP) },
    (_, i) => i * SLOT_STEP,
  );
  // Universal slots spread proportionally across the duration
  const universalSlots = Array.from(
    { length: Math.max(4, Math.floor(durationMinutes / 10) + 1) },
    (_, i) => Math.min(i * 10, durationMinutes - 5),
  ).filter((v, i, a) => a.indexOf(v) === i);
  const baseTeamSlots = allSlots.filter((s) => !universalSlots.includes(s));

  // Every team gets ALL available time slots with per-team jitter so they
  // don't all fire at the exact same second.
  const JITTER = [0, 2, -1, 3, 1, -2, 2, -1, 1, 0];
  const CHAOS_JITTER = [1, -2, 3, 0, -1, 2, -1, 3, 0, 1];
  const teamSlots: Record<string, number[]> = {};
  const chaosSlots: Record<string, number[]> = {};

  for (let i = 0; i < teamNames.length; i++) {
    const jitter = JITTER[i % JITTER.length];
    const slots: number[] = baseTeamSlots.map((s) => {
      const raw = s + jitter;
      return Math.max(1, Math.min(durationMinutes - 1, raw));
    });
    teamSlots[teamNames[i]] = slots;

    const cJitter = CHAOS_JITTER[i % CHAOS_JITTER.length];
    const cSlots: number[] = baseTeamSlots.map((s) => {
      const raw = s + cJitter;
      return Math.max(1, Math.min(durationMinutes - 1, raw));
    });
    chaosSlots[teamNames[i]] = cSlots;
  }

  return { universalSlots, teamSlots, chaosSlots };
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
// Phase: Counter Definitions per team (scenario-specific metrics)
// ---------------------------------------------------------------------------

const COUNTER_BEHAVIOR_CATALOG = `BEHAVIOR TYPES (you MUST pick from this list — do NOT invent new ones):

1. "time_rate" — a numeric counter that advances automatically each game tick.
   Config: base_rate_per_min (number), cap_key (key of another counter that is the ceiling),
   requires_flag (key of a boolean counter that must be true before ticking starts),
   robustness_affects (bool — team robustness score modifies rate),
   robustness_low_mult (multiplier when robustness<=4, default 0.25),
   robustness_high_mult (multiplier when robustness>=8, default 1.25),
   congestion_halves (bool — halved when unmanaged congested exits exist),
   impact_sensitive (bool — cross-team impact score modifies rate).

2. "decision_toggle" — a boolean counter flipped to true when a matching player decision is detected.
   Config: keywords (string[]), categories (string[]).

3. "decision_increment" — a numeric counter incremented by 1 each time a matching decision is made.
   Config: keywords (string[]), categories (string[]).

4. "derived" — a numeric counter recomputed each tick from other counters (e.g. patients_waiting = pool - processed).
   Config: source_pool_key (key whose value is the pool), pool_fraction (fraction of pool, e.g. 0.25),
   rate_key (key of a time_rate counter this derives from),
   split_fractions (object mapping output counter keys to fractions, e.g. {"deaths": 0.12, "transported": 0.4}).

5. "state_effect" — changed only by inject state_effects (external events). The engine never auto-updates it.

6. "static" — set at scenario start, never changes (e.g. total_evacuees). Used as caps or reference values.`;

/**
 * Generate scenario-appropriate CounterDefinition[] for each team using AI.
 * For minimal complexity, returns undefined (template-based fallback used instead).
 */
async function generateCounterDefinitions(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<Record<string, CounterDefinition[]> | undefined> {
  if (input.complexity_tier === 'minimal') return undefined;

  onProgress?.('Generating team counter definitions...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const systemPrompt = `You are an expert crisis management scenario designer. You must define the METRICS (counters) that each team will track during a "${scenario_type}" training exercise.

Scenario: ${narrative?.title || scenario_type}
Venue: ${venue}
Setting: ${setting}
Teams: ${teamNames.join(', ')}
${narrative?.description ? `\nDescription: ${narrative.description}` : ''}

${COUNTER_BEHAVIOR_CATALOG}

RULES:
- Each team should have 3–8 counters that are RELEVANT to this specific scenario type and team role.
- Do NOT include counters that don't make sense (e.g. "evacuated_count" for a negotiation team in a kidnapping, or "inner_cordon_radius_m" for a media team).
- Every team MUST have at least one "decision_toggle" counter (a key milestone the team should achieve).
- Teams that manage people/resources over time should have "time_rate" counters.
- Use "static" for fixed reference values (caps, totals).
- Use "derived" for counters computed from others (e.g. patients_waiting = pool - processed).
- visible_to should be "all" for most counters; use "trainer_only" for internal flags players shouldn't see.
- Counter keys must be snake_case, unique within each team.
- Labels should be short, human-readable (e.g. "People Evacuated", "Perimeter Established").
- For decision_toggle and decision_increment, provide realistic keywords that would appear in a player's decision text.

Return ONLY valid JSON:
{
  "counter_definitions": {
    "<team_name>": [
      {
        "key": "snake_case_key",
        "label": "Human Readable Label",
        "type": "number|boolean|enum",
        "initial_value": 0,
        "behavior": "time_rate|decision_toggle|decision_increment|derived|state_effect|static",
        "visible_to": "all|trainer_only",
        "config": { ... }
      }
    ]
  }
}`;

  const userPrompt = `Define counter definitions for each team in "${narrative?.title || scenario_type}" at ${venue}. Teams: ${teamNames.join(', ')}.`;

  try {
    const parsed = await callOpenAi<{
      counter_definitions?: Record<string, CounterDefinition[]>;
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);

    if (!parsed.counter_definitions || typeof parsed.counter_definitions !== 'object') {
      return undefined;
    }

    // Validate: ensure every definition has required fields
    for (const [team, defs] of Object.entries(parsed.counter_definitions)) {
      if (!Array.isArray(defs)) {
        delete parsed.counter_definitions[team];
        continue;
      }
      parsed.counter_definitions[team] = defs
        .filter(
          (d) =>
            d &&
            typeof d.key === 'string' &&
            typeof d.label === 'string' &&
            ['number', 'boolean', 'enum'].includes(d.type) &&
            [
              'time_rate',
              'decision_toggle',
              'decision_increment',
              'derived',
              'state_effect',
              'static',
            ].includes(d.behavior),
        )
        .map((d) => {
          if (d.initial_value != null && typeof d.initial_value === 'object') {
            d.initial_value = d.type === 'number' ? 0 : d.type === 'boolean' ? false : '';
          }
          return d;
        });
    }

    enrichWithStandardDecisionIntentKeys(parsed.counter_definitions, teamNames);

    return Object.keys(parsed.counter_definitions).length > 0
      ? parsed.counter_definitions
      : undefined;
  } catch (err) {
    logger.warn({ err }, 'Counter definitions generation failed; continuing without');
    return undefined;
  }
}

const STANDARD_DECISION_INTENT_KEYS: Record<string, CounterDefinition[]> = {
  evacuation_state: [
    {
      key: 'zone_identification_decided',
      label: 'Zone Identification',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'flow_control_decided',
      label: 'Flow Control Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  triage_state: [
    {
      key: 'prioritisation_decided',
      label: 'Triage Prioritisation Set',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'supply_request_made',
      label: 'Supply Request Made',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'patient_privacy_decided',
      label: 'Patient Privacy Managed',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'perimeter_security_decided',
      label: 'Triage Perimeter Security',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'triage_zone_established',
      label: 'Triage Zone Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  media_state: [
    {
      key: 'first_statement_issued',
      label: 'Public Statement Issued',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
    {
      key: 'spokesperson_designated',
      label: 'Spokesperson Designated',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
  police_state: [
    {
      key: 'perimeter_established',
      label: 'Perimeter Established',
      type: 'boolean',
      initial_value: false,
      behavior: 'decision_toggle',
      visible_to: 'trainer_only',
    },
  ],
};

function teamNameToStateKey(teamName: string): string {
  const lower = teamName.toLowerCase();
  if (lower.includes('evacuation') || lower.includes('evac')) return 'evacuation_state';
  if (lower.includes('triage') || lower.includes('medical') || lower.includes('medic'))
    return 'triage_state';
  if (
    lower.includes('media') ||
    lower.includes('comms') ||
    lower.includes('communication') ||
    lower.includes('public')
  )
    return 'media_state';
  if (lower.includes('police') || lower.includes('security') || lower.includes('law'))
    return 'police_state';
  if (lower.includes('fire') || lower.includes('hazard') || lower.includes('hazmat'))
    return 'fire_state';
  return lower.replace(/[\s-]+/g, '_') + '_state';
}

function enrichWithStandardDecisionIntentKeys(
  counterDefs: Record<string, CounterDefinition[]>,
  teamNames: string[],
): void {
  for (const teamName of teamNames) {
    const stateKey = teamNameToStateKey(teamName);
    const standardKeys = STANDARD_DECISION_INTENT_KEYS[stateKey];
    if (!standardKeys) continue;

    if (!counterDefs[teamName]) counterDefs[teamName] = [];

    const existingKeys = new Set(counterDefs[teamName].map((d) => d.key));
    for (const def of standardKeys) {
      if (!existingKeys.has(def.key)) {
        counterDefs[teamName].push(def);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4a-1 — Scenario-Fixed Pins  (incident, exits, cordons — anchored to building outline)
// ---------------------------------------------------------------------------

async function generateScenarioFixedPins(
  input: WarroomGenerateInput,
  teamNames: string[],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['locations']> {
  if (input.complexity_tier === 'minimal') return undefined;

  onProgress?.('Generating scenario-fixed map pins...');

  const { scenario_type, setting, terrain, venue_name, location, geocode, osmBuildings } = input;
  const venue = venue_name || location || setting;
  const coords = geocode
    ? `Venue geocode (approximate center of the venue — NOT necessarily the incident location): ${geocode.lat}, ${geocode.lng}`
    : '';

  let buildingBlock = '';
  if (osmBuildings && osmBuildings.length > 0) {
    const lines = osmBuildings.map((b, i) => {
      const nameStr = b.name ? `"${b.name}"` : '(unnamed)';
      const boundsStr = b.bounds
        ? `spans [${b.bounds.minlat.toFixed(5)},${b.bounds.minlon.toFixed(5)}] to [${b.bounds.maxlat.toFixed(5)},${b.bounds.maxlon.toFixed(5)}]`
        : `center [${b.lat.toFixed(5)},${b.lng.toFixed(5)}]`;
      return `  ${i + 1}. ${nameStr} — ${boundsStr}, ${b.distance_from_center_m}m from incident`;
    });
    buildingBlock = `\nREAL BUILDING OUTLINES (from OpenStreetMap — use these to place exit pins at the actual building perimeter):\n${lines.join('\n')}`;
  }

  const narrativeBlock = narrative
    ? `\n\nSCENARIO NARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer placing scenario-fixed pins on a real map.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${coords}
${buildingBlock}
${narrativeBlock}

Generate SCENARIO-FIXED pins: the incident site and all potential entry/exit points at the venue.

IMPORTANT: Before generating pins, read the scenario narrative carefully to determine WHERE the incident actually occurs within the venue. The venue geocode is just the approximate center of the venue — the actual incident may be in a car park, a specific wing, an outdoor area, or any sub-location described in the narrative. Place pins relative to the ACTUAL incident location, not the venue center.

PIN CATEGORIES (only these two):
- incident_site (1 pin): Determine the EXACT crisis location from the scenario narrative. If the narrative describes an incident at a specific part of the venue (e.g. "car bomb in the car park", "explosion on the runway", "fire in the loading dock", "shooting in the lobby"), place the pin at THAT specific location — not at the main building center. Use the building outlines to identify which structure or area matches the narrative. Only default to the main building center if the narrative does not specify a sub-location within the venue.
- entry_exit (4-8 pins): ALL potential entry/exit points at the venue that response teams could use. These are NEUTRAL — teams will claim them during gameplay. Include building exits, service entrances, loading docks, emergency exits, vehicle access gates, pedestrian paths. For building incidents: place at the building perimeter where doors meet roads or open areas. For outdoor incidents: place at vehicle exits, pedestrian gates, or emergency paths. If building bounds are provided, place exit coordinates ON or VERY NEAR the building boundary edges.

CONDITIONS per pin type:
- entry_exit: { width_m, surface, capacity_flow_per_min, is_blocked, lighting, accessibility, distance_from_incident_m, exit_type (e.g. "double_door", "loading_dock", "vehicle_gate", "emergency_exit", "pedestrian_path"), notes }
- incident_site: { area_m2, structural_damage, hazards[], accessibility, casualty_density, notes }

Do NOT generate hospital, police station, fire station, candidate-space, or cordon pins. Cordons are placed by players during gameplay.

SPATIAL RULES:
- Incident site pins: first read the scenario narrative to determine WHERE exactly the incident occurs, then place the pin at that specific location. This may be inside a building, in a car park, on an airfield, at a loading dock, or any location described in the briefing — do NOT default to the main building center.
- Entry/exit pins: MUST be at real building exits, gates, or access paths. NOT floating in open space away from any structure.
- All coordinates must be realistic for the venue geography

Return ONLY valid JSON:
{ "locations": [ { "location_type": "string", "pin_category": "string", "description": "string", "label": "string (max 5 words)", "coordinates": { "lat": 0.0, "lng": 0.0 }, "conditions": {}, "display_order": 1 } ] }`;

  const userPrompt = `Place scenario-fixed pins (incident site + all entry/exit points) for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{ locations?: WarroomScenarioPayload['locations'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      2000,
    );
    return parsed.locations?.length ? parsed.locations : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4a-1 scenario-fixed pins failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Post-processing — validate pin spatial topology
// ---------------------------------------------------------------------------

function validatePinTopology(
  pins: NonNullable<WarroomScenarioPayload['locations']>,
  incidentCenter?: { lat: number; lng: number },
  osmOpenSpaces?: OsmOpenSpace[],
): NonNullable<WarroomScenarioPayload['locations']> {
  if (!incidentCenter || pins.length === 0) return pins;

  // Compute distance_from_incident_m for every pin
  for (const pin of pins) {
    const dist = Math.round(
      haversineDistance(
        incidentCenter.lat,
        incidentCenter.lng,
        pin.coordinates.lat,
        pin.coordinates.lng,
      ),
    );
    if (!pin.conditions) pin.conditions = {};
    if (pin.conditions.distance_from_incident_m == null) {
      pin.conditions.distance_from_incident_m = dist;
    }
  }

  // Find the outermost exit pin distance
  let maxExitDist = 0;
  for (const pin of pins) {
    const cat = pin.pin_category || (pin.conditions?.pin_category as string);
    if (cat === 'access') {
      const d = pin.conditions?.distance_from_incident_m as number;
      if (d > maxExitDist) maxExitDist = d;
    }
  }

  // Validate candidate spaces are further than exits
  let topologyWarnings = 0;
  for (const pin of pins) {
    const cat = pin.pin_category || (pin.conditions?.pin_category as string);
    if (cat !== 'candidate_space') continue;
    const d = pin.conditions?.distance_from_incident_m as number;
    if (maxExitDist > 0 && d < maxExitDist) {
      topologyWarnings++;
    }
  }
  if (topologyWarnings > 0) {
    logger.warn(
      { count: topologyWarnings, maxExitDist },
      'Candidate spaces closer to incident than outermost exit — topology violation',
    );
  }

  // Validate candidate space coordinates match an OSM open space within 50m
  if (osmOpenSpaces && osmOpenSpaces.length > 0) {
    let matchCount = 0;
    let missCount = 0;
    for (const pin of pins) {
      const cat = pin.pin_category || (pin.conditions?.pin_category as string);
      if (cat !== 'candidate_space') continue;
      const matched = osmOpenSpaces.some(
        (s) => haversineDistance(pin.coordinates.lat, pin.coordinates.lng, s.lat, s.lng) < 50,
      );
      if (matched) matchCount++;
      else missCount++;
    }
    logger.info(
      { matched: matchCount, unmatched: missCount },
      'Candidate space OSM coordinate matching',
    );
  }

  return pins;
}

// ---------------------------------------------------------------------------
// Phase 4a-POI — Generate POI pins from OSM data with AI-enriched conditions
// ---------------------------------------------------------------------------

interface PoiStub {
  location_type: 'hospital' | 'police_station' | 'fire_station';
  pin_category: 'poi';
  label: string;
  coordinates: { lat: number; lng: number };
  distance_from_incident_m: number;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function generatePoiPinsFromOsm(
  osmVicinity: OsmVicinity | undefined,
  scenarioType: string,
  venue: string,
  incidentCoords: { lat: number; lng: number } | undefined,
  openAiApiKey: string,
): Promise<NonNullable<WarroomScenarioPayload['locations']>> {
  if (!osmVicinity) return [];

  const stubs: PoiStub[] = [];
  const center = incidentCoords ?? osmVicinity.center ?? { lat: 0, lng: 0 };

  for (const h of osmVicinity.hospitals ?? []) {
    stubs.push({
      location_type: 'hospital',
      pin_category: 'poi',
      label: h.name || 'Hospital',
      coordinates: { lat: h.lat, lng: h.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, h.lat, h.lng)),
    });
  }
  for (const p of osmVicinity.police ?? []) {
    stubs.push({
      location_type: 'police_station',
      pin_category: 'poi',
      label: p.name || 'Police Station',
      coordinates: { lat: p.lat, lng: p.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, p.lat, p.lng)),
    });
  }
  for (const f of osmVicinity.fire_stations ?? []) {
    stubs.push({
      location_type: 'fire_station',
      pin_category: 'poi',
      label: f.name || 'Fire Station',
      coordinates: { lat: f.lat, lng: f.lng },
      distance_from_incident_m: Math.round(haversineDistance(center.lat, center.lng, f.lat, f.lng)),
    });
  }

  if (stubs.length === 0) return [];

  const POI_CAPS: Record<string, number> = { hospital: 5, police_station: 3, fire_station: 3 };
  const byType: Record<string, PoiStub[]> = {};
  for (const s of stubs) {
    (byType[s.location_type] ??= []).push(s);
  }
  const capped: PoiStub[] = [];
  for (const [type, items] of Object.entries(byType)) {
    items.sort((a, b) => a.distance_from_incident_m - b.distance_from_incident_m);
    capped.push(...items.slice(0, POI_CAPS[type] ?? 5));
  }
  capped.sort((a, b) => a.distance_from_incident_m - b.distance_from_incident_m);
  const cappedStubs = capped;

  const stubSummary = cappedStubs
    .map(
      (s, i) =>
        `${i + 1}. [${s.location_type}] "${s.label}" — ${s.distance_from_incident_m}m from incident`,
    )
    .join('\n');

  const systemPrompt = `You are an expert in emergency facility capabilities. Given a list of real facilities near a ${scenarioType} incident at ${venue}, estimate realistic operational conditions for each.

Facilities:
${stubSummary}

For each facility (by index), return conditions as JSON:

For hospitals: { facility_type: "tertiary_hospital"|"general_hospital"|"community_hospital"|"clinic", trauma_center_level?: "Level 1"|"Level 2"|"Level 3", bed_capacity: number, emergency_beds_available: number, has_helipad: boolean, ambulance_bays: number, specializations: string[], estimated_response_time_min: number, notes: string }

For police_station: { facility_type: "division_hq"|"district_station"|"neighbourhood_post"|"tactical_base", available_officers_estimate: number, has_tactical_unit: boolean, has_k9_unit: boolean, has_negotiation_team: boolean, estimated_response_time_min: number, notes: string }

For fire_station: { facility_type: "headquarters"|"standard_station"|"substation", appliance_count: number, has_hazmat_unit: boolean, has_rescue_unit: boolean, has_aerial_platform: boolean, estimated_response_time_min: number, notes: string }

ENVIRONMENTAL CHALLENGES:
For each facility, also generate an "environmental_challenges" array with 0-2 realistic operational challenges that responders would face. NOT every facility has a problem — leave the array empty for facilities with no issues (at least half should have none). Challenges make the scenario more realistic and test player adaptability.

Challenge types: "traffic_congestion", "at_capacity", "power_outage", "road_closure", "equipment_shortage", "structural_damage", "staffing_shortage", "communication_failure"

Each challenge: { challenge_type: string, description: string (1-2 sentences, specific and actionable), severity: "high"|"medium"|"low", affected_route?: string (if traffic/road related), alternative?: string (workaround hint, e.g. alternate route name) }

Examples:
- Hospital closest to incident: { challenge_type: "traffic_congestion", description: "Main access via Bayfront Avenue is gridlocked due to emergency vehicle convergence and fleeing pedestrians.", severity: "high", affected_route: "Bayfront Avenue", alternative: "Approach via Sheares Avenue from the south" }
- Hospital at capacity: { challenge_type: "at_capacity", description: "Emergency department already handling mass casualty patients from a separate industrial accident. Only 3 trauma bays available.", severity: "medium" }
- Fire station with equipment issue: { challenge_type: "equipment_shortage", description: "Primary aerial platform undergoing maintenance. Only ground-level appliances available.", severity: "low" }

Return ONLY valid JSON: { "facilities": [ { "index": 1, "conditions": { ..., "environmental_challenges": [...] } } ] }
Base response times on distance. Use the facility name to infer size/capabilities where possible.`;

  try {
    const parsed = await callOpenAi<{
      facilities?: Array<{ index: number; conditions: Record<string, unknown> }>;
    }>(
      systemPrompt,
      `Enrich ${cappedStubs.length} facilities for a ${scenarioType} response.`,
      openAiApiKey,
      6000,
    );

    const enriched = parsed.facilities ?? [];
    const conditionsMap = new Map<number, Record<string, unknown>>();
    for (const f of enriched) {
      if (typeof f.index === 'number' && f.conditions) {
        conditionsMap.set(f.index, f.conditions);
      }
    }

    return cappedStubs.map((stub, i) => {
      const aiConditions = conditionsMap.get(i + 1) ?? {};
      return {
        location_type: stub.location_type,
        pin_category: stub.pin_category as string,
        label: stub.label,
        description: `${stub.location_type.replace(/_/g, ' ')} — ${stub.distance_from_incident_m}m from incident`,
        coordinates: stub.coordinates,
        conditions: {
          distance_from_incident_m: stub.distance_from_incident_m,
          ...aiConditions,
        },
        display_order: 100 + i,
      };
    });
  } catch (err) {
    logger.warn(
      { err, count: cappedStubs.length },
      'POI enrichment failed; using stubs with distance only',
    );
    return cappedStubs.map((stub, i) => ({
      location_type: stub.location_type,
      pin_category: stub.pin_category as string,
      label: stub.label,
      description: `${stub.location_type.replace(/_/g, ' ')} — ${stub.distance_from_incident_m}m from incident`,
      coordinates: stub.coordinates,
      conditions: { distance_from_incident_m: stub.distance_from_incident_m },
      display_order: 100 + i,
    }));
  }
}

// ---------------------------------------------------------------------------
// Phase 4b — Route Network (corridor computation + AI enrichment)
// ---------------------------------------------------------------------------

interface RouteCorridor {
  route_id: string;
  label: string;
  highway_type: string;
  one_way: boolean;
  geometry: [number, number][];
  distance_m: number;
  baseline_travel_min: number;
  connects_to: string[];
}

const HIGHWAY_SPEED_KPH: Record<string, number> = {
  motorway: 80,
  trunk: 60,
  primary: 50,
  secondary: 40,
  tertiary: 30,
  residential: 20,
  unclassified: 25,
};

function polylineLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += geoHaversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Deterministic corridor computation: link OSM road polylines to nearby
 * facilities (hospitals, police, fire) and the incident site.
 */
function computeRouteCorridors(
  routeGeometries: OsmRouteGeometry[],
  facilities: Array<{
    label: string;
    coordinates: { lat: number; lng: number };
    location_type: string;
  }>,
  incidentCoords: { lat: number; lng: number },
): RouteCorridor[] {
  const PROXIMITY_THRESHOLD_M = 400;
  const corridors: RouteCorridor[] = [];
  const seenIds = new Set<string>();

  for (const route of routeGeometries) {
    if (!route.coordinates?.length || route.coordinates.length < 2) continue;

    const routeId = slugify(route.name);
    if (seenIds.has(routeId)) continue;
    seenIds.add(routeId);

    const nearIncident = route.coordinates.some(
      ([lat, lng]) =>
        geoHaversineM(lat, lng, incidentCoords.lat, incidentCoords.lng) < PROXIMITY_THRESHOLD_M,
    );
    if (!nearIncident) continue;

    const connectsTo: string[] = [];
    for (const facility of facilities) {
      const nearFacility = route.coordinates.some(
        ([lat, lng]) =>
          geoHaversineM(lat, lng, facility.coordinates.lat, facility.coordinates.lng) <
          PROXIMITY_THRESHOLD_M,
      );
      if (nearFacility) connectsTo.push(facility.label);
    }

    const lengthM = polylineLength(route.coordinates);
    const speedKph = HIGHWAY_SPEED_KPH[route.highway_type] ?? 30;
    const travelMin = Math.round((lengthM / 1000 / speedKph) * 60 * 10) / 10;

    const suffix = connectsTo.length > 0 ? ` – toward ${connectsTo[0]}` : '';
    corridors.push({
      route_id: routeId,
      label: `${route.name}${suffix}`,
      highway_type: route.highway_type,
      one_way: route.one_way,
      geometry: route.coordinates,
      distance_m: Math.round(lengthM),
      baseline_travel_min: Math.max(1, travelMin),
      connects_to: connectsTo,
    });
  }

  corridors.sort((a, b) => a.baseline_travel_min - b.baseline_travel_min);
  return corridors.slice(0, 12);
}

/**
 * AI enrichment: assign traffic conditions to route corridors and return
 * them as scenario_locations rows (location_type = 'route', pin_category = 'route').
 */
async function enrichRouteLocations(
  input: WarroomGenerateInput,
  corridors: RouteCorridor[],
  facilities: Array<{ label: string; location_type: string; conditions?: Record<string, unknown> }>,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['locations']> {
  if (corridors.length === 0) return undefined;

  onProgress?.('Enriching route network with traffic conditions...');

  const { scenario_type, venue_name, location, setting } = input;
  const venue = venue_name || location || setting;

  const corridorSummary = corridors
    .map(
      (c, i) =>
        `${i + 1}. "${c.label}" [route_id: "${c.route_id}"] (${c.highway_type}, ${c.distance_m}m, ~${c.baseline_travel_min} min)${c.one_way ? ' [one-way]' : ''}${c.connects_to.length > 0 ? ` → connects to: ${c.connects_to.join(', ')}` : ''}`,
    )
    .join('\n');

  const facilitySummary = facilities
    .filter((f) => f.location_type === 'hospital')
    .map((f) => {
      const conds = f.conditions as Record<string, unknown> | undefined;
      const beds = conds?.emergency_beds_available ?? '?';
      return `- ${f.label} (${beds} emergency beds)`;
    })
    .join('\n');

  const systemPrompt = `You are an expert in urban traffic management during crisis incidents. Given real road corridors near a ${scenario_type} incident at ${venue}, assign realistic traffic conditions to each route.

ROAD CORRIDORS (computed from real OpenStreetMap data):
${corridorSummary}

HOSPITALS:
${facilitySummary}

SCENARIO: ${narrative?.title ?? scenario_type} — ${narrative?.description ?? ''}

For each route, assign a condition. Not every route has a problem — at least half should be clear.
Problems must be specific and scenario-appropriate (not generic). Reference real road names.

Return ONLY valid JSON:
{
  "routes": [
    {
      "route_id": "string (use the exact route_id from input)",
      "label": "string (use the exact label from input)",
      "travel_time_minutes": number (baseline if clear, inflated 2-4x if congested, null if impassable),
      "problem": null or "string describing the specific issue (e.g. 'Multi-vehicle accident blocking 2 lanes', 'Emergency vehicle convergence causing gridlock')",
      "managed": boolean (true if clear, false if problem exists),
      "connects_to": ["facility labels this road passes near"],
      "is_optimal_for": ["facility labels this is the best route to"]
    }
  ]
}`;

  const userPrompt = `Assign traffic conditions for "${narrative?.title || scenario_type}" at ${venue}. ${corridors.length} routes to enrich.`;

  try {
    const parsed = await callOpenAi<{
      routes?: Array<{
        route_id: string;
        label: string;
        travel_time_minutes: number | null;
        problem: string | null;
        managed: boolean;
        connects_to?: string[];
        is_optimal_for?: string[];
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 3000);

    if (!parsed.routes?.length) {
      logger.warn('Route enrichment AI returned no routes; using corridor stubs');
      return corridors.map((c, i) => corridorToLocation(c, i));
    }

    const corridorMap = new Map(corridors.map((c) => [c.route_id, c]));

    return parsed.routes.map((r, i) => {
      const corridor = corridorMap.get(r.route_id);
      const midpoint = corridor
        ? corridor.geometry[Math.floor(corridor.geometry.length / 2)]
        : [0, 0];
      return {
        location_type: 'route',
        pin_category: 'route',
        label: r.label || corridor?.label || 'Route',
        description: r.problem || 'Clear route',
        coordinates: { lat: midpoint[0], lng: midpoint[1] },
        conditions: {
          route_id: r.route_id,
          highway_type: corridor?.highway_type,
          one_way: corridor?.one_way ?? false,
          distance_m: corridor?.distance_m,
          baseline_travel_min: corridor?.baseline_travel_min,
          travel_time_minutes: r.travel_time_minutes,
          problem: r.problem,
          managed: r.managed,
          connects_to: r.connects_to ?? corridor?.connects_to ?? [],
          is_optimal_for: r.is_optimal_for ?? [],
          geometry: corridor?.geometry,
        },
        display_order: 200 + i,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Route enrichment failed; using corridor stubs');
    return corridors.map((c, i) => corridorToLocation(c, i));
  }
}

function corridorToLocation(
  c: RouteCorridor,
  i: number,
): NonNullable<WarroomScenarioPayload['locations']>[number] {
  const midpoint = c.geometry[Math.floor(c.geometry.length / 2)] ?? [0, 0];
  return {
    location_type: 'route',
    pin_category: 'route',
    label: c.label,
    description: `${c.highway_type} road — ${c.distance_m}m`,
    coordinates: { lat: midpoint[0], lng: midpoint[1] },
    conditions: {
      route_id: c.route_id,
      highway_type: c.highway_type,
      one_way: c.one_way,
      distance_m: c.distance_m,
      baseline_travel_min: c.baseline_travel_min,
      travel_time_minutes: c.baseline_travel_min,
      problem: null,
      managed: true,
      connects_to: c.connects_to,
      is_optimal_for: [],
      geometry: c.geometry,
    },
    display_order: 200 + i,
  };
}

// ---------------------------------------------------------------------------
// Phase 4b2 — Step 1: Hazard Identification  (2 500 tokens)
// ---------------------------------------------------------------------------

async function generateScenarioHazards(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  teamNames?: string[],
): Promise<WarroomScenarioPayload['hazards']> {
  const includeHazards = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeHazards) return undefined;

  onProgress?.('Identifying hazards (step 1)...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const incidentSites =
    locations?.filter(
      (l) =>
        l.pin_category === 'incident_site' ||
        l.location_type.toLowerCase().includes('blast') ||
        l.location_type.toLowerCase().includes('epicentre'),
    ) ?? [];

  const incidentBlock =
    incidentSites.length > 0
      ? `Incident sites:\n${incidentSites.map((s) => `- ${s.label} at (${s.coordinates.lat}, ${s.coordinates.lng})`).join('\n')}`
      : '';

  const systemPrompt = `You are an expert crisis management scenario designer identifying hazards for a realistic training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title}\nDescription: ${narrative.description}\nBriefing: ${narrative.briefing || ''}` : ''}
${incidentBlock}
Teams available: ${(teamNames ?? []).join(', ') || 'not specified'}

Research the venue and scenario type to identify ALL realistic hazards that would result from this incident. Consider:
- What materials are at this venue? (gas lines in restaurants/kitchens, glass facades, chemical storage, fuel in parking areas, flammable materials in shops, electrical systems)
- What structural damage would this incident type cause? (blast radius, fire spread, collapse zones, shrapnel patterns)
- What secondary hazards would develop? (gas leaks from ruptured lines, electrical fires, flooding from burst water mains, smoke in enclosed spaces)
- What infrastructure is compromised? (elevators, stairwells, fire suppression systems, emergency lighting)

Generate 8-15 hazards. Each hazard is a DISTINCT danger at a SPECIFIC location. More hazards create a richer, more interactive environment for teams to coordinate.

Return ONLY valid JSON:
{
  "hazards": [
    {
      "hazard_type": "fire|chemical_spill|structural_collapse|debris|gas_leak|flood|biological|explosion|electrical|smoke",
      "location_lat": number,
      "location_lng": number,
      "floor_level": "G",
      "properties": {
        "size": "small|medium|large",
        "fuel_source": "what is burning/leaking/collapsed",
        "adjacent_risks": ["risk1", "risk2"],
        "wind_exposure": true/false,
        "casualties_visible": number,
        "access_blocked": true/false,
        "venue_material_context": "what venue-specific materials are involved"
      },
      "assessment_criteria": ["criteria1", "criteria2"],
      "status": "active",
      "appears_at_minutes": 0
    }
  ]
}

RULES:
- Hazards must be near or at the incident sites (within 300m)
- At least 4 immediate hazards (appears_at_minutes: 0) and 4+ delayed hazards (appear as situation develops at different times)
- Include venue-specific material detail in properties.fuel_source and venue_material_context
- Vary hazard types — not all fires; include structural, debris, gas, smoke as appropriate
- Locations must be realistic coordinates near the incident sites`;

  const userPrompt = `Identify all hazards from "${narrative?.title || scenario_type}" at ${venue}. Research what materials and infrastructure exist at this type of venue.`;

  try {
    const parsed = await callOpenAi<{
      hazards?: WarroomScenarioPayload['hazards'];
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);
    const stubs = parsed.hazards?.length ? parsed.hazards : undefined;
    if (!stubs?.length) return undefined;

    onProgress?.(`Enriching ${stubs.length} hazards in parallel (step 2)...`);
    const enriched = await Promise.all(
      stubs.map((h) => enrichHazardDetail(h, input, openAiApiKey, narrative, teamNames)),
    );
    return enriched;
  } catch (err) {
    logger.warn({ err }, 'Hazard identification failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2 — Step 2: Deep Hazard Enrichment  (5 000 tokens each, parallel)
// ---------------------------------------------------------------------------

async function enrichHazardDetail(
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  input: WarroomGenerateInput,
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  teamNames?: string[],
): Promise<NonNullable<WarroomScenarioPayload['hazards']>[number]> {
  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const hazardContext = `Scenario: ${scenario_type} at ${venue}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
Hazard type: ${hazard.hazard_type}
Location: (${hazard.location_lat}, ${hazard.location_lng}), floor ${hazard.floor_level}
Size: ${(hazard.properties as Record<string, unknown>).size || 'unknown'}
Fuel/source: ${(hazard.properties as Record<string, unknown>).fuel_source || 'unknown'}
Adjacent risks: ${JSON.stringify((hazard.properties as Record<string, unknown>).adjacent_risks || [])}
Teams available: ${(teamNames ?? []).join(', ') || 'not specified'}`;

  // Run three focused calls in parallel (zones are now unified per-incident, not per-hazard)
  const [descResult, reqsResult, deteriorationResult] = await Promise.all([
    enrichHazardDescription(hazardContext, hazard, venue, openAiApiKey),
    enrichHazardRequirements(hazardContext, hazard, venue, openAiApiKey),
    enrichHazardDeterioration(hazardContext, hazard, venue, openAiApiKey),
  ]);

  return {
    ...hazard,
    enriched_description: descResult.enriched_description ?? undefined,
    fire_class: descResult.fire_class ?? undefined,
    debris_type: descResult.debris_type ?? undefined,
    resolution_requirements: reqsResult.resolution_requirements ?? {},
    personnel_requirements: reqsResult.personnel_requirements ?? {},
    equipment_requirements: reqsResult.equipment_requirements ?? [],
    deterioration_timeline: deteriorationResult.deterioration_timeline ?? {},
    zones: [],
  };
}

// Sub-call 1: Description, fire class, debris type
async function enrichHazardDescription(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{ enriched_description?: string; fire_class?: string; debris_type?: string }> {
  const systemPrompt = `You are an expert hazard assessment specialist. Describe this hazard in vivid, realistic detail.

${hazardContext}

Provide:
1. ENRICHED DESCRIPTION: A detailed paragraph (200+ words) describing the hazard condition — what it looks like, smells like, sounds like. What a responder approaching would see. Include venue-specific materials (gas lines, glass facades, chemical storage, fuel tanks, electrical systems).
2. FIRE CLASS (if fire): A (ordinary combustibles), B (flammable liquids/gases), C (electrical), D (metals), K (cooking oils). null if not a fire.
3. DEBRIS TYPE (if structural/collapse): concrete, steel, glass, wood, mixed. null if not debris/collapse.

Return ONLY valid JSON:
{
  "enriched_description": "detailed paragraph...",
  "fire_class": "A|B|C|D|K" or null,
  "debris_type": "concrete|steel|glass|wood|mixed" or null
}`;

  try {
    return await callOpenAi<{
      enriched_description?: string;
      fire_class?: string;
      debris_type?: string;
    }>(
      systemPrompt,
      `Describe the ${hazard.hazard_type} hazard at ${venue} in vivid detail.`,
      openAiApiKey,
      2000,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard description enrichment failed');
    return {};
  }
}

// Sub-call 2: Resolution, personnel, and equipment requirements
async function enrichHazardRequirements(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{
  resolution_requirements?: Record<string, unknown>;
  personnel_requirements?: Record<string, unknown>;
  equipment_requirements?: Array<Record<string, unknown>>;
}> {
  const systemPrompt = `You are an expert in emergency response requirements. Determine the EXACT personnel, equipment, and procedures needed to resolve this hazard.

${hazardContext}

You MUST fill out ALL three requirement sections. Be specific about quantities and types.

Return ONLY valid JSON:
{
  "resolution_requirements": {
    "personnel_type": "firefighter|hazmat_specialist|structural_engineer|paramedic|bomb_technician|etc.",
    "personnel_count": <number, minimum needed>,
    "equipment": ["specific_item_1", "specific_item_2", "specific_item_3"],
    "approach_method": "describe the correct approach/containment method",
    "estimated_time_minutes": <number>,
    "requires_external": <true if none of the exercise teams can handle it>,
    "external_resource": "<what external resource>" or null,
    "safety_precautions": ["precaution1", "precaution2"]
  },
  "personnel_requirements": {
    "primary_responder": "role name",
    "minimum_count": <number>,
    "specialist_needed": <true/false>,
    "specialist_type": "type" or null,
    "support_roles": ["role1", "role2"]
  },
  "equipment_requirements": [
    { "equipment_type": "internal_id", "label": "Human readable name", "quantity": <number>, "critical": <true if essential>, "applicable_teams": ["team_name_1", "team_name_2"] },
    { "equipment_type": "another_item", "label": "Display name", "quantity": <number>, "critical": <true/false>, "applicable_teams": ["team_name"] }
  ]
}

IMPORTANT:
- equipment_requirements MUST contain at least 2 items. Be specific — not just "fire_extinguisher" but the correct type (foam, CO2, dry chemical, etc.) for this hazard.
- ALWAYS include the personal protective equipment (PPE) that responders MUST wear when approaching this hazard. Examples: breathing_apparatus, hazmat_suit, fire_protective_gear, safety_vest, helmet, ppe_medical, chemical_gloves, face_shield. Mark PPE items as critical: true.
- safety_precautions should list procedural safety steps (e.g. "establish exclusion zone", "approach from upwind").
- applicable_teams: assign each equipment item ONLY to the team(s) trained to use it. Use the EXACT team names from "Teams available" above. Rules:
  - Fire-fighting gear (turnout gear, hose, foam units, fire extinguishers) → fire/hazmat team only
  - HAZMAT PPE (hazmat_suit, breathing_apparatus, chemical_gloves) → fire/hazmat team only
  - Medical equipment (defibrillator, iv_kit, burn_kit, splint, oxygen) → triage/medical team only
  - Medical PPE (ppe_medical, surgical gloves, face_shield for patient care) → triage/medical team only
  - Rescue/extrication tools (cutting_tools, hydraulic_jack, stretcher, spinal_board) → evacuation team AND triage team
  - General safety items (safety_vest, helmet) → any team that operates in the hazard zone
  - If unsure, assign to the team whose real-world role would use that equipment`;

  try {
    return await callOpenAi<{
      resolution_requirements?: Record<string, unknown>;
      personnel_requirements?: Record<string, unknown>;
      equipment_requirements?: Array<Record<string, unknown>>;
    }>(
      systemPrompt,
      `What personnel, equipment, and procedures are needed to resolve this ${hazard.hazard_type} at ${venue}?`,
      openAiApiKey,
      2000,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard requirements enrichment failed');
    return {};
  }
}

// Sub-call 3: Deterioration timeline
async function enrichHazardDeterioration(
  hazardContext: string,
  hazard: NonNullable<WarroomScenarioPayload['hazards']>[number],
  venue: string,
  openAiApiKey: string,
): Promise<{ deterioration_timeline?: Record<string, unknown> }> {
  const systemPrompt = `You are an expert in hazard progression and deterioration. Predict what happens if this hazard is NOT addressed over time.

${hazardContext}

Describe the realistic, cascading deterioration of this hazard at three time checkpoints. Consider venue-specific materials, structural integrity, and secondary effects.

Return ONLY valid JSON:
{
  "deterioration_timeline": {
    "at_10min": "detailed description of state after 10 minutes unaddressed — what has changed, spread, worsened",
    "at_20min": "detailed description after 20 minutes — escalation, secondary effects beginning",
    "at_30min": "detailed description after 30 minutes — critical stage, cascading failures",
    "spawns_new_hazards": <true/false>,
    "new_hazard_description": "what new hazard(s) would appear and where" or null,
    "spawns_casualties": <true/false>,
    "estimated_new_casualties": <number>,
    "new_casualty_injury_types": ["burn", "smoke_inhalation", "crush", "laceration", etc.]
  }
}`;

  try {
    return await callOpenAi<{
      deterioration_timeline?: Record<string, unknown>;
    }>(
      systemPrompt,
      `What happens if this ${hazard.hazard_type} at ${venue} is left unaddressed for 30 minutes?`,
      openAiApiKey,
      1500,
    );
  } catch (err) {
    logger.warn({ err, hazardType: hazard.hazard_type }, 'Hazard deterioration enrichment failed');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Zone polygon computation — snap radii to building footprints
// ---------------------------------------------------------------------------

interface ZoneWithPolygon {
  zone_type: string;
  radius_m: number;
  polygon: [number, number][];
  ppe_required: string[];
  allowed_teams: string[];
  activities: string[];
}

/**
 * Convert radius-based zones into polygon-based zones.
 * Hot zone: building footprint if available, else circle polygon.
 * Warm zone: scaled building footprint, else circle polygon.
 * Cold zone: always circle polygon.
 */
function computeZonePolygons(
  hazardLat: number,
  hazardLng: number,
  zones: Array<{
    zone_type: string;
    radius_m: number;
    ppe_required: string[];
    allowed_teams: string[];
    activities: string[];
  }>,
  osmBuildings?: OsmBuilding[],
): ZoneWithPolygon[] {
  let bestFootprint: [number, number][] | undefined;

  if (osmBuildings?.length) {
    for (const b of osmBuildings) {
      if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;
      if (pointInPolygon(hazardLat, hazardLng, b.footprint_polygon)) {
        bestFootprint = b.footprint_polygon;
        break;
      }
    }
    if (!bestFootprint) {
      let minDist = Infinity;
      for (const b of osmBuildings) {
        if (!b.footprint_polygon || b.footprint_polygon.length < 3) continue;
        const d = geoHaversineM(hazardLat, hazardLng, b.lat, b.lng);
        if (d < minDist) {
          minDist = d;
          bestFootprint = b.footprint_polygon;
        }
      }
      const hotZone = zones.find((z) => z.zone_type === 'hot');
      if (bestFootprint && minDist > (hotZone?.radius_m ?? 50) * 0.5) {
        bestFootprint = undefined;
      }
    }
  }

  const sorted = [...zones].sort((a, b) => a.radius_m - b.radius_m);
  const hotRadius =
    sorted.find((z) => z.zone_type === 'hot')?.radius_m ?? sorted[0]?.radius_m ?? 50;

  return sorted.map((z) => {
    let polygon: [number, number][];

    if (z.zone_type === 'hot' && bestFootprint) {
      polygon = [...bestFootprint];
      if (
        polygon.length > 1 &&
        (polygon[0][0] !== polygon[polygon.length - 1][0] ||
          polygon[0][1] !== polygon[polygon.length - 1][1])
      ) {
        polygon.push(polygon[0]);
      }
    } else if (z.zone_type === 'warm' && bestFootprint) {
      const [cLat, cLng] = polygonCentroid(bestFootprint);
      const scale = z.radius_m / Math.max(hotRadius, 1);
      polygon = scalePolygonFromCentroid(bestFootprint, cLat, cLng, scale);
      if (
        polygon.length > 1 &&
        (polygon[0][0] !== polygon[polygon.length - 1][0] ||
          polygon[0][1] !== polygon[polygon.length - 1][1])
      ) {
        polygon.push(polygon[0]);
      }
    } else {
      polygon = circleToPolygon(hazardLat, hazardLng, z.radius_m);
    }

    return {
      zone_type: z.zone_type,
      radius_m: z.radius_m,
      polygon,
      ppe_required: z.ppe_required,
      allowed_teams: z.allowed_teams,
      activities: z.activities,
    };
  });
}

// ---------------------------------------------------------------------------
// Unified Incident Zones — ONE set of hot/warm/cold for the entire incident
// ---------------------------------------------------------------------------

async function generateUnifiedIncidentZones(
  input: WarroomGenerateInput,
  hazards: NonNullable<WarroomScenarioPayload['hazards']>,
  openAiApiKey: string,
  teamNames: string[],
  onProgress?: WarroomAiProgressCallback,
): Promise<ZoneWithPolygon[]> {
  onProgress?.('Generating unified incident zones (hot/warm/cold)...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const hazardSummary = hazards
    .map(
      (h) =>
        `- ${h.hazard_type} (${(h.properties as Record<string, unknown>).size || 'medium'}) at (${h.location_lat}, ${h.location_lng}): ${(h.properties as Record<string, unknown>).fuel_source || h.hazard_type}`,
    )
    .join('\n');

  const incidentLat = hazards.reduce((s, h) => s + Number(h.location_lat), 0) / hazards.length;
  const incidentLng = hazards.reduce((s, h) => s + Number(h.location_lng), 0) / hazards.length;

  const worstSize = hazards.some((h) => (h.properties as Record<string, unknown>).size === 'large')
    ? 'large'
    : hazards.some((h) => (h.properties as Record<string, unknown>).size === 'medium')
      ? 'medium'
      : 'small';

  const systemPrompt = `You are an ICS/NIMS Incident Safety Officer. Define ONE unified set of Hot, Warm, and Cold zone boundaries for this ENTIRE incident — not per-hazard.

Scenario: ${scenario_type} at ${venue}
Teams available: ${teamNames.join(', ')}

ALL active hazards at this incident:
${hazardSummary}

Incident centroid: (${incidentLat.toFixed(5)}, ${incidentLng.toFixed(5)})
Worst-case hazard size: ${worstSize}
Number of hazards: ${hazards.length}

The zones must ENVELOPE all hazards. The hot zone must contain ALL hazard locations plus a safety buffer. Consider the combined threat footprint — multiple overlapping hazards create a larger danger area than any single hazard.

Radius guidelines (adjust UP for multiple hazards):
- Single small hazard: hot ~30-50m, warm ~80-120m, cold ~200-350m
- Single large hazard: hot ~80-120m, warm ~180-280m, cold ~400-600m
- Multiple clustered hazards: hot ~100-200m, warm ~250-400m, cold ~500-800m
- CBRNE or major explosion: hot ~150-300m, warm ~400-600m, cold ~800-1200m

Adjust for hazard mix:
- Chemical/HAZMAT present: expand warm zone for decontamination corridor
- Fire + gas leak: expand hot zone for explosive risk
- Structural collapse: consider aftershock/secondary collapse in warm zone

Return ONLY valid JSON:
{
  "zones": [
    {
      "zone_type": "hot",
      "radius_m": <number>,
      "ppe_required": ["equipment_ids"],
      "allowed_teams": ["team_names"],
      "activities": ["rapid_extrication", "suppression", "containment", "reconnaissance"],
      "pin_guidance": "What belongs here: trapped casualties, active hazards, structural damage. Only specialized rescue teams (fire/hazmat) with full PPE. NO prolonged treatment — extract and move to warm zone."
    },
    {
      "zone_type": "warm",
      "radius_m": <number>,
      "ppe_required": ["equipment_ids"],
      "allowed_teams": ["team_names"],
      "activities": ["triage", "decontamination", "stabilization", "handoff"],
      "pin_guidance": "What belongs here: triage points, decontamination stations, casualty collection points. Extracted casualties move here for initial assessment. Medical/triage teams operate here with respiratory protection."
    },
    {
      "zone_type": "cold",
      "radius_m": <number>,
      "ppe_required": [],
      "allowed_teams": ["all"],
      "activities": ["treatment", "staging", "command", "transport", "definitive_care"],
      "pin_guidance": "What belongs here: command post, staging areas, treatment areas, ambulance loading, assembly points for evacuees. Walking wounded and evacuee crowds congregate here. Media staging. Convergent crowds (onlookers, family) gather at the outer edge."
    }
  ]
}

RULES:
- ppe_required: use equipment IDs like scba, hazmat_suit, fire_protective_gear, respirator, safety_vest, helmet, ppe_medical, chemical_gloves, face_shield, turnout_gear
- allowed_teams: use EXACT team names from above. Hot zone = only fire/hazmat specialists. Warm zone = add triage/medical. Cold zone = "all".
- Each zone radius MUST be larger than the previous (hot < warm < cold)
- The hot zone MUST be large enough to contain ALL hazard locations`;

  try {
    const result = await callOpenAi<{
      zones?: Array<{
        zone_type: string;
        radius_m: number;
        ppe_required: string[];
        allowed_teams: string[];
        activities: string[];
        pin_guidance?: string;
      }>;
    }>(
      systemPrompt,
      `Define the unified hot, warm, and cold zones for this ${scenario_type} incident with ${hazards.length} active hazards.`,
      openAiApiKey,
      2000,
    );

    const rawZones = result.zones ?? [];
    if (rawZones.length === 0) {
      logger.warn('Unified zone generation returned empty; using defaults');
      return [];
    }

    return computeZonePolygons(incidentLat, incidentLng, rawZones, input.osmBuildings);
  } catch (err) {
    logger.warn({ err }, 'Unified incident zone generation failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2c — Casualty Identification + Enrichment
// ---------------------------------------------------------------------------

async function generateCasualties(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  hazards?: WarroomScenarioPayload['hazards'],
  zoneSummaryBlock?: string,
): Promise<WarroomScenarioPayload['casualties']> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return undefined;

  onProgress?.('Generating casualty pins...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const incidentSites =
    locations?.filter(
      (l) =>
        l.pin_category === 'incident_site' ||
        l.location_type?.toLowerCase().includes('blast') ||
        l.location_type?.toLowerCase().includes('epicentre'),
    ) ?? [];

  const hazardBlock = hazards?.length
    ? `\nActive hazards:\n${hazards.map((h) => `- ${h.hazard_type} at (${h.location_lat}, ${h.location_lng}): ${h.enriched_description?.slice(0, 150) || (h.properties as Record<string, unknown>).fuel_source || h.hazard_type}`).join('\n')}`
    : '';

  const systemPrompt = `You are an expert in mass casualty incident planning generating INDIVIDUAL casualty pins for a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${incidentSites.length > 0 ? `Incident site: ${incidentSites[0].label} at (${incidentSites[0].coordinates.lat}, ${incidentSites[0].coordinates.lng})` : ''}
${hazardBlock}
${zoneSummaryBlock || ''}

Generate 15-20 INDIVIDUAL casualty pins representing the most clinically significant casualties that responders will encounter. Focus on variety of injury types and severity.

ZONE-BASED PLACEMENT — place casualties where they would realistically be found:
- HOT ZONE (inside the danger area): Trapped casualties under debris, behind fire, in smoke. These are the most severely injured — burns, blast injuries, crush injuries. Many are unconscious or unresponsive. They CANNOT be reached without specialized teams in full PPE. Place 3-5 casualties here.
- WARM ZONE (buffer/transition area): Casualties who were near the blast but managed to crawl or stagger away. Mix of moderate-to-severe injuries. Some confused, some in shock. Place 5-7 casualties here.
- COLD ZONE / OUTSIDE: Walking wounded who made it out. Minor injuries — lacerations, minor burns, psychological trauma, concussions. Some collapsed just outside exits. Place 5-8 casualties here.
- DELAYED DISCOVERY: Some casualties appear later (appears_at_minutes 5-20) as smoke clears or areas become accessible.

IMPORTANT: The "visible_description" must ONLY describe what a responder physically observes — do NOT reveal treatment protocols or equipment needed. Players must figure out the right response.

Generate "treatment_requirements", "transport_prerequisites", and "contraindications" as HIDDEN ground truth fields for the evaluation system.

Return ONLY valid JSON:
{
  "casualties": [
    {
      "casualty_type": "patient",
      "location_lat": number,
      "location_lng": number,
      "floor_level": "G",
      "headcount": 1,
      "conditions": {
        "injuries": [{ "type": "burn|laceration|fracture|blast_injury|crush_injury|smoke_inhalation|concussion|shrapnel_wound|cardiac_arrest|psychological|hemorrhage|amputation|penetrating_wound", "severity": "minor|moderate|severe|critical", "body_part": "string", "visible_signs": "string" }],
        "triage_color": "green|yellow|red|black",
        "mobility": "ambulatory|non_ambulatory|trapped",
        "accessibility": "open|behind_fire|under_debris|in_smoke|blocked_corridor",
        "consciousness": "alert|confused|unconscious|unresponsive",
        "breathing": "normal|labored|absent",
        "visible_description": "1-2 sentence description of what a responder sees approaching this person",
        "treatment_requirements": [{ "intervention": "string", "priority": "critical|high|medium", "reason": "short clinical rationale" }],
        "transport_prerequisites": ["string"],
        "contraindications": ["string"]
      },
      "status": "undiscovered",
      "appears_at_minutes": 0
    }
  ]
}

RULES:
- Each pin is ONE person (headcount: 1)
- Realistic triage color distribution for a major bombing: ~8% black (deceased), ~18% red (immediate/critical), ~30% yellow (delayed/serious), ~44% green (walking wounded/minor)
- At least 3-4 trapped casualties requiring extraction before they can be moved
- At least 2-3 casualties behind active hazards (accessibility: "behind_fire", "under_debris", "in_smoke")
- Scatter casualties realistically using zone guidance above — most severe near blast center, severity decreasing outward
- treatment_requirements: derive from injuries using real pre-hospital care protocols. Be medically accurate.
- transport_prerequisites: what MUST be stabilized before moving the patient safely
- contraindications: dangerous actions for this specific patient (e.g. crush syndrome risks, spinal precautions)
- Generate 15-20 casualties total.`;

  const userPrompt = `Generate 15-20 individual casualty pins for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      casualties?: WarroomScenarioPayload['casualties'];
    }>(systemPrompt, userPrompt, openAiApiKey, 8000);
    return parsed.casualties?.length ? parsed.casualties : undefined;
  } catch (err) {
    logger.warn({ err }, 'Casualty generation failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2d — Crowd / Evacuee Group Generation
// ---------------------------------------------------------------------------

async function generateCrowdPins(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  zoneSummaryBlock?: string,
): Promise<WarroomScenarioPayload['casualties']> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return undefined;

  onProgress?.('Generating crowd/evacuee pins...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const exitPins =
    locations?.filter((l) => l.pin_category === 'entry_exit' || l.pin_category === 'access') ?? [];

  const exitBlock =
    exitPins.length > 0
      ? `\nEntry/exit points:\n${exitPins.map((e) => `- ${e.label} at (${e.coordinates.lat}, ${e.coordinates.lng})`).join('\n')}`
      : '';

  const systemPrompt = `You are an expert in crowd dynamics and evacuation planning generating civilian crowd pins for a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${exitBlock}
${zoneSummaryBlock || ''}

Generate 8-15 crowd/evacuee group pins. Each represents a GROUP of civilians at a specific location.

ZONE-BASED PLACEMENT — place crowds where they would realistically be:
- WARM ZONE: Small groups (5-15) of dazed people who staggered out of the danger area. Confused, some injured. These need to be moved further out.
- COLD ZONE (near exits): Large groups (30-80) bottlenecking at exits. Panicking, some crushing. These are the primary evacuation challenge.
- COLD ZONE (assembly areas): Groups (20-60) who made it outside. Anxious but calmer. Some contain walking wounded mixed in.
- OUTSIDE PERIMETER: Groups of bystanders, people from nearby buildings who came to look. Curious, filming, some trying to get back in to find family.

Consider:
- Where would people naturally congregate after an incident? (near exits, open areas, parking lots)
- Some groups are fleeing, some are sheltering in place, some are confused/stationary
- Some groups contain walking wounded mixed in with uninjured
- Groups near exits may be creating bottlenecks — stampede risk
- Groups further from the incident may not yet know what happened

Return ONLY valid JSON:
{
  "crowds": [
    {
      "casualty_type": "crowd",
      "location_lat": number,
      "location_lng": number,
      "floor_level": "G",
      "headcount": number (5-80 per group),
      "conditions": {
        "behavior": "calm|anxious|panicking|sheltering|fleeing",
        "movement_direction": "string|null (e.g. 'toward south exit', 'stationary', 'milling')",
        "mixed_wounded": [{ "injury_type": "string", "severity": "minor|moderate", "count": number }],
        "bottleneck": true/false,
        "blocking_exit": "string|null (label of exit being blocked, if any)",
        "visible_description": "1-2 sentence description of what a marshal approaching sees"
      },
      "status": "identified",
      "appears_at_minutes": 0
    }
  ]
}

RULES:
- Total civilian count across all groups should be 200-500 (proportional to venue size)
- At least 3 groups should contain mixed_wounded (walking wounded mixed in)
- At least 2-3 groups should be creating bottlenecks near exits
- Some groups appear later as people emerge from different parts of the venue
- Vary group sizes: some small (5-15 near danger), some large (40-80 at exits)`;

  const userPrompt = `Generate crowd/evacuee group pins for "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{
      crowds?: WarroomScenarioPayload['casualties'];
    }>(systemPrompt, userPrompt, openAiApiKey, 5000);
    return parsed.crowds?.length ? parsed.crowds : undefined;
  } catch (err) {
    logger.warn({ err }, 'Crowd pin generation failed; continuing without');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2e — Convergent Crowd Generation (onlookers, media, family arriving later)
// ---------------------------------------------------------------------------

interface ConvergentCrowdResult {
  crowds?: WarroomScenarioPayload['casualties'];
  alertInjects?: WarroomScenarioPayload['time_injects'];
}

async function generateConvergentCrowds(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  teamNames?: string[],
): Promise<ConvergentCrowdResult> {
  const include = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!include) return {};

  onProgress?.('Generating convergent crowd pins (onlookers, media, family)...');

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;
  const durationMinutes = input.duration_minutes ?? 60;

  const entryExitPins =
    locations?.filter((l) => l.pin_category === 'entry_exit' || l.pin_category === 'access') ?? [];

  const entryBlock =
    entryExitPins.length > 0
      ? `\nEntry/exit points (convergent crowds arrive at these):\n${entryExitPins.map((e) => `- ${e.label} at (${e.coordinates.lat}, ${e.coordinates.lng})`).join('\n')}`
      : '';

  const incidentPin = locations?.find((l) => l.pin_category === 'incident_site');
  const incidentBlock = incidentPin
    ? `\nIncident site: (${incidentPin.coordinates.lat}, ${incidentPin.coordinates.lng})`
    : '';

  const crowdDynamics = researchContext?.crowd_dynamics;
  const researchBlock = crowdDynamics
    ? `\nRESEARCH ON CROWD DYNAMICS FOR THIS SCENARIO TYPE:\n${crowdDynamicsToPromptBlock(crowdDynamics)}`
    : '';

  const teamsBlock = teamNames?.length ? `\nAvailable teams: ${teamNames.join(', ')}` : '';

  const systemPrompt = `You are an expert in crowd dynamics and post-incident convergent behavior, generating convergent crowd pins for a crisis training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting}
Game duration: ${durationMinutes} minutes
${narrative ? `Narrative: ${narrative.title} — ${narrative.description}` : ''}
${entryBlock}
${incidentBlock}
${researchBlock}
${teamsBlock}

CONVERGENT CROWDS are people who arrive FROM OUTSIDE the incident after word spreads. They are NOT evacuees. They move TOWARD the incident scene. Types include:
- onlooker: Curious bystanders gathering near the perimeter to watch. They obstruct access and crowd exits.
- media: News crews and citizen journalists pushing for access to film. They may breach cordons.
- family: Distraught family members searching for loved ones, may be hysterical or aggressive toward responders.
- helper: Self-appointed volunteers who may cause harm by interfering with trained responders.

Generate 4-8 convergent crowd groups that arrive at different entry points at staggered times.
For EACH crowd group, also generate a paired ALERT INJECT that fires at the same time the crowd appears. The alert inject notifies the relevant team that a crowd is building up.

Target team mapping by crowd type:
- onlooker -> police/security team (perimeter concern)
- media -> media/communications team
- family -> evacuation or triage team
- helper -> whichever team is most affected

Return ONLY valid JSON:
{
  "convergent_crowds": [
    {
      "casualty_type": "convergent_crowd",
      "location_lat": number (at an entry point),
      "location_lng": number (at an entry point),
      "floor_level": "G",
      "headcount": number (5-50 per group),
      "conditions": {
        "crowd_origin": "onlooker|media|family|helper",
        "behavior": "calm|anxious|aggressive|demanding|filming",
        "visible_description": "1-2 sentence description of what responders see",
        "obstruction_risk": "low|medium|high"
      },
      "status": "identified",
      "appears_at_minutes": number (5-${Math.min(45, durationMinutes - 5)}),
      "destination_lat": number (toward the incident site or cordon area),
      "destination_lng": number (toward the incident site or cordon area),
      "destination_label": "string (e.g. 'toward incident perimeter')",
      "movement_speed_mpm": 72
    }
  ],
  "alert_injects": [
    {
      "trigger_time_minutes": number (SAME as the crowd's appears_at_minutes),
      "type": "intel brief",
      "title": "short (5-8 words) alert headline (e.g. 'News Crew Arriving at North Entrance')",
      "content": "1-2 sentence in-world description of what's happening — describe the crowd arriving and the potential impact on operations",
      "severity": "low|medium",
      "inject_scope": "team_specific",
      "target_teams": ["team name"],
      "requires_response": true
    }
  ]
}

RULES:
- Stagger arrival times: onlookers earliest (T+3-8), media next (T+8-15), family later (T+12-25), helpers scattered
- Each group spawns at an entry/exit point coordinate (or nearby if no entry points provided)
- destination coordinates should be partway between the entry point and the incident site (they move toward it)
- movement_speed_mpm: 72 for walking crowds, 40 for hesitant/family groups
- At least 1 onlooker group, 1 media group, 1 family group
- headcount: onlookers 15-50, media 3-10, family 5-20, helpers 5-15
- Vary obstruction_risk: media and family tend to be higher risk
- Each convergent_crowd entry MUST have a matching alert_inject with the SAME trigger_time_minutes as the crowd's appears_at_minutes`;

  const userPrompt = `Generate convergent crowd pins for "${narrative?.title || scenario_type}" at ${venue}. These are people arriving from outside after the incident.`;

  try {
    const parsed = await callOpenAi<{
      convergent_crowds?: WarroomScenarioPayload['casualties'];
      alert_injects?: WarroomScenarioPayload['time_injects'];
    }>(systemPrompt, userPrompt, openAiApiKey, 5000);
    return {
      crowds: parsed.convergent_crowds?.length ? parsed.convergent_crowds : undefined,
      alertInjects: parsed.alert_injects?.length ? parsed.alert_injects : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Convergent crowd generation failed; continuing without');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Phase 4b2f — Equipment Palette Generation
// Collects all equipment requirements from hazards + casualties → unified list
// ---------------------------------------------------------------------------

async function generateScenarioEquipment(
  hazards?: WarroomScenarioPayload['hazards'],
  casualties?: WarroomScenarioPayload['casualties'],
  teamNames?: string[],
): Promise<WarroomScenarioPayload['equipment']> {
  const equipmentMap = new Map<
    string,
    {
      equipment_type: string;
      label: string;
      icon?: string;
      properties: Record<string, unknown>;
      applicable_teams: string[];
    }
  >();

  const normalizeTeam = (t: string) => t.toLowerCase().replace(/[\s-]+/g, '_');

  const mergeTeams = (existing: string[], incoming: string[]) => {
    const set = new Set(existing.map(normalizeTeam));
    for (const t of incoming) set.add(normalizeTeam(t));
    return Array.from(set);
  };

  for (const h of hazards ?? []) {
    for (const eq of h.equipment_requirements ?? []) {
      const eqType = (eq.equipment_type as string) ?? '';
      if (!eqType) continue;
      const teams = Array.isArray(eq.applicable_teams) ? (eq.applicable_teams as string[]) : [];
      const existing = equipmentMap.get(eqType);
      if (existing) {
        existing.applicable_teams = mergeTeams(existing.applicable_teams, teams);
      } else {
        equipmentMap.set(eqType, {
          equipment_type: eqType,
          label: (eq.label as string) ?? eqType.replace(/_/g, ' '),
          icon: iconForEquipment(eqType),
          properties: {
            quantity_needed: (eq.quantity as number) ?? 1,
            critical: (eq.critical as boolean) ?? false,
            applicable_to: ['hazard'],
          },
          applicable_teams: teams.map(normalizeTeam),
        });
      }
    }

    const resReq = h.resolution_requirements ?? {};
    const reqEquipment = (resReq.equipment as string[]) ?? [];
    for (const eqType of reqEquipment) {
      if (eqType && !equipmentMap.has(eqType)) {
        equipmentMap.set(eqType, {
          equipment_type: eqType,
          label: eqType.replace(/_/g, ' '),
          icon: iconForEquipment(eqType),
          properties: { quantity_needed: 1, applicable_to: ['hazard'] },
          applicable_teams: [],
        });
      }
    }
  }

  const mobilityEquipment: Record<string, { label: string; icon: string; defaultTeams: string[] }> =
    {
      stretcher: { label: 'Stretcher', icon: 'bed', defaultTeams: ['evacuation', 'triage'] },
      spinal_board: {
        label: 'Spinal Board',
        icon: 'clipboard',
        defaultTeams: ['evacuation', 'triage'],
      },
      wheelchair: {
        label: 'Wheelchair',
        icon: 'accessibility',
        defaultTeams: ['evacuation', 'triage'],
      },
      cutting_tools: {
        label: 'Cutting Tools',
        icon: 'wrench',
        defaultTeams: ['fire_hazmat', 'evacuation'],
      },
      breathing_apparatus: {
        label: 'Breathing Apparatus',
        icon: 'wind',
        defaultTeams: ['fire_hazmat'],
      },
    };

  for (const c of casualties ?? []) {
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    const mobility = conds.mobility as string;
    if (mobility === 'non_ambulatory' || mobility === 'trapped') {
      if (!equipmentMap.has('stretcher')) {
        const me = mobilityEquipment.stretcher;
        equipmentMap.set('stretcher', {
          equipment_type: 'stretcher',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['non_ambulatory', 'trapped'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
    if (mobility === 'trapped') {
      if (!equipmentMap.has('cutting_tools')) {
        const me = mobilityEquipment.cutting_tools;
        equipmentMap.set('cutting_tools', {
          equipment_type: 'cutting_tools',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['trapped'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
    const accessibility = conds.accessibility as string;
    if (accessibility === 'in_smoke') {
      if (!equipmentMap.has('breathing_apparatus')) {
        const me = mobilityEquipment.breathing_apparatus;
        equipmentMap.set('breathing_apparatus', {
          equipment_type: 'breathing_apparatus',
          label: me.label,
          icon: me.icon,
          properties: { quantity_needed: 1, applicable_to: ['smoke_environment'] },
          applicable_teams: me.defaultTeams,
        });
      }
    }
  }

  // Items with empty applicable_teams get assigned to all teams (universal)
  const allTeamsNormalized = (teamNames ?? []).map(normalizeTeam);
  for (const entry of equipmentMap.values()) {
    if (entry.applicable_teams.length === 0) {
      entry.applicable_teams = allTeamsNormalized;
    }
  }

  const list = Array.from(equipmentMap.values());
  return list.length > 0 ? list : undefined;
}

function iconForEquipment(eqType: string): string {
  const iconMap: Record<string, string> = {
    foam_unit: 'droplet',
    fire_extinguisher: 'flame',
    thermal_camera: 'camera',
    breathing_apparatus: 'wind',
    hose_line: 'droplet',
    stretcher: 'bed',
    spinal_board: 'clipboard',
    cutting_tools: 'wrench',
    hydraulic_jack: 'wrench',
    defibrillator: 'heart',
    iv_kit: 'syringe',
    burn_kit: 'first-aid',
    splint: 'bone',
    oxygen_cylinder: 'wind',
    hazmat_suit: 'shield',
  };
  return iconMap[eqType] ?? 'package';
}

// ---------------------------------------------------------------------------
// Phase 4b3 — Floor Plan Generation  (3 000 tokens)
// Uses real building polygon from OSM + AI features → server-side SVG render
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function generateFloorPlans(
  input: WarroomGenerateInput,
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<WarroomScenarioPayload['floor_plans']> {
  const includeFloors = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeFloors) return undefined;

  const mainBuilding = input.osmBuildings?.[0];
  const levels = mainBuilding?.building_levels ?? 1;
  if (levels <= 1) return undefined;

  onProgress?.('Generating multi-floor layout from building footprint...');

  const { scenario_type, setting, venue_name, location } = input;
  const venue = venue_name || location || setting;

  const undergroundLevels = mainBuilding?.building_levels_underground ?? 0;
  const buildingUse = mainBuilding?.building_use ?? setting;

  const floorList: string[] = [];
  for (let i = undergroundLevels; i > 0; i--) floorList.push(`B${i}`);
  floorList.push('G');
  for (let i = 1; i < levels; i++) floorList.push(`L${i}`);

  const hasPolygon = !!mainBuilding?.footprint_polygon?.length;
  const polygonNote = hasPolygon
    ? `The building has a real footprint polygon with ${mainBuilding!.footprint_polygon!.length} vertices from OSM.`
    : 'No polygon available; layout will use a rectangular approximation.';

  const boundsBlock = mainBuilding?.bounds
    ? `Building bounds: minLat=${mainBuilding.bounds.minlat}, maxLat=${mainBuilding.bounds.maxlat}, minLng=${mainBuilding.bounds.minlon}, maxLng=${mainBuilding.bounds.maxlon}`
    : '';

  const systemPrompt = `You are an expert building layout designer. You are placing features inside a ${buildingUse} for a crisis training exercise.

Scenario type: ${scenario_type}
Venue: ${venue} (${buildingUse})
Setting: ${setting}
Floors: ${floorList.join(', ')}
${boundsBlock}
${polygonNote}
${narrative ? `Narrative: ${narrative.title}` : ''}

IMPORTANT: Position each feature using NORMALISED coordinates (0.0 to 1.0):
- position_x: 0.0 = west edge, 1.0 = east edge
- position_y: 0.0 = north edge, 1.0 = south edge
- For area features, also provide size_x and size_y (0.0 to 1.0 fraction of building)

Place exits at edges (x near 0 or 1, or y near 0 or 1). Place central features (escalators, elevators) near the middle (0.4-0.6). Distribute rooms across the floor realistically.

Return ONLY valid JSON:
{
  "floor_plans": [
    {
      "floor_level": "G",
      "floor_label": "Ground Floor",
      "features": [
        {
          "id": "main_entrance_g",
          "type": "entrance",
          "label": "Main Entrance",
          "position_x": 0.5,
          "position_y": 1.0,
          "properties": { "capacity": 200, "width_m": 6 }
        },
        {
          "id": "food_court_g",
          "type": "food_court",
          "label": "Food Court",
          "position_x": 0.3,
          "position_y": 0.4,
          "size_x": 0.25,
          "size_y": 0.2,
          "properties": {}
        }
      ],
      "environmental_factors": [
        { "factor": "smoke_accumulation", "severity": "low" },
        { "factor": "crowd_density", "severity": "medium" }
      ]
    }
  ]
}

RULES:
- Each feature MUST have id, type, label, position_x (0-1), position_y (0-1)
- Area features (corridor, food_court, retail, room, parking, office, storage) also need size_x and size_y
- emergency_exit positions: on edges (x=0, x=1, y=0, or y=1)
- escalator/elevator/stairs: near center, consistent across floors
- Ground floor: main entrance, 3-4 emergency exits, retail/food areas
- Upper floors: escalators/stairs down, fire exits, retail/office
- Basement: parking, service areas, limited exits
- 6-10 features per floor
- Valid types: emergency_exit, escalator, elevator, stairs, entrance, room, corridor, food_court, retail, restroom, fire_extinguisher, fire_alarm, first_aid, electrical_panel, ventilation, water_supply, parking, office, storage`;

  const userPrompt = `Generate floor plans for ${floorList.length} floors of ${venue} (${buildingUse}). Floors: ${floorList.join(', ')}.`;

  try {
    const { generateFloorPlanSvg, convertFeaturesToGeoJson } =
      await import('./floorPlanSvgService.js');

    interface AiFloorPlan {
      floor_level: string;
      floor_label: string;
      features: Array<{
        id: string;
        type: string;
        label: string;
        position_x: number;
        position_y: number;
        size_x?: number;
        size_y?: number;
        properties?: Record<string, unknown>;
      }>;
      environmental_factors: Array<Record<string, unknown>>;
    }

    const parsed = await callOpenAi<{
      floor_plans?: AiFloorPlan[];
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);

    if (!parsed.floor_plans?.length) return undefined;

    const polygon = mainBuilding?.footprint_polygon;
    const rectBounds = mainBuilding?.bounds ?? null;
    const leafletBounds = rectBounds
      ? {
          southWest: [rectBounds.minlat, rectBounds.minlon],
          northEast: [rectBounds.maxlat, rectBounds.maxlon],
        }
      : undefined;

    const results: NonNullable<WarroomScenarioPayload['floor_plans']> = [];

    for (const aiFloor of parsed.floor_plans) {
      // Generate SVG from real polygon + AI features
      const svg = generateFloorPlanSvg(polygon, rectBounds, {
        floor_level: aiFloor.floor_level,
        floor_label: aiFloor.floor_label,
        building_use: buildingUse,
        features: aiFloor.features.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          position_x: Math.max(0, Math.min(1, f.position_x ?? 0.5)),
          position_y: Math.max(0, Math.min(1, f.position_y ?? 0.5)),
          size_x: f.size_x,
          size_y: f.size_y,
          properties: f.properties,
        })),
        environmental_factors: aiFloor.environmental_factors ?? [],
      });

      // Convert normalised feature positions to GeoJSON for map markers
      const geoFeatures = rectBounds
        ? convertFeaturesToGeoJson(
            aiFloor.features.map((f) => ({
              id: f.id,
              type: f.type,
              label: f.label,
              position_x: Math.max(0, Math.min(1, f.position_x ?? 0.5)),
              position_y: Math.max(0, Math.min(1, f.position_y ?? 0.5)),
              properties: f.properties,
            })),
            rectBounds,
          )
        : [];

      results.push({
        floor_level: aiFloor.floor_level,
        floor_label: aiFloor.floor_label,
        plan_svg: svg || undefined,
        bounds: leafletBounds,
        features: geoFeatures,
        environmental_factors: aiFloor.environmental_factors ?? [],
      });
    }

    logger.info(
      { floors: results.length, hasPolygon, polygonVertices: polygon?.length ?? 0 },
      'Floor plan SVGs generated from building footprint',
    );

    return results;
  } catch (err) {
    logger.warn({ err }, 'Floor plan generation failed; continuing without');
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
  const routeLocations = locations?.filter((l) => l.location_type === 'route') ?? [];
  const routeSummary =
    routeLocations.length > 0
      ? `Routes:\n${routeLocations
          .map((r) => {
            const c = r.conditions as Record<string, unknown> | undefined;
            return `- ${r.label}: ${c?.problem || 'clear'}, ${c?.travel_time_minutes ?? '?'} min`;
          })
          .join('\n')}`
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
${routeSummary}

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
- site_areas: If the scenario locations already carry rich conditions (capacity_persons, has_water, has_electricity, area_m2, potential_uses, etc.), return an EMPTY site_areas array [] — the location conditions are the source of truth. Otherwise, generate 3–5 operational areas that teams in THIS scenario actually use. Name them for this incident type — NOT generic MCI area names unless this is an MCI.
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
// Phase 4d — Team Intelligence Dossiers  (1 call per team · ~2 500 tokens each)
// ---------------------------------------------------------------------------

interface TeamDossierEntry {
  question: string;
  category: string;
  answer: string;
}

async function generateSingleTeamDossier(
  teamName: string,
  teamDescription: string,
  input: WarroomGenerateInput,
  allTeamNames: string[],
  openAiApiKey: string,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  phase4c?: {
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
  },
): Promise<TeamDossierEntry[]> {
  const { scenario_type, setting, terrain, venue_name, location, osm_vicinity } = input;
  const venue = venue_name || location || setting;

  const narrativeBlock = narrative
    ? `\nNARRATIVE:\nTitle: ${narrative.title || ''}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : '';
  const locationsBlock = locations?.length
    ? `\nMap pins:\n${locations.map((l) => `- ${l.label} (${l.location_type}): ${l.description || ''}`).join('\n')}`
    : '';
  const osmBlock = osm_vicinity
    ? `\nNearby facilities — Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}; Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}; Fire: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}`
    : '';
  const routeLocs = locations?.filter((l) => l.location_type === 'route') ?? [];
  const routeSummary =
    routeLocs.length > 0
      ? `\nRoutes:\n${routeLocs
          .map((r) => {
            const c = r.conditions as Record<string, unknown> | undefined;
            return `- ${r.label}: ${c?.problem || 'clear'}, ${c?.travel_time_minutes ?? '?'} min`;
          })
          .join('\n')}`
      : '';
  const factsBlock = phase4c?.custom_facts?.length
    ? `\nScenario facts:\n${phase4c.custom_facts.map((f) => `- ${f.topic}: ${f.detail || f.summary}`).join('\n')}`
    : '';
  const escalationBlock = phase4c?.baseline_escalation_factors?.length
    ? `\nEscalation risks:\n${phase4c.baseline_escalation_factors.map((e) => `- ${e.name} (${e.severity}): ${e.description}`).join('\n')}`
    : '';
  const layoutBlock = phase4c?.layout_ground_truth
    ? `\nLayout: ${JSON.stringify(phase4c.layout_ground_truth, null, 1).slice(0, 600)}`
    : '';

  const systemPrompt = `You are an expert crisis management scenario designer building a detailed INTELLIGENCE DOSSIER for one specific team in a training exercise.

Scenario type: ${scenario_type}
Venue: ${venue}
Setting: ${setting} | Terrain: ${terrain}
All teams: ${allTeamNames.join(', ')}
${narrativeBlock}
${locationsBlock}
${osmBlock}
${routeSummary}
${factsBlock}
${escalationBlock}
${layoutBlock}

TARGET TEAM: "${teamName}"
TEAM ROLE: ${teamDescription}

Your task: Think about what a "${teamName}" team would ACTUALLY need to know from a well-informed insider during a ${scenario_type} incident. Generate 10–15 questions they would realistically ask, along with rich, detailed answers grounded in this specific scenario.

Each answer must be 3–6 sentences with SPECIFIC details: names of people, organizations, locations, numbers, timestamps, conditions, sentiments. Invent realistic details that are CONSISTENT with the scenario context — real-sounding names, plausible organizations, concrete numbers.

Return ONLY valid JSON:
{
  "dossier": [
    {
      "question": "string — a natural question this team would ask the insider",
      "category": "string — short snake_case category (e.g. public_sentiment, media_presence, resource_status, suspect_profile, witness_accounts, infrastructure_status, weather_conditions, crowd_behavior, political_pressure, supply_chain, communication_lines, legal_authority, chain_of_command, intelligence_feeds, hazmat_status, structural_integrity, casualty_profile, transport_availability, community_relations, misinformation, vip_presence)",
      "answer": "string — 3-6 sentences of rich, specific, scenario-grounded intelligence"
    }
  ]
}

RULES:
- Questions must be specific to what a "${teamName}" team needs during a ${scenario_type}. Think about their operational concerns, information gaps, and decision-making needs.
- Answers must reference specific scenario details: the venue name, location, nearby facilities, scenario narrative.
- Invent realistic supporting details (people names, organization names, specific numbers, timestamps) that are consistent with the scenario but add depth.
- Cover a WIDE range of information needs — don't cluster around one topic. Include situational awareness, resource status, stakeholder dynamics, environmental conditions, and operational constraints.
- Do NOT repeat information verbatim from the scenario briefing — add NEW intelligence that enriches the picture.
- Every answer should give the team something ACTIONABLE or help them make better decisions.`;

  const userPrompt = `Build the intelligence dossier for the "${teamName}" team in "${narrative?.title || scenario_type}" at ${venue}.`;

  const parsed = await callOpenAi<{ dossier?: TeamDossierEntry[] }>(
    systemPrompt,
    userPrompt,
    openAiApiKey,
    3000,
  );
  return parsed.dossier?.length ? parsed.dossier : [];
}

async function generateTeamIntelligenceDossiers(
  input: WarroomGenerateInput,
  teamNames: string[],
  teams: WarroomScenarioPayload['teams'],
  openAiApiKey: string,
  onProgress?: WarroomAiProgressCallback,
  narrative?: { title?: string; description?: string; briefing?: string },
  locations?: WarroomScenarioPayload['locations'],
  phase4c?: {
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
  },
): Promise<Record<string, TeamDossierEntry[]> | undefined> {
  const includeDossiers = input.complexity_tier === 'full' || input.complexity_tier === 'rich';
  if (!includeDossiers) return undefined;

  onProgress?.('Generating team intelligence dossiers...');

  try {
    const results = await Promise.all(
      teams.map((t) =>
        generateSingleTeamDossier(
          t.team_name,
          t.team_description,
          input,
          teamNames,
          openAiApiKey,
          narrative,
          locations,
          phase4c,
        ),
      ),
    );

    const dossiers: Record<string, TeamDossierEntry[]> = {};
    for (let i = 0; i < teams.length; i++) {
      if (results[i].length > 0) {
        dossiers[teams[i].team_name] = results[i];
      }
    }

    return Object.keys(dossiers).length > 0 ? dossiers : undefined;
  } catch (err) {
    logger.warn({ err }, 'Phase 4d team intelligence dossiers failed; continuing without');
    return undefined;
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

  const systemPrompt = `You are an expert crisis management scenario designer writing EXTERNAL WORLD injects visible to ALL teams simultaneously. These represent events OUTSIDE player control — things happening in the world around the crisis that players must react to but cannot prevent through their operational decisions.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
Teams: ${teamNames.join(', ')}
${osmBlock}
${standardsBlock}
${similarCasesBlock}
${narrativeBlock}

WHAT THESE INJECTS ARE:
- The initial incident (explosion, attack, disaster) and its immediate aftermath
- Breaking news reports, social media firestorms, viral misinformation
- Political pressure: ministers arriving, parliamentary questions, conflicting orders from political vs operational chains
- Black swan events: improbable but possible complications (impostor doctor, secondary device threat, hostile drone, chemical contamination discovery, infrastructure collapse upstream)
- Weather changes affecting operations (wind shift carrying smoke, rain, temperature drop)
- Social tensions triggered by the incident (ethnic accusations, protests, vigilante mobs, conspiracy theories)
- External resource complications (hospital declaring capacity full, ambulance fleet diverted, road closure cutting off access)
- Media chaos: journalists breaching cordons, deepfake footage, hostile live broadcasts

WHAT THESE INJECTS ARE NOT (these are handled by real-time condition monitoring):
- Overcrowding in triage or assembly areas
- Staff shortages or carer-to-patient ratios
- Equipment shortages in operational areas
- Exit congestion or evacuation flow problems
- Patient deterioration or casualty status changes

The game runs for ${input.duration_minutes ?? 60} minutes. Arc the external narrative: initial shock → media/political pressure builds → black swan complications → resolution pressure.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": 0,
      "type": "field_update|media_report|intel_brief|weather_change|political_pressure|black_swan",
      "title": "string",
      "content": "string — 2-3 sentences, specific to THIS scenario and venue",
      "severity": "critical|high|medium|low",
      "inject_scope": "universal",
      "target_teams": [],
      "requires_response": true,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${universalSlots.length} injects. Assigned times: ${slotDescriptions}.
- Each inject MUST use its exact assigned trigger_time_minutes — no substitutions.
- inject_scope is always "universal". target_teams is always [].
- Each inject must reference the specific scenario title, venue, and narrative details.
- Include at least 1-2 genuine black swan events (improbable but possible: impostor responders, secondary threats, infrastructure failures, rogue actors).
- No operational/logistical injects (no "triage is overwhelmed" or "exit congested") — those emerge from gameplay.
- requires_response: set to true when teams must react (e.g. political demand, media confrontation, secondary threat). false ONLY for atmospheric pressure (background news, social media chatter).`;

  const userPrompt = `Write ${universalSlots.length} universal injects for "${narrative?.title || scenario_type}" at ${venue} at times: ${slotDescriptions}.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      5000,
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
      requires_response: inj.requires_response ?? true,
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

  const systemPrompt = `You are an expert crisis management scenario designer writing EXTERNAL WORLD events EXCLUSIVELY for the ${teamName} team. These are events that happen TO this team from the outside world — things they cannot prevent through operational decisions but must react to.

Scenario: ${scenario_type} at ${venue}
Setting: ${setting} | Terrain: ${terrain}
All teams in this exercise: ${allTeamNames.join(', ')}
THIS inject set is ONLY for: ${teamName}
${narrativeBlock}
${similarCasesBlock}

Inject style reference (tone and specificity):
${JSON.stringify(injectTemplates.slice(0, 3))}

WHAT THESE INJECTS ARE (external events specific to ${teamName}'s domain):
- Someone impersonating a ${teamName}-related professional (fake doctor, unauthorized volunteer, rogue official)
- Inter-agency friction: conflicting orders from higher command, turf disputes with other teams
- External civilian pressure: families demanding access to ${teamName}'s area, VIPs pulling rank, cultural conflicts
- Supply chain disruptions: ambulance fleet delayed by traffic, equipment shipment lost, vendor refusing to deliver
- Media targeting: journalist confronting ${teamName} leader on camera, leaked footage of ${teamName}'s area
- Black swan complications: unexpected discovery (hazmat, secondary device, structural failure) that directly impacts ${teamName}
- Political interference specific to ${teamName}'s role

WHAT THESE INJECTS ARE NOT (handled by real-time area monitors):
- "Your triage is overcrowded" — this is detected automatically by area capacity monitoring
- "Not enough medics" — detected by carer-ratio monitoring
- "Exit is congested" — detected by exit flow monitoring
- "Equipment shortage" — detected by equipment monitoring
- Any patient status change or deterioration — handled by deterioration services

The game runs for ${input.duration_minutes ?? 60} minutes. Arc the ${teamName}'s external narrative:
- Setup (T+0–${Math.round((input.duration_minutes ?? 60) * 0.25)}): ${teamName} encounters their first external complication.
- Escalation (T+${Math.round((input.duration_minutes ?? 60) * 0.25)}–${Math.round((input.duration_minutes ?? 60) * 0.55)}): An outside force raises the stakes for ${teamName}.
- Peak (T+${Math.round((input.duration_minutes ?? 60) * 0.55)}–${Math.round((input.duration_minutes ?? 60) * 0.85)}): A black swan or worst-case external event.
- Resolution (T+${Math.round((input.duration_minutes ?? 60) * 0.85)}–${input.duration_minutes ?? 60}): External consequence or relief.

Return ONLY valid JSON:
{
  "time_injects": [
    {
      "trigger_time_minutes": <exact value from: ${assignedSlots.join(', ')}>,
      "type": "field_update|citizen_call|intel_brief|media_report|political_pressure|black_swan",
      "title": "string — specific external event hitting ${teamName}",
      "content": "string — 2-4 sentences, vivid and specific to ${teamName}'s role",
      "severity": "critical|high|medium|low",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": true,
      "requires_coordination": false
    }
  ]
}

RULES:
- Exactly ${assignedSlots.length} injects using EXACTLY these times: ${slotsWithPhase}.
- inject_scope always "team_specific". target_teams always ["${teamName}"].
- No operational/logistical status updates — only external world events.
- Include at least 1 black swan event (impostor, rogue actor, unexpected discovery, infrastructure failure).
- No two injects should address the same challenge.
- requires_response: true when ${teamName} must act. false ONLY for atmospheric pressure.`;

  const userPrompt = `Write ${assignedSlots.length} deep team-specific injects for ${teamName} at: ${slotsWithPhase} in "${narrative?.title || scenario_type}" at ${venue}.`;

  try {
    const parsed = await callOpenAi<{ time_injects?: WarroomScenarioPayload['time_injects'] }>(
      systemPrompt,
      userPrompt,
      openAiApiKey,
      5000,
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
      requires_response: inj.requires_response ?? true,
      requires_coordination: inj.requires_coordination ?? false,
    }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Team time injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2c — Per-team chaos/wildcard injects  (1 call per team · 3 000 tokens)
// ---------------------------------------------------------------------------

/**
 * Generates non-procedural, socially volatile, emotionally charged wildcard events
 * specific to each team's domain. These are CONDITION-BASED: they trigger when
 * specific game state conditions are met, not at fixed times.
 */
async function generateChaosInjects(
  input: WarroomGenerateInput,
  teamName: string,
  allTeamNames: string[],
  openAiApiKey: string,
  chaosCount: number,
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<NonNullable<WarroomScenarioPayload['condition_driven_injects']>> {
  if (chaosCount <= 0) return [];

  const { scenario_type, setting, venue_name, location, researchContext } = input;
  const venue = venue_name || location || setting;
  const durationMinutes = input.duration_minutes ?? 60;

  const narrativeBlock = narrative
    ? `\nNARRATIVE: ${narrative.title || ''} — ${narrative.description || ''}`
    : '';
  const similarCasesBlock =
    researchContext?.similar_cases && researchContext.similar_cases.length > 0
      ? `\nSIMILAR REAL INCIDENTS (use for inspiration on realistic chaos events):\n${similarCasesToPromptBlock(researchContext.similar_cases)}`
      : '';
  const crowdDynamicsBlock = researchContext?.crowd_dynamics
    ? `\nCROWD DYNAMICS RESEARCH:\n${crowdDynamicsToPromptBlock(researchContext.crowd_dynamics)}`
    : '';

  const systemPrompt = `You are a crisis simulation chaos designer. Your job is to generate unpredictable, socially volatile, emotionally charged wildcard events for the ${teamName} team. These are NOT operational or procedural events — they are the messy human reality of a crisis.

These chaos events are CONDITION-BASED: instead of firing at a fixed time, each inject specifies CONDITIONS that must be true in the game state before the inject appears. This makes them reactive to player actions and game progression.

Scenario: ${scenario_type} at ${venue}
All teams: ${allTeamNames.join(', ')}
Focus team: ${teamName}
Game duration: ${durationMinutes} minutes
${narrativeBlock}
${similarCasesBlock}
${crowdDynamicsBlock}

These events represent the HUMAN CHAOS that overwhelms responders in real crises — the irrational behavior, social tensions, cultural flashpoints, media intrusions, emotional breakdowns, and political interference that no procedure manual covers.

Generate events from categories like these (tailored to ${teamName}'s domain):
- SOCIAL TENSION: Ethnic or religious accusations between victims/bystanders, communal blame, hate speech, sectarian conflict
- CROWD PSYCHOLOGY: Mob mentality, stampede risk, mass hysteria, people refusing to cooperate, vigilante behavior
- MEDIA INTRUSION: Bystanders livestreaming casualties, journalists sneaking past cordons, deepfake footage going viral
- FAMILY & GRIEF: Distraught families storming restricted areas, parents searching for children, VIPs demanding special treatment
- POLITICAL INTERFERENCE: Politicians arriving for photo opportunities, conflicting orders from political vs operational chains
- MISINFORMATION: Conspiracy theories going viral in real-time, false second-attack rumors, fake authority figures
- ETHICAL DILEMMAS: Patient refusing treatment on religious grounds, triage decisions with ethical dimensions
- CULTURAL SENSITIVITY: Body handling conflicts, prayer time during evacuation, language barriers

AVAILABLE CONDITION KEYS (use these in conditions_to_appear):
- "casualties_at_assembly_above_20" — people have gathered at assembly areas
- "patients_in_treatment_above_5" — medical treatment is underway
- "active_fires_above_0" — fires are still burning
- "convergent_crowd_present" — onlookers/media/family have arrived from outside
- "no_zone_identification_decision" — players have not drawn any hazard zones
- "no_perimeter_establishment_decision" — no cordon/perimeter placed
- "exits_congested" — at least one exit has congestion
- "no_media_management_decision" — no media statement has been issued
- "crowd_density_above_0.6" — crowd density is dangerously high
- "objective_evacuation_not_completed" — evacuation objective is still active

AVAILABLE STATE EFFECT KEYS (mechanical disruptions the inject causes):
- evacuation_state.flow_rate_modifier — multiplier on exit flow rate (e.g. 0.5 = halved, 0.3 = severe)
- movement_state.speed_modifier — multiplier on crowd/patient movement speed (e.g. 0.6 = slowed)
- triage_state.treatment_time_modifier — multiplier on treatment duration (e.g. 1.5 = 50% longer)

Return ONLY valid JSON:
{
  "condition_injects": [
    {
      "type": "citizen_call|field_update|media_report|intel_brief",
      "title": "string — vivid, specific headline of the chaos event",
      "content": "string — 2-4 sentences describing the situation viscerally, with specific details",
      "severity": "critical|high|medium",
      "inject_scope": "team_specific",
      "target_teams": ["${teamName}"],
      "requires_response": true,
      "conditions_to_appear": {
        "threshold": 1,
        "conditions": ["condition_key_1", "condition_key_2"]
      },
      "conditions_to_cancel": ["condition_key_that_resolves_this"],
      "eligible_after_minutes": 5,
      "state_effect": {
        "evacuation_state": { "flow_rate_modifier": 0.5 }
      }
    }
  ]
}

RULES:
- Exactly ${chaosCount} injects.
- inject_scope always "team_specific". target_teams always ["${teamName}"].
- Every inject must be a NON-PROCEDURAL chaos event.
- Each inject must have conditions_to_appear with 1-3 condition keys from the list above.
- threshold: how many conditions must be true (1 = any of them, 2+ = multiple must co-occur).
- conditions_to_cancel: 1-2 keys that, if true, mean the chaos has been addressed and the inject should NOT fire.
- eligible_after_minutes: earliest game time this can fire (stagger: some at 5, some at 10-15, some at 20+).
- state_effect: include a mechanical disruption for at least half the injects. Use realistic modifiers (0.3-0.8 for slowdowns, 1.3-2.0 for time increases). Leave state_effect as {} for purely narrative injects.
- Be bold and uncomfortable — real crises involve racism, grief, anger, and panic. Do not sanitize.
- Make events culturally and geographically specific to ${venue}.`;

  const userPrompt = `Write ${chaosCount} condition-based chaos/wildcard injects for ${teamName} in "${narrative?.title || scenario_type}" at ${venue}. Each must be a distinct, non-procedural social/human chaos event with game-state conditions that trigger it.`;

  try {
    const parsed = await callOpenAi<{
      condition_injects?: Array<{
        type?: string;
        title?: string;
        content?: string;
        severity?: string;
        inject_scope?: string;
        target_teams?: string[];
        requires_response?: boolean;
        conditions_to_appear?: { threshold?: number; conditions?: string[] } | { all: string[] };
        conditions_to_cancel?: string[];
        eligible_after_minutes?: number;
        state_effect?: Record<string, unknown>;
      }>;
    }>(systemPrompt, userPrompt, openAiApiKey, 4000);

    const raw = parsed.condition_injects || [];
    return raw.map((inj) => ({
      type: normalizeInjectType(inj.type || 'citizen_call'),
      title: inj.title || `${teamName} wildcard event`,
      content: inj.content || '',
      severity: inj.severity || 'high',
      inject_scope: 'team_specific',
      target_teams: [teamName],
      requires_response: inj.requires_response ?? true,
      conditions_to_appear: inj.conditions_to_appear ?? { threshold: 1, conditions: [] },
      conditions_to_cancel: inj.conditions_to_cancel,
      eligible_after_minutes: inj.eligible_after_minutes ?? 5,
      state_effect:
        inj.state_effect && Object.keys(inj.state_effect).length > 0 ? inj.state_effect : undefined,
    }));
  } catch (err) {
    logger.warn({ err, teamName }, 'Chaos injects failed; continuing without');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — (removed: generic decision-based injects replaced by condition-driven injects)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Env inject sub-generators removed — replaced by AI runtime evaluation
// ---------------------------------------------------------------------------
/**
 * Exported alias so warroomService can run Phase 1 before standards research
 * and then pass the result back in via input.phase1Preview.
 */
export const generateTeamsAndCoreForResearch = generateTeamsAndCore;

/**
 * Generate full scenario payload using multi-phase AI.
 *
 * Phase 1      (sequential) : teams + core scenario
 * Batch A      (parallel)   : universal time injects + per-team time injects + per-team decision injects + per-team chaos injects
 * Phase 4a-1   (parallel)   : scenario-fixed pins (anchored to building outline)
 *   + POI enrichment        : (runs in parallel with 4a-1)
 * Phase 4a-2   (sequential) : candidate-space pins (selected from OSM open spaces, after 4a-1)
 * Phase 4b     (sequential) : environmental seeds
 * Phase 4c     (sequential) : layout + site knowledge
 * Phase 4d     (parallel)   : team intelligence dossiers (one call per team)
 * Batch B      (parallel)   : per-team condition injects + per-pair condition injects
 * Post-process              : normalizeInjectTiming + validatePinTopology
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
  const durationMinutes = input.duration_minutes ?? 60;
  const timingManifest = buildTimingManifest(teamNames, durationMinutes);

  // Batch A — time injects + chaos injects, all parallel (no world context needed)
  onProgress?.('Generating injects (parallel batch A)...');
  const [universalTimeInjects, perTeamTimeResults, perTeamChaosResults] = await Promise.all([
    generateUniversalTimeInjects(
      input,
      teamNames,
      openAiApiKey,
      timingManifest.universalSlots,
      undefined,
      narrative,
    ),
    Promise.all(
      teamNames.map((t) =>
        generateTeamTimeInjects(
          input,
          t,
          teamNames,
          openAiApiKey,
          timingManifest.teamSlots[t] ?? [],
          narrative,
        ),
      ),
    ),
    Promise.all(
      teamNames.map((t) =>
        generateChaosInjects(
          input,
          t,
          teamNames,
          openAiApiKey,
          Math.max(3, Math.floor(durationMinutes / 15)),
          narrative,
        ),
      ),
    ),
  ]);

  // Merge and normalise time injects — guarantees no 5-min gap in 0–60
  const rawTimeInjects: WarroomScenarioPayload['time_injects'] = [
    ...universalTimeInjects,
    ...perTeamTimeResults.flat(),
  ];
  const time_injects = normalizeInjectTiming(rawTimeInjects, durationMinutes);

  // Phase 4a-1 (scenario-fixed pins) + POI enrichment run in PARALLEL
  const venue = input.venue_name || input.location || input.setting;
  const [scenarioFixedPins, poiPins] = await Promise.all([
    generateScenarioFixedPins(input, teamNames, openAiApiKey, onProgress, narrative),
    osm_vicinity
      ? generatePoiPinsFromOsm(
          osm_vicinity,
          input.scenario_type,
          venue,
          input.geocode ? { lat: input.geocode.lat, lng: input.geocode.lng } : undefined,
          openAiApiKey,
        ).catch((err) => {
          logger.warn({ err }, 'POI pin generation failed; continuing without');
          return [] as NonNullable<WarroomScenarioPayload['locations']>;
        })
      : Promise.resolve([] as NonNullable<WarroomScenarioPayload['locations']>),
  ]);

  // Merge and validate all pins (incident site + entry/exit + POIs)
  const mergedPins: NonNullable<WarroomScenarioPayload['locations']> = [
    ...(scenarioFixedPins ?? []),
    ...poiPins,
  ];
  const locations =
    mergedPins.length > 0
      ? validatePinTopology(
          mergedPins,
          input.geocode ? { lat: input.geocode.lat, lng: input.geocode.lng } : undefined,
          input.osmOpenSpaces,
        )
      : undefined;

  if (poiPins.length > 0) {
    logger.info({ poiCount: poiPins.length }, 'POI pins generated from OSM');
  }

  // Counter definitions first, then environmental seeds (seeds reference counter keys)
  const counterDefsMap = await generateCounterDefinitions(
    input,
    teamNames,
    openAiApiKey,
    onProgress,
    narrative,
  );

  // Route network: compute corridors from OSM data, then AI-enrich with conditions
  if (input.osmRouteGeometries?.length && locations?.length) {
    const incidentPin = locations.find((l) => l.pin_category === 'incident_site');
    const incidentCoords = incidentPin?.coordinates ?? input.geocode;
    if (incidentCoords) {
      const facilityPins = locations.filter((l) => l.pin_category === 'poi');
      const corridors = computeRouteCorridors(
        input.osmRouteGeometries,
        facilityPins.map((p) => ({
          label: p.label,
          coordinates: p.coordinates,
          location_type: p.location_type,
        })),
        incidentCoords,
      );
      if (corridors.length > 0) {
        const routeLocations = await enrichRouteLocations(
          input,
          corridors,
          facilityPins.map((p) => ({
            label: p.label,
            location_type: p.location_type,
            conditions: p.conditions,
          })),
          openAiApiKey,
          onProgress,
          narrative,
        );
        if (routeLocations?.length) {
          locations.push(...routeLocations);
        }
      }
    }
  }

  // Attach counter definitions to teams (AI-generated or template fallback)
  const effectiveDefsMap = counterDefsMap ?? loadTemplateCounterDefs(input.scenario_type);
  if (effectiveDefsMap) {
    for (const team of phase1.teams) {
      const n = team.team_name.toLowerCase();
      const defs =
        effectiveDefsMap[team.team_name] ??
        effectiveDefsMap[n] ??
        Object.entries(effectiveDefsMap).find(([k]) => k.toLowerCase() === n)?.[1];
      if (defs?.length) {
        team.counter_definitions = defs;
      }
    }
  }

  const [phase4c, scenarioHazards] = await Promise.all([
    generateLayoutAndSiteKnowledge(
      input,
      teamNames,
      openAiApiKey,
      onProgress,
      narrative,
      locations,
    ),
    generateScenarioHazards(input, openAiApiKey, onProgress, narrative, locations, teamNames),
  ]);
  const floorPlansResult = undefined;

  // Generate unified incident zones (one hot/warm/cold set for the whole incident)
  let unifiedZones: ZoneWithPolygon[] = [];
  if (scenarioHazards?.length) {
    unifiedZones = await generateUnifiedIncidentZones(
      input,
      scenarioHazards,
      openAiApiKey,
      teamNames,
      onProgress,
    );
    // Store zones on the first hazard only; others get empty arrays
    if (unifiedZones.length > 0) {
      scenarioHazards[0].zones = unifiedZones;
      for (let i = 1; i < scenarioHazards.length; i++) {
        scenarioHazards[i].zones = [];
      }
    }
  }

  // Build a zone summary block for casualty/crowd generation prompts
  const zoneSummaryBlock =
    unifiedZones.length > 0
      ? `\nUNIFIED INCIDENT ZONES (use these for pin placement):
${unifiedZones.map((z) => `- ${z.zone_type.toUpperCase()} zone: radius ${z.radius_m}m from incident center. ${z.activities.join(', ')}. Allowed teams: ${z.allowed_teams.join(', ')}`).join('\n')}`
      : '';

  // Casualty + crowd generation (casualties depend on hazard data + zone info for positioning)
  const [casualtyPins, crowdPins, convergentResult] = await Promise.all([
    generateCasualties(
      input,
      openAiApiKey,
      onProgress,
      narrative,
      locations,
      scenarioHazards,
      zoneSummaryBlock,
    ),
    generateCrowdPins(input, openAiApiKey, onProgress, narrative, locations, zoneSummaryBlock),
    generateConvergentCrowds(input, openAiApiKey, onProgress, narrative, locations, teamNames),
  ]);
  const convergentPins = convergentResult?.crowds;
  const convergentAlertInjects = convergentResult?.alertInjects;
  const allCasualtyPins = [
    ...(casualtyPins ?? []),
    ...(crowdPins ?? []),
    ...(convergentPins ?? []),
  ];
  const casualties: WarroomScenarioPayload['casualties'] =
    allCasualtyPins.length > 0 ? allCasualtyPins : undefined;

  // Reconcile counter pool caps with actual pin counts so UI totals match reality
  if (allCasualtyPins.length > 0) {
    let totalPatients = 0;
    let totalEvacuees = 0;
    for (const pin of allCasualtyPins) {
      const hc = pin.headcount ?? 1;
      if (pin.casualty_type === 'patient') {
        totalPatients += hc;
      } else {
        totalEvacuees += hc;
      }
    }
    for (const team of phase1.teams) {
      if (!team.counter_definitions?.length) continue;
      for (const def of team.counter_definitions) {
        if (def.key === 'total_patients' && def.behavior === 'static' && totalPatients > 0) {
          def.initial_value = totalPatients;
        }
        if (def.key === 'total_evacuees' && def.behavior === 'static' && totalEvacuees > 0) {
          def.initial_value = totalEvacuees;
        }
      }
    }
    logger.info(
      { totalPatients, totalEvacuees, pinCount: allCasualtyPins.length },
      'Counter pool caps reconciled with actual pin counts',
    );
  }

  // Equipment palette derived from hazard + casualty requirements
  const scenarioEquipment = await generateScenarioEquipment(scenarioHazards, casualties, teamNames);

  // Phase 4d — Team Intelligence Dossiers (one AI call per team, in parallel)
  const teamDossiers = await generateTeamIntelligenceDossiers(
    input,
    teamNames,
    phase1.teams,
    openAiApiKey,
    onProgress,
    narrative,
    locations,
    phase4c,
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

    const teamNames = phase1.teams.map((t) => t.team_name);
    if (teamNames.length > 0) {
      const teamDoctrines = await mapStandardsToTeams(
        openAiApiKey,
        teamNames,
        input.researchContext.standards_findings,
      );
      if (Object.keys(teamDoctrines).length > 0) {
        insiderKnowledge.team_doctrines = teamDoctrines;
      }
    }
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
  if (teamDossiers && Object.keys(teamDossiers).length > 0) {
    insiderKnowledge.team_intelligence_dossiers = teamDossiers;
  }

  // Team workflow chains (endgame, steps, ratios, SOP)
  try {
    onProgress?.('Researching team workflow chains...');
    const workflows = await researchTeamWorkflows(
      openAiApiKey,
      input.scenario_type,
      teamNames,
      narrative,
    );
    if (Object.keys(workflows).length > 0) {
      insiderKnowledge.team_workflows = workflows;
    }
  } catch (err) {
    logger.warn({ err }, 'Team workflow research failed; continuing without');
  }

  const hasInsiderKnowledge = Object.keys(insiderKnowledge).length > 0;

  const allConditionInjects = perTeamChaosResults.flat();
  const condition_driven_injects = allConditionInjects.length > 0 ? allConditionInjects : undefined;

  const finalTimeInjects = convergentAlertInjects?.length
    ? [...time_injects, ...convergentAlertInjects].sort(
        (a, b) => (a.trigger_time_minutes ?? 0) - (b.trigger_time_minutes ?? 0),
      )
    : time_injects;

  return {
    scenario: scenarioWithType,
    teams: phase1.teams,
    objectives: phase1.objectives,
    time_injects: finalTimeInjects,
    condition_driven_injects,
    locations,
    hazards: scenarioHazards,
    casualties,
    equipment: scenarioEquipment,
    floor_plans: floorPlansResult,
    insider_knowledge: hasInsiderKnowledge ? insiderKnowledge : undefined,
  };
}
