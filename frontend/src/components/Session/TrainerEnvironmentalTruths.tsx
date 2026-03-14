/**
 * Trainer-only module: shows environmental truths, conditions, and standards
 * that the backend uses to evaluate decisions and drive injects.
 * Enables trainers to manually verify events use information correctly.
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface LayoutGroundTruth {
  evacuee_count?: number;
  exits?: Array<{
    id?: string;
    label?: string;
    flow_per_min?: number;
    status?: string;
  }>;
  zones?: Array<{ id?: string; label?: string; capacity?: number; type?: string }>;
  blast_site?: { description?: string };
}

interface SiteArea {
  label?: string;
  capacity_lying?: number;
  capacity_standing?: number;
  area_m2?: number;
  hazards?: string;
  vehicle_access?: boolean;
  stretcher_route?: boolean;
  water?: boolean;
  power?: boolean;
}

interface OsmVicinity {
  emergency_routes?: Array<{ description?: string; one_way?: boolean }>;
  hospitals?: Array<{ name?: string; address?: string }>;
}

interface EscalationFactor {
  id?: string;
  name?: string;
  description?: string;
  severity?: string;
}

interface CustomFact {
  topic?: string;
  summary?: string;
  detail?: string;
}

interface SiteRequirement {
  min_area_m2?: number;
  requires_water?: boolean;
  requires_shelter?: boolean;
  requires_vehicle_access?: boolean;
  requires_electricity?: boolean;
  min_capacity?: number;
  max_distance_from_incident_m?: number;
  notes?: string;
}

interface StandardsFindingDisplay {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
}

interface InsiderKnowledge {
  layout_ground_truth?: LayoutGroundTruth;
  site_areas?: SiteArea[];
  site_requirements?: Record<string, SiteRequirement>;
  osm_vicinity?: OsmVicinity;
  sector_standards?: string;
  sector_standards_structured?: StandardsFindingDisplay[];
  team_doctrines?: Record<string, StandardsFindingDisplay[]>;
  baseline_escalation_factors?: EscalationFactor[];
  custom_facts?: CustomFact[];
}

interface LocationRow {
  id?: string;
  label?: string;
  location_type?: string;
  coordinates?: { lat?: number; lng?: number };
  conditions?: Record<string, unknown> | null;
  display_order?: number;
}

interface EnvArea {
  area_id?: string;
  label?: string;
  type?: string;
  at_capacity?: boolean;
  capacity?: number;
}

interface SessionRoute {
  label?: string;
  problem?: string | null;
  managed?: boolean;
  travel_time_minutes?: number | null;
}

interface TeamState {
  [key: string]: unknown;
}

interface TrainerEnvironmentalTruthsProps {
  sessionId: string;
  scenarioId: string;
}

/** Condition keys used by backend (from conditionEvaluatorService + CONDITION_INJECT_DATA_MODEL) */
const CONDITION_KEYS: Array<{ key: string; meaning: string; team?: string }> = [
  {
    key: 'evacuation_no_flow_control_decision',
    meaning: 'No decision matches flow/bottleneck/exit capacity keywords',
    team: 'Evac',
  },
  {
    key: 'evacuation_flow_control_decided',
    meaning: 'evacuation_state.flow_control_decided === true',
    team: 'Evac',
  },
  {
    key: 'evacuation_exit_bottleneck_active',
    meaning: 'exits_congested non-empty (unmanaged)',
    team: 'Evac',
  },
  {
    key: 'evacuation_coordination_established',
    meaning: 'evacuation_state.coordination_with_triage === true',
    team: 'Evac',
  },
  {
    key: 'triage_zone_established_as_incident_location',
    meaning: 'Decision mentions triage zone',
    team: 'Triage',
  },
  {
    key: 'triage_no_supply_management_decision',
    meaning: 'No decision matches supply/equipment keywords',
    team: 'Triage',
  },
  {
    key: 'triage_supply_request_made',
    meaning: 'triage_state.supply_request_made === true',
    team: 'Triage',
  },
  {
    key: 'triage_no_prioritisation_decision',
    meaning: 'No decision matches prioritisation keywords',
    team: 'Triage',
  },
  {
    key: 'triage_prioritisation_decided',
    meaning: 'triage_state.prioritisation_decided === true',
    team: 'Triage',
  },
  { key: 'triage_surge_active', meaning: 'triage_state.surge_active === true', team: 'Triage' },
  {
    key: 'media_statement_issued',
    meaning: 'media_state.first_statement_issued === true',
    team: 'Media',
  },
  {
    key: 'media_no_statement_by_T12',
    meaning: 'elapsedMinutes >= 12 and no statement',
    team: 'Media',
  },
  {
    key: 'media_misinformation_addressed',
    meaning: 'media_state.misinformation_addressed === true',
    team: 'Media',
  },
  {
    key: 'media_spokesperson_designated',
    meaning: 'media_state.spokesperson_designated === true',
    team: 'Media',
  },
  {
    key: 'media_no_spokesperson_designated',
    meaning: 'media_state.spokesperson_designated !== true',
    team: 'Media',
  },
];

/** Keyword patterns used by backend for state/condition updates */
const KEYWORD_PATTERNS: Array<{ category: string; keywords: string[] }> = [
  {
    category: 'Flow control (evac)',
    keywords: [
      'flow',
      'bottleneck',
      'stagger',
      'egress',
      'congestion',
      'exit capacity',
      'exit width',
      'flow rate',
      'people per minute',
      'capacity per exit',
    ],
  },
  {
    category: 'Supply/equipment (triage)',
    keywords: [
      'supply',
      'request',
      'tourniquet',
      'stretcher',
      'triage tag',
      'airway kit',
      'oxygen',
      'iv fluid',
      'trauma kit',
      'gauze',
      'bandage',
    ],
  },
  {
    category: 'Prioritisation (triage)',
    keywords: [
      'prioritise',
      'critical first',
      'severity',
      'triage protocol',
      'red',
      'yellow',
      'green',
    ],
  },
  { category: 'Statement (media)', keywords: ['statement', 'press', 'announce', 'release'] },
  {
    category: 'Misinformation (media)',
    keywords: ['debunk', 'counter', 'correct', 'misinformation', 'rumour', 'narrative'],
  },
  {
    category: 'Spokesperson (media)',
    keywords: ['spokesperson', 'one voice', 'designated spokesperson'],
  },
  {
    category: 'Victim dignity (media)',
    keywords: ['no names', 'family first', 'notify family', 'victim dignity'],
  },
  {
    category: 'Regular updates (media)',
    keywords: ['30 min', '60 min', 'next update', 'regular updates'],
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-robotic-yellow/80 mb-1 font-medium">{title}</div>
      <div className="text-robotic-gray-50">{children}</div>
    </div>
  );
}

function ConditionsBlock({ conditions }: { conditions: Record<string, unknown> | null }) {
  if (!conditions || Object.keys(conditions).length === 0) return null;
  return (
    <div className="ml-2 mt-0.5 text-xs text-robotic-gray-400 font-mono">
      {Object.entries(conditions).map(([k, v]) => (
        <div key={k}>
          {k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
        </div>
      ))}
    </div>
  );
}

export const TrainerEnvironmentalTruths = ({
  sessionId,
  scenarioId,
}: TrainerEnvironmentalTruthsProps) => {
  const [insiderKnowledge, setInsiderKnowledge] = useState<InsiderKnowledge | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [sessionRoutes, setSessionRoutes] = useState<SessionRoute[]>([]);
  const [envAreas, setEnvAreas] = useState<EnvArea[]>([]);
  const [currentState, setCurrentState] = useState<{
    evacuation_state?: TeamState;
    triage_state?: TeamState;
    media_state?: TeamState;
  } | null>(null);
  const [conditionKeys, setConditionKeys] =
    useState<Array<{ key: string; meaning: string; team?: string }>>(CONDITION_KEYS);
  const [keywordPatterns, setKeywordPatterns] =
    useState<Array<{ category: string; keywords: string[] }>>(KEYWORD_PATTERNS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    conditions: false,
    keywords: false,
  });

  useEffect(() => {
    if (!scenarioId || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.scenarios
        .get(scenarioId)
        .then(
          (r) => (r.data as { insider_knowledge?: InsiderKnowledge })?.insider_knowledge ?? null,
        ),
      api.scenarios.getConditionConfig(scenarioId).then((r) => {
        const d = r.data;
        return {
          condition_keys: d?.condition_keys ?? CONDITION_KEYS,
          keyword_patterns: d?.keyword_patterns ?? KEYWORD_PATTERNS,
        };
      }),
      api.sessions.getLocations(sessionId).then((r) => {
        const data = r.data as LocationRow[] | undefined;
        return Array.isArray(data) ? data : [];
      }),
      api.sessions.get(sessionId).then((r) => {
        const data = r.data as {
          current_state?: {
            environmental_state?: { routes?: SessionRoute[]; areas?: EnvArea[] };
            evacuation_state?: TeamState;
            triage_state?: TeamState;
            media_state?: TeamState;
          };
        };
        const cs = data?.current_state;
        const env = cs?.environmental_state;
        return {
          routes: Array.isArray(env?.routes) ? env.routes : [],
          areas: Array.isArray(env?.areas) ? env.areas : [],
          evacuation_state: cs?.evacuation_state ?? null,
          triage_state: cs?.triage_state ?? null,
          media_state: cs?.media_state ?? null,
        };
      }),
    ])
      .then(([ik, conditionConfig, locs, sessionData]) => {
        if (!cancelled) {
          setInsiderKnowledge((ik as InsiderKnowledge) ?? null);
          const cc = conditionConfig as {
            condition_keys: Array<{ key: string; meaning: string; team?: string }>;
            keyword_patterns: Array<{ category: string; keywords: string[] }>;
          };
          if (cc?.condition_keys?.length) setConditionKeys(cc.condition_keys);
          if (cc?.keyword_patterns?.length) setKeywordPatterns(cc.keyword_patterns);
          setLocations(locs ?? []);
          const sd = sessionData as {
            routes: SessionRoute[];
            areas: EnvArea[];
            evacuation_state?: TeamState;
            triage_state?: TeamState;
            media_state?: TeamState;
          };
          setSessionRoutes(sd.routes ?? []);
          setEnvAreas(sd.areas ?? []);
          setCurrentState({
            evacuation_state: sd.evacuation_state ?? undefined,
            triage_state: sd.triage_state ?? undefined,
            media_state: sd.media_state ?? undefined,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, scenarioId]);

  if (loading) {
    return (
      <div className="p-4 text-sm terminal-text text-robotic-yellow/70">
        Loading environmental truths…
      </div>
    );
  }
  if (error) {
    return <div className="p-4 text-sm terminal-text text-robotic-red">Error: {error}</div>;
  }

  const layout = insiderKnowledge?.layout_ground_truth;
  const siteAreas = insiderKnowledge?.site_areas ?? [];
  const osm = insiderKnowledge?.osm_vicinity;
  const sectorStandards = insiderKnowledge?.sector_standards;
  const escalationFactors = insiderKnowledge?.baseline_escalation_factors ?? [];
  const customFacts = insiderKnowledge?.custom_facts ?? [];

  const groupByType = (type: string) => locations.filter((l) => l.location_type === type);
  const exitLocs = groupByType('exit');
  const triageLocs = locations.filter(
    (l) => l.location_type === 'area' || l.location_type === 'triage_site',
  );
  const evacHoldingLocs = groupByType('evacuation_holding');
  const hospitalLocs = groupByType('hospital');
  const blastLocs = groupByType('blast_site');
  const cordonLocs = groupByType('cordon');

  // New-model pin groups (pin_category is stored inside conditions JSON)
  const getPinCategory = (l: LocationRow) =>
    (l.conditions as Record<string, unknown> | null)?.pin_category as string | undefined;
  const candidateSpaceLocs = locations.filter((l) => {
    const cond = l.conditions as Record<string, unknown> | null;
    return getPinCategory(l) === 'candidate_space' || (cond && Array.isArray(cond.potential_uses));
  });
  const poiHospitals = locations.filter((l) => l.location_type === 'hospital');
  const poiPolice = locations.filter((l) => l.location_type === 'police_station');
  const poiFire = locations.filter((l) => l.location_type === 'fire_station');
  const hasNewModel = candidateSpaceLocs.length > 0 || poiPolice.length > 0 || poiFire.length > 0;
  const siteRequirements = insiderKnowledge?.site_requirements;

  const otherLocs = locations.filter(
    (l) =>
      ![
        'exit',
        'area',
        'triage_site',
        'evacuation_holding',
        'hospital',
        'blast_site',
        'cordon',
        'police_station',
        'fire_station',
      ].includes(l.location_type ?? '') && !candidateSpaceLocs.includes(l),
  );

  const hospitalAreas = envAreas.filter((a) => a.type === 'hospital');
  const hasHospitalData = hospitalAreas.length > 0 ? hospitalAreas : (osm?.hospitals ?? []);

  const toggleSection = (key: string) => setExpandedSections((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div className="env-truths-panel terminal-text space-y-4 text-sm overflow-y-auto max-h-[85vh]">
      <h4 className="text-robotic-yellow uppercase text-xs font-semibold border-b border-robotic-yellow/30 pb-1 sticky top-0 bg-robotic-gray-900/95 z-10">
        [ENVIRONMENT GROUND TRUTH]
      </h4>
      <p className="text-robotic-gray-400 text-xs">
        Backend uses these to evaluate decisions, drive injects, and modulate counters.
      </p>

      {/* Layout ground truth */}
      {layout && (
        <Section title="Layout ground truth (insider_knowledge)">
          {layout.evacuee_count != null && <div>Evacuees: {layout.evacuee_count}</div>}
          {layout.exits && layout.exits.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5">
              {layout.exits.map((e, i) => (
                <li key={i}>
                  {e.label ?? e.id} — {e.flow_per_min ?? '?'}/min
                  {e.status ? ` [${e.status}]` : ''}
                </li>
              ))}
            </ul>
          )}
          {layout.zones && layout.zones.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5">
              {layout.zones.map((z, i) => (
                <li key={i}>
                  {z.label ?? z.id}
                  {z.capacity != null ? ` — capacity ${z.capacity}` : ''}
                  {z.type ? ` (${z.type})` : ''}
                </li>
              ))}
            </ul>
          )}
          {layout.blast_site?.description && (
            <div>Blast / cordon: {layout.blast_site.description}</div>
          )}
        </Section>
      )}

      {/* All scenario_locations by type with full conditions */}
      <Section title="Scenario locations (full conditions)">
        {exitLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Exits</div>
            {exitLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? 'Exit'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {triageLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Triage zone candidates</div>
            {triageLocs.map((loc, i) => {
              const sa = siteAreas[i];
              const cap = sa
                ? [
                    sa.capacity_lying != null && `lying ${sa.capacity_lying}`,
                    sa.capacity_standing != null && `standing ${sa.capacity_standing}`,
                  ]
                    .filter(Boolean)
                    .join(', ')
                : null;
              return (
                <div key={loc.id ?? i} className="mb-1">
                  <span className="font-medium">{loc.label ?? `Area ${i + 1}`}</span>
                  {cap && <span className="text-robotic-gray-400"> — {cap}</span>}
                  <ConditionsBlock conditions={loc.conditions ?? null} />
                </div>
              );
            })}
          </div>
        )}
        {evacHoldingLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Evacuation holding</div>
            {evacHoldingLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? 'Unknown'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {hospitalLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Hospitals</div>
            {hospitalLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? 'Hospital'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {blastLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Blast site</div>
            {blastLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? 'Blast'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {cordonLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">Cordon</div>
            {cordonLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? 'Cordon'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {otherLocs.length > 0 && (
          <div className="mb-2">
            <div className="text-robotic-yellow/70 text-xs mb-0.5">
              Other ({otherLocs.map((l) => l.location_type).join(', ')})
            </div>
            {otherLocs.map((loc, i) => (
              <div key={loc.id ?? i} className="mb-1">
                <span className="font-medium">{loc.label ?? loc.location_type ?? 'Unknown'}</span>
                <ConditionsBlock conditions={loc.conditions ?? null} />
              </div>
            ))}
          </div>
        )}
        {locations.length === 0 && <span className="text-robotic-gray-500">None</span>}
      </Section>

      {/* New-model: Candidate Spaces */}
      {hasNewModel && candidateSpaceLocs.length > 0 && (
        <Section title="Candidate spaces (neutral, for player assignment)">
          <p className="text-robotic-gray-400 text-xs mb-1">
            Physical spaces players can assign a purpose to (triage, staging, command post, etc.)
          </p>
          {candidateSpaceLocs.map((loc, i) => {
            const cond = (loc.conditions ?? {}) as Record<string, unknown>;
            const uses = Array.isArray(cond.potential_uses)
              ? (cond.potential_uses as string[])
              : [];
            return (
              <div key={loc.id ?? i} className="mb-2 border-l-2 border-robotic-yellow/20 pl-2">
                <span className="font-medium">{loc.label ?? 'Space'}</span>
                {uses.length > 0 && (
                  <span className="ml-2">
                    {uses.map((u) => (
                      <span
                        key={u}
                        className="inline-block text-xs bg-robotic-yellow/10 text-robotic-yellow/80 px-1.5 py-0.5 rounded mr-1"
                      >
                        {u.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </span>
                )}
                <div className="text-xs text-robotic-gray-400 mt-0.5">
                  {[
                    cond.area_m2 != null && `${cond.area_m2}m²`,
                    cond.capacity_persons != null && `cap ${cond.capacity_persons}`,
                    cond.has_water !== undefined && (cond.has_water ? 'water' : 'no water'),
                    cond.has_electricity !== undefined &&
                      (cond.has_electricity ? 'power' : 'no power'),
                    cond.has_shelter !== undefined && (cond.has_shelter ? 'sheltered' : 'open'),
                    cond.vehicle_access !== undefined &&
                      (cond.vehicle_access ? 'vehicle access' : 'no vehicle access'),
                    cond.distance_from_incident_m != null &&
                      `${cond.distance_from_incident_m}m from incident`,
                    cond.surface && `surface: ${cond.surface}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {cond.notes != null && (
                  <div className="text-xs text-robotic-gray-500 italic">{String(cond.notes)}</div>
                )}
              </div>
            );
          })}
          {siteRequirements && Object.keys(siteRequirements).length > 0 && (
            <div className="mt-3 pt-2 border-t border-robotic-yellow/10">
              <div className="text-robotic-yellow/70 text-xs mb-1">
                Site requirements (from standards)
              </div>
              {Object.entries(siteRequirements).map(([useType, req]) => (
                <div key={useType} className="text-xs text-robotic-gray-400 mb-1">
                  <span className="text-robotic-yellow/60">{useType.replace(/_/g, ' ')}:</span>{' '}
                  {[
                    req.min_area_m2 != null && `min ${req.min_area_m2}m²`,
                    req.min_capacity != null && `min cap ${req.min_capacity}`,
                    req.requires_water && 'water',
                    req.requires_electricity && 'electricity',
                    req.requires_shelter && 'shelter',
                    req.requires_vehicle_access && 'vehicle access',
                    req.max_distance_from_incident_m != null &&
                      `max ${req.max_distance_from_incident_m}m`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* New-model: Nearby Facilities (enriched POIs) */}
      {hasNewModel && (poiHospitals.length > 0 || poiPolice.length > 0 || poiFire.length > 0) && (
        <Section title="Nearby facilities (enriched POI pins)">
          {poiHospitals.length > 0 && (
            <div className="mb-2">
              <div className="text-robotic-yellow/70 text-xs mb-0.5">
                Hospitals ({poiHospitals.length})
              </div>
              {poiHospitals.map((loc, i) => {
                const cond = (loc.conditions ?? {}) as Record<string, unknown>;
                return (
                  <div key={loc.id ?? i} className="mb-1 text-xs">
                    <span className="font-medium">{loc.label}</span>
                    <span className="text-robotic-gray-400">
                      {' — '}
                      {[
                        cond.distance_from_incident_m != null &&
                          `${cond.distance_from_incident_m}m`,
                        cond.trauma_center_level,
                        cond.bed_capacity != null && `${cond.bed_capacity} beds`,
                        cond.emergency_beds_available != null &&
                          `${cond.emergency_beds_available} emergency`,
                        cond.estimated_response_time_min != null &&
                          `~${cond.estimated_response_time_min}min`,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {poiPolice.length > 0 && (
            <div className="mb-2">
              <div className="text-robotic-yellow/70 text-xs mb-0.5">
                Police ({poiPolice.length})
              </div>
              {poiPolice.map((loc, i) => {
                const cond = (loc.conditions ?? {}) as Record<string, unknown>;
                return (
                  <div key={loc.id ?? i} className="mb-1 text-xs">
                    <span className="font-medium">{loc.label}</span>
                    <span className="text-robotic-gray-400">
                      {' — '}
                      {[
                        cond.distance_from_incident_m != null &&
                          `${cond.distance_from_incident_m}m`,
                        cond.facility_type && String(cond.facility_type).replace(/_/g, ' '),
                        cond.available_officers_estimate != null &&
                          `~${cond.available_officers_estimate} officers`,
                        cond.has_tactical_unit && 'tactical',
                        cond.estimated_response_time_min != null &&
                          `~${cond.estimated_response_time_min}min`,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {poiFire.length > 0 && (
            <div className="mb-2">
              <div className="text-robotic-yellow/70 text-xs mb-0.5">
                Fire stations ({poiFire.length})
              </div>
              {poiFire.map((loc, i) => {
                const cond = (loc.conditions ?? {}) as Record<string, unknown>;
                return (
                  <div key={loc.id ?? i} className="mb-1 text-xs">
                    <span className="font-medium">{loc.label}</span>
                    <span className="text-robotic-gray-400">
                      {' — '}
                      {[
                        cond.distance_from_incident_m != null &&
                          `${cond.distance_from_incident_m}m`,
                        cond.appliance_count != null && `${cond.appliance_count} appliances`,
                        cond.has_hazmat_unit && 'hazmat',
                        cond.has_rescue_unit && 'rescue',
                        cond.estimated_response_time_min != null &&
                          `~${cond.estimated_response_time_min}min`,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* Routes */}
      {(sessionRoutes.length > 0 || (osm?.emergency_routes?.length ?? 0) > 0) && (
        <Section title="Routes (environmental_state)">
          <p className="text-robotic-gray-400 text-xs mb-1">
            Used for consistency checks; affects robustness cap and counter pressure.
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {sessionRoutes.length > 0
              ? sessionRoutes.map((r, i) => (
                  <li key={i}>
                    {r.label ?? 'Route'} — {r.problem?.trim() || 'clear'},{' '}
                    {r.managed ? 'managed' : 'unmanaged'}
                    {r.travel_time_minutes != null ? `, ${r.travel_time_minutes} min` : ''}
                  </li>
                ))
              : (osm?.emergency_routes ?? []).map((r, i) => (
                  <li key={i}>
                    {r.description ?? 'Route'}
                    {r.one_way ? ' [one-way]' : ''} — (no session status)
                  </li>
                ))}
          </ul>
        </Section>
      )}

      {/* Hospitals from env areas */}
      {hasHospitalData.length > 0 && (
        <Section title="Hospitals (env areas)">
          <ul className="list-disc pl-4 space-y-0.5">
            {hospitalAreas.length > 0
              ? hospitalAreas.map((h, i) => (
                  <li key={i}>
                    {h.label ?? 'Unknown'}
                    {h.at_capacity ? ' — at full capacity' : ''}
                    {h.capacity != null && !h.at_capacity ? ` — capacity ${h.capacity}` : ''}
                  </li>
                ))
              : (osm?.hospitals ?? []).map((h, i) => (
                  <li key={i}>
                    {h.name ?? 'Unknown'}
                    {h.address ? ` — ${h.address}` : ''}
                  </li>
                ))}
          </ul>
        </Section>
      )}

      {/* Doctrine / Sector standards */}
      {(insiderKnowledge?.sector_standards_structured?.length ||
        insiderKnowledge?.team_doctrines ||
        sectorStandards != null) && (
        <Section title="Doctrine / Sector standards">
          {/* Per-team doctrine mapping */}
          {insiderKnowledge?.team_doctrines &&
            Object.keys(insiderKnowledge.team_doctrines).length > 0 && (
              <div className="mb-4">
                <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                  Doctrine by team
                </div>
                <div className="space-y-2">
                  {Object.entries(insiderKnowledge.team_doctrines).map(([teamName, findings]) => (
                    <div key={teamName} className="border border-robotic-yellow/20 p-2">
                      <span className="text-xs terminal-text text-robotic-yellow font-medium uppercase">
                        {teamName}:
                      </span>{' '}
                      <span className="text-xs terminal-text">
                        {findings.map((f) => f.source).join(', ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* Structured standards */}
          {insiderKnowledge?.sector_standards_structured?.length ? (
            <div className="space-y-3">
              {insiderKnowledge.sector_standards_structured.map((f, i) => (
                <div key={i} className="border border-robotic-yellow/15 p-3">
                  <div className="text-xs terminal-text text-robotic-yellow font-medium">
                    {f.source}
                  </div>
                  <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                    {f.domain}
                  </div>
                  <ul className="space-y-0.5">
                    {f.key_points.map((pt, j) => (
                      <li key={j} className="text-xs terminal-text flex gap-1">
                        <span className="text-robotic-yellow/30 shrink-0">▸</span>
                        {pt}
                      </li>
                    ))}
                  </ul>
                  {f.decision_thresholds && (
                    <div className="text-xs terminal-text text-robotic-yellow/50 mt-1">
                      Thresholds: {f.decision_thresholds}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : typeof sectorStandards === 'string' ? (
            <p className="text-xs whitespace-pre-wrap break-words">{sectorStandards}</p>
          ) : sectorStandards != null ? (
            <pre className="text-xs whitespace-pre-wrap break-words font-mono">
              {JSON.stringify(sectorStandards, null, 2)}
            </pre>
          ) : null}
        </Section>
      )}

      {/* Baseline escalation factors */}
      {escalationFactors.length > 0 && (
        <Section title="Baseline escalation factors">
          <ul className="list-disc pl-4 space-y-1">
            {escalationFactors.map((f, i) => (
              <li key={f.id ?? i}>
                <span className="font-medium">{f.name ?? f.id}</span>
                {f.severity && <span className="text-robotic-yellow/70 ml-1">({f.severity})</span>}
                {f.description && (
                  <div className="text-xs text-robotic-gray-400 mt-0.5">{f.description}</div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Custom facts */}
      {customFacts.length > 0 && (
        <Section title="Custom facts (insider)">
          <ul className="list-disc pl-4 space-y-1">
            {customFacts.map((f, i) => (
              <li key={i}>
                <span className="font-medium">{f.topic ?? 'Fact'}</span>
                {f.summary && (
                  <div className="text-xs text-robotic-gray-400 mt-0.5">{f.summary}</div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Team state (current) */}
      {currentState && (
        <Section title="Team state (current_state)">
          <p className="text-robotic-gray-400 text-xs mb-2">
            Used by condition evaluator and inject scheduler.
          </p>
          {currentState.evacuation_state &&
            Object.keys(currentState.evacuation_state).length > 0 && (
              <div className="mb-2">
                <div className="text-robotic-yellow/70 text-xs mb-0.5">evacuation_state</div>
                <pre className="text-xs font-mono bg-robotic-gray-800/50 p-2 rounded overflow-x-auto">
                  {JSON.stringify(currentState.evacuation_state, null, 2)}
                </pre>
              </div>
            )}
          {currentState.triage_state && Object.keys(currentState.triage_state).length > 0 && (
            <div className="mb-2">
              <div className="text-robotic-yellow/70 text-xs mb-0.5">triage_state</div>
              <pre className="text-xs font-mono bg-robotic-gray-800/50 p-2 rounded overflow-x-auto">
                {JSON.stringify(currentState.triage_state, null, 2)}
              </pre>
            </div>
          )}
          {currentState.media_state && Object.keys(currentState.media_state).length > 0 && (
            <div className="mb-2">
              <div className="text-robotic-yellow/70 text-xs mb-0.5">media_state</div>
              <pre className="text-xs font-mono bg-robotic-gray-800/50 p-2 rounded overflow-x-auto">
                {JSON.stringify(currentState.media_state, null, 2)}
              </pre>
            </div>
          )}
          {(!currentState.evacuation_state ||
            Object.keys(currentState.evacuation_state).length === 0) &&
            (!currentState.triage_state || Object.keys(currentState.triage_state).length === 0) &&
            (!currentState.media_state || Object.keys(currentState.media_state).length === 0) && (
              <span className="text-robotic-gray-500">Empty or not yet initialized</span>
            )}
        </Section>
      )}

      {/* Condition keys reference */}
      <div>
        <button
          type="button"
          onClick={() => toggleSection('conditions')}
          className="text-robotic-yellow/80 mb-1 font-medium hover:underline text-left w-full flex justify-between"
        >
          Condition keys (backend registry)
          <span>{expandedSections.conditions ? '▼' : '▶'}</span>
        </button>
        {expandedSections.conditions && (
          <div className="text-robotic-gray-50 text-xs overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-robotic-yellow/20">
                  <th className="text-left py-1 pr-2">Key</th>
                  <th className="text-left py-1 pr-2">Team</th>
                  <th className="text-left py-1">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {conditionKeys.map((c) => (
                  <tr key={c.key} className="border-b border-robotic-gray-700/50">
                    <td className="py-1 pr-2 font-mono">{c.key}</td>
                    <td className="py-1 pr-2">{c.team ?? '—'}</td>
                    <td className="py-1">{c.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Keyword patterns reference */}
      <div>
        <button
          type="button"
          onClick={() => toggleSection('keywords')}
          className="text-robotic-yellow/80 mb-1 font-medium hover:underline text-left w-full flex justify-between"
        >
          Keyword patterns (state/condition updates)
          <span>{expandedSections.keywords ? '▼' : '▶'}</span>
        </button>
        {expandedSections.keywords && (
          <div className="text-robotic-gray-50 text-xs space-y-2">
            {keywordPatterns.map((p) => (
              <div key={p.category}>
                <div className="text-robotic-yellow/70 font-medium">{p.category}</div>
                <div className="font-mono text-robotic-gray-400 mt-0.5">
                  {p.keywords.join(', ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {locations.length === 0 &&
        !layout &&
        !sectorStandards &&
        !insiderKnowledge?.sector_standards_structured?.length &&
        !insiderKnowledge?.team_doctrines &&
        escalationFactors.length === 0 &&
        customFacts.length === 0 &&
        sessionRoutes.length === 0 &&
        hasHospitalData.length === 0 && (
          <p className="text-robotic-yellow/70">
            No environmental truths configured for this scenario.
          </p>
        )}
    </div>
  );
};
