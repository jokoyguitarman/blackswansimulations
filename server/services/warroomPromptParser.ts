/**
 * War Room Prompt Parser
 * Extracts scenario_type, setting, terrain, location from free-text or structured input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ThreatExpectedDamage {
  structural: boolean;
  fire: boolean;
  blast: boolean;
  chemical: boolean;
  crowd_panic_radius: 'immediate' | 'local' | 'wide';
}

export interface ThreatProfile {
  weapon_type: string;
  weapon_class: string;
  threat_scale: 'individual' | 'small_group' | 'mass_casualty' | 'catastrophic';
  adversary_count: number;
  expected_damage: ThreatExpectedDamage;
  injury_types: string[];
}

export interface ParsedWarroomInput {
  scenario_type: string;
  setting: string;
  terrain: string;
  location: string | null;
  venue_name?: string;
  landmarks?: string[];
  threat_profile?: ThreatProfile;
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
  'nuclear_plant_leak',
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

  const weaponClasses =
    'melee_bladed, melee_blunt, firearm_handgun, firearm_rifle, firearm_shotgun, explosive, chemical, biological, vehicle, incendiary, none';

  const systemPrompt = `You are a scenario classifier. Extract structured parameters from the user's scenario description.

Return ONLY valid JSON in this exact format:
{
  "scenario_type": "one of: ${scenarioTypesList}",
  "setting": "one of: ${settingsList}",
  "terrain": "one of: ${terrainsList}",
  "location": "geographic place (city, country) if mentioned, e.g. 'Davao, Philippines', or null",
  "venue_name": "the specific venue/site name the user mentioned, e.g. 'Roxas Night Market', 'Jurong Point', or null",
  "landmarks": ["nearby landmarks the user mentioned, e.g. 'Ateneo de Davao University'"],
  "threat_profile": {
    "weapon_type": "specific weapon mentioned or inferred (e.g. 'knife', 'machete', 'baseball_bat', 'sword', 'AR-15', 'explosive_vest', 'car_bomb', 'sarin', 'petrol')",
    "weapon_class": "one of: ${weaponClasses}",
    "threat_scale": "one of: individual, small_group, mass_casualty, catastrophic",
    "adversary_count": 1,
    "expected_damage": {
      "structural": false,
      "fire": false,
      "blast": false,
      "chemical": false,
      "crowd_panic_radius": "one of: immediate, local, wide"
    },
    "injury_types": ["list of realistic injury types this weapon causes"]
  }
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
- knife_attack: knife, blade, machete, or edged-weapon attack — also covers other melee weapons (bat, sword, axe, hammer) where the core scenario pattern is a close-quarters attacker
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

Threat profile rules:
- weapon_type: the SPECIFIC weapon mentioned. "knife", "machete", "baseball_bat", "crowbar", "sword", "katana", "axe", "hammer", "pistol", "AR-15", "AK-47", "shotgun", "explosive_vest", "IED", "pipe_bomb", "car_bomb", "truck", "van", "sarin", "chlorine", "petrol", "molotov" etc. If not mentioned, infer from scenario_type.
- weapon_class: the CATEGORY of weapon. melee_bladed (knife, machete, sword, axe), melee_blunt (bat, crowbar, hammer, pipe), firearm_handgun (pistol, revolver), firearm_rifle (AR-15, AK-47, rifle), firearm_shotgun (shotgun), explosive (IED, car bomb, vest, pipe bomb), chemical (sarin, chlorine, mustard gas), biological (anthrax, ricin), vehicle (truck, van, car used as weapon), incendiary (petrol, molotov, arson), none (stampede, infrastructure failure, natural).
- threat_scale: individual (1 attacker, limited weapon), small_group (2-4 attackers OR single attacker with high-capacity weapon), mass_casualty (explosive, vehicle ramming, or shooting with extended engagement), catastrophic (large-scale bombing, chemical attack, multiple coordinated attacks).
- adversary_count: the number of attackers explicitly mentioned or implied. Default 1. If "3 attackers" or "group of militants" — extract the count. "Group" with no number = 3.
- expected_damage:
  - structural: true ONLY for explosives, vehicle ramming into structures, large-scale arson, or infrastructure attacks. FALSE for all melee and most firearms.
  - fire: true ONLY for incendiary, arson, explosives, or if the scenario explicitly involves fire. FALSE for melee and firearms.
  - blast: true ONLY for explosives (IED, car bomb, pipe bomb, vest). FALSE for everything else.
  - chemical: true ONLY for chemical/biological agents. FALSE for everything else.
  - crowd_panic_radius: "immediate" (<50m, melee weapons, single gunshot), "local" (<200m, sustained gunfire, small explosion, vehicle attack), "wide" (>200m, large explosion, chemical cloud, mass shooting).
- injury_types: ONLY injuries this weapon can realistically cause:
  - melee_bladed: ["laceration", "stab_wound", "hemorrhage", "severed_tendon", "psychological"]
  - melee_blunt: ["fracture", "concussion", "contusion", "internal_bleeding", "psychological"]
  - firearm: ["gunshot_wound", "hemorrhage", "penetrating_wound", "fracture", "psychological"]
  - explosive: ["blast_injury", "burn", "shrapnel_wound", "crush_injury", "amputation", "tympanic_rupture", "smoke_inhalation", "psychological"]
  - vehicle: ["crush_injury", "fracture", "internal_bleeding", "laceration", "traumatic_brain_injury", "psychological"]
  - incendiary: ["burn", "smoke_inhalation", "carbon_monoxide_poisoning", "psychological"]
  - chemical: ["chemical_burn", "respiratory_failure", "nerve_agent_exposure", "skin_contamination", "psychological"]

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
      max_tokens: 800,
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

  const threat_profile = parseThreatProfile(parsed.threat_profile, scenario_type);

  return {
    scenario_type: SCENARIO_TYPES.includes(scenario_type) ? scenario_type : 'car_bomb',
    setting: SETTINGS.includes(setting) ? setting : 'open_field',
    terrain: TERRAINS.includes(terrain) ? terrain : 'urban',
    location,
    venue_name: venue_name || undefined,
    landmarks: landmarks && landmarks.length > 0 ? landmarks : undefined,
    threat_profile,
  };
}

const VALID_WEAPON_CLASSES = [
  'melee_bladed',
  'melee_blunt',
  'firearm_handgun',
  'firearm_rifle',
  'firearm_shotgun',
  'explosive',
  'chemical',
  'biological',
  'radiological',
  'vehicle',
  'incendiary',
  'none',
];
const VALID_THREAT_SCALES = ['individual', 'small_group', 'mass_casualty', 'catastrophic'] as const;
const VALID_PANIC_RADII = ['immediate', 'local', 'wide'] as const;

const SCENARIO_DEFAULT_PROFILES: Record<string, Omit<ThreatProfile, 'adversary_count'>> = {
  knife_attack: {
    weapon_type: 'knife',
    weapon_class: 'melee_bladed',
    threat_scale: 'individual',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'immediate',
    },
    injury_types: ['laceration', 'stab_wound', 'hemorrhage', 'psychological'],
  },
  active_shooter: {
    weapon_type: 'rifle',
    weapon_class: 'firearm_rifle',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: ['gunshot_wound', 'hemorrhage', 'penetrating_wound', 'fracture', 'psychological'],
  },
  open_field_shooting: {
    weapon_type: 'rifle',
    weapon_class: 'firearm_rifle',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: ['gunshot_wound', 'hemorrhage', 'penetrating_wound', 'fracture', 'psychological'],
  },
  car_bomb: {
    weapon_type: 'car_bomb',
    weapon_class: 'explosive',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: true,
      fire: true,
      blast: true,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'blast_injury',
      'burn',
      'shrapnel_wound',
      'crush_injury',
      'amputation',
      'smoke_inhalation',
      'psychological',
    ],
  },
  bombing: {
    weapon_type: 'IED',
    weapon_class: 'explosive',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: true,
      fire: true,
      blast: true,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'blast_injury',
      'burn',
      'shrapnel_wound',
      'crush_injury',
      'amputation',
      'smoke_inhalation',
      'psychological',
    ],
  },
  bombing_mall: {
    weapon_type: 'IED',
    weapon_class: 'explosive',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: true,
      fire: true,
      blast: true,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'blast_injury',
      'burn',
      'shrapnel_wound',
      'crush_injury',
      'amputation',
      'smoke_inhalation',
      'psychological',
    ],
  },
  suicide_bombing: {
    weapon_type: 'explosive_vest',
    weapon_class: 'explosive',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: true,
      blast: true,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: ['blast_injury', 'burn', 'shrapnel_wound', 'amputation', 'psychological'],
  },
  vehicle_ramming: {
    weapon_type: 'vehicle',
    weapon_class: 'vehicle',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'local',
    },
    injury_types: [
      'crush_injury',
      'fracture',
      'internal_bleeding',
      'laceration',
      'traumatic_brain_injury',
      'psychological',
    ],
  },
  gas_attack: {
    weapon_type: 'chemical_agent',
    weapon_class: 'chemical',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: true,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'chemical_burn',
      'respiratory_failure',
      'nerve_agent_exposure',
      'skin_contamination',
      'psychological',
    ],
  },
  arson: {
    weapon_type: 'petrol',
    weapon_class: 'incendiary',
    threat_scale: 'individual',
    expected_damage: {
      structural: true,
      fire: true,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'local',
    },
    injury_types: ['burn', 'smoke_inhalation', 'carbon_monoxide_poisoning', 'psychological'],
  },
  poisoning: {
    weapon_type: 'poison',
    weapon_class: 'chemical',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: true,
      crowd_panic_radius: 'local',
    },
    injury_types: ['poisoning', 'organ_failure', 'respiratory_failure', 'psychological'],
  },
  kidnapping: {
    weapon_type: 'firearm',
    weapon_class: 'firearm_handgun',
    threat_scale: 'individual',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'immediate',
    },
    injury_types: ['gunshot_wound', 'contusion', 'psychological'],
  },
  hostage_siege: {
    weapon_type: 'rifle',
    weapon_class: 'firearm_rifle',
    threat_scale: 'small_group',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'local',
    },
    injury_types: ['gunshot_wound', 'contusion', 'psychological'],
  },
  hijacking: {
    weapon_type: 'firearm',
    weapon_class: 'firearm_handgun',
    threat_scale: 'small_group',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'local',
    },
    injury_types: ['gunshot_wound', 'contusion', 'psychological'],
  },
  infrastructure_attack: {
    weapon_type: 'explosive',
    weapon_class: 'explosive',
    threat_scale: 'catastrophic',
    expected_damage: {
      structural: true,
      fire: true,
      blast: true,
      chemical: true,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'blast_injury',
      'burn',
      'chemical_burn',
      'crush_injury',
      'smoke_inhalation',
      'psychological',
    ],
  },
  stampede_crush: {
    weapon_type: 'none',
    weapon_class: 'none',
    threat_scale: 'mass_casualty',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'wide',
    },
    injury_types: ['crush_injury', 'fracture', 'asphyxiation', 'trampling', 'psychological'],
  },
  biohazard: {
    weapon_type: 'biological_agent',
    weapon_class: 'biological',
    threat_scale: 'catastrophic',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: true,
      crowd_panic_radius: 'wide',
    },
    injury_types: ['respiratory_failure', 'skin_contamination', 'organ_failure', 'psychological'],
  },
  assassination: {
    weapon_type: 'firearm',
    weapon_class: 'firearm_handgun',
    threat_scale: 'individual',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: false,
      crowd_panic_radius: 'immediate',
    },
    injury_types: ['gunshot_wound', 'hemorrhage', 'psychological'],
  },
  nuclear_plant_leak: {
    weapon_type: 'radiation_release',
    weapon_class: 'radiological',
    threat_scale: 'catastrophic',
    expected_damage: {
      structural: false,
      fire: false,
      blast: false,
      chemical: true,
      crowd_panic_radius: 'wide',
    },
    injury_types: [
      'acute_radiation_syndrome',
      'beta_burn',
      'thyroid_exposure',
      'internal_contamination',
      'radiation_dermatitis',
      'psychological',
    ],
  },
};

export function buildDefaultThreatProfile(scenarioType: string, adversaryCount = 1): ThreatProfile {
  const defaults = SCENARIO_DEFAULT_PROFILES[scenarioType] || SCENARIO_DEFAULT_PROFILES['car_bomb'];
  return { ...defaults, adversary_count: adversaryCount };
}

function parseThreatProfile(raw: unknown, scenarioType: string): ThreatProfile {
  const defaults = SCENARIO_DEFAULT_PROFILES[scenarioType] || SCENARIO_DEFAULT_PROFILES['car_bomb'];
  if (!raw || typeof raw !== 'object') {
    return { ...defaults, adversary_count: 1 };
  }

  const r = raw as Record<string, unknown>;

  const weapon_type =
    typeof r.weapon_type === 'string' && r.weapon_type.trim()
      ? r.weapon_type.trim()
      : defaults.weapon_type;

  const rawClass =
    typeof r.weapon_class === 'string' ? r.weapon_class.toLowerCase().replace(/\s+/g, '_') : '';
  const weapon_class = VALID_WEAPON_CLASSES.includes(rawClass) ? rawClass : defaults.weapon_class;

  const rawScale = typeof r.threat_scale === 'string' ? r.threat_scale.toLowerCase() : '';
  const threat_scale = (VALID_THREAT_SCALES as readonly string[]).includes(rawScale)
    ? (rawScale as ThreatProfile['threat_scale'])
    : defaults.threat_scale;

  const adversary_count =
    typeof r.adversary_count === 'number' && r.adversary_count >= 1
      ? Math.min(Math.round(r.adversary_count), 10)
      : 1;

  let expected_damage = defaults.expected_damage;
  if (r.expected_damage && typeof r.expected_damage === 'object') {
    const ed = r.expected_damage as Record<string, unknown>;
    const rawPanic =
      typeof ed.crowd_panic_radius === 'string' ? ed.crowd_panic_radius.toLowerCase() : '';
    expected_damage = {
      structural:
        typeof ed.structural === 'boolean' ? ed.structural : defaults.expected_damage.structural,
      fire: typeof ed.fire === 'boolean' ? ed.fire : defaults.expected_damage.fire,
      blast: typeof ed.blast === 'boolean' ? ed.blast : defaults.expected_damage.blast,
      chemical: typeof ed.chemical === 'boolean' ? ed.chemical : defaults.expected_damage.chemical,
      crowd_panic_radius: (VALID_PANIC_RADII as readonly string[]).includes(rawPanic)
        ? (rawPanic as ThreatExpectedDamage['crowd_panic_radius'])
        : defaults.expected_damage.crowd_panic_radius,
    };
  }

  const injury_types =
    Array.isArray(r.injury_types) && r.injury_types.length > 0
      ? r.injury_types.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : defaults.injury_types;

  return {
    weapon_type,
    weapon_class,
    threat_scale,
    adversary_count,
    expected_damage,
    injury_types,
  };
}
