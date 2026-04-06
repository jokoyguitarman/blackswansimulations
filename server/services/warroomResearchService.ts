/**
 * War Room Research Service
 * Uses OpenAI web search models for area, standards, and similar-cases research.
 * Standards research is narrative-driven: first identifies relevant domains from the
 * scenario story, then fetches specific protocols per domain.
 * Similar-cases research runs right after parsing (concurrent with geocoding) and
 * provides structured real-world incident context for every AI generation phase.
 */

import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const SEARCH_MODEL = 'gpt-4o-search-preview';

export interface AreaResearchStructured {
  venue_name?: string;
  location?: string;
  establishment_types: string[];
  incident_focus_establishment?: string;
  access_routes: {
    primary_roads: Array<{ name: string; notes?: string }>;
    secondary_roads: Array<{ name: string; notes?: string }>;
    bottlenecks: Array<{ name: string; notes?: string }>;
    pedestrian_restrictions?: string[];
    underground_connections?: string[];
  };
  emergency_facilities: {
    hospitals: Array<{
      name: string;
      distance_km?: number;
      drive_time_min?: number;
      notes?: string;
    }>;
    police: Array<{ name: string; distance_km?: number; notes?: string }>;
    fire_stations: Array<{ name: string; distance_km?: number; notes?: string }>;
    ambulance_rally_points?: Array<{ name: string; notes?: string }>;
  };
  venue_layout: {
    description?: string;
    floors?: string;
    entries_exits?: string[];
    adjacent_buildings?: string[];
    crowd_capacity_notes?: string;
    cctv_notes?: string;
  };
  on_site_materials_and_systems: Array<{
    category: string;
    items: string[];
    why_it_matters?: string;
  }>;
  secondary_effects: string[];
  utilities_and_infrastructure: {
    power?: string[];
    gas?: string[];
    water?: string[];
    telecoms?: string[];
    drainage_flood?: string[];
  };
  environmental_cultural_context?: string[];
  operational_constraints?: string[];
  sensitive_nearby_sites?: Array<{ name: string; type: string; notes?: string }>;
  summary_for_ui: string;
}

export interface HazardMaterialInference {
  establishment_inference: {
    primary: string;
    secondary?: string[];
    confidence: 'low' | 'medium' | 'high';
    rationale: string[];
  };
  venue_material_risks: Array<{
    hazard_theme: string;
    plausible_sources: string[];
    trigger_conditions: string[];
    secondary_effects: string[];
    responder_implications: string[];
  }>;
}

export interface SensitiveInfrastructureStructured {
  sites: Array<{
    name: string;
    type: string;
    distance_km?: number;
    operational_impact: string[];
  }>;
  summary_for_ui: string;
}

export interface SimilarCase {
  name: string;
  summary: string;
  timeline: string;
  adversary_behavior: string;
  other_actors: string;
  environment: string;
  outcome: string;
  casualties_killed?: number;
  casualties_injured?: number;
  num_attackers?: number;
  weapon_description?: string;
  relevance_score?: number;
  weapon_forensics?: string;
  damage_radius_m?: number;
  hazards_triggered?: string[];
  secondary_effects?: string[];
  injury_breakdown?: string;
  crowd_response?: string;
  response_time_minutes?: number;
  containment_time_minutes?: number;
  environment_factors?: string[];
  /** Set when loaded from the database cache */
  db_id?: string;
}

export interface SiteRequirement {
  min_area_m2?: number;
  requires_water?: boolean;
  requires_shelter?: boolean;
  requires_vehicle_access?: boolean;
  requires_electricity?: boolean;
  min_capacity?: number;
  max_distance_from_incident_m?: number;
  notes?: string;
}

export interface StandardsFinding {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
  site_requirements?: Record<string, SiteRequirement>;
}

/**
 * Research the area around a location: geography, access, landmarks, local agencies,
 * establishment type, and on-site materials/systems relevant to secondary hazards.
 */
export async function researchArea(
  openAiApiKey: string,
  location: string,
  venueName?: string,
): Promise<string> {
  const venue = venueName || location;
  const prompt = `You are a crisis management planning officer preparing an operational area brief for an emergency exercise at ${venue} in ${location}.

Produce a detailed area intelligence report covering ALL of the following sections. Be specific — use real names, real distances, real addresses where possible.

## ACCESS ROUTES
- Primary vehicle access roads (name, direction, lanes, one-way restrictions)
- Secondary / alternative routes
- Pedestrian-only zones or restricted vehicle areas
- Underground connections (MRT/subway, basement links between buildings)
- Known traffic bottleneck points during peak hours

## EMERGENCY FACILITIES (within 10km radius)
- Hospitals: name, distance, type (public/private), trauma level or emergency capability, estimated drive time
- Police stations: name, distance, division/jurisdiction
- Fire stations: name, distance
- Ambulance staging areas or known rally points

## VENUE / AREA LAYOUT
- Physical description: building type, floors, open spaces, parking structures
- Entry and exit points (pedestrian and vehicle)
- Adjacent buildings and what they are (commercial, residential, government)
- Crowd capacity estimates for the area
- CCTV coverage (if known — transit stations, government buildings typically have it)

## ESTABLISHMENT TYPE & ON-SITE HAZARD CONTEXT
Classify the PRIMARY facility or site type at "${venue}" (e.g. acute hospital, outpatient clinic, R&D chemistry lab, pharmaceutical manufacturing, university teaching lab, school, shopping mall, office tower, industrial plant, warehouse, transit hub, stadium, hotel). If multiple, list them and note which is the incident focus.

For that establishment type, list REALISTIC on-site materials, stored goods, and fixed systems that change crisis outcomes when fire, blast, flood, or loss of utilities occurs. Be specific where credible; use categories if exact inventory is unknown:
- Medical/clinical: medical oxygen and other compressed medical gases, vacuum/SMV systems, sterilants, pharmacies, LNG for backup power, isolation wards, vulnerable patients
- Laboratories (chemistry/biology/pharma): flammable and combustible liquids, compressed and cryogenic gases, corrosives, toxics, waste accumulation areas, fume hoods, peroxide-formers
- Industrial/manufacturing: dust explosion fuels, ammonia refrigeration, battery storage, forklift/LPG, spray booths, bulk chemicals, high-voltage equipment
- Commercial/retail: stockpiled goods, cleaning chemicals, food service oils, data/UPS battery rooms
- Infrastructure: diesel generators, fuel storage, transformer yards, elevator machine rooms

Briefly note how a violent incident (explosion, major fire, structural breach) at THIS venue could realistically trigger SECONDARY effects via those materials (e.g. oxygen accelerating fire spread, solvent pool fires, toxic smoke plumes, gas cylinder projectiles).

## INFRASTRUCTURE & UTILITIES
- Major utility corridors (power substations, gas mains, water supply)
- Telecommunications infrastructure (cell towers, known dead zones)
- Drainage or flood-prone areas

## ENVIRONMENTAL & CULTURAL CONTEXT
- Is this a tourist zone, diplomatic quarter, heritage area, residential neighborhood?
- Language/demographic considerations for public communication
- Time-of-day crowd patterns (when is it busiest vs. quietest)
- Any recurring events (markets, festivals, religious gatherings) that affect crowd density

## OPERATIONAL CONSTRAINTS
- Vehicle weight/height restrictions
- Heritage or protected building restrictions on forced entry
- Nearby sensitive facilities (embassies, schools, religious sites) requiring special coordination
- Helicopter landing zone availability

Write 2000-5000 words. Be thorough — this will be used to ground a realistic crisis simulation. Use only factual, real-world information.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10000,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || response.statusText;
      logger.warn({ status: response.status, msg }, 'Area research failed');
      return '';
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch (err) {
    logger.warn({ err }, 'Area research error');
    return '';
  }
}

/**
 * Extract a structured, JSON-safe representation of the area research dossier.
 * This is used to avoid "skimping" in downstream generations and to drive
 * establishment-anchored hazards and sensitive-site constraints.
 */
export async function extractAreaResearchStructured(
  openAiApiKey: string,
  dossier: string,
  location: string,
  venueName?: string,
): Promise<AreaResearchStructured | null> {
  const venue = venueName || location;
  const prompt = `You are an analyst. Convert the following area research dossier into STRICT JSON with the required schema.

Rules:
- Preserve concrete facts; do not invent.
- If unknown, use empty arrays/omit optional fields.
- Keep summary_for_ui to ~15-25 lines max, but information-dense.

SCHEMA (return EXACT keys):
{
  "venue_name": "string?",
  "location": "string?",
  "establishment_types": ["string"],
  "incident_focus_establishment": "string?",
  "access_routes": {
    "primary_roads": [{ "name": "string", "notes": "string?" }],
    "secondary_roads": [{ "name": "string", "notes": "string?" }],
    "bottlenecks": [{ "name": "string", "notes": "string?" }],
    "pedestrian_restrictions": ["string"]?,
    "underground_connections": ["string"]?
  },
  "emergency_facilities": {
    "hospitals": [{ "name": "string", "distance_km": 0, "drive_time_min": 0, "notes": "string?" }],
    "police": [{ "name": "string", "distance_km": 0, "notes": "string?" }],
    "fire_stations": [{ "name": "string", "distance_km": 0, "notes": "string?" }],
    "ambulance_rally_points": [{ "name": "string", "notes": "string?" }]?
  },
  "venue_layout": {
    "description": "string?",
    "floors": "string?",
    "entries_exits": ["string"]?,
    "adjacent_buildings": ["string"]?,
    "crowd_capacity_notes": "string?",
    "cctv_notes": "string?"
  },
  "on_site_materials_and_systems": [
    { "category": "string", "items": ["string"], "why_it_matters": "string?" }
  ],
  "secondary_effects": ["string"],
  "utilities_and_infrastructure": {
    "power": ["string"]?,
    "gas": ["string"]?,
    "water": ["string"]?,
    "telecoms": ["string"]?,
    "drainage_flood": ["string"]?
  },
  "environmental_cultural_context": ["string"]?,
  "operational_constraints": ["string"]?,
  "sensitive_nearby_sites": [{ "name": "string", "type": "string", "notes": "string?" }]?,
  "summary_for_ui": "string"
}

Venue: ${venue}
Location: ${location}

DOSSIER:
${dossier.slice(0, 24000)}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2200,
        temperature: 0.2,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return null;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as AreaResearchStructured;
  } catch (err) {
    logger.warn({ err }, 'Area structured extraction failed');
    return null;
  }
}

/**
 * Infer establishment-anchored hazard material context separately from hazard placement.
 * This yields a stable "material risk register" that hazard generation can draw from.
 */
export async function inferHazardMaterialContext(
  openAiApiKey: string,
  area: AreaResearchStructured | null,
  scenarioType: string,
  venue: string,
): Promise<HazardMaterialInference | null> {
  const prompt = `You are a HazMat and industrial safety analyst supporting crisis simulation design.

Given the venue and structured area research, produce a "material risk register" that:
- Anchors risks to establishment type, stored goods, and fixed systems
- Predicts realistic secondary effects from blast/fire/flood/power loss
- Provides responder implications (PPE, cordons, monitoring, specialized assets)

Return ONLY valid JSON:
{
  "establishment_inference": {
    "primary": "string",
    "secondary": ["string"]?,
    "confidence": "low|medium|high",
    "rationale": ["string"]
  },
  "venue_material_risks": [
    {
      "hazard_theme": "string",
      "plausible_sources": ["string"],
      "trigger_conditions": ["string"],
      "secondary_effects": ["string"],
      "responder_implications": ["string"]
    }
  ]
}

Scenario type: ${scenarioType}
Venue: ${venue}
Structured area research (may be empty): ${area ? JSON.stringify(area).slice(0, 12000) : '{}'}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1700,
        temperature: 0.3,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return null;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as HazardMaterialInference;
  } catch (err) {
    logger.warn({ err }, 'Hazard material context inference failed');
    return null;
  }
}

/**
 * Extract sensitive nearby infrastructure separately so downstream generation
 * can apply explicit constraints (hospital surge, school evacuation, utilities).
 */
export async function extractSensitiveInfrastructureStructured(
  openAiApiKey: string,
  dossier: string,
  location: string,
  venue: string,
): Promise<SensitiveInfrastructureStructured | null> {
  const prompt = `You are an emergency planning analyst. From the dossier, extract sensitive nearby infrastructure and operational impacts.

Return ONLY valid JSON:
{
  "sites": [
    {
      "name": "string",
      "type": "hospital|school|nursing_home|industrial|utilities|government|transit|port|religious|other",
      "distance_km": 0,
      "operational_impact": ["string"]
    }
  ],
  "summary_for_ui": "string"
}

Venue: ${venue}
Location: ${location}

DOSSIER:
${dossier.slice(0, 20000)}
`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.2,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return null;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as SensitiveInfrastructureStructured;
  } catch (err) {
    logger.warn({ err }, 'Sensitive infrastructure extraction failed');
    return null;
  }
}

/**
 * Per-team standards research.
 *
 * For each team, makes a dedicated research call that considers the team's name,
 * description, role within the scenario, and the scenario narrative. Produces
 * rich, team-specific doctrine at 4000 tokens per team — including overarching
 * command frameworks (ICS/AIIMS/NIMS) as they apply to each team's role.
 *
 * Returns { teamDoctrines, allFindings } — no separate mapping step needed.
 */
export interface TeamInput {
  team_name: string;
  team_description?: string;
}

export async function researchStandardsPerTeam(
  openAiApiKey: string,
  scenarioType: string,
  teams: TeamInput[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<{ teamDoctrines: Record<string, StandardsFinding[]>; allFindings: StandardsFinding[] }> {
  if (teams.length === 0) return { teamDoctrines: {}, allFindings: [] };

  const narrativeBlock = narrative
    ? `\nScenario: ${narrative.title || scenarioType}\nDescription: ${(narrative.description || '').slice(0, 800)}\nBriefing: ${(narrative.briefing || '').slice(0, 400)}`
    : `\nScenario type: ${scenarioType}`;

  const otherTeamsContext = teams
    .map((t) => `${t.team_name}${t.team_description ? ` — ${t.team_description}` : ''}`)
    .join('; ');

  const teamDoctrines: Record<string, StandardsFinding[]> = {};
  const allFindings: StandardsFinding[] = [];

  await Promise.all(
    teams.map(async (team) => {
      const descLine = team.team_description ? `\nTeam description: ${team.team_description}` : '';

      const prompt = `You are an expert in emergency management, crisis response, and sector-specific operational standards.
${narrativeBlock}

All teams in this exercise: ${otherTeamsContext}

FOCUS TEAM: ${team.team_name}${descLine}

Research the specific standards, doctrines, frameworks, and operational protocols that govern how "${team.team_name}" should operate during this kind of incident. Consider:

1. What is this team's FUNCTIONAL ROLE in the response — infer from the team name, description, the scenario type, and how they fit alongside the other teams? For example, a "Railway Maintenance Team" in a subway bombing would handle power isolation, ventilation, structural assessment. An "Interreligious Organisation" placed alongside media/police teams is likely handling community communications and interfaith liaison.

2. What SPECIFIC authoritative standards or doctrines govern this functional role? Name real frameworks (e.g. "ICS NIMS 2017", "START Triage Protocol", "Rail Safety Directive 2016/798", "Singapore Civil Defence Act", "CBRN STANAG 2513"). Include sector-specific regulations (rail, aviation, maritime, hospitality, etc.) where applicable.

3. Include any OVERARCHING command frameworks (ICS, AIIMS, NIMS, SCDF) as they specifically apply to this team's position in the command structure.

Return ONLY valid JSON — an array of 2-4 findings:
[
  {
    "domain": "the discipline area",
    "source": "specific named standard or doctrine",
    "key_points": [
      "specific protocol, procedure, or threshold 1",
      "specific protocol, procedure, or threshold 2",
      "..."
    ],
    "decision_thresholds": "any numeric thresholds, time targets, or decision gates relevant to this team",
    "site_requirements": {
      "operational_area_type": {
        "min_area_m2": 100,
        "requires_water": true,
        "requires_shelter": false,
        "requires_vehicle_access": true,
        "requires_electricity": false,
        "min_capacity": 20,
        "max_distance_from_incident_m": 150,
        "notes": "why these requirements matter"
      }
    }
  }
]

Focus on: decision gates, time thresholds, role responsibilities, handover procedures, and any criteria that determine correct vs incorrect responses by this team. For site_requirements, include only area types this team would actually set up or manage.`;

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAiApiKey}`,
          },
          body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 8000,
          }),
        });

        if (!res.ok) {
          logger.warn(
            { status: res.status, team: team.team_name },
            'Per-team standards research failed',
          );
          return;
        }

        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content as string | undefined;
        if (!raw) return;

        let parsed: StandardsFinding[] = [];
        const jsonArrMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonArrMatch) {
          parsed = JSON.parse(jsonArrMatch[0]) as StandardsFinding[];
        } else {
          const objMatch = raw.match(/\{[\s\S]*\}/);
          if (objMatch) {
            const single = JSON.parse(objMatch[0]) as StandardsFinding;
            parsed = [single];
          }
        }

        const valid = (Array.isArray(parsed) ? parsed : []).filter(
          (f) => f.domain && f.source && Array.isArray(f.key_points),
        );
        for (const f of valid) {
          if (
            f.site_requirements &&
            typeof f.site_requirements === 'object' &&
            Object.keys(f.site_requirements).length === 0
          ) {
            delete f.site_requirements;
          }
        }
        if (valid.length > 0) {
          teamDoctrines[team.team_name] = valid;
          allFindings.push(...valid);
        }
      } catch (err) {
        logger.warn({ err, team: team.team_name }, 'Per-team standards research error');
      }
    }),
  );

  logger.info(
    {
      scenarioType,
      teamCount: teams.length,
      teamsWithDoctrines: Object.keys(teamDoctrines).length,
      totalFindings: allFindings.length,
    },
    'Per-team standards research complete',
  );

  return { teamDoctrines, allFindings };
}

/**
 * @deprecated Use researchStandardsPerTeam instead.
 * Legacy wrapper — converts string[] team names into TeamInput[] and delegates.
 */
export async function researchStandards(
  openAiApiKey: string,
  scenarioType: string,
  teams?: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<StandardsFinding[]> {
  const teamInputs: TeamInput[] = (teams ?? []).map((t) => ({ team_name: t }));
  const { allFindings } = await researchStandardsPerTeam(
    openAiApiKey,
    scenarioType,
    teamInputs,
    narrative,
  );
  return allFindings;
}

/**
 * Research 2–4 real-world incidents similar to the given scenario type and venue.
 * Database-first: checks the local research_cases cache before hitting the internet.
 * Persists any new internet results to the cache for future reuse.
 * Returns [] on any failure so generation always proceeds.
 */
export async function researchSimilarCases(
  openAiApiKey: string,
  scenarioType: string,
  location?: string,
  venueName?: string,
  setting?: string,
  originalPrompt?: string,
  threatProfile?: {
    weapon_type?: string;
    weapon_class?: string;
    adversary_count?: number;
    threat_scale?: string;
  },
): Promise<SimilarCase[]> {
  const settingTags = extractSettingTags(
    `${originalPrompt || ''} ${location || ''} ${venueName || ''} ${setting || ''}`,
    scenarioType,
  );
  const weaponClass = threatProfile?.weapon_class;

  // Step 1: Check the database cache
  const cached = await findCachedResearchCases(scenarioType, weaponClass, settingTags);
  if (cached.length >= 2) {
    logger.info(
      { scenarioType, cached: cached.length },
      'Using cached research cases from database',
    );
    return cached;
  }

  // Step 2: Not enough cached results — fetch from internet
  const internetResults = await fetchSimilarCasesFromInternet(
    openAiApiKey,
    scenarioType,
    location,
    venueName,
    setting,
    originalPrompt,
    threatProfile,
  );

  // Step 3: Merge cached + new, dedup by normalized name
  const seenNames = new Set(cached.map((c) => normalizeCaseName(c.name)));
  const newFromInternet = internetResults.filter((c) => {
    const n = normalizeCaseName(c.name);
    if (seenNames.has(n)) return false;
    seenNames.add(n);
    return true;
  });
  const merged = [...cached, ...newFromInternet].slice(0, 4);

  // Step 4: Persist new internet results to the database (non-blocking)
  if (newFromInternet.length > 0) {
    persistResearchCases(newFromInternet, scenarioType, weaponClass, settingTags).catch((err) =>
      logger.warn({ err }, 'Background persist of research cases failed'),
    );
  }

  logger.info(
    {
      scenarioType,
      location,
      cached: cached.length,
      internet: newFromInternet.length,
      total: merged.length,
    },
    'Similar cases research complete',
  );
  return merged;
}

/**
 * Fetch similar cases from the internet via OpenAI search model.
 * This is the original internet-only research path, now extracted as an internal helper.
 */
async function fetchSimilarCasesFromInternet(
  openAiApiKey: string,
  scenarioType: string,
  location?: string,
  venueName?: string,
  setting?: string,
  originalPrompt?: string,
  threatProfile?: {
    weapon_type?: string;
    weapon_class?: string;
    adversary_count?: number;
    threat_scale?: string;
  },
): Promise<SimilarCase[]> {
  const venueContext = venueName || location || setting || scenarioType;
  const locationHint = location ? ` in or near ${location}` : '';
  const settingHint = setting ? ` (setting: ${setting})` : '';

  const scenarioDescription = originalPrompt
    ? `"${originalPrompt}" (classified as: ${scenarioType})`
    : scenarioType;

  const threatHint = threatProfile
    ? `\nThreat details: ${threatProfile.adversary_count ?? 1} attacker(s) with ${threatProfile.weapon_type || threatProfile.weapon_class || 'unknown weapon'}, threat scale: ${threatProfile.threat_scale || 'unknown'}`
    : '';

  const prompt = `You are an expert in crisis management, emergency response history, and forensic incident analysis.

Find 2–4 real-world incidents that are similar to: ${scenarioDescription}${locationHint}${settingHint}.${threatHint}

Match on these factors in priority order: (1) weapon type and attack method, (2) number of attackers, (3) venue/crowd density similarity, (4) geographic/cultural similarity.

For each incident, extract a DETAILED structured summary covering both the narrative AND the forensic/tactical details. This data will be used to calibrate a crisis simulation for realism — casualty counts, hazard types, crowd behavior, and response timelines must be grounded in real documented data.

Return ONLY valid JSON:
{
  "cases": [
    {
      "name": "incident name, location, year (e.g. 'Kunming Station Attack, 2014')",
      "summary": "2–3 sentence overview of what happened",
      "timeline": "How the event evolved: key phases, escalation points, turning points (2–4 sentences)",
      "adversary_behavior": "What the threat actor(s) did: tactics, adaptations, objectives (2–3 sentences)",
      "other_actors": "How the public, media, bystanders, or other third parties behaved and influenced events (1–2 sentences)",
      "environment": "How location, infrastructure, crowd density, or environmental factors shaped the response (1–2 sentences)",
      "outcome": "How it resolved, key lessons for responders (1–2 sentences)",
      "casualties_killed": 0,
      "casualties_injured": 0,
      "num_attackers": 1,
      "weapon_description": "brief description of weapons used",
      "weapon_forensics": "detailed weapon specification: type, dimensions, caliber, composition, or IED components if applicable",
      "damage_radius_m": 0,
      "hazards_triggered": ["list of environmental hazards that resulted: fire, structural_collapse, debris, glass, chemical_spill, etc."],
      "secondary_effects": ["chain reactions: stampede, traffic_gridlock, secondary_evacuation, hospital_surge, etc."],
      "injury_breakdown": "percentage breakdown of injury types documented (e.g. '40% lacerations, 30% stab wounds, 20% crush, 10% psychological')",
      "crowd_response": "how the crowd actually behaved at different distances from the incident",
      "response_time_minutes": 0,
      "containment_time_minutes": 0,
      "environment_factors": ["physical factors: narrow_corridors, open_field, underground, high_crowd_density, limited_exits, etc."],
      "relevance_score": 8
    }
  ]
}

FIELD GUIDANCE:
- weapon_forensics: Be specific — "8 attackers each carried 30cm single-edge knives" not just "knives". For bombs: composition, yield estimate, delivery method.
- damage_radius_m: Physical area affected. For melee: the area the attacker(s) traversed. For explosives: documented blast/damage radius. For vehicles: length of the attack path.
- hazards_triggered: Only hazards that ACTUALLY occurred in the documented incident. Empty array if none.
- secondary_effects: Cascading consequences beyond the primary attack. Empty array if none documented.
- injury_breakdown: Use approximate documented percentages. If unknown, describe the dominant injury types qualitatively.
- crowd_response: Describe behavior at different distances (near attack, mid-range, far). How did panic spread? Where did bottlenecks form?
- response_time_minutes: Minutes from first emergency call to first responder on scene. 0 if unknown.
- containment_time_minutes: Minutes from first response to situation neutralized/contained. 0 if unknown.
- environment_factors: Physical characteristics of the venue that shaped the incident dynamics.

RULES:
- Use ONLY real, documented incidents — no fictional or hypothetical cases.
- If no closely similar real incidents can be found, return an empty cases array: { "cases": [] }
- Focus on incidents where the response dynamics (coordination, timing, actor behavior) are most instructive.
- Prioritise incidents from the past 30 years with documented after-action reviews.
- casualties_killed and casualties_injured should be approximate documented numbers.
- relevance_score: 1-10 rating of how closely this incident matches the prompted scenario (10 = near-identical, 1 = loosely related).

Scenario context: ${scenarioDescription} at ${venueContext}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5000,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || res.statusText;
      logger.warn({ status: res.status, msg }, 'Similar cases internet research failed');
      return [];
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return [];

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { cases?: unknown[] };
    const cases = parsed.cases ?? [];

    return cases.filter(
      (c): c is SimilarCase =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as SimilarCase).name === 'string' &&
        typeof (c as SimilarCase).summary === 'string',
    );
  } catch (err) {
    logger.warn({ err, scenarioType }, 'Similar cases internet research error');
    return [];
  }
}

/**
 * Serialize SimilarCase[] to a compact string for embedding in AI prompts.
 */
export function similarCasesToPromptBlock(cases: SimilarCase[]): string {
  if (cases.length === 0) return '';
  return cases
    .map((c) => {
      const lines: string[] = [];
      lines.push(`[${c.name}]${c.relevance_score ? ` (relevance: ${c.relevance_score}/10)` : ''}`);
      lines.push(`  Overview: ${c.summary}`);

      const statsParts: string[] = [];
      if (c.casualties_killed != null || c.casualties_injured != null)
        statsParts.push(
          `${c.casualties_killed ?? '?'} killed, ${c.casualties_injured ?? '?'} injured`,
        );
      if (c.num_attackers) statsParts.push(`${c.num_attackers} attacker(s)`);
      if (c.weapon_description) statsParts.push(c.weapon_description);
      if (statsParts.length) lines.push(`  Casualties: ${statsParts.join(' | ')}`);

      if (c.weapon_forensics) lines.push(`  Weapon forensics: ${c.weapon_forensics}`);
      if (c.damage_radius_m)
        lines.push(`  Damage radius: ${Math.round(c.damage_radius_m * 3.28084)} ft`);
      if (c.injury_breakdown) lines.push(`  Injury breakdown: ${c.injury_breakdown}`);
      if (c.hazards_triggered?.length)
        lines.push(`  Hazards triggered: ${c.hazards_triggered.join(', ')}`);
      if (c.secondary_effects?.length)
        lines.push(`  Secondary effects: ${c.secondary_effects.join(', ')}`);
      if (c.crowd_response) lines.push(`  Crowd response: ${c.crowd_response}`);
      if (c.response_time_minutes) lines.push(`  Response time: ${c.response_time_minutes} min`);
      if (c.containment_time_minutes)
        lines.push(`  Containment time: ${c.containment_time_minutes} min`);
      if (c.environment_factors?.length)
        lines.push(`  Environment factors: ${c.environment_factors.join(', ')}`);

      lines.push(`  Timeline: ${c.timeline}`);
      lines.push(`  Adversary: ${c.adversary_behavior}`);
      lines.push(`  Other actors: ${c.other_actors}`);
      lines.push(`  Environment: ${c.environment}`);
      lines.push(`  Outcome: ${c.outcome}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Setting-tag extraction (keyword-based, no AI call)
// ---------------------------------------------------------------------------

const SETTING_KEYWORDS: Record<string, string[]> = {
  outdoor: [
    'outdoor',
    'open air',
    'park',
    'field',
    'garden',
    'beach',
    'street',
    'road',
    'highway',
    'plaza',
    'square',
  ],
  indoor: [
    'indoor',
    'building',
    'mall',
    'office',
    'warehouse',
    'factory',
    'hall',
    'auditorium',
    'theater',
    'theatre',
    'cinema',
    'gym',
  ],
  underground: ['underground', 'subway', 'metro', 'basement', 'tunnel', 'bunker', 'parking garage'],
  high_rise: [
    'tower',
    'skyscraper',
    'high-rise',
    'highrise',
    'multi-storey',
    'multistory',
    'floors',
  ],
  transport_hub: [
    'airport',
    'station',
    'terminal',
    'port',
    'harbor',
    'harbour',
    'bus stop',
    'train',
    'railway',
  ],
  market: ['market', 'bazaar', 'fair', 'flea market', 'hawker', 'food court', 'chinatown', 'souk'],
  school: ['school', 'university', 'campus', 'college', 'classroom', 'kindergarten', 'nursery'],
  hospital: ['hospital', 'clinic', 'medical center', 'emergency room', 'ward'],
  religious: ['mosque', 'church', 'temple', 'synagogue', 'cathedral', 'shrine', 'chapel'],
  stadium: ['stadium', 'arena', 'concert', 'festival', 'venue', 'amphitheatre', 'amphitheater'],
  residential: [
    'apartment',
    'house',
    'residential',
    'neighbourhood',
    'neighborhood',
    'suburb',
    'village',
    'housing',
  ],
  commercial: ['shop', 'store', 'retail', 'supermarket', 'restaurant', 'hotel', 'resort', 'cafe'],
  industrial: [
    'factory',
    'plant',
    'refinery',
    'industrial',
    'construction site',
    'warehouse',
    'depot',
  ],
  waterfront: ['waterfront', 'riverside', 'harbour', 'pier', 'dock', 'marina', 'bridge'],
  crowded: [
    'crowded',
    'busy',
    'packed',
    'rush hour',
    'peak',
    'festival',
    'parade',
    'celebration',
    'gathering',
    'crowd',
  ],
  nighttime: ['night', 'nighttime', 'dark', 'evening', 'midnight', 'late night'],
  rural: ['rural', 'countryside', 'farm', 'remote', 'isolated', 'outback'],
  government: [
    'government',
    'parliament',
    'embassy',
    'consulate',
    'ministry',
    'city hall',
    'court',
  ],
  military: ['military', 'barracks', 'base', 'camp', 'checkpoint', 'border'],
};

export function extractSettingTags(prompt: string, scenarioType: string): string[] {
  const text = `${prompt} ${scenarioType}`.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(SETTING_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      tags.push(tag);
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Database cache: find, persist, and link research cases
// ---------------------------------------------------------------------------

export async function findCachedResearchCases(
  scenarioType: string,
  weaponClass?: string,
  settingTags?: string[],
): Promise<(SimilarCase & { db_id: string })[]> {
  try {
    const query = supabaseAdmin
      .from('research_cases')
      .select('*')
      .overlaps('scenario_types', [scenarioType]);

    const { data, error } = await query.limit(10);
    if (error || !data) {
      logger.warn({ error }, 'findCachedResearchCases query failed');
      return [];
    }

    type Row = Record<string, unknown>;
    const scored = (data as Row[]).map((row) => {
      let score = 1;
      const rowWeaponClasses = (row.weapon_classes as string[]) || [];
      const rowSettingTags = (row.setting_tags as string[]) || [];
      if (weaponClass && rowWeaponClasses.includes(weaponClass)) score += 3;
      if (settingTags?.length) {
        const overlap = settingTags.filter((t) => rowSettingTags.includes(t)).length;
        score += overlap;
      }
      return { row, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 4).map(({ row }) => rowToSimilarCase(row));
  } catch (err) {
    logger.warn({ err }, 'findCachedResearchCases error');
    return [];
  }
}

function rowToSimilarCase(row: Record<string, unknown>): SimilarCase & { db_id: string } {
  return {
    db_id: row.id as string,
    name: row.name as string,
    summary: row.summary as string,
    timeline: (row.timeline as string) || '',
    adversary_behavior: (row.adversary_behavior as string) || '',
    other_actors: (row.other_actors as string) || '',
    environment: (row.environment as string) || '',
    outcome: (row.outcome as string) || '',
    casualties_killed: row.casualties_killed as number | undefined,
    casualties_injured: row.casualties_injured as number | undefined,
    num_attackers: row.num_attackers as number | undefined,
    weapon_description: row.weapon_description as string | undefined,
    relevance_score: row.relevance_score as number | undefined,
    weapon_forensics: row.weapon_forensics as string | undefined,
    damage_radius_m: row.damage_radius_m as number | undefined,
    hazards_triggered: row.hazards_triggered as string[] | undefined,
    secondary_effects: row.secondary_effects as string[] | undefined,
    injury_breakdown: row.injury_breakdown as string | undefined,
    crowd_response: row.crowd_response as string | undefined,
    response_time_minutes: row.response_time_minutes as number | undefined,
    containment_time_minutes: row.containment_time_minutes as number | undefined,
    environment_factors: row.environment_factors as string[] | undefined,
  };
}

function normalizeCaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function persistResearchCases(
  cases: SimilarCase[],
  scenarioType: string,
  weaponClass?: string,
  settingTags?: string[],
): Promise<{ id: string; case_: SimilarCase }[]> {
  const results: { id: string; case_: SimilarCase }[] = [];

  for (const c of cases) {
    if (c.db_id) {
      results.push({ id: c.db_id, case_: c });
      continue;
    }
    const normalizedName = normalizeCaseName(c.name);
    try {
      const row = {
        normalized_name: normalizedName,
        name: c.name,
        summary: c.summary,
        timeline: c.timeline || null,
        adversary_behavior: c.adversary_behavior || null,
        other_actors: c.other_actors || null,
        environment: c.environment || null,
        outcome: c.outcome || null,
        casualties_killed: c.casualties_killed ?? null,
        casualties_injured: c.casualties_injured ?? null,
        num_attackers: c.num_attackers ?? null,
        weapon_description: c.weapon_description ?? null,
        weapon_forensics: c.weapon_forensics ?? null,
        damage_radius_m: c.damage_radius_m ?? null,
        hazards_triggered: c.hazards_triggered ?? [],
        secondary_effects: c.secondary_effects ?? [],
        injury_breakdown: c.injury_breakdown ?? null,
        crowd_response: c.crowd_response ?? null,
        response_time_minutes: c.response_time_minutes ?? null,
        containment_time_minutes: c.containment_time_minutes ?? null,
        environment_factors: c.environment_factors ?? [],
        scenario_types: [scenarioType],
        weapon_classes: weaponClass ? [weaponClass] : [],
        setting_tags: settingTags ?? [],
      };

      const { data, error } = await supabaseAdmin
        .from('research_cases')
        .upsert(row, { onConflict: 'normalized_name' })
        .select('id')
        .single();

      if (error || !data) {
        logger.warn({ error, name: c.name }, 'Failed to persist research case');
        continue;
      }
      results.push({ id: (data as { id: string }).id, case_: c });
    } catch (err) {
      logger.warn({ err, name: c.name }, 'persistResearchCase error');
    }
  }
  return results;
}

export async function linkResearchToScenario(
  scenarioId: string,
  caseIds: { id: string; relevanceScore?: number }[],
): Promise<void> {
  if (caseIds.length === 0) return;
  try {
    const rows = caseIds.map((c) => ({
      scenario_id: scenarioId,
      research_case_id: c.id,
      relevance_score: c.relevanceScore ?? null,
    }));
    const { error } = await supabaseAdmin
      .from('scenario_research_usage')
      .upsert(rows, { onConflict: 'scenario_id,research_case_id' });
    if (error) {
      logger.warn({ error, scenarioId }, 'linkResearchToScenario failed');
    }
  } catch (err) {
    logger.warn({ err, scenarioId }, 'linkResearchToScenario error');
  }
}

/**
 * Map each StandardsFinding to the team(s) it applies to.
 * Shared command doctrines (e.g. AIIMS/ICS) are mapped to every team.
 * Returns Record<team_name, StandardsFinding[]>.
 */
export async function mapStandardsToTeams(
  openAiApiKey: string,
  teams: string[],
  findings: StandardsFinding[],
): Promise<Record<string, StandardsFinding[]>> {
  if (teams.length === 0 || findings.length === 0) return {};

  const findingsSummary = findings.map((f, i) => ({
    index: i,
    domain: f.domain,
    source: f.source,
  }));

  const prompt = `You are an expert in emergency management and crisis response.

Given these response TEAMS:
${teams.map((t) => `- ${t}`).join('\n')}

And these operational STANDARDS/DOCTRINES:
${findingsSummary.map((f) => `[${f.index}] ${f.source} (${f.domain})`).join('\n')}

Map each standard to the team(s) it primarily governs. Shared command frameworks (e.g. incident command systems like AIIMS, ICS, NIMS) should be mapped to ALL teams.

Return ONLY valid JSON:
{
  "mapping": {
    "team_name": [0, 2],
    "other_team": [1, 3]
  }
}

Where values are arrays of standard indices. Every standard must appear in at least one team. Every team must have at least one standard.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Standards-to-teams mapping failed');
      return {};
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return {};

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]) as {
      mapping?: Record<string, number[]>;
    };
    if (!parsed.mapping) return {};

    const result: Record<string, StandardsFinding[]> = {};
    for (const [team, indices] of Object.entries(parsed.mapping)) {
      const normalizedTeam = teams.find((t) => t.toLowerCase() === team.toLowerCase()) || team;
      result[normalizedTeam] = indices
        .filter((i) => i >= 0 && i < findings.length)
        .map((i) => findings[i]);
    }

    logger.info(
      { teamCount: Object.keys(result).length, standardsCount: findings.length },
      'Standards-to-teams mapping complete',
    );
    return result;
  } catch (err) {
    logger.warn({ err }, 'Standards-to-teams mapping error');
    return {};
  }
}

/**
 * Serialize a team_doctrines record into a prompt block grouped by team.
 */
export function teamDoctrinesToPromptBlock(
  teamDoctrines: Record<string, StandardsFinding[]>,
  teamFilter?: string,
): string {
  const entries = teamFilter
    ? [[teamFilter, teamDoctrines[teamFilter] ?? []] as const]
    : Object.entries(teamDoctrines);

  return entries
    .filter(([, findings]) => findings.length > 0)
    .map(
      ([team, findings]) => `[${team}]\n` + standardsToPromptBlock(findings as StandardsFinding[]),
    )
    .join('\n\n');
}

export interface TeamWorkflow {
  endgame: string;
  steps: string[];
  personnel_ratios?: Record<string, string>;
  sop_checklist?: string[];
}

/**
 * Research team-specific workflow chains — endgame definitions, step-by-step
 * process, personnel ratios, and SOP checklists for each team in the scenario.
 */
export async function researchTeamWorkflows(
  openAiApiKey: string,
  scenarioType: string,
  teamNames: string[],
  narrative?: { title?: string; description?: string; briefing?: string },
): Promise<Record<string, TeamWorkflow>> {
  if (teamNames.length === 0) return {};

  const narrativeBlock = narrative
    ? `\nScenario: ${narrative.title}\nDescription: ${narrative.description || ''}\nBriefing: ${narrative.briefing || ''}`
    : `\nScenario type: ${scenarioType}`;

  const prompt = `You are an expert in emergency management operations and standard operating procedures.
${narrativeBlock}

Teams in this exercise: ${teamNames.join(', ')}

For EACH team, research and define:

1. ENDGAME: What does "done" look like for this team? The definitive completion state.
2. STEPS: The sequential workflow chain this team follows from first action to endgame. Each step should be a discrete, verifiable action. Order matters.
3. PERSONNEL RATIOS: Key staffing ratios from real SOPs (e.g. "medic_to_patient": "1:4", "marshal_to_exit": "2:1"). Use the format "role_to_role": "N:M".
4. SOP CHECKLIST: Mandatory procedural items this team must complete per established standards (e.g. "triage_color_coding", "scene_safety_check", "communication_log").

Return ONLY valid JSON:
{
  "workflows": {
    "Team Name": {
      "endgame": "string",
      "steps": ["step1", "step2", ...],
      "personnel_ratios": { "role_to_role": "N:M" },
      "sop_checklist": ["item1", "item2"]
    }
  }
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5000,
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Team workflow research failed');
      return {};
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return {};

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]) as { workflows?: Record<string, TeamWorkflow> };
    return parsed.workflows ?? {};
  } catch (err) {
    logger.warn({ err }, 'Team workflow research error');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Crowd Dynamics Research
// ---------------------------------------------------------------------------

export interface ConvergentCrowdType {
  type: string;
  typical_arrival_minutes: number;
  behavior: string;
  size_range: string;
}

export interface CrowdDynamicsResearch {
  self_evacuation_patterns: string;
  convergent_crowd_types: ConvergentCrowdType[];
  movement_notes: string;
}

/**
 * Research crowd dynamics for a specific scenario type and venue:
 * self-evacuation patterns, convergent crowd behavior, arrival schedules.
 */
export async function researchCrowdDynamics(
  openAiApiKey: string,
  scenarioType: string,
  location?: string,
  venueName?: string,
): Promise<CrowdDynamicsResearch | null> {
  const venue = venueName || location || scenarioType;
  const locationHint = location ? ` at or near ${location}` : '';

  const prompt = `You are an expert in crowd psychology, mass casualty incidents, and emergency evacuation dynamics.

Research how crowds behave during and after a ${scenarioType}${locationHint} at a venue like ${venue}.

Cover the following areas IN DEPTH:

## 1. SELF-EVACUATION PATTERNS (first 0-15 minutes)
- Initial freeze / startle response duration and what triggers movement
- Panic flight vs orderly self-directed evacuation — what tips the balance
- Bottleneck formation at exits: which exits get overloaded and why
- Stampede / crush risk factors (crowd density thresholds, narrow corridors, locked doors)
- Role of venue staff and security in guiding initial flow
- Shell-shocked / immobile individuals — typical percentage and where they cluster
- Counter-flow: people moving TOWARD the incident (to find family, record video, help)
- Effect of alarms, PA announcements, and social cues on evacuation speed
- Differences by time of day (peak vs off-peak density)
- Injuries sustained during evacuation itself (trampling, falls, crush)

## 2. CONVERGENT CROWD TYPES (post-incident arrivals)
For EACH of the following groups, provide:
- Typical arrival window (minutes after incident)
- Estimated group size range
- Specific behaviors and demands on arrival
- How they interact with responders and cordons
- Historical examples where relevant

Groups:
a) Onlookers / rubberneckers
b) Media crews (local, national, international — staggered arrival)
c) Family members searching for loved ones
d) Self-appointed helpers / Good Samaritans / off-duty medical staff
e) Political figures, elected officials, government representatives
f) Religious and community leaders
g) Protest groups or activist organizations (if relevant to scenario type)
h) Criminal opportunists (looting, pickpocketing in chaos)

## 3. MOVEMENT & FLOW DYNAMICS
- Which entry/exit points do convergent crowds gravitate toward and why
- How convergent crowd presence interferes with ambulance staging, casualty extraction, cordon integrity
- Collision points between evacuees flowing OUT and convergent crowds flowing IN
- Secondary crowd surges triggered by rumors, aftershocks, or perceived secondary threats
- Crowd density thresholds that force cordon expansion or route changes

## 4. COMMUNICATION & INFORMATION CASCADES
- How news of the incident spreads (social media timeline, word of mouth, news alerts)
- Misinformation patterns: what false rumors typically emerge and when
- Effect of live-streamed footage on convergent crowd size
- Language and cultural factors affecting public communication effectiveness

Return ONLY valid JSON:
{
  "self_evacuation_patterns": "Detailed multi-paragraph description covering all aspects listed in section 1",
  "convergent_crowd_types": [
    {
      "type": "onlooker|media|family|helper|political|religious|protest|criminal",
      "typical_arrival_minutes": 10,
      "behavior": "Detailed description of group behavior, demands, and historical patterns",
      "size_range": "10-30"
    }
  ],
  "movement_notes": "Detailed description covering sections 3 and 4: flow dynamics, collision points, information cascades, and misinformation patterns"
}

Base your response on documented after-action reports and crowd psychology research. Use ONLY real behavioral patterns from real incidents. Be thorough — this drives realistic crowd simulation in a crisis training exercise.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiApiKey}` },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5000,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || res.statusText;
      logger.warn({ status: res.status, msg }, 'Crowd dynamics research failed');
      return null;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content as string | undefined;
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as CrowdDynamicsResearch;
    if (!parsed.self_evacuation_patterns || !Array.isArray(parsed.convergent_crowd_types)) {
      return null;
    }

    logger.info(
      { scenarioType, crowdTypes: parsed.convergent_crowd_types.length },
      'Crowd dynamics research complete',
    );
    return parsed;
  } catch (err) {
    logger.warn({ err, scenarioType }, 'Crowd dynamics research error');
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Deterioration Physics Research                                     */
/* ------------------------------------------------------------------ */

export interface DeteriorationResearch {
  per_hazard_physics: Array<{
    hazard_label: string;
    dispersion_rate: string;
    structural_progression: string;
    timeline_notes: string;
    real_world_precedent: string;
  }>;
  cross_hazard_interactions: Array<{
    hazard_a: string;
    hazard_b: string;
    interaction: string;
    compound_effect: string;
    timeline: string;
  }>;
  patient_deterioration_notes: string;
}

/**
 * Phase 4d-a: Research real-world deterioration physics for the generated
 * hazards and casualties. Uses gpt-4o-search-preview to ground the
 * deterioration timeline in scientific reality.
 */
export async function researchDeteriorationPhysics(
  hazards: Array<{ label: string; hazard_type: string; properties?: Record<string, unknown> }>,
  casualties: Array<{ casualty_type: string; conditions?: Record<string, unknown> }>,
  areaContext: string,
  venue: string,
  openAiApiKey: string,
): Promise<DeteriorationResearch | null> {
  const hazardBlock = hazards
    .map(
      (h) =>
        `- ${h.label} (${h.hazard_type})${h.properties ? `: ${JSON.stringify(h.properties)}` : ''}`,
    )
    .join('\n');

  const patientSummary = casualties
    .filter((c) => c.casualty_type === 'patient')
    .map((c) => {
      const conds = c.conditions || {};
      const injuries = (conds.injuries as Array<{ type: string; severity: string }>) || [];
      return `- ${(conds.triage_color as string) || 'unknown'} patient: ${injuries.map((i) => `${i.type}(${i.severity})`).join(', ')}`;
    })
    .join('\n');

  const prompt = `You are a hazardous materials scientist and emergency medicine physician advising a crisis simulation design team.

VENUE: ${venue}
AREA CONTEXT (excerpt):
${areaContext.slice(0, 3000)}

GENERATED HAZARDS:
${hazardBlock}

GENERATED PATIENTS (summary):
${patientSummary}

Research and provide REAL-WORLD PHYSICS for how each hazard deteriorates over time at this specific facility, and how different hazards interact with each other.

For each hazard, cover:
1. Dispersion/spread rate in local climate conditions (tropical humidity, temperature, wind patterns)
2. Structural progression timeline (fire spread rates, structural failure sequence, gas cloud expansion)
3. Timeline notes: key milestones (e.g. "ammonia cloud reaches 300ppm IDLH at 100m within 8 minutes in still tropical air")
4. Real-world precedent: cite a documented incident with similar materials

For cross-hazard interactions:
- Which hazards can combine or cascade? (e.g. fire + ammonia = toxic plume, dust + ignition source = secondary explosion)
- What compound effects emerge and on what timeline?

For patient deterioration:
- How do the specific injuries worsen over time without treatment? Reference clinical deterioration data.

Return valid JSON:
{
  "per_hazard_physics": [
    { "hazard_label": "...", "dispersion_rate": "...", "structural_progression": "...", "timeline_notes": "...", "real_world_precedent": "..." }
  ],
  "cross_hazard_interactions": [
    { "hazard_a": "...", "hazard_b": "...", "interaction": "...", "compound_effect": "...", "timeline": "..." }
  ],
  "patient_deterioration_notes": "..."
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as { error?: { message?: string } }).error?.message || response.statusText;
      logger.warn({ status: response.status, msg }, 'Deterioration research failed');
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Deterioration research returned non-JSON content');
      return null;
    }
    return JSON.parse(jsonMatch[0]) as DeteriorationResearch;
  } catch (err) {
    logger.warn({ err }, 'Deterioration research error');
    return null;
  }
}

/**
 * Serialize DeteriorationResearch into a prompt block for the generation call.
 */
export function deteriorationResearchToPromptBlock(research: DeteriorationResearch): string {
  const hazards = research.per_hazard_physics
    .map(
      (h) =>
        `[${h.hazard_label}]\n  Dispersion: ${h.dispersion_rate}\n  Structural: ${h.structural_progression}\n  Timeline: ${h.timeline_notes}\n  Precedent: ${h.real_world_precedent}`,
    )
    .join('\n\n');

  const interactions = research.cross_hazard_interactions
    .map(
      (x) =>
        `${x.hazard_a} + ${x.hazard_b}: ${x.interaction} → ${x.compound_effect} (${x.timeline})`,
    )
    .join('\n');

  return `HAZARD PHYSICS:\n${hazards}\n\nCROSS-HAZARD INTERACTIONS:\n${interactions}\n\nPATIENT DETERIORATION NOTES:\n${research.patient_deterioration_notes}`;
}

/**
 * Serialize CrowdDynamicsResearch into a prompt block for AI generation.
 */
export function crowdDynamicsToPromptBlock(research: CrowdDynamicsResearch): string {
  const types = research.convergent_crowd_types
    .map(
      (t) =>
        `  - ${t.type}: arrives ~T+${t.typical_arrival_minutes}min, size ${t.size_range}, ${t.behavior}`,
    )
    .join('\n');
  return (
    `Self-evacuation: ${research.self_evacuation_patterns}\n` +
    `Convergent crowd types:\n${types}\n` +
    `Movement notes: ${research.movement_notes}`
  );
}

/**
 * Serialize StandardsFinding[] to a compact string for embedding in AI prompts.
 */
export function standardsToPromptBlock(findings: StandardsFinding[]): string {
  if (findings.length === 0) return '';
  return findings
    .map(
      (f) =>
        `[${f.source}] ${f.domain}:\n` +
        f.key_points.map((p) => `  - ${p}`).join('\n') +
        (f.decision_thresholds ? `\n  Thresholds: ${f.decision_thresholds}` : ''),
    )
    .join('\n\n');
}

/**
 * Extract and serialize all site_requirements from findings into a prompt block.
 */
export function siteRequirementsToPromptBlock(findings: StandardsFinding[]): string {
  const allReqs: Array<{ useType: string; req: SiteRequirement; source: string }> = [];
  for (const f of findings) {
    if (!f.site_requirements) continue;
    for (const [useType, req] of Object.entries(f.site_requirements)) {
      allReqs.push({ useType, req, source: f.source });
    }
  }
  if (allReqs.length === 0) return '';
  return allReqs
    .map(({ useType, req, source }) => {
      const parts: string[] = [];
      if (req.min_area_m2 != null) parts.push(`min area: ${req.min_area_m2}m²`);
      if (req.min_capacity != null) parts.push(`min capacity: ${req.min_capacity} persons`);
      if (req.requires_water) parts.push('requires water');
      if (req.requires_electricity) parts.push('requires electricity');
      if (req.requires_shelter) parts.push('requires shelter');
      if (req.requires_vehicle_access) parts.push('requires vehicle access');
      if (req.max_distance_from_incident_m != null)
        parts.push(`max ${req.max_distance_from_incident_m}m from incident`);
      if (req.notes) parts.push(req.notes);
      return `${useType} [${source}]: ${parts.join(', ')}`;
    })
    .join('\n');
}
