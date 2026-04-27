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
  expandHospitalSearch,
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
  generateTeamsAndCoreForResearch,
  generateDeteriorationTimeline,
  type WarroomScenarioPayload,
  type Phase1Result,
  type DeteriorationTimelineResult,
  type TrainerScene,
} from './warroomAiService.js';
import { persistWarroomScenario } from './warroomPersistenceService.js';
import {
  researchArea,
  researchStandardsPerTeam,
  researchForbiddenActionsPerTeam,
  researchSimilarCases,
  researchCrowdDynamics,
  researchTeamWorkflows,
  researchDeteriorationPhysics,
  deteriorationResearchToPromptBlock,
  persistResearchCases,
  linkResearchToScenario,
  extractSettingTags,
  type StandardsFinding,
  type SimilarCase,
  type CrowdDynamicsResearch,
  type ForbiddenAction,
  type TeamInput,
  type TeamWorkflow,
} from './warroomResearchService.js';

import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import type { OsmVicinity } from './osmVicinityService.js';
import type { OsmOpenSpace, OsmBuilding, OsmRouteGeometry } from './osmVicinityService.js';
import { backfillBuildingsForScenario, generateStudGrids } from './buildingStudService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OSM_CACHE_RADIUS_M = 5000;

/**
 * Convert a sim-space position (meters, relative to building polygon centroid)
 * back to WGS84 lat/lng. Same projection as projectPolygon in the frontend,
 * but inverted.
 */
export function simToLatLng(
  simPos: { x: number; y: number },
  polygon: [number, number][],
): { lat: number; lng: number } {
  const refLat = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const refLng = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((refLat * Math.PI) / 180);
  return {
    lat: refLat - simPos.y / mPerDegLat,
    lng: refLng + simPos.x / mPerDegLng,
  };
}

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
  secondary_devices_count?: number;
  real_bombs_count?: number;
  teams?: WarroomTeamInput[];
  scene_context?: Record<string, unknown>;
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
      setting: options.setting || 'office',
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

// ---------------------------------------------------------------------------
// Composable Wizard Stages
// ---------------------------------------------------------------------------

export interface ParseAndGeocodeResult {
  parsed: ParsedWarroomInput;
  geocodeResult: { lat: number; lng: number; display_name: string } | null;
  osmVicinity?: OsmVicinity;
  osmOpenSpaces?: OsmOpenSpace[];
  osmBuildings?: OsmBuilding[];
  osmRouteGeometries?: OsmRouteGeometry[];
  areaSummary: string;
  areaStructured?: import('./warroomResearchService.js').AreaResearchStructured | null;
  hazardMaterialContext?: import('./warroomResearchService.js').HazardMaterialInference | null;
  sensitiveInfrastructure?:
    | import('./warroomResearchService.js').SensitiveInfrastructureStructured
    | null;
  similarCases: SimilarCase[];
  crowdDynamics: CrowdDynamicsResearch | null;
  typeSpec: Record<string, unknown>;
  settingSpec: Record<string, unknown>;
  terrainSpec: Record<string, unknown>;
  venueName: string;
  threatProfile: import('./warroomPromptParser.js').ThreatProfile | undefined;
}

export interface DoctrineResearchResult {
  standardsFindings: StandardsFinding[];
  perTeamDoctrines: Record<string, StandardsFinding[]>;
  perTeamForbiddenActions: Record<string, ForbiddenAction[]>;
  teamWorkflows: Record<string, TeamWorkflow>;
}

export async function stageParseAndGeocode(
  options: WarroomGenerateOptions,
  openAiApiKey: string,
  onProgress?: WarroomProgressCallback,
  geocodeOverride?: { lat: number; lng: number; display_name?: string } | null,
  skipHeavyOsm = false,
): Promise<ParseAndGeocodeResult> {
  let parsed: ParsedWarroomInput;

  if (options.prompt && !options.scenario_type) {
    onProgress?.('parsing', 'Parsing prompt and classifying scenario type, setting, terrain...');
    parsed = await parseFreeTextPrompt(options.prompt, openAiApiKey);
  } else {
    parsed = {
      scenario_type: options.scenario_type || 'car_bomb',
      setting: options.setting || 'office',
      terrain: options.terrain || 'urban',
      location: options.location || null,
      threat_profile: buildDefaultThreatProfile(options.scenario_type || 'car_bomb'),
    };
  }

  const validation = validateCompatibility(parsed.scenario_type, parsed.setting, parsed.terrain);
  if (!validation.valid) throw new Error(validation.message);

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
  if (!typeSpec || !settingSpec || !terrainSpec)
    throw new Error('Failed to load scenario templates');

  const venueName = parsed.venue_name || parsed.location || parsed.setting;
  const threatProfile = parsed.threat_profile;

  const hasOverride =
    geocodeOverride &&
    typeof geocodeOverride.lat === 'number' &&
    typeof geocodeOverride.lng === 'number';

  if (hasOverride) {
    onProgress?.('geocoding', 'Using pre-selected coordinates; skipping server-side geocoding.');
    logger.info(
      { lat: geocodeOverride!.lat, lng: geocodeOverride!.lng },
      'Skipping Nominatim — using client-supplied geocode override',
    );
  } else {
    onProgress?.(
      'geocoding',
      parsed.location
        ? `Resolving coordinates for "${parsed.location}"...`
        : 'No location specified; skipping geocoding.',
    );
  }
  onProgress?.('case_research', 'Researching similar real-world incidents...');

  const geocodePromise: Promise<{ lat: number; lng: number; display_name: string } | null> =
    hasOverride
      ? Promise.resolve({
          lat: geocodeOverride!.lat,
          lng: geocodeOverride!.lng,
          display_name: geocodeOverride!.display_name || venueName,
        })
      : parsed.location
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

  const [geocodeResult, similarCases, crowdDynamics] = await Promise.all([
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

  let osmVicinity: OsmVicinity | undefined;
  let osmOpenSpaces: OsmOpenSpace[] | undefined;
  let osmBuildings: OsmBuilding[] | undefined;
  let osmRouteGeometries: OsmRouteGeometry[] | undefined;
  if (geocodeResult) {
    onProgress?.(
      'osm',
      'Fetching nearby facilities, open spaces, building outlines, and route geometries...',
    );
    try {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const INITIAL_RADIUS_M = 10000;
      const cachedVicinity = await findCachedOsmVicinity(geocodeResult.lat, geocodeResult.lng);
      let vicinity =
        cachedVicinity ??
        (await fetchOsmVicinityByCoordinates(
          geocodeResult.lat,
          geocodeResult.lng,
          INITIAL_RADIUS_M,
        ));
      if (!cachedVicinity) await delay(1500);

      // Tiered expansion: if fewer than 2 hospitals found, widen search
      if ((vicinity.hospitals?.length ?? 0) < 2) {
        onProgress?.('osm', 'Expanding hospital search radius...');
        vicinity = await expandHospitalSearch(
          vicinity,
          geocodeResult.lat,
          geocodeResult.lng,
          INITIAL_RADIUS_M,
        );
      }

      let buildings: OsmBuilding[] = [];
      let spaces: OsmOpenSpace[] = [];
      let routeGeoms: OsmRouteGeometry[] = [];

      if (skipHeavyOsm) {
        logger.info('Skipping heavy OSM queries (trainer scene provides building/layout)');
      } else {
        const buildingRadii = [300, 450, 600];
        for (let attempt = 1; attempt <= 5; attempt++) {
          const radiusM = buildingRadii[Math.min(attempt - 1, buildingRadii.length - 1)];
          try {
            buildings = await fetchVenueBuilding(geocodeResult.lat, geocodeResult.lng, radiusM);
            if (buildings.length > 0) break;
          } catch (err) {
            logger.warn({ err, attempt, radiusM }, 'OSM venue building fetch failed');
          }
          if (attempt < 5) await delay(2000 * attempt);
        }
        await delay(1500);

        spaces = await fetchOsmOpenSpaces(geocodeResult.lat, geocodeResult.lng, 1500).catch(
          (err) => {
            logger.warn({ err }, 'OSM open spaces fetch failed; continuing without');
            return [] as OsmOpenSpace[];
          },
        );
        await delay(3000);

        routeGeoms = await fetchRouteGeometries(geocodeResult.lat, geocodeResult.lng, 6000).catch(
          (err) => {
            logger.warn({ err }, 'OSM route geometries fetch failed; continuing without');
            return [] as OsmRouteGeometry[];
          },
        );
      }

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

  const areaSummary = parsed.location
    ? await (() => {
        onProgress?.('area_research', 'Researching area: geography, agencies...');
        return researchArea(openAiApiKey, parsed.location!, venueName).catch(() => '');
      })()
    : '';

  let areaStructured: import('./warroomResearchService.js').AreaResearchStructured | null = null;
  let hazardMaterialContext: import('./warroomResearchService.js').HazardMaterialInference | null =
    null;
  let sensitiveInfrastructure:
    | import('./warroomResearchService.js').SensitiveInfrastructureStructured
    | null = null;

  if (parsed.location && areaSummary) {
    try {
      onProgress?.(
        'area_research',
        'Structuring research (establishment, utilities, sensitive sites)...',
      );
      const {
        extractAreaResearchStructured,
        inferHazardMaterialContext,
        extractSensitiveInfrastructureStructured,
      } = await import('./warroomResearchService.js');
      const venue = venueName || parsed.location!;

      areaStructured = await extractAreaResearchStructured(
        openAiApiKey,
        areaSummary,
        parsed.location!,
        venueName,
      );

      const [hazCtx, sensitive] = await Promise.all([
        inferHazardMaterialContext(openAiApiKey, areaStructured, parsed.scenario_type, venue),
        extractSensitiveInfrastructureStructured(
          openAiApiKey,
          areaSummary,
          parsed.location!,
          venue,
        ),
      ]);
      hazardMaterialContext = hazCtx;
      sensitiveInfrastructure = sensitive;
    } catch (err) {
      logger.warn({ err }, 'Structured research extraction failed; continuing without');
    }
  }

  // Log hospital source comparison for diagnostics
  const osmHospitalCount = osmVicinity?.hospitals?.length ?? 0;
  const researchHospitalCount = areaStructured?.emergency_facilities?.hospitals?.length ?? 0;
  if (osmHospitalCount > 0 || researchHospitalCount > 0) {
    const level = osmHospitalCount === 0 && researchHospitalCount > 0 ? 'warn' : 'info';
    logger[level](
      {
        osmHospitals: osmHospitalCount,
        researchHospitals: researchHospitalCount,
        osmNames: osmVicinity?.hospitals?.map((h) => h.name) ?? [],
        researchNames: areaStructured?.emergency_facilities?.hospitals?.map((h) => h.name) ?? [],
      },
      'Hospital source comparison (OSM vs area research)',
    );
  }

  // Fallback: if OSM still has no hospitals but area research found some,
  // geocode the research hospital names and inject them into osmVicinity.
  if (
    osmVicinity &&
    (osmVicinity.hospitals?.length ?? 0) === 0 &&
    areaStructured?.emergency_facilities?.hospitals?.length
  ) {
    const researchHospitals = areaStructured.emergency_facilities.hospitals;
    logger.warn(
      {
        osmHospitals: 0,
        researchHospitals: researchHospitals.length,
        names: researchHospitals.map((h) => h.name),
      },
      'OSM returned no hospitals but area research found some — geocoding research hospitals as fallback',
    );

    const fallbackHospitals: NonNullable<OsmVicinity['hospitals']> = [];
    const locationHint = parsed.location || venueName || '';
    for (const rh of researchHospitals.slice(0, 5)) {
      try {
        const query = `${rh.name}, ${locationHint}`;
        const result = await geocode(query);
        if (result) {
          fallbackHospitals.push({
            name: rh.name,
            lat: result.lat,
            lng: result.lng,
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
      } catch {
        logger.warn({ name: rh.name }, 'Research hospital geocoding failed; skipping');
      }
    }

    if (fallbackHospitals.length > 0) {
      osmVicinity.hospitals = fallbackHospitals;
      logger.info(
        { geocoded: fallbackHospitals.length },
        'Research hospitals geocoded and added to osm_vicinity',
      );
    }
  }

  return {
    parsed,
    geocodeResult,
    osmVicinity,
    osmOpenSpaces,
    osmBuildings,
    osmRouteGeometries,
    areaSummary,
    areaStructured,
    hazardMaterialContext,
    sensitiveInfrastructure,
    similarCases,
    crowdDynamics,
    typeSpec,
    settingSpec,
    terrainSpec,
    venueName,
    threatProfile,
  };
}

export async function stageTeamsAndNarrative(
  geoResult: ParseAndGeocodeResult,
  options: WarroomGenerateOptions,
  openAiApiKey: string,
  onProgress?: WarroomProgressCallback,
): Promise<{ phase1Preview: Phase1Result; userTeams: ReturnType<typeof buildUserTeams> }> {
  onProgress?.('ai', 'Generating scenario world: teams, injects, objectives, locations...');
  const aiProgress = (msg: string) => onProgress?.('ai', msg);
  const userTeams = buildUserTeams(options.teams);

  const phase1Preview = await generateTeamsAndCoreForResearch(
    {
      scenario_type: geoResult.parsed.scenario_type,
      setting: geoResult.parsed.setting,
      terrain: geoResult.parsed.terrain,
      location: geoResult.parsed.location,
      venue_name: geoResult.venueName,
      original_prompt: options.prompt || undefined,
      landmarks: geoResult.parsed.landmarks,
      osm_vicinity: geoResult.osmVicinity,
      geocode: geoResult.geocodeResult
        ? {
            lat: geoResult.geocodeResult.lat,
            lng: geoResult.geocodeResult.lng,
            display_name: geoResult.geocodeResult.display_name,
          }
        : undefined,
      complexity_tier: options.complexity_tier || 'full',
      typeSpec: geoResult.typeSpec,
      settingSpec: geoResult.settingSpec,
      terrainSpec: geoResult.terrainSpec,
      researchContext:
        geoResult.similarCases.length > 0 || geoResult.areaSummary || geoResult.crowdDynamics
          ? {
              area_summary: geoResult.areaSummary || undefined,
              area_structured: geoResult.areaStructured ?? undefined,
              hazard_material_context: geoResult.hazardMaterialContext ?? undefined,
              sensitive_infrastructure: geoResult.sensitiveInfrastructure ?? undefined,
              similar_cases: geoResult.similarCases.length > 0 ? geoResult.similarCases : undefined,
              crowd_dynamics: geoResult.crowdDynamics || undefined,
            }
          : undefined,
      userTeams,
      inject_profiles: options.inject_profiles,
      threat_profile: geoResult.threatProfile,
    },
    openAiApiKey,
    aiProgress,
  );

  return { phase1Preview, userTeams };
}

export function buildUserTeams(teams?: WarroomTeamInput[]) {
  return teams?.map((t) => ({
    team_name: t.team_name,
    team_description: t.team_description || '',
    min_participants: t.min_participants ?? 1,
    max_participants: t.max_participants ?? 10,
    is_investigative: (t as unknown as Record<string, unknown>).is_investigative === true,
  }));
}

export async function stageResearchDoctrines(
  phase1Preview: Phase1Result,
  geoResult: ParseAndGeocodeResult,
  userTeams: ReturnType<typeof buildUserTeams>,
  openAiApiKey: string,
  onProgress?: WarroomProgressCallback,
  sceneContext?: Record<string, unknown> | null,
): Promise<DoctrineResearchResult> {
  onProgress?.(
    'standards_research',
    'Researching response standards per team for this scenario...',
  );

  let standardsFindings: StandardsFinding[] = [];
  let perTeamDoctrines: Record<string, StandardsFinding[]> = {};
  let perTeamForbiddenActions: Record<string, ForbiddenAction[]> = {};

  const teamInputs: TeamInput[] =
    userTeams && userTeams.length > 0
      ? userTeams.map((t) => ({ team_name: t.team_name, team_description: t.team_description }))
      : phase1Preview.teams.map((t) => ({
          team_name: t.team_name,
          team_description: t.team_description || undefined,
        }));

  let sceneDescription = '';
  if (sceneContext) {
    const parts: string[] = [];
    if (sceneContext.building_name) parts.push(`Building: ${sceneContext.building_name}`);
    if (sceneContext.exits_count) parts.push(`${sceneContext.exits_count} exits`);
    if (sceneContext.stairwells_count) parts.push(`${sceneContext.stairwells_count} stairwells`);
    if (sceneContext.interior_walls_count)
      parts.push(`${sceneContext.interior_walls_count} interior walls`);
    if (sceneContext.has_blast_site) parts.push('blast site established');
    if (sceneContext.blast_radius) parts.push(`blast radius: ${sceneContext.blast_radius}m`);
    if (sceneContext.total_casualties)
      parts.push(
        `${sceneContext.total_casualties} total casualties across ${sceneContext.casualty_clusters} clusters`,
      );
    if (sceneContext.casualty_count) parts.push(`${sceneContext.casualty_count} casualty pins`);
    if (sceneContext.pedestrian_count) parts.push(`${sceneContext.pedestrian_count} evacuees`);

    // Game zones
    if (Array.isArray(sceneContext.game_zones) && sceneContext.game_zones.length > 0) {
      parts.push(`Operational zones: ${(sceneContext.game_zones as string[]).join(', ')}`);
    }

    // Basic hazard list
    if (Array.isArray(sceneContext.hazard_zones) && sceneContext.hazard_zones.length > 0) {
      parts.push(`Hazards: ${(sceneContext.hazard_zones as string[]).join(', ')}`);
    }

    if (parts.length > 0) sceneDescription = `\n\nPhysical scene setup: ${parts.join('. ')}.`;

    // Enrichment results — deep hazard analyses
    if (Array.isArray(sceneContext.hazard_analyses)) {
      const analyses = sceneContext.hazard_analyses as Array<Record<string, unknown>>;
      if (analyses.length > 0) {
        const hazardDetails = analyses
          .map(
            (h) =>
              `  - ${h.material || h.id}: Risk=${h.risk}. ${h.blast_interaction || ''} Secondary effects: ${Array.isArray(h.secondary_effects) ? (h.secondary_effects as string[]).join(', ') : 'none'}. Chain reaction risk: ${h.chain_risk || 'none'}.`,
          )
          .join('\n');
        sceneDescription += `\n\nDetailed hazard analysis:\n${hazardDetails}`;
      }
    }

    // Enrichment synthesis
    if (sceneContext.scene_synthesis) {
      const syn = sceneContext.scene_synthesis as Record<string, unknown>;
      if (Array.isArray(syn.chainReactions) && syn.chainReactions.length > 0) {
        sceneDescription += `\n\nChain reaction risks: ${(syn.chainReactions as string[]).join('; ')}`;
      }
      if (syn.escalationTimeline) {
        sceneDescription += `\n\nEscalation timeline: ${syn.escalationTimeline}`;
      }
      if (Array.isArray(syn.keyChallenges) && syn.keyChallenges.length > 0) {
        sceneDescription += `\n\nKey challenges: ${(syn.keyChallenges as string[]).join('; ')}`;
      }
    }

    // Overall enrichment assessment
    if (sceneContext.enrichment_assessment) {
      sceneDescription += `\n\nScene assessment: ${sceneContext.enrichment_assessment}`;
    }

    // Casualty profiles
    if (Array.isArray(sceneContext.casualty_profiles)) {
      const profiles = sceneContext.casualty_profiles as Array<Record<string, unknown>>;
      if (profiles.length > 0) {
        const casDetails = profiles
          .slice(0, 15)
          .map(
            (c) =>
              `  - ${c.id}: ${((c.tag as string) || '').toUpperCase()} — ${c.description || 'no description'}`,
          )
          .join('\n');
        sceneDescription += `\n\nCasualty profiles:\n${casDetails}`;
      }
    }
  }

  const narrativeCtx = {
    title: phase1Preview.scenario.title,
    description: phase1Preview.scenario.description + sceneDescription,
    briefing: phase1Preview.scenario.briefing,
  };

  try {
    const [standardsResult, forbiddenResult] = await Promise.all([
      researchStandardsPerTeam(
        openAiApiKey,
        geoResult.parsed.scenario_type,
        teamInputs,
        narrativeCtx,
      ),
      researchForbiddenActionsPerTeam(
        openAiApiKey,
        geoResult.parsed.scenario_type,
        teamInputs,
        narrativeCtx,
      ),
    ]);
    standardsFindings = standardsResult.allFindings;
    perTeamDoctrines = standardsResult.teamDoctrines;
    perTeamForbiddenActions = forbiddenResult;
  } catch (err) {
    logger.warn({ err }, 'Standards / forbidden actions research failed; continuing without');
  }

  const teamNames =
    userTeams?.map((t) => t.team_name) ?? phase1Preview.teams.map((t) => t.team_name);
  let teamWorkflows: Record<string, TeamWorkflow> = {};
  try {
    teamWorkflows = await researchTeamWorkflows(
      openAiApiKey,
      geoResult.parsed.scenario_type,
      teamNames,
      narrativeCtx,
    );
  } catch (err) {
    logger.warn({ err }, 'Team workflow research failed; continuing without');
  }

  return { standardsFindings, perTeamDoctrines, perTeamForbiddenActions, teamWorkflows };
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
  // Stage 1: Parse prompt, geocode, fetch OSM data, area research, similar cases
  const geoResult = await stageParseAndGeocode(options, openAiApiKey, onProgress);

  // Stage 2: Generate Phase 1 (teams + narrative)
  const { phase1Preview, userTeams } = await stageTeamsAndNarrative(
    geoResult,
    options,
    openAiApiKey,
    onProgress,
  );

  // Stage 3: Research doctrines & workflows
  const doctrines = await stageResearchDoctrines(
    phase1Preview,
    geoResult,
    userTeams,
    openAiApiKey,
    onProgress,
  );

  // Stage 4: Full generation
  return stageGenerateAndPersist(
    geoResult,
    phase1Preview,
    userTeams,
    doctrines,
    options,
    openAiApiKey,
    createdBy,
    onProgress,
  );
}

/**
 * Merge the deterioration specialist output back into the scenario payload.
 * Enriches existing hazard/casualty timelines and appends spawn pins.
 */
function mergeDeteriorationResult(
  payload: WarroomScenarioPayload,
  det: DeteriorationTimelineResult,
): void {
  // Enrich existing hazard deterioration timelines
  for (const eh of det.enriched_hazard_timelines) {
    const match = (payload.hazards ?? []).find(
      (h) => ((h as Record<string, unknown>).label ?? h.hazard_type) === eh.hazard_label,
    );
    if (match) {
      if (!match.properties) match.properties = {} as Record<string, unknown>;
      (match.properties as Record<string, unknown>).deterioration_timeline =
        eh.deterioration_timeline;
    }
  }

  // Enrich existing casualty deterioration timelines
  for (const ec of det.enriched_casualty_timelines) {
    const cas = (payload.casualties ?? [])[ec.casualty_index];
    if (cas && cas.conditions) {
      (cas.conditions as Record<string, unknown>).deterioration_timeline =
        ec.deterioration_timeline;
    }
  }

  // Append spawn pins — these will be persisted with parent_pin_id + spawn_condition
  if (!payload.hazards) payload.hazards = [] as unknown as typeof payload.hazards;
  if (!payload.casualties) payload.casualties = [] as unknown as typeof payload.casualties;

  for (const sp of det.spawn_pins) {
    const parentHazard = payload.hazards!.find(
      (h) => ((h as Record<string, unknown>).label ?? h.hazard_type) === sp.parent_pin_label,
    );
    const parentLat = parentHazard?.location_lat ?? 0;
    const parentLng = parentHazard?.location_lng ?? 0;
    const latOff = Number.isFinite(sp.lat_offset) ? sp.lat_offset : 0;
    const lngOff = Number.isFinite(sp.lng_offset) ? sp.lng_offset : 0;

    if (sp.pin_type === 'hazard') {
      (payload.hazards as Array<Record<string, unknown>>).push({
        hazard_type: sp.hazard_type || 'secondary_hazard',
        label: sp.label,
        location_lat: parentLat + latOff,
        location_lng: parentLng + lngOff,
        floor_level: sp.floor_level || 'G',
        status: 'delayed',
        appears_at_minutes: sp.appears_at_minutes,
        properties: {
          ...sp.properties,
          description: sp.description,
        },
        _parent_pin_label: sp.parent_pin_label,
        _spawn_condition: sp.spawn_condition,
      });
    } else {
      (payload.casualties as Array<Record<string, unknown>>).push({
        casualty_type: sp.casualty_type || 'patient',
        location_lat: parentLat + latOff,
        location_lng: parentLng + lngOff,
        floor_level: sp.floor_level || 'G',
        headcount: sp.headcount ?? 1,
        status: 'delayed',
        appears_at_minutes: sp.appears_at_minutes,
        conditions: {
          ...sp.conditions,
          visible_description: sp.description,
        },
        _parent_pin_label: sp.parent_pin_label,
        _spawn_condition: sp.spawn_condition,
      });
    }
  }

  // Store cascade narrative in insider_knowledge
  if (det.cascade_narrative) {
    if (!payload.insider_knowledge) payload.insider_knowledge = {};
    (payload.insider_knowledge as Record<string, unknown>).cascade_narrative =
      det.cascade_narrative;
  }
}

/**
 * Stage 4+5 combined: full AI generation + persistence.
 * Accepts pre-computed stage results so wizard mode can inject validated data.
 */
export async function stageGenerateAndPersist(
  geoResult: ParseAndGeocodeResult,
  phase1Preview: Phase1Result,
  userTeams: ReturnType<typeof buildUserTeams>,
  doctrines: DoctrineResearchResult,
  options: WarroomGenerateOptions,
  openAiApiKey: string,
  createdBy: string,
  onProgress?: WarroomProgressCallback,
): Promise<{ scenarioId: string; payload: WarroomScenarioPayload }> {
  const { parsed, geocodeResult, areaSummary, similarCases, crowdDynamics } = geoResult;
  const { standardsFindings, perTeamDoctrines, perTeamForbiddenActions } = doctrines;
  const aiProgress = (msg: string) => onProgress?.('ai', msg);

  // Load trainer scene if rts_scene_id is present in scene_context
  let trainerScene: TrainerScene | undefined;
  let sceneStudGrids: import('./buildingStudService.js').StudGrid[] | undefined;
  let sceneLocationDescription: string | undefined;
  const sceneCtx = options.scene_context;
  const rtsSceneId = sceneCtx?.rts_scene_id as string | undefined;
  if (rtsSceneId) {
    try {
      const { data: sceneRow } = await supabaseAdmin
        .from('rts_scene_configs')
        .select('*')
        .eq('id', rtsSceneId)
        .single();

      if (sceneRow) {
        const buildingPolygon = sceneRow.building_polygon as [number, number][] | null;
        const blastSiteRaw = sceneRow.blast_site as {
          x: number;
          y: number;
          radius?: number;
          weaponType?: string;
          locationDescription?: string;
          gameZones?: Array<{ type: string; radius: number; center?: { x: number; y: number } }>;
        } | null;
        const hazardZonesRaw = (sceneRow.hazard_zones as Array<Record<string, unknown>>) || [];
        const exitsRaw = (sceneRow.exits as Array<Record<string, unknown>>) || [];
        const interiorWallsRaw = (sceneRow.interior_walls as Array<Record<string, unknown>>) || [];
        const enrichmentResult = sceneRow.enrichment_result as Record<string, unknown> | null;
        sceneLocationDescription = blastSiteRaw?.locationDescription;

        if (buildingPolygon && buildingPolygon.length >= 3) {
          const blastLatLng = blastSiteRaw ? simToLatLng(blastSiteRaw, buildingPolygon) : null;

          // Resolve planted items with positions from wall inspection points
          const plantedItemsRaw = (sceneRow.planted_items as Array<Record<string, unknown>>) || [];
          const wallPointsRaw =
            (sceneRow.wall_inspection_points as Array<Record<string, unknown>>) || [];
          const wallPointMap = new Map<string, { lat: number; lng: number }>();
          for (const wp of wallPointsRaw) {
            wallPointMap.set(wp.id as string, {
              lat: wp.lat as number,
              lng: wp.lng as number,
            });
          }
          const plantedItems = plantedItemsRaw
            .map((p) => {
              const wpId = p.wallPointId as string;
              const wpPos = wallPointMap.get(wpId);
              if (!wpPos) return null;
              return {
                id: (p.id as string) || `pi-${Math.random().toString(36).slice(2, 8)}`,
                wallPointId: wpId,
                description: (p.description as string) || '',
                threatLevel:
                  (p.threatLevel as 'decoy' | 'real_device' | 'secondary_device') || 'decoy',
                concealmentDifficulty:
                  (p.concealmentDifficulty as 'easy' | 'moderate' | 'hard') || 'moderate',
                detonationTimer: (p.detonationTimer as number) ?? null,
                lat: wpPos.lat,
                lng: wpPos.lng,
              };
            })
            .filter((p): p is NonNullable<typeof p> => p !== null);

          trainerScene = {
            rtsSceneId,
            blastSite: blastLatLng
              ? { lat: blastLatLng.lat, lng: blastLatLng.lng, radius: blastSiteRaw?.radius }
              : null,
            hazards: hazardZonesRaw.map((h) => {
              const pos = (h.pos as { x: number; y: number }) || { x: 0, y: 0 };
              const geo = simToLatLng(pos, buildingPolygon);
              return {
                id: (h.id as string) || `haz-${Math.random().toString(36).slice(2, 8)}`,
                lat: geo.lat,
                lng: geo.lng,
                hazardType: (h.hazardType as string) || 'unknown',
                severity: (h.severity as string) || 'medium',
                description: (h.description as string) || '',
                radius: (h.radius as number) || 5,
                photos: (h.photos as string[]) || [],
              };
            }),
            exits: exitsRaw.map((e) => {
              const pos = (e.pos as { x: number; y: number }) || { x: 0, y: 0 };
              const geo = simToLatLng(pos, buildingPolygon);
              return {
                id: (e.id as string) || `exit-${Math.random().toString(36).slice(2, 8)}`,
                lat: geo.lat,
                lng: geo.lng,
                width: (e.width as number) || 2,
                status: (e.status as string) || 'open',
                description: (e.description as string) || '',
              };
            }),
            buildingPolygon,
            buildingName: (sceneRow.building_name as string) || null,
            pedestrianCount: (sceneRow.pedestrian_count as number) || 120,
            plantedItems,
            interiorWalls: interiorWallsRaw.map((w) => ({
              id: (w.id as string) || `iw-${Math.random().toString(36).slice(2, 8)}`,
              start: (w.start as { x: number; y: number }) || { x: 0, y: 0 },
              end: (w.end as { x: number; y: number }) || { x: 0, y: 0 },
              material: (w.material as string) || '',
              description: (w.description as string) || '',
              hasDoor: (w.hasDoor as boolean) || false,
              photos: (w.photos as string[]) || [],
            })),
            enrichment: enrichmentResult
              ? {
                  hazardAnalysis: (enrichmentResult.hazardAnalysis ?? []) as Array<
                    Record<string, unknown>
                  >,
                  sceneSynthesis: (enrichmentResult.sceneSynthesis ?? {}) as Record<
                    string,
                    unknown
                  >,
                  overallAssessment: (enrichmentResult.overallAssessment ?? '') as string,
                  generatedCasualties: (enrichmentResult.generatedCasualties ?? []) as Array<
                    Record<string, unknown>
                  >,
                  enrichedCasualties: (enrichmentResult.enrichedCasualties ?? []) as Array<
                    Record<string, unknown>
                  >,
                }
              : undefined,
          };

          sceneStudGrids = generateStudGrids(
            [
              {
                name: trainerScene.buildingName,
                lat: buildingPolygon.reduce((s, p) => s + p[0], 0) / buildingPolygon.length,
                lng: buildingPolygon.reduce((s, p) => s + p[1], 0) / buildingPolygon.length,
                bounds: null,
                footprint_polygon: buildingPolygon,
                distance_from_center_m: 0,
              },
            ],
            5,
            blastLatLng ? { lat: blastLatLng.lat, lng: blastLatLng.lng } : undefined,
            true,
          );

          logger.info(
            {
              rtsSceneId,
              hazards: trainerScene.hazards.length,
              exits: trainerScene.exits.length,
              plantedItems: trainerScene.plantedItems.length,
              studs: sceneStudGrids.reduce((s, g) => s + g.studs.length, 0),
              hasEnrichment: !!trainerScene.enrichment,
            },
            'Trainer scene loaded for scenario generation',
          );
        }
      }
    } catch (err) {
      logger.warn({ err, rtsSceneId }, 'Failed to load trainer scene; continuing without');
    }
  }

  // Override any outdoor setting to indoor when blast is inside a building
  const OUTDOOR_SETTINGS = new Set([
    'open_field',
    'park',
    'beach',
    'street',
    'waterfront',
    'stadium',
  ]);
  if (trainerScene?.blastSite && trainerScene.buildingName) {
    if (OUTDOOR_SETTINGS.has(parsed.setting)) {
      const prev = parsed.setting;
      parsed.setting = 'office';
      logger.info(
        { buildingName: trainerScene.buildingName, from: prev, to: 'office' },
        'Overriding outdoor setting to office (blast inside building)',
      );
    }
  }

  // Inject indoor explosion context into the prompt
  let indoorContext = '';
  if (trainerScene?.blastSite && trainerScene.buildingName) {
    indoorContext = `CRITICAL: The explosive device was detonated INSIDE ${trainerScene.buildingName}. This is an INDOOR explosion. All blast damage, casualties, fire, and debris are contained within the building interior. Do NOT describe this as an outdoor or open-air explosion.`;
  }

  const payload = await warroomGenerateScenario(
    {
      scenario_type: parsed.scenario_type,
      setting: parsed.setting,
      terrain: parsed.terrain,
      location: parsed.location || sceneLocationDescription || null,
      venue_name: geoResult.venueName || trainerScene?.buildingName || undefined,
      original_prompt: indoorContext
        ? `${indoorContext}\n\n${options.prompt || ''}`
        : options.prompt || undefined,
      landmarks: parsed.landmarks,
      osm_vicinity: geoResult.osmVicinity,
      osmOpenSpaces: geoResult.osmOpenSpaces,
      osmBuildings: geoResult.osmBuildings,
      osmRouteGeometries: geoResult.osmRouteGeometries,
      geocode: geocodeResult
        ? {
            lat: geocodeResult.lat,
            lng: geocodeResult.lng,
            display_name: geocodeResult.display_name,
          }
        : undefined,
      complexity_tier: options.complexity_tier || 'full',
      duration_minutes: options.duration_minutes || 60,
      typeSpec: geoResult.typeSpec,
      settingSpec: geoResult.settingSpec,
      terrainSpec: geoResult.terrainSpec,
      researchContext:
        areaSummary ||
        standardsFindings.length > 0 ||
        similarCases.length > 0 ||
        crowdDynamics ||
        Object.keys(perTeamDoctrines).length > 0 ||
        Object.keys(perTeamForbiddenActions).length > 0
          ? {
              area_summary: areaSummary || undefined,
              area_structured: geoResult.areaStructured ?? undefined,
              hazard_material_context: geoResult.hazardMaterialContext ?? undefined,
              sensitive_infrastructure: geoResult.sensitiveInfrastructure ?? undefined,
              standards_findings: standardsFindings.length > 0 ? standardsFindings : undefined,
              team_doctrines:
                Object.keys(perTeamDoctrines).length > 0 ? perTeamDoctrines : undefined,
              forbidden_actions:
                Object.keys(perTeamForbiddenActions).length > 0
                  ? perTeamForbiddenActions
                  : undefined,
              similar_cases: similarCases.length > 0 ? similarCases : undefined,
              crowd_dynamics: crowdDynamics || undefined,
            }
          : undefined,
      userTeams,
      phase1Preview,
      inject_profiles: options.inject_profiles,
      threat_profile: geoResult.threatProfile,
      secondary_devices_count: options.secondary_devices_count,
      real_bombs_count: options.real_bombs_count,
      trainerScene,
      studGrids: sceneStudGrids,
    },
    openAiApiKey,
    aiProgress,
  );

  // Adversary pursuit decision tree
  const hasInvestigativeTeam = userTeams?.some((t) => t.is_investigative) ?? false;
  const pursuitToggle = hasInvestigativeTeam ? (options.include_adversary_pursuit ?? true) : false;
  if (!pursuitToggle) {
    logger.info('Adversary pursuit: skipped (no investigative team)');
  }
  if (pursuitToggle)
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
          typeSpec: geoResult.typeSpec,
          settingSpec: geoResult.settingSpec,
          terrainSpec: geoResult.terrainSpec,
          complexity_tier: options.complexity_tier || 'full',
          threat_profile: geoResult.threatProfile,
        },
        payloadLocations,
        payloadTeamNames,
        openAiApiKey,
        pursuitNarrative,
        (msg: string) => onProgress?.('ai', msg),
        pursuitToggle,
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

  // Phase 4d: Deterioration specialist AI
  try {
    onProgress?.('ai', 'Researching deterioration physics...');
    const detResearch = await researchDeteriorationPhysics(
      (payload.hazards ?? []).map((h) => ({
        label: ((h as Record<string, unknown>).label as string) ?? h.hazard_type,
        hazard_type: h.hazard_type,
        properties: h.properties as Record<string, unknown> | undefined,
      })),
      (payload.casualties ?? []).map((c) => ({
        casualty_type: c.casualty_type,
        conditions: c.conditions as Record<string, unknown> | undefined,
      })),
      areaSummary || '',
      geoResult.venueName || parsed.location || '',
      openAiApiKey,
    );

    if (detResearch) {
      onProgress?.('ai', 'Generating deterioration timeline...');
      const detPromptBlock = deteriorationResearchToPromptBlock(detResearch);

      const detResult = await generateDeteriorationTimeline(
        (payload.hazards ?? []).map((h) => ({
          label: ((h as Record<string, unknown>).label as string) ?? h.hazard_type,
          hazard_type: h.hazard_type,
          location_lat: h.location_lat,
          location_lng: h.location_lng,
          properties: h.properties as Record<string, unknown> | undefined,
        })),
        (payload.casualties ?? []).map((c) => ({
          casualty_type: c.casualty_type,
          location_lat: c.location_lat,
          location_lng: c.location_lng,
          conditions: c.conditions as Record<string, unknown> | undefined,
          headcount: c.headcount,
        })),
        (payload.locations ?? []).map((l) => ({
          label: l.label,
          location_type: l.location_type || l.pin_category || '',
          lat: l.coordinates?.lat ?? 0,
          lng: l.coordinates?.lng ?? 0,
        })),
        detPromptBlock,
        geoResult.venueName || parsed.location || '',
        openAiApiKey,
      );

      if (detResult) {
        mergeDeteriorationResult(payload, detResult);
        logger.info(
          {
            enrichedHazards: detResult.enriched_hazard_timelines.length,
            enrichedCasualties: detResult.enriched_casualty_timelines.length,
            spawnPins: detResult.spawn_pins.length,
          },
          'Deterioration timeline merged into scenario payload',
        );
      }
    }
  } catch (detErr) {
    logger.warn({ err: detErr }, 'Deterioration specialist failed; continuing without');
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
    osmBuildings: geoResult.osmBuildings,
  });

  // If buildings were empty, schedule a background backfill (non-blocking)
  if (!geoResult.osmBuildings?.length && finalCenterLat != null) {
    const BACKFILL_DELAY_MS = 10_000;
    setTimeout(() => {
      logger.info({ scenarioId }, 'Starting deferred building backfill');
      backfillBuildingsForScenario(scenarioId).catch((err) =>
        logger.warn({ err, scenarioId }, 'Deferred building backfill failed (non-blocking)'),
      );
    }, BACKFILL_DELAY_MS);
  }

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
