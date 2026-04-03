/**
 * War Room Service
 * Orchestrates prompt parsing, geocoding, OSM vicinity, AI generation, and persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { geocode, geocodeBest } from './geocodingService.js';
import {
  fetchOsmVicinityByCoordinates,
  fetchOsmOpenSpaces,
  fetchVenueBuilding,
  fetchRouteGeometries,
} from './osmVicinityService.js';
import {
  parseFreeTextPrompt,
  validateCompatibility,
  buildDefaultThreatProfile,
  type ParsedWarroomInput,
} from './warroomPromptParser.js';
import {
  warroomGenerateScenario,
  generateAdversaryPursuitTree,
  type WarroomScenarioPayload,
} from './warroomAiService.js';
import { persistWarroomScenario } from './warroomPersistenceService.js';
import {
  researchArea,
  researchStandardsPerTeam,
  researchSimilarCases,
  researchCrowdDynamics,
  persistResearchCases,
  linkResearchToScenario,
  extractSettingTags,
  type StandardsFinding,
  type SimilarCase,
  type CrowdDynamicsResearch,
  type TeamInput,
} from './warroomResearchService.js';

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import type { OsmVicinity } from './osmVicinityService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OSM_CACHE_RADIUS_M = 5000;

/**
 * Look for a nearby scenario that already has osm_vicinity data cached in
 * its insider_knowledge. Returns the cached vicinity if one exists within
 * OSM_CACHE_RADIUS_M meters, otherwise null.
 */
async function findCachedOsmVicinity(lat: number, lng: number): Promise<OsmVicinity | null> {
  try {
    const degApprox = OSM_CACHE_RADIUS_M / 111_000;
    const { data: rows } = await supabaseAdmin
      .from('scenarios')
      .select('center_lat, center_lng, insider_knowledge')
      .not('insider_knowledge', 'is', null)
      .gte('center_lat', lat - degApprox)
      .lte('center_lat', lat + degApprox)
      .gte('center_lng', lng - degApprox)
      .lte('center_lng', lng + degApprox)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!rows?.length) return null;

    for (const row of rows) {
      const ik = row.insider_knowledge as Record<string, unknown> | null;
      const cached = ik?.osm_vicinity as OsmVicinity | undefined;
      if (!cached) continue;

      const hasData =
        (cached.hospitals?.length ?? 0) > 0 ||
        (cached.police?.length ?? 0) > 0 ||
        (cached.fire_stations?.length ?? 0) > 0;
      if (!hasData) continue;

      const dLat = (Number(row.center_lat) - lat) * 111_000;
      const dLng = (Number(row.center_lng) - lng) * 111_000 * Math.cos((lat * Math.PI) / 180);
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist <= OSM_CACHE_RADIUS_M) {
        logger.info(
          { dist: Math.round(dist), hospitals: cached.hospitals?.length ?? 0 },
          'Reusing cached OSM vicinity from nearby scenario',
        );
        return cached;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err }, 'OSM vicinity cache lookup failed; will fetch fresh');
    return null;
  }
}

export interface WarroomTeamInput {
  team_name: string;
  team_description: string;
  min_participants?: number;
  max_participants?: number;
}

export interface WarroomGenerateOptions {
  prompt?: string;
  scenario_type?: string;
  setting?: string;
  terrain?: string;
  location?: string;
  complexity_tier?: 'minimal' | 'standard' | 'full' | 'rich';
  duration_minutes?: number;
  include_adversary_pursuit?: boolean;
  inject_profiles?: string[];
  teams?: WarroomTeamInput[];
}

export interface WarroomSuggestTeamsResult {
  suggested_teams: WarroomTeamInput[];
  scenario_type?: string;
  setting?: string;
  terrain?: string;
  location?: string | null;
  venue_name?: string;
  landmarks?: string[];
  threat_profile?: import('./warroomPromptParser.js').ThreatProfile;
}

export type WarroomProgressPhase =
  | 'parsing'
  | 'geocoding'
  | 'case_research'
  | 'osm'
  | 'area_research'
  | 'standards_research'
  | 'ai'
  | 'persist';

export interface WarroomProgressCallback {
  (phase: WarroomProgressPhase, message: string): void;
}

function loadJson<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function getTemplatesDir(): string {
  const candidates = [
    path.join(__dirname, '../../scenario_templates'),
    path.join(process.cwd(), 'scenario_templates'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(process.cwd(), 'scenario_templates');
}

function getRequiredTeamsFromTemplate(typeSpec: Record<string, unknown>): WarroomTeamInput[] {
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
 * Suggest teams from scenario template. Parses prompt if provided.
 */
export async function suggestWarroomTeams(
  options: Pick<
    WarroomGenerateOptions,
    'prompt' | 'scenario_type' | 'setting' | 'terrain' | 'location'
  >,
  openAiApiKey: string,
): Promise<WarroomSuggestTeamsResult> {
  let parsed: ParsedWarroomInput;

  if (options.prompt && !options.scenario_type) {
    parsed = await parseFreeTextPrompt(options.prompt, openAiApiKey);
  } else {
    parsed = {
      scenario_type: options.scenario_type || 'car_bomb',
      setting: options.setting || 'open_field',
      terrain: options.terrain || 'urban',
      location: options.location || null,
      threat_profile: buildDefaultThreatProfile(options.scenario_type || 'car_bomb'),
    };
  }

  const validation = validateCompatibility(parsed.scenario_type, parsed.setting, parsed.terrain);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const templatesDir = getTemplatesDir();
  const typeSpec = loadJson<Record<string, unknown>>(
    path.join(templatesDir, 'scenario_types', `${parsed.scenario_type}.json`),
  );

  if (!typeSpec) {
    throw new Error(`Failed to load scenario template: ${parsed.scenario_type}`);
  }

  const suggested_teams = getRequiredTeamsFromTemplate(typeSpec);

  return {
    suggested_teams,
    scenario_type: parsed.scenario_type,
    setting: parsed.setting,
    terrain: parsed.terrain,
    location: parsed.location,
    venue_name: parsed.venue_name,
    landmarks: parsed.landmarks,
    threat_profile: parsed.threat_profile,
  };
}

/**
 * Generate and persist a War Room scenario.
 */
export async function generateAndPersistWarroomScenario(
  options: WarroomGenerateOptions,
  openAiApiKey: string,
  createdBy: string,
  onProgress?: WarroomProgressCallback,
): Promise<{ scenarioId: string; payload: WarroomScenarioPayload }> {
  let parsed: ParsedWarroomInput;

  if (options.prompt && !options.scenario_type) {
    onProgress?.('parsing', 'Parsing prompt and classifying scenario type, setting, terrain...');
    parsed = await parseFreeTextPrompt(options.prompt, openAiApiKey);
  } else {
    parsed = {
      scenario_type: options.scenario_type || 'car_bomb',
      setting: options.setting || 'open_field',
      terrain: options.terrain || 'urban',
      location: options.location || null,
      threat_profile: buildDefaultThreatProfile(options.scenario_type || 'car_bomb'),
    };
  }

  const validation = validateCompatibility(parsed.scenario_type, parsed.setting, parsed.terrain);
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const templatesDir = getTemplatesDir();
  const typeSpec = loadJson<Record<string, unknown>>(
    path.join(templatesDir, 'scenario_types', `${parsed.scenario_type}.json`),
  );
  const settingSpec = loadJson<Record<string, unknown>>(
    path.join(templatesDir, 'settings', `${parsed.setting}.json`),
  );
  const terrainSpec = loadJson<Record<string, unknown>>(
    path.join(templatesDir, 'terrains', `${parsed.terrain}.json`),
  );

  if (!typeSpec || !settingSpec || !terrainSpec) {
    throw new Error('Failed to load scenario templates');
  }

  const complexity_tier = options.complexity_tier || 'full';
  const duration_minutes = options.duration_minutes || 60;
  const threatProfile = parsed.threat_profile;

  const venueName = parsed.venue_name || parsed.location || parsed.setting;
  // Run geocoding and similar-cases research in parallel (both can start right after parsing)
  onProgress?.(
    'geocoding',
    parsed.location
      ? `Resolving coordinates for "${parsed.location}"...`
      : 'No location specified; skipping geocoding.',
  );
  onProgress?.('case_research', 'Researching similar real-world incidents...');

  let geocodeResult = null;
  let similarCases: SimilarCase[] = [];
  let crowdDynamics: CrowdDynamicsResearch | null = null;

  const geocodePromise = parsed.location
    ? (() => {
        const alternates: string[] = [];
        if (parsed.venue_name && parsed.location) {
          alternates.push(`${parsed.venue_name}, ${parsed.location}`);
        }
        if (alternates.length > 0) {
          const hint = parsed.venue_name || parsed.location || '';
          return geocodeBest(parsed.location, alternates, hint);
        }
        return geocode(parsed.location);
      })()
    : Promise.resolve(null);

  [geocodeResult, similarCases, crowdDynamics] = await Promise.all([
    geocodePromise,
    researchSimilarCases(
      openAiApiKey,
      parsed.scenario_type,
      parsed.location ?? undefined,
      venueName,
      parsed.setting,
      options.prompt || undefined,
      parsed.threat_profile
        ? {
            weapon_type: parsed.threat_profile.weapon_type,
            weapon_class: parsed.threat_profile.weapon_class,
            adversary_count: parsed.threat_profile.adversary_count,
            threat_scale: parsed.threat_profile.threat_scale,
          }
        : undefined,
    ).catch(() => [] as SimilarCase[]),
    researchCrowdDynamics(
      openAiApiKey,
      parsed.scenario_type,
      parsed.location ?? undefined,
      venueName,
    ).catch(() => null),
  ]);

  logger.info({ found: similarCases.length }, 'Similar cases research done');
  if (crowdDynamics) {
    logger.info(
      { crowdTypes: crowdDynamics.convergent_crowd_types.length },
      'Crowd dynamics research done',
    );
  }

  let osmVicinity: OsmVicinity | undefined = undefined;
  let osmOpenSpaces: import('./osmVicinityService.js').OsmOpenSpace[] | undefined;
  let osmBuildings: import('./osmVicinityService.js').OsmBuilding[] | undefined;
  let osmRouteGeometries: import('./osmVicinityService.js').OsmRouteGeometry[] | undefined;
  if (geocodeResult) {
    onProgress?.(
      'osm',
      'Fetching nearby facilities, open spaces, building outlines, and route geometries...',
    );
    try {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // Try cache first — reuse OSM vicinity from a nearby scenario
      const cachedVicinity = await findCachedOsmVicinity(geocodeResult.lat, geocodeResult.lng);

      const vicinity =
        cachedVicinity ??
        (await fetchOsmVicinityByCoordinates(geocodeResult.lat, geocodeResult.lng, 5000));
      if (!cachedVicinity) await delay(1500);

      const buildings = await fetchVenueBuilding(geocodeResult.lat, geocodeResult.lng, 300).catch(
        (err) => {
          logger.warn({ err }, 'OSM venue building fetch failed; continuing without');
          return [] as import('./osmVicinityService.js').OsmBuilding[];
        },
      );
      await delay(1500);

      const spaces = await fetchOsmOpenSpaces(geocodeResult.lat, geocodeResult.lng, 1500).catch(
        (err) => {
          logger.warn({ err }, 'OSM open spaces fetch failed; continuing without');
          return [] as import('./osmVicinityService.js').OsmOpenSpace[];
        },
      );
      await delay(3000);

      const routeGeoms = await fetchRouteGeometries(
        geocodeResult.lat,
        geocodeResult.lng,
        6000,
      ).catch((err) => {
        logger.warn({ err }, 'OSM route geometries fetch failed; continuing without');
        return [] as import('./osmVicinityService.js').OsmRouteGeometry[];
      });

      osmVicinity = vicinity;
      osmOpenSpaces = spaces.length > 0 ? spaces : undefined;
      osmBuildings = buildings.length > 0 ? buildings : undefined;
      osmRouteGeometries = routeGeoms.length > 0 ? routeGeoms : undefined;
    } catch (osmErr) {
      logger.warn(
        { err: osmErr, location: parsed.location },
        'OSM vicinity fetch failed; continuing without',
      );
    }
  }

  // Phase A: area research (runs independently of standards)
  const areaSummary = parsed.location
    ? await (() => {
        onProgress?.('area_research', 'Researching area: geography, agencies...');
        return researchArea(openAiApiKey, parsed.location!, venueName).catch(() => '');
      })()
    : '';

  // Phase B: generate core scenario first (Phase 1) so standards research can read the narrative
  onProgress?.('ai', 'Generating scenario world: teams, injects, objectives, locations...');
  const aiProgress = (msg: string) => onProgress?.('ai', msg);
  const userTeams = options.teams?.map((t) => ({
    team_name: t.team_name,
    team_description: t.team_description || '',
    min_participants: t.min_participants ?? 1,
    max_participants: t.max_participants ?? 10,
    is_investigative: (t as unknown as Record<string, unknown>).is_investigative === true,
  }));

  // Run Phase 1 (core + teams) to get the narrative before standards research
  const { generateTeamsAndCoreForResearch } = await import('./warroomAiService.js');
  const phase1Preview = await generateTeamsAndCoreForResearch(
    {
      scenario_type: parsed.scenario_type,
      setting: parsed.setting,
      terrain: parsed.terrain,
      location: parsed.location,
      venue_name: venueName,
      original_prompt: options.prompt || undefined,
      landmarks: parsed.landmarks,
      osm_vicinity: osmVicinity,
      geocode: geocodeResult
        ? {
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
            display_name: geocodeResult.display_name,
          }
        : undefined,
      complexity_tier,
      typeSpec,
      settingSpec,
      terrainSpec,
      researchContext:
        similarCases.length > 0 || areaSummary || crowdDynamics
          ? {
              area_summary: areaSummary || undefined,
              similar_cases: similarCases.length > 0 ? similarCases : undefined,
              crowd_dynamics: crowdDynamics || undefined,
            }
          : undefined,
      userTeams,
      inject_profiles: options.inject_profiles,
      threat_profile: threatProfile,
    },
    openAiApiKey,
    aiProgress,
  );

  // Phase C: per-team standards research using the real story + team descriptions
  onProgress?.(
    'standards_research',
    'Researching response standards per team for this scenario...',
  );
  let standardsFindings: StandardsFinding[] = [];
  let perTeamDoctrines: Record<string, StandardsFinding[]> = {};
  try {
    const teamInputs: TeamInput[] =
      userTeams && userTeams.length > 0
        ? userTeams.map((t) => ({ team_name: t.team_name, team_description: t.team_description }))
        : phase1Preview.teams.map((t) => ({
            team_name: t.team_name,
            team_description: t.team_description || undefined,
          }));

    const result = await researchStandardsPerTeam(openAiApiKey, parsed.scenario_type, teamInputs, {
      title: phase1Preview.scenario.title,
      description: phase1Preview.scenario.description,
      briefing: phase1Preview.scenario.briefing,
    });
    standardsFindings = result.allFindings;
    perTeamDoctrines = result.teamDoctrines;
  } catch (err) {
    logger.warn({ err }, 'Standards research failed; continuing without');
  }

  const payload = await warroomGenerateScenario(
    {
      scenario_type: parsed.scenario_type,
      setting: parsed.setting,
      terrain: parsed.terrain,
      location: parsed.location,
      venue_name: venueName,
      original_prompt: options.prompt || undefined,
      landmarks: parsed.landmarks,
      osm_vicinity: osmVicinity,
      osmOpenSpaces,
      osmBuildings,
      osmRouteGeometries,
      geocode: geocodeResult
        ? {
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
            display_name: geocodeResult.display_name,
          }
        : undefined,
      complexity_tier,
      duration_minutes,
      typeSpec,
      settingSpec,
      terrainSpec,
      researchContext:
        areaSummary ||
        standardsFindings.length > 0 ||
        similarCases.length > 0 ||
        crowdDynamics ||
        Object.keys(perTeamDoctrines).length > 0
          ? {
              area_summary: areaSummary || undefined,
              standards_findings: standardsFindings.length > 0 ? standardsFindings : undefined,
              team_doctrines:
                Object.keys(perTeamDoctrines).length > 0 ? perTeamDoctrines : undefined,
              similar_cases: similarCases.length > 0 ? similarCases : undefined,
              crowd_dynamics: crowdDynamics || undefined,
            }
          : undefined,
      userTeams,
      phase1Preview,
      inject_profiles: options.inject_profiles,
      threat_profile: threatProfile,
    },
    openAiApiKey,
    aiProgress,
  );

  // Adversary pursuit decision tree (only for scenarios with has_adversary: true)
  try {
    const payloadLocations = (payload.locations || []).map((l) => ({
      location_type: l.location_type,
      pin_category: l.pin_category,
      label: l.label,
      coordinates: l.coordinates,
    }));
    const payloadTeamNames = payload.teams.map((t) => t.team_name);
    const pursuitNarrative = {
      title: payload.scenario.title,
      description: payload.scenario.description,
      briefing: payload.scenario.briefing,
    };

    const pursuitResult = await generateAdversaryPursuitTree(
      {
        scenario_type: parsed.scenario_type,
        setting: parsed.setting,
        terrain: parsed.terrain,
        location: parsed.location ?? null,
        venue_name: parsed.venue_name,
        original_prompt: options.prompt,
        duration_minutes: options.duration_minutes || 60,
        typeSpec,
        settingSpec,
        terrainSpec,
        complexity_tier: options.complexity_tier || 'full',
        threat_profile: threatProfile,
      },
      payloadLocations,
      payloadTeamNames,
      openAiApiKey,
      pursuitNarrative,
      (msg: string) => onProgress?.('ai', msg),
      options.include_adversary_pursuit,
    );

    if (pursuitResult) {
      if (!payload.insider_knowledge) payload.insider_knowledge = {};
      (payload.insider_knowledge as Record<string, unknown>).adversary_profiles =
        pursuitResult.adversary_profiles;

      const taggedPursuitInjects = pursuitResult.pursuit_time_injects.map((inj, i) => ({
        ...inj,
        _pursuit_inject_index: i,
      }));
      payload.time_injects = [...payload.time_injects, ...taggedPursuitInjects].sort(
        (a, b) => a.trigger_time_minutes - b.trigger_time_minutes,
      ) as typeof payload.time_injects;

      if (!payload.condition_driven_injects) payload.condition_driven_injects = [];
      (payload.condition_driven_injects as Array<Record<string, unknown>>).push(
        ...(pursuitResult.pursuit_condition_injects as Array<Record<string, unknown>>),
      );

      if (!payload.locations) payload.locations = [];
      payload.locations.push(
        ...pursuitResult.last_known_pins.map((p) => p as (typeof payload.locations)[0]),
      );

      const payloadAny = payload as unknown as Record<string, unknown>;
      if (!payloadAny.pursuit_gates) {
        payloadAny.pursuit_gates = pursuitResult.pursuit_gates;
      }

      logger.info(
        {
          adversaryCount: pursuitResult.adversary_profiles.length,
          pursuitInjects: pursuitResult.pursuit_time_injects.length,
          pursuitCondInjects: pursuitResult.pursuit_condition_injects.length,
          pursuitGates: pursuitResult.pursuit_gates.length,
        },
        'Adversary pursuit tree merged into scenario payload',
      );
    }
  } catch (pursuitErr) {
    logger.warn(
      { err: pursuitErr },
      'Adversary pursuit tree generation failed; continuing without',
    );
  }

  // Persist site_requirements into insider_knowledge for runtime use
  if (standardsFindings.length > 0) {
    const allSiteReqs: Record<string, import('./warroomResearchService.js').SiteRequirement> = {};
    for (const f of standardsFindings) {
      if (f.site_requirements) {
        Object.assign(allSiteReqs, f.site_requirements);
      }
    }
    if (Object.keys(allSiteReqs).length > 0) {
      if (!payload.insider_knowledge) payload.insider_knowledge = {};
      (payload.insider_knowledge as Record<string, unknown>).site_requirements = allSiteReqs;
    }
  }

  // Ensure we always have center coordinates: geocode first, then fall back to incident_site pin
  let finalCenterLat = geocodeResult?.lat;
  let finalCenterLng = geocodeResult?.lng;

  if (finalCenterLat == null || finalCenterLng == null) {
    const incidentPin = (payload.locations ?? []).find(
      (l) =>
        l.pin_category === 'incident_site' &&
        typeof l.coordinates?.lat === 'number' &&
        typeof l.coordinates?.lng === 'number',
    );
    if (incidentPin) {
      finalCenterLat = incidentPin.coordinates.lat;
      finalCenterLng = incidentPin.coordinates.lng;
      logger.info(
        { lat: finalCenterLat, lng: finalCenterLng },
        'Using incident_site pin coordinates as scenario center (geocode unavailable)',
      );
    } else {
      // Last resort: pick the first location pin that has coordinates
      const anyPin = (payload.locations ?? []).find(
        (l) => typeof l.coordinates?.lat === 'number' && typeof l.coordinates?.lng === 'number',
      );
      if (anyPin) {
        finalCenterLat = anyPin.coordinates.lat;
        finalCenterLng = anyPin.coordinates.lng;
        logger.info(
          { lat: finalCenterLat, lng: finalCenterLng, label: anyPin.label },
          'Using first available pin coordinates as scenario center (no geocode, no incident_site)',
        );
      }
    }
  }

  onProgress?.('persist', 'Saving scenario to database: teams, injects, objectives...');
  const scenarioId = await persistWarroomScenario(payload, createdBy, {
    center_lat: finalCenterLat,
    center_lng: finalCenterLng,
    vicinity_radius_meters: finalCenterLat != null ? 10000 : undefined,
  });

  // Persist research cases and link them to the scenario (non-blocking)
  if (similarCases.length > 0) {
    const settingTags = extractSettingTags(
      `${options.prompt || ''} ${parsed.location || ''} ${parsed.venue_name || ''} ${parsed.setting || ''}`,
      parsed.scenario_type,
    );
    persistResearchCases(
      similarCases,
      parsed.scenario_type,
      parsed.threat_profile?.weapon_class,
      settingTags,
    )
      .then((persisted) => {
        const caseLinks = persisted.map((p) => ({
          id: p.id,
          relevanceScore: p.case_.relevance_score,
        }));
        return linkResearchToScenario(scenarioId, caseLinks);
      })
      .catch((err) => logger.warn({ err, scenarioId }, 'Research linking failed (non-blocking)'));
  }

  return { scenarioId, payload };
}
