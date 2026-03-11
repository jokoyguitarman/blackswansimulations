/**
 * War Room AI Service
 * Generates full scenario payload from templates + location data using OpenAI.
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
}

/**
 * Generate full scenario payload using AI with template merging.
 */
export async function warroomGenerateScenario(
  input: WarroomGenerateInput,
  openAiApiKey: string,
): Promise<WarroomScenarioPayload> {
  const {
    scenario_type,
    setting,
    terrain,
    location,
    venue_name,
    osm_vicinity,
    geocode,
    complexity_tier,
    typeSpec,
    settingSpec,
    terrainSpec,
  } = input;

  const venue = venue_name || location || setting;
  const locationContext = geocode
    ? `Real location: ${geocode.display_name} (${geocode.lat}, ${geocode.lng})`
    : location
      ? `Location mentioned: ${location} (no coordinates available)`
      : 'No specific real-world location.';

  const osmContext = osm_vicinity
    ? `
Real facilities from OpenStreetMap:
- Hospitals: ${osm_vicinity.hospitals?.map((h) => h.name).join(', ') || 'None'}
- Police: ${osm_vicinity.police?.map((p) => p.name).join(', ') || 'None'}
- Fire stations: ${osm_vicinity.fire_stations?.map((f) => f.name).join(', ') || 'None'}
- Emergency routes: ${osm_vicinity.emergency_routes?.map((r) => r.description).join(', ') || 'None'}
Use these real names in scenario content where relevant.`
    : '';

  const injectCount =
    complexity_tier === 'minimal'
      ? 4
      : complexity_tier === 'standard'
        ? 8
        : complexity_tier === 'full'
          ? 12
          : 18;
  const decisionCount =
    complexity_tier === 'minimal'
      ? 0
      : complexity_tier === 'standard'
        ? 2
        : complexity_tier === 'full'
          ? 4
          : 6;
  const includeLocations = complexity_tier !== 'minimal';
  const includeEnvSeeds = complexity_tier === 'full' || complexity_tier === 'rich';

  const systemPrompt = `You are an expert crisis management scenario designer. Create a complete, playable scenario for multi-agency emergency response training.

Scenario type: ${scenario_type}
Setting: ${setting}
Terrain: ${terrain}
Venue: ${venue}
${locationContext}
${osmContext}

Template context:
- Scenario type: ${JSON.stringify(typeSpec)}
- Setting: ${JSON.stringify(settingSpec)}
- Terrain: ${JSON.stringify(terrainSpec)}

Generate a complete scenario with:
- ${injectCount} time-based injects (trigger_time_minutes: 0, 5, 10, 15, ...)
- ${decisionCount} decision-based injects (trigger_condition: e.g. "when evacuation team decides to segregate")
- target_teams must be subset of teams you define
- Include locations (blast_site, exits, triage_sites, hospitals, police, fire_stations) if location data available
- ${includeEnvSeeds ? 'Include 2 environmental_seed variants' : 'No environmental_seeds'}

Return ONLY valid JSON matching this schema. No markdown, no explanation.`;

  const userPrompt = `Create a ${complexity_tier} complexity scenario. Use real facility names from OSM if provided. Make injects realistic and challenging.`;

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
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg =
      (err as { error?: { message?: string } }).error?.message ||
      `OpenAI API error: ${response.status}`;
    logger.error({ status: response.status, msg }, 'Warroom AI generation failed');
    throw new Error(msg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content from OpenAI');
  }

  const parsed = JSON.parse(content) as WarroomScenarioPayload;

  // Validate and normalize
  const teams = parsed.teams || [];
  const teamNames = new Set(teams.map((t) => t.team_name));

  const time_injects = (parsed.time_injects || []).map((inj) => ({
    ...inj,
    target_teams: (inj.target_teams || []).filter((t) => teamNames.has(t)),
    inject_scope: inj.inject_scope || 'universal',
    requires_response: inj.requires_response ?? false,
    requires_coordination: inj.requires_coordination ?? false,
  }));

  const decision_injects = (parsed.decision_injects || [])
    .filter((inj) => inj.trigger_condition)
    .map((inj) => ({
      ...inj,
      title: inj.title || inj.trigger_condition?.slice(0, 80) || 'Decision required',
      content: inj.content || inj.trigger_condition || '',
      target_teams: (inj.target_teams || []).filter((t) => teamNames.has(t)),
      inject_scope: inj.inject_scope || 'universal',
      requires_response: inj.requires_response ?? false,
      requires_coordination: inj.requires_coordination ?? false,
    }));

  return {
    scenario: {
      title: parsed.scenario?.title || `${scenario_type} at ${venue}`,
      description: parsed.scenario?.description || '',
      briefing: parsed.scenario?.briefing || '',
      objectives: Array.isArray(parsed.scenario?.objectives) ? parsed.scenario.objectives : [],
      initial_state: parsed.scenario?.initial_state || {},
      role_specific_briefs: parsed.scenario?.role_specific_briefs || {},
      category: parsed.scenario?.category || 'terrorism',
      difficulty: parsed.scenario?.difficulty || 'advanced',
      duration_minutes: parsed.scenario?.duration_minutes || 60,
    },
    teams,
    objectives: parsed.objectives || [],
    time_injects,
    decision_injects: decision_injects.length > 0 ? decision_injects : undefined,
    locations: includeLocations ? parsed.locations : undefined,
    environmental_seeds: includeEnvSeeds ? parsed.environmental_seeds : undefined,
    insider_knowledge: osm_vicinity
      ? { ...parsed.insider_knowledge, osm_vicinity }
      : parsed.insider_knowledge,
  };
}
