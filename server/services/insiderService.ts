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
  osm_vicinity?: OsmVicinity;
  custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
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
