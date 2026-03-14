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
} from './osmVicinityService.js';
import {
  parseFreeTextPrompt,
  validateCompatibility,
  type ParsedWarroomInput,
} from './warroomPromptParser.js';
import { warroomGenerateScenario, type WarroomScenarioPayload } from './warroomAiService.js';
import { persistWarroomScenario } from './warroomPersistenceService.js';
import {
  researchArea,
  researchStandards,
  researchSimilarCases,
  type StandardsFinding,
  type SimilarCase,
} from './warroomResearchService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const venueName = parsed.venue_name || parsed.location || parsed.setting;
  const teamNames = options.teams?.map((t) => t.team_name) ?? [];

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

  [geocodeResult, similarCases] = await Promise.all([
    geocodePromise,
    researchSimilarCases(
      openAiApiKey,
      parsed.scenario_type,
      parsed.location ?? undefined,
      venueName,
      parsed.setting,
    ).catch(() => []),
  ]);

  logger.info({ found: similarCases.length }, 'Similar cases research done');

  let osmVicinity = undefined;
  let osmOpenSpaces: import('./osmVicinityService.js').OsmOpenSpace[] | undefined;
  let osmBuildings: import('./osmVicinityService.js').OsmBuilding[] | undefined;
  if (geocodeResult) {
    onProgress?.('osm', 'Fetching nearby facilities, open spaces, and building outlines...');
    try {
      const [vicinity, spaces, buildings] = await Promise.all([
        fetchOsmVicinityByCoordinates(geocodeResult.lat, geocodeResult.lng, 10000),
        fetchOsmOpenSpaces(geocodeResult.lat, geocodeResult.lng, 1500).catch((err) => {
          logger.warn({ err }, 'OSM open spaces fetch failed; continuing without');
          return [] as import('./osmVicinityService.js').OsmOpenSpace[];
        }),
        fetchVenueBuilding(geocodeResult.lat, geocodeResult.lng, 300).catch((err) => {
          logger.warn({ err }, 'OSM venue building fetch failed; continuing without');
          return [] as import('./osmVicinityService.js').OsmBuilding[];
        }),
      ]);
      osmVicinity = vicinity;
      osmOpenSpaces = spaces.length > 0 ? spaces : undefined;
      osmBuildings = buildings.length > 0 ? buildings : undefined;
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
        similarCases.length > 0
          ? { area_summary: areaSummary || undefined, similar_cases: similarCases }
          : areaSummary
            ? { area_summary: areaSummary }
            : undefined,
      userTeams,
    },
    openAiApiKey,
    aiProgress,
  );

  // Phase C: narrative-driven standards research using the real story
  onProgress?.(
    'standards_research',
    'Researching response standards for this specific scenario...',
  );
  let standardsFindings: StandardsFinding[] = [];
  try {
    standardsFindings = await researchStandards(
      openAiApiKey,
      parsed.scenario_type,
      teamNames.length > 0 ? teamNames : phase1Preview.teams.map((t) => t.team_name),
      {
        title: phase1Preview.scenario.title,
        description: phase1Preview.scenario.description,
        briefing: phase1Preview.scenario.briefing,
      },
    );
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
        areaSummary || standardsFindings.length > 0 || similarCases.length > 0
          ? {
              area_summary: areaSummary || undefined,
              standards_findings: standardsFindings.length > 0 ? standardsFindings : undefined,
              similar_cases: similarCases.length > 0 ? similarCases : undefined,
            }
          : undefined,
      userTeams,
      phase1Preview,
    },
    openAiApiKey,
    aiProgress,
  );

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

  onProgress?.('persist', 'Saving scenario to database: teams, injects, objectives...');
  const scenarioId = await persistWarroomScenario(payload, createdBy, {
    center_lat: geocodeResult?.lat,
    center_lng: geocodeResult?.lng,
    vicinity_radius_meters: geocodeResult ? 10000 : undefined,
  });

  return { scenarioId, payload };
}
