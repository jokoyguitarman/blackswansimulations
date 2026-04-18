import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { VoiceMicButton } from '../components/VoiceMicButton';
import { LocationPicker, type PickedLocation } from '../components/WarRoom/LocationPicker';
import { SceneSetup, type SceneSetupResult } from '../components/WarRoom/SceneSetup';
import { SceneDesigner, type SceneDesignerResult } from '../components/WarRoom/SceneDesigner';
import { createSceneConfig } from '../lib/rts/sceneConfigApi';

type TeamEntry = {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
  is_investigative?: boolean;
};

type StandardsFinding = {
  domain: string;
  source: string;
  key_points: string[];
  decision_thresholds?: string;
};

type TeamWorkflow = {
  endgame: string;
  steps: string[];
  personnel_ratios?: Record<string, string>;
  sop_checklist?: string[];
};

const WAR_ROOM_LABEL_MAX = 72;
function warRoomShortLabel(raw: string, fallback: string): string {
  const s = (raw || fallback).trim() || fallback;
  if (s.length <= WAR_ROOM_LABEL_MAX) return s;
  return `${s.slice(0, WAR_ROOM_LABEL_MAX - 1)}…`;
}

type GeocodeData = {
  lat: number;
  lng: number;
  display_name: string;
};

type OsmPoi = { name: string; lat: number; lng: number; address?: string };

type OsmVicinityData = {
  hospitals?: OsmPoi[];
  police?: OsmPoi[];
  fire_stations?: OsmPoi[];
};

type WizardDoctrines = {
  perTeamDoctrines: Record<string, StandardsFinding[]>;
  teamWorkflows: Record<string, TeamWorkflow>;
};

const SCENARIO_TYPES = [
  { id: 'open_field_shooting', label: 'Open-field shooting' },
  { id: 'knife_attack', label: 'Knife attack' },
  { id: 'gas_attack', label: 'Gas attack' },
  { id: 'kidnapping', label: 'Kidnapping' },
  { id: 'car_bomb', label: 'Car bomb / VBIED' },
  { id: 'bombing', label: 'Bombing (open-air)' },
  { id: 'bombing_mall', label: 'Mall bombing' },
  { id: 'suicide_bombing', label: 'Suicide bombing (PBIED)' },
  { id: 'vehicle_ramming', label: 'Vehicle ramming attack' },
  { id: 'poisoning', label: 'Poisoning / contamination' },
  { id: 'infrastructure_attack', label: 'Infrastructure attack' },
  { id: 'hostage_siege', label: 'Hostage siege / barricade' },
  { id: 'hijacking', label: 'Hijacking' },
  { id: 'arson', label: 'Arson / deliberate fire' },
  { id: 'assassination', label: 'Assassination (public venue)' },
  { id: 'stampede_crush', label: 'Concert stampede / crush' },
  { id: 'active_shooter', label: 'Active shooter (enclosed)' },
  { id: 'biohazard', label: 'Biological attack / biohazard' },
  { id: 'nuclear_plant_leak', label: 'Nuclear plant leak / radiation release' },
];

const SETTINGS = [
  { id: 'beach', label: 'Beach' },
  { id: 'subway', label: 'Subway / Metro' },
  { id: 'mall', label: 'Mall' },
  { id: 'resort', label: 'Resort' },
  { id: 'hotel', label: 'Hotel' },
  { id: 'train', label: 'Train' },
  { id: 'open_field', label: 'Open field' },
  { id: 'stadium', label: 'Stadium' },
  { id: 'concert', label: 'Concert venue' },
  { id: 'festival', label: 'Festival / outdoor event' },
  { id: 'government', label: 'Government building' },
  { id: 'conference', label: 'Conference centre' },
  { id: 'airport', label: 'Airport' },
  { id: 'school', label: 'School / University' },
  { id: 'hospital', label: 'Hospital' },
  { id: 'embassy', label: 'Embassy / Diplomatic' },
  { id: 'power_plant', label: 'Power Plant / Industrial Facility' },
];

const TERRAINS = [
  { id: 'jungle', label: 'Jungle' },
  { id: 'mountain', label: 'Mountain' },
  { id: 'coastal', label: 'Coastal' },
  { id: 'desert', label: 'Desert' },
  { id: 'urban', label: 'Urban' },
  { id: 'rural', label: 'Rural' },
  { id: 'swamp', label: 'Swamp' },
  { id: 'island', label: 'Island' },
];

const INJECT_PRESSURE_TYPES = [
  { id: 'political_interference', group: 'Political & Authority', label: 'Political interference' },
  { id: 'command_chain_conflict', group: 'Political & Authority', label: 'Command chain conflict' },
  {
    id: 'jurisdictional_turf_war',
    group: 'Political & Authority',
    label: 'Jurisdictional turf war',
  },
  { id: 'diplomatic_incident', group: 'Political & Authority', label: 'Diplomatic incident' },
  { id: 'hostile_media_ambush', group: 'Media & Information', label: 'Hostile media ambush' },
  { id: 'viral_misinformation', group: 'Media & Information', label: 'Viral misinformation' },
  { id: 'social_media_firestorm', group: 'Media & Information', label: 'Social media firestorm' },
  { id: 'information_blackout', group: 'Media & Information', label: 'Comms failure / blackout' },
  {
    id: 'ethnic_religious_tension',
    group: 'Community & Social',
    label: 'Ethnic / religious tension',
  },
  { id: 'vigilante_behavior', group: 'Community & Social', label: 'Vigilante behavior' },
  { id: 'cultural_sensitivity', group: 'Community & Social', label: 'Cultural sensitivity clash' },
  { id: 'language_barrier', group: 'Community & Social', label: 'Language barrier crisis' },
  { id: 'family_intrusion', group: 'Human & Emotional', label: 'Family intrusion' },
  { id: 'vip_privilege', group: 'Human & Emotional', label: 'VIP demanding privilege' },
  { id: 'mass_grief_event', group: 'Human & Emotional', label: 'Mass grief event' },
  { id: 'ethical_dilemma', group: 'Human & Emotional', label: 'Ethical dilemma' },
  { id: 'mental_health_crisis', group: 'Human & Emotional', label: 'Mental health crisis' },
  { id: 'power_grid_failure', group: 'Infrastructure & Technical', label: 'Power grid failure' },
  {
    id: 'water_contamination',
    group: 'Infrastructure & Technical',
    label: 'Water / utility disruption',
  },
  { id: 'cyber_attack', group: 'Infrastructure & Technical', label: 'Cyber attack' },
  { id: 'transport_collapse', group: 'Infrastructure & Technical', label: 'Transport collapse' },
  {
    id: 'structural_collapse',
    group: 'Infrastructure & Technical',
    label: 'Structural collapse risk',
  },
  { id: 'weather_escalation', group: 'Environmental & Hazards', label: 'Weather escalation' },
  { id: 'hazmat_discovery', group: 'Environmental & Hazards', label: 'Secondary hazmat discovery' },
  { id: 'fire_spread', group: 'Environmental & Hazards', label: 'Fire spread' },
  { id: 'environmental_cascade', group: 'Environmental & Hazards', label: 'Environmental cascade' },
  {
    id: 'supply_chain_disruption',
    group: 'Operational & Supply',
    label: 'Supply chain disruption',
  },
  { id: 'hospital_overflow', group: 'Operational & Supply', label: 'Hospital capacity overflow' },
  {
    id: 'personnel_attrition',
    group: 'Operational & Supply',
    label: 'Personnel fatigue / attrition',
  },
  { id: 'equipment_malfunction', group: 'Operational & Supply', label: 'Equipment malfunction' },
  { id: 'impersonation', group: 'Trust & Insider', label: 'Credential fraud / impersonation' },
  { id: 'insider_leak', group: 'Trust & Insider', label: 'Insider intelligence leak' },
  { id: 'sabotage', group: 'Trust & Insider', label: 'Equipment sabotage' },
  { id: 'friendly_fire', group: 'Trust & Insider', label: 'Friendly fire / blue-on-blue' },
  { id: 'stampede_crush', group: 'Trust & Insider', label: 'Stampede or crush risk' },
  { id: 'evacuation_refusal', group: 'Trust & Insider', label: 'Evacuation refusal' },
];

const SCENARIO_INJECT_RELEVANCE: Record<string, string[]> = {
  knife_attack: [
    'vigilante_behavior',
    'family_intrusion',
    'hostile_media_ambush',
    'viral_misinformation',
    'mental_health_crisis',
    'ethical_dilemma',
    'stampede_crush',
    'impersonation',
  ],
  active_shooter: [
    'command_chain_conflict',
    'hostile_media_ambush',
    'viral_misinformation',
    'social_media_firestorm',
    'family_intrusion',
    'ethical_dilemma',
    'friendly_fire',
    'hospital_overflow',
    'stampede_crush',
  ],
  open_field_shooting: [
    'command_chain_conflict',
    'hostile_media_ambush',
    'social_media_firestorm',
    'family_intrusion',
    'hospital_overflow',
    'stampede_crush',
    'personnel_attrition',
    'supply_chain_disruption',
  ],
  car_bomb: [
    'structural_collapse',
    'fire_spread',
    'hazmat_discovery',
    'hospital_overflow',
    'hostile_media_ambush',
    'political_interference',
    'command_chain_conflict',
    'supply_chain_disruption',
    'personnel_attrition',
  ],
  bombing: [
    'structural_collapse',
    'fire_spread',
    'hazmat_discovery',
    'hospital_overflow',
    'hostile_media_ambush',
    'political_interference',
    'command_chain_conflict',
    'supply_chain_disruption',
  ],
  bombing_mall: [
    'structural_collapse',
    'fire_spread',
    'stampede_crush',
    'hospital_overflow',
    'hostile_media_ambush',
    'family_intrusion',
    'social_media_firestorm',
    'evacuation_refusal',
  ],
  suicide_bombing: [
    'ethnic_religious_tension',
    'political_interference',
    'hostile_media_ambush',
    'viral_misinformation',
    'hospital_overflow',
    'ethical_dilemma',
    'cultural_sensitivity',
  ],
  vehicle_ramming: [
    'hostile_media_ambush',
    'viral_misinformation',
    'family_intrusion',
    'hospital_overflow',
    'stampede_crush',
    'ethnic_religious_tension',
    'vigilante_behavior',
  ],
  gas_attack: [
    'hazmat_discovery',
    'environmental_cascade',
    'hospital_overflow',
    'information_blackout',
    'political_interference',
    'supply_chain_disruption',
    'evacuation_refusal',
    'personnel_attrition',
  ],
  arson: [
    'fire_spread',
    'structural_collapse',
    'environmental_cascade',
    'evacuation_refusal',
    'hospital_overflow',
    'hostile_media_ambush',
    'personnel_attrition',
  ],
  poisoning: [
    'hospital_overflow',
    'supply_chain_disruption',
    'viral_misinformation',
    'social_media_firestorm',
    'political_interference',
    'information_blackout',
    'water_contamination',
  ],
  kidnapping: [
    'political_interference',
    'diplomatic_incident',
    'hostile_media_ambush',
    'family_intrusion',
    'vip_privilege',
    'insider_leak',
    'ethical_dilemma',
  ],
  hostage_siege: [
    'command_chain_conflict',
    'jurisdictional_turf_war',
    'hostile_media_ambush',
    'family_intrusion',
    'ethical_dilemma',
    'friendly_fire',
    'insider_leak',
    'political_interference',
  ],
  hijacking: [
    'command_chain_conflict',
    'jurisdictional_turf_war',
    'diplomatic_incident',
    'political_interference',
    'hostile_media_ambush',
    'family_intrusion',
    'ethical_dilemma',
  ],
  infrastructure_attack: [
    'power_grid_failure',
    'water_contamination',
    'cyber_attack',
    'environmental_cascade',
    'political_interference',
    'information_blackout',
    'supply_chain_disruption',
    'transport_collapse',
  ],
  stampede_crush: [
    'stampede_crush',
    'hospital_overflow',
    'hostile_media_ambush',
    'social_media_firestorm',
    'family_intrusion',
    'mass_grief_event',
    'personnel_attrition',
    'evacuation_refusal',
  ],
  biohazard: [
    'hazmat_discovery',
    'environmental_cascade',
    'hospital_overflow',
    'information_blackout',
    'viral_misinformation',
    'evacuation_refusal',
    'supply_chain_disruption',
    'personnel_attrition',
  ],
  assassination: [
    'political_interference',
    'diplomatic_incident',
    'command_chain_conflict',
    'hostile_media_ambush',
    'insider_leak',
    'vip_privilege',
    'ethical_dilemma',
  ],
};

const GENERATION_PHASES: { id: string; label: string; desc: string }[] = [
  { id: 'parsing', label: 'Parsing', desc: 'Classifying scenario type, setting, terrain' },
  { id: 'geocoding', label: 'Geocoding', desc: 'Resolving location coordinates' },
  { id: 'case_research', label: 'Case research', desc: 'Similar real-world incidents' },
  { id: 'osm', label: 'Map data', desc: 'Hospitals, police, fire stations, routes' },
  { id: 'area_research', label: 'Area research', desc: 'Geography, agencies, access' },
  { id: 'standards_research', label: 'Standards research', desc: 'ICS, triage, protocols' },
  { id: 'ai', label: 'AI generation', desc: 'Teams, injects, objectives, locations' },
  { id: 'persist', label: 'Persisting', desc: 'Saving world to database' },
];

export const WarRoom = () => {
  const { isTrainer } = useRoleVisibility();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [scenarioType, setScenarioType] = useState('');
  const [setting, setSetting] = useState('');
  const [terrain, setTerrain] = useState('');
  const [location, setLocation] = useState('');
  const [complexityTier] = useState<'minimal' | 'standard' | 'full' | 'rich'>('rich');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [includeAdversaryPursuit, setIncludeAdversaryPursuit] = useState(false);
  const [injectProfiles, setInjectProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useStructured, setUseStructured] = useState(false);
  const [progressPhase, setProgressPhase] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string>('');
  const [step, setStep] = useState<1 | 2 | 3 | 35 | 4 | 5 | 11 | 12 | 13 | 14 | 15 | 16>(11);
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [resolvedScenarioType, setResolvedScenarioType] = useState<string | null>(null);
  const [resolvedWeaponClass, setResolvedWeaponClass] = useState<string | null>(null);
  const [secondaryDevicesCount, setSecondaryDevicesCount] = useState(0);
  const [realBombsCount, setRealBombsCount] = useState(0);

  // Wizard mode
  const [wizardMode, setWizardMode] = useState(false);
  const [geocodeData, setGeocodeData] = useState<GeocodeData | null>(null);
  const [osmVicinity, setOsmVicinity] = useState<OsmVicinityData | null>(null);
  const [areaSummary, setAreaSummary] = useState<string | null>(null);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [doctrines, setDoctrines] = useState<WizardDoctrines | null>(null);
  const [doctrinesLoading, setDoctrinesLoading] = useState(false);
  const [wizardScenarioId, setWizardScenarioId] = useState<string | null>(null);
  const [wizardDraftId, setWizardDraftId] = useState<string | null>(null);
  const [manualCoords, setManualCoords] = useState<PickedLocation | null>(null);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [deteriorationPreview, setDeteriorationPreview] = useState<Awaited<
    ReturnType<typeof api.warroom.wizardDeteriorationPreview>
  > | null>(null);
  const [deteriorationLoading, setDeteriorationLoading] = useState(false);
  /** First-time persist from step 4→5 (avoid full-screen loading so spawn UI stays visible). */
  const [wizardScenarioPersisting, setWizardScenarioPersisting] = useState(false);
  const [sceneConfig, setSceneConfig] = useState<SceneSetupResult | null>(null);
  const [rtsSceneId, setRtsSceneId] = useState<string | null>(null);

  // ── Manual Design mode state ──────────────────────────────────────────
  const [manualSceneResult, setManualSceneResult] = useState<SceneDesignerResult | null>(null);
  const [aiEnrichmentLoading, setAiEnrichmentLoading] = useState(false);
  const [aiEnrichmentResult, setAiEnrichmentResult] = useState<string | null>(null);

  const [searchParams] = useSearchParams();
  const draftResumeLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    const draftParam = searchParams.get('draft');
    if (!draftParam || !isTrainer) return;
    if (draftResumeLoadedRef.current === draftParam) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.warroom.wizardDraftGet(draftParam);
        if (cancelled) return;
        const sid = typeof data.scenario_id === 'string' ? data.scenario_id : null;
        const dp = data.deterioration_preview;
        if (
          sid &&
          dp &&
          typeof dp === 'object' &&
          dp !== null &&
          Array.isArray((dp as { enrichedHazards?: unknown }).enrichedHazards)
        ) {
          draftResumeLoadedRef.current = draftParam;
          setWizardDraftId(draftParam);
          setWizardScenarioId(sid);
          setDeteriorationPreview(
            dp as Awaited<ReturnType<typeof api.warroom.wizardDeteriorationPreview>>,
          );
          setWizardMode(true);
          setStep(5);
        }
      } catch {
        // invalid id or network
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, isTrainer]);

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

  const buildOptions = () => {
    const opts: Parameters<typeof api.warroom.generateStream>[0] = {
      complexity_tier: complexityTier,
      duration_minutes: durationMinutes,
      include_adversary_pursuit: includeAdversaryPursuit,
    };
    if (injectProfiles.length >= 2) opts.inject_profiles = injectProfiles;
    if (secondaryDevicesCount > 0) {
      opts.secondary_devices_count = secondaryDevicesCount;
      opts.real_bombs_count = realBombsCount;
    }
    if (useStructured && scenarioType) {
      opts.scenario_type = scenarioType;
      opts.setting = setting || undefined;
      opts.terrain = terrain || undefined;
      opts.location = location || undefined;
    } else if (prompt.trim()) {
      opts.prompt = prompt.trim();
    }
    return opts;
  };

  const toggleInjectProfile = (id: string) => {
    setInjectProfiles((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      return [...prev, id];
    });
  };

  const recommendedProfileIds = resolvedScenarioType
    ? SCENARIO_INJECT_RELEVANCE[resolvedScenarioType] || []
    : [];

  const surpriseMeProfiles = () => {
    const pool =
      recommendedProfileIds.length > 0
        ? recommendedProfileIds
        : INJECT_PRESSURE_TYPES.map((t) => t.id);
    const count = Math.min(pool.length, 2 + Math.floor(Math.random() * 3));
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
    setInjectProfiles(shuffled);
  };

  const handleNext = async () => {
    setError(null);
    if (useStructured && !scenarioType) {
      setError('Select scenario type, setting, and terrain.');
      return;
    }
    if (!useStructured && !prompt.trim()) {
      setError('Provide a prompt or select scenario type, setting, and terrain.');
      return;
    }
    setTeamsLoading(true);
    try {
      const opts = buildOptions();
      const { data } = await api.warroom.suggestTeams(opts);
      const mappedTeams = data.suggested_teams.map((t: Record<string, unknown>) => ({
        team_name: t.team_name as string,
        team_description: (t.team_description as string) || '',
        min_participants: (t.min_participants as number) ?? 1,
        max_participants: (t.max_participants as number) ?? 10,
        is_investigative: (t.is_investigative as boolean) ?? false,
      }));
      setTeams(mappedTeams);
      if (wizardMode) {
        const draftInput = {
          ...opts,
          teams: mappedTeams.map((t) => ({
            team_name: t.team_name,
            team_description: t.team_description,
            min_participants: t.min_participants,
            max_participants: t.max_participants,
            is_investigative: t.is_investigative ?? false,
          })),
        };
        const { data: draftRes } = await api.warroom.wizardDraftCreate({ input: draftInput });
        setWizardDraftId(draftRes.draft_id);
      } else {
        setWizardDraftId(null);
      }
      if (data.scenario_type) setResolvedScenarioType(data.scenario_type);
      if (data.threat_profile?.weapon_class)
        setResolvedWeaponClass(data.threat_profile.weapon_class);
      setInjectProfiles([]);
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggested teams');
    } finally {
      setTeamsLoading(false);
    }
  };

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    setProgressPhase(null);
    setProgressMessage('');
    try {
      const options = buildOptions();
      options.teams = teams.map((t) => ({
        team_name: t.team_name,
        team_description: t.team_description,
        min_participants: t.min_participants,
        max_participants: t.max_participants,
        is_investigative: t.is_investigative ?? false,
      }));

      const { data: created } = await api.warroom.wizardDraftCreate({
        input: { ...options },
      });
      const draftId = created.draft_id;

      setProgressPhase('parsing');
      setProgressMessage('Parsing scenario and location…');
      await api.warroom.wizardDraftGeocodeValidate(draftId);

      setProgressPhase('standards_research');
      setProgressMessage('Researching standards and team workflows…');
      await api.warroom.wizardDraftResearchDoctrines(draftId);

      setProgressPhase('ai');
      setProgressMessage('Generating full scenario…');
      const { data: persisted } = await api.warroom.wizardDraftPersist(draftId);

      if (persisted.scenarioId) {
        setProgressPhase('persist');
        setProgressMessage('Scenario created successfully.');
        navigate(`/scenarios`);
      } else {
        setError('No scenario ID returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate scenario');
    } finally {
      setLoading(false);
    }
  };

  // --- Wizard Step Handlers ---

  const handleGeocodeValidate = useCallback(async () => {
    setError(null);
    setGeocodeLoading(true);
    try {
      const opts = buildOptions();
      const inputPayload: Record<string, unknown> = {
        ...opts,
        teams: teams.map((t) => ({
          team_name: t.team_name,
          team_description: t.team_description,
          min_participants: t.min_participants,
          max_participants: t.max_participants,
          is_investigative: t.is_investigative ?? false,
        })),
      };

      if (manualCoords) {
        inputPayload.geocode_override = {
          lat: manualCoords.lat,
          lng: manualCoords.lng,
          display_name: manualCoords.display_name,
        };
      }

      let draftId = wizardDraftId;
      if (!draftId) {
        const { data: created } = await api.warroom.wizardDraftCreate({ input: inputPayload });
        draftId = created.draft_id;
        setWizardDraftId(draftId);
      } else {
        await api.warroom.wizardDraftPatch(draftId, { input: inputPayload });
      }

      const { data } = await api.warroom.wizardDraftGeocodeValidate(draftId);
      setGeocodeData(data.geocode);
      setOsmVicinity(data.osmVicinity);
      setAreaSummary(data.areaSummary);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Geocode validation failed');
    } finally {
      setGeocodeLoading(false);
    }
  }, [teams, buildOptions, wizardDraftId, manualCoords]);

  const handleResearchDoctrines = useCallback(async () => {
    setError(null);
    setDoctrinesLoading(true);
    try {
      if (!wizardDraftId) {
        setError('Wizard draft missing. Go back to teams and continue.');
        return;
      }
      const opts = buildOptions();
      const inputPayload: Record<string, unknown> = {
        ...opts,
        teams: teams.map((t) => ({
          team_name: t.team_name,
          team_description: t.team_description,
          min_participants: t.min_participants,
          max_participants: t.max_participants,
          is_investigative: t.is_investigative ?? false,
        })),
      };
      if (geocodeData) {
        inputPayload.geocode_override = {
          lat: geocodeData.lat,
          lng: geocodeData.lng,
          display_name: geocodeData.display_name,
        };
      }
      if (sceneConfig) {
        inputPayload.scene_context = {
          building_name: sceneConfig.buildingName,
          exits_count: sceneConfig.exits.length,
          interior_walls_count: sceneConfig.interiorWalls.length,
          hazard_zones: sceneConfig.hazardZones.map(
            (hz: { hazardType: string; severity: string }) => `${hz.hazardType} (${hz.severity})`,
          ),
          stairwells_count: sceneConfig.stairwells.length,
          has_blast_site: !!sceneConfig.blastSite,
          casualty_clusters: sceneConfig.casualtyClusters.length,
          total_casualties: sceneConfig.casualtyClusters.reduce(
            (sum: number, c: { victims: unknown[] }) => sum + c.victims.length,
            0,
          ),
          pedestrian_count: sceneConfig.pedestrianCount,
          rts_scene_id: rtsSceneId,
        };
      }
      await api.warroom.wizardDraftPatch(wizardDraftId, { input: inputPayload });
      const { data } = await api.warroom.wizardDraftResearchDoctrines(wizardDraftId);
      setDoctrines({
        perTeamDoctrines: data.doctrines.perTeamDoctrines,
        teamWorkflows: data.doctrines.teamWorkflows,
      });
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Doctrine research failed');
    } finally {
      setDoctrinesLoading(false);
    }
  }, [teams, buildOptions, geocodeData, wizardDraftId, sceneConfig, rtsSceneId]);

  const handleDeteriorationPreview = useCallback(async () => {
    setError(null);
    setDeteriorationLoading(true);
    setDeteriorationPreview(null);
    setStep(5);
    const hadScenarioAlready = Boolean(wizardScenarioId);
    try {
      // Persist-first, DB-backed preview:
      // 1) Ensure the scenario (pins) exists in DB
      let scenarioId = wizardScenarioId;
      if (!scenarioId) {
        setWizardScenarioPersisting(true);
        setProgressPhase('ai');
        setProgressMessage('Generating scenario and saving to database…');

        if (!wizardDraftId) {
          throw new Error('Wizard draft missing. Go back to teams and continue.');
        }

        const options = buildOptions();
        const inputPayload: Record<string, unknown> = {
          ...options,
          teams: teams.map((t) => ({
            team_name: t.team_name,
            team_description: t.team_description,
            min_participants: t.min_participants,
            max_participants: t.max_participants,
            is_investigative: t.is_investigative ?? false,
          })),
        };
        if (geocodeData) {
          inputPayload.geocode_override = {
            lat: geocodeData.lat,
            lng: geocodeData.lng,
            display_name: geocodeData.display_name,
          };
        }

        await api.warroom.wizardDraftPatch(wizardDraftId, {
          input: inputPayload,
          ...(doctrines
            ? {
                validated_doctrines: {
                  perTeamDoctrines: doctrines.perTeamDoctrines,
                  teamWorkflows: doctrines.teamWorkflows,
                },
              }
            : {}),
        });

        const { data: persisted } = await api.warroom.wizardDraftPersist(wizardDraftId);
        scenarioId = persisted.scenarioId;
        if (!scenarioId) throw new Error('No scenario ID returned');
        setWizardScenarioId(scenarioId);
        setWizardScenarioPersisting(false);
      }

      // 2) Generate deterioration from DB pins (spawns + timelines)
      await api.scenarios.retryDeterioration(scenarioId, { force: hadScenarioAlready });

      // 3) Build preview from DB state
      const [scenRes, hazRes, casRes] = await Promise.all([
        api.scenarios.get(scenarioId),
        api.scenarios.getScenarioHazards(scenarioId).catch(() => ({ data: [] })),
        api.scenarios.getScenarioCasualties(scenarioId).catch(() => ({ data: [] })),
      ]);

      const hazards = (hazRes.data ?? []) as Array<Record<string, unknown>>;
      const casualties = (casRes.data ?? []) as Array<Record<string, unknown>>;

      const hazardIdToShortLabel = new Map<string, string>();
      for (const h of hazards) {
        const props = (h.properties ?? {}) as Record<string, unknown>;
        const raw = String(props.label ?? h.enriched_description ?? h.hazard_type ?? 'Hazard');
        hazardIdToShortLabel.set(
          String(h.id),
          warRoomShortLabel(raw, String(h.hazard_type ?? 'Hazard')),
        );
      }

      const enrichedHazards = hazards
        .map((h) => {
          const props = (h.properties ?? {}) as Record<string, unknown>;
          const raw = String(props.label ?? h.enriched_description ?? h.hazard_type ?? 'Hazard');
          const label = warRoomShortLabel(raw, String(h.hazard_type ?? 'Hazard'));
          const dt = (h.deterioration_timeline ?? {}) as Record<string, unknown>;
          return { hazard_label: label, deterioration_timeline: dt };
        })
        .filter((eh) => Object.keys(eh.deterioration_timeline ?? {}).length > 0);

      const enrichedCasualties = casualties
        .map((c, idx) => {
          const conds = (c.conditions ?? {}) as Record<string, unknown>;
          const raw = String(
            conds.visible_description ?? conds.injury_description ?? c.casualty_type ?? 'Casualty',
          );
          const label = warRoomShortLabel(raw, String(c.casualty_type ?? 'Casualty'));
          const timeline = (conds.deterioration_timeline ?? []) as Array<{
            at_minutes: number;
            description: string;
          }>;
          return { casualty_index: idx, casualty_label: label, deterioration_timeline: timeline };
        })
        .filter(
          (ec) => Array.isArray(ec.deterioration_timeline) && ec.deterioration_timeline.length > 0,
        );

      const spawnPins = [
        ...hazards
          .filter((h) => h.spawn_condition != null || h.parent_pin_id != null)
          .map((h) => {
            const props = (h.properties ?? {}) as Record<string, unknown>;
            const raw = String(
              props.label ?? h.enriched_description ?? h.hazard_type ?? 'Spawn hazard',
            );
            const label = warRoomShortLabel(raw, String(h.hazard_type ?? 'Spawn hazard'));
            const pid = h.parent_pin_id != null ? String(h.parent_pin_id) : '';
            const parentLabel = pid
              ? (hazardIdToShortLabel.get(pid) ?? `Parent ${pid.slice(0, 8)}…`)
              : '—';
            return {
              pin_type: 'hazard' as const,
              parent_pin_label: parentLabel,
              label,
              hazard_type: String(h.hazard_type ?? 'secondary_hazard'),
              lat_offset: 0,
              lng_offset: 0,
              appears_at_minutes: Number(h.appears_at_minutes ?? 0),
              spawn_condition: (h.spawn_condition ??
                ({
                  trigger: 'unknown',
                  at_minutes: Number(h.appears_at_minutes ?? 0),
                  unless_status: [],
                } as unknown)) as { trigger: string; at_minutes: number; unless_status: string[] },
              description: String(props.description ?? props.visible_description ?? label),
              properties: props,
            };
          }),
        ...casualties
          .filter((c) => c.spawn_condition != null || c.parent_pin_id != null)
          .map((c) => {
            const conds = (c.conditions ?? {}) as Record<string, unknown>;
            const raw = String(
              conds.visible_description ??
                conds.injury_description ??
                c.casualty_type ??
                'Spawn casualty',
            );
            const label = warRoomShortLabel(raw, String(c.casualty_type ?? 'Spawn casualty'));
            const pid = c.parent_pin_id != null ? String(c.parent_pin_id) : '';
            const parentLabel = pid
              ? (hazardIdToShortLabel.get(pid) ?? `Parent ${pid.slice(0, 8)}…`)
              : '—';
            return {
              pin_type: 'casualty' as const,
              parent_pin_label: parentLabel,
              label,
              casualty_type: String(c.casualty_type ?? 'patient'),
              lat_offset: 0,
              lng_offset: 0,
              appears_at_minutes: Number(c.appears_at_minutes ?? 0),
              spawn_condition: (c.spawn_condition ??
                ({
                  trigger: 'unknown',
                  at_minutes: Number(c.appears_at_minutes ?? 0),
                  unless_status: [],
                } as unknown)) as { trigger: string; at_minutes: number; unless_status: string[] },
              description: String(conds.visible_description ?? label),
              conditions: conds,
              headcount: (c.headcount as number | undefined) ?? 1,
            };
          }),
      ];

      const ik = ((scenRes.data as Record<string, unknown>)?.insider_knowledge ?? {}) as Record<
        string,
        unknown
      >;
      const cascadeNarrative = String(ik.cascade_narrative ?? '');

      const previewPayload = {
        enrichedHazards,
        enrichedCasualties,
        spawnPins,
        cascadeNarrative,
      };
      setDeteriorationPreview(previewPayload);

      if (wizardDraftId) {
        try {
          await api.warroom.wizardDraftPatch(wizardDraftId, {
            deterioration_preview: previewPayload,
            current_step: 5,
          });
        } catch {
          // preview still shown; draft cache is best-effort
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deterioration preview failed');
    } finally {
      setDeteriorationLoading(false);
      setWizardScenarioPersisting(false);
      setLoading(false);
    }
  }, [wizardScenarioId, wizardDraftId, teams, buildOptions, geocodeData, doctrines]);

  const updateTeam = (index: number, field: keyof TeamEntry, value: string | number) => {
    setTeams((prev) => prev.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  };
  const addTeam = () => {
    setTeams((prev) => [
      ...prev,
      {
        team_name: 'new_team',
        team_description: '',
        min_participants: 1,
        max_participants: 10,
      },
    ]);
  };
  const removeTeam = (index: number) => {
    setTeams((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="min-h-screen scanline">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4 mb-4">
          <Link
            to="/dashboard"
            className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow"
          >
            ← [HOME]
          </Link>
          <Link
            to="/scenarios"
            className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow"
          >
            ← [SCENARIOS]
          </Link>
        </div>
        <div className="military-border p-6 mb-6">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl terminal-text uppercase tracking-wider">
              [WAR_ROOM] Scenario Generator
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setWizardMode(false);
                  setStep(11);
                }}
                disabled={loading}
                className={`px-3 py-1 text-[10px] terminal-text uppercase tracking-wider border transition-all ${
                  !wizardMode && step >= 11
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                    : 'border-robotic-yellow/30 text-robotic-yellow/50 hover:border-robotic-yellow/60'
                }`}
              >
                [MANUAL DESIGN]
              </button>
              <button
                onClick={() => {
                  setWizardMode(true);
                  setStep(1);
                }}
                disabled={loading}
                className={`px-3 py-1 text-[10px] terminal-text uppercase tracking-wider border transition-all ${
                  wizardMode
                    ? 'border-cyan-500 bg-cyan-500/15 text-cyan-300'
                    : 'border-robotic-yellow/30 text-robotic-yellow/50 hover:border-robotic-yellow/60'
                }`}
              >
                [QUICK SETUP]
              </button>
            </div>
          </div>
          <p className="text-xs terminal-text text-robotic-yellow/70">
            {wizardMode
              ? 'Quick Setup: AI-assisted wizard with automated doctrine research and deterioration preview.'
              : step >= 11
                ? 'Manual Design: hands-on scene design with full control over buildings, hazards, casualties, and blast zones.'
                : 'Quick Generate: enter inputs and generate immediately.'}
          </p>
        </div>

        <div className={`military-border p-6 mb-6 ${step !== 1 ? 'hidden' : ''}`}>
          <div className="flex gap-4 mb-4">
            <button
              onClick={() => setUseStructured(false)}
              className={`px-4 py-2 text-xs terminal-text uppercase border ${
                !useStructured
                  ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                  : 'border-robotic-gray-200 text-robotic-yellow/70'
              }`}
            >
              Free-text prompt
            </button>
            <button
              onClick={() => setUseStructured(true)}
              className={`px-4 py-2 text-xs terminal-text uppercase border ${
                useStructured
                  ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                  : 'border-robotic-gray-200 text-robotic-yellow/70'
              }`}
            >
              Structured
            </button>
          </div>

          {!useStructured ? (
            <div className="mb-4">
              <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                [PROMPT] Describe your scenario (e.g. "Kidnapping at jungle resort in Bali")
              </label>
              <div className="relative">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Kidnapping at a jungle resort in Bali with ocean and jungle access"
                  className="w-full min-h-[120px] px-4 py-3 pr-14 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow placeholder-robotic-yellow/30 terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                  disabled={loading}
                />
                <div className="absolute top-2 right-2">
                  <VoiceMicButton
                    disabled={loading}
                    onTranscript={(text) => setPrompt((prev) => (prev ? `${prev} ${text}` : text))}
                  />
                </div>
              </div>
              <p className="mt-1 text-[10px] terminal-text text-robotic-yellow/40">
                Click the mic to dictate your scenario instead of typing
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                  [SCENARIO_TYPE]
                </label>
                <select
                  value={scenarioType}
                  onChange={(e) => setScenarioType(e.target.value)}
                  className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                  disabled={loading}
                >
                  <option value="">Select...</option>
                  {SCENARIO_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                    [SETTING]
                  </label>
                  <select
                    value={setting}
                    onChange={(e) => setSetting(e.target.value)}
                    className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                    disabled={loading}
                  >
                    <option value="">Select...</option>
                    {SETTINGS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                    [TERRAIN]
                  </label>
                  <select
                    value={terrain}
                    onChange={(e) => setTerrain(e.target.value)}
                    className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                    disabled={loading}
                  >
                    <option value="">Select...</option>
                    {TERRAINS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
                  [LOCATION] Real place (optional, e.g. "Bondi Beach, Sydney")
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Bali, Indonesia"
                  className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow placeholder-robotic-yellow/30 terminal-text text-sm focus:outline-none focus:border-robotic-yellow"
                  disabled={loading}
                />
              </div>
            </div>
          )}

          {/* Location Picker — browser-side Nominatim search */}
          <div className="border border-robotic-yellow/30 p-4 mt-6">
            <button
              type="button"
              onClick={() => setLocationPickerOpen((v) => !v)}
              className="w-full text-left flex items-center justify-between"
            >
              <h4 className="text-sm terminal-text uppercase text-robotic-yellow">
                [LOCATION SELECTION]
                {manualCoords && (
                  <span className="text-robotic-green ml-2 text-[10px] normal-case">
                    {manualCoords.lat.toFixed(4)}, {manualCoords.lng.toFixed(4)}
                  </span>
                )}
              </h4>
              <span className="text-robotic-yellow/50 text-xs terminal-text">
                {locationPickerOpen ? '[-]' : '[+]'}
              </span>
            </button>
            {!locationPickerOpen && (
              <p className="text-[10px] terminal-text text-robotic-yellow/40 mt-1">
                {manualCoords
                  ? 'Location set. Click to change.'
                  : 'Optional — search and select a real-world location for your scenario.'}
              </p>
            )}
            {locationPickerOpen && (
              <div className="mt-3">
                <LocationPicker onLocationChange={setManualCoords} initialLocation={manualCoords} />
              </div>
            )}
          </div>

          <div className="mt-6">
            <label className="block text-xs terminal-text text-robotic-yellow/70 mb-2">
              [DURATION] Game length in minutes
            </label>
            <select
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className="w-full px-4 py-3 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm focus:outline-none focus:border-robotic-yellow appearance-none"
              disabled={loading}
            >
              {Array.from({ length: Math.floor((240 - 20) / 5) + 1 }, (_, i) => 20 + i * 5).map(
                (m) => (
                  <option key={m} value={m}>
                    {m} minutes{m === 60 ? ' (default)' : m >= 120 ? ` (${m / 60}h)` : ''}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className="mt-6">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  includeAdversaryPursuit
                    ? 'bg-robotic-orange/60 border-robotic-orange'
                    : 'bg-black/50 border-robotic-yellow/50'
                } border`}
                onClick={() => !loading && setIncludeAdversaryPursuit(!includeAdversaryPursuit)}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
                    includeAdversaryPursuit
                      ? 'left-5 bg-robotic-orange'
                      : 'left-0.5 bg-robotic-yellow/50'
                  }`}
                />
              </div>
              <span className="text-xs terminal-text text-robotic-yellow/70 group-hover:text-robotic-yellow transition-colors">
                [ADVERSARY PURSUIT] Scenario involves a fleeing suspect or active adversary
              </span>
            </label>
            <p className="text-[10px] terminal-text text-robotic-yellow/40 mt-1 ml-[52px]">
              Generates pursuit decision tree, sighting injects, and witness reports. Auto-enabled
              if your prompt describes a chase or fleeing suspect.
            </p>
          </div>
        </div>

        {step === 2 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[CONFIGURE TEAMS]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Add, remove, or rename teams. These will be used for standards research and inject
              targeting.
            </p>
            <div className="space-y-3 mb-4">
              {teams.map((t, i) => (
                <div
                  key={i}
                  className="border border-robotic-yellow/50 p-4 bg-black/30 flex flex-col gap-2"
                >
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={t.team_name}
                      onChange={(e) => updateTeam(i, 'team_name', e.target.value)}
                      placeholder="team_name"
                      className="flex-1 px-3 py-2 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow terminal-text text-sm"
                      disabled={loading}
                    />
                    <button
                      type="button"
                      onClick={() => removeTeam(i)}
                      disabled={loading || teams.length <= 1}
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
                    disabled={loading}
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
                        disabled={loading}
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
                        disabled={loading}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setTeams((prev) =>
                          prev.map((team, idx) =>
                            idx === i
                              ? { ...team, is_investigative: !team.is_investigative }
                              : team,
                          ),
                        )
                      }
                      disabled={loading}
                      className={`ml-auto px-3 py-1 text-[10px] terminal-text uppercase tracking-wider border rounded transition-all ${
                        t.is_investigative
                          ? 'border-purple-500 bg-purple-500/20 text-purple-300'
                          : 'border-robotic-yellow/30 text-robotic-yellow/40 hover:border-purple-500/50 hover:text-purple-400'
                      }`}
                    >
                      {t.is_investigative ? '⬟ INVESTIGATIVE' : '○ INVESTIGATIVE'}
                    </button>
                  </div>
                  {/bomb|eod/i.test(t.team_name) && (
                    <div className="border-t border-robotic-yellow/20 pt-2 mt-1">
                      <p className="text-[10px] terminal-text text-robotic-orange/80 uppercase mb-2">
                        [SECONDARY DEVICE CHALLENGE]
                      </p>
                      <div className="flex gap-4 items-center flex-wrap">
                        <label className="flex items-center gap-2 text-xs terminal-text text-robotic-yellow/70">
                          Suspicious Devices:
                          <select
                            value={secondaryDevicesCount}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10);
                              setSecondaryDevicesCount(v);
                              if (realBombsCount > v) setRealBombsCount(v);
                            }}
                            className="w-16 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-sm"
                            disabled={loading}
                          >
                            {Array.from({ length: 11 }, (_, n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center gap-2 text-xs terminal-text text-robotic-yellow/70">
                          Real Bombs:
                          <select
                            value={realBombsCount}
                            onChange={(e) => setRealBombsCount(parseInt(e.target.value, 10))}
                            className="w-16 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-sm"
                            disabled={loading || secondaryDevicesCount === 0}
                          >
                            {Array.from({ length: secondaryDevicesCount + 1 }, (_, n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="text-[9px] terminal-text text-robotic-yellow/40 mt-1">
                        Devices are split between tip-based injects and hidden inside placed assets.
                        Real bombs detonate after 2 min if not rendered safe.
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addTeam}
              disabled={loading}
              className="text-xs terminal-text text-robotic-yellow/70 hover:text-robotic-yellow border border-robotic-yellow/50 px-3 py-2"
            >
              [+ ADD TEAM]
            </button>

            {/* Inject Profiles — now on step 2 with scenario-aware filtering */}
            <div className="mt-8 pt-6 border-t border-robotic-yellow/20">
              <div className="flex items-center justify-between mb-3">
                <label className="block text-xs terminal-text text-robotic-yellow/70">
                  [INJECT PROFILES] Select at least 2 challenge pressures
                  {injectProfiles.length > 0 && (
                    <span className="ml-2 text-robotic-orange">
                      ({injectProfiles.length}/
                      {recommendedProfileIds.length || INJECT_PRESSURE_TYPES.length} selected)
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={surpriseMeProfiles}
                    disabled={loading}
                    className="px-3 py-1 text-[10px] terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow/70 hover:text-robotic-yellow hover:border-robotic-yellow transition-colors"
                  >
                    [SURPRISE ME]
                  </button>
                  {injectProfiles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setInjectProfiles([])}
                      disabled={loading}
                      className="px-3 py-1 text-[10px] terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/50 hover:text-robotic-yellow transition-colors"
                    >
                      [CLEAR]
                    </button>
                  )}
                </div>
              </div>

              {resolvedScenarioType && (
                <p className="text-[10px] terminal-text text-robotic-yellow/50 mb-2">
                  Showing recommendations for{' '}
                  <span className="text-robotic-orange font-bold uppercase">
                    {resolvedScenarioType.replace(/_/g, ' ')}
                  </span>
                  {resolvedWeaponClass && (
                    <span className="text-robotic-yellow/40">
                      {' '}
                      ({resolvedWeaponClass.replace(/_/g, ' ')})
                    </span>
                  )}
                </p>
              )}

              {(() => {
                const availableTypes =
                  recommendedProfileIds.length > 0
                    ? INJECT_PRESSURE_TYPES.filter((t) => recommendedProfileIds.includes(t.id))
                    : INJECT_PRESSURE_TYPES;

                return (
                  <div className="max-h-[320px] overflow-y-auto border border-robotic-yellow/20 bg-black/30 p-3">
                    <div className="grid grid-cols-2 gap-1.5">
                      {availableTypes.map((t) => {
                        const selected = injectProfiles.includes(t.id);
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => !loading && toggleInjectProfile(t.id)}
                            className={`px-2 py-1.5 text-[11px] terminal-text text-left border transition-all ${
                              selected
                                ? 'border-robotic-orange bg-robotic-orange/15 text-robotic-orange'
                                : 'border-robotic-orange/30 text-robotic-yellow/70 hover:border-robotic-orange/50 hover:text-robotic-yellow/90 bg-robotic-orange/5'
                            }`}
                          >
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <p className="text-[10px] terminal-text text-robotic-yellow/40 mt-1.5">
                Shapes the thematic flavor of injects. Pick at least 2 for a blended challenge, or
                leave empty for default variety.
                {injectProfiles.length === 1 && (
                  <span className="text-robotic-orange ml-1">
                    Select at least 2 profiles or clear selection.
                  </span>
                )}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="military-border p-4 mb-6 border-robotic-orange">
            <p className="text-sm terminal-text text-robotic-orange">{error}</p>
          </div>
        )}

        {loading && (
          <div className="military-border p-6 mb-6 bg-robotic-gray-300">
            <h3 className="text-lg terminal-text uppercase mb-4">
              [BACKEND] Building scenario world
            </h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Creating a playable scenario with multiple layers: teams, injects, objectives,
              locations, environmental seeds, and real-world facility data.
            </p>
            <div className="space-y-2">
              {GENERATION_PHASES.map((phase) => {
                const phaseIndex = GENERATION_PHASES.findIndex((p) => p.id === phase.id);
                const currentIndex =
                  progressPhase !== null
                    ? GENERATION_PHASES.findIndex((p) => p.id === progressPhase)
                    : 0;
                const isDone = phaseIndex >= 0 && currentIndex >= 0 && phaseIndex < currentIndex;
                const isCurrent =
                  progressPhase === phase.id || (progressPhase === null && phaseIndex === 0);
                return (
                  <div
                    key={phase.id}
                    className={`border p-3 font-mono text-xs transition-all ${
                      isCurrent
                        ? 'border-robotic-yellow bg-robotic-yellow/10'
                        : isDone
                          ? 'border-robotic-green/50 bg-robotic-green/5'
                          : 'border-robotic-gray-200 text-robotic-yellow/60'
                    }`}
                  >
                    <span className="text-robotic-yellow/90">
                      {isDone ? '[DONE]' : isCurrent ? '[...]' : '[---]'} {phase.label}
                    </span>
                    <span className="text-robotic-yellow/60"> — {phase.desc}</span>
                    {isCurrent && (
                      <div className="mt-2 text-robotic-yellow/80 pl-6">
                        {progressMessage || 'In progress...'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 3: Map Validation (wizard only) */}
        {wizardMode && step === 3 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[MAP VALIDATION]</h3>
            {geocodeLoading ? (
              <p className="text-sm terminal-text text-robotic-yellow/70">
                Geocoding location and fetching map data...
              </p>
            ) : geocodeData ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs terminal-text text-robotic-yellow/70 mb-1">
                      RESOLVED LOCATION
                    </p>
                    <p className="text-sm terminal-text text-robotic-yellow">
                      {geocodeData.display_name}
                    </p>
                    <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
                      {geocodeData.lat.toFixed(6)}, {geocodeData.lng.toFixed(6)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs terminal-text text-robotic-yellow/70 mb-1">
                      NEARBY FACILITIES
                    </p>
                    {osmVicinity ? (
                      <div className="text-xs terminal-text text-robotic-yellow/80 space-y-1">
                        <p>Hospitals: {osmVicinity.hospitals?.length ?? 0}</p>
                        <p>Police: {osmVicinity.police?.length ?? 0}</p>
                        <p>Fire Stations: {osmVicinity.fire_stations?.length ?? 0}</p>
                      </div>
                    ) : (
                      <p className="text-xs terminal-text text-robotic-yellow/50">
                        No OSM data available
                      </p>
                    )}
                  </div>
                </div>

                {osmVicinity &&
                  (osmVicinity.hospitals?.length ||
                    osmVicinity.police?.length ||
                    osmVicinity.fire_stations?.length) && (
                    <div className="border border-robotic-yellow/20 p-3 max-h-40 overflow-y-auto">
                      <p className="text-[10px] terminal-text text-robotic-yellow/50 mb-2 uppercase">
                        Facility Details
                      </p>
                      {[
                        ...(osmVicinity.hospitals?.map((h) => ({ ...h, type: 'Hospital' })) ?? []),
                        ...(osmVicinity.police?.map((p) => ({ ...p, type: 'Police' })) ?? []),
                        ...(osmVicinity.fire_stations?.map((f) => ({ ...f, type: 'Fire' })) ?? []),
                      ].map((f, i) => (
                        <div
                          key={i}
                          className="text-[10px] terminal-text text-robotic-yellow/70 mb-0.5"
                        >
                          [{f.type}] {f.name}
                          {f.address ? ` — ${f.address}` : ''}
                        </div>
                      ))}
                    </div>
                  )}

                {areaSummary && (
                  <div className="border border-robotic-yellow/20 p-3">
                    <p className="text-[10px] terminal-text text-robotic-yellow/50 mb-2 uppercase">
                      Area Research Summary
                    </p>
                    <div className="text-[10px] terminal-text text-robotic-yellow/70 max-h-60 overflow-y-auto whitespace-pre-wrap">
                      {areaSummary.slice(0, 3000)}
                      {areaSummary.length > 3000 ? '...' : ''}
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <label className="text-xs terminal-text text-robotic-yellow/70">
                    Override Lat:
                    <input
                      type="number"
                      step="0.0001"
                      value={geocodeData.lat}
                      onChange={(e) =>
                        setGeocodeData((prev) =>
                          prev ? { ...prev, lat: parseFloat(e.target.value) || prev.lat } : prev,
                        )
                      }
                      className="ml-2 w-28 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-xs"
                    />
                  </label>
                  <label className="text-xs terminal-text text-robotic-yellow/70">
                    Lng:
                    <input
                      type="number"
                      step="0.0001"
                      value={geocodeData.lng}
                      onChange={(e) =>
                        setGeocodeData((prev) =>
                          prev ? { ...prev, lng: parseFloat(e.target.value) || prev.lng } : prev,
                        )
                      }
                      className="ml-2 w-28 px-2 py-1 bg-black/50 border border-robotic-yellow/50 text-robotic-yellow text-xs"
                    />
                  </label>
                </div>
              </div>
            ) : (
              <p className="text-sm terminal-text text-robotic-yellow/50">
                No location data available. You may proceed without validation.
              </p>
            )}
          </div>
        )}

        {/* Step 3.5: Scene Setup (wizard only) */}
        {wizardMode && step === 35 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[SCENE SETUP]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Set up the physical scene for the exercise. Place exits, the blast site, hazards,
              casualties, and interior elements on the building.
            </p>
            {geocodeData ? (
              <SceneSetup
                buildingPolygon={
                  sceneConfig?.buildingPolygon ?? [[geocodeData.lat, geocodeData.lng]]
                }
                buildingName={sceneConfig?.buildingName ?? geocodeData.display_name}
                centerLat={geocodeData.lat}
                centerLng={geocodeData.lng}
                initialConfig={sceneConfig ?? undefined}
                onSave={async (config) => {
                  setSceneConfig(config);
                  try {
                    let cLat = 0,
                      cLng = 0;
                    for (const [la, ln] of config.buildingPolygon) {
                      cLat += la;
                      cLng += ln;
                    }
                    cLat /= config.buildingPolygon.length;
                    cLng /= config.buildingPolygon.length;
                    const { id } = await createSceneConfig({
                      name: config.buildingName ?? 'Exercise Scene',
                      buildingPolygon: config.buildingPolygon,
                      buildingName: config.buildingName ?? undefined,
                      centerLat: cLat,
                      centerLng: cLng,
                      exits: config.exits,
                      interiorWalls: config.interiorWalls,
                      hazardZones: config.hazardZones,
                      stairwells: config.stairwells,
                      blastSite: config.blastSite,
                      casualtyClusters: config.casualtyClusters,
                      plantedItems: config.plantedItems,
                      wallInspectionPoints: config.wallInspectionPoints,
                      pedestrianCount: config.pedestrianCount,
                    });
                    setRtsSceneId(id);
                  } catch (err) {
                    console.error('Failed to save scene config:', err);
                  }
                }}
              />
            ) : (
              <div className="text-sm terminal-text text-robotic-yellow/50">
                No location data available. Validate the location in the previous step first.
                <br />
                <button
                  onClick={() => setStep(3)}
                  className="mt-2 text-xs terminal-text uppercase border border-robotic-yellow/30 px-3 py-1 hover:border-robotic-yellow/50"
                >
                  [BACK TO MAP VALIDATION]
                </button>
              </div>
            )}
            {sceneConfig && (
              <div className="mt-3 text-xs terminal-text text-robotic-yellow/50">
                Scene saved: {sceneConfig.exits.length} exits · Blast:{' '}
                {sceneConfig.blastSite ? '✓' : '—'} · {sceneConfig.casualtyClusters.length} casualty
                clusters · {sceneConfig.hazardZones.length} hazards
                {rtsSceneId && (
                  <span className="text-green-500 ml-2">(DB: {rtsSceneId.slice(0, 8)}...)</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Doctrine Review (wizard only) */}
        {wizardMode && step === 4 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[DOCTRINE & SOP REVIEW]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Review and edit the researched doctrines for each team. These will be used as ground
              truth for evaluating player decisions during the simulation.
            </p>
            {doctrinesLoading ? (
              <p className="text-sm terminal-text text-robotic-yellow/70">
                Researching doctrines and SOPs per team...
              </p>
            ) : doctrines ? (
              <div className="space-y-4">
                {Object.entries(doctrines.perTeamDoctrines).map(([teamName, findings]) => (
                  <div
                    key={teamName}
                    className="border border-robotic-yellow/30 bg-black/30 p-4 space-y-3"
                  >
                    <h4 className="text-sm terminal-text text-robotic-yellow uppercase tracking-wider">
                      {teamName}
                    </h4>

                    {findings.map((finding, fi) => (
                      <div
                        key={fi}
                        className="border border-robotic-yellow/15 p-3 space-y-2 relative"
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <span className="text-[10px] terminal-text text-cyan-400/80 uppercase">
                              {finding.domain}
                            </span>
                            <span className="text-[10px] terminal-text text-robotic-yellow/50 ml-2">
                              Source: {finding.source}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              setDoctrines((prev) => {
                                if (!prev) return prev;
                                const updated = { ...prev };
                                updated.perTeamDoctrines = { ...updated.perTeamDoctrines };
                                updated.perTeamDoctrines[teamName] = [
                                  ...updated.perTeamDoctrines[teamName],
                                ];
                                updated.perTeamDoctrines[teamName].splice(fi, 1);
                                return updated;
                              });
                            }}
                            className="text-[10px] terminal-text text-robotic-orange hover:text-robotic-orange/80"
                          >
                            [DELETE]
                          </button>
                        </div>
                        {finding.key_points.map((kp, ki) => (
                          <div key={ki} className="flex gap-1 items-start">
                            <span className="text-robotic-yellow/40 text-[10px] mt-1 shrink-0">
                              {ki + 1}.
                            </span>
                            <textarea
                              value={kp}
                              rows={1}
                              onChange={(e) => {
                                setDoctrines((prev) => {
                                  if (!prev) return prev;
                                  const updated = { ...prev };
                                  updated.perTeamDoctrines = { ...updated.perTeamDoctrines };
                                  updated.perTeamDoctrines[teamName] = [
                                    ...updated.perTeamDoctrines[teamName],
                                  ];
                                  const newFinding = {
                                    ...updated.perTeamDoctrines[teamName][fi],
                                  };
                                  newFinding.key_points = [...newFinding.key_points];
                                  newFinding.key_points[ki] = e.target.value;
                                  updated.perTeamDoctrines[teamName][fi] = newFinding;
                                  return updated;
                                });
                              }}
                              className="flex-1 px-2 py-1 bg-black/30 border border-robotic-yellow/20 text-robotic-yellow/80 text-[10px] terminal-text resize-y"
                            />
                          </div>
                        ))}
                        <button
                          onClick={() => {
                            setDoctrines((prev) => {
                              if (!prev) return prev;
                              const updated = { ...prev };
                              updated.perTeamDoctrines = { ...updated.perTeamDoctrines };
                              updated.perTeamDoctrines[teamName] = [
                                ...updated.perTeamDoctrines[teamName],
                              ];
                              const newFinding = {
                                ...updated.perTeamDoctrines[teamName][fi],
                              };
                              newFinding.key_points = [...newFinding.key_points, ''];
                              updated.perTeamDoctrines[teamName][fi] = newFinding;
                              return updated;
                            });
                          }}
                          className="text-[10px] terminal-text text-robotic-yellow/50 hover:text-robotic-yellow"
                        >
                          [+ ADD KEY POINT]
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={() => {
                        setDoctrines((prev) => {
                          if (!prev) return prev;
                          const updated = { ...prev };
                          updated.perTeamDoctrines = { ...updated.perTeamDoctrines };
                          updated.perTeamDoctrines[teamName] = [
                            ...updated.perTeamDoctrines[teamName],
                            {
                              domain: 'Custom',
                              source: 'Trainer-defined',
                              key_points: [''],
                            },
                          ];
                          return updated;
                        });
                      }}
                      className="text-[10px] terminal-text text-cyan-400/70 hover:text-cyan-300 border border-cyan-500/30 px-3 py-1.5"
                    >
                      [+ ADD DOCTRINE FINDING]
                    </button>

                    {/* Workflow section */}
                    {doctrines.teamWorkflows[teamName] && (
                      <div className="border-t border-robotic-yellow/15 pt-3 mt-3">
                        <p className="text-[10px] terminal-text text-robotic-yellow/50 uppercase mb-2">
                          Workflow Chain
                        </p>
                        <div className="space-y-1">
                          <div className="text-[10px] terminal-text text-robotic-yellow/70">
                            <span className="text-robotic-yellow/40">Endgame:</span>{' '}
                            {doctrines.teamWorkflows[teamName].endgame}
                          </div>
                          <div className="text-[10px] terminal-text text-robotic-yellow/70">
                            <span className="text-robotic-yellow/40">Steps:</span>
                            <ol className="list-decimal list-inside mt-1 space-y-0.5">
                              {doctrines.teamWorkflows[teamName].steps.map((s, si) => (
                                <li key={si}>{s}</li>
                              ))}
                            </ol>
                          </div>
                          {doctrines.teamWorkflows[teamName].sop_checklist?.length ? (
                            <div className="text-[10px] terminal-text text-robotic-yellow/70">
                              <span className="text-robotic-yellow/40">SOP Checklist:</span>
                              <ul className="list-disc list-inside mt-1 space-y-0.5">
                                {doctrines.teamWorkflows[teamName].sop_checklist!.map((s, si) => (
                                  <li key={si}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm terminal-text text-robotic-yellow/50">
                No doctrine data available.
              </p>
            )}
          </div>
        )}

        {/* Step 5: Deterioration Timeline Review (wizard only) */}
        {wizardMode && step === 5 && (
          <div className="military-border p-6 mb-6 bg-robotic-gray-300">
            <h3 className="text-lg terminal-text uppercase mb-4">
              [DETERIORATION TIMELINE REVIEW]
            </h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Review how the scenario deteriorates over time if teams fail to act. You can edit or
              remove spawn events before generating.
            </p>

            {wizardScenarioPersisting && (
              <p className="text-xs terminal-text text-cyan-300/90 animate-pulse mb-3 border border-cyan-500/30 p-3">
                Saving scenario to the database (first run can take 1–2 minutes). Spawn and timeline
                review will appear below when ready — no need to leave this page.
              </p>
            )}

            {deteriorationLoading && (
              <p className="text-xs terminal-text text-robotic-yellow/60 animate-pulse">
                Researching deterioration physics and generating timeline...
              </p>
            )}

            {deteriorationPreview && (
              <div className="space-y-6">
                {/* Spawn Pins first so trainers see editable pins without scrolling past long timelines */}
                {deteriorationPreview.spawnPins.length > 0 ? (
                  <div id="warroom-spawn-events">
                    <h4 className="text-sm terminal-text uppercase mb-2 text-robotic-yellow">
                      Spawn Events ({deteriorationPreview.spawnPins.length}) — edit or remove before
                      opening scenarios
                    </h4>
                    <div className="space-y-2">
                      {deteriorationPreview.spawnPins.map((sp, i) => (
                        <div
                          key={i}
                          className="border border-robotic-gray-200 p-3 flex items-start justify-between gap-4"
                        >
                          <div className="flex-1">
                            <div className="text-xs terminal-text text-robotic-yellow/90 font-bold mb-1">
                              <span
                                className={
                                  sp.pin_type === 'hazard' ? 'text-red-400' : 'text-amber-400'
                                }
                              >
                                [{sp.pin_type.toUpperCase()}]
                              </span>{' '}
                              {sp.label}
                            </div>
                            <div className="text-xs terminal-text text-robotic-yellow/60">
                              Parent: {sp.parent_pin_label} | Appears: +{sp.appears_at_minutes}min |
                              Trigger: {sp.spawn_condition.trigger} at +
                              {sp.spawn_condition.at_minutes}min (unless{' '}
                              {sp.spawn_condition.unless_status.join(', ')})
                            </div>
                            <div className="text-xs terminal-text text-robotic-yellow/70 mt-1">
                              {sp.description}
                            </div>
                            <div className="text-xs terminal-text text-robotic-yellow/40 mt-1">
                              Offset: [{sp.lat_offset.toFixed(5)}, {sp.lng_offset.toFixed(5)}]
                            </div>
                          </div>
                          <button
                            onClick={() => {
                              setDeteriorationPreview((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      spawnPins: prev.spawnPins.filter((_, idx) => idx !== i),
                                    }
                                  : null,
                              );
                            }}
                            className="text-xs terminal-text text-red-400 hover:text-red-300 border border-red-400/30 px-2 py-1"
                          >
                            [REMOVE]
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs terminal-text text-robotic-yellow/50 border border-robotic-yellow/20 p-3">
                    No spawn pins were written to the scenario yet. Use [REBUILD DETERIORATION
                    PREVIEW] from the previous step, or regenerate — the server matches AI parent
                    labels to hazards more reliably after the latest update.
                  </p>
                )}

                {/* Cascade Narrative */}
                {deteriorationPreview.cascadeNarrative && (
                  <div className="border border-robotic-yellow/30 p-4">
                    <h4 className="text-sm terminal-text uppercase mb-2 text-robotic-yellow">
                      Cascade Narrative
                    </h4>
                    <p className="text-xs terminal-text text-robotic-yellow/80">
                      {deteriorationPreview.cascadeNarrative}
                    </p>
                  </div>
                )}

                {/* Enriched Hazard Timelines */}
                {deteriorationPreview.enrichedHazards.length > 0 && (
                  <div>
                    <h4 className="text-sm terminal-text uppercase mb-2 text-robotic-yellow">
                      Hazard Deterioration ({deteriorationPreview.enrichedHazards.length})
                    </h4>
                    <div className="space-y-2">
                      {deteriorationPreview.enrichedHazards.map((eh, i) => (
                        <div key={i} className="border border-robotic-gray-200 p-3">
                          <div className="text-xs terminal-text text-robotic-yellow/90 font-bold mb-1">
                            {eh.hazard_label}
                          </div>
                          {Object.entries(eh.deterioration_timeline)
                            .filter(([k]) => k.startsWith('at_'))
                            .map(([k, v]) => (
                              <div
                                key={k}
                                className="text-xs terminal-text text-robotic-yellow/70 pl-4"
                              >
                                <span className="text-robotic-yellow/50">{k}:</span> {String(v)}
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Enriched Casualty Timelines */}
                {deteriorationPreview.enrichedCasualties.length > 0 && (
                  <div>
                    <h4 className="text-sm terminal-text uppercase mb-2 text-robotic-yellow">
                      Patient Deterioration ({deteriorationPreview.enrichedCasualties.length})
                    </h4>
                    <div className="space-y-2">
                      {deteriorationPreview.enrichedCasualties.map((ec, i) => (
                        <div key={i} className="border border-robotic-gray-200 p-3">
                          <div className="text-xs terminal-text text-robotic-yellow/90 font-bold mb-1">
                            {ec.casualty_label}
                          </div>
                          {ec.deterioration_timeline.map((entry, j) => (
                            <div
                              key={j}
                              className="text-xs terminal-text text-robotic-yellow/70 pl-4"
                            >
                              <span className="text-robotic-yellow/50">
                                +{entry.at_minutes}min:
                              </span>{' '}
                              {entry.description}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ============================================================= */}
        {/* MANUAL DESIGN STEPS */}
        {/* ============================================================= */}

        {/* Manual Step 1: Incident Type */}
        {!wizardMode && step === 11 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[INCIDENT TYPE]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Describe the incident or select a type from the list.
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-xs terminal-text text-robotic-yellow/70 block mb-1">
                  Incident Description
                </label>
                <textarea
                  value={
                    typeof (window as unknown as Record<string, unknown>).__wrPrompt === 'string'
                      ? ''
                      : prompt
                  }
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. A bomb has detonated in the ground floor lobby of a shopping mall during peak hours..."
                  className="w-full p-3 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-sm terminal-text resize-none focus:border-robotic-yellow/60 focus:outline-none"
                  rows={4}
                />
              </div>
              <div>
                <label className="text-xs terminal-text text-robotic-yellow/70 block mb-1">
                  Scenario Type
                </label>
                <select
                  value={resolvedScenarioType || ''}
                  onChange={(e) => setResolvedScenarioType(e.target.value || null)}
                  className="w-full p-2 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs terminal-text"
                >
                  <option value="">Auto-detect from description</option>
                  {SCENARIO_TYPES.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Manual Step 2: Location */}
        {!wizardMode && step === 12 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[LOCATION]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Choose the location for the exercise. Your current position is used as the default.
            </p>
            <div className="space-y-4">
              <LocationPicker
                onLocationChange={(loc) => setManualCoords(loc)}
                initialLocation={manualCoords}
              />
              {manualCoords && (
                <div className="text-xs terminal-text text-robotic-yellow/50">
                  Selected: {manualCoords.display_name} ({manualCoords.lat.toFixed(6)},{' '}
                  {manualCoords.lng.toFixed(6)})
                </div>
              )}
            </div>
          </div>
        )}

        {/* Manual Step 3: Teams */}
        {!wizardMode && step === 13 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[TEAMS]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              Configure the teams for the exercise.
            </p>
            <div className="space-y-3">
              {teams.length === 0 && (
                <div className="text-xs terminal-text text-robotic-yellow/50">
                  No teams configured yet. Click "Suggest Teams" or add manually.
                </div>
              )}
              {teams.map((t, i) => (
                <div key={i} className="border border-robotic-gray-200 p-3 space-y-2">
                  <input
                    value={t.team_name}
                    onChange={(e) => {
                      const c = [...teams];
                      c[i] = { ...c[i], team_name: e.target.value };
                      setTeams(c);
                    }}
                    className="w-full p-1.5 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs terminal-text"
                    placeholder="Team name"
                  />
                  <textarea
                    value={t.team_description}
                    onChange={(e) => {
                      const c = [...teams];
                      c[i] = { ...c[i], team_description: e.target.value };
                      setTeams(c);
                    }}
                    className="w-full p-1.5 bg-black/50 border border-robotic-yellow/30 text-robotic-yellow text-xs terminal-text resize-none"
                    rows={2}
                    placeholder="Team description"
                  />
                </div>
              ))}
              <button
                onClick={() =>
                  setTeams((prev) => [
                    ...prev,
                    {
                      team_name: '',
                      team_description: '',
                      min_participants: 1,
                      max_participants: 4,
                    },
                  ])
                }
                className="text-xs terminal-text text-robotic-yellow/50 border border-robotic-yellow/30 px-3 py-1 hover:border-robotic-yellow/50"
              >
                + Add Team
              </button>
            </div>
          </div>
        )}

        {/* Manual Step 4: Location Validation */}
        {!wizardMode && step === 14 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[LOCATION VALIDATION]</h3>
            {geocodeLoading ? (
              <p className="text-sm terminal-text text-robotic-yellow/70 animate-pulse">
                Validating location and fetching map data...
              </p>
            ) : geocodeData ? (
              <div className="space-y-3">
                <div>
                  <p className="text-xs terminal-text text-robotic-yellow/70 mb-1">
                    RESOLVED LOCATION
                  </p>
                  <p className="text-sm terminal-text text-robotic-yellow">
                    {geocodeData.display_name}
                  </p>
                  <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
                    {geocodeData.lat.toFixed(6)}, {geocodeData.lng.toFixed(6)}
                  </p>
                </div>
                {osmVicinity && (
                  <div>
                    <p className="text-xs terminal-text text-robotic-yellow/70 mb-1">
                      NEARBY FACILITIES
                    </p>
                    <div className="text-xs terminal-text text-robotic-yellow/80 space-y-0.5">
                      <p>Hospitals: {osmVicinity.hospitals?.length ?? 0}</p>
                      <p>Police: {osmVicinity.police?.length ?? 0}</p>
                      <p>Fire Stations: {osmVicinity.fire_stations?.length ?? 0}</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm terminal-text text-robotic-yellow/50">
                Click "Validate Location" to proceed.
              </p>
            )}
          </div>
        )}

        {/* Manual Step 5: Scene Design */}
        {!wizardMode && step === 15 && geocodeData && (
          <div
            className="military-border mb-6"
            style={{ height: 'calc(100vh - 280px)', minHeight: 500 }}
          >
            <SceneDesigner
              centerLat={geocodeData.lat}
              centerLng={geocodeData.lng}
              radius={300}
              initialConfig={manualSceneResult ?? undefined}
              onSave={(config) => {
                setManualSceneResult(config);
              }}
            />
          </div>
        )}

        {/* Manual Step 6: AI Research + Enrichment */}
        {!wizardMode && step === 16 && (
          <div className="military-border p-6 mb-6">
            <h3 className="text-lg terminal-text uppercase mb-4">[AI RESEARCH & ENRICHMENT]</h3>
            <p className="text-xs terminal-text text-robotic-yellow/70 mb-4">
              The AI will analyze your scene setup and research relevant doctrines, hazard
              interactions, casualty profiles, and response protocols.
            </p>
            {manualSceneResult && (
              <div className="text-xs terminal-text text-robotic-yellow/50 mb-4 space-y-0.5">
                <p>Building: {manualSceneResult.buildingName || 'Custom'}</p>
                <p>
                  Exits: {manualSceneResult.exits.length} · Casualties:{' '}
                  {manualSceneResult.casualtyPins.length} · Hazards:{' '}
                  {manualSceneResult.hazardZones.length}
                </p>
                <p>
                  Blast site:{' '}
                  {manualSceneResult.blastSite
                    ? `Set (${manualSceneResult.blastRadius}m radius)`
                    : 'Not set'}
                </p>
                <p>Pedestrians: {manualSceneResult.pedestrianCount}</p>
              </div>
            )}
            {aiEnrichmentLoading && (
              <p className="text-sm terminal-text text-robotic-yellow/70 animate-pulse">
                AI is analyzing scene and researching doctrines...
              </p>
            )}
            {aiEnrichmentResult && (
              <div className="bg-black/50 border border-robotic-yellow/30 p-4 mt-4">
                <pre className="text-xs terminal-text text-robotic-yellow/80 whitespace-pre-wrap">
                  {aiEnrichmentResult}
                </pre>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-4">
          {step === 1 ? (
            <>
              <button
                onClick={handleNext}
                disabled={loading || teamsLoading}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {teamsLoading ? '[LOADING TEAMS...]' : '[NEXT: CONFIGURE TEAMS]'}
              </button>
              <Link
                to="/scenarios"
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 transition-all"
              >
                [CANCEL]
              </Link>
            </>
          ) : step === 2 ? (
            <>
              <button
                onClick={() => {
                  setWizardDraftId(null);
                  setStep(1);
                }}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK]
              </button>
              {wizardMode ? (
                <button
                  onClick={handleGeocodeValidate}
                  disabled={loading || geocodeLoading || teams.length === 0}
                  className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {geocodeLoading ? '[VALIDATING LOCATION...]' : '[NEXT: VALIDATE LOCATION]'}
                </button>
              ) : (
                <button
                  onClick={handleGenerate}
                  disabled={loading || teams.length === 0}
                  className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? '[GENERATING...] (30–60s)' : '[GENERATE]'}
                </button>
              )}
              <Link
                to="/scenarios"
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 transition-all"
              >
                [CANCEL]
              </Link>
            </>
          ) : step === 3 ? (
            <>
              <button
                onClick={() => setStep(2)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: TEAMS]
              </button>
              <button
                onClick={() => setStep(35)}
                disabled={loading}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                [NEXT: SCENE SETUP]
              </button>
            </>
          ) : step === 35 ? (
            <>
              <button
                onClick={() => setStep(3)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: MAP]
              </button>
              <button
                onClick={handleResearchDoctrines}
                disabled={loading || doctrinesLoading}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {doctrinesLoading ? '[RESEARCHING DOCTRINES...]' : '[NEXT: RESEARCH DOCTRINES]'}
              </button>
            </>
          ) : step === 4 ? (
            <>
              <button
                onClick={() => setStep(35)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: SCENE]
              </button>
              <button
                onClick={handleDeteriorationPreview}
                disabled={loading || deteriorationLoading || wizardScenarioPersisting || !doctrines}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deteriorationLoading || wizardScenarioPersisting
                  ? '[BUILDING PREVIEW...]'
                  : wizardScenarioId
                    ? '[REBUILD DETERIORATION PREVIEW]'
                    : '[NEXT: DETERIORATION PREVIEW]'}
              </button>
            </>
          ) : step === 5 ? (
            <>
              <button
                onClick={() => setStep(4)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: DOCTRINES]
              </button>
              <button
                onClick={() => navigate('/scenarios')}
                disabled={loading || !wizardScenarioId}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '[LOADING...]' : '[OPEN SCENARIOS]'}
              </button>
            </>
          ) : step === 11 ? (
            /* Manual Step 1: Incident Type */
            <>
              <button
                onClick={() => setStep(12)}
                disabled={loading || !prompt.trim()}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                [NEXT: CHOOSE LOCATION]
              </button>
              <Link
                to="/scenarios"
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [CANCEL]
              </Link>
            </>
          ) : step === 12 ? (
            /* Manual Step 2: Location */
            <>
              <button
                onClick={() => setStep(11)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK]
              </button>
              <button
                onClick={async () => {
                  if (!manualCoords) return;
                  setTeamsLoading(true);
                  setError(null);
                  try {
                    const opts = buildOptions();
                    if (manualCoords) {
                      (opts as Record<string, unknown>).location = manualCoords.display_name;
                    }
                    const { data } = await api.warroom.suggestTeams(opts);
                    const mappedTeams = data.suggested_teams.map((t: Record<string, unknown>) => ({
                      team_name: t.team_name as string,
                      team_description: (t.team_description as string) || '',
                      min_participants: (t.min_participants as number) ?? 1,
                      max_participants: (t.max_participants as number) ?? 10,
                      is_investigative: (t.is_investigative as boolean) ?? false,
                    }));
                    setTeams(mappedTeams);
                    if (data.scenario_type) setResolvedScenarioType(data.scenario_type);
                    if (data.threat_profile?.weapon_class)
                      setResolvedWeaponClass(data.threat_profile.weapon_class);
                    setStep(13);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to suggest teams');
                  } finally {
                    setTeamsLoading(false);
                  }
                }}
                disabled={loading || teamsLoading || !manualCoords}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {teamsLoading ? '[SUGGESTING TEAMS...]' : '[NEXT: CONFIGURE TEAMS]'}
              </button>
            </>
          ) : step === 13 ? (
            /* Manual Step 3: Teams */
            <>
              <button
                onClick={() => setStep(12)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: LOCATION]
              </button>
              <button
                onClick={async () => {
                  if (!manualCoords) return;
                  setGeocodeLoading(true);
                  try {
                    let draftId = wizardDraftId;
                    if (!draftId) {
                      const opts = buildOptions();
                      const { data: draftRes } = await api.warroom.wizardDraftCreate({
                        input: {
                          ...opts,
                          teams: teams.map((t) => ({
                            team_name: t.team_name,
                            team_description: t.team_description,
                            min_participants: t.min_participants,
                            max_participants: t.max_participants,
                          })),
                          geocode_override: {
                            lat: manualCoords.lat,
                            lng: manualCoords.lng,
                            display_name: manualCoords.display_name,
                          },
                        },
                      });
                      draftId = draftRes.draft_id;
                      setWizardDraftId(draftId);
                    }
                    const { data } = await api.warroom.wizardDraftGeocodeValidate(draftId);
                    setGeocodeData(data.geocode);
                    setOsmVicinity(data.osmVicinity);
                    setAreaSummary(data.areaSummary);
                    setStep(14);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Validation failed');
                  } finally {
                    setGeocodeLoading(false);
                  }
                }}
                disabled={loading || geocodeLoading || teams.length === 0}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {geocodeLoading ? '[VALIDATING...]' : '[NEXT: VALIDATE LOCATION]'}
              </button>
            </>
          ) : step === 14 ? (
            /* Manual Step 4: Validation */
            <>
              <button
                onClick={() => setStep(13)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: TEAMS]
              </button>
              <button
                onClick={() => setStep(15)}
                disabled={loading || !geocodeData}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                [NEXT: DESIGN SCENE]
              </button>
            </>
          ) : step === 15 ? (
            /* Manual Step 5: Scene Design */
            <>
              <button
                onClick={() => setStep(14)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: VALIDATION]
              </button>
              <button
                onClick={() => setStep(16)}
                disabled={loading || !manualSceneResult}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                [NEXT: AI RESEARCH]
              </button>
            </>
          ) : step === 16 ? (
            /* Manual Step 6: AI Research */
            <>
              <button
                onClick={() => setStep(15)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK: SCENE]
              </button>
              <button
                onClick={async () => {
                  if (!manualSceneResult || !wizardDraftId) return;
                  setAiEnrichmentLoading(true);
                  try {
                    const opts = buildOptions();
                    const inputPayload: Record<string, unknown> = {
                      ...opts,
                      teams: teams.map((t) => ({
                        team_name: t.team_name,
                        team_description: t.team_description,
                        min_participants: t.min_participants,
                        max_participants: t.max_participants,
                      })),
                      scene_context: {
                        building_name: manualSceneResult.buildingName,
                        exits_count: manualSceneResult.exits.length,
                        stairwells_count: manualSceneResult.stairwells.length,
                        has_blast_site: !!manualSceneResult.blastSite,
                        blast_radius: manualSceneResult.blastRadius,
                        casualty_count: manualSceneResult.casualtyPins.length,
                        pedestrian_count: manualSceneResult.pedestrianCount,
                        hazard_zones: manualSceneResult.hazardZones.map(
                          (hz) =>
                            `${hz.hazardType} (${hz.severity}): ${hz.description || 'no description'}`,
                        ),
                        game_zones: manualSceneResult.gameZones.map(
                          (gz) => `${gz.type}: ${gz.radius}m`,
                        ),
                      },
                    };
                    if (geocodeData) {
                      inputPayload.geocode_override = {
                        lat: geocodeData.lat,
                        lng: geocodeData.lng,
                        display_name: geocodeData.display_name,
                      };
                    }
                    await api.warroom.wizardDraftPatch(wizardDraftId, { input: inputPayload });
                    const { data } = await api.warroom.wizardDraftResearchDoctrines(wizardDraftId);
                    setDoctrines({
                      perTeamDoctrines: data.doctrines.perTeamDoctrines,
                      teamWorkflows: data.doctrines.teamWorkflows,
                    });
                    setAiEnrichmentResult(
                      `Doctrine research complete.\n\nTeams analyzed: ${Object.keys(data.doctrines.perTeamDoctrines).length}\n` +
                        Object.entries(data.doctrines.perTeamDoctrines)
                          .map(
                            ([team, findings]) =>
                              `\n--- ${team} ---\n${(findings as Array<{ domain: string; key_points: string[] }>).map((f) => `  • ${f.domain}: ${f.key_points?.[0] || ''}`).join('\n')}`,
                          )
                          .join(''),
                    );
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'AI research failed');
                  } finally {
                    setAiEnrichmentLoading(false);
                  }
                }}
                disabled={loading || aiEnrichmentLoading || !manualSceneResult}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {aiEnrichmentLoading ? '[RESEARCHING...]' : '[RUN AI RESEARCH]'}
              </button>
              {doctrines && (
                <button
                  onClick={() => navigate('/scenarios')}
                  className="military-button px-8 py-3"
                >
                  [OPEN SCENARIOS]
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
