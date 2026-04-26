import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { SceneEditor } from '../components/SceneEditor/SceneEditor';
import { loadSceneConfig } from '../lib/rts/sceneConfigApi';
import { LocationValidationStep } from '../components/WarRoom/LocationValidationStep';
import { ResearchStep } from '../components/WarRoom/ResearchStep';
import { CompileStep } from '../components/WarRoom/CompileStep';

interface TeamEntry {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  is_investigative: boolean;
}

const STEP_LABELS: Record<number, string> = {
  1: 'Incident',
  2: 'Teams',
  3: 'Scene Editor',
  5: 'Location',
  6: 'Research',
  7: 'Compile',
};

const VISIBLE_STEPS = [1, 2, 3, 5, 6, 7];

const INCIDENT_TYPES = [
  { id: 'bombing', label: 'Bombing (General)', group: 'Explosives', enabled: true, icon: '💣' },
  { id: 'car_bomb', label: 'Car Bomb / VBIED', group: 'Explosives', enabled: true, icon: '🚗' },
  {
    id: 'suicide_bombing',
    label: 'Suicide Bombing',
    group: 'Explosives',
    enabled: true,
    icon: '⚠',
  },
  { id: 'bombing_mall', label: 'Mall Bombing', group: 'Explosives', enabled: true, icon: '🏬' },
  {
    id: 'open_field_shooting',
    label: 'Shooting (Open Field)',
    group: 'Armed Attack',
    enabled: false,
    icon: '🔫',
  },
  {
    id: 'knife_attack',
    label: 'Knife / Bladed Attack',
    group: 'Armed Attack',
    enabled: false,
    icon: '🔪',
  },
  { id: 'gas_attack', label: 'Chemical / Gas Attack', group: 'CBRN', enabled: false, icon: '☣' },
  { id: 'poisoning', label: 'Poisoning', group: 'CBRN', enabled: false, icon: '☠' },
  { id: 'kidnapping', label: 'Kidnapping / Hostage', group: 'Other', enabled: false, icon: '🚨' },
  { id: 'hijacking', label: 'Hijacking', group: 'Other', enabled: false, icon: '✈' },
] as const;

const INCIDENT_GROUPS = ['Explosives', 'Armed Attack', 'CBRN', 'Other'] as const;

const TEAM_INVENTORY = [
  {
    name: 'Bomb Squad / EOD',
    description:
      'Secondary device sweep, render safe procedures, controlled detonation, forensic IED analysis',
  },
  {
    name: 'Medical Triage',
    description:
      'Mass casualty triage, patient stabilization, hospital coordination, field treatment',
  },
  {
    name: 'Hazards / Fire / Rescue',
    description: 'Fire suppression, HAZMAT response, structural rescue, ventilation operations',
  },
  {
    name: 'Evacuation',
    description:
      'Civilian evacuation management, assembly point coordination, headcount verification',
  },
  {
    name: 'Media & Communications',
    description:
      'Press briefings, public information, social media monitoring, misinformation management',
  },
  {
    name: 'Pursuit & Investigation',
    description:
      'Suspect tracking, evidence preservation, witness management, intelligence gathering',
  },
  {
    name: 'Incident Command',
    description:
      'Overall incident coordination, resource allocation, inter-agency liaison, strategic decisions',
  },
  {
    name: 'Police / Security',
    description: 'Cordon management, crowd control, access control, VIP protection',
  },
];

export const WarRoom = () => {
  const { isTrainer } = useRoleVisibility();
  const [searchParams, setSearchParams] = useSearchParams();
  const resumedRef = useRef(false);

  // Draft picker
  const [existingDrafts, setExistingDrafts] = useState<
    Array<{
      id: string;
      status: string;
      current_step: number;
      input: Record<string, unknown>;
      created_at: string;
      updated_at: string;
      scenario_id: string | null;
    }>
  >([]);
  const [showDraftPicker, setShowDraftPicker] = useState(false);
  const [draftsLoaded, setDraftsLoaded] = useState(false);

  const [step, setStep] = useState<1 | 2 | 3 | 5 | 6 | 7>(1);

  // Step 1: Incident selection
  const [incidentType, setIncidentType] = useState<string | null>(null);
  const [customIncidentText, setCustomIncidentText] = useState('');

  // Step 2: Teams
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [showAddTeam, setShowAddTeam] = useState(false);

  // Step 3: Scene editor
  const [rtsSceneId, setRtsSceneId] = useState<string | null>(null);
  const [sceneConfig, setSceneConfig] = useState<Record<string, unknown> | null>(null);
  const [weaponType, setWeaponType] = useState<string | null>(null);

  // Wizard draft
  const [wizardDraftId, setWizardDraftId] = useState<string | null>(null);

  // Step 5: Location validation
  const [geoResult, setGeoResult] = useState<Record<string, unknown> | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const geoFetchedRef = useRef(false);

  // Step 6: Research
  const [researchResults, setResearchResults] = useState<Record<string, unknown> | null>(null);

  // Step 7: Compile
  const [scenarioId, setScenarioId] = useState<string | null>(null);

  // ── Draft save/resume helpers ─────────────────────────────────────────

  const buildDraftInput = useCallback(() => {
    const input: Record<string, unknown> = {
      scenario_type: incidentType,
      custom_incident_text: customIncidentText,
      teams: teams,
      weapon_type: weaponType,
      scene_context: rtsSceneId ? { rts_scene_id: rtsSceneId } : undefined,
    };
    if (customIncidentText) input.prompt = customIncidentText;
    return input;
  }, [incidentType, customIncidentText, teams, weaponType, rtsSceneId]);

  const saveDraftState = useCallback(
    async (nextStep: number) => {
      try {
        if (!wizardDraftId) {
          const { data: created } = await api.warroom.wizardDraftCreate({
            input: buildDraftInput(),
          });
          const newId = created.draft_id;
          setWizardDraftId(newId);
          setSearchParams({ draft: newId }, { replace: true });
          return newId;
        }
        await api.warroom.wizardDraftPatch(wizardDraftId, {
          current_step: nextStep,
          input: buildDraftInput(),
        });
        return wizardDraftId;
      } catch (err) {
        console.error('Failed to save draft', err);
        return wizardDraftId;
      }
    },
    [wizardDraftId, buildDraftInput, setSearchParams],
  );

  // Resume from ?draft= on mount
  useEffect(() => {
    if (resumedRef.current) return;
    const draftParam = searchParams.get('draft');
    if (!draftParam) return;
    resumedRef.current = true;

    const resume = async () => {
      try {
        const { data: draft } = await api.warroom.wizardDraftGet(draftParam);
        if (!draft) return;

        setWizardDraftId(draftParam);
        const input = (draft.input ?? {}) as Record<string, unknown>;
        const savedStep = (draft.current_step as number) || 1;
        const validStep = VISIBLE_STEPS.includes(savedStep) ? savedStep : 1;

        // Restore wizard state from draft input
        if (input.scenario_type) setIncidentType(input.scenario_type as string);
        if (input.custom_incident_text) setCustomIncidentText(input.custom_incident_text as string);
        if (input.weapon_type) setWeaponType(input.weapon_type as string);

        const teamsData = input.teams as TeamEntry[] | string[] | undefined;
        if (Array.isArray(teamsData) && teamsData.length > 0) {
          if (typeof teamsData[0] === 'string') {
            setTeams(
              (teamsData as string[]).map((name) => ({
                team_name: name,
                team_description: '',
                min_participants: 1,
                max_participants: 10,
                is_investigative: false,
              })),
            );
          } else {
            setTeams(teamsData as TeamEntry[]);
          }
        }

        const sceneCtx = input.scene_context as Record<string, unknown> | undefined;
        if (sceneCtx?.rts_scene_id) {
          const sceneId = sceneCtx.rts_scene_id as string;
          setRtsSceneId(sceneId);
          try {
            const sceneRow = await loadSceneConfig(sceneId);
            if (sceneRow) {
              const row = sceneRow as unknown as Record<string, unknown>;
              setSceneConfig({
                buildingPolygon: row.building_polygon,
                buildingName: row.building_name,
                centerLat: parseFloat(String(row.center_lat)) || 0,
                centerLng: parseFloat(String(row.center_lng)) || 0,
                exits: row.exits || [],
                interiorWalls: row.interior_walls || [],
                hazardZones: row.hazard_zones || [],
                stairwells: row.stairwells || [],
                blastSite: row.blast_site || null,
                blastRadius: ((row.blast_site as Record<string, unknown>)?.radius as number) || 20,
                wallInspectionPoints: row.wall_inspection_points || [],
                plantedItems: row.planted_items || [],
                pedestrianCount: row.pedestrian_count || 120,
                weaponType:
                  ((row.blast_site as Record<string, unknown>)?.weaponType as string) || null,
                locationDescription:
                  ((row.blast_site as Record<string, unknown>)?.locationDescription as string) ||
                  null,
              } as unknown as Record<string, unknown>);
            }
          } catch {
            // Scene config load failed -- non-critical, continue
          }
        }

        // Restore geo result if present
        if (draft.geo_result) {
          setGeoResult(draft.geo_result as Record<string, unknown>);
          geoFetchedRef.current = true;
        }

        // Restore research results if present
        if (draft.phase1_preview && draft.doctrines) {
          setResearchResults({
            phase1Preview: draft.phase1_preview,
            doctrines: draft.doctrines,
          } as Record<string, unknown>);
        }

        setStep(validStep as typeof step);
      } catch (err) {
        console.error('Failed to resume draft', err);
      }
    };
    resume();
  }, [searchParams]);

  // Load existing drafts for picker (when no ?draft= param)
  useEffect(() => {
    if (searchParams.get('draft') || draftsLoaded) return;
    setDraftsLoaded(true);
    api.warroom
      .wizardDraftList()
      .then(({ data }) => {
        const active = data.filter((d) => d.status === 'draft' && !d.scenario_id);
        if (active.length > 0) {
          setExistingDrafts(active);
          setShowDraftPicker(true);
        }
      })
      .catch(() => {});
  }, [searchParams, draftsLoaded]);

  // Team helpers
  const updateTeam = useCallback(
    (index: number, field: keyof TeamEntry, value: string | number | boolean) => {
      setTeams((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
    },
    [],
  );
  const removeTeam = useCallback((index: number) => {
    setTeams((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const addTeamFromInventory = useCallback((name: string) => {
    const inv = TEAM_INVENTORY.find((t) => t.name === name);
    if (!inv) return;
    setTeams((prev) => [
      ...prev,
      {
        team_name: inv.name,
        team_description: inv.description,
        min_participants: 1,
        max_participants: 10,
        is_investigative: /pursuit|investigation|police/i.test(inv.name),
      },
    ]);
    setShowAddTeam(false);
  }, []);

  // Auto-suggest teams when entering step 2
  useEffect(() => {
    if (step !== 2 || teams.length > 0 || !incidentType) return;
    setTeamsLoading(true);
    api.warroom
      .suggestTeams({
        scenario_type: incidentType === 'custom' ? customIncidentText : incidentType,
      })
      .then(({ data }) => {
        const mapped: TeamEntry[] = data.suggested_teams.map((t: Record<string, unknown>) => ({
          team_name: (t.team_name as string) || '',
          team_description: (t.team_description as string) || '',
          min_participants: (t.min_participants as number) ?? 1,
          max_participants: (t.max_participants as number) ?? 10,
          is_investigative: !!(t.is_investigative as boolean),
        }));
        setTeams(mapped);
      })
      .catch(() => {})
      .finally(() => setTeamsLoading(false));
  }, [step, incidentType, customIncidentText, teams.length]);

  // Auto-run geocode-validate when entering Step 5
  useEffect(() => {
    if (step !== 5 || geoResult || geoLoading || geoFetchedRef.current) return;
    geoFetchedRef.current = true;

    const run = async () => {
      setGeoLoading(true);
      setGeoError(null);
      try {
        const draftInput: Record<string, unknown> = {
          scenario_type: incidentType,
          teams: teams.map((t) => t.team_name),
          weapon_type: weaponType,
          scene_context: rtsSceneId ? { rts_scene_id: rtsSceneId } : undefined,
        };
        if (customIncidentText) {
          draftInput.prompt = customIncidentText;
        }
        // Provide geocode override from scene config so the server knows where to search for POIs
        if (sceneConfig) {
          const cLat = sceneConfig.centerLat as number | undefined;
          const cLng = sceneConfig.centerLng as number | undefined;
          const locDesc = sceneConfig.locationDescription as string | undefined;
          const bName = sceneConfig.buildingName as string | undefined;
          if (cLat && cLng) {
            draftInput.geocode_override = {
              lat: cLat,
              lng: cLng,
              display_name: locDesc || bName || undefined,
            };
          }
          if (locDesc || bName) {
            draftInput.location = locDesc || bName;
            draftInput.venue_name = bName || undefined;
          }
        }

        let draftId = wizardDraftId;
        if (!draftId) {
          const { data: created } = await api.warroom.wizardDraftCreate({ input: draftInput });
          draftId = created.draft_id;
          setWizardDraftId(draftId);
          setSearchParams({ draft: draftId }, { replace: true });
        } else {
          await api.warroom.wizardDraftPatch(draftId, { input: draftInput });
        }

        const { data } = await api.warroom.wizardDraftGeocodeValidate(draftId);
        setGeoResult(data as Record<string, unknown>);
      } catch (err) {
        setGeoError(err instanceof Error ? err.message : 'Geocode validation failed');
      } finally {
        setGeoLoading(false);
      }
    };
    run();
  }, [
    step,
    geoResult,
    geoLoading,
    incidentType,
    teams,
    weaponType,
    rtsSceneId,
    customIncidentText,
    wizardDraftId,
    sceneConfig,
  ]);

  if (!isTrainer) {
    return (
      <div className="min-h-screen scanline flex items-center justify-center">
        <div className="military-border p-8 text-center">
          <h1 className="text-xl terminal-text uppercase mb-4">[ACCESS DENIED]</h1>
          <p className="text-sm terminal-text text-robotic-yellow/70">
            War Room is available to trainers only.
          </p>
        </div>
      </div>
    );
  }

  const currentStepIndex = VISIBLE_STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;
  const stepValid =
    step === 1
      ? !!incidentType
      : step === 2
        ? teams.length > 0 && !teamsLoading
        : step === 3
          ? !!rtsSceneId
          : step === 6
            ? !!researchResults
            : true;
  const canGoNext = step < 7 && stepValid;

  const goBack = () => {
    if (canGoBack) {
      const prevStep = VISIBLE_STEPS[currentStepIndex - 1];
      saveDraftState(prevStep);
      setStep(prevStep as typeof step);
    }
  };

  const goNext = () => {
    if (step === 3) {
      saveDraftState(5);
      setStep(5);
    } else if (canGoNext) {
      const nextStep = (step + 1) as typeof step;
      saveDraftState(nextStep);
      setStep(nextStep);
    }
  };

  return (
    <div className="min-h-screen scanline p-6">
      <div className="w-full px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl terminal-text uppercase tracking-wider">[WAR ROOM]</h1>
          <span className="text-xs terminal-text text-robotic-yellow/50">v2.0</span>
        </div>

        {/* Step progress bar */}
        <div className="military-border p-3 mb-6 bg-robotic-gray-300">
          <div className="flex items-center gap-1 overflow-x-auto">
            {VISIBLE_STEPS.map((s, i) => {
              const isCurrent = s === step;
              const isPast = VISIBLE_STEPS.indexOf(step) > i;
              return (
                <div key={s} className="flex items-center">
                  {i > 0 && (
                    <div
                      className={`w-4 h-px mx-1 ${
                        isPast ? 'bg-robotic-yellow' : 'bg-robotic-gray-200'
                      }`}
                    />
                  )}
                  <div
                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] terminal-text uppercase whitespace-nowrap ${
                      isCurrent
                        ? 'border border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                        : isPast
                          ? 'text-robotic-yellow/70'
                          : 'text-robotic-yellow/30'
                    }`}
                  >
                    <span
                      className={`w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold ${
                        isCurrent
                          ? 'bg-robotic-yellow text-black'
                          : isPast
                            ? 'bg-robotic-yellow/30 text-robotic-yellow'
                            : 'bg-robotic-gray-200 text-robotic-yellow/30'
                      }`}
                    >
                      {isPast ? '\u2713' : VISIBLE_STEPS.indexOf(s) + 1}
                    </span>
                    {STEP_LABELS[s]}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Draft picker banner */}
        {showDraftPicker && existingDrafts.length > 0 && (
          <div className="military-border p-4 mb-4 bg-cyan-900/10">
            <div className="flex justify-between items-center mb-3">
              <div className="text-sm terminal-text text-cyan-400 uppercase">
                Resume an in-progress scenario
              </div>
              <button
                onClick={() => setShowDraftPicker(false)}
                className="text-xs terminal-text text-robotic-yellow/40 hover:text-robotic-yellow/70"
              >
                Dismiss
              </button>
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {existingDrafts.map((draft) => {
                const input = draft.input || {};
                const sceneName = (input.scenario_type as string) || 'Unknown';
                const stepLabel =
                  STEP_LABELS[draft.current_step as keyof typeof STEP_LABELS] ||
                  `Step ${draft.current_step}`;
                const updated = new Date(draft.updated_at).toLocaleString();
                return (
                  <div
                    key={draft.id}
                    className="flex items-center justify-between border border-robotic-gray-200 rounded px-3 py-2 hover:bg-robotic-gray-200/20"
                  >
                    <div>
                      <div className="text-xs terminal-text text-robotic-yellow/70 capitalize">
                        {sceneName.replace(/_/g, ' ')}
                      </div>
                      <div className="text-[10px] terminal-text text-robotic-yellow/30">
                        At: {stepLabel} — Updated: {updated}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setShowDraftPicker(false);
                        setSearchParams({ draft: draft.id }, { replace: true });
                        window.location.reload();
                      }}
                      className="text-xs terminal-text text-cyan-400 border border-cyan-500/50 px-3 py-1 hover:bg-cyan-900/20"
                    >
                      Resume
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step content */}
        <div className="military-border p-6 mb-6 min-h-[400px]">
          {step === 1 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 1: INCIDENT SELECTION]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                Select the type of incident for this training scenario.
              </p>

              {INCIDENT_GROUPS.map((group) => {
                const groupTypes = INCIDENT_TYPES.filter((t) => t.group === group);
                return (
                  <div key={group} className="mb-5">
                    <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2">
                      {group}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {groupTypes.map((t) => {
                        const isSelected = incidentType === t.id;
                        const isDisabled = !t.enabled;
                        return (
                          <div
                            key={t.id}
                            onClick={() => {
                              if (isDisabled) return;
                              setIncidentType(t.id);
                              setCustomIncidentText('');
                            }}
                            title={isDisabled ? 'Available soon' : t.label}
                            className={`relative px-3 py-3 border rounded text-center transition-all ${
                              isDisabled
                                ? 'border-robotic-gray-200 opacity-30 cursor-not-allowed'
                                : isSelected
                                  ? 'border-cyan-400 bg-cyan-900/30 cursor-pointer'
                                  : 'border-robotic-gray-200 hover:border-robotic-yellow/50 cursor-pointer'
                            }`}
                          >
                            <div className="text-xl mb-1">{t.icon}</div>
                            <div
                              className={`text-xs terminal-text ${
                                isSelected
                                  ? 'text-cyan-300'
                                  : isDisabled
                                    ? 'text-robotic-yellow/20'
                                    : 'text-robotic-yellow/70'
                              }`}
                            >
                              {t.label}
                            </div>
                            {isDisabled && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-[8px] terminal-text text-robotic-yellow/30 bg-black/60 px-1.5 py-0.5 rounded">
                                  SOON
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div className="border-t border-robotic-gray-200 pt-4 mt-4">
                <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider">
                  Or describe a custom bombing scenario
                </label>
                <input
                  type="text"
                  value={customIncidentText}
                  onChange={(e) => {
                    setCustomIncidentText(e.target.value);
                    if (e.target.value.trim()) {
                      setIncidentType('custom');
                    } else if (incidentType === 'custom') {
                      setIncidentType(null);
                    }
                  }}
                  placeholder="e.g., IED hidden in a vehicle outside a government building..."
                  className="w-full mt-1 px-4 py-2 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow terminal-text text-sm rounded focus:outline-none focus:border-robotic-yellow/70"
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 2: TEAM SELECTION]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
                Configure the response teams for this scenario. Add or remove teams as needed.
              </p>

              {teamsLoading && (
                <p className="text-sm terminal-text text-robotic-yellow/70 animate-pulse mb-4">
                  Suggesting teams for {incidentType}...
                </p>
              )}

              <div className="space-y-3 mb-4">
                {teams.map((t, i) => (
                  <div
                    key={i}
                    className="border border-robotic-yellow/50 p-4 bg-black/30 flex flex-col gap-2"
                  >
                    <div className="flex gap-2 items-center">
                      <div className="flex-1 px-3 py-2 bg-black/30 border border-robotic-yellow/30 text-robotic-yellow terminal-text text-sm font-bold">
                        {t.team_name}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTeam(i)}
                        disabled={teams.length <= 1}
                        className="px-3 py-2 text-xs terminal-text text-robotic-orange hover:bg-robotic-orange/10 disabled:opacity-50"
                      >
                        [REMOVE]
                      </button>
                    </div>
                    <input
                      type="text"
                      value={t.team_description}
                      onChange={(e) => updateTeam(i, 'team_description', e.target.value)}
                      placeholder="Team description"
                      className="px-3 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
                    />
                    <div className="flex gap-4 items-center">
                      <label className="flex items-center gap-2 text-xs terminal-text text-robotic-yellow/70">
                        Min:
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={t.min_participants}
                          onChange={(e) =>
                            updateTeam(i, 'min_participants', parseInt(e.target.value, 10) || 1)
                          }
                          className="w-16 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs terminal-text text-robotic-yellow/70">
                        Max:
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={t.max_participants}
                          onChange={(e) =>
                            updateTeam(i, 'max_participants', parseInt(e.target.value, 10) || 10)
                          }
                          className="w-16 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => updateTeam(i, 'is_investigative', !t.is_investigative)}
                        className={`px-3 py-1.5 text-[10px] terminal-text uppercase tracking-wider border transition-all ${
                          t.is_investigative
                            ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                            : 'border-robotic-yellow/30 text-robotic-yellow/50 hover:border-robotic-yellow/60'
                        }`}
                      >
                        {t.is_investigative ? '\u2B21 INVESTIGATIVE' : '\u25CB INVESTIGATIVE'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add team from inventory */}
              <div className="relative">
                <button
                  onClick={() => setShowAddTeam(!showAddTeam)}
                  className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow border border-robotic-yellow/50 px-3 py-2"
                >
                  [+ ADD TEAM]
                </button>
                {showAddTeam && (
                  <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-robotic-yellow/50 rounded shadow-xl z-10 max-h-60 overflow-y-auto">
                    {TEAM_INVENTORY.filter(
                      (inv) => !teams.some((t) => t.team_name === inv.name),
                    ).map((inv) => (
                      <button
                        key={inv.name}
                        onClick={() => addTeamFromInventory(inv.name)}
                        className="block w-full text-left px-4 py-2 text-xs terminal-text text-robotic-yellow/70 hover:bg-robotic-yellow/10 hover:text-robotic-yellow border-b border-robotic-gray-200 last:border-b-0"
                      >
                        <div className="font-bold">{inv.name}</div>
                        <div className="text-[10px] text-robotic-yellow/40 mt-0.5">
                          {inv.description}
                        </div>
                      </button>
                    ))}
                    {TEAM_INVENTORY.filter((inv) => !teams.some((t) => t.team_name === inv.name))
                      .length === 0 && (
                      <div className="px-4 py-2 text-xs terminal-text text-robotic-yellow/30">
                        All teams added
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="h-[calc(100vh-280px)] min-h-[500px] lg:min-h-[600px]">
              <SceneEditor
                incidentType={incidentType || 'bombing'}
                initialSceneId={rtsSceneId}
                weaponType={weaponType}
                onWeaponTypeChange={(wt) => setWeaponType(wt)}
                onSave={(id, config) => {
                  setRtsSceneId(id);
                  setSceneConfig(config as unknown as Record<string, unknown>);
                  setWeaponType(config.weaponType);
                }}
              />
            </div>
          )}

          {step === 5 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 5: LOCATION VALIDATION]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
                Review nearby facilities, routes, and points of interest. Remove or adjust as
                needed.
              </p>
              <LocationValidationStep
                geoResult={geoResult}
                onUpdate={setGeoResult}
                sceneConfig={sceneConfig}
                loading={geoLoading}
                error={geoError}
              />
            </div>
          )}

          {step === 6 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 6: INCIDENT RESEARCH]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
                AI researches similar incidents, generates scenario narrative, and produces per-team
                doctrines and workflows.
              </p>
              <ResearchStep
                wizardDraftId={wizardDraftId}
                onComplete={(data) => setResearchResults(data)}
              />
            </div>
          )}

          {step === 7 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 7: COMPILE SCENARIO]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
                Compile all research, hazard analysis, and doctrines into a playable scenario.
              </p>
              <CompileStep wizardDraftId={wizardDraftId} onComplete={(id) => setScenarioId(id)} />
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between items-center">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            [BACK]
          </button>
          <span className="text-xs terminal-text text-robotic-yellow/40">
            Step {VISIBLE_STEPS.indexOf(step) + 1} of {VISIBLE_STEPS.length}
          </span>
          {step === 7 ? (
            scenarioId ? (
              <a
                href={`/scenarios/${scenarioId}`}
                className="military-button px-8 py-3 text-center"
              >
                [VIEW SCENARIO]
              </a>
            ) : (
              <span className="text-xs terminal-text text-robotic-yellow/30">
                Compile the scenario above to finish
              </span>
            )
          ) : (
            <button
              onClick={goNext}
              disabled={!canGoNext}
              className="military-button px-8 py-3 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              [NEXT]
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
