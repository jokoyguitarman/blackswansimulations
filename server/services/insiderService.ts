/**
 * Insider answer service: map-only and slice-based answers from insider_knowledge.
 */

import { logger } from '../lib/logger.js';
import type { OsmVicinity } from './osmVicinityService.js';

export type InsiderCategory =
  | 'map'
  | 'hospitals'
  | 'police'
  | 'fire_stations'
  | 'cctv'
  | 'routes'
  | 'crowd_density'
  | 'triage_site'
  | 'evacuation_holding'
  | 'space_status'
  | 'layout'
  | 'other';

/** One site area from insider_knowledge.site_areas (C2E triage candidates). */
export interface SiteAreaEntry {
  id?: string;
  label?: string;
  surface?: string;
  level?: boolean;
  area_m2?: number;
  has_cover?: boolean;
  cover_notes?: string;
  capacity_lying?: number;
  capacity_standing?: number;
  distance_to_cordon_m?: number;
  distance_from_blast_m?: number;
  vehicle_access?: boolean;
  vehicle_notes?: string;
  stretcher_route?: boolean;
  stretcher_notes?: string;
  ambulance_pickup?: string;
  water?: boolean;
  water_notes?: string;
  power?: boolean;
  power_notes?: string;
  hazards?: string;
  wind_exposure?: string;
}

export interface InsiderKnowledgeBlob {
  vicinity_map_url?: string | null;
  layout_image_url?: string | null;
  layout_ground_truth?: {
    evacuee_count?: number;
    exits?: Array<{ id: string; label: string; flow_per_min?: number; status?: string }>;
    zones?: Array<{ id: string; label: string; capacity?: number; type?: string }>;
  };
  site_areas?: SiteAreaEntry[];
  site_requirements?: Record<string, import('./warroomResearchService.js').SiteRequirement>;
  osm_vicinity?: OsmVicinity;
  custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
  team_doctrines?: Record<string, import('./warroomResearchService.js').StandardsFinding[]>;
  team_intelligence_dossiers?: Record<
    string,
    Array<{
      question: string;
      category: string;
      answer: string;
    }>
  >;
}

function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Classify user question into a category for slice-based answer.
 */
export function classifyInsiderQuestion(question: string): InsiderCategory {
  const q = normalizeQuestion(question);
  if (
    /\b(the\s+)?map\b|\bvicinity\s+map\b|\b(layout|building)\s+(map|plan)\b|\b(show|give|send)\s+me\s+the\s+map\b/i.test(
      q,
    )
  ) {
    return 'map';
  }
  if (
    /\bhospital(s)?\b|\bmedical\s+facilit(y|ies)\b|\bhealthcare\b|\bactivate\s+hospitals\b|\bhow\s+many\s+hospitals\b/i.test(
      q,
    )
  ) {
    return 'hospitals';
  }
  if (
    /\bpolice\b|\boutpost(s)?\b|\b(law\s+enforcement|LE)\s+(location|facilities)\b/i.test(q) &&
    !/\bfire\b|\bscdf\b|\bcivil\s+defence\b/i.test(q)
  ) {
    return 'police';
  }
  if (
    /\bfire\s+station(s)?\b|\bscdf\b|\bcivil\s+defence\b|\bfire\s+department\b|\bfirefighter(s)?\b/i.test(
      q,
    )
  ) {
    return 'fire_stations';
  }
  if (
    /\bcctv\b|\bcamera(s)?\b|\bsurveillance\b|\bfootage\b|\bvideo\s+feed\b|\b(bomber|suspect).*camera\b/i.test(
      q,
    )
  ) {
    return 'cctv';
  }
  if (
    /\broute(s)?\b|\bemergency\s+(route|access)\b|\broad(s)?\b|\b(how\s+to\s+)?(get\s+)?(there|here)\b|\b(evacuation|response)\s+route\b/i.test(
      q,
    )
  ) {
    return 'routes';
  }
  if (
    /\bcrowd\s+density\b|\bpopulation\s+(around|near|in)\b|\bpeople\s+(around|near|in\s+the\s+area)\b|\bsurrounds?\s+of\s+(the\s+)?blast\b|\bdensity\s+(of\s+)?(the\s+)?(surrounds?|area)\b|\b(any\s+)?people\s+around\s+(the\s+)?(blast\s+)?(site|area)\b|\bwho\s+is\s+still\s+near\s+(ground\s+zero|the\s+blast)\b/i.test(
      q,
    )
  ) {
    return 'crowd_density';
  }
  if (
    /\btriage\s+(tent|zone|site|area|candidate|location|set\s+up|where)\b|\bwhere\s+(can|could|should)\s+(we|i)\s+set\s+up\s+(a\s+)?triage\b|\bvacant\s+lot(s)?\b|\bempty\s+lot(s)?\b|\btriage\s+candidate(s)?\b|\bsuitable\s+(for\s+)?triage\b|\b(which|what)\s+areas?\s+(can|for)\s+triage\b/i.test(
      q,
    )
  ) {
    return 'triage_site';
  }
  if (
    /\bholding\s+zone(s)?\b|\bassembly\s+(area|point)(s)?\b|\bwhere\s+(can\s+we\s+)?(send|disperse|direct)\s+evacuees\b|\bafter\s+(they\s+)?exit\b|\bstaging\s+area\b|\bevacuation\s+(holding|assembly)\b|\bwhere\s+to\s+(send|hold|stage)\s+(people|evacuees)\b|\bsuitable\s+(for\s+)?(evacuation\s+)?(holding|assembly)\b/i.test(
      q,
    )
  ) {
    return 'evacuation_holding';
  }
  if (
    /\b(what|which)\s+(spaces?|lots?|areas?)\s+(are\s+)?(available|free|open|taken|claimed)\b|\bis\s+(lot|space|bay|area)\s+\w+\s+(taken|free|available|claimed)\b|\bwho\s+is\s+using\b|\bspace\s+status\b|\bavailable\s+(spaces?|lots?|areas?)\b/i.test(
      q,
    )
  ) {
    return 'space_status';
  }
  if (
    /\bexit(s)?\b|\bflow\s+rate\b|\bevacuee(s)?\b|\bcapacity\b|\btriage\s+zone\b|\bground\s+zero\b|\blayout\b/i.test(
      q,
    )
  ) {
    return 'layout';
  }
  return 'other';
}

const VALID_INSIDER_CATEGORIES: InsiderCategory[] = [
  'map',
  'hospitals',
  'police',
  'fire_stations',
  'cctv',
  'routes',
  'crowd_density',
  'triage_site',
  'evacuation_holding',
  'space_status',
  'layout',
  'other',
];

/**
 * Classify user question via AI into one of the Insider categories. Falls back to regex classification when API key is missing or the AI call fails.
 */
export async function classifyInsiderQuestionWithAI(
  question: string,
  openAiApiKey: string | undefined,
): Promise<InsiderCategory> {
  if (!openAiApiKey?.trim()) {
    return classifyInsiderQuestion(question);
  }
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You classify a crisis-simulation player question into exactly one category. Return ONLY a JSON object: { "category": "<category>" }.

Valid categories and what they mean:
- map: request for a map, layout image, or vicinity map
- hospitals: hospitals, medical facilities, healthcare, activating hospitals
- police: police stations, outposts, law enforcement locations (not fire/SCDF)
- fire_stations: fire stations, SCDF, civil defence, fire department
- cctv: CCTV, cameras, surveillance, footage, video feed
- routes: evacuation routes, emergency routes, roads, access, how to get there
- crowd_density: crowd density, population around the area, people near the blast/site
- triage_site: where to set up triage, triage zones/sites/tents, vacant lots for casualties, suitable areas for triage
- evacuation_holding: where to send or hold evacuees after they exit, evacuation holding zones, assembly areas, staging areas
- space_status: what spaces/lots/areas are available or taken, who is using a space, is a space claimed, space availability
- layout: exits, flow rate, evacuees, capacity, ground zero, general layout (not map image)
- other: none of the above or unclear

Pick the single best-matching category. Use "other" only if the question does not clearly fit any other category.`,
          },
          {
            role: 'user',
            content: normalizeQuestion(question).slice(0, 1000) || question.slice(0, 1000),
          },
        ],
        temperature: 0.2,
        max_tokens: 30,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.warn(
        { status: response.status, body: text },
        'Insider AI classification request failed',
      );
      return classifyInsiderQuestion(question);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      return classifyInsiderQuestion(question);
    }
    const parsed = JSON.parse(content) as { category?: string };
    const category = parsed.category;
    if (
      typeof category === 'string' &&
      VALID_INSIDER_CATEGORIES.includes(category as InsiderCategory)
    ) {
      return category as InsiderCategory;
    }
    return classifyInsiderQuestion(question);
  } catch (e) {
    logger.warn({ err: e }, 'classifyInsiderQuestionWithAI failed, using regex fallback');
    return classifyInsiderQuestion(question);
  }
}

/**
 * Location row when building triage-site answer: map pin label + conditions, optionally enriched with insider_knowledge.site_areas.
 */
export interface TriageSiteLocationRow {
  label: string;
  conditions?: Record<string, unknown> | null;
  /** Enriched from insider_knowledge.site_areas (same order as map pins: A→0, B→1, …). */
  site_area?: SiteAreaEntry | null;
}

/**
 * Build answer listing vacant lots / triage zone candidates with capacities, size, access, and utilities.
 * Uses scenario_locations (map pins) and, when present, insider_knowledge.site_areas for richer detail.
 */
export function buildTriageSiteAnswerFromLocations(locations: TriageSiteLocationRow[]): {
  answer: string;
  sources_used: string;
} {
  if (!locations.length) {
    return {
      answer:
        "I don't have specific vacant lots or triage site candidates for this scenario. Check the map for any pinned areas.",
      sources_used: 'scenario_locations',
    };
  }
  const usedSiteAreas = locations.some((loc) => loc.site_area != null);
  const lines = locations.map((loc) => {
    const cond = loc.conditions ?? {};
    const sa = loc.site_area;
    const lying =
      (sa?.capacity_lying as number | undefined) ?? (cond.capacity_lying as number | undefined);
    const standing =
      (sa?.capacity_standing as number | undefined) ??
      (cond.capacity_standing as number | undefined);
    const suitability = (cond.suitability as string) ?? null;
    const hazards = sa?.hazards ?? (cond.hazards as string) ?? null;
    const areaM2 = sa?.area_m2;
    const vehicleAccess = sa?.vehicle_access;
    const vehicleNotes = sa?.vehicle_notes;
    const stretcherRoute = sa?.stretcher_route;
    const stretcherNotes = sa?.stretcher_notes;
    const ambulancePickup = sa?.ambulance_pickup;
    const water = sa?.water;
    const waterNotes = sa?.water_notes;
    const power = sa?.power;
    const powerNotes = sa?.power_notes;
    const coverNotes = sa?.cover_notes;
    const distanceCordon =
      sa?.distance_to_cordon_m ?? (cond.distance_from_cordon_m as number | undefined);
    const distanceBlast =
      (cond.distance_from_blast_m as number | undefined) ??
      (sa?.distance_from_blast_m as number | undefined);
    const windExposure = sa?.wind_exposure;

    const parts: string[] = [];
    if (lying != null && typeof lying === 'number') parts.push(`lying capacity ${lying}`);
    if (standing != null && typeof standing === 'number')
      parts.push(`standing capacity ${standing}`);
    if (areaM2 != null && typeof areaM2 === 'number') parts.push(`~${areaM2} m²`);
    if (suitability) parts.push(`suitability ${suitability}`);
    const capText = parts.length ? ` — ${parts.join('; ')}` : '';
    const detail: string[] = [];
    if (hazards) detail.push(hazards);
    if (coverNotes) detail.push(coverNotes);
    if (vehicleAccess !== undefined) {
      detail.push(vehicleAccess ? `Vehicle access: ${vehicleNotes ?? 'yes'}` : 'No vehicle access');
    }
    if (stretcherRoute !== undefined && stretcherNotes) {
      detail.push(`Stretcher: ${stretcherNotes}`);
    }
    if (ambulancePickup) detail.push(`Ambulance pickup: ${ambulancePickup}`);
    if (water !== undefined) {
      detail.push(water ? `Water: ${waterNotes ?? 'available'}` : 'No water on site');
    }
    if (power !== undefined) {
      detail.push(power ? `Power: ${powerNotes ?? 'available'}` : 'No power on site');
    }
    if (distanceCordon != null) detail.push(`${distanceCordon} m from cordon`);
    if (distanceBlast != null && typeof distanceBlast === 'number')
      detail.push(`${distanceBlast} m from blast`);
    if (windExposure) detail.push(windExposure);
    const detailText = detail.length ? ` ${detail.join('. ')}` : '';
    return `- **${loc.label}**${capText}.${detailText}`;
  });
  const answer = `These empty or vacant lots are pinned on the map and can be used as triage zone candidates:\n\n${lines.join('\n\n')}\n\nUse the map to see their exact positions.`;
  return {
    answer,
    sources_used: usedSiteAreas
      ? 'scenario_locations, insider_knowledge.site_areas'
      : 'scenario_locations',
  };
}

/** Row for building evacuation-holding answer from scenario_locations (label + conditions). */
export interface EvacuationHoldingLocationRow {
  label: string;
  conditions?: Record<string, unknown> | null;
}

/**
 * Build answer listing evacuation holding / assembly zones with capacity, suitability, nearest exit, etc.
 * Uses scenario_locations (map pins) with location_type = 'evacuation_holding' only.
 */
export function buildEvacuationHoldingAnswerFromLocations(
  locations: EvacuationHoldingLocationRow[],
): { answer: string; sources_used: string } {
  if (!locations.length) {
    return {
      answer:
        "I don't have specific evacuation holding or assembly areas for this scenario. Check the map for any pinned areas.",
      sources_used: 'scenario_locations',
    };
  }
  const lines = locations.map((loc) => {
    const cond = loc.conditions ?? {};
    const capacity = cond.capacity as number | undefined;
    const suitability = (cond.suitability as string) ?? null;
    const nearestExit = (cond.nearest_exit as string) ?? null;
    const hazards = (cond.hazards as string) ?? null;
    const hasCover = cond.has_cover as boolean | undefined;
    const distanceCordon = cond.distance_from_cordon_m as number | undefined;
    const distanceBlast = cond.distance_from_blast_m as number | undefined;
    const water = cond.water as boolean | undefined;
    const waterNotes = cond.water_notes as string | undefined;
    const power = cond.power as boolean | undefined;
    const powerNotes = cond.power_notes as string | undefined;

    const parts: string[] = [];
    if (capacity != null && typeof capacity === 'number') parts.push(`capacity ${capacity}`);
    if (suitability) parts.push(`suitability ${suitability}`);
    if (nearestExit) parts.push(`nearest exit ${nearestExit}`);
    const capText = parts.length ? ` — ${parts.join('; ')}` : '';
    const detail: string[] = [];
    if (hazards) detail.push(hazards);
    if (hasCover !== undefined) {
      detail.push(hasCover ? 'Cover available' : 'No cover');
    }
    if (distanceCordon != null && typeof distanceCordon === 'number') {
      detail.push(`${distanceCordon} m from cordon`);
    }
    if (distanceBlast != null && typeof distanceBlast === 'number') {
      detail.push(`${distanceBlast} m from blast`);
    }
    if (water !== undefined) {
      detail.push(water ? `Water: ${waterNotes ?? 'available'}` : 'No water on site');
    }
    if (power !== undefined) {
      detail.push(power ? `Power: ${powerNotes ?? 'available'}` : 'No power on site');
    }
    const detailText = detail.length ? ` ${detail.join('. ')}` : '';
    return `- **${loc.label}**${capText}.${detailText}`;
  });
  const answer = `These areas are pinned on the map and can be used to hold or disperse evacuees after they exit:\n\n${lines.join('\n\n')}\n\nUse the map to see their exact positions.`;
  return {
    answer,
    sources_used: 'scenario_locations',
  };
}

/**
 * Build map-only response: just the URL(s), no narrative.
 */
export function buildMapOnlyResponse(knowledge: InsiderKnowledgeBlob): {
  answer: string;
  sources_used: string;
} {
  const urls: string[] = [];
  if (knowledge.vicinity_map_url) urls.push(knowledge.vicinity_map_url);
  if (knowledge.layout_image_url) urls.push(knowledge.layout_image_url);
  if (urls.length === 0) {
    return { answer: 'No map is available for this scenario.', sources_used: 'none' };
  }
  const answer = urls.map((u) => u).join('\n\n');
  return { answer, sources_used: 'vicinity_map_url, layout_image_url' };
}

/**
 * Build answer from the relevant slice of insider_knowledge.
 */
export function buildSliceAnswer(
  knowledge: InsiderKnowledgeBlob,
  category: InsiderCategory,
): { answer: string; sources_used: string } {
  if (category === 'map') {
    return buildMapOnlyResponse(knowledge);
  }

  if (category === 'hospitals' && knowledge.osm_vicinity?.hospitals) {
    const list = knowledge.osm_vicinity.hospitals;
    const lines = list.map(
      (h) =>
        `- ${h.name} (${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}${h.address ? `; ${h.address}` : ''})`,
    );
    const answer = `There are ${list.length} hospital(s) in the vicinity:\n\n${lines.join('\n')}`;
    return { answer, sources_used: 'osm_vicinity.hospitals' };
  }

  if (category === 'police' && knowledge.osm_vicinity?.police) {
    const list = knowledge.osm_vicinity.police;
    const lines = list.map(
      (p) =>
        `- ${p.name} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}${p.address ? `; ${p.address}` : ''})`,
    );
    const answer = `There are ${list.length} police station(s)/outpost(s) in the vicinity:\n\n${lines.join('\n')}`;
    return { answer, sources_used: 'osm_vicinity.police' };
  }

  if (category === 'fire_stations' && knowledge.osm_vicinity?.fire_stations) {
    const list = knowledge.osm_vicinity.fire_stations;
    const lines = list.map(
      (f) =>
        `- ${f.name} (${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}${f.address ? `; ${f.address}` : ''})`,
    );
    const answer = `There are ${list.length} fire station(s)/SCDF post(s) in the vicinity:\n\n${lines.join('\n')}`;
    return { answer, sources_used: 'osm_vicinity.fire_stations' };
  }

  if (
    category === 'fire_stations' &&
    (!knowledge.osm_vicinity?.fire_stations || knowledge.osm_vicinity.fire_stations.length === 0)
  ) {
    return {
      answer: 'No fire stations or SCDF posts are listed for this vicinity.',
      sources_used: 'none',
    };
  }

  if (category === 'cctv' && knowledge.osm_vicinity?.cctv_or_surveillance) {
    const list = knowledge.osm_vicinity.cctv_or_surveillance;
    const lines = list.map((c) => `- ${c.location} (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`);
    const answer = `There are ${list.length} known CCTV/surveillance point(s) in the area:\n\n${lines.join('\n')}`;
    return { answer, sources_used: 'osm_vicinity.cctv_or_surveillance' };
  }

  if (
    category === 'cctv' &&
    (!knowledge.osm_vicinity?.cctv_or_surveillance ||
      knowledge.osm_vicinity.cctv_or_surveillance.length === 0)
  ) {
    return {
      answer: 'No public CCTV/surveillance data is available for this vicinity.',
      sources_used: 'none',
    };
  }

  if (category === 'routes' && knowledge.osm_vicinity?.emergency_routes) {
    const list = knowledge.osm_vicinity.emergency_routes;
    const lines = list.map(
      (r) =>
        `- ${r.description}${r.highway_type ? ` (${r.highway_type})` : ''}${r.one_way ? ' [one-way]' : ''}`,
    );
    const answer = `Possible emergency routes in the vicinity:\n\n${lines.join('\n')}`;
    return { answer, sources_used: 'osm_vicinity.emergency_routes' };
  }

  if (category === 'crowd_density') {
    if (knowledge.custom_facts?.length) {
      const fact = knowledge.custom_facts.find(
        (f) =>
          f.topic.toLowerCase().includes('crowd_density') ||
          f.topic.toLowerCase().includes('crowd') ||
          f.summary.toLowerCase().includes('crowd') ||
          f.summary.toLowerCase().includes('density'),
      );
      if (fact) {
        return {
          answer: fact.detail || fact.summary,
          sources_used: 'custom_facts',
        };
      }
    }
    return {
      answer: "I don't have crowd density or population-around-site data for this scenario.",
      sources_used: 'none',
    };
  }

  if (category === 'layout' && knowledge.layout_ground_truth) {
    const g = knowledge.layout_ground_truth;
    const parts: string[] = [];
    if (g.evacuee_count != null) parts.push(`Evacuees: ${g.evacuee_count}`);
    if (g.exits?.length) {
      parts.push(
        `Exits: ${g.exits.map((e) => `${e.label}${e.flow_per_min != null ? ` (${e.flow_per_min}/min)` : ''}${e.status ? ` [${e.status}]` : ''}`).join('; ')}`,
      );
    }
    if (g.zones?.length) {
      parts.push(
        `Zones: ${g.zones.map((z) => `${z.label}${z.capacity != null ? ` capacity ${z.capacity}` : ''}`).join('; ')}`,
      );
    }
    const answer = parts.length > 0 ? parts.join('\n') : 'No layout details are available.';
    return { answer, sources_used: 'layout_ground_truth' };
  }

  // custom_facts: check topic match loosely
  if (knowledge.custom_facts?.length) {
    const q = category === 'other' ? '' : category;
    const fact = knowledge.custom_facts.find(
      (f) => q && (f.topic.toLowerCase().includes(q) || f.summary.toLowerCase().includes(q)),
    );
    if (fact) {
      return {
        answer: fact.detail || fact.summary,
        sources_used: 'custom_facts',
      };
    }
  }

  return {
    answer: "I don't have that information for this scenario.",
    sources_used: 'none',
  };
}

// ---------------------------------------------------------------------------
// New-model builders for physical-space pins and enriched POIs
// ---------------------------------------------------------------------------

export interface PhysicalSpaceLocationRow {
  label: string;
  conditions?: Record<string, unknown>;
  claim?: { claimed_by?: string; claimed_as?: string; claimed_at_minutes?: number };
}

export function buildPhysicalSpaceAnswer(
  locations: PhysicalSpaceLocationRow[],
  useType: string,
  siteRequirements?: Record<string, import('./warroomResearchService.js').SiteRequirement>,
): { answer: string; sources_used: string } {
  if (!locations.length) {
    return {
      answer: `No candidate spaces with potential for "${useType}" were found for this scenario. Check the map for available areas.`,
      sources_used: 'scenario_locations',
    };
  }

  const req = siteRequirements?.[useType];
  const reqBlock = req
    ? `\n\n**Requirements for ${useType}** (per standards):\n` +
      [
        req.min_area_m2 != null ? `- Min area: ${req.min_area_m2}m²` : null,
        req.min_capacity != null ? `- Min capacity: ${req.min_capacity} persons` : null,
        req.requires_water ? '- Requires water access' : null,
        req.requires_electricity ? '- Requires electricity' : null,
        req.requires_shelter ? '- Requires shelter/cover' : null,
        req.requires_vehicle_access ? '- Requires vehicle access' : null,
        req.max_distance_from_incident_m != null
          ? `- Max ${req.max_distance_from_incident_m}m from incident`
          : null,
        req.notes ? `- ${req.notes}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const lines = locations.map((loc) => {
    const cond = loc.conditions ?? {};
    const parts: string[] = [];
    if (cond.area_m2 != null) parts.push(`${cond.area_m2}m²`);
    if (cond.capacity_persons != null) parts.push(`capacity ${cond.capacity_persons}`);
    if (cond.has_water !== undefined) parts.push(cond.has_water ? 'water: yes' : 'no water');
    if (cond.has_electricity !== undefined)
      parts.push(cond.has_electricity ? 'electricity: yes' : 'no electricity');
    if (cond.has_shelter !== undefined) parts.push(cond.has_shelter ? 'sheltered' : 'unsheltered');
    if (cond.vehicle_access !== undefined)
      parts.push(cond.vehicle_access ? 'vehicle access' : 'no vehicle access');
    if (cond.distance_from_incident_m != null)
      parts.push(`${cond.distance_from_incident_m}m from incident`);
    if (cond.surface) parts.push(`surface: ${cond.surface}`);
    const propText = parts.length ? ` — ${parts.join('; ')}` : '';

    const shortfalls: string[] = [];
    if (req) {
      if (
        req.min_area_m2 != null &&
        typeof cond.area_m2 === 'number' &&
        cond.area_m2 < req.min_area_m2
      )
        shortfalls.push(`area below min ${req.min_area_m2}m²`);
      if (
        req.min_capacity != null &&
        typeof cond.capacity_persons === 'number' &&
        cond.capacity_persons < req.min_capacity
      )
        shortfalls.push(`capacity below min ${req.min_capacity}`);
      if (req.requires_water && cond.has_water === false) shortfalls.push('no water (required)');
      if (req.requires_electricity && cond.has_electricity === false)
        shortfalls.push('no electricity (required)');
      if (req.requires_shelter && cond.has_shelter === false)
        shortfalls.push('no shelter (required)');
      if (req.requires_vehicle_access && cond.vehicle_access === false)
        shortfalls.push('no vehicle access (required)');
      if (
        req.max_distance_from_incident_m != null &&
        typeof cond.distance_from_incident_m === 'number' &&
        cond.distance_from_incident_m > req.max_distance_from_incident_m
      )
        shortfalls.push(
          `too far (${cond.distance_from_incident_m}m, max ${req.max_distance_from_incident_m}m)`,
        );
    }
    const shortfallText = shortfalls.length ? ` ⚠ ${shortfalls.join('; ')}` : '';

    const claimText = loc.claim?.claimed_by
      ? ` [CLAIMED by ${loc.claim.claimed_by} as ${loc.claim.claimed_as ?? 'unknown'} since T+${loc.claim.claimed_at_minutes ?? '?'}]`
      : '';

    const notes = cond.notes ? ` ${cond.notes}` : '';

    return `- **${loc.label}**${propText}.${notes}${shortfallText}${claimText}`;
  });

  const answer = `These candidate spaces could potentially be used for ${useType}:\n\n${lines.join('\n\n')}${reqBlock}\n\nUse the map to see their exact positions.`;
  return { answer, sources_used: 'scenario_locations' };
}

export interface EnrichedPoiRow {
  label: string;
  location_type: string;
  conditions?: Record<string, unknown>;
}

export function buildEnrichedPoiAnswer(
  locations: EnrichedPoiRow[],
  poiType: 'hospital' | 'police_station' | 'fire_station',
): { answer: string; sources_used: string } {
  if (!locations.length) {
    const typeLabel =
      poiType === 'hospital'
        ? 'hospitals'
        : poiType === 'police_station'
          ? 'police stations'
          : 'fire stations';
    return {
      answer: `No ${typeLabel} with detailed data are available for this scenario.`,
      sources_used: 'none',
    };
  }

  const lines = locations.map((loc) => {
    const cond = loc.conditions ?? {};
    const parts: string[] = [];

    if (cond.distance_from_incident_m != null)
      parts.push(`${cond.distance_from_incident_m}m from incident`);
    if (cond.estimated_response_time_min != null)
      parts.push(`~${cond.estimated_response_time_min} min response`);

    if (poiType === 'hospital') {
      if (cond.facility_type) parts.push(String(cond.facility_type).replace(/_/g, ' '));
      if (cond.trauma_center_level) parts.push(String(cond.trauma_center_level));
      if (cond.bed_capacity != null) parts.push(`${cond.bed_capacity} beds`);
      if (cond.emergency_beds_available != null)
        parts.push(`${cond.emergency_beds_available} emergency beds available`);
      if (cond.has_helipad) parts.push('helipad');
      if (cond.ambulance_bays != null) parts.push(`${cond.ambulance_bays} ambulance bays`);
      if (Array.isArray(cond.specializations) && cond.specializations.length > 0)
        parts.push(`specializations: ${(cond.specializations as string[]).join(', ')}`);
    } else if (poiType === 'police_station') {
      if (cond.facility_type) parts.push(String(cond.facility_type).replace(/_/g, ' '));
      if (cond.available_officers_estimate != null)
        parts.push(`~${cond.available_officers_estimate} officers`);
      if (cond.has_tactical_unit) parts.push('tactical unit available');
      if (cond.has_negotiation_team) parts.push('negotiation team');
      if (cond.has_k9_unit) parts.push('K9 unit');
    } else {
      if (cond.facility_type) parts.push(String(cond.facility_type).replace(/_/g, ' '));
      if (cond.appliance_count != null) parts.push(`${cond.appliance_count} appliances`);
      if (cond.has_hazmat_unit) parts.push('hazmat');
      if (cond.has_rescue_unit) parts.push('rescue');
      if (cond.has_aerial_platform) parts.push('aerial platform');
    }

    const notes = cond.notes ? ` ${cond.notes}` : '';
    const propText = parts.length ? ` — ${parts.join('; ')}` : '';
    return `- **${loc.label}**${propText}.${notes}`;
  });

  const typeLabel =
    poiType === 'hospital'
      ? 'hospital(s)'
      : poiType === 'police_station'
        ? 'police station(s)/outpost(s)'
        : 'fire station(s)';

  const answer = `There are ${locations.length} ${typeLabel} in the vicinity:\n\n${lines.join('\n\n')}`;
  return { answer, sources_used: 'scenario_locations (enriched POI pins)' };
}

export function buildSpaceStatusAnswer(locations: PhysicalSpaceLocationRow[]): {
  answer: string;
  sources_used: string;
} {
  if (!locations.length) {
    return {
      answer: 'No candidate spaces are available for this scenario.',
      sources_used: 'scenario_locations',
    };
  }

  const claimed = locations.filter((l) => l.claim?.claimed_by);
  const available = locations.filter((l) => !l.claim?.claimed_by);

  const lines: string[] = [];
  if (available.length > 0) {
    lines.push(`**Available spaces (${available.length}):**`);
    for (const loc of available) {
      const cond = loc.conditions ?? {};
      const parts: string[] = [];
      if (cond.area_m2 != null) parts.push(`${cond.area_m2}m²`);
      if (cond.capacity_persons != null) parts.push(`capacity ${cond.capacity_persons}`);
      if (cond.has_shelter !== undefined) parts.push(cond.has_shelter ? 'sheltered' : 'open');
      const propText = parts.length ? ` (${parts.join(', ')})` : '';
      lines.push(`- ${loc.label}${propText}`);
    }
  }
  if (claimed.length > 0) {
    lines.push(`\n**Claimed spaces (${claimed.length}):**`);
    for (const loc of claimed) {
      lines.push(
        `- ${loc.label} — claimed by **${loc.claim!.claimed_by}** as **${loc.claim!.claimed_as ?? 'unknown'}** since T+${loc.claim!.claimed_at_minutes ?? '?'}`,
      );
    }
  }

  return { answer: lines.join('\n'), sources_used: 'scenario_locations, session_state' };
}

// ---------------------------------------------------------------------------
// AI-powered contextual answer — accepts any question, searches all data
// ---------------------------------------------------------------------------

export interface InsiderContext {
  scenarioTitle?: string;
  scenarioDescription?: string;
  scenarioBriefing?: string;
  scenarioType?: string;
  durationMinutes?: number;
  knowledge: InsiderKnowledgeBlob;
  locations: Array<{
    label: string;
    location_type: string;
    description?: string;
    conditions?: Record<string, unknown>;
  }>;
  environmentalSeeds: Array<{ variant_label: string; seed_data: Record<string, unknown> }>;
  teams: Array<{ team_name: string; team_description: string }>;
  currentState?: Record<string, unknown>;
  locationState?: Record<
    string,
    { claimed_by?: string; claimed_as?: string; claimed_at_minutes?: number }
  >;
  elapsedMinutes?: number;
  askingTeamName?: string;
  /** Titles of injects already published in this session (for time-gating intel). */
  publishedInjectTitles?: string[];
}

function truncateJson(obj: unknown, maxChars: number): string {
  const full = JSON.stringify(obj, null, 0);
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars) + '... (truncated)';
}

const SECOND_DEVICE_UNLOCK_INJECTS = [
  'Suspicious Individual',
  'Suspected Second Device',
  'Second device found and defused',
  'Second device detonates (area populated)',
  'Second device detonates (area cleared)',
];

const SECOND_DEVICE_REGEX = /second\s+(device|bomb|explosive)|exit\s+b.*backpack|suicide\s+attack/i;

function isSecondDeviceUnlocked(publishedTitles?: string[]): boolean {
  if (!publishedTitles?.length) return false;
  return publishedTitles.some((t) =>
    SECOND_DEVICE_UNLOCK_INJECTS.some((u) => t.toLowerCase().includes(u.toLowerCase())),
  );
}

function buildInsiderContextBlock(ctx: InsiderContext): string {
  const parts: string[] = [];
  const secondDeviceRevealed = isSecondDeviceUnlocked(ctx.publishedInjectTitles);

  if (ctx.scenarioTitle) parts.push(`SCENARIO: ${ctx.scenarioTitle}`);
  if (ctx.scenarioType) parts.push(`TYPE: ${ctx.scenarioType}`);
  if (ctx.scenarioDescription) parts.push(`DESCRIPTION: ${ctx.scenarioDescription}`);
  if (ctx.scenarioBriefing) parts.push(`BRIEFING: ${ctx.scenarioBriefing.slice(0, 2000)}`);
  if (ctx.durationMinutes) parts.push(`DURATION: ${ctx.durationMinutes} minutes`);
  if (ctx.elapsedMinutes != null) parts.push(`TIME ELAPSED: ${ctx.elapsedMinutes} minutes`);

  if (ctx.teams.length > 0) {
    parts.push(
      `TEAMS:\n${ctx.teams.map((t) => `- ${t.team_name}: ${t.team_description}`).join('\n')}`,
    );
  }

  if (ctx.locations.length > 0) {
    const locLines = ctx.locations.map((l) => {
      const cond = l.conditions ? ` | Properties: ${truncateJson(l.conditions, 300)}` : '';
      return `- ${l.label} (${l.location_type})${l.description ? `: ${l.description}` : ''}${cond}`;
    });
    parts.push(`MAP LOCATIONS (${ctx.locations.length} pins):\n${locLines.join('\n')}`);
  }

  if (ctx.locationState && Object.keys(ctx.locationState).length > 0) {
    const claimLines = Object.entries(ctx.locationState)
      .filter(([, v]) => v.claimed_by)
      .map(
        ([id, v]) =>
          `- ${id}: claimed by ${v.claimed_by} as ${v.claimed_as ?? '?'} at T+${v.claimed_at_minutes ?? '?'}`,
      );
    if (claimLines.length > 0) {
      parts.push(`CLAIMED LOCATIONS:\n${claimLines.join('\n')}`);
    }
  }

  const k = ctx.knowledge;

  if (k.layout_ground_truth) {
    parts.push(`LAYOUT GROUND TRUTH:\n${truncateJson(k.layout_ground_truth, 1500)}`);
  }

  if (k.site_areas?.length) {
    parts.push(`SITE AREAS (triage/staging candidates):\n${truncateJson(k.site_areas, 2000)}`);
  }

  if (k.osm_vicinity) {
    const osm = k.osm_vicinity;
    const osmParts: string[] = [];
    if (osm.hospitals?.length) osmParts.push(`Hospitals: ${truncateJson(osm.hospitals, 800)}`);
    if (osm.police?.length) osmParts.push(`Police: ${truncateJson(osm.police, 800)}`);
    if (osm.fire_stations?.length)
      osmParts.push(`Fire stations: ${truncateJson(osm.fire_stations, 800)}`);
    if (osm.emergency_routes?.length)
      osmParts.push(`Emergency routes: ${truncateJson(osm.emergency_routes, 800)}`);
    if (osm.cctv_or_surveillance?.length)
      osmParts.push(`CCTV: ${truncateJson(osm.cctv_or_surveillance, 500)}`);
    if (osmParts.length > 0) parts.push(`NEARBY FACILITIES (OSM):\n${osmParts.join('\n')}`);
  }

  if (k.custom_facts?.length) {
    const visibleFacts = secondDeviceRevealed
      ? k.custom_facts
      : k.custom_facts.filter((f) => {
          const text = `${f.topic} ${f.summary} ${f.detail ?? ''}`;
          return !SECOND_DEVICE_REGEX.test(text);
        });
    const factLines = visibleFacts.map((f) => `- ${f.topic}: ${f.detail || f.summary}`);
    if (factLines.length > 0) {
      parts.push(`SCENARIO FACTS:\n${factLines.join('\n')}`);
    }
  }

  if (k.team_doctrines && Object.keys(k.team_doctrines).length > 0) {
    parts.push(`TEAM DOCTRINES/STANDARDS:\n${truncateJson(k.team_doctrines, 1500)}`);
  }

  if (k.team_intelligence_dossiers && Object.keys(k.team_intelligence_dossiers).length > 0) {
    if (ctx.askingTeamName && k.team_intelligence_dossiers[ctx.askingTeamName]?.length) {
      const dossier = k.team_intelligence_dossiers[ctx.askingTeamName];
      const dossierLines = dossier.map((d) => `Q: ${d.question}\nA: ${d.answer}`);
      parts.push(
        `INTELLIGENCE DOSSIER FOR ${ctx.askingTeamName.toUpperCase()}:\n${dossierLines.join('\n\n')}`,
      );
    } else {
      const allLines: string[] = [];
      for (const [team, entries] of Object.entries(k.team_intelligence_dossiers)) {
        const teamLines = entries.slice(0, 5).map((d) => `Q: ${d.question}\nA: ${d.answer}`);
        allLines.push(`[${team}]\n${teamLines.join('\n\n')}`);
      }
      if (allLines.length > 0) {
        parts.push(`INTELLIGENCE DOSSIERS (all teams, summary):\n${allLines.join('\n\n')}`);
      }
    }
  }

  if (ctx.environmentalSeeds.length > 0) {
    for (const seed of ctx.environmentalSeeds.slice(0, 2)) {
      parts.push(
        `ENVIRONMENTAL SEED (${seed.variant_label}):\n${truncateJson(seed.seed_data, 2000)}`,
      );
    }
  }

  if (ctx.currentState && Object.keys(ctx.currentState).length > 0) {
    const stateToShow = { ...ctx.currentState };
    delete stateToShow._counter_definitions;
    delete stateToShow.location_state;
    parts.push(`CURRENT GAME STATE:\n${truncateJson(stateToShow, 2000)}`);
  }

  return parts.join('\n\n');
}

export async function buildAIContextualAnswer(
  question: string,
  ctx: InsiderContext,
  openAiApiKey: string,
): Promise<{ answer: string; sources_used: string }> {
  const contextBlock = buildInsiderContextBlock(ctx);

  const secondDeviceRevealed = isSecondDeviceUnlocked(ctx.publishedInjectTitles);

  const intelLockRule = secondDeviceRevealed
    ? ''
    : `
- CRITICAL INTEL RESTRICTION: There is NO confirmed intelligence about a second device or secondary explosive at this time. Rumours about a "second bomb" are UNVERIFIED. If the player asks about a second device, second bomb, suspicious individual with a backpack, or anything related, respond ONLY with: "We have no confirmed intelligence on a secondary device at this time. There are unverified rumours circulating but no evidence to support them. Focus on confirmed threats." Do NOT reveal any details about Exit B, backpacks, suicide attackers, or bomb disposal procedures for a second device.`;

  const systemPrompt = `You are the "Insider" — a knowledgeable intelligence operative embedded in a crisis management simulation. You have deep knowledge of the area, the scenario, the facilities, the environment, and the current game state.

Your job: answer the player's question using ONLY the context provided below. Be specific, cite actual location names, distances, capacities, and conditions from the data. If the data contains the answer, give it clearly and concisely. If the data does not contain enough information to answer, say so honestly.

RULES:
- Answer in a professional, concise intelligence-briefing style
- Use markdown formatting (bold for location names, bullet points for lists)
- Reference specific data: names, numbers, distances, capacities, conditions
- If the question is about a location, include its properties (capacity, water, electricity, distance, etc.)
- If locations have been claimed by teams, mention that
- If environmental conditions (routes, weather, crowd density) are relevant, include them
- Do NOT make up information that isn't in the context
- Do NOT reveal internal game mechanics (condition keys, state schema, inject triggers)
- Keep answers focused — 2-6 sentences for simple questions, longer with structured data for complex ones
- If the player asks about the map, tell them to use the interactive map in the session view${intelLockRule}

CONTEXT:
${contextBlock}`;

  try {
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
          { role: 'user', content: question.slice(0, 2000) },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, body: text }, 'Insider AI contextual answer failed');
      return {
        answer: "I'm having trouble processing that question right now. Try asking again.",
        sources_used: 'none',
      };
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;

    if (!content?.trim()) {
      return {
        answer: "I don't have enough information to answer that question for this scenario.",
        sources_used: 'none',
      };
    }

    return { answer: content.trim(), sources_used: 'ai_contextual' };
  } catch (err) {
    logger.error({ err }, 'Insider AI contextual answer threw');
    return {
      answer: "I'm having trouble processing that question right now. Try asking again.",
      sources_used: 'none',
    };
  }
}
