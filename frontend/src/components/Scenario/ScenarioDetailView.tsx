import { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer } from 'react-leaflet';
import { api } from '../../lib/api';
import { ScenarioLocationMarker, type ScenarioLocationPin } from '../COP/ScenarioLocationMarker';

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

interface Seed {
  id: string;
  variant_label: string;
  seed_data: Record<string, unknown>;
  display_order: number;
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
  'Env Seeds',
  'Standards',
] as const;
type Tab = (typeof tabs)[number];

export const ScenarioDetailView = ({ scenarioId, onClose }: Props) => {
  const [scenario, setScenario] = useState<ScenarioFull | null>(null);
  const [injects, setInjects] = useState<Inject[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [locations, setLocations] = useState<LocationPin[]>([]);
  const [seeds, setSeeds] = useState<Seed[]>([]);
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
        const [scenRes, injectRes, teamRes, locRes, seedRes] = await Promise.all([
          api.scenarios.get(scenarioId),
          api.scenarios.getInjects(scenarioId),
          api.scenarios.getTeams(scenarioId),
          api.scenarios.getScenarioLocations(scenarioId),
          api.scenarios.getSeeds(scenarioId),
        ]);
        setScenario(scenRes.data as ScenarioFull);
        setInjects((injectRes.data ?? []) as Inject[]);
        setTeams((teamRes.data ?? []) as Team[]);
        setLocations((locRes.data ?? []) as LocationPin[]);
        setSeeds((seedRes.data ?? []) as Seed[]);
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
          {activeTab === 'Map Pins' && <MapPinsTab locations={locations} />}

          {/* ─── ENV TRUTHS ─── */}
          {activeTab === 'Env Truths' && (
            <EnvTruthsTab locations={locations} siteRequirements={ik?.site_requirements} />
          )}

          {/* ─── ENV SEEDS ─── */}
          {activeTab === 'Env Seeds' && (
            <div>
              {seeds.length === 0 ? (
                <p className="text-sm terminal-text text-robotic-yellow/50">
                  [NO ENVIRONMENTAL SEEDS]
                </p>
              ) : (
                <div className="space-y-4">
                  {seeds.map((seed) => (
                    <div key={seed.id} className="military-border p-4">
                      <div className="text-sm terminal-text text-robotic-yellow uppercase mb-3">
                        {seed.variant_label}
                      </div>
                      <SeedDataView data={seed.seed_data} />
                    </div>
                  ))}
                </div>
              )}
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
];

const MapPinsTab = ({ locations }: { locations: LocationPin[] }) => {
  const [expandedPin, setExpandedPin] = useState<string | null>(null);

  if (locations.length === 0) {
    return <p className="text-sm terminal-text text-robotic-yellow/50">[NO LOCATIONS]</p>;
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

  const mapCenter: [number, number] =
    validPins.length > 0
      ? [validPins[0].coordinates.lat!, validPins[0].coordinates.lng!]
      : [1.2931, 103.8558];

  return (
    <div className="space-y-4">
      {/* OSM map */}
      <div className="military-border overflow-hidden" style={{ height: 440 }}>
        <MapContainer
          center={mapCenter}
          zoom={14}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {validPins.map((pin) => (
            <ScenarioLocationMarker
              key={pin.id}
              location={pin}
              position={[pin.coordinates.lat!, pin.coordinates.lng!]}
            />
          ))}
        </MapContainer>
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

      {/* Pin list */}
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

const SeedDataView = ({ data }: { data: Record<string, unknown> }) => {
  const routes = data.routes as Array<Record<string, unknown>> | undefined;
  const areas = data.areas as Array<Record<string, unknown>> | undefined;
  const stateKeys = Object.entries(data).filter(
    ([k]) => k.endsWith('_state') && typeof data[k] === 'object',
  );

  return (
    <div className="space-y-3">
      {routes && routes.length > 0 && (
        <div>
          <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">Routes</div>
          <div className="space-y-1">
            {routes.map((r, i) => (
              <div key={i} className="flex gap-2 text-xs terminal-text">
                <span className="text-robotic-yellow/80">{String(r.label ?? '—')}</span>
                {r.problem != null && (
                  <span className="text-orange-400/80">{'⚠ ' + String(r.problem)}</span>
                )}
                {r.travel_time_minutes != null && (
                  <span className="text-robotic-yellow/40">
                    {String(r.travel_time_minutes) + 'min'}
                  </span>
                )}
                {r.managed === false && <span className="text-red-400/70">[UNMANAGED]</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {areas && areas.length > 0 && (
        <div>
          <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">Areas</div>
          <div className="space-y-1">
            {areas.map((a, i) => (
              <div key={i} className="flex gap-2 text-xs terminal-text">
                <span className="text-robotic-yellow/80">
                  {String(a.label ?? a.area_id ?? '—')}
                </span>
                {a.at_capacity === true && <span className="text-red-400/70">[AT CAPACITY]</span>}
                {a.capacity != null && (
                  <span className="text-robotic-yellow/40">{'cap: ' + String(a.capacity)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {stateKeys.map(([key, val]) => (
        <div key={key}>
          <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
            {key.replace(/_/g, ' ')}
          </div>
          <div className="text-xs terminal-text font-mono bg-black/20 p-2 rounded">
            {JSON.stringify(val as Record<string, unknown>, null, 2)}
          </div>
        </div>
      ))}
    </div>
  );
};
