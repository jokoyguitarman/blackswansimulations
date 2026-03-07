/**
 * Insider answer service: map-only and slice-based answers from insider_knowledge.
 */

import type { OsmVicinity } from './osmVicinityService.js';

export type InsiderCategory =
  | 'map'
  | 'hospitals'
  | 'police'
  | 'fire_stations'
  | 'cctv'
  | 'routes'
  | 'crowd_density'
  | 'layout'
  | 'other';

export interface InsiderKnowledgeBlob {
  vicinity_map_url?: string | null;
  layout_image_url?: string | null;
  layout_ground_truth?: {
    evacuee_count?: number;
    exits?: Array<{ id: string; label: string; flow_per_min?: number; status?: string }>;
    zones?: Array<{ id: string; label: string; capacity?: number; type?: string }>;
  };
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
    /\bexit(s)?\b|\bflow\s+rate\b|\bevacuee(s)?\b|\bcapacity\b|\btriage\s+zone\b|\bground\s+zero\b|\blayout\b/i.test(
      q,
    )
  ) {
    return 'layout';
  }
  return 'other';
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
