import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { VoiceMicButton } from '../components/VoiceMicButton';

type TeamEntry = {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
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
  const [step, setStep] = useState<1 | 2>(1);
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [resolvedScenarioType, setResolvedScenarioType] = useState<string | null>(null);
  const [resolvedWeaponClass, setResolvedWeaponClass] = useState<string | null>(null);

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
      setTeams(
        data.suggested_teams.map((t) => ({
          team_name: t.team_name,
          team_description: t.team_description || '',
          min_participants: t.min_participants ?? 1,
          max_participants: t.max_participants ?? 10,
        })),
      );
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
      }));

      const result = await api.warroom.generateStream(options, (phase, message) => {
        setProgressPhase(phase);
        setProgressMessage(message);
      });
      if (result.scenarioId) {
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
          <h1 className="text-2xl terminal-text uppercase tracking-wider mb-2">
            [WAR_ROOM] Scenario Generator
          </h1>
          <p className="text-xs terminal-text text-robotic-yellow/70">
            Enter a prompt or select parameters. AI will generate a complete, playable scenario.
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
                  <div className="flex gap-4">
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
                  </div>
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
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
              >
                [BACK]
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading || teams.length === 0}
                className="military-button px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '[GENERATING...] (30–60s)' : '[GENERATE]'}
              </button>
              <Link
                to="/scenarios"
                className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50 transition-all"
              >
                [CANCEL]
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
