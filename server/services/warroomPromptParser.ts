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
}

const SCENARIO_TYPES = [
  'open_field_shooting',
  'knife_attack',
  'gas_attack',
  'kidnapping',
  'car_bomb',
  'bombing_mall',
];
const SETTINGS = ['beach', 'subway', 'mall', 'resort', 'hotel', 'train', 'open_field'];
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

  if (typeSpec.compatible_settings && !typeSpec.compatible_settings.includes(setting)) {
    return {
      valid: false,
      message: `Scenario type "${scenarioType}" is not compatible with setting "${setting}"`,
    };
  }
  if (typeSpec.compatible_terrains && !typeSpec.compatible_terrains.includes(terrain)) {
    return {
      valid: false,
      message: `Scenario type "${scenarioType}" is not compatible with terrain "${terrain}"`,
    };
  }
  if (settingSpec.compatible_terrains && !settingSpec.compatible_terrains.includes(terrain)) {
    return {
      valid: false,
      message: `Setting "${setting}" is not compatible with terrain "${terrain}"`,
    };
  }

  return { valid: true };
}

/**
 * Parse free-text prompt using LLM to extract structured input.
 */
export async function parseFreeTextPrompt(
  prompt: string,
  openAiApiKey: string,
): Promise<ParsedWarroomInput> {
  const systemPrompt = `You are a scenario classifier. Extract structured parameters from the user's scenario description.

Return ONLY valid JSON in this exact format:
{
  "scenario_type": "one of: open_field_shooting, knife_attack, gas_attack, kidnapping, car_bomb, bombing_mall",
  "setting": "one of: beach, subway, mall, resort, hotel, train, open_field",
  "terrain": "one of: jungle, mountain, coastal, desert, urban, rural, swamp, island",
  "location": "real-world place name if mentioned (e.g. 'Bali, Indonesia', 'Jurong Point, Singapore'), or null"
}

Rules:
- Infer the most likely scenario type from keywords (shooting, knife, gas, kidnapping, bomb, mall bombing).
- Infer setting from venue (beach, subway, mall, resort, hotel, train, open field).
- Infer terrain from geography (jungle, mountain, coastal, desert, urban, rural, swamp, island).
- If no real location is mentioned, set location to null.
- Prefer compatible combinations; if ambiguous, pick the most specific match.`;

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
      max_tokens: 300,
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

  return {
    scenario_type: SCENARIO_TYPES.includes(scenario_type) ? scenario_type : 'car_bomb',
    setting: SETTINGS.includes(setting) ? setting : 'open_field',
    terrain: TERRAINS.includes(terrain) ? terrain : 'urban',
    location,
  };
}
