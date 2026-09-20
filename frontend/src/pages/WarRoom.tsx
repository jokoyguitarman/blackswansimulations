import { useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { SceneEditor } from '../components/SceneEditor/SceneEditor';
import { loadSceneConfig } from '../lib/rts/sceneConfigApi';
import { LocationValidationStep } from '../components/WarRoom/LocationValidationStep';
import { ResearchStep } from '../components/WarRoom/ResearchStep';
import { CompileStep } from '../components/WarRoom/CompileStep';
import { BrandMark } from '../components/BrandMark';
import { WrIcon, INCIDENT_ICON, teamIcon, type WrIconName } from '../components/UI/WarRoomIcon';
import { SHELL_ART } from '../lib/scenarioArt';

interface TeamEntry {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  is_investigative: boolean;
}

const STEP_LABELS: Record<number, string> = {
  0: 'Mode',
  1: 'Incident',
  2: 'Teams',
  3: 'Scene Editor',
  5: 'Location',
  6: 'Research',
  7: 'Compile',
};

const VISIBLE_STEPS = [0, 1, 2, 3, 5, 6, 7];

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
  const { isTrainer, role } = useRoleVisibility();
  const [searchParams, setSearchParams] = useSearchParams();
  const resumedRef = useRef(false);

  // Payment portal: scenario generation requires a scenario credit
  // (granted when a client pays an invoice). Admins bypass. The server
  // enforces this regardless - the banner is UX only.
  const [scenarioCredits, setScenarioCredits] = useState<number | null>(null);
  useEffect(() => {
    if (role === 'admin') {
      setScenarioCredits(1);
      return;
    }
    api.billing
      .getCredits()
      .then((res) => setScenarioCredits(res.data.scenario))
      .catch(() => setScenarioCredits(1)); // fail open in UI; server still enforces
  }, [role]);

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

  const [step, setStep] = useState<0 | 1 | 2 | 3 | 5 | 6 | 7>(0);
  const [simMode, setSimMode] = useState<'field_ops' | 'social_media' | null>(null);
  const navigate = useNavigate();

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
        const allDrafts = data.filter((d) => d.status === 'draft' || d.status === 'persisted');
        if (allDrafts.length > 0) {
          setExistingDrafts(allDrafts);
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
      <div className="min-h-screen bg-bg flex items-center justify-center p-6">
        <div className="wr-map text-center max-w-md">
          <div
            className="wr-tile mx-auto mb-3"
            style={{ width: 48, height: 48, '--g': 'var(--brand)' } as CSSProperties}
          >
            <WrIcon name="lock" size={22} />
          </div>
          <h1 className="text-lg font-extrabold text-brand mb-2">Access denied</h1>
          <p className="text-sm text-muted">War Room is available to trainers only.</p>
        </div>
      </div>
    );
  }

  if (scenarioCredits === 0 && role !== 'admin') {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-6">
        <div className="wr-map text-center max-w-md">
          <div
            className="wr-tile mx-auto mb-3"
            style={{ width: 48, height: 48, '--g': 'var(--accent)' } as CSSProperties}
          >
            <WrIcon name="lock" size={22} />
          </div>
          <h1 className="text-lg font-extrabold text-brand mb-2">
            Scenario generation requires a paid engagement
          </h1>
          <p className="text-sm text-muted mb-6">
            You have <b>0 scenario credits</b>. Invoice a client from the Clients page — when they
            pay, the War Room unlocks automatically with 1 scenario credit and 2 session credits.
          </p>
          <button onClick={() => navigate('/clients')} className="wr-btn accent lg">
            Go to Clients &amp; billing <WrIcon name="arrow" />
          </button>
        </div>
      </div>
    );
  }

  const currentStepIndex = VISIBLE_STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;
  const stepValid =
    step === 0
      ? simMode !== null
      : step === 1
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
    if (step === 0 && simMode === 'social_media') {
      navigate('/warroom/social-crisis');
      return;
    }
    if (step === 3) {
      saveDraftState(5);
      setStep(5);
    } else if (canGoNext) {
      const nextStep = (step + 1) as typeof step;
      saveDraftState(nextStep);
      setStep(nextStep);
    }
  };

  /* ── Situation Map shell (docs/design/warroom/warroom-entry.html, spec §4) ─────────── */

  const FIELD_STEPS = VISIBLE_STEPS.filter((s) => s !== 0);
  const fieldStepIndex = FIELD_STEPS.indexOf(step);
  const heroArt: Record<number, string> = {
    0: SHELL_ART.warroomEntry,
    1: SHELL_ART.fieldIncident,
    2: SHELL_ART.fieldTeams,
    3: SHELL_ART.fieldScene,
    5: SHELL_ART.fieldLocation,
    6: SHELL_ART.fieldResearch,
    7: SHELL_ART.fieldCompile,
  };
  const heroTitle: Record<number, string> = {
    0: 'What are you training for?',
    1: 'What kind of incident?',
    2: 'Who responds?',
    3: 'Lay out the scene',
    5: 'Check the location',
    6: 'Research & doctrine',
    7: 'Compile the scenario',
  };
  const heroLead: Record<number, string> = {
    0: 'Pick the kind of exercise. Field operations puts teams on a map with hazards and casualties; corporate crisis puts them on a phone with feeds, inboxes and stakeholders. Everything after this is generated from what you tell us.',
    1: 'The incident type drives the hazards, casualty profile, team suggestions and the research the AI runs. Greyed types are coming soon.',
    2: 'Configure the response teams for this scenario. Add or remove teams as needed; investigative teams get the intelligence layer.',
    3: 'Place the building, the device and the surroundings. The scene becomes the map every team works on.',
    5: 'Review nearby facilities, routes, and points of interest. Remove or adjust as needed.',
    6: 'AI researches similar incidents, generates the scenario narrative, and produces per-team doctrines and workflows.',
    7: 'Compile all research, hazard analysis, and doctrines into a playable scenario.',
  };
  const primaryLabel: Record<number, string> = {
    0: 'Continue',
    1: 'Suggest teams',
    2: 'Lay out the scene',
    3: 'Check location',
    5: 'Run research',
    6: 'Compile',
  };
  const incidentLabel =
    incidentType === 'custom'
      ? customIncidentText.slice(0, 40) || 'Custom'
      : (INCIDENT_TYPES.find((t) => t.id === incidentType)?.label ?? null);
  const INCIDENT_HINT: Record<string, string> = {
    bombing: 'Placed device · blast & fragmentation',
    car_bomb: 'Vehicle-borne · secondary device sweep',
    suicide_bombing: 'Person-borne · crowd egress',
    bombing_mall: 'Enclosed retail · multi-level evacuation',
    open_field_shooting: 'Active shooter · cordon & contain',
    knife_attack: 'Close quarters · rapid triage',
    gas_attack: 'Plume · decontamination corridor',
    poisoning: 'Food / water · public health',
    kidnapping: 'Negotiation · perimeter',
    hijacking: 'Aviation · multi-agency',
  };
  const GROUP_FAMILY: Record<string, { colour: string; icon: WrIconName }> = {
    Explosives: { colour: 'var(--f-crisis)', icon: 'bomb' },
    'Armed Attack': { colour: 'var(--f-rival)', icon: 'gun' },
    CBRN: { colour: 'var(--f-ai)', icon: 'bio' },
    Other: { colour: 'var(--f-intel)', icon: 'siren' },
  };
  const TEAM_FAMILY = [
    'var(--f-crisis)',
    'var(--success)',
    'var(--f-pressure)',
    'var(--brand)',
    'var(--f-intel)',
    'var(--f-ai)',
  ];
  const draftsInProgress = existingDrafts.filter(
    (d) => !(d.status === 'persisted' || !!d.scenario_id),
  );
  const draftsCompiled = existingDrafts.filter((d) => d.status === 'persisted' || !!d.scenario_id);

  const resumeDraft = (draft: (typeof existingDrafts)[number]) => {
    const input = (draft.input || {}) as Record<string, unknown>;
    const isSocialCrisis = input.sim_mode === 'social_media';
    setShowDraftPicker(false);
    if (isSocialCrisis) {
      navigate(`/warroom/social-crisis?draft=${draft.id}`);
    } else {
      setSearchParams({ draft: draft.id }, { replace: true });
      window.location.reload();
    }
  };

  const draftRow = (draft: (typeof existingDrafts)[number]) => {
    const input = (draft.input || {}) as Record<string, unknown>;
    const isSocialCrisis = input.sim_mode === 'social_media';
    const sceneName = isSocialCrisis
      ? String(input.crisis_type || input.org_name || 'Corporate crisis')
          .replace(/_/g, ' ')
          .replace(/\+/g, ' + ')
      : String(input.scenario_type || 'Untitled').replace(/_/g, ' ');
    const isCompleted = draft.status === 'persisted' || !!draft.scenario_id;
    const stepLabel = isCompleted
      ? 'Compiled'
      : STEP_LABELS[draft.current_step as keyof typeof STEP_LABELS] || `Step ${draft.current_step}`;
    const updated = new Date(draft.updated_at).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const total = isSocialCrisis ? 3 : FIELD_STEPS.length;
    const done = isCompleted
      ? total
      : Math.max(
          0,
          Math.min(
            total,
            isSocialCrisis ? draft.current_step : FIELD_STEPS.indexOf(draft.current_step) + 1,
          ),
        );
    return (
      <div key={draft.id} className="wr-draft">
        <div
          className="wr-tile"
          style={
            {
              '--g': isCompleted
                ? 'var(--success)'
                : isSocialCrisis
                  ? 'var(--accent)'
                  : 'var(--brand)',
            } as CSSProperties
          }
        >
          <WrIcon name={isCompleted ? 'check' : isSocialCrisis ? 'phone' : 'map'} size={16} />
        </div>
        <div className="min-w-0">
          <div className="nm">
            <span className="capitalize truncate">{sceneName}</span>
            <span className={`k ${isCompleted ? 'done' : ''}`}>
              {isCompleted ? 'Compiled' : isSocialCrisis ? 'Corporate' : 'Field ops'}
            </span>
          </div>
          <div className="mt">
            <span className="prog" aria-hidden>
              {Array.from({ length: total }).map((_, i) => (
                <i key={i} className={i < done ? (isCompleted ? 'd' : 'f') : ''} />
              ))}
            </span>
            {stepLabel} · {updated}
          </div>
        </div>
        <button
          onClick={() => resumeDraft(draft)}
          className={`wr-btn sm ${isCompleted ? 'onDark' : isSocialCrisis ? 'accent' : 'onDark'}`}
        >
          {isCompleted ? 'Re-compile' : 'Resume'}
          {!isCompleted && <WrIcon name="arrow" size={12} />}
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-bg">
      <header className="wr-artband wr-hero">
        <img className="wr-art" src={heroArt[step]} alt="" />
        <div className="wr-hero-top">
          <div className="wr-brandmark">
            <BrandMark className="h-8 w-8" /> War Room{' '}
            <span className="sub">· {step === 0 ? 'new scenario' : 'Field operations'}</span>
          </div>
          <div className="wr-steps" aria-label="Steps">
            {step === 0 ? (
              simMode === 'social_media' ? (
                <>
                  <span className="on">
                    <i>1</i> Choose a path
                  </span>
                  <span className="ghost">
                    <i>2</i> Setup
                  </span>
                  <span className="ghost">
                    <i>3</i> Build
                  </span>
                  <span className="ghost">
                    <i>4</i> Review &amp; compile
                  </span>
                </>
              ) : simMode === 'field_ops' ? (
                <>
                  <span className="on">
                    <i>1</i> Choose a path
                  </span>
                  {FIELD_STEPS.map((s, i) => (
                    <span key={s} className="ghost">
                      <i>{i + 2}</i> {STEP_LABELS[s]}
                    </span>
                  ))}
                </>
              ) : (
                <>
                  <span className="on">
                    <i>1</i> Choose a path
                  </span>
                  <span className="ghost">
                    <i>2</i> …
                  </span>
                  <span className="ghost">
                    <i>3</i> …
                  </span>
                </>
              )
            ) : (
              FIELD_STEPS.map((s, i) => {
                const isCurrent = s === step;
                const isPast = fieldStepIndex > i;
                return (
                  <span key={s} className={isCurrent ? 'on' : isPast ? 'done' : ''}>
                    <i>{isPast ? <WrIcon name="check" size={11} /> : i + 1}</i>
                    <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
                  </span>
                );
              })
            )}
          </div>
          <div className="wr-credits">
            <span>
              <WrIcon name="layers" /> Scenario credits <b>{scenarioCredits ?? '…'}</b>
            </span>
          </div>
        </div>

        <div className="wr-hero-grid">
          <div>
            <div className="wr-eyebrow">
              {step === 0
                ? 'War Room · step 1'
                : `Field operations · step ${fieldStepIndex + 1} of ${FIELD_STEPS.length}`}
            </div>
            <h1>{heroTitle[step]}</h1>
            <p className="lead">{heroLead[step]}</p>
            {step === 0 && (
              <div className="wr-facts">
                <div className="wr-glass">
                  <b>{existingDrafts.length}</b>
                  <span>drafts saved</span>
                </div>
                <div className="wr-glass">
                  <b>{draftsCompiled.length}</b>
                  <span>compiled</span>
                </div>
              </div>
            )}
          </div>

          {step === 0 ? (
            showDraftPicker && existingDrafts.length > 0 ? (
              <aside className="wr-ledger wr-glass">
                <h3>
                  <span className="wr-livedot" /> Pick up where you left off
                  <button
                    onClick={() => setShowDraftPicker(false)}
                    className="ml-auto text-[11px] font-semibold text-white/50 hover:text-white normal-case tracking-normal"
                  >
                    Dismiss
                  </button>
                </h3>
                <p className="text-xs text-white/60 mt-1">
                  Drafts save at every step. Compiled scenarios can be re-run through the compiler.
                </p>
                {draftsInProgress.length > 0 && (
                  <>
                    <div className="lgrp">In progress · {draftsInProgress.length}</div>
                    <div className="max-h-56 overflow-y-auto">{draftsInProgress.map(draftRow)}</div>
                  </>
                )}
                {draftsCompiled.length > 0 && (
                  <>
                    <div className="lgrp">Compiled · {draftsCompiled.length}</div>
                    <div className="max-h-40 overflow-y-auto">{draftsCompiled.map(draftRow)}</div>
                  </>
                )}
              </aside>
            ) : null
          ) : (
            <aside className="wr-brief wr-glass self-end">
              <h5>Scenario so far</h5>
              <div className="row">
                <WrIcon name="hazard" /> Incident <b>{incidentLabel ?? <span>not set</span>}</b>
              </div>
              <div className="row">
                <WrIcon name="users" /> Teams{' '}
                <b>
                  {teams.length > 0 ? (
                    `${teams.length} team${teams.length === 1 ? '' : 's'}`
                  ) : (
                    <span>{step === 2 && teamsLoading ? 'suggesting…' : 'suggested next'}</span>
                  )}
                </b>
              </div>
              <div className="row">
                <WrIcon name="pin" /> Scene{' '}
                <b>{rtsSceneId ? 'saved' : <span>not laid out</span>}</b>
              </div>
              <div className="row">
                <WrIcon name="map" /> Location{' '}
                <b>
                  {geoResult ? (
                    String(
                      (geoResult as Record<string, unknown>).display_name ??
                        (sceneConfig?.locationDescription as string | undefined) ??
                        'validated',
                    ).slice(0, 34)
                  ) : (
                    <span>
                      {(sceneConfig?.locationDescription as string | undefined)?.slice(0, 34) ??
                        'not set'}
                    </span>
                  )}
                </b>
              </div>
              <div className="row">
                <WrIcon name="doc" /> Research{' '}
                <b>{researchResults ? 'complete' : <span>pending</span>}</b>
              </div>
            </aside>
          )}
        </div>
      </header>

      <main className="wr-wrap">
        <section className={`wr-map ${step === 3 ? 'flush' : ''}`}>
          {step === 0 && (
            <>
              <h2>Choose a path</h2>
              <p className="sub">
                Each path has its own steps; both end in the same library with the same card, detail
                view and edit lock.
              </p>
              <div className="wr-paths">
                <button
                  type="button"
                  className={`wr-path wr-reveal ${simMode === 'field_ops' ? 'on' : ''}`}
                  style={{ '--g': 'var(--brand)', '--i': 0 } as CSSProperties}
                  onClick={() => setSimMode('field_ops')}
                  aria-pressed={simMode === 'field_ops'}
                >
                  <div className="band wr-artband">
                    <img className="wr-art" src={SHELL_ART.pathField} alt="" />
                    <div className="kicker">
                      <WrIcon name="map" /> Field operations
                      <span className="pick">
                        {simMode === 'field_ops' && <WrIcon name="check" />}
                      </span>
                    </div>
                    <h3>Teams on the ground</h3>
                    <p>
                      Bombing, armed attack, CBRN. A real location, a scene you lay out, hazards and
                      casualties that evolve, and response teams working the map in real time.
                    </p>
                  </div>
                  <div className="body">
                    <div>
                      <h5>You define</h5>
                      <div className="chips">
                        <span>
                          <WrIcon name="hazard" size={12} /> Incident type
                        </span>
                        <span>
                          <WrIcon name="users" size={12} /> Response teams
                        </span>
                        <span>
                          <WrIcon name="pin" size={12} /> Scene &amp; location
                        </span>
                      </div>
                    </div>
                    <div>
                      <h5>We generate</h5>
                      <div className="chips">
                        <span>Hazards</span>
                        <span>Casualties</span>
                        <span>Injects</span>
                        <span>Doctrines</span>
                      </div>
                    </div>
                    <div className="route">
                      <b>Incident</b>
                      <span className="arrow">›</span>Teams<span className="arrow">›</span>Scene
                      editor
                      <span className="arrow">›</span>Location<span className="arrow">›</span>
                      Research
                      <span className="arrow">›</span>Compile
                      <span className="dur">
                        <WrIcon name="clock" size={12} /> ~20 min to build
                      </span>
                    </div>
                  </div>
                  <div className="ft">
                    <span className="who">
                      For emergency services, security, facilities and site teams.
                    </span>
                    <span className={`wr-btn ${simMode === 'field_ops' ? 'accent' : ''}`}>
                      {simMode === 'field_ops' ? 'Selected' : 'Choose'}{' '}
                      <WrIcon name={simMode === 'field_ops' ? 'check' : 'arrow'} />
                    </span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`wr-path wr-reveal ${simMode === 'social_media' ? 'on' : ''}`}
                  style={{ '--g': 'var(--accent)', '--i': 1 } as CSSProperties}
                  onClick={() => setSimMode('social_media')}
                  aria-pressed={simMode === 'social_media'}
                >
                  <div className="band wr-artband">
                    <img className="wr-art" src={SHELL_ART.pathCorporate} alt="" />
                    <div className="kicker">
                      <WrIcon name="phone" /> Corporate crisis
                      <span className="pick">
                        {simMode === 'social_media' && <WrIcon name="check" />}
                      </span>
                    </div>
                    <h3>Teams on the phone</h3>
                    <p>
                      A reputational, labour, safety or data crisis told through feeds, news,
                      inboxes and calls. Multiple offices and countries, pressure groups, rivals —
                      and executives who decide by communicating.
                    </p>
                  </div>
                  <div className="body">
                    <div>
                      <h5>You define</h5>
                      <div className="chips">
                        <span>
                          <WrIcon name="doc" size={12} /> What happened
                        </span>
                        <span>
                          <WrIcon name="building" size={12} /> Organisations &amp; teams
                        </span>
                        <span>
                          <WrIcon name="fist" size={12} /> Pressure groups
                        </span>
                        <span>
                          <WrIcon name="swords" size={12} /> Rivals
                        </span>
                      </div>
                    </div>
                    <div>
                      <h5>We generate</h5>
                      <div className="chips">
                        <span>Contacts</span>
                        <span>Crowd</span>
                        <span>Injects</span>
                        <span>Fact sheet</span>
                      </div>
                    </div>
                    <div className="route">
                      <b>Setup</b>
                      <span className="arrow">›</span>Build<span className="arrow">›</span>Review
                      &amp; compile
                      <span className="dur">
                        <WrIcon name="clock" size={12} /> ~12 min to build
                      </span>
                    </div>
                  </div>
                  <div className="ft">
                    <span className="who">
                      For communications, legal, HR, operations and leadership teams.
                    </span>
                    <span className={`wr-btn ${simMode === 'social_media' ? 'accent' : ''}`}>
                      {simMode === 'social_media' ? 'Selected' : 'Choose'}{' '}
                      <WrIcon name={simMode === 'social_media' ? 'check' : 'arrow'} />
                    </span>
                  </div>
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="wr-groups">
                {INCIDENT_GROUPS.map((group) => {
                  const groupTypes = INCIDENT_TYPES.filter((t) => t.group === group);
                  const fam = GROUP_FAMILY[group];
                  return (
                    <div
                      key={group}
                      className="wr-grp"
                      style={{ '--g': fam.colour } as CSSProperties}
                    >
                      <header>
                        <div className="wr-tile">
                          <WrIcon name={fam.icon} size={14} />
                        </div>
                        <h4>{group}</h4>
                        <span className="n">{groupTypes.length}</span>
                      </header>
                      <div className="tiles">
                        {groupTypes.map((t) => {
                          const isSelected = incidentType === t.id;
                          const isDisabled = !t.enabled;
                          return (
                            <button
                              type="button"
                              key={t.id}
                              onClick={() => {
                                if (isDisabled) return;
                                setIncidentType(t.id);
                                setCustomIncidentText('');
                              }}
                              disabled={isDisabled}
                              title={isDisabled ? 'Available soon' : t.label}
                              className={`wr-inc ${isSelected ? 'on' : ''} ${isDisabled ? 'soon' : ''}`}
                            >
                              <div className={`wr-tile ${isSelected ? '' : 'soft'}`}>
                                <WrIcon name={INCIDENT_ICON[t.id] ?? 'hazard'} size={16} />
                              </div>
                              <div>
                                <div className="nm">{t.label}</div>
                                <div className="ds">{INCIDENT_HINT[t.id] ?? ''}</div>
                              </div>
                              {isDisabled ? (
                                <span className="soon">Soon</span>
                              ) : isSelected ? (
                                <WrIcon name="check" size={16} className="pick" />
                              ) : (
                                <span />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="wr-custom" style={{ '--g': 'var(--accent)' } as CSSProperties}>
                <div className="wr-tile">
                  <WrIcon name="sparkle" size={18} />
                </div>
                <div>
                  <h4>Or describe your own</h4>
                  <p>
                    Anything explosive-based works today — the type is inferred from what you write.
                  </p>
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
                    placeholder="e.g., IED hidden in a vehicle outside a government building during a state visit…"
                    className="wr-field"
                  />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              {teamsLoading && (
                <p className="text-sm text-muted animate-pulse mb-4">
                  Suggesting teams for {incidentLabel ?? incidentType}…
                </p>
              )}
              <div className="wr-teams">
                {teams.map((t, i) => (
                  <div
                    key={i}
                    className="wr-team"
                    style={{ '--g': TEAM_FAMILY[i % TEAM_FAMILY.length] } as CSSProperties}
                  >
                    <div className="acts">
                      <button
                        type="button"
                        onClick={() => removeTeam(i)}
                        disabled={teams.length <= 1}
                        className="wr-btn sm ghost icon"
                        aria-label={`Remove ${t.team_name}`}
                        title="Remove team"
                      >
                        <WrIcon name="x" />
                      </button>
                    </div>
                    <div className="id">
                      <div className="wr-tile">
                        <WrIcon name={teamIcon(t.team_name)} size={17} />
                      </div>
                      <div className="min-w-0">
                        <div className="nm">{t.team_name}</div>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={t.team_description}
                      onChange={(e) => updateTeam(i, 'team_description', e.target.value)}
                      placeholder="Team description"
                      className="wr-field"
                      style={{ fontSize: 12.5, padding: '8px 10px' }}
                    />
                    <div className="ctl">
                      Players
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={t.min_participants}
                        onChange={(e) =>
                          updateTeam(i, 'min_participants', parseInt(e.target.value, 10) || 1)
                        }
                        aria-label="Minimum players"
                      />
                      –
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={t.max_participants}
                        onChange={(e) =>
                          updateTeam(i, 'max_participants', parseInt(e.target.value, 10) || 10)
                        }
                        aria-label="Maximum players"
                      />
                      <button
                        type="button"
                        onClick={() => updateTeam(i, 'is_investigative', !t.is_investigative)}
                        className={`inv ${t.is_investigative ? 'on' : ''}`}
                        aria-pressed={t.is_investigative}
                      >
                        {t.is_investigative && <WrIcon name="search" size={12} />} Investigative
                      </button>
                    </div>
                  </div>
                ))}
                <div className="relative">
                  <button
                    type="button"
                    className="wr-add h-full"
                    onClick={() => setShowAddTeam(!showAddTeam)}
                    style={{ '--g': 'var(--brand)' } as CSSProperties}
                  >
                    <div>
                      <WrIcon name="plus" size={24} />
                      <div className="mt-2">Add a team from the inventory</div>
                      <small>
                        {TEAM_INVENTORY.filter(
                          (inv) => !teams.some((t) => t.team_name === inv.name),
                        )
                          .map((inv) => inv.name)
                          .slice(0, 4)
                          .join(' · ')}
                      </small>
                    </div>
                  </button>
                  {showAddTeam && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-xl shadow-lg z-10 max-h-64 overflow-y-auto">
                      {TEAM_INVENTORY.filter(
                        (inv) => !teams.some((t) => t.team_name === inv.name),
                      ).map((inv) => (
                        <button
                          key={inv.name}
                          onClick={() => addTeamFromInventory(inv.name)}
                          className="block w-full text-left px-4 py-2.5 text-xs text-ink hover:bg-surface-2 border-b border-border last:border-b-0"
                        >
                          <div className="font-bold flex items-center gap-2">
                            <WrIcon name={teamIcon(inv.name)} size={12} /> {inv.name}
                          </div>
                          <div className="text-[11px] text-muted mt-0.5">{inv.description}</div>
                        </button>
                      ))}
                      {TEAM_INVENTORY.filter((inv) => !teams.some((t) => t.team_name === inv.name))
                        .length === 0 && (
                        <div className="px-4 py-2 text-xs text-muted">All teams added</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <div className="w-full" style={{ height: 'calc(100vh - 240px)', minHeight: 350 }}>
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
            <LocationValidationStep
              geoResult={geoResult}
              onUpdate={setGeoResult}
              sceneConfig={sceneConfig}
              loading={geoLoading}
              error={geoError}
            />
          )}

          {step === 6 && (
            <ResearchStep
              wizardDraftId={wizardDraftId}
              onComplete={(data) => setResearchResults(data)}
            />
          )}

          {step === 7 && (
            <CompileStep wizardDraftId={wizardDraftId} onComplete={(id) => setScenarioId(id)} />
          )}
        </section>

        {/* Navigation */}
        <div className="wr-ctabar sticky">
          <button onClick={goBack} disabled={!canGoBack} className="wr-btn ghost">
            <WrIcon name="arrow-l" /> Back
          </button>
          <span className="hint">
            Step <b>{step === 0 ? 1 : fieldStepIndex + 1}</b> of{' '}
            {step === 0
              ? simMode === 'social_media'
                ? 4
                : FIELD_STEPS.length + 1
              : FIELD_STEPS.length}
            {step === 0 && simMode === 'social_media' && (
              <>
                {' '}
                · Corporate crisis selected — next is <b>Setup</b>, where you describe the crisis.
              </>
            )}
            {step === 0 && simMode === 'field_ops' && (
              <>
                {' '}
                · Field operations selected — next is <b>Incident</b>.
              </>
            )}
            {step === 1 && incidentLabel && (
              <>
                {' '}
                · <b>{incidentLabel}</b> selected.
              </>
            )}
            {step === 2 && (
              <>
                {' '}
                · {teams.length} team{teams.length === 1 ? '' : 's'}.
              </>
            )}
          </span>
          <span className="grow" />
          {step > 0 && step < 7 && (
            <button onClick={() => void saveDraftState(step)} className="wr-btn ghost">
              <WrIcon name="save" /> Save draft
            </button>
          )}
          {step === 7 ? (
            scenarioId ? (
              <a href="/scenarios" className="wr-btn accent lg">
                View scenarios <WrIcon name="arrow" />
              </a>
            ) : (
              <span className="hint">Compile the scenario above to finish</span>
            )
          ) : (
            <button onClick={goNext} disabled={!canGoNext} className="wr-btn accent lg">
              {primaryLabel[step] ?? 'Next'} <WrIcon name="arrow" />
            </button>
          )}
        </div>
      </main>
    </div>
  );
};
