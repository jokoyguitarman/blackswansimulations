import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Tooltip,
  Popup,
  Polygon,
  useMapEvents,
} from 'react-leaflet';
import { DivIcon } from 'leaflet';
import { api } from '../../lib/api';
import { ScenarioLocationMarker, type ScenarioLocationPin } from '../COP/ScenarioLocationMarker';
import { FloorSelector, type FloorPlan } from '../COP/FloorSelector';
import { FloorPlanOverlay } from '../COP/FloorPlanOverlay';
import { BuildingStudOverlay } from '../COP/BuildingStudOverlay';
import { svg } from '../COP/mapIcons';

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

interface CounterDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'enum';
  initial_value?: number | boolean | string;
  behavior?: string;
  visible_to?: string;
  config?: {
    keywords?: string[];
    categories?: string[];
    base_rate_per_min?: number;
    values?: string[];
    [k: string]: unknown;
  };
}

interface Team {
  id: string;
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  counter_definitions?: CounterDef[];
  is_investigative?: boolean;
}

interface LocationPin {
  id: string;
  location_type: string;
  pin_category?: string;
  label: string;
  coordinates: { lat: number; lng: number };
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

function itemLabel(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  const obj = item as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    'name',
    'item',
    'reason',
    'action',
    'label',
    'type',
    'role',
    'condition',
    'description',
  ]) {
    if (typeof obj[key] === 'string') {
      parts.push(obj[key] as string);
      break;
    }
  }
  if (parts.length === 0)
    parts.push(
      Object.values(obj)
        .filter((v) => typeof v === 'string')
        .join(' — ') || JSON.stringify(obj),
    );
  for (const key of ['priority', 'intervention', 'detail', 'purpose']) {
    if (typeof obj[key] === 'string') parts.push(`(${obj[key]})`);
  }
  return parts.join(' ');
}

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
  'Research',
] as const;
type Tab = (typeof tabs)[number];

interface ResearchCase {
  id: string;
  name: string;
  summary: string;
  timeline: string | null;
  adversary_behavior: string | null;
  other_actors: string | null;
  environment: string | null;
  outcome: string | null;
  casualties_killed: number | null;
  casualties_injured: number | null;
  num_attackers: number | null;
  weapon_description: string | null;
  weapon_forensics: string | null;
  damage_radius_m: number | null;
  hazards_triggered: string[] | null;
  secondary_effects: string[] | null;
  injury_breakdown: string | null;
  crowd_response: string | null;
  response_time_minutes: number | null;
  containment_time_minutes: number | null;
  environment_factors: string[] | null;
  relevance_score: number | null;
}

export const ScenarioDetailView = ({ scenarioId, onClose }: Props) => {
  const [scenario, setScenario] = useState<ScenarioFull | null>(null);
  const [injects, setInjects] = useState<Inject[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [locations, setLocations] = useState<LocationPin[]>([]);
  const [hazardPins, setHazardPins] = useState<HazardPin[]>([]);
  const [casualtyPins, setCasualtyPins] = useState<CasualtyPin[]>([]);
  const [equipmentItems, setEquipmentItems] = useState<EquipmentItem[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>([]);
  const [researchCases, setResearchCases] = useState<ResearchCase[]>([]);
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
  const [retryingRoutes, setRetryingRoutes] = useState(false);
  const [retryRoutesMsg, setRetryRoutesMsg] = useState<string | null>(null);
  const [customFactsLoading, setCustomFactsLoading] = useState(false);
  const [customFactsMsg, setCustomFactsMsg] = useState<string | null>(null);

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
        const [scenRes, injectRes, teamRes, locRes, hazRes, casRes, eqRes, fpRes, researchRes] =
          await Promise.all([
            api.scenarios.get(scenarioId),
            api.scenarios.getInjects(scenarioId),
            api.scenarios.getTeams(scenarioId),
            api.scenarios.getScenarioLocations(scenarioId),
            api.scenarios.getScenarioHazards(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioCasualties(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioEquipment(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioFloorPlans(scenarioId).catch(() => ({ data: [] })),
            api.scenarios.getScenarioResearch(scenarioId).catch(() => ({ data: [] })),
          ]);
        setScenario(scenRes.data as ScenarioFull);
        setInjects((injectRes.data ?? []) as Inject[]);
        setTeams((teamRes.data ?? []) as Team[]);
        setLocations((locRes.data ?? []) as LocationPin[]);
        setHazardPins((hazRes.data ?? []) as HazardPin[]);
        setCasualtyPins((casRes.data ?? []) as CasualtyPin[]);
        setEquipmentItems((eqRes.data ?? []) as EquipmentItem[]);
        setFloorPlans((fpRes.data ?? []) as FloorPlan[]);
        setResearchCases((researchRes.data ?? []) as ResearchCase[]);
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

              <Section title="Intelligence / Custom Facts">
                {(!ik?.custom_facts || ik.custom_facts.length === 0) && (
                  <div className="flex items-center gap-3 mb-3">
                    <p className="text-sm terminal-text text-robotic-yellow/50">
                      [NO CUSTOM FACTS] Generate research-oriented facility/area facts for this
                      scenario.
                    </p>
                    <button
                      onClick={async () => {
                        setCustomFactsLoading(true);
                        setCustomFactsMsg(null);
                        try {
                          const res = await api.scenarios.retryCustomFacts(scenarioId);
                          setCustomFactsMsg(
                            res.message ||
                              (res.ok
                                ? `Generated ${res.facts_count ?? 0} custom facts`
                                : res.error) ||
                              'Done',
                          );
                          const scenRes = await api.scenarios.get(scenarioId);
                          setScenario(scenRes.data as ScenarioFull);
                        } catch (err) {
                          setCustomFactsMsg(
                            err instanceof Error ? err.message : 'Failed to generate custom facts',
                          );
                        } finally {
                          setCustomFactsLoading(false);
                        }
                      }}
                      disabled={customFactsLoading}
                      className="ml-auto px-4 py-1.5 text-xs terminal-text bg-blue-700 hover:bg-blue-600 text-white rounded border border-blue-500 disabled:opacity-50"
                    >
                      {customFactsLoading ? 'GENERATING...' : 'GENERATE CUSTOM FACTS'}
                    </button>
                  </div>
                )}
                {customFactsMsg && (
                  <div className="text-xs terminal-text text-green-400 p-1 mb-2">
                    {customFactsMsg}
                  </div>
                )}
                {ik?.custom_facts && ik.custom_facts.length > 0 ? (
                  <div className="space-y-3">
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={async () => {
                          setCustomFactsLoading(true);
                          setCustomFactsMsg(null);
                          try {
                            const res = await api.scenarios.retryCustomFacts(scenarioId, {
                              force: true,
                            });
                            setCustomFactsMsg(
                              res.message ||
                                (res.ok
                                  ? `Regenerated ${res.facts_count ?? 0} custom facts`
                                  : res.error) ||
                                'Done',
                            );
                            const scenRes = await api.scenarios.get(scenarioId);
                            setScenario(scenRes.data as ScenarioFull);
                          } catch (err) {
                            setCustomFactsMsg(
                              err instanceof Error
                                ? err.message
                                : 'Failed to regenerate custom facts',
                            );
                          } finally {
                            setCustomFactsLoading(false);
                          }
                        }}
                        disabled={customFactsLoading}
                        className="px-3 py-1 text-xs terminal-text bg-robotic-yellow/10 hover:bg-robotic-yellow/20 text-robotic-yellow rounded border border-robotic-yellow/40 disabled:opacity-50"
                      >
                        {customFactsLoading ? 'REGENERATING…' : 'REGENERATE CUSTOM FACTS'}
                      </button>
                    </div>
                    {ik.custom_facts.map((fact, i) => (
                      <div key={i} className="military-border p-3">
                        <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
                          {fact.topic}
                        </div>
                        <p className="text-sm terminal-text">{fact.summary}</p>
                        {fact.detail && (
                          <p className="text-xs terminal-text text-robotic-yellow/60 mt-1 whitespace-pre-wrap">
                            {fact.detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </Section>

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
                <div className="space-y-4">
                  {teams.map((team) => (
                    <div key={team.id} className="military-border p-4">
                      <div className="text-sm terminal-text text-robotic-yellow font-medium uppercase mb-1 flex items-center gap-2">
                        {team.team_name}
                        {team.is_investigative && (
                          <span className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded border border-purple-500/60 bg-purple-500/20 text-purple-300">
                            INVESTIGATIVE
                          </span>
                        )}
                      </div>
                      <p className="text-xs terminal-text text-robotic-yellow/70 mb-2">
                        {team.team_description}
                      </p>
                      <div className="text-xs terminal-text text-robotic-yellow/50 mb-3">
                        {team.min_participants}–{team.max_participants} participants
                      </div>
                      {team.counter_definitions && team.counter_definitions.length > 0 && (
                        <div className="border-t border-robotic-yellow/15 pt-3 mt-2">
                          <div className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2 tracking-wider">
                            Counters ({team.counter_definitions.length})
                          </div>
                          <div className="space-y-2">
                            {team.counter_definitions.map((cd) => (
                              <div
                                key={cd.key}
                                className="bg-black/30 border border-robotic-yellow/10 rounded px-3 py-2"
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-xs terminal-text text-robotic-yellow/90 font-medium">
                                    {cd.label}
                                  </span>
                                  <span className="text-[10px] terminal-text text-robotic-yellow/40 uppercase">
                                    {cd.type}
                                    {cd.behavior ? ` · ${cd.behavior.replace(/_/g, ' ')}` : ''}
                                  </span>
                                </div>
                                <div className="text-[10px] terminal-text text-robotic-yellow/40 font-mono">
                                  key: {cd.key}
                                  {cd.initial_value !== undefined &&
                                    ` · initial: ${String(cd.initial_value)}`}
                                  {cd.visible_to === 'trainer_only' && ' · trainer only'}
                                </div>
                                {cd.config?.keywords && cd.config.keywords.length > 0 && (
                                  <div className="text-[10px] terminal-text text-robotic-yellow/35 mt-1">
                                    triggers: {cd.config.keywords.join(', ')}
                                  </div>
                                )}
                                {cd.config?.base_rate_per_min != null && (
                                  <div className="text-[10px] terminal-text text-robotic-yellow/35 mt-1">
                                    rate: {cd.config.base_rate_per_min}/min
                                  </div>
                                )}
                                {cd.config?.values && cd.config.values.length > 0 && (
                                  <div className="text-[10px] terminal-text text-robotic-yellow/35 mt-1">
                                    values: {cd.config.values.join(' | ')}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
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
                const hasRoutes = routePins.length > 0;
                return (
                  <>
                    {!hasRoutes && (
                      <p className="text-sm terminal-text text-robotic-yellow/50 mb-3">
                        [NO ROUTE DATA]
                      </p>
                    )}
                    <div className="flex items-center gap-3 mb-3">
                      <button
                        onClick={async () => {
                          setRetryingRoutes(true);
                          setRetryRoutesMsg(null);
                          try {
                            const res = await api.scenarios.retryRoutes(scenarioId);
                            if (res.routes_count) {
                              setRetryRoutesMsg(`${res.routes_count} routes generated`);
                              const locRes = await api.scenarios.getScenarioLocations(scenarioId);
                              setLocations((locRes.data ?? []) as LocationPin[]);
                            } else {
                              setRetryRoutesMsg(res.message || res.error || 'No routes generated');
                            }
                          } catch (err) {
                            setRetryRoutesMsg(
                              err instanceof Error ? err.message : 'Failed to fetch routes',
                            );
                          } finally {
                            setRetryingRoutes(false);
                          }
                        }}
                        disabled={retryingRoutes || hasRoutes}
                        className="px-4 py-1.5 text-xs terminal-text bg-blue-700 hover:bg-blue-600 text-white rounded border border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {retryingRoutes
                          ? 'FETCHING ROUTES...'
                          : hasRoutes
                            ? 'ROUTES AVAILABLE'
                            : 'RETRY ROUTE FETCH'}
                      </button>
                      {retryRoutesMsg && (
                        <span className="text-xs terminal-text text-green-400">
                          {retryRoutesMsg}
                        </span>
                      )}
                    </div>
                    {hasRoutes && (
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
                                  {c.highway_type ? `${String(c.highway_type)} ` : null}
                                  {c.one_way ? '[one-way] ' : ''}
                                  {c.distance_m != null ? `${c.distance_m}m ` : null}
                                  {c.travel_time_minutes != null
                                    ? `~${c.travel_time_minutes} min`
                                    : null}
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
                    )}
                  </>
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

          {activeTab === 'Research' && (
            <div className="space-y-4">
              {researchCases.length === 0 ? (
                <p className="text-sm terminal-text text-robotic-yellow/50">
                  [NO RESEARCH DATA] — Research cases are gathered during scenario generation.
                </p>
              ) : (
                researchCases.map((rc) => (
                  <div
                    key={rc.id}
                    className="military-border p-4 border-robotic-yellow/30 bg-black/20 space-y-3"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm terminal-text text-robotic-yellow font-bold uppercase">
                        {rc.name}
                      </h3>
                      {rc.relevance_score != null && (
                        <span
                          className={`shrink-0 px-2 py-0.5 text-[10px] terminal-text uppercase border ${
                            rc.relevance_score >= 8
                              ? 'text-green-400 border-green-400/50 bg-green-400/10'
                              : rc.relevance_score >= 5
                                ? 'text-robotic-orange border-robotic-orange/50 bg-robotic-orange/10'
                                : 'text-robotic-yellow/60 border-robotic-yellow/30 bg-robotic-yellow/5'
                          }`}
                        >
                          {rc.relevance_score}/10 match
                        </span>
                      )}
                    </div>

                    {/* Summary */}
                    <p className="text-xs terminal-text text-robotic-yellow/80 leading-relaxed">
                      {rc.summary}
                    </p>

                    {/* Stats chips */}
                    <div className="flex flex-wrap gap-2">
                      {rc.casualties_killed != null && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-red-900/40 border border-red-500/30 text-red-300">
                          {rc.casualties_killed} KILLED
                        </span>
                      )}
                      {rc.casualties_injured != null && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-orange-900/40 border border-orange-500/30 text-orange-300">
                          {rc.casualties_injured} INJURED
                        </span>
                      )}
                      {rc.num_attackers != null && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-purple-900/40 border border-purple-500/30 text-purple-300">
                          {rc.num_attackers} ATTACKER{rc.num_attackers !== 1 ? 'S' : ''}
                        </span>
                      )}
                      {rc.response_time_minutes != null && rc.response_time_minutes > 0 && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-blue-900/40 border border-blue-500/30 text-blue-300">
                          RESPONSE: {rc.response_time_minutes} MIN
                        </span>
                      )}
                      {rc.containment_time_minutes != null && rc.containment_time_minutes > 0 && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-cyan-900/40 border border-cyan-500/30 text-cyan-300">
                          CONTAINED: {rc.containment_time_minutes} MIN
                        </span>
                      )}
                      {rc.damage_radius_m != null && rc.damage_radius_m > 0 && (
                        <span className="px-2 py-0.5 text-[10px] terminal-text bg-yellow-900/40 border border-yellow-500/30 text-yellow-300">
                          RADIUS: {Math.round(rc.damage_radius_m * 3.28084)} FT
                        </span>
                      )}
                    </div>

                    {/* Weapon section */}
                    {(rc.weapon_description || rc.weapon_forensics) && (
                      <div className="border-l-2 border-robotic-orange/40 pl-3">
                        <div className="text-[10px] terminal-text text-robotic-orange/70 uppercase mb-1">
                          WEAPON PROFILE
                        </div>
                        {rc.weapon_description && (
                          <p className="text-xs terminal-text text-robotic-yellow/70">
                            {rc.weapon_description}
                          </p>
                        )}
                        {rc.weapon_forensics && (
                          <p className="text-xs terminal-text text-robotic-yellow/60 mt-1">
                            Forensics: {rc.weapon_forensics}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Injury breakdown */}
                    {rc.injury_breakdown && (
                      <div className="border-l-2 border-red-500/40 pl-3">
                        <div className="text-[10px] terminal-text text-red-400/70 uppercase mb-1">
                          INJURY BREAKDOWN
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/70">
                          {rc.injury_breakdown}
                        </p>
                      </div>
                    )}

                    {/* Hazards triggered */}
                    {rc.hazards_triggered && rc.hazards_triggered.length > 0 && (
                      <div className="border-l-2 border-yellow-500/40 pl-3">
                        <div className="text-[10px] terminal-text text-yellow-400/70 uppercase mb-1">
                          HAZARDS TRIGGERED
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {rc.hazards_triggered.map((h, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 text-[10px] terminal-text bg-yellow-900/30 border border-yellow-500/20 text-yellow-300"
                            >
                              {h.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Crowd response */}
                    {rc.crowd_response && (
                      <div className="border-l-2 border-purple-500/40 pl-3">
                        <div className="text-[10px] terminal-text text-purple-400/70 uppercase mb-1">
                          CROWD BEHAVIOR
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/70">
                          {rc.crowd_response}
                        </p>
                      </div>
                    )}

                    {/* Secondary effects */}
                    {rc.secondary_effects && rc.secondary_effects.length > 0 && (
                      <div className="border-l-2 border-cyan-500/40 pl-3">
                        <div className="text-[10px] terminal-text text-cyan-400/70 uppercase mb-1">
                          SECONDARY EFFECTS
                        </div>
                        <ul className="space-y-0.5">
                          {rc.secondary_effects.map((e, i) => (
                            <li key={i} className="text-xs terminal-text text-robotic-yellow/70">
                              ▸ {e.replace(/_/g, ' ')}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Timeline */}
                    {rc.timeline && (
                      <div className="border-l-2 border-robotic-yellow/30 pl-3">
                        <div className="text-[10px] terminal-text text-robotic-yellow/50 uppercase mb-1">
                          TIMELINE
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/60 leading-relaxed">
                          {rc.timeline}
                        </p>
                      </div>
                    )}

                    {/* Adversary behavior */}
                    {rc.adversary_behavior && (
                      <div className="border-l-2 border-red-600/30 pl-3">
                        <div className="text-[10px] terminal-text text-red-400/50 uppercase mb-1">
                          ADVERSARY BEHAVIOR
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/60 leading-relaxed">
                          {rc.adversary_behavior}
                        </p>
                      </div>
                    )}

                    {/* Environment factors */}
                    {rc.environment_factors && rc.environment_factors.length > 0 && (
                      <div className="border-l-2 border-green-500/30 pl-3">
                        <div className="text-[10px] terminal-text text-green-400/50 uppercase mb-1">
                          ENVIRONMENT FACTORS
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {rc.environment_factors.map((f, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 text-[10px] terminal-text bg-green-900/20 border border-green-500/20 text-green-300/80"
                            >
                              {f.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Outcome */}
                    {rc.outcome && (
                      <div className="border-l-2 border-robotic-yellow/20 pl-3">
                        <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-1">
                          OUTCOME
                        </div>
                        <p className="text-xs terminal-text text-robotic-yellow/60 leading-relaxed">
                          {rc.outcome}
                        </p>
                      </div>
                    )}
                  </div>
                ))
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
  { color: '#d97706', label: 'Medical Triage' },
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

const HAZARD_SVG_KEYS: Record<string, string> = {
  fire: 'fire',
  structural_collapse: 'collapse',
  gas_leak: 'gas',
  chemical: 'chemical',
  chemical_spill: 'chemical',
  smoke: 'smoke',
  debris: 'debris',
  electrical: 'electrical',
  flooding: 'flood',
  flood: 'flood',
  explosion: 'explosion',
  biological: 'biohazard',
  biohazard: 'biohazard',
  suspicious_package: 'hazard_generic',
  secondary_explosion: 'explosion',
};

const HAZARD_COLORS: Record<string, string> = {
  fire: '#f97316',
  structural_collapse: '#a8a29e',
  gas_leak: '#eab308',
  chemical: '#84cc16',
  chemical_spill: '#84cc16',
  smoke: '#9ca3af',
  debris: '#78716c',
  electrical: '#f59e0b',
  flooding: '#0284c7',
  flood: '#0284c7',
  explosion: '#ef4444',
  biological: '#65a30d',
  biohazard: '#65a30d',
  suspicious_package: '#d946ef',
  secondary_explosion: '#dc2626',
};

const TRIAGE_COLORS: Record<string, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  black: '#1f2937',
};

const createSvgDivIcon = (color: string, svgHtml: string, size = 28): DivIcon =>
  new DivIcon({
    className: 'custom-pin-icon',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid rgba(255,255,255,0.6);box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;line-height:1;cursor:grab">${svgHtml}</div>`,
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

type AddPinMode =
  | 'entry_exit'
  | 'hazard'
  | 'casualty'
  | 'crowd'
  | 'poi'
  | 'incident_site'
  | 'sighting_area'
  | null;

const ADD_PIN_OPTIONS: { mode: NonNullable<AddPinMode>; label: string; color: string }[] = [
  {
    mode: 'entry_exit',
    label: 'Entry / Exit',
    color: 'bg-emerald-700 hover:bg-emerald-600 border-emerald-500',
  },
  { mode: 'hazard', label: 'Hazard', color: 'bg-red-800 hover:bg-red-700 border-red-600' },
  { mode: 'casualty', label: 'Patient', color: 'bg-amber-800 hover:bg-amber-700 border-amber-600' },
  { mode: 'crowd', label: 'Crowd', color: 'bg-violet-800 hover:bg-violet-700 border-violet-600' },
  { mode: 'poi', label: 'POI', color: 'bg-cyan-800 hover:bg-cyan-700 border-cyan-600' },
  {
    mode: 'incident_site',
    label: 'Incident Site',
    color: 'bg-orange-800 hover:bg-orange-700 border-orange-600',
  },
  {
    mode: 'sighting_area',
    label: 'Sighting',
    color: 'bg-pink-800 hover:bg-pink-700 border-pink-600',
  },
];

const MapClickHandler = ({ onClick }: { onClick: (lat: number, lng: number) => void }) => {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

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
  const [retryDetLoading, setRetryDetLoading] = useState(false);
  const [retryDetMsg, setRetryDetMsg] = useState<string | null>(null);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [studRefreshKey, setStudRefreshKey] = useState(0);
  const [activeFloor, setActiveFloor] = useState('G');

  // Add-pin mode state
  const [addPinMode, setAddPinMode] = useState<AddPinMode>(null);
  const [pendingPin, setPendingPin] = useState<{ lat: number; lng: number } | null>(null);
  const [addPinForm, setAddPinForm] = useState<Record<string, string>>({});
  const [addingPin, setAddingPin] = useState(false);
  const [deletingPin, setDeletingPin] = useState<string | null>(null);
  const changesRef = useRef<{
    locations: Map<string, { lat: number; lng: number; conditions?: Record<string, unknown> }>;
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

  const haversineM = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const EXPLOSION_HAZARD_RE = /explosion|bomb|blast|detonat|ied/i;

  const onHazardDrag = useCallback((id: string, lat: number, lng: number) => {
    changesRef.current.hazards.set(id, { lat, lng });

    let oldLat = 0;
    let oldLng = 0;
    let isExplosion = false;

    setHazards((prev) =>
      prev.map((h) => {
        if (h.id !== id) return h;
        oldLat = h.location_lat;
        oldLng = h.location_lng;
        isExplosion = EXPLOSION_HAZARD_RE.test(h.hazard_type);
        const updatedZones = (h.zones ?? []).map((z) => ({
          ...z,
          polygon: generateCirclePolygon(lat, lng, z.radius_m),
        }));
        return { ...h, location_lat: lat, location_lng: lng, zones: updatedZones };
      }),
    );

    // For explosion hazards: move linked blast zone circles and nearby casualties
    if (isExplosion && (oldLat !== 0 || oldLng !== 0)) {
      const deltaLat = lat - oldLat;
      const deltaLng = lng - oldLng;

      // Find the max blast radius from linked blast zones (for casualty following)
      let maxBlastRadius = 200;

      // Move blast zone location circles linked to this hazard
      setLocations((prev) => {
        // First pass: find max radius from linked zones
        for (const loc of prev) {
          const conds = (loc.conditions ?? {}) as Record<string, unknown>;
          if (conds.linked_hazard_id !== id) continue;
          const r = Number(conds.radius_m) || 0;
          if (r > maxBlastRadius) maxBlastRadius = r;
        }

        return prev.map((loc) => {
          const conds = (loc.conditions ?? {}) as Record<string, unknown>;
          if (conds.linked_hazard_id !== id) return loc;
          const newLocLat = loc.coordinates.lat + deltaLat;
          const newLocLng = loc.coordinates.lng + deltaLng;
          const radiusM = Number(conds.radius_m) || 100;
          const newPolygon = generateCirclePolygon(newLocLat, newLocLng, radiusM);
          const updatedConditions = { ...conds, polygon: newPolygon };
          changesRef.current.locations.set(loc.id, {
            lat: newLocLat,
            lng: newLocLng,
            conditions: updatedConditions,
          });
          return {
            ...loc,
            coordinates: { lat: newLocLat, lng: newLocLng },
            conditions: updatedConditions,
          };
        });
      });

      // Move casualties within the blast radius
      setCasualties((prev) =>
        prev.map((c) => {
          const dist = haversineM(oldLat, oldLng, c.location_lat, c.location_lng);
          if (dist > maxBlastRadius) return c;
          const newCLat = c.location_lat + deltaLat;
          const newCLng = c.location_lng + deltaLng;
          changesRef.current.casualties.set(c.id, { lat: newCLat, lng: newCLng });
          return { ...c, location_lat: newCLat, location_lng: newCLng };
        }),
      );
    }

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

  const onZoneLocationDrag = useCallback((id: string, lat: number, lng: number) => {
    setLocations((prev) => {
      const loc = prev.find((l) => l.id === id);
      if (!loc) return prev;
      const conds = (loc.conditions ?? {}) as Record<string, unknown>;
      const radiusM = Number(conds.radius_m) || 100;
      const newPolygon = generateCirclePolygon(lat, lng, radiusM);
      const updatedConditions = { ...conds, polygon: newPolygon };
      changesRef.current.locations.set(id, { lat, lng, conditions: updatedConditions });
      return prev.map((l) =>
        l.id === id ? { ...l, coordinates: { lat, lng }, conditions: updatedConditions } : l,
      );
    });
    setDirty(true);
  }, []);

  const onZoneLocationRadiusChange = useCallback((id: string, newRadius: number) => {
    setLocations((prev) => {
      return prev.map((loc) => {
        if (loc.id !== id) return loc;
        const conds = (loc.conditions ?? {}) as Record<string, unknown>;
        const newPolygon = generateCirclePolygon(
          loc.coordinates.lat,
          loc.coordinates.lng,
          newRadius,
        );
        const updatedConditions = { ...conds, radius_m: newRadius, polygon: newPolygon };
        changesRef.current.locations.set(id, {
          lat: loc.coordinates.lat,
          lng: loc.coordinates.lng,
          conditions: updatedConditions,
        });
        return { ...loc, conditions: updatedConditions };
      });
    });
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!hasChanges()) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const c = changesRef.current;
      const payload: {
        locations?: Array<{
          id: string;
          lat: number;
          lng: number;
          conditions?: Record<string, unknown>;
        }>;
        hazards?: Array<{ id: string; lat: number; lng: number }>;
        casualties?: Array<{ id: string; lat: number; lng: number }>;
        zones?: Array<{ hazard_id: string; zone_type: string; radius_m: number }>;
      } = {};
      if (c.locations.size) {
        payload.locations = [...c.locations.entries()].map(([id, p]) => {
          if (p.conditions) {
            return { id, lat: p.lat, lng: p.lng, conditions: p.conditions };
          }
          return { id, lat: p.lat, lng: p.lng };
        });
      }
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

  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      if (!addPinMode) return;
      setPendingPin({ lat, lng });
      setAddPinForm({});
    },
    [addPinMode],
  );

  const handleAddPinSubmit = useCallback(async () => {
    if (!pendingPin || !addPinMode) return;
    setAddingPin(true);
    try {
      const { lat, lng } = pendingPin;
      const f = addPinForm;

      if (addPinMode === 'entry_exit') {
        const res = await api.scenarios.createPin(scenarioId, 'location', {
          label: f.label || 'Entry / Exit',
          location_type: 'entry_exit',
          lat,
          lng,
          pin_category: 'entry_exit',
          conditions: { entry_exit: true },
        });
        if (res.pin) {
          const p = res.pin;
          setLocations((prev) => [
            ...prev,
            {
              id: p.id as string,
              location_type: (p.location_type as string) || 'entry_exit',
              pin_category: (p.pin_category as string) || undefined,
              label: (p.label as string) || '',
              coordinates: (p.coordinates as { lat: number; lng: number }) || { lat, lng },
              conditions: (p.conditions as Record<string, unknown>) || {},
              display_order: 999,
            },
          ]);
        }
      } else if (addPinMode === 'hazard') {
        const res = await api.scenarios.createPin(scenarioId, 'hazard', {
          hazard_type: f.hazard_type || 'fire',
          label: f.label || 'Hazard',
          lat,
          lng,
          properties: { severity: f.severity || 'medium', description: f.label || '' },
        });
        if (res.pin) {
          const p = res.pin;
          setHazards((prev) => [
            ...prev,
            {
              id: p.id as string,
              hazard_type: (p.hazard_type as string) || 'unknown',
              location_lat: Number(p.location_lat) || lat,
              location_lng: Number(p.location_lng) || lng,
              floor_level: (p.floor_level as string) || 'G',
              properties: (p.properties as Record<string, unknown>) || {},
              status: 'active',
              enriched_description: (p.enriched_description as string) || '',
              appears_at_minutes: 0,
              zones: (p.zones as HazardPin['zones']) || [],
            },
          ]);
        }
      } else if (addPinMode === 'casualty') {
        const res = await api.scenarios.createPin(scenarioId, 'casualty', {
          casualty_type: 'patient',
          lat,
          lng,
          headcount: 1,
          conditions: {
            triage_color: f.triage_color || 'yellow',
            injury_description: f.injury || 'Unspecified injury',
            injury_type: f.injury_type || 'unknown',
          },
        });
        if (res.pin) {
          const p = res.pin;
          setCasualties((prev) => [
            ...prev,
            {
              id: p.id as string,
              casualty_type: 'patient',
              location_lat: Number(p.location_lat) || lat,
              location_lng: Number(p.location_lng) || lng,
              floor_level: (p.floor_level as string) || 'G',
              headcount: Number(p.headcount) || 1,
              conditions: (p.conditions as Record<string, unknown>) || {},
              status: 'undiscovered',
              appears_at_minutes: 0,
            },
          ]);
        }
      } else if (addPinMode === 'crowd') {
        const hc = parseInt(f.headcount || '20', 10) || 20;
        const res = await api.scenarios.createPin(scenarioId, 'casualty', {
          casualty_type: f.crowd_type || 'crowd',
          lat,
          lng,
          headcount: hc,
          conditions: {
            behavior: f.behavior || 'calm',
            description: f.description || `Group of ~${hc} people`,
          },
        });
        if (res.pin) {
          const p = res.pin;
          setCasualties((prev) => [
            ...prev,
            {
              id: p.id as string,
              casualty_type: (p.casualty_type as string) || 'crowd',
              location_lat: Number(p.location_lat) || lat,
              location_lng: Number(p.location_lng) || lng,
              floor_level: (p.floor_level as string) || 'G',
              headcount: Number(p.headcount) || hc,
              conditions: (p.conditions as Record<string, unknown>) || {},
              status: 'undiscovered',
              appears_at_minutes: 0,
            },
          ]);
        }
      } else if (
        addPinMode === 'poi' ||
        addPinMode === 'incident_site' ||
        addPinMode === 'sighting_area'
      ) {
        const locType =
          addPinMode === 'incident_site'
            ? 'incident_site'
            : addPinMode === 'sighting_area'
              ? 'sighting_area'
              : 'poi';
        const pinCat = addPinMode === 'sighting_area' ? 'adversary_sighting' : undefined;
        const res = await api.scenarios.createPin(scenarioId, 'location', {
          label:
            f.label ||
            (addPinMode === 'incident_site'
              ? 'Incident Site'
              : addPinMode === 'sighting_area'
                ? 'Sighting Area'
                : 'Point of Interest'),
          location_type: locType,
          lat,
          lng,
          pin_category: pinCat,
        });
        if (res.pin) {
          const p = res.pin;
          setLocations((prev) => [
            ...prev,
            {
              id: p.id as string,
              location_type: (p.location_type as string) || locType,
              pin_category: (p.pin_category as string) || undefined,
              label: (p.label as string) || '',
              coordinates: (p.coordinates as { lat: number; lng: number }) || { lat, lng },
              conditions: (p.conditions as Record<string, unknown>) || {},
              display_order: 999,
            },
          ]);
        }
      }

      setPendingPin(null);
      setAddPinMode(null);
      setAddPinForm({});
    } catch (err) {
      console.error('Failed to create pin:', err);
    } finally {
      setAddingPin(false);
    }
  }, [scenarioId, addPinMode, pendingPin, addPinForm]);

  const handleDeletePin = useCallback(
    async (pinId: string, pinType: 'location' | 'hazard' | 'casualty') => {
      if (!confirm('Delete this pin? This cannot be undone.')) return;
      setDeletingPin(pinId);
      try {
        await api.scenarios.deletePin(scenarioId, pinId, pinType);
        if (pinType === 'location') {
          setLocations((prev) => prev.filter((l) => l.id !== pinId));
        } else if (pinType === 'hazard') {
          setHazards((prev) => prev.filter((h) => h.id !== pinId));
          // Also remove linked blast zone locations
          setLocations((prev) =>
            prev.filter((l) => {
              const linked = l.conditions?.linked_hazard_id;
              return linked !== pinId;
            }),
          );
        } else {
          setCasualties((prev) => prev.filter((c) => c.id !== pinId));
        }
      } catch (err) {
        console.error('Failed to delete pin:', err);
      } finally {
        setDeletingPin(null);
      }
    },
    [scenarioId],
  );

  const totalPins = locations.length + hazards.length + casualties.length;
  if (totalPins === 0 && equipment.length === 0) {
    return <p className="text-sm terminal-text text-robotic-yellow/50">[NO MAP DATA]</p>;
  }

  // Separate zone locations and blast zone locations from regular pins
  const zoneLocations = locations.filter(
    (loc) => loc.location_type === 'incident_zone' || loc.pin_category === 'incident_zone',
  );
  const blastZoneLocations = locations.filter(
    (loc) => loc.pin_category === 'blast_zone' || loc.location_type === 'blast_radius',
  );
  const nonZoneLocations = locations.filter(
    (loc) =>
      loc.location_type !== 'incident_zone' &&
      loc.pin_category !== 'incident_zone' &&
      loc.pin_category !== 'blast_zone' &&
      loc.location_type !== 'blast_radius',
  );

  const validPins: ScenarioLocationPin[] = nonZoneLocations
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
  const crowds = casualties.filter(
    (c) =>
      c.casualty_type === 'crowd' ||
      c.casualty_type === 'evacuee_group' ||
      c.casualty_type === 'convergent_crowd',
  );

  const hasAnySpawnPins =
    hazards.some((h) => (h as unknown as { spawn_condition?: unknown }).spawn_condition) ||
    casualties.some((c) => (c as unknown as { spawn_condition?: unknown }).spawn_condition);
  const hasAnyHazardDeterioration = hazards.some((h) => {
    const dt = (h as unknown as { deterioration_timeline?: Record<string, unknown> })
      .deterioration_timeline;
    return dt && Object.keys(dt).length > 0;
  });
  const hasAnyCasualtyDeterioration = casualties.some((c) => {
    const conds = (c.conditions ?? {}) as Record<string, unknown>;
    return Array.isArray(conds.deterioration_timeline) && conds.deterioration_timeline.length > 0;
  });
  const deteriorationMissing =
    (hazards.length > 0 || casualties.length > 0) &&
    !hasAnySpawnPins &&
    !hasAnyHazardDeterioration &&
    !hasAnyCasualtyDeterioration;

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

      {(deteriorationMissing || hazards.length > 0 || casualties.length > 0) && (
        <div className="flex items-center gap-3 p-2 military-border bg-robotic-yellow/5">
          <div className="text-xs terminal-text text-robotic-yellow/70">
            {deteriorationMissing
              ? 'Deterioration data is missing (no timelines/spawn pins). You can generate it from the current map pins.'
              : 'Regenerate deterioration timelines/spawn pins after adding/removing map pins.'}
          </div>
          <button
            onClick={async () => {
              setRetryDetLoading(true);
              setRetryDetMsg(null);
              try {
                const res = await api.scenarios.retryDeterioration(scenarioId, {
                  force: !deteriorationMissing,
                });
                const msg =
                  res.message ||
                  (res.ok
                    ? `Updated hazards: ${res.hazards_updated ?? 0}, casualties: ${res.casualties_updated ?? 0}, spawn pins: ${(res.spawn_hazards_inserted ?? 0) + (res.spawn_casualties_inserted ?? 0)}`
                    : res.error) ||
                  'Retry complete';
                setRetryDetMsg(msg);

                const [locRes, hazRes, casRes] = await Promise.all([
                  api.scenarios.getScenarioLocations(scenarioId),
                  api.scenarios.getScenarioHazards(scenarioId).catch(() => ({ data: [] })),
                  api.scenarios.getScenarioCasualties(scenarioId).catch(() => ({ data: [] })),
                ]);
                setLocations((locRes.data ?? []) as LocationPin[]);
                setHazards((hazRes.data ?? []) as HazardPin[]);
                setCasualties((casRes.data ?? []) as CasualtyPin[]);
              } catch (err) {
                setRetryDetMsg(
                  err instanceof Error ? err.message : 'Failed to retry deterioration',
                );
              } finally {
                setRetryDetLoading(false);
              }
            }}
            disabled={retryDetLoading}
            className="ml-auto px-4 py-1.5 text-xs terminal-text bg-blue-700 hover:bg-blue-600 text-white rounded border border-blue-500 disabled:opacity-50"
          >
            {retryDetLoading
              ? 'GENERATING...'
              : deteriorationMissing
                ? 'GENERATE DETERIORATION'
                : 'REGENERATE DETERIORATION'}
          </button>
        </div>
      )}
      {retryDetMsg && <div className="text-xs terminal-text text-green-400 p-1">{retryDetMsg}</div>}

      {/* Backfill buildings toolbar */}
      <div className="flex items-center gap-3 p-2 military-border bg-cyan-900/10">
        <div className="text-xs terminal-text text-robotic-yellow/70">
          Missing building studs? Fetch buildings from OpenStreetMap.
        </div>
        <button
          onClick={async () => {
            setBackfillLoading(true);
            setBackfillMsg(null);
            try {
              const res = await api.scenarios.backfillBuildings(scenarioId);
              setBackfillMsg(
                res.status === 'backfilled'
                  ? `Loaded ${res.buildingCount} buildings + ${res.routeCount} roads`
                  : res.status === 'already_populated'
                    ? `${res.buildingCount} buildings + ${res.routeCount} roads already loaded`
                    : res.message,
              );
              setStudRefreshKey((k) => k + 1);
            } catch (err) {
              setBackfillMsg(err instanceof Error ? err.message : 'Backfill failed');
            } finally {
              setBackfillLoading(false);
            }
          }}
          disabled={backfillLoading}
          className="ml-auto px-4 py-1.5 text-xs terminal-text bg-cyan-700 hover:bg-cyan-600 text-white rounded border border-cyan-500 disabled:opacity-50"
        >
          {backfillLoading ? 'LOADING...' : 'BACKFILL BUILDINGS'}
        </button>
      </div>
      {backfillMsg && <div className="text-xs terminal-text text-green-400 p-1">{backfillMsg}</div>}

      {/* Add Pin toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-2 military-border bg-black/30">
        <span className="text-xs terminal-text text-robotic-yellow/60 mr-1">ADD PIN:</span>
        {ADD_PIN_OPTIONS.map((opt) => (
          <button
            key={opt.mode}
            onClick={() => {
              setAddPinMode(addPinMode === opt.mode ? null : opt.mode);
              setPendingPin(null);
              setAddPinForm({});
            }}
            className={`px-2.5 py-1 text-[10px] terminal-text rounded border transition-all ${
              addPinMode === opt.mode
                ? `${opt.color} text-white ring-1 ring-white/40`
                : 'bg-gray-800 hover:bg-gray-700 border-gray-600 text-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
        {addPinMode && (
          <button
            onClick={() => {
              setAddPinMode(null);
              setPendingPin(null);
              setAddPinForm({});
            }}
            className="px-2 py-1 text-[10px] terminal-text bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-400 rounded ml-auto"
          >
            CANCEL
          </button>
        )}
      </div>
      {addPinMode && !pendingPin && (
        <div className="text-xs terminal-text text-robotic-yellow animate-pulse p-1.5 bg-robotic-yellow/5 military-border">
          Click on the map to place a{' '}
          {ADD_PIN_OPTIONS.find((o) => o.mode === addPinMode)?.label || 'pin'}
        </div>
      )}

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
          {/* Map click handler for add-pin mode */}
          {addPinMode && <MapClickHandler onClick={handleMapClick} />}

          {/* Pending pin marker with form popup */}
          {pendingPin && addPinMode && (
            <Marker
              position={[pendingPin.lat, pendingPin.lng]}
              icon={
                new DivIcon({
                  className: '',
                  html: '<div style="width:20px;height:20px;background:rgba(255,220,0,0.9);border:2px solid #fff;border-radius:50%;box-shadow:0 0 8px rgba(255,220,0,0.6);"></div>',
                  iconSize: [20, 20],
                  iconAnchor: [10, 10],
                })
              }
            >
              <Popup autoPan={true} closeOnClick={false} minWidth={240} maxWidth={300}>
                <div className="space-y-2" style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#222', marginBottom: 6 }}>
                    New {ADD_PIN_OPTIONS.find((o) => o.mode === addPinMode)?.label || 'Pin'}
                  </div>

                  {/* Entry/Exit form */}
                  {addPinMode === 'entry_exit' && (
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                        Label
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Main Gate, Exit B"
                        value={addPinForm.label || ''}
                        onChange={(e) => setAddPinForm((f) => ({ ...f, label: e.target.value }))}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          fontSize: 12,
                          border: '1px solid #ccc',
                          borderRadius: 3,
                        }}
                      />
                    </div>
                  )}

                  {/* Hazard form */}
                  {addPinMode === 'hazard' && (
                    <>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Type
                        </label>
                        <select
                          value={addPinForm.hazard_type || 'fire'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, hazard_type: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="fire">Fire</option>
                          <option value="chemical_spill">Chemical Spill</option>
                          <option value="structural_collapse">Structural Collapse</option>
                          <option value="gas_leak">Gas Leak</option>
                          <option value="explosion">Explosion / Bomb</option>
                          <option value="flooding">Flooding</option>
                          <option value="electrical">Electrical Hazard</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Description (optional — AI generates full profile)
                        </label>
                        <textarea
                          placeholder="e.g. Vehicle fire near entrance with fuel leaking — leave blank for auto-generated details"
                          value={addPinForm.label || ''}
                          onChange={(e) => setAddPinForm((f) => ({ ...f, label: e.target.value }))}
                          rows={2}
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                            resize: 'vertical',
                          }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Severity
                        </label>
                        <select
                          value={addPinForm.severity || 'medium'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, severity: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                      </div>
                    </>
                  )}

                  {/* Casualty (patient) form */}
                  {addPinMode === 'casualty' && (
                    <>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Triage Color
                        </label>
                        <select
                          value={addPinForm.triage_color || 'yellow'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, triage_color: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="green">GREEN (minor)</option>
                          <option value="yellow">YELLOW (delayed)</option>
                          <option value="red">RED (immediate)</option>
                          <option value="black">BLACK (deceased)</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Injury Type
                        </label>
                        <select
                          value={addPinForm.injury_type || 'blunt_trauma'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, injury_type: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="blunt_trauma">Blunt Trauma</option>
                          <option value="gunshot">Gunshot Wound</option>
                          <option value="laceration">Laceration</option>
                          <option value="burn">Burn</option>
                          <option value="fracture">Fracture</option>
                          <option value="crush_injury">Crush Injury</option>
                          <option value="smoke_inhalation">Smoke Inhalation</option>
                          <option value="chemical_exposure">Chemical Exposure</option>
                          <option value="blast_injury">Blast Injury</option>
                          <option value="psychological">Psychological Trauma</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Description (optional — AI generates full profile)
                        </label>
                        <textarea
                          placeholder="e.g. Severe burn on face with blistering, shrapnel in arms — leave blank for auto-generated profile"
                          value={addPinForm.injury || ''}
                          onChange={(e) => setAddPinForm((f) => ({ ...f, injury: e.target.value }))}
                          rows={2}
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                            resize: 'vertical',
                          }}
                        />
                      </div>
                    </>
                  )}

                  {/* Crowd form */}
                  {addPinMode === 'crowd' && (
                    <>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Crowd Type
                        </label>
                        <select
                          value={addPinForm.crowd_type || 'crowd'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, crowd_type: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="crowd">Crowd</option>
                          <option value="evacuee_group">Evacuee Group</option>
                          <option value="convergent_crowd">Convergent Crowd</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Headcount
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={5000}
                          value={addPinForm.headcount || '20'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, headcount: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        />
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Behavior
                        </label>
                        <select
                          value={addPinForm.behavior || 'calm'}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, behavior: e.target.value }))
                          }
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                          }}
                        >
                          <option value="calm">Calm</option>
                          <option value="anxious">Anxious</option>
                          <option value="panicking">Panicking</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                          Description (optional — AI generates full profile)
                        </label>
                        <textarea
                          placeholder="e.g. Families with children sheltering near exit, some elderly — leave blank for auto-generated profile"
                          value={addPinForm.description || ''}
                          onChange={(e) =>
                            setAddPinForm((f) => ({ ...f, description: e.target.value }))
                          }
                          rows={2}
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            fontSize: 12,
                            border: '1px solid #ccc',
                            borderRadius: 3,
                            resize: 'vertical',
                          }}
                        />
                      </div>
                    </>
                  )}

                  {/* POI / Incident Site / Sighting form */}
                  {(addPinMode === 'poi' ||
                    addPinMode === 'incident_site' ||
                    addPinMode === 'sighting_area') && (
                    <div>
                      <label style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                        Label
                      </label>
                      <input
                        type="text"
                        placeholder={
                          addPinMode === 'incident_site'
                            ? 'e.g. Bomb Detonation Site'
                            : addPinMode === 'sighting_area'
                              ? 'e.g. Suspect last seen here'
                              : 'e.g. Main Lobby'
                        }
                        value={addPinForm.label || ''}
                        onChange={(e) => setAddPinForm((f) => ({ ...f, label: e.target.value }))}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          fontSize: 12,
                          border: '1px solid #ccc',
                          borderRadius: 3,
                        }}
                      />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      onClick={handleAddPinSubmit}
                      disabled={addingPin}
                      style={{
                        flex: 1,
                        padding: '5px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        background: addingPin ? '#555' : '#16a34a',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 3,
                        cursor: addingPin ? 'wait' : 'pointer',
                      }}
                    >
                      {addingPin ? 'GENERATING PROFILE...' : 'ADD PIN'}
                    </button>
                    <button
                      onClick={() => {
                        setPendingPin(null);
                        setAddPinForm({});
                      }}
                      style={{
                        padding: '5px 10px',
                        fontSize: 11,
                        background: '#374151',
                        color: '#d1d5db',
                        border: '1px solid #4b5563',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Popup>
            </Marker>
          )}

          {/* Floor plan overlay for active floor */}
          {floorPlans
            .filter((f) => f.floor_level === activeFloor)
            .map((floor) => (
              <FloorPlanOverlay key={floor.id} floor={floor} />
            ))}
          {/* Independent zone locations — draggable center + editable radius */}
          {zoneLocations.length > 0
            ? [...zoneLocations]
                .sort((a, b) => {
                  const rA = Number((a.conditions as Record<string, unknown>)?.radius_m) || 0;
                  const rB = Number((b.conditions as Record<string, unknown>)?.radius_m) || 0;
                  return rB - rA;
                })
                .map((zl) => {
                  const conds = (zl.conditions ?? {}) as Record<string, unknown>;
                  const zoneType = (conds.zone_type as string) || 'unknown';
                  const radiusM = Number(conds.radius_m) || 100;
                  const polygon = conds.polygon as number[][] | undefined;
                  if (!polygon || polygon.length < 3) return null;
                  const ZONE_COLORS: Record<string, { color: string; fillColor: string }> = {
                    hot: { color: '#dc2626', fillColor: '#dc262640' },
                    warm: { color: '#f59e0b', fillColor: '#f59e0b30' },
                    cold: { color: '#3b82f6', fillColor: '#3b82f620' },
                  };
                  const style = ZONE_COLORS[zoneType] ?? {
                    color: '#6b7280',
                    fillColor: '#6b728020',
                  };
                  const positions = polygon.map((p) => [p[0], p[1]] as [number, number]);
                  return (
                    <span key={`zl-${zl.id}`}>
                      <Polygon
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
                          {zoneType.toUpperCase()} zone ({radiusM}m) — drag center marker to move
                        </Tooltip>
                        <Popup>
                          <div
                            style={{
                              minWidth: 160,
                              background: '#fff',
                              color: '#222',
                              padding: 8,
                              borderRadius: 4,
                            }}
                          >
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
                              {zoneType} zone
                            </div>
                            <label
                              style={{
                                fontSize: 11,
                                display: 'block',
                                marginBottom: 2,
                                color: '#555',
                              }}
                            >
                              Radius (meters)
                            </label>
                            <input
                              type="number"
                              min={10}
                              max={5000}
                              step={5}
                              defaultValue={radiusM}
                              onBlur={(e) => {
                                const val = parseInt(e.target.value, 10);
                                if (!isNaN(val) && val >= 10 && val !== radiusM) {
                                  onZoneLocationRadiusChange(zl.id, val);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              }}
                              style={{
                                width: '100%',
                                padding: '4px 6px',
                                fontSize: 13,
                                border: `1px solid ${style.color}`,
                                borderRadius: 4,
                                outline: 'none',
                                background: '#f9f9f9',
                                color: '#222',
                              }}
                            />
                            {(conds.ppe_required as string[] | undefined)?.length ? (
                              <div style={{ marginTop: 6, fontSize: 10, color: '#666' }}>
                                PPE: {(conds.ppe_required as string[]).join(', ')}
                              </div>
                            ) : null}
                            {(conds.allowed_teams as string[] | undefined)?.length ? (
                              <div style={{ fontSize: 10, color: '#666' }}>
                                Teams: {(conds.allowed_teams as string[]).join(', ')}
                              </div>
                            ) : null}
                          </div>
                        </Popup>
                      </Polygon>
                      <Marker
                        position={[zl.coordinates.lat, zl.coordinates.lng]}
                        draggable
                        icon={
                          new DivIcon({
                            className: '',
                            html: `<div style="width:18px;height:18px;border-radius:50%;border:3px solid ${style.color};background:${style.fillColor};cursor:grab" title="Drag to move ${zoneType} zone"></div>`,
                            iconSize: [18, 18],
                            iconAnchor: [9, 9],
                          })
                        }
                        eventHandlers={{
                          dragend: (e) => {
                            const latlng = e.target.getLatLng();
                            onZoneLocationDrag(zl.id, latlng.lat, latlng.lng);
                          },
                        }}
                      >
                        <Tooltip direction="top" offset={[0, -12]}>
                          Drag to move {zoneType.toUpperCase()} zone
                        </Tooltip>
                      </Marker>
                    </span>
                  );
                })
            : /* Legacy: hazard-based zone polygons */
              hazards
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
                            <div
                              style={{
                                minWidth: 160,
                                background: '#fff',
                                color: '#222',
                                padding: 8,
                                borderRadius: 4,
                              }}
                            >
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
                                  color: '#555',
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
                                  if (!isNaN(val) && val >= 10 && val !== zone.radius_m)
                                    onZoneRadiusChange(hazard.id, zone.zone_type, val);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                }}
                                style={{
                                  width: '100%',
                                  padding: '4px 6px',
                                  fontSize: 13,
                                  border: `1px solid ${style.color}`,
                                  borderRadius: 4,
                                  outline: 'none',
                                  background: '#f9f9f9',
                                  color: '#222',
                                }}
                              />
                              {zone.ppe_required?.length ? (
                                <div style={{ marginTop: 6, fontSize: 10, color: '#666' }}>
                                  PPE: {zone.ppe_required.join(', ')}
                                </div>
                              ) : null}
                              {zone.allowed_teams?.length ? (
                                <div style={{ fontSize: 10, color: '#666' }}>
                                  Teams: {zone.allowed_teams.join(', ')}
                                </div>
                              ) : null}
                            </div>
                          </Popup>
                        </Polygon>
                      );
                    }),
                )}
          {/* Blast radius guide circles */}
          {[...blastZoneLocations]
            .sort((a, b) => {
              const rA = Number((a.conditions as Record<string, unknown>)?.radius_m) || 0;
              const rB = Number((b.conditions as Record<string, unknown>)?.radius_m) || 0;
              return rB - rA;
            })
            .map((bz) => {
              const conds = (bz.conditions ?? {}) as Record<string, unknown>;
              const blastType = (conds.zone_type as string) || '';
              const radiusM = Number(conds.radius_m) || 100;
              const polygon = conds.polygon as number[][] | undefined;
              if (!polygon || polygon.length < 3) return null;

              const BLAST_COLORS: Record<
                string,
                { color: string; fillColor: string; opacity: number }
              > = {
                blast_lethal: { color: '#991b1b', fillColor: '#dc2626', opacity: 0.25 },
                blast_severe: { color: '#c2410c', fillColor: '#ea580c', opacity: 0.18 },
                blast_fragment: { color: '#ca8a04', fillColor: '#eab308', opacity: 0.12 },
              };
              const style = BLAST_COLORS[blastType] ?? {
                color: '#6b7280',
                fillColor: '#6b7280',
                opacity: 0.15,
              };
              const positions = polygon.map((p) => [p[0], p[1]] as [number, number]);

              const BLAST_LABELS: Record<string, string> = {
                blast_lethal: 'Lethal Zone',
                blast_severe: 'Severe Injury Zone',
                blast_fragment: 'Fragment Zone',
              };

              return (
                <Polygon
                  key={`blast-${bz.id}`}
                  positions={positions}
                  pathOptions={{
                    color: style.color,
                    fillColor: style.fillColor,
                    fillOpacity: style.opacity,
                    weight: 2,
                    dashArray: '4 6',
                  }}
                >
                  <Tooltip direction="center" permanent={false}>
                    {bz.label} ({Math.round(radiusM * 3.28084)} ft)
                  </Tooltip>
                  <Popup>
                    <div style={{ minWidth: 160, padding: 4 }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 12,
                          marginBottom: 6,
                          color: style.color,
                        }}
                      >
                        {BLAST_LABELS[blastType] || blastType.replace(/_/g, ' ')}
                      </div>
                      <label
                        style={{
                          fontSize: 11,
                          display: 'block',
                          marginBottom: 2,
                          color: '#555',
                        }}
                      >
                        Radius (meters)
                      </label>
                      <input
                        type="number"
                        min={5}
                        max={500}
                        step={5}
                        defaultValue={radiusM}
                        onBlur={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val) && val >= 5 && val !== radiusM)
                            onZoneLocationRadiusChange(bz.id, val);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        style={{
                          width: '100%',
                          padding: '4px 6px',
                          fontSize: 13,
                          border: `1px solid ${style.color}`,
                          borderRadius: 4,
                          outline: 'none',
                          background: '#f9f9f9',
                          color: '#222',
                        }}
                      />
                      <div style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
                        {Math.round(radiusM * 3.28084)} ft
                      </div>
                    </div>
                  </Popup>
                </Polygon>
              );
            })}
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
                icon={createSvgDivIcon(
                  HAZARD_COLORS[h.hazard_type] ?? '#ef4444',
                  svg(HAZARD_SVG_KEYS[h.hazard_type] ?? 'hazard_generic', 16),
                  30,
                )}
                draggable
                eventHandlers={{
                  dragend: (e) => {
                    const ll = e.target.getLatLng();
                    onHazardDrag(h.id, ll.lat, ll.lng);
                  },
                }}
              >
                <Tooltip direction="top">{h.hazard_type.replace(/_/g, ' ')}</Tooltip>
              </Marker>
            ))}
          {patients
            .filter((c) => c.floor_level === activeFloor || !floorPlans.length)
            .map((c) => {
              const triageColor =
                TRIAGE_COLORS[(c.conditions.triage_color as string) ?? 'yellow'] ?? '#eab308';
              const mobilitySvgKey =
                c.conditions.mobility === 'trapped'
                  ? 'person_trapped'
                  : c.conditions.mobility === 'non_ambulatory'
                    ? 'stretcher'
                    : 'person';
              return (
                <Marker
                  key={`cas-${c.id}`}
                  position={[c.location_lat, c.location_lng]}
                  icon={createSvgDivIcon(triageColor, svg(mobilitySvgKey, 14), 24)}
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
                icon={createSvgDivIcon(
                  '#8b5cf6',
                  svg('crowd', 16),
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
                  {c.headcount} people — {(c.conditions.behavior as string) ?? 'unknown'}
                </Tooltip>
              </Marker>
            ))}

          {/* Building Stud Overlay — snap-point grid inside buildings */}
          <BuildingStudOverlay
            scenarioId={scenarioId}
            floor={activeFloor}
            refreshKey={studRefreshKey}
          />
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
                      <div className="flex items-center gap-2">
                        <div className="text-sm terminal-text text-robotic-yellow font-medium flex-1">
                          {loc.label}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePin(loc.id, 'location');
                          }}
                          disabled={deletingPin === loc.id}
                          className="shrink-0 w-5 h-5 flex items-center justify-center text-red-500/60 hover:text-red-400 hover:bg-red-900/30 rounded transition-colors text-xs"
                          title="Delete pin"
                        >
                          {deletingPin === loc.id ? '...' : '✕'}
                        </button>
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
                      <div className="text-xs terminal-text text-red-400/80 uppercase flex items-center gap-1.5">
                        <span
                          dangerouslySetInnerHTML={{
                            __html: svg(HAZARD_SVG_KEYS[h.hazard_type] ?? 'hazard_generic', 14),
                          }}
                        />
                        {h.hazard_type.replace(/_/g, ' ')}
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
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          {h.enriched_description && (
                            <p className="text-xs terminal-text text-robotic-yellow/80">
                              {h.enriched_description}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePin(h.id, 'hazard');
                          }}
                          disabled={deletingPin === h.id}
                          className="shrink-0 w-5 h-5 flex items-center justify-center text-red-500/60 hover:text-red-400 hover:bg-red-900/30 rounded transition-colors text-xs"
                          title="Delete hazard"
                        >
                          {deletingPin === h.id ? '...' : '✕'}
                        </button>
                      </div>
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
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2 space-y-3">
                      {/* Ideal Response Sequence */}
                      {Array.isArray(
                        (h.resolution_requirements as Record<string, unknown>)
                          ?.ideal_response_sequence,
                      ) &&
                        (
                          (h.resolution_requirements as Record<string, unknown>)
                            .ideal_response_sequence as Array<Record<string, unknown>>
                        ).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-cyan-400/80 uppercase mb-1 font-bold">
                              Ideal Response Sequence
                            </div>
                            {(
                              (h.resolution_requirements as Record<string, unknown>)
                                .ideal_response_sequence as Array<Record<string, unknown>>
                            ).map((step, i) => (
                              <div
                                key={i}
                                className="flex gap-2 text-xs terminal-text text-robotic-yellow/70 mb-0.5"
                              >
                                <span className="text-cyan-400/60 shrink-0 w-5">
                                  {(step.step as number) ?? i + 1}.
                                </span>
                                <span className="flex-1">
                                  <b className="text-robotic-yellow/90">{String(step.action)}</b>
                                  {step.detail ? (
                                    <span className="text-robotic-yellow/50">
                                      {' '}
                                      — {String(step.detail)}
                                    </span>
                                  ) : null}
                                  {step.responsible_team ? (
                                    <span className="text-cyan-400/50 ml-1">
                                      [{String(step.responsible_team)}]
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      {/* Required PPE */}
                      {Array.isArray(
                        (h.resolution_requirements as Record<string, unknown>)?.required_ppe,
                      ) &&
                        (
                          (h.resolution_requirements as Record<string, unknown>)
                            .required_ppe as Array<Record<string, unknown>>
                        ).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-amber-400/80 uppercase mb-1 font-bold">
                              Required PPE
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(
                                (h.resolution_requirements as Record<string, unknown>)
                                  .required_ppe as Array<Record<string, unknown>>
                              ).map((ppe, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] terminal-text bg-amber-900/30 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30"
                                >
                                  {itemLabel(ppe)}
                                  {typeof ppe === 'object' &&
                                  ppe != null &&
                                  (ppe as Record<string, unknown>).mandatory
                                    ? ' *'
                                    : ''}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {/* Estimated Resolution Time */}
                      {(h.resolution_requirements as Record<string, unknown>)
                        ?.estimated_resolution_minutes != null && (
                        <div className="text-xs terminal-text text-robotic-yellow/60">
                          Est. resolution:{' '}
                          <b className="text-robotic-yellow/90">
                            {
                              (h.resolution_requirements as Record<string, unknown>)
                                .estimated_resolution_minutes as number
                            }{' '}
                            min
                          </b>
                        </div>
                      )}
                      {/* Equipment Requirements */}
                      {Array.isArray(h.equipment_requirements) &&
                        h.equipment_requirements.length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-green-400/80 uppercase mb-1 font-bold">
                              Equipment Required
                            </div>
                            <div className="grid grid-cols-1 gap-1">
                              {(h.equipment_requirements as Array<Record<string, unknown>>).map(
                                (eq, i) => (
                                  <div
                                    key={i}
                                    className="text-xs terminal-text text-robotic-yellow/60 flex gap-2"
                                  >
                                    <span className="text-green-400/60">
                                      ×{Number(eq.quantity ?? 1)}
                                    </span>
                                    <span>{String(eq.label ?? eq.equipment_type ?? '')}</span>
                                    {eq.critical ? (
                                      <span className="text-red-400/60">critical</span>
                                    ) : null}
                                    {Array.isArray(eq.applicable_teams) && (
                                      <span className="text-robotic-yellow/40">
                                        [{(eq.applicable_teams as string[]).join(', ')}]
                                      </span>
                                    )}
                                  </div>
                                ),
                              )}
                            </div>
                          </div>
                        )}
                      {/* Personnel Requirements */}
                      {h.personnel_requirements &&
                        Object.keys(h.personnel_requirements).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-purple-400/80 uppercase mb-1 font-bold">
                              Personnel
                            </div>
                            {Object.entries(h.personnel_requirements).map(([role, details]) => (
                              <div
                                key={role}
                                className="text-xs terminal-text text-robotic-yellow/60 mb-0.5"
                              >
                                <span className="text-purple-400/60">
                                  {role.replace(/_/g, ' ')}:
                                </span>{' '}
                                {typeof details === 'object' && details !== null
                                  ? Object.entries(details as Record<string, unknown>)
                                      .filter(([k]) => k !== 'role')
                                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                                      .join(', ')
                                  : String(details)}
                              </div>
                            ))}
                          </div>
                        )}
                      {/* Deterioration Timeline */}
                      {h.deterioration_timeline &&
                        Object.keys(h.deterioration_timeline).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-red-400/80 uppercase mb-1 font-bold">
                              Deterioration Timeline
                            </div>
                            {Object.entries(h.deterioration_timeline).map(([stage, info]) => (
                              <div
                                key={stage}
                                className="text-xs terminal-text text-robotic-yellow/60 mb-0.5"
                              >
                                <span className="text-red-400/60">{stage.replace(/_/g, ' ')}:</span>{' '}
                                {typeof info === 'object' && info !== null
                                  ? Object.entries(info as Record<string, unknown>)
                                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                                      .join(', ')
                                  : String(info)}
                              </div>
                            ))}
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
                      <div className="flex items-start gap-2">
                        <p className="text-xs terminal-text text-robotic-yellow/80 flex-1">
                          {(conds.visible_description as string) || 'Patient'}
                        </p>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePin(c.id, 'casualty');
                          }}
                          disabled={deletingPin === c.id}
                          className="shrink-0 w-5 h-5 flex items-center justify-center text-red-500/60 hover:text-red-400 hover:bg-red-900/30 rounded transition-colors text-xs"
                          title="Delete casualty"
                        >
                          {deletingPin === c.id ? '...' : '✕'}
                        </button>
                      </div>
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
                    <button
                      onClick={() => setExpandedPin(isExpanded ? null : `cas-${c.id}`)}
                      className="text-robotic-yellow/40 hover:text-robotic-yellow terminal-text text-xs shrink-0 self-start"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2 space-y-3">
                      {/* Injuries */}
                      {injuries.length > 0 && (
                        <div>
                          <div className="text-xs terminal-text text-red-400/80 uppercase mb-1 font-bold">
                            Injuries
                          </div>
                          <div className="space-y-0.5">
                            {injuries.map((inj, i) => (
                              <div
                                key={i}
                                className="text-xs terminal-text text-robotic-yellow/60 flex gap-2"
                              >
                                <span className="text-robotic-yellow/40">
                                  {inj.severity as string}
                                </span>
                                <span>
                                  {(inj.type as string)?.replace(/_/g, ' ')} —{' '}
                                  {inj.body_part as string}
                                </span>
                                {typeof inj.visible_signs === 'string' && (
                                  <span className="text-robotic-yellow/40">
                                    ({inj.visible_signs})
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* Treatment Requirements */}
                      {Array.isArray(conds.treatment_requirements) &&
                        (conds.treatment_requirements as unknown[]).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-green-400/80 uppercase mb-1 font-bold">
                              Treatment Requirements
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(conds.treatment_requirements as unknown[]).map((req, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] terminal-text bg-green-900/30 text-green-400 px-1.5 py-0.5 rounded border border-green-400/30"
                                >
                                  {itemLabel(req)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {/* Transport Prerequisites */}
                      {Array.isArray(conds.transport_prerequisites) &&
                        (conds.transport_prerequisites as unknown[]).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-blue-400/80 uppercase mb-1 font-bold">
                              Transport Prerequisites
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(conds.transport_prerequisites as unknown[]).map((req, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] terminal-text bg-blue-900/30 text-blue-400 px-1.5 py-0.5 rounded border border-blue-400/30"
                                >
                                  {itemLabel(req)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {/* Contraindications */}
                      {Array.isArray(conds.contraindications) &&
                        (conds.contraindications as unknown[]).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-red-400/80 uppercase mb-1 font-bold">
                              Contraindications
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(conds.contraindications as unknown[]).map((c2, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] terminal-text bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded border border-red-400/30"
                                >
                                  {itemLabel(c2)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {/* Required PPE */}
                      {Array.isArray(conds.required_ppe) &&
                        (conds.required_ppe as unknown[]).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-amber-400/80 uppercase mb-1 font-bold">
                              Required PPE
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(conds.required_ppe as unknown[]).map((ppe, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] terminal-text bg-amber-900/30 text-amber-400 px-1.5 py-0.5 rounded border border-amber-400/30"
                                >
                                  {itemLabel(ppe)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {/* Required Equipment */}
                      {Array.isArray(conds.required_equipment) &&
                        (conds.required_equipment as Array<Record<string, unknown>>).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-cyan-400/80 uppercase mb-1 font-bold">
                              Required Equipment
                            </div>
                            {(conds.required_equipment as Array<Record<string, unknown>>).map(
                              (eq, i) => (
                                <div
                                  key={i}
                                  className="text-xs terminal-text text-robotic-yellow/60 flex gap-2 mb-0.5"
                                >
                                  <span className="text-cyan-400/60">
                                    ×{Number(eq.quantity ?? 1)}
                                  </span>
                                  <span>{String(eq.item ?? '')}</span>
                                  {eq.purpose ? (
                                    <span className="text-robotic-yellow/40">
                                      ({String(eq.purpose)})
                                    </span>
                                  ) : null}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      {/* Ideal Response Sequence */}
                      {Array.isArray(conds.ideal_response_sequence) &&
                        (conds.ideal_response_sequence as Array<Record<string, unknown>>).length >
                          0 && (
                          <div>
                            <div className="text-xs terminal-text text-cyan-400/80 uppercase mb-1 font-bold">
                              Ideal Response Sequence
                            </div>
                            {(conds.ideal_response_sequence as Array<Record<string, unknown>>).map(
                              (step, i) => (
                                <div
                                  key={i}
                                  className="flex gap-2 text-xs terminal-text text-robotic-yellow/70 mb-0.5"
                                >
                                  <span className="text-cyan-400/60 shrink-0 w-5">
                                    {Number(step.step ?? i + 1)}.
                                  </span>
                                  <span>
                                    <b className="text-robotic-yellow/90">{String(step.action)}</b>
                                    {step.detail ? (
                                      <span className="text-robotic-yellow/50">
                                        {' '}
                                        — {String(step.detail)}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      {/* Expected Time to Treat */}
                      {typeof conds.expected_time_to_treat_minutes === 'number' && (
                        <div className="text-xs terminal-text text-robotic-yellow/60">
                          Est. treatment time:{' '}
                          <b className="text-robotic-yellow/90">
                            {conds.expected_time_to_treat_minutes as number} min
                          </b>
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

      {/* ── Crowds ── */}
      {crowds.length > 0 && (
        <Section
          title={`Crowds (${crowds.length} groups, ${crowds.reduce((s, c) => s + c.headcount, 0)} total)`}
        >
          <div className="space-y-2">
            {crowds.map((c) => {
              const conds = c.conditions;
              const wounded = (conds.mixed_wounded as Array<Record<string, unknown>>) ?? [];
              const isExpanded = expandedPin === `crowd-${c.id}`;
              return (
                <div key={c.id} className="military-border">
                  <div className="p-4 flex gap-4">
                    <div className="shrink-0 w-28">
                      <div className="text-xs terminal-text text-violet-400/80 uppercase">
                        {c.headcount} people
                      </div>
                      <div className="text-xs terminal-text text-robotic-yellow/30 mt-0.5">
                        {c.location_lat.toFixed(4)}, {c.location_lng.toFixed(4)}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2">
                        <p className="text-xs terminal-text text-robotic-yellow/80 flex-1">
                          {(conds.visible_description as string) || `Group of ${c.headcount}`}
                        </p>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePin(c.id, 'casualty');
                          }}
                          disabled={deletingPin === c.id}
                          className="shrink-0 w-5 h-5 flex items-center justify-center text-red-500/60 hover:text-red-400 hover:bg-red-900/30 rounded transition-colors text-xs"
                          title="Delete crowd"
                        >
                          {deletingPin === c.id ? '...' : '✕'}
                        </button>
                      </div>
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
                    <button
                      onClick={() => setExpandedPin(isExpanded ? null : `crowd-${c.id}`)}
                      className="text-robotic-yellow/40 hover:text-robotic-yellow terminal-text text-xs shrink-0 self-start"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 border-t border-robotic-yellow/15 pt-2 space-y-3">
                      {/* Management Priority */}
                      {conds.management_priority ? (
                        <div className="text-xs terminal-text text-robotic-yellow/60">
                          Priority:{' '}
                          <b className="text-violet-400">
                            {String(conds.management_priority).replace(/_/g, ' ').toUpperCase()}
                          </b>
                        </div>
                      ) : null}
                      {/* Ideal Response Sequence */}
                      {Array.isArray(conds.ideal_response_sequence) &&
                        (conds.ideal_response_sequence as Array<Record<string, unknown>>).length >
                          0 && (
                          <div>
                            <div className="text-xs terminal-text text-cyan-400/80 uppercase mb-1 font-bold">
                              Ideal Response Sequence
                            </div>
                            {(conds.ideal_response_sequence as Array<Record<string, unknown>>).map(
                              (step, i) => (
                                <div
                                  key={i}
                                  className="flex gap-2 text-xs terminal-text text-robotic-yellow/70 mb-0.5"
                                >
                                  <span className="text-cyan-400/60 shrink-0 w-5">
                                    {Number(step.step ?? i + 1)}.
                                  </span>
                                  <span>
                                    <b className="text-robotic-yellow/90">{String(step.action)}</b>
                                    {step.detail ? (
                                      <span className="text-robotic-yellow/50">
                                        {' '}
                                        — {String(step.detail)}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      {/* Required Personnel */}
                      {Array.isArray(conds.required_personnel) &&
                        (conds.required_personnel as Array<Record<string, unknown>>).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-purple-400/80 uppercase mb-1 font-bold">
                              Required Personnel
                            </div>
                            {(conds.required_personnel as Array<Record<string, unknown>>).map(
                              (p, i) => (
                                <div
                                  key={i}
                                  className="text-xs terminal-text text-robotic-yellow/60 flex gap-2 mb-0.5"
                                >
                                  <span className="text-purple-400/60">
                                    ×{Number(p.count ?? 1)}
                                  </span>
                                  <span>{String(p.role ?? p.type ?? '')}</span>
                                  {p.purpose ? (
                                    <span className="text-robotic-yellow/40">
                                      ({String(p.purpose)})
                                    </span>
                                  ) : null}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      {/* Required Equipment */}
                      {Array.isArray(conds.required_equipment) &&
                        (conds.required_equipment as Array<Record<string, unknown>>).length > 0 && (
                          <div>
                            <div className="text-xs terminal-text text-green-400/80 uppercase mb-1 font-bold">
                              Required Equipment
                            </div>
                            {(conds.required_equipment as Array<Record<string, unknown>>).map(
                              (eq, i) => (
                                <div
                                  key={i}
                                  className="text-xs terminal-text text-robotic-yellow/60 flex gap-2 mb-0.5"
                                >
                                  <span className="text-green-400/60">
                                    ×{Number(eq.quantity ?? 1)}
                                  </span>
                                  <span>{String(eq.item ?? eq.type ?? '')}</span>
                                  {eq.purpose ? (
                                    <span className="text-robotic-yellow/40">
                                      ({String(eq.purpose)})
                                    </span>
                                  ) : null}
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      {/* Estimated Resolution Time */}
                      {typeof conds.estimated_resolution_minutes === 'number' && (
                        <div className="text-xs terminal-text text-robotic-yellow/60">
                          Est. resolution:{' '}
                          <b className="text-robotic-yellow/90">
                            {conds.estimated_resolution_minutes as number} min
                          </b>
                        </div>
                      )}
                      {/* Mixed Wounded Details */}
                      {wounded.length > 0 && (
                        <div>
                          <div className="text-xs terminal-text text-amber-400/80 uppercase mb-1 font-bold">
                            Mixed Wounded
                          </div>
                          {wounded.map((w, i) => (
                            <div
                              key={i}
                              className="text-xs terminal-text text-robotic-yellow/60 flex gap-2 mb-0.5"
                            >
                              <span className="text-amber-400/60">
                                ×{(w.count as number) ?? '?'}
                              </span>
                              <span>
                                {(w.condition as string) ?? (w.triage_color as string) ?? 'unknown'}
                              </span>
                            </div>
                          ))}
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
            <span>{(val as unknown[]).map((v) => itemLabel(v)).join(', ')}</span>
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
