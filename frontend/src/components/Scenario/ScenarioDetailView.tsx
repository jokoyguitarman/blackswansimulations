import { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup, Polygon } from 'react-leaflet';
import { DivIcon } from 'leaflet';
import { api } from '../../lib/api';
import { ScenarioLocationMarker, type ScenarioLocationPin } from '../COP/ScenarioLocationMarker';
import { FloorSelector, type FloorPlan } from '../COP/FloorSelector';
import { FloorPlanOverlay } from '../COP/FloorPlanOverlay';

interface StandardsFinding {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
}

interface ScenarioFull {
  id: string;
  title: string;
  description: string;
  briefing?: string;
  category: string;
  difficulty: string;
  duration_minutes: number;
  objectives: string[];
  is_active: boolean;
  created_at: string;
  role_specific_briefs?: Record<string, string>;
  insider_knowledge?: {
    sector_standards?: string;
    sector_standards_structured?: StandardsFinding[];
    team_doctrines?: Record<string, StandardsFinding[]>;
    layout_ground_truth?: Record<string, unknown>;
    site_areas?: Array<Record<string, unknown>>;
    site_requirements?: Record<
      string,
      {
        min_area_m2?: number;
        requires_water?: boolean;
        requires_shelter?: boolean;
        requires_vehicle_access?: boolean;
        requires_electricity?: boolean;
        min_capacity?: number;
        max_distance_from_incident_m?: number;
        notes?: string;
      }
    >;
    custom_facts?: Array<{ topic: string; summary: string; detail?: string }>;
    baseline_escalation_factors?: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }>;
    osm_vicinity?: {
      hospitals?: Array<{ name: string }>;
      police?: Array<{ name: string }>;
      fire_stations?: Array<{ name: string }>;
    };
  };
}

interface Inject {
  id: string;
  trigger_time_minutes: number | null;
  trigger_condition: string | null;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[] | null;
  conditions_to_appear: unknown;
  conditions_to_cancel: string[] | null;
  eligible_after_minutes: number | null;
  objective_penalty: unknown;
  state_effect: unknown;
}

interface Team {
  id: string;
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

interface LocationPin {
  id: string;
  location_type: string;
  label: string;
  coordinates: { lat?: number; lng?: number };
  conditions?: Record<string, unknown>;
  display_order: number;
}

interface HazardPin {
  id: string;
  hazard_type: string;
  location_lat: number;
  location_lng: number;
  floor_level: string;
  properties: Record<string, unknown>;
  status: string;
  enriched_description?: string;
  fire_class?: string;
  debris_type?: string;
  resolution_requirements?: Record<string, unknown>;
  personnel_requirements?: Record<string, unknown>;
  equipment_requirements?: unknown[];
  deterioration_timeline?: Record<string, unknown>;
  appears_at_minutes: number;
  zones?: Array<{
    zone_type: string;
    radius_m: number;
    polygon?: number[][];
    ppe_required?: string[];
    allowed_teams?: string[];
  }>;
}

interface CasualtyPin {
  id: string;
  casualty_type: string;
  location_lat: number;
  location_lng: number;
  floor_level: string;
  headcount: number;
  conditions: Record<string, unknown>;
  status: string;
  appears_at_minutes: number;
}

interface EquipmentItem {
  id: string;
  equipment_type: string;
  label: string;
  icon?: string;
  properties: Record<string, unknown>;
}

interface Props {
  scenarioId: string;
  onClose: () => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-red-400 border-red-400',
  high: 'text-orange-400 border-orange-400',
  medium: 'text-robotic-yellow border-robotic-yellow',
  low: 'text-green-400 border-green-400',
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mb-6">
    <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase tracking-widest mb-3 border-b border-robotic-yellow/20 pb-1">
      {title}
    </h3>
    {children}
  </div>
);

const tabs = [
  'Overview',
  'Teams',
  'Injects',
  'Map Pins',
  'Env Truths',
  'Routes',
  'Standards',
] as const;
type Tab = (typeof tabs)[number];

export const ScenarioDetailView = ({ scenarioId, onClose }: Props) => {
  const [scenario, setScenario] = useState<ScenarioFull | null>(null);
  const [injects, setInjects] = useState<Inject[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [locations, setLocations] = useState<LocationPin[]>([]);
  const [hazardPins, setHazardPins] = useState<HazardPin[]>([]);
  const [casualtyPins, setCasualtyPins] = useState<CasualtyPin[]>([]);
  const [equipmentItems, setEquipmentItems] = useState<EquipmentItem[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [expandedInject, setExpandedInject] = useState<string | null>(null);
  const [editingStandard, setEditingStandard] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<StandardsFinding | null>(null);
  const [addingStandard, setAddingStandard] = useState(false);
  const [newStandard, setNewStandard] = useState<StandardsFinding>({
    domain: '',
    source: '',
    key_points: [''],
  });
  const [savingDoctrine, setSavingDoctrine] = useState(false);

  const saveDoctrine = useCallback(
    async (updated: StandardsFinding[]) => {
      if (!scenario) return;
      setSavingDoctrine(true);
      try {
        const textBlock = updated
          .map(
            (f) =>
              `[${f.source}] ${f.domain}:\n` +
              f.key_points.map((p) => `  - ${p}`).join('\n') +
              (f.decision_thresholds ? `\n  Thresholds: ${f.decision_thresholds}` : ''),
          )
          .join('\n\n');

        const ik = scenario.insider_knowledge ?? {};
        const updatedIk = {
          ...ik,
          sector_standards_structured: updated,
          sector_standards: textBlock || undefined,
        };

        await api.scenarios.update(scenarioId, { insider_knowledge: updatedIk });
        setScenario({ ...scenario, insider_knowledge: updatedIk });
      } catch (err) {
        console.error('Failed to save doctrine', err);
      } finally {
        setSavingDoctrine(false);
      }
    },
    [scenario, scenarioId],
  );

  useEffect(() => {
    const load = async () => {
      try {
        const [scenRes, injectRes, teamRes, locRes, hazRes, casRes, eqRes, fpRes] =
          await Promise.all([
            api.scenarios.get(scenarioId),
            api.scenarios.getInjects(scenarioId),
            api.scenarios.getTeams(scenarioId),
            api.scenarios.getScenarioLocations(scenarioId),
            api.scenarios.getScenarioHazards(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioCasualties(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioEquipment(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioFloorPlans(scenarioId).catch(() => ({ data: [] })),
          ]);
        setScenario(scenRes.data as ScenarioFull);
        setInjects((injectRes.data ?? []) as Inject[]);
        setTeams((teamRes.data ?? []) as Team[]);
        setLocations((locRes.data ?? []) as LocationPin[]);
        setHazardPins((hazRes.data ?? []) as HazardPin[]);
        setCasualtyPins((casRes.data ?? []) as CasualtyPin[]);
        setEquipmentItems((eqRes.data ?? []) as EquipmentItem[]);
        setFloorPlans((fpRes.data ?? []) as FloorPlan[]);
      } catch (err) {
        console.error('Failed to load scenario detail', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [scenarioId]);

  const timeInjects = injects.filter((i) => i.trigger_time_minutes != null && !i.trigger_condition);
  const decisionInjects = injects.filter((i) => !!i.trigger_condition);
  const conditionInjects = injects.filter(
    (i) => i.trigger_time_minutes == null && !i.trigger_condition,
  );

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
        <div className="text-lg terminal-text animate-pulse">[LOADING SCENARIO DATA...]</div>
      </div>
    );
  }

  if (!scenario) {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
        <div className="military-border p-8 text-center">
          <p className="terminal-text text-red-400">[ERROR] Failed to load scenario</p>
          <button onClick={onClose} className="mt-4 military-button px-4 py-2 text-sm">
            [CLOSE]
          </button>
        </div>
      </div>
    );
  }

  const ik = scenario.insider_knowledge;
  const structuredStandards = Array.isArray(ik?.sector_standards_structured)
    ? ik.sector_standards_structured
    : null;
  const flatStandards = typeof ik?.sector_standards === 'string' ? ik.sector_standards : null;

  return (
    <div className="fixed inset-0 bg-black/85 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="military-border bg-robotic-gray-300 w-full max-w-5xl my-4">
        {/* Header */}
        <div className="border-b border-robotic-yellow/30 p-6 flex justify-between items-start">
          <div className="flex-1 pr-4">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl terminal-text uppercase">{scenario.title}</h1>
              <span
                className={`text-xs terminal-text px-2 py-0.5 border ${
                  scenario.is_active
                    ? 'border-robotic-yellow text-robotic-yellow'
                    : 'border-robotic-gray-200 text-robotic-gray-50'
                }`}
              >
                {scenario.is_active ? 'ACTIVE' : 'DRAFT'}
              </span>
            </div>
            <div className="flex gap-4 text-xs terminal-text text-robotic-yellow/50">
              <span>[{scenario.category.toUpperCase()}]</span>
              <span>[{scenario.difficulty.toUpperCase()}]</span>
              <span>[{scenario.duration_minutes}MIN]</span>
              <span>[{teams.length} TEAMS]</span>
              <span>[{injects.length} INJECTS]</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-robotic-orange hover:text-robotic-yellow terminal-text text-sm"
          >
            [CLOSE]
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-robotic-yellow/20 flex overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-xs terminal-text uppercase whitespace-nowrap transition-all ${
                activeTab === tab
                  ? 'border-b-2 border-robotic-yellow text-robotic-yellow'
                  : 'text-robotic-yellow/50 hover:text-robotic-yellow/80'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="p-6">
          {/* ─── OVERVIEW ─── */}
          {activeTab === 'Overview' && (
            <div>
              <Section title="Description">
                <p className="text-sm terminal-text leading-relaxed">{scenario.description}</p>
              </Section>

              {scenario.briefing && (
                <Section title="Operational Briefing">
                  <p className="text-sm terminal-text leading-relaxed whitespace-pre-wrap">
                    {scenario.briefing}
                  </p>
                </Section>
              )}

              <Section title="Objectives">
                <ul className="space-y-1">
                  {scenario.objectives.map((obj, i) => (
                    <li key={i} className="text-sm terminal-text flex gap-2">
                      <span className="text-robotic-yellow/40">{i + 1}.</span>
                      {obj}
                    </li>
                  ))}
                </ul>
              </Section>

              {scenario.role_specific_briefs &&
                Object.keys(scenario.role_specific_briefs).length > 0 && (
                  <Section title="Role-specific briefs">
                    <div className="space-y-3">
                      {Object.entries(scenario.role_specific_briefs).map(([role, brief]) => (
                        <div key={role}>
                          <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-1">
                            {role}
                          </div>
                          <p className="text-sm terminal-text">{brief}</p>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

              {ik?.custom_facts && ik.custom_facts.length > 0 && (
                <Section title="Intelligence / Custom Facts">
                  <div className="space-y-3">
                    {ik.custom_facts.map((fact, i) => (
                      <div key={i} className="military-border p-3">
                        <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
                          {fact.topic}
                        </div>
                        <p className="text-sm terminal-text">{fact.summary}</p>
                        {fact.detail && (
                          <p className="text-xs terminal-text text-robotic-yellow/60 mt-1">
                            {fact.detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {ik?.baseline_escalation_factors && ik.baseline_escalation_factors.length > 0 && (
                <Section title="Baseline Escalation Factors">
                  <div className="space-y-2">
                    {ik.baseline_escalation_factors.map((f, i) => (
                      <div key={i} className="flex gap-3 items-start">
                        <span
                          className={`text-xs terminal-text px-1.5 py-0.5 border shrink-0 ${SEVERITY_COLORS[f.severity] ?? 'text-robotic-yellow border-robotic-yellow'}`}
                        >
                          {f.severity.toUpperCase()}
                        </span>
                        <div>
                          <div className="text-xs terminal-text text-robotic-yellow font-medium">
                            {f.name}
                          </div>
                          <p className="text-xs terminal-text text-robotic-yellow/70">
                            {f.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          )}

          {/* ─── TEAMS ─── */}
          {activeTab === 'Teams' && (
            <div>
              {teams.length === 0 ? (
                <p className="text-sm terminal-text text-robotic-yellow/50">[NO TEAMS DEFINED]</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {teams.map((team) => (
                    <div key={team.id} className="military-border p-4">
                      <div className="text-sm terminal-text text-robotic-yellow font-medium uppercase mb-1">
                        {team.team_name}
                      </div>
                      <p className="text-xs terminal-text text-robotic-yellow/70 mb-2">
                        {team.team_description}
                      </p>
                      <div className="text-xs terminal-text text-robotic-yellow/50">
                        {team.min_participants}–{team.max_participants} participants
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── INJECTS ─── */}
          {activeTab === 'Injects' && (
            <div className="space-y-6">
              {/* Time-based */}
              <div>
                <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-3">
                  Time-based injects ({timeInjects.length})
                </div>
                <div className="space-y-2">
                  {timeInjects
                    .sort((a, b) => (a.trigger_time_minutes ?? 0) - (b.trigger_time_minutes ?? 0))
                    .map((inj) => (
                      <InjectRow
                        key={inj.id}
                        inject={inj}
                        expanded={expandedInject === inj.id}
                        onToggle={() =>
                          setExpandedInject(expandedInject === inj.id ? null : inj.id)
                        }
                      />
                    ))}
                </div>
              </div>

              {/* Decision-triggered */}
              {decisionInjects.length > 0 && (
                <div>
                  <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-3">
                    Decision-triggered injects ({decisionInjects.length})
                  </div>
                  <div className="space-y-2">
                    {decisionInjects.map((inj) => (
                      <InjectRow
                        key={inj.id}
                        inject={inj}
                        expanded={expandedInject === inj.id}
                        onToggle={() =>
                          setExpandedInject(expandedInject === inj.id ? null : inj.id)
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Condition-driven */}
              {conditionInjects.length > 0 && (
                <div>
                  <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-3">
                    Condition-driven injects ({conditionInjects.length})
                  </div>
                  <div className="space-y-2">
                    {conditionInjects.map((inj) => (
                      <InjectRow
                        key={inj.id}
                        inject={inj}
                        expanded={expandedInject === inj.id}
                        onToggle={() =>
                          setExpandedInject(expandedInject === inj.id ? null : inj.id)
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── MAP PINS ─── */}
          {activeTab === 'Map Pins' && (
            <MapPinsTab
              scenarioId={scenarioId}
              locations={locations}
              hazards={hazardPins}
              casualties={casualtyPins}
              equipment={equipmentItems}
              floorPlans={floorPlans}
            />
          )}

          {/* ─── ENV TRUTHS ─── */}
          {activeTab === 'Env Truths' && (
            <EnvTruthsTab locations={locations} siteRequirements={ik?.site_requirements} />
          )}

          {/* ─── ROUTES ─── */}
          {activeTab === 'Routes' && (
            <div>
              {(() => {
                const routePins = locations.filter((l) => l.location_type === 'route');
                if (routePins.length === 0) {
                  return (
                    <p className="text-sm terminal-text text-robotic-yellow/50">[NO ROUTE DATA]</p>
                  );
                }
                return (
                  <div className="space-y-2">
                    <p className="text-xs terminal-text text-robotic-yellow/60 mb-3">
                      Enriched route conditions — used by transport outcome service and
                      environmental condition management.
                    </p>
                    {routePins.map((r, i) => {
                      const c = (r.conditions ?? {}) as Record<string, unknown>;
                      return (
                        <div key={r.id ?? i} className="military-border p-3">
                          <div className="text-sm terminal-text text-robotic-yellow font-medium">
                            {r.label}
                          </div>
                          <div className="text-xs terminal-text mt-1 space-y-0.5">
                            <div>
                              {c.problem ? (
                                <span className="text-orange-400">{String(c.problem)}</span>
                              ) : (
                                <span className="text-green-400">Clear</span>
                              )}
                              {' — '}
                              {c.managed ? 'managed' : 'unmanaged'}
                            </div>
                            <div>
                              {c.highway_type && `${String(c.highway_type)} `}
                              {c.one_way ? '[one-way] ' : ''}
                              {c.distance_m != null && `${c.distance_m}m `}
                              {c.travel_time_minutes != null && `~${c.travel_time_minutes} min`}
                            </div>
                            {Array.isArray(c.connects_to) &&
                              (c.connects_to as string[]).length > 0 && (
                                <div className="text-robotic-yellow/50">
                                  Connects to: {(c.connects_to as string[]).join(', ')}
                                </div>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ─── STANDARDS / DOCTRINE ─── */}
          {activeTab === 'Standards' && (
            <div>
              {/* Team doctrine mapping */}
              {ik?.team_doctrines && Object.keys(ik.team_doctrines).length > 0 && (
                <Section title="Doctrine by team">
                  <div className="space-y-3 mb-6">
                    {Object.entries(ik.team_doctrines).map(([teamName, findings]) => (
                      <div key={teamName} className="military-border p-3">
                        <div className="text-sm terminal-text text-robotic-yellow font-medium uppercase mb-2">
                          {teamName}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(findings as StandardsFinding[]).map((f, i) => (
                            <span
                              key={i}
                              className="text-xs terminal-text bg-robotic-yellow/10 border border-robotic-yellow/20 px-2 py-1"
                            >
                              {f.source}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Editable standards list */}
              {structuredStandards && structuredStandards.length > 0 ? (
                <div className="space-y-4">
                  {structuredStandards.map((finding, i) => {
                    const isEditing = editingStandard === i;
                    const keyPoints = Array.isArray(finding.key_points)
                      ? finding.key_points
                      : finding.key_points && typeof finding.key_points === 'object'
                        ? Object.entries(finding.key_points).map(
                            ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
                          )
                        : [];
                    const source =
                      typeof finding.source === 'string'
                        ? finding.source
                        : JSON.stringify(finding.source ?? '');
                    const domain =
                      typeof finding.domain === 'string'
                        ? finding.domain
                        : JSON.stringify(finding.domain ?? '');

                    if (isEditing && editDraft) {
                      return (
                        <div key={i} className="military-border p-4 border-robotic-yellow/60">
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                                  Source
                                </label>
                                <input
                                  className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                                  value={editDraft.source}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, source: e.target.value })
                                  }
                                />
                              </div>
                              <div>
                                <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                                  Domain
                                </label>
                                <input
                                  className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                                  value={editDraft.domain}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, domain: e.target.value })
                                  }
                                />
                              </div>
                            </div>
                            <div>
                              <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                                Key Points
                              </label>
                              {editDraft.key_points.map((pt, j) => (
                                <div key={j} className="flex gap-2 mb-1">
                                  <input
                                    className="flex-1 bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                                    value={pt}
                                    onChange={(e) => {
                                      const pts = [...editDraft.key_points];
                                      pts[j] = e.target.value;
                                      setEditDraft({ ...editDraft, key_points: pts });
                                    }}
                                  />
                                  <button
                                    className="text-red-400 text-xs px-2"
                                    onClick={() => {
                                      const pts = editDraft.key_points.filter((_, k) => k !== j);
                                      setEditDraft({
                                        ...editDraft,
                                        key_points: pts.length > 0 ? pts : [''],
                                      });
                                    }}
                                  >
                                    X
                                  </button>
                                </div>
                              ))}
                              <button
                                className="text-xs terminal-text text-robotic-yellow/60 mt-1"
                                onClick={() =>
                                  setEditDraft({
                                    ...editDraft,
                                    key_points: [...editDraft.key_points, ''],
                                  })
                                }
                              >
                                + Add point
                              </button>
                            </div>
                            <div>
                              <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                                Decision Thresholds
                              </label>
                              <textarea
                                className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2 h-16"
                                value={editDraft.decision_thresholds ?? ''}
                                onChange={(e) =>
                                  setEditDraft({
                                    ...editDraft,
                                    decision_thresholds: e.target.value || undefined,
                                  })
                                }
                              />
                            </div>
                            <div className="flex gap-2">
                              <button
                                className="military-button px-3 py-1 text-xs"
                                disabled={savingDoctrine}
                                onClick={() => {
                                  const updated = [...structuredStandards];
                                  updated[i] = {
                                    ...editDraft,
                                    key_points: editDraft.key_points.filter((p) => p.trim()),
                                  };
                                  setEditingStandard(null);
                                  setEditDraft(null);
                                  saveDoctrine(updated);
                                }}
                              >
                                [SAVE]
                              </button>
                              <button
                                className="text-xs terminal-text text-robotic-yellow/50 px-3 py-1"
                                onClick={() => {
                                  setEditingStandard(null);
                                  setEditDraft(null);
                                }}
                              >
                                [CANCEL]
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={i} className="military-border p-4">
                        <div className="flex gap-3 items-start mb-3 justify-between">
                          <div>
                            <div className="text-sm terminal-text text-robotic-yellow font-medium">
                              {source}
                            </div>
                            <div className="text-xs terminal-text text-robotic-yellow/60 uppercase">
                              {domain}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              className="text-xs terminal-text text-robotic-yellow/50 hover:text-robotic-yellow"
                              onClick={() => {
                                setEditingStandard(i);
                                setEditDraft({ ...finding, key_points: [...keyPoints] });
                              }}
                            >
                              [EDIT]
                            </button>
                            <button
                              className="text-xs terminal-text text-red-400/60 hover:text-red-400"
                              disabled={savingDoctrine}
                              onClick={() => {
                                const updated = structuredStandards.filter((_, k) => k !== i);
                                saveDoctrine(updated);
                              }}
                            >
                              [REMOVE]
                            </button>
                          </div>
                        </div>
                        <ul className="space-y-1 mb-2">
                          {keyPoints.map((pt, j) => (
                            <li key={j} className="text-xs terminal-text flex gap-2">
                              <span className="text-robotic-yellow/40 shrink-0">▸</span>
                              {typeof pt === 'string' ? pt : JSON.stringify(pt)}
                            </li>
                          ))}
                        </ul>
                        {finding.decision_thresholds && (
                          <div className="mt-2 border-t border-robotic-yellow/20 pt-2">
                            <span className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                              Decision thresholds:{' '}
                            </span>
                            <span className="text-xs terminal-text">
                              {typeof finding.decision_thresholds === 'string'
                                ? finding.decision_thresholds
                                : JSON.stringify(finding.decision_thresholds, null, 2)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : flatStandards ? (
                <Section title="Sector standards">
                  <p className="text-xs terminal-text whitespace-pre-wrap break-words">
                    {flatStandards}
                  </p>
                </Section>
              ) : ik?.sector_standards != null && typeof ik.sector_standards !== 'string' ? (
                <Section title="Sector standards">
                  <pre className="text-xs terminal-text whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(ik.sector_standards, null, 2)}
                  </pre>
                </Section>
              ) : (
                <p className="text-sm terminal-text text-robotic-yellow/50">
                  [NO STANDARDS DATA] — Standards are researched during scenario generation.
                </p>
              )}

              {/* Add new standard */}
              {addingStandard ? (
                <div className="military-border p-4 mt-4 border-robotic-yellow/60">
                  <div className="text-sm terminal-text text-robotic-yellow mb-3 uppercase">
                    Add Doctrine / Standard
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                          Source
                        </label>
                        <input
                          className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                          placeholder="e.g. AIIMS, START Triage Protocol"
                          value={newStandard.source}
                          onChange={(e) =>
                            setNewStandard({ ...newStandard, source: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                          Domain
                        </label>
                        <input
                          className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                          placeholder="e.g. Incident Command, Medical Triage"
                          value={newStandard.domain}
                          onChange={(e) =>
                            setNewStandard({ ...newStandard, domain: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                        Key Points
                      </label>
                      {newStandard.key_points.map((pt, j) => (
                        <div key={j} className="flex gap-2 mb-1">
                          <input
                            className="flex-1 bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2"
                            placeholder="Protocol point or procedure"
                            value={pt}
                            onChange={(e) => {
                              const pts = [...newStandard.key_points];
                              pts[j] = e.target.value;
                              setNewStandard({ ...newStandard, key_points: pts });
                            }}
                          />
                          {newStandard.key_points.length > 1 && (
                            <button
                              className="text-red-400 text-xs px-2"
                              onClick={() =>
                                setNewStandard({
                                  ...newStandard,
                                  key_points: newStandard.key_points.filter((_, k) => k !== j),
                                })
                              }
                            >
                              X
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        className="text-xs terminal-text text-robotic-yellow/60 mt-1"
                        onClick={() =>
                          setNewStandard({
                            ...newStandard,
                            key_points: [...newStandard.key_points, ''],
                          })
                        }
                      >
                        + Add point
                      </button>
                    </div>
                    <div>
                      <label className="text-xs terminal-text text-robotic-yellow/50 uppercase block mb-1">
                        Decision Thresholds (optional)
                      </label>
                      <textarea
                        className="w-full bg-black/40 border border-robotic-yellow/30 text-xs terminal-text p-2 h-16"
                        placeholder="e.g. Category 1: immediate treatment, Category 2: within 10 minutes"
                        value={newStandard.decision_thresholds ?? ''}
                        onChange={(e) =>
                          setNewStandard({
                            ...newStandard,
                            decision_thresholds: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="military-button px-3 py-1 text-xs"
                        disabled={
                          savingDoctrine || !newStandard.source.trim() || !newStandard.domain.trim()
                        }
                        onClick={() => {
                          const cleaned = {
                            ...newStandard,
                            key_points: newStandard.key_points.filter((p) => p.trim()),
                          };
                          if (cleaned.key_points.length === 0)
                            cleaned.key_points = [newStandard.key_points[0] || ''];
                          const updated = [...(structuredStandards ?? []), cleaned];
                          saveDoctrine(updated);
                          setAddingStandard(false);
                          setNewStandard({ domain: '', source: '', key_points: [''] });
                        }}
                      >
                        [ADD STANDARD]
                      </button>
                      <button
                        className="text-xs terminal-text text-robotic-yellow/50 px-3 py-1"
                        onClick={() => {
                          setAddingStandard(false);
                          setNewStandard({ domain: '', source: '', key_points: [''] });
                        }}
                      >
                        [CANCEL]
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  className="military-button px-4 py-2 text-xs mt-4"
                  onClick={() => setAddingStandard(true)}
                >
                  [+ ADD DOCTRINE / STANDARD]
                </button>
              )}

              {savingDoctrine && (
                <div className="text-xs terminal-text text-robotic-yellow/60 mt-2 animate-pulse">
                  [SAVING...]
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────────────

const PIN_LEGEND: Array<{ color: string; label: string }> = [
  { color: '#b91c1c', label: 'Incident site' },
  { color: '#7c3aed', label: 'Cordon' },
  { color: '#d97706', label: 'Triage' },
  { color: '#059669', label: 'Access / route' },
  { color: '#0284c7', label: 'Command' },
  { color: '#0891b2', label: 'Staging' },
  { color: '#4338ca', label: 'POI' },
  { color: '#4b5563', label: 'Other' },
  { color: '#ef4444', label: 'Hazard' },
  { color: '#f59e0b', label: 'Casualty' },
  { color: '#8b5cf6', label: 'Crowd' },
  { color: '#06b6d4', label: 'Entry/Exit' },
];

const HAZARD_ICONS: Record<string, string> = {
  fire: '🔥',
  structural_collapse: '🏚️',
  gas_leak: '💨',
  chemical: '☣️',
  smoke: '🌫️',
  debris: '🧱',
  electrical: '⚡',
  flooding: '🌊',
};

const TRIAGE_COLORS: Record<string, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  black: '#1f2937',
};

const createDivIcon = (color: string, label: string, size = 28): DivIcon =>
  new DivIcon({
    className: 'custom-pin-icon',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:${Math.floor(size * 0.5)}px;line-height:1;cursor:grab"><span style="filter:drop-shadow(0 0 1px rgba(0,0,0,.5))">${label}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

function generateCirclePolygon(
  centerLat: number,
  centerLng: number,
  radiusM: number,
  segments = 32,
): number[][] {
  const ring: number[][] = [];
  const R = 6371000;
  const latRad = (centerLat * Math.PI) / 180;
  const lngRad = (centerLng * Math.PI) / 180;
  const angDist = radiusM / R;
  for (let i = 0; i < segments; i++) {
    const bearing = (2 * Math.PI * i) / segments;
    const destLat = Math.asin(
      Math.sin(latRad) * Math.cos(angDist) +
        Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearing),
    );
    const destLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angDist) * Math.cos(latRad),
        Math.cos(angDist) - Math.sin(latRad) * Math.sin(destLat),
      );
    ring.push([(destLat * 180) / Math.PI, (destLng * 180) / Math.PI]);
  }
  ring.push(ring[0]);
  return ring;
}

const MapPinsTab = ({
  scenarioId,
  locations: locationsProp,
  hazards: hazardsProp,
  casualties: casualtiesProp,
  equipment,
  floorPlans,
}: {
  scenarioId: string;
  locations: LocationPin[];
  hazards: HazardPin[];
  casualties: CasualtyPin[];
  equipment: EquipmentItem[];
  floorPlans: FloorPlan[];
}) => {
  const [locations, setLocations] = useState(locationsProp);
  const [hazards, setHazards] = useState(hazardsProp);
  const [casualties, setCasualties] = useState(casualtiesProp);

  useEffect(() => setLocations(locationsProp), [locationsProp]);
  useEffect(() => setHazards(hazardsProp), [hazardsProp]);
  useEffect(() => setCasualties(casualtiesProp), [casualtiesProp]);

  const [expandedPin, setExpandedPin] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState('G');
  const changesRef = useRef<{
    locations: Map<string, { lat: number; lng: number }>;
    hazards: Map<string, { lat: number; lng: number }>;
    casualties: Map<string, { lat: number; lng: number }>;
    zones: Map<string, { hazard_id: string; zone_type: string; radius_m: number }>;
  }>({ locations: new Map(), hazards: new Map(), casualties: new Map(), zones: new Map() });

  const hasChanges = () => {
    const c = changesRef.current;
    return c.locations.size > 0 || c.hazards.size > 0 || c.casualties.size > 0 || c.zones.size > 0;
  };

  const [dirty, setDirty] = useState(false);

  const onLocationDrag = useCallback((id: string, lat: number, lng: number) => {
    changesRef.current.locations.set(id, { lat, lng });
    setDirty(true);
  }, []);

  const onHazardDrag = useCallback((id: string, lat: number, lng: number) => {
    changesRef.current.hazards.set(id, { lat, lng });
    setDirty(true);
  }, []);

  const onCasualtyDrag = useCallback((id: string, lat: number, lng: number) => {
    changesRef.current.casualties.set(id, { lat, lng });
    setDirty(true);
  }, []);

  const onZoneRadiusChange = useCallback(
    (hazardId: string, zoneType: string, newRadius: number) => {
      const key = `${hazardId}:${zoneType}`;
      changesRef.current.zones.set(key, {
        hazard_id: hazardId,
        zone_type: zoneType,
        radius_m: newRadius,
      });
      // Update local state to re-render the polygon at the new radius
      setHazards((prev) =>
        prev.map((h) => {
          if (h.id !== hazardId) return h;
          const updatedZones = (h.zones ?? []).map((z) => {
            if (z.zone_type !== zoneType) return z;
            const newPolygon = generateCirclePolygon(h.location_lat, h.location_lng, newRadius);
            return { ...z, radius_m: newRadius, polygon: newPolygon };
          });
          return { ...h, zones: updatedZones };
        }),
      );
      setDirty(true);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges()) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const c = changesRef.current;
      const payload: {
        locations?: Array<{ id: string; lat: number; lng: number }>;
        hazards?: Array<{ id: string; lat: number; lng: number }>;
        casualties?: Array<{ id: string; lat: number; lng: number }>;
        zones?: Array<{ hazard_id: string; zone_type: string; radius_m: number }>;
      } = {};
      if (c.locations.size)
        payload.locations = [...c.locations.entries()].map(([id, p]) => ({ id, ...p }));
      if (c.hazards.size)
        payload.hazards = [...c.hazards.entries()].map(([id, p]) => ({ id, ...p }));
      if (c.casualties.size)
        payload.casualties = [...c.casualties.entries()].map(([id, p]) => ({ id, ...p }));
      if (c.zones.size) payload.zones = [...c.zones.values()];

      const res = await api.scenarios.updatePinPositions(scenarioId, payload);
      if (res.warnings?.length) {
        setSaveMsg(`Saved with ${res.warnings.length} warning(s)`);
      } else {
        setSaveMsg('All pin positions saved');
      }

      // Update local state so pins stay at their new positions after save
      if (c.locations.size) {
        setLocations((prev) =>
          prev.map((loc) => {
            const moved = c.locations.get(loc.id);
            return moved ? { ...loc, coordinates: { lat: moved.lat, lng: moved.lng } } : loc;
          }),
        );
      }
      if (c.hazards.size) {
        setHazards((prev) =>
          prev.map((h) => {
            const moved = c.hazards.get(h.id);
            return moved ? { ...h, location_lat: moved.lat, location_lng: moved.lng } : h;
          }),
        );
      }
      if (c.casualties.size) {
        setCasualties((prev) =>
          prev.map((cas) => {
            const moved = c.casualties.get(cas.id);
            return moved ? { ...cas, location_lat: moved.lat, location_lng: moved.lng } : cas;
          }),
        );
      }

      changesRef.current = {
        locations: new Map(),
        hazards: new Map(),
        casualties: new Map(),
        zones: new Map(),
      };
      setDirty(false);
    } catch {
      setSaveMsg('Failed to save — check console');
    } finally {
      setSaving(false);
    }
  }, [scenarioId]);

  const totalPins = locations.length + hazards.length + casualties.length;
  if (totalPins === 0 && equipment.length === 0) {
    return <p className="text-sm terminal-text text-robotic-yellow/50">[NO MAP DATA]</p>;
  }

  const validPins: ScenarioLocationPin[] = locations
    .filter((loc) => loc.coordinates.lat != null && loc.coordinates.lng != null)
    .map((loc) => ({
      id: loc.id,
      location_type: loc.location_type,
      label: loc.label,
      coordinates: loc.coordinates,
      conditions: loc.conditions,
      pin_category: loc.conditions?.pin_category as string | undefined,
      narrative_description: loc.conditions?.narrative_description as string | undefined,
    }));

  const patients = casualties.filter((c) => c.casualty_type === 'patient');
  const crowds = casualties.filter((c) => c.casualty_type === 'crowd');

  const allCoords: [number, number][] = [
    ...validPins
      .filter((p) => p.coordinates.lat != null)
      .map((p) => [p.coordinates.lat!, p.coordinates.lng!] as [number, number]),
    ...hazards.map((h) => [h.location_lat, h.location_lng] as [number, number]),
    ...casualties.map((c) => [c.location_lat, c.location_lng] as [number, number]),
  ];
  const mapCenter: [number, number] = allCoords.length > 0 ? allCoords[0] : [1.2931, 103.8558];

  return (
    <div className="space-y-4">
      {/* Summary counts + save bar */}
      <div className="flex flex-wrap items-center gap-3 text-xs terminal-text">
        {locations.length > 0 && (
          <span className="text-robotic-yellow/70">{locations.length} locations</span>
        )}
        {hazards.length > 0 && <span className="text-red-400">{hazards.length} hazards</span>}
        {patients.length > 0 && (
          <span className="text-amber-400">{patients.length} casualties</span>
        )}
        {crowds.length > 0 && (
          <span className="text-violet-400">
            {crowds.length} crowds ({crowds.reduce((s, c) => s + c.headcount, 0)} people)
          </span>
        )}
        {equipment.length > 0 && (
          <span className="text-cyan-400">{equipment.length} equipment types</span>
        )}
        {floorPlans.length > 1 && <span className="text-blue-400">{floorPlans.length} floors</span>}
        <span className="ml-auto text-robotic-yellow/40">drag pins to reposition</span>
      </div>

      {dirty && (
        <div className="flex items-center gap-3 p-2 military-border bg-robotic-yellow/5">
          <span className="text-xs terminal-text text-robotic-yellow animate-pulse">
            Unsaved pin changes
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            className="ml-auto px-4 py-1.5 text-xs terminal-text bg-green-700 hover:bg-green-600 text-white rounded border border-green-500 disabled:opacity-50"
          >
            {saving ? 'SAVING...' : 'SAVE CHANGES'}
          </button>
        </div>
      )}
      {saveMsg && <div className="text-xs terminal-text text-green-400 p-1">{saveMsg}</div>}

      {/* OSM map */}
      <div className="military-border overflow-hidden relative" style={{ height: 600 }}>
        <MapContainer
          center={mapCenter}
          zoom={16}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={true}
          doubleClickZoom={true}
          zoomControl={true}
          maxZoom={22}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxNativeZoom={19}
            maxZoom={22}
          />
          {/* Floor plan overlay for active floor */}
          {floorPlans
            .filter((f) => f.floor_level === activeFloor)
            .map((floor) => (
              <FloorPlanOverlay key={floor.id} floor={floor} />
            ))}
          {/* Ground-truth zone polygons with editable radius — render largest first so smallest is on top */}
          {hazards
            .filter((h) => h.floor_level === activeFloor || !floorPlans.length)
            .flatMap((hazard) =>
              [...(hazard.zones ?? [])]
                .filter((z) => z.polygon && z.polygon.length >= 3)
                .sort((a, b) => b.radius_m - a.radius_m)
                .map((zone) => {
                  const ZONE_COLORS: Record<string, { color: string; fillColor: string }> = {
                    hot: { color: '#dc2626', fillColor: '#dc262640' },
                    warm: { color: '#f59e0b', fillColor: '#f59e0b30' },
                    cold: { color: '#3b82f6', fillColor: '#3b82f620' },
                  };
                  const style = ZONE_COLORS[zone.zone_type] ?? {
                    color: '#6b7280',
                    fillColor: '#6b728020',
                  };
                  const positions = zone.polygon!.map((p) => [p[0], p[1]] as [number, number]);
                  return (
                    <Polygon
                      key={`zone-${hazard.id}-${zone.zone_type}`}
                      positions={positions}
                      pathOptions={{
                        color: style.color,
                        fillColor: style.fillColor,
                        fillOpacity: 0.3,
                        weight: 2,
                        dashArray: '6 4',
                      }}
                    >
                      <Tooltip direction="center" permanent={false}>
                        {zone.zone_type.toUpperCase()} zone ({zone.radius_m}m)
                      </Tooltip>
                      <Popup>
                        <div style={{ minWidth: 160 }}>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 13,
                              color: style.color,
                              marginBottom: 6,
                              textTransform: 'uppercase',
                              letterSpacing: 1,
                            }}
                          >
                            {zone.zone_type} zone
                          </div>
                          <label
                            style={{
                              fontSize: 11,
                              display: 'block',
                              marginBottom: 2,
                              color: '#666',
                            }}
                          >
                            Radius (meters)
                          </label>
                          <input
                            type="number"
                            min={10}
                            max={5000}
                            step={5}
                            defaultValue={zone.radius_m}
                            onBlur={(e) => {
                              const val = parseInt(e.target.value, 10);
                              if (!isNaN(val) && val >= 10 && val !== zone.radius_m) {
                                onZoneRadiusChange(hazard.id, zone.zone_type, val);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            style={{
                              width: '100%',
                              padding: '4px 6px',
                              fontSize: 13,
                              border: `1px solid ${style.color}`,
                              borderRadius: 4,
                              outline: 'none',
                            }}
                          />
                          {zone.ppe_required?.length ? (
                            <div style={{ marginTop: 6, fontSize: 10, color: '#888' }}>
                              PPE: {zone.ppe_required.join(', ')}
                            </div>
                          ) : null}
                          {zone.allowed_teams?.length ? (
                            <div style={{ fontSize: 10, color: '#888' }}>
                              Teams: {zone.allowed_teams.join(', ')}
                            </div>
                          ) : null}
                        </div>
                      </Popup>
                    </Polygon>
                  );
                }),
            )}
          {validPins.map((pin) => (
            <ScenarioLocationMarker
              key={pin.id}
              location={pin}
              position={[pin.coordinates.lat!, pin.coordinates.lng!]}
              draggable
              onDragEnd={onLocationDrag}
            />
          ))}
          {hazards
            .filter((h) => h.floor_level === activeFloor || !floorPlans.length)
            .map((h) => (
              <Marker
                key={`haz-${h.id}`}
                position={[h.location_lat, h.location_lng]}
                icon={createDivIcon('#ef4444', HAZARD_ICONS[h.hazard_type] ?? '⚠️', 30)}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const ll = e.target.getLatLng();
                    onHazardDrag(h.id, ll.lat, ll.lng);
                  },
                }}
              >
                <Tooltip direction="top">
                  {HAZARD_ICONS[h.hazard_type] ?? '⚠️'} {h.hazard_type.replace(/_/g, ' ')}
                </Tooltip>
              </Marker>
            ))}
          {patients
            .filter((c) => c.floor_level === activeFloor || !floorPlans.length)
            .map((c) => {
              const triageColor =
                TRIAGE_COLORS[(c.conditions.triage_color as string) ?? 'yellow'] ?? '#eab308';
              const mobilityIcon =
                c.conditions.mobility === 'trapped'
                  ? '🪤'
                  : c.conditions.mobility === 'non_ambulatory'
                    ? '🚑'
                    : '🚶';
              return (
                <Marker
                  key={`cas-${c.id}`}
                  position={[c.location_lat, c.location_lng]}
                  icon={createDivIcon(triageColor, mobilityIcon, 24)}
                  draggable
                  eventHandlers={{
                    dragend: (e) => {
                      const ll = e.target.getLatLng();
                      onCasualtyDrag(c.id, ll.lat, ll.lng);
                    },
                  }}
                >
                  <Tooltip direction="top">
                    {(c.conditions.visible_description as string)?.slice(0, 80) || 'Patient'}
                  </Tooltip>
                </Marker>
              );
            })}
          {crowds
            .filter((c) => c.floor_level === activeFloor || !floorPlans.length)
            .map((c) => (
              <Marker
                key={`crowd-${c.id}`}
                position={[c.location_lat, c.location_lng]}
                icon={createDivIcon(
                  '#8b5cf6',
                  '👥',
                  Math.min(36, 24 + Math.floor(c.headcount / 15)),
                )}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const ll = e.target.getLatLng();
                    onCasualtyDrag(c.id, ll.lat, ll.lng);
                  },
                }}
              >
                <Tooltip direction="top">
                  👥 {c.headcount} people — {(c.conditions.behavior as string) ?? 'unknown'}
                </Tooltip>
              </Marker>
            ))}
        </MapContainer>
        {/* Floor Selector */}
        {floorPlans.length > 1 && (
          <FloorSelector
            floors={floorPlans}
            activeFloor={activeFloor}
            onFloorChange={setActiveFloor}
            hazardFloors={
              new Set(hazards.filter((h) => h.status !== 'resolved').map((h) => h.floor_level))
            }
          />
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {PIN_LEGEND.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-full border border-white/40 shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-xs terminal-text text-robotic-yellow/60">{item.label}</span>
          </div>
        ))}
      </div>

      {/* ── Location pins ── */}
      {locations.length > 0 && (
        <Section title="Locations">
          <div className="space-y-2">
            {locations.map((loc) => {
              const pinCat = loc.conditions?.pin_category as string | undefined;
              const narrativeDesc = loc.conditions?.narrative_description as string | undefined;
              const cond = loc.conditions ?? {};
              const hasConditions = Object.keys(cond).some(
                (k) => k !== 'pin_category' && k !== 'narrative_description',
              );
              const isExpanded = expandedPin === loc.id;
              const potentialUses = Array.isArray(cond.potential_uses)
                ? (cond.potential_uses as string[])
                : [];
              const quickFacts = [
                cond.area_m2 != null && `${cond.area_m2}m²`,
                cond.capacity_persons != null && `cap ${cond.capacity_persons}`,
                cond.has_water !== undefined && (cond.has_water ? '💧' : 'no water'),
                cond.has_electricity !== undefined && (cond.has_electricity ? '⚡' : 'no power'),
                cond.bed_capacity != null && `${cond.bed_capacity} beds`,
                cond.available_officers_estimate != null &&
                  `~${cond.available_officers_estimate} officers`,
                cond.appliance_count != null && `${cond.appliance_count} appliances`,
                cond.distance_from_incident_m != null && `${cond.distance_from_incident_m}m away`,
              ].filter(Boolean) as string[];

              return (
                <div key={loc.id} className="military-border">
                  <div className="p-4 flex gap-4">
                    <div className="shrink-0 w-28">
                      <div className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                        {pinCat ?? loc.location_type.replace(/_/g, ' ')}
                      </div>
                      {loc.coordinates.lat != null && (
                        <div className="text-xs terminal-text text-robotic-yellow/30 mt-0.5">
                          {loc.coordinates.lat.toFixed(4)}, {loc.coordinates.lng?.toFixed(4)}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm terminal-text text-robotic-yellow font-medium">
                        {loc.label}
                      </div>
                      {narrativeDesc && (
                        <p className="text-xs terminal-text text-robotic-yellow/70 mt-0.5">
                          {narrativeDesc}
                        </p>
                      )}
                      {quickFacts.length > 0 && (
                        <div className="text-xs terminal-text text-robotic-yellow/50 mt-0.5">
                          {quickFacts.join(' · ')}
                        </div>
                      )}
                      {potentialUses.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-1">
                          {potentialUses.map((u) => (
                            <span
                              key={u}
                              className="text-xs terminal-text bg-robotic-yellow/10 text-robotic-yellow/70 px-1 py-0.5 rounded"
                            >
                              {u.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="text-xs terminal-text text-robotic-yellow/40 mt-0.5">
                        type: {loc.location_type}
                      </div>
                    </div>
                    {hasConditions && (
                      <button
                        onClick={() => setExpandedPin(isExpanded ? null : loc.id)}
                        className="text-robotic-yellow/40 hover:text-robotic-yellow terminal-text text-xs shrink-0 self-start"
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    )}
                  </div>
                  {isExpanded && hasConditions && (
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2">
                      <ConditionsSummary conditions={loc.conditions} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Hazards ── */}
      {hazards.length > 0 && (
        <Section title={`Hazards (${hazards.length})`}>
          <div className="space-y-2">
            {hazards.map((h) => {
              const isExpanded = expandedPin === `haz-${h.id}`;
              return (
                <div key={h.id} className="military-border">
                  <div className="p-4 flex gap-4">
                    <div className="shrink-0 w-28">
                      <div className="text-xs terminal-text text-red-400/80 uppercase">
                        {HAZARD_ICONS[h.hazard_type] ?? '⚠️'} {h.hazard_type.replace(/_/g, ' ')}
                      </div>
                      <div className="text-xs terminal-text text-robotic-yellow/30 mt-0.5">
                        {h.location_lat.toFixed(4)}, {h.location_lng.toFixed(4)}
                      </div>
                      {h.appears_at_minutes > 0 && (
                        <div className="text-xs terminal-text text-red-400/50 mt-0.5">
                          T+{h.appears_at_minutes}min
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      {h.enriched_description && (
                        <p className="text-xs terminal-text text-robotic-yellow/80">
                          {h.enriched_description}
                        </p>
                      )}
                      <div className="flex gap-2 flex-wrap mt-1">
                        {h.fire_class && (
                          <span className="text-xs terminal-text bg-red-900/30 text-red-400 px-1 py-0.5 rounded border border-red-400/30">
                            Class {h.fire_class}
                          </span>
                        )}
                        {h.debris_type && (
                          <span className="text-xs terminal-text bg-orange-900/30 text-orange-400 px-1 py-0.5 rounded border border-orange-400/30">
                            {h.debris_type}
                          </span>
                        )}
                        <span className="text-xs terminal-text text-robotic-yellow/40">
                          floor: {h.floor_level}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setExpandedPin(isExpanded ? null : `haz-${h.id}`)}
                      className="text-robotic-yellow/40 hover:text-robotic-yellow terminal-text text-xs shrink-0 self-start"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2 space-y-2">
                      {h.resolution_requirements &&
                        Object.keys(h.resolution_requirements).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                              Resolution Requirements
                            </div>
                            <pre className="text-xs terminal-text text-robotic-yellow/60 whitespace-pre-wrap">
                              {JSON.stringify(h.resolution_requirements, null, 2)}
                            </pre>
                          </div>
                        )}
                      {h.personnel_requirements &&
                        Object.keys(h.personnel_requirements).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                              Personnel
                            </div>
                            <pre className="text-xs terminal-text text-robotic-yellow/60 whitespace-pre-wrap">
                              {JSON.stringify(h.personnel_requirements, null, 2)}
                            </pre>
                          </div>
                        )}
                      {h.deterioration_timeline &&
                        Object.keys(h.deterioration_timeline).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                              Deterioration Timeline
                            </div>
                            <pre className="text-xs terminal-text text-robotic-yellow/60 whitespace-pre-wrap">
                              {JSON.stringify(h.deterioration_timeline, null, 2)}
                            </pre>
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Casualties ── */}
      {patients.length > 0 && (
        <Section title={`Casualties (${patients.length})`}>
          <div className="space-y-2">
            {patients.map((c) => {
              const conds = c.conditions;
              const triageColor = (conds.triage_color as string) ?? 'yellow';
              const injuries = (conds.injuries as Array<Record<string, unknown>>) ?? [];
              const isExpanded = expandedPin === `cas-${c.id}`;
              return (
                <div key={c.id} className="military-border">
                  <div className="p-4 flex gap-4">
                    <div className="shrink-0 w-28">
                      <div
                        className="text-xs terminal-text uppercase font-bold"
                        style={{ color: TRIAGE_COLORS[triageColor] ?? '#eab308' }}
                      >
                        {triageColor.toUpperCase()}
                      </div>
                      <div className="text-xs terminal-text text-robotic-yellow/30 mt-0.5">
                        {c.location_lat.toFixed(4)}, {c.location_lng.toFixed(4)}
                      </div>
                      {c.appears_at_minutes > 0 && (
                        <div className="text-xs terminal-text text-amber-400/50 mt-0.5">
                          T+{c.appears_at_minutes}min
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs terminal-text text-robotic-yellow/80">
                        {(conds.visible_description as string) || 'Patient'}
                      </p>
                      <div className="flex gap-2 flex-wrap mt-1">
                        <span className="text-xs terminal-text text-robotic-yellow/50">
                          {(conds.mobility as string)?.replace(/_/g, ' ') ?? '?'}
                        </span>
                        <span className="text-xs terminal-text text-robotic-yellow/50">
                          {(conds.accessibility as string)?.replace(/_/g, ' ') ?? 'open'}
                        </span>
                        <span className="text-xs terminal-text text-robotic-yellow/50">
                          {(conds.consciousness as string) ?? '?'}
                        </span>
                      </div>
                    </div>
                    {injuries.length > 0 && (
                      <button
                        onClick={() => setExpandedPin(isExpanded ? null : `cas-${c.id}`)}
                        className="text-robotic-yellow/40 hover:text-robotic-yellow terminal-text text-xs shrink-0 self-start"
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    )}
                  </div>
                  {isExpanded && injuries.length > 0 && (
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2">
                      <div className="space-y-1">
                        {injuries.map((inj, i) => (
                          <div
                            key={i}
                            className="text-xs terminal-text text-robotic-yellow/60 flex gap-2"
                          >
                            <span className="text-robotic-yellow/40">{inj.severity as string}</span>
                            <span>
                              {(inj.type as string)?.replace(/_/g, ' ')} — {inj.body_part as string}
                            </span>
                            {typeof inj.visible_signs === 'string' && (
                              <span className="text-robotic-yellow/40">({inj.visible_signs})</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Crowds ── */}
      {crowds.length > 0 && (
        <Section
          title={`Crowds (${crowds.length} groups, ${crowds.reduce((s, c) => s + c.headcount, 0)} total)`}
        >
          <div className="space-y-2">
            {crowds.map((c) => {
              const conds = c.conditions;
              const wounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
              return (
                <div key={c.id} className="military-border">
                  <div className="p-4 flex gap-4">
                    <div className="shrink-0 w-28">
                      <div className="text-xs terminal-text text-violet-400/80 uppercase">
                        👥 {c.headcount} people
                      </div>
                      <div className="text-xs terminal-text text-robotic-yellow/30 mt-0.5">
                        {c.location_lat.toFixed(4)}, {c.location_lng.toFixed(4)}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs terminal-text text-robotic-yellow/80">
                        {(conds.visible_description as string) || `Group of ${c.headcount}`}
                      </p>
                      <div className="flex gap-2 flex-wrap mt-1">
                        <span className="text-xs terminal-text text-violet-400/70">
                          {(conds.behavior as string) ?? 'unknown'}
                        </span>
                        {!!conds.bottleneck && (
                          <span className="text-xs terminal-text text-red-400/70">bottleneck</span>
                        )}
                        {typeof conds.blocking_exit === 'string' && (
                          <span className="text-xs terminal-text text-red-400/70">
                            blocking: {conds.blocking_exit}
                          </span>
                        )}
                        {wounded.length > 0 && (
                          <span className="text-xs terminal-text text-amber-400/70">
                            {wounded.reduce((s, w) => s + ((w.count as number) ?? 0), 0)} wounded
                            mixed in
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Equipment Palette ── */}
      {equipment.length > 0 && (
        <Section title={`Equipment Palette (${equipment.length} types)`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {equipment.map((eq) => (
              <div key={eq.id} className="military-border p-3">
                <div className="text-sm terminal-text text-cyan-400 font-medium">
                  {eq.icon && <span className="mr-1">{eq.icon}</span>}
                  {eq.label}
                </div>
                <div className="text-xs terminal-text text-robotic-yellow/40 mt-0.5">
                  {eq.equipment_type.replace(/_/g, ' ')}
                </div>
                {eq.properties && Object.keys(eq.properties).length > 0 && (
                  <div className="text-xs terminal-text text-robotic-yellow/50 mt-1">
                    {Object.entries(eq.properties)
                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-900/40 text-red-400 border-red-400/50',
  high: 'bg-orange-900/40 text-orange-400 border-orange-400/50',
  medium: 'bg-yellow-900/40 text-robotic-yellow border-robotic-yellow/50',
  low: 'bg-green-900/40 text-green-400 border-green-400/50',
};

const InjectRow = ({
  inject,
  expanded,
  onToggle,
}: {
  inject: Inject;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const triggerLabel =
    inject.trigger_time_minutes != null
      ? `T+${inject.trigger_time_minutes}min`
      : inject.trigger_condition
        ? `DECISION: ${inject.trigger_condition}`
        : 'CONDITION-DRIVEN';

  const condAppear = inject.conditions_to_appear as
    | { threshold?: number; conditions?: string[]; all?: string[] }
    | null
    | undefined;

  return (
    <div className="military-border">
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-start gap-3 text-left hover:bg-robotic-yellow/5 transition-all"
      >
        <div className="shrink-0 w-28">
          <div className="text-xs terminal-text text-robotic-yellow/60">{triggerLabel}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm terminal-text text-robotic-yellow">{inject.title}</div>
          <div className="flex gap-2 mt-1 flex-wrap">
            <span
              className={`text-xs terminal-text px-1.5 py-0.5 border ${SEVERITY_BADGE[inject.severity] ?? SEVERITY_BADGE.medium}`}
            >
              {inject.severity.toUpperCase()}
            </span>
            <span className="text-xs terminal-text text-robotic-yellow/40">
              {inject.type.replace(/_/g, ' ')}
            </span>
            <span className="text-xs terminal-text text-robotic-yellow/40">
              [{inject.inject_scope}]
            </span>
            {inject.target_teams && inject.target_teams.length > 0 && (
              <span className="text-xs terminal-text text-robotic-yellow/40">
                → {inject.target_teams.join(', ')}
              </span>
            )}
          </div>
        </div>
        <span className="text-robotic-yellow/40 terminal-text text-xs shrink-0">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-robotic-yellow/15 pt-3 space-y-3">
          <p className="text-xs terminal-text leading-relaxed">{inject.content}</p>

          {condAppear && (
            <div>
              <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                Conditions to appear
              </div>
              <div className="text-xs terminal-text font-mono bg-black/30 p-2 rounded">
                {JSON.stringify(condAppear, null, 2)}
              </div>
            </div>
          )}

          {inject.conditions_to_cancel && inject.conditions_to_cancel.length > 0 && (
            <div>
              <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                Conditions to cancel
              </div>
              <div className="flex gap-1 flex-wrap">
                {inject.conditions_to_cancel.map((c, i) => (
                  <span
                    key={i}
                    className="text-xs terminal-text px-1.5 py-0.5 border border-robotic-orange/50 text-robotic-orange/80"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}

          {inject.eligible_after_minutes != null && (
            <div className="text-xs terminal-text text-robotic-yellow/50">
              Eligible after: T+{inject.eligible_after_minutes}min
            </div>
          )}

          {inject.objective_penalty != null && (
            <div className="text-xs terminal-text text-red-400">
              {'Penalty: ' + JSON.stringify(inject.objective_penalty as Record<string, unknown>)}
            </div>
          )}

          {inject.state_effect != null &&
            Object.keys(inject.state_effect as Record<string, unknown>).length > 0 && (
              <div>
                <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                  State effect
                </div>
                <pre className="text-xs terminal-text font-mono bg-black/30 p-2 rounded whitespace-pre-wrap">
                  {JSON.stringify(inject.state_effect as Record<string, unknown>, null, 2)}
                </pre>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

// ─── Env Truths Tab ─────────────────────────────────────────────────────────

interface SiteReqMap {
  [useType: string]: {
    min_area_m2?: number;
    requires_water?: boolean;
    requires_shelter?: boolean;
    requires_vehicle_access?: boolean;
    requires_electricity?: boolean;
    min_capacity?: number;
    max_distance_from_incident_m?: number;
    notes?: string;
  };
}

const EnvTruthsTab = ({
  locations,
  siteRequirements,
}: {
  locations: LocationPin[];
  siteRequirements?: SiteReqMap;
}) => {
  const getPinCat = (l: LocationPin) => l.conditions?.pin_category as string | undefined;

  const candidateSpaces = locations.filter(
    (l) =>
      getPinCat(l) === 'candidate_space' ||
      (l.conditions && Array.isArray(l.conditions.potential_uses)),
  );
  const poiHospitals = locations.filter((l) => l.location_type === 'hospital');
  const poiPolice = locations.filter((l) => l.location_type === 'police_station');
  const poiFire = locations.filter((l) => l.location_type === 'fire_station');
  const scenarioFixed = locations.filter((l) => {
    const isCandidateSpace =
      getPinCat(l) === 'candidate_space' ||
      (l.conditions && Array.isArray(l.conditions.potential_uses));
    const isPoi =
      l.location_type === 'hospital' ||
      l.location_type === 'police_station' ||
      l.location_type === 'fire_station';
    return !isCandidateSpace && !isPoi;
  });

  const hasNewModel = candidateSpaces.length > 0 || poiPolice.length > 0 || poiFire.length > 0;

  if (!hasNewModel && locations.length === 0) {
    return (
      <p className="text-sm terminal-text text-robotic-yellow/50">[NO ENVIRONMENTAL TRUTH DATA]</p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Scenario Infrastructure */}
      {scenarioFixed.length > 0 && (
        <Section title={`Scenario infrastructure (${scenarioFixed.length})`}>
          <div className="space-y-2">
            {scenarioFixed.map((loc) => (
              <div key={loc.id} className="military-border p-3">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-24">
                    <div className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                      {getPinCat(loc) ?? loc.location_type.replace(/_/g, ' ')}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm terminal-text text-robotic-yellow font-medium">
                      {loc.label}
                    </div>
                    <ConditionsSummary conditions={loc.conditions} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Candidate Spaces */}
      {candidateSpaces.length > 0 && (
        <Section title={`Candidate spaces (${candidateSpaces.length})`}>
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-3">
            Physical spaces players must evaluate and assign a purpose to.
          </p>
          <div className="space-y-3">
            {candidateSpaces.map((loc) => {
              const cond = loc.conditions ?? {};
              const uses = Array.isArray(cond.potential_uses)
                ? (cond.potential_uses as string[])
                : [];
              return (
                <div
                  key={loc.id}
                  className="military-border p-3 border-l-2 border-l-robotic-yellow/30"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-sm terminal-text text-robotic-yellow font-medium">
                      {loc.label}
                    </span>
                    {uses.length > 0 && (
                      <div className="flex gap-1 flex-wrap justify-end">
                        {uses.map((u) => (
                          <span
                            key={u}
                            className="text-xs terminal-text bg-robotic-yellow/10 text-robotic-yellow/80 px-1.5 py-0.5 rounded"
                          >
                            {u.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs terminal-text text-robotic-yellow/60">
                    {[
                      cond.area_m2 != null && `${cond.area_m2}m²`,
                      cond.capacity_persons != null && `capacity ${cond.capacity_persons}`,
                      cond.has_water !== undefined && (cond.has_water ? 'water: yes' : 'no water'),
                      cond.has_electricity !== undefined &&
                        (cond.has_electricity ? 'electricity: yes' : 'no electricity'),
                      cond.has_shelter !== undefined &&
                        (cond.has_shelter ? 'sheltered' : 'unsheltered'),
                      cond.vehicle_access !== undefined &&
                        (cond.vehicle_access ? 'vehicle access' : 'no vehicle access'),
                      cond.distance_from_incident_m != null &&
                        `${cond.distance_from_incident_m}m from incident`,
                      cond.surface && `surface: ${String(cond.surface)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {cond.notes != null && (
                    <div className="text-xs terminal-text text-robotic-yellow/40 italic mt-1">
                      {String(cond.notes)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Site requirements comparison */}
          {siteRequirements && Object.keys(siteRequirements).length > 0 && (
            <div className="mt-4 pt-3 border-t border-robotic-yellow/15">
              <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Site requirements (from standards)
              </div>
              <div className="space-y-1">
                {Object.entries(siteRequirements).map(([useType, req]) => (
                  <div key={useType} className="text-xs terminal-text text-robotic-yellow/50">
                    <span className="text-robotic-yellow/70">{useType.replace(/_/g, ' ')}:</span>{' '}
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
            </div>
          )}
        </Section>
      )}

      {/* Nearby Facilities (POI) */}
      {(poiHospitals.length > 0 || poiPolice.length > 0 || poiFire.length > 0) && (
        <Section
          title={`Nearby facilities (${poiHospitals.length + poiPolice.length + poiFire.length})`}
        >
          {poiHospitals.length > 0 && (
            <div className="mb-3">
              <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-1">
                Hospitals ({poiHospitals.length})
              </div>
              <div className="space-y-1">
                {poiHospitals.map((loc) => {
                  const c = loc.conditions ?? {};
                  return (
                    <div key={loc.id} className="text-xs terminal-text flex gap-2 items-baseline">
                      <span className="text-robotic-yellow/80 font-medium">{loc.label}</span>
                      <span className="text-robotic-yellow/50">
                        {[
                          c.distance_from_incident_m != null && `${c.distance_from_incident_m}m`,
                          c.trauma_center_level && String(c.trauma_center_level),
                          c.bed_capacity != null && `${c.bed_capacity} beds`,
                          c.emergency_beds_available != null &&
                            `${c.emergency_beds_available} emergency`,
                          c.estimated_response_time_min != null &&
                            `~${c.estimated_response_time_min}min`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {poiPolice.length > 0 && (
            <div className="mb-3">
              <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-1">
                Police ({poiPolice.length})
              </div>
              <div className="space-y-1">
                {poiPolice.map((loc) => {
                  const c = loc.conditions ?? {};
                  return (
                    <div key={loc.id} className="text-xs terminal-text flex gap-2 items-baseline">
                      <span className="text-robotic-yellow/80 font-medium">{loc.label}</span>
                      <span className="text-robotic-yellow/50">
                        {[
                          c.distance_from_incident_m != null && `${c.distance_from_incident_m}m`,
                          c.facility_type && String(c.facility_type).replace(/_/g, ' '),
                          c.available_officers_estimate != null &&
                            `~${c.available_officers_estimate} officers`,
                          c.has_tactical_unit && 'tactical',
                          c.estimated_response_time_min != null &&
                            `~${c.estimated_response_time_min}min`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {poiFire.length > 0 && (
            <div className="mb-3">
              <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-1">
                Fire stations ({poiFire.length})
              </div>
              <div className="space-y-1">
                {poiFire.map((loc) => {
                  const c = loc.conditions ?? {};
                  return (
                    <div key={loc.id} className="text-xs terminal-text flex gap-2 items-baseline">
                      <span className="text-robotic-yellow/80 font-medium">{loc.label}</span>
                      <span className="text-robotic-yellow/50">
                        {[
                          c.distance_from_incident_m != null && `${c.distance_from_incident_m}m`,
                          c.appliance_count != null && `${c.appliance_count} appliances`,
                          c.has_hazmat_unit && 'hazmat',
                          c.has_rescue_unit && 'rescue',
                          c.estimated_response_time_min != null &&
                            `~${c.estimated_response_time_min}min`,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
};

const ConditionsSummary = ({ conditions }: { conditions?: Record<string, unknown> | null }) => {
  if (!conditions) return null;
  const skip = new Set(['pin_category', 'narrative_description']);
  const entries = Object.entries(conditions).filter(
    ([k, v]) => !skip.has(k) && v != null && v !== '' && v !== false,
  );
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 text-xs terminal-text text-robotic-yellow/50 space-y-0.5">
      {entries.map(([key, val]) => (
        <div key={key}>
          <span className="text-robotic-yellow/40">{key.replace(/_/g, ' ')}: </span>
          {Array.isArray(val) ? (
            <span>{(val as string[]).join(', ')}</span>
          ) : typeof val === 'boolean' ? (
            <span>{val ? 'yes' : 'no'}</span>
          ) : (
            <span>{String(val)}</span>
          )}
        </div>
      ))}
    </div>
  );
};
