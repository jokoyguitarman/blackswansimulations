/**
 * War Room Prompt Parser
 * Extracts scenario_type, setting, terrain, location from free-text or structured input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ParsedWarroomInput {
  scenario_type: string;
  setting: string;
  terrain: string;
  location: string | null;
  venue_name?: string;
  landmarks?: string[];
}

const SCENARIO_TYPES = [
  'open_field_shooting',
  'knife_attack',
  'gas_attack',
  'kidnapping',
  'car_bomb',
  'bombing_mall',
  'bombing',
  'hijacking',
  'suicide_bombing',
  'poisoning',
  'infrastructure_attack',
  'active_shooter',
  'arson',
  'vehicle_ramming',
  'hostage_siege',
];
const SETTINGS = [
  'beach',
  'subway',
  'mall',
  'resort',
  'hotel',
  'train',
  'open_field',
  'market',
  'street',
  'office',
  'park',
  'worship',
  'industrial',
  'government',
  'campus',
  'airport',
  'stadium',
  'hospital',
  'waterfront',
];
const TERRAINS = ['jungle', 'mountain', 'coastal', 'desert', 'urban', 'rural', 'swamp', 'island'];

interface ScenarioTypeSpec {
  id: string;
  compatible_settings?: string[];
  compatible_terrains?: string[];
}

interface SettingSpec {
  id: string;
  compatible_terrains?: string[];
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
 * Validate scenario_type × setting × terrain compatibility using template specs.
 */
export function validateCompatibility(
  scenarioType: string,
  setting: string,
  terrain: string,
): { valid: boolean; message?: string } {
  const templatesDir = getTemplatesDir();
  const typeSpec = loadJson<ScenarioTypeSpec>(
    path.join(templatesDir, 'scenario_types', `${scenarioType}.json`),
  );
  const settingSpec = loadJson<SettingSpec>(path.join(templatesDir, 'settings', `${setting}.json`));

  if (!typeSpec) {
    return { valid: false, message: `Unknown scenario type: ${scenarioType}` };
  }
  if (!settingSpec) {
    return { valid: false, message: `Unknown setting: ${setting}` };
  }
  if (!TERRAINS.includes(terrain)) {
    return { valid: false, message: `Unknown terrain: ${terrain}` };
  }

  // Compatibility checks removed: any incident type can occur at any
  // location the player chooses. The AI adapts the scenario narrative
  // to fit unconventional combinations (e.g. car bomb on a campus).
  // The compatible_settings / compatible_terrains fields in template
  // JSON files are retained for reference but no longer enforced.

  return { valid: true };
}

/**
 * Parse free-text prompt using LLM to extract structured input.
 */
export async function parseFreeTextPrompt(
  prompt: string,
  openAiApiKey: string,
): Promise<ParsedWarroomInput> {
  const scenarioTypesList = SCENARIO_TYPES.join(', ');
  const settingsList = SETTINGS.join(', ');
  const terrainsList = TERRAINS.join(', ');

  const systemPrompt = `You are a scenario classifier. Extract structured parameters from the user's scenario description.

Return ONLY valid JSON in this exact format:
{
  "scenario_type": "one of: ${scenarioTypesList}",
  "setting": "one of: ${settingsList}",
  "terrain": "one of: ${terrainsList}",
  "location": "geographic place (city, country) if mentioned, e.g. 'Davao, Philippines', or null",
  "venue_name": "the specific venue/site name the user mentioned, e.g. 'Roxas Night Market', 'Jurong Point', or null",
  "landmarks": ["nearby landmarks the user mentioned, e.g. 'Ateneo de Davao University'"]
}

Scenario type rules:
- bombing_mall: ONLY for bombings explicitly inside an enclosed multi-storey shopping mall
- bombing: any other bombing — outdoor markets, streets, open-air venues, general IED/explosive attack
- car_bomb: specifically a vehicle-borne explosive (VBIED), car bomb
- suicide_bombing: person-borne IED, suicide vest, suicide bomber walking into a crowd
- hijacking: vehicle, aircraft, bus, or train hijacking/seizure
- hostage_siege: armed takeover of a building with hostages held inside (barricade situation)
- kidnapping: abduction of specific individuals, ransom situation (smaller scale than siege)
- active_shooter: gunman inside an enclosed building (office, school, mall, etc.)
- open_field_shooting: mass shooting in an open/outdoor area (park, field, concert, parade)
- knife_attack: knife, blade, machete, or edged-weapon attack
- gas_attack: chemical agent, nerve agent, or gas release
- poisoning: water supply contamination, food poisoning attack, deliberate toxic substance
- infrastructure_attack: attack on critical infrastructure — oil refinery, desalination plant, power station, dam, water treatment
- arson: deliberate fire-setting, incendiary attack
- vehicle_ramming: vehicle deliberately driven into pedestrians (not an explosion)

Setting rules:
- market: outdoor markets, night markets, bazaars, food bazaars, street food markets — NOT enclosed malls
- street: street-level, roadside, intersection, boulevard, avenue
- mall: enclosed shopping centres/malls only
- office: corporate buildings, office towers, business centres
- park: public parks, gardens, recreational grounds
- worship: churches, mosques, temples, synagogues, places of worship
- industrial: oil refineries, desalination plants, factories, power stations, water treatment plants
- government: government buildings, courthouses, civic centres, embassies
- campus: schools, universities, educational institutions
- airport: airport terminals, runways, aviation facilities
- stadium: sports stadiums, arenas, concert venues, amphitheatres
- hospital: hospitals, clinics, medical facilities
- waterfront: ports, harbours, piers, marinas, docks
- resort: resort complexes, holiday compounds
- hotel: hotels, lodgings
- subway: underground metro, subway stations
- train: train stations, railway carriages
- beach: beaches, coastal recreational areas
- open_field: any open-air venue that does not fit the more specific settings above

Other rules:
- location should be the geographic place (city/region, country) — NOT the venue name itself
- venue_name should be the specific venue/site name the user mentioned (if any)
- landmarks should list any nearby landmarks, buildings, or institutions the user referenced
- If no real location is mentioned, set location to null
- If no venue name is mentioned, set venue_name to null
- If no landmarks are mentioned, set landmarks to []
- Pick the MOST SPECIFIC scenario type and setting that matches. Do not default to generic options when a specific one fits.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      (err as { error?: { message?: string } }).error?.message ||
        `OpenAI API error: ${response.status}`,
    );
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content from OpenAI');
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  const scenario_type = String(parsed.scenario_type || 'car_bomb')
    .toLowerCase()
    .replace(/\s+/g, '_');
  const setting = String(parsed.setting || 'open_field')
    .toLowerCase()
    .replace(/\s+/g, '_');
  const terrain = String(parsed.terrain || 'urban')
    .toLowerCase()
    .replace(/\s+/g, '_');
  const location =
    parsed.location != null && parsed.location !== '' ? String(parsed.location) : null;
  const venue_name =
    parsed.venue_name != null && parsed.venue_name !== '' ? String(parsed.venue_name) : undefined;
  const landmarks = Array.isArray(parsed.landmarks)
    ? (parsed.landmarks.filter((l) => typeof l === 'string' && l.trim() !== '') as string[])
    : undefined;

  return {
    scenario_type: SCENARIO_TYPES.includes(scenario_type) ? scenario_type : 'car_bomb',
    setting: SETTINGS.includes(setting) ? setting : 'open_field',
    terrain: TERRAINS.includes(terrain) ? terrain : 'urban',
    location,
    venue_name: venue_name || undefined,
    landmarks: landmarks && landmarks.length > 0 ? landmarks : undefined,
  };
}
