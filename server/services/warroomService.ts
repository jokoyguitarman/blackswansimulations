/**
 * War Room Service
 * Orchestrates prompt parsing, geocoding, OSM vicinity, AI generation, and persistence.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js';
import { geocode } from './geocodingService.js';
import { fetchOsmVicinityByCoordinates } from './osmVicinityService.js';
import {
  parseFreeTextPrompt,
  validateCompatibility,
  type ParsedWarroomInput,
} from './warroomPromptParser.js';
import { warroomGenerateScenario, type WarroomScenarioPayload } from './warroomAiService.js';
import { persistWarroomScenario } from './warroomPersistenceService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WarroomGenerateOptions {
  prompt?: string;
  scenario_type?: string;
  setting?: string;
  terrain?: string;
  location?: string;
  complexity_tier?: 'minimal' | 'standard' | 'full' | 'rich';
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

/**
 * Generate and persist a War Room scenario.
 */
export async function generateAndPersistWarroomScenario(
  options: WarroomGenerateOptions,
  openAiApiKey: string,
  createdBy: string,
): Promise<{ scenarioId: string; payload: WarroomScenarioPayload }> {
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

  let geocodeResult = null;
  let osmVicinity = undefined;

  if (parsed.location) {
    geocodeResult = await geocode(parsed.location);
    if (geocodeResult) {
      try {
        osmVicinity = await fetchOsmVicinityByCoordinates(
          geocodeResult.lat,
          geocodeResult.lng,
          3000,
        );
      } catch (osmErr) {
        logger.warn(
          { err: osmErr, location: parsed.location },
          'OSM vicinity fetch failed; continuing without',
        );
      }
    }
  }

  const payload = await warroomGenerateScenario(
    {
      scenario_type: parsed.scenario_type,
      setting: parsed.setting,
      terrain: parsed.terrain,
      location: parsed.location,
      venue_name: parsed.location || parsed.setting,
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
    },
    openAiApiKey,
  );

  const scenarioId = await persistWarroomScenario(payload, createdBy, {
    center_lat: geocodeResult?.lat,
    center_lng: geocodeResult?.lng,
    vicinity_radius_meters: geocodeResult ? 3000 : undefined,
  });

  return { scenarioId, payload };
}
