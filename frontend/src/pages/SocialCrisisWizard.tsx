import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

/* ─── Types ─────────────────────────────────────────────────────────── */

interface TeamEntry {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

interface SOPStep {
  step_id: string;
  name: string;
  description: string;
  time_limit_minutes: number;
}

interface SOPDefinition {
  sop_name: string;
  description: string;
  steps: SOPStep[];
  response_time_limit_minutes: number;
  content_guidelines: {
    tone: string[];
    avoid: string[];
    include: string[];
    language_sensitivity: string[];
  };
}

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
}

interface FactSheetEntry {
  claim: string;
  status: string;
  truth: string;
}

interface FactSheet {
  confirmed_facts: string[];
  unconfirmed_claims: FactSheetEntry[];
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const CRISIS_TYPES = [
  {
    id: 'racial_tension',
    label: 'Racial Tension',
    icon: '⚡',
    description: 'Hate speech and scapegoating targeting ethnic communities',
  },
  {
    id: 'religious_incident',
    label: 'Religious Incident',
    icon: '🕌',
    description: 'Inflammatory posts targeting religious communities',
  },
  {
    id: 'xenophobic_attack',
    label: 'Xenophobic Attack',
    icon: '🌍',
    description: 'Anti-immigrant sentiment and misinformation',
  },
  {
    id: 'terror_aftermath',
    label: 'Terror Aftermath',
    icon: '💥',
    description: 'Social media backlash after a terror event',
  },
  {
    id: 'police_incident',
    label: 'Police Incident',
    icon: '🚔',
    description: 'Viral video of a controversial police encounter',
  },
  {
    id: 'fake_news_spiral',
    label: 'Fake News Spiral',
    icon: '📰',
    description: 'Viral misinformation causing real-world harm',
  },
];

const STEP_LABELS: Record<number, string> = {
  1: 'Crisis Event',
  2: 'Communities',
  3: 'Teams',
  4: 'SOP & Guidelines',
  5: 'NPCs & Facts',
  6: 'Compile',
};

const VISIBLE_STEPS = [1, 2, 3, 4, 5, 6];

/* ─── Helpers ───────────────────────────────────────────────────────── */

function fetchJSON(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

const API_BASE = import.meta.env.VITE_API_URL || '';
function apiUrl(path: string) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${clean}` : clean;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await (await import('../lib/supabase')).supabase.auth.getSession();
  const token = data.session?.access_token || '';
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/* ─── Component ─────────────────────────────────────────────────────── */

export const SocialCrisisWizard = () => {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const navigate = useNavigate();

  /* Step 1 — Crisis Event */
  const [crisisType, setCrisisType] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('Singapore');
  const [context, setContext] = useState('');

  /* Step 2 — Affected Communities */
  const [communities, setCommunities] = useState<string[]>([]);
  const [communitiesLoading, setCommunitiesLoading] = useState(false);
  const [newCommunity, setNewCommunity] = useState('');

  /* Step 3 — Response Teams */
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);

  /* Step 4 — SOP & Guidelines */
  const [sop, setSop] = useState<SOPDefinition | null>(null);
  const [sopLoading, setSopLoading] = useState(false);

  /* Step 5 — NPC Personas & Fact Sheet */
  const [personas, setPersonas] = useState<NPCPersona[]>([]);
  const [factSheet, setFactSheet] = useState<FactSheet | null>(null);
  const [personasLoading, setPersonasLoading] = useState(false);

  /* Step 6 — Compile */
  const [compiling, setCompiling] = useState(false);
  const [compileProgress, setCompileProgress] = useState<string[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);

  /* Difficulty & duration */
  const [difficulty, setDifficulty] = useState('medium');
  const [duration, setDuration] = useState(60);

  /* ─── Validation ────────────────────────────────────────────────── */

  const canProceed = useMemo(() => {
    switch (step) {
      case 1:
        return !!crisisType && location.trim().length > 0;
      case 2:
        return communities.length > 0 && !communitiesLoading;
      case 3:
        return teams.length > 0 && !teamsLoading;
      case 4:
        return !!sop && !sopLoading;
      case 5:
        return personas.length > 0 && !!factSheet && !personasLoading;
      case 6:
        return true;
      default:
        return false;
    }
  }, [
    step,
    crisisType,
    location,
    communities,
    communitiesLoading,
    teams,
    teamsLoading,
    sop,
    sopLoading,
    personas,
    factSheet,
    personasLoading,
  ]);

  /* ─── API calls ─────────────────────────────────────────────────── */

  const generateCommunities = useCallback(async () => {
    if (!crisisType) return;
    setCommunitiesLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/suggest-communities'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ crisis_type: crisisType, context, country }),
      });
      if (res.ok) {
        const json = await res.json();
        setCommunities(json.data?.communities || json.communities || []);
      }
    } catch {
      /* fallback below */
    }
    if (communities.length === 0) {
      setCommunities(['Affected minority community', 'Immigrant community']);
    }
    setCommunitiesLoading(false);
  }, [crisisType, context, country, communities.length]);

  const generateTeams = useCallback(async () => {
    if (!crisisType || communities.length === 0) return;
    setTeamsLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/suggest-teams'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ crisis_type: crisisType, communities }),
      });
      if (res.ok) {
        const json = await res.json();
        setTeams(json.data?.teams || json.teams || []);
      }
    } catch {
      /* use fallback */
    }
    if (teams.length === 0) {
      setTeams([
        {
          team_name: 'Social Media Monitoring',
          team_description: 'Monitor feeds, flag hate speech and misinformation',
          min_participants: 2,
          max_participants: 4,
        },
        {
          team_name: 'Content Response',
          team_description: 'Draft and publish counter-narratives and corrections',
          min_participants: 2,
          max_participants: 4,
        },
        {
          team_name: 'Community Liaison',
          team_description: 'Coordinate with community leaders and grassroots networks',
          min_participants: 1,
          max_participants: 3,
        },
        {
          team_name: 'Escalation & Coordination',
          team_description: 'Escalate to authorities, manage inter-agency comms',
          min_participants: 1,
          max_participants: 2,
        },
      ]);
    }
    setTeamsLoading(false);
  }, [crisisType, communities, teams.length]);

  const generateSOP = useCallback(async () => {
    if (!crisisType || communities.length === 0 || teams.length === 0) return;
    setSopLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-sop'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          communities,
          teams: teams.map((t) => ({ team_name: t.team_name })),
        }),
      });
      if (res.ok) {
        const json = await res.json();
        setSop(json.data?.sop || json.sop || json.data || null);
      }
    } catch {
      /* fallback */
    }
    setSopLoading(false);
  }, [crisisType, communities, teams]);

  const generatePersonasAndFacts = useCallback(async () => {
    if (!crisisType) return;
    setPersonasLoading(true);
    try {
      const headers = await authHeaders();
      const [pRes, fRes] = await Promise.all([
        fetchJSON(apiUrl('/api/warroom/social-crisis/generate-personas'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ crisis_type: crisisType, communities, country }),
        }),
        fetchJSON(apiUrl('/api/warroom/social-crisis/generate-factsheet'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ crisis_type: crisisType, location, context }),
        }),
      ]);
      if (pRes.ok) {
        const pJson = await pRes.json();
        setPersonas(pJson.data?.personas || pJson.personas || []);
      }
      if (fRes.ok) {
        const fJson = await fRes.json();
        setFactSheet(fJson.data?.fact_sheet || fJson.fact_sheet || fJson.data || null);
      }
    } catch {
      /* fallback */
    }
    setPersonasLoading(false);
  }, [crisisType, communities, country, location, context]);

  const compileScenario = useCallback(async () => {
    if (!crisisType || !sop || !factSheet) return;
    setCompiling(true);
    setCompileProgress([]);

    const addProgress = (msg: string) => setCompileProgress((prev) => [...prev, msg]);
    addProgress('Initiating scenario compilation...');

    try {
      const headers = await authHeaders();
      addProgress('Generating narrative and objectives...');

      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/compile'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          location,
          country,
          context,
          communities,
          teams,
          sop,
          personas,
          fact_sheet: factSheet,
          duration_minutes: duration,
          difficulty,
        }),
      });

      if (res.ok) {
        addProgress('Generating social media inject timeline...');
        const json = await res.json();
        const id = json.data?.scenario_id || json.scenario_id || json.data?.scenarioId || null;
        addProgress('Generating escalation triggers...');
        addProgress('Assembling final scenario...');
        if (id) {
          setScenarioId(String(id));
          addProgress(`Scenario created successfully! ID: ${String(id)}`);
        } else {
          addProgress('Scenario compiled but no ID returned.');
        }
      } else {
        addProgress('Error: Failed to compile scenario. Check server logs.');
      }
    } catch {
      addProgress('Error: Network error during compilation.');
    }
    setCompiling(false);
  }, [
    crisisType,
    location,
    country,
    context,
    communities,
    teams,
    sop,
    personas,
    factSheet,
    duration,
    difficulty,
  ]);

  /* ─── Step transition ───────────────────────────────────────────── */

  const currentStepIndex = VISIBLE_STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;

  const goBack = () => {
    if (step === 1) {
      navigate('/warroom');
      return;
    }
    if (canGoBack) {
      setStep(VISIBLE_STEPS[currentStepIndex - 1] as typeof step);
    }
  };

  const goNext = async () => {
    const nextStep = VISIBLE_STEPS[currentStepIndex + 1] as typeof step | undefined;
    if (!nextStep) return;

    if (step === 1 && communities.length === 0) {
      setStep(nextStep);
      generateCommunities();
      return;
    }
    if (step === 2 && teams.length === 0) {
      setStep(nextStep);
      generateTeams();
      return;
    }
    if (step === 3 && !sop) {
      setStep(nextStep);
      generateSOP();
      return;
    }
    if (step === 4 && personas.length === 0) {
      setStep(nextStep);
      generatePersonasAndFacts();
      return;
    }
    if (step === 5) {
      setStep(6);
      return;
    }

    setStep(nextStep);
  };

  /* ─── Render helpers ────────────────────────────────────────────── */

  const removeCommunity = (idx: number) =>
    setCommunities((prev) => prev.filter((_, i) => i !== idx));

  const addCommunity = () => {
    const trimmed = newCommunity.trim();
    if (trimmed && !communities.includes(trimmed)) {
      setCommunities((prev) => [...prev, trimmed]);
      setNewCommunity('');
    }
  };

  const removeTeam = (idx: number) => setTeams((prev) => prev.filter((_, i) => i !== idx));

  const updateTeam = (idx: number, field: keyof TeamEntry, value: string | number) => {
    setTeams((prev) => prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)));
  };

  const removePersona = (idx: number) => setPersonas((prev) => prev.filter((_, i) => i !== idx));

  /* ─── Render ────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen scanline p-2 sm:p-6">
      <div className="w-full px-1 sm:px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/warroom')}
              className="text-xs terminal-text text-robotic-yellow/50 hover:text-robotic-yellow border border-robotic-gray-200 px-2 py-1"
            >
              ← WAR ROOM
            </button>
            <h1 className="text-2xl terminal-text uppercase tracking-wider">
              [SOCIAL CRISIS WIZARD]
            </h1>
          </div>
          <span className="text-xs terminal-text text-robotic-yellow/50">📱 Social Media Mode</span>
        </div>

        {/* Progress bar */}
        <div className="military-border p-2 sm:p-3 mb-4 sm:mb-6 bg-robotic-gray-300 flex-shrink-0">
          <div className="flex items-center gap-1 overflow-x-auto">
            {VISIBLE_STEPS.map((s, i) => {
              const isCurrent = s === step;
              const isPast = VISIBLE_STEPS.indexOf(step) > i;
              return (
                <div key={s} className="flex items-center">
                  {i > 0 && (
                    <div
                      className={`w-4 h-px mx-1 ${isPast ? 'bg-robotic-yellow' : 'bg-robotic-gray-200'}`}
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
                      {isPast ? '✓' : i + 1}
                    </span>
                    <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content */}
        <div className="military-border p-4 sm:p-6 mb-4 sm:mb-6">
          {/* ── Step 1: Crisis Event ─────────────────────────────── */}
          {step === 1 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 1: CRISIS EVENT]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                Select the type of social media crisis and provide location details.
              </p>

              <div className="mb-6">
                <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                  Crisis Type
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {CRISIS_TYPES.map((ct) => (
                    <button
                      key={ct.id}
                      onClick={() => setCrisisType(ct.id)}
                      className={`p-4 border rounded text-left transition-all ${
                        crisisType === ct.id
                          ? 'border-cyan-400 bg-cyan-900/30'
                          : 'border-robotic-gray-200 hover:border-robotic-yellow/50'
                      }`}
                    >
                      <div className="text-2xl mb-2">{ct.icon}</div>
                      <div className="text-xs terminal-text font-bold mb-1">{ct.label}</div>
                      <div className="text-[10px] terminal-text text-robotic-yellow/40">
                        {ct.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                    Location
                  </label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. Woodlands, Singapore"
                    className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                    Country
                  </label>
                  <input
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                  Additional Context (optional)
                </label>
                <textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={3}
                  placeholder="Any specific scenario details, recent events, or nuances to incorporate..."
                  className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none resize-none"
                />
              </div>
            </div>
          )}

          {/* ── Step 2: Affected Communities ──────────────────────── */}
          {step === 2 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 2: AFFECTED COMMUNITIES]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                Communities likely targeted by hate speech and misinformation. AI-suggested — edit
                as needed.
              </p>

              {communitiesLoading ? (
                <div className="flex items-center gap-3 py-8 justify-center">
                  <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
                  <span className="text-sm terminal-text text-robotic-yellow/60 animate-pulse">
                    Analyzing crisis context for affected communities...
                  </span>
                </div>
              ) : (
                <>
                  <div className="space-y-2 mb-4">
                    {communities.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between border border-robotic-gray-200 px-4 py-3 rounded"
                      >
                        <span className="text-sm terminal-text">{c}</span>
                        <button
                          onClick={() => removeCommunity(i)}
                          className="text-xs terminal-text text-red-400/60 hover:text-red-400"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCommunity}
                      onChange={(e) => setNewCommunity(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addCommunity()}
                      placeholder="Add a community..."
                      className="flex-1 bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
                    />
                    <button
                      onClick={addCommunity}
                      className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
                    >
                      + Add
                    </button>
                  </div>

                  <button
                    onClick={generateCommunities}
                    className="mt-4 text-xs terminal-text text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ↻ Regenerate suggestions
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Step 3: Response Teams ────────────────────────────── */}
          {step === 3 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 3: RESPONSE TEAMS]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                AI-suggested response team structure. Edit team names, descriptions, and participant
                counts.
              </p>

              {teamsLoading ? (
                <div className="flex items-center gap-3 py-8 justify-center">
                  <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
                  <span className="text-sm terminal-text text-robotic-yellow/60 animate-pulse">
                    Generating response team structure...
                  </span>
                </div>
              ) : (
                <>
                  <div className="space-y-3 mb-4">
                    {teams.map((t, i) => (
                      <div key={i} className="border border-robotic-gray-200 rounded p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-3">
                            <input
                              type="text"
                              value={t.team_name}
                              onChange={(e) => updateTeam(i, 'team_name', e.target.value)}
                              className="w-full bg-transparent border-b border-robotic-gray-200 pb-1 text-sm terminal-text text-robotic-yellow font-bold focus:border-robotic-yellow/70 focus:outline-none"
                            />
                            <textarea
                              value={t.team_description}
                              onChange={(e) => updateTeam(i, 'team_description', e.target.value)}
                              rows={2}
                              className="w-full bg-transparent border border-robotic-gray-200 px-2 py-1 text-xs terminal-text text-robotic-yellow/70 focus:border-robotic-yellow/70 focus:outline-none resize-none"
                            />
                            <div className="flex items-center gap-4">
                              <label className="text-[10px] terminal-text text-robotic-yellow/40">
                                Min:
                                <input
                                  type="number"
                                  min={1}
                                  max={10}
                                  value={t.min_participants}
                                  onChange={(e) =>
                                    updateTeam(i, 'min_participants', Number(e.target.value))
                                  }
                                  className="w-12 ml-1 bg-transparent border border-robotic-gray-200 px-1 py-0.5 text-xs terminal-text text-robotic-yellow text-center focus:outline-none"
                                />
                              </label>
                              <label className="text-[10px] terminal-text text-robotic-yellow/40">
                                Max:
                                <input
                                  type="number"
                                  min={1}
                                  max={10}
                                  value={t.max_participants}
                                  onChange={(e) =>
                                    updateTeam(i, 'max_participants', Number(e.target.value))
                                  }
                                  className="w-12 ml-1 bg-transparent border border-robotic-gray-200 px-1 py-0.5 text-xs terminal-text text-robotic-yellow text-center focus:outline-none"
                                />
                              </label>
                            </div>
                          </div>
                          <button
                            onClick={() => removeTeam(i)}
                            className="text-xs terminal-text text-red-400/60 hover:text-red-400 mt-1"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={generateTeams}
                    className="text-xs terminal-text text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ↻ Regenerate teams
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Step 4: SOP & Guidelines ──────────────────────────── */}
          {step === 4 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 4: SOP & GUIDELINES]</h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                AI-generated Standard Operating Procedure for crisis response. Review and edit
                before proceeding.
              </p>

              {sopLoading ? (
                <div className="flex items-center gap-3 py-8 justify-center">
                  <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
                  <span className="text-sm terminal-text text-robotic-yellow/60 animate-pulse">
                    Generating SOP and content guidelines...
                  </span>
                </div>
              ) : sop ? (
                <>
                  <div className="border border-robotic-gray-200 rounded p-4 mb-4">
                    <input
                      type="text"
                      value={sop.sop_name}
                      onChange={(e) => setSop({ ...sop, sop_name: e.target.value })}
                      className="w-full bg-transparent border-b border-robotic-gray-200 pb-1 mb-2 text-sm terminal-text text-robotic-yellow font-bold focus:border-robotic-yellow/70 focus:outline-none"
                    />
                    <textarea
                      value={sop.description}
                      onChange={(e) => setSop({ ...sop, description: e.target.value })}
                      rows={2}
                      className="w-full bg-transparent border border-robotic-gray-200 px-2 py-1 mb-3 text-xs terminal-text text-robotic-yellow/70 focus:border-robotic-yellow/70 focus:outline-none resize-none"
                    />
                    <div className="text-[10px] terminal-text text-robotic-yellow/40 uppercase mb-2">
                      Response Time Limit: {sop.response_time_limit_minutes} min
                    </div>
                  </div>

                  <div className="mb-4">
                    <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                      SOP Steps
                    </h3>
                    <div className="space-y-2">
                      {sop.steps.map((s, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 border border-robotic-gray-200 px-3 py-2 rounded"
                        >
                          <span className="text-[10px] terminal-text text-robotic-yellow/30 w-6">
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <div className="flex-1">
                            <div className="text-xs terminal-text font-bold">{s.name}</div>
                            <div className="text-[10px] terminal-text text-robotic-yellow/50">
                              {s.description}
                            </div>
                          </div>
                          <span className="text-[10px] terminal-text text-cyan-400">
                            T+{s.time_limit_minutes}m
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border border-robotic-gray-200 rounded p-4">
                    <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                      Content Guidelines
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-[10px] terminal-text text-green-400/60 uppercase mb-1">
                          Tone
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sop.content_guidelines.tone.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] terminal-text bg-green-900/20 border border-green-700/30 px-2 py-0.5 rounded"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] terminal-text text-red-400/60 uppercase mb-1">
                          Avoid
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sop.content_guidelines.avoid.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] terminal-text bg-red-900/20 border border-red-700/30 px-2 py-0.5 rounded"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] terminal-text text-cyan-400/60 uppercase mb-1">
                          Include
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sop.content_guidelines.include.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] terminal-text bg-cyan-900/20 border border-cyan-700/30 px-2 py-0.5 rounded"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] terminal-text text-yellow-400/60 uppercase mb-1">
                          Language Sensitivity
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sop.content_guidelines.language_sensitivity.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] terminal-text bg-yellow-900/20 border border-yellow-700/30 px-2 py-0.5 rounded"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={generateSOP}
                    className="mt-4 text-xs terminal-text text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ↻ Regenerate SOP
                  </button>
                </>
              ) : (
                <div className="text-center py-8">
                  <p className="text-sm terminal-text text-robotic-yellow/50 mb-4">
                    No SOP generated yet.
                  </p>
                  <button
                    onClick={generateSOP}
                    className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
                  >
                    Generate SOP
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 5: NPC Personas & Fact Sheet ─────────────────── */}
          {step === 5 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">
                [STEP 5: NPC PERSONAS & FACT SHEET]
              </h2>
              <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
                AI-generated social media personas and fact/misinformation sheet for the simulation.
              </p>

              {personasLoading ? (
                <div className="flex items-center gap-3 py-8 justify-center">
                  <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
                  <span className="text-sm terminal-text text-robotic-yellow/60 animate-pulse">
                    Generating NPC personas and fact sheet...
                  </span>
                </div>
              ) : (
                <>
                  {/* Personas */}
                  <div className="mb-6">
                    <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                      NPC Personas ({personas.length})
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {personas.map((p, i) => (
                        <div
                          key={i}
                          className="border border-robotic-gray-200 rounded p-3 relative"
                        >
                          <button
                            onClick={() => removePersona(i)}
                            className="absolute top-2 right-2 text-xs terminal-text text-red-400/60 hover:text-red-400"
                          >
                            ✕
                          </button>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs terminal-text text-cyan-400">{p.handle}</span>
                            <span
                              className={`text-[9px] terminal-text px-1.5 py-0.5 rounded uppercase ${
                                p.type === 'npc_media'
                                  ? 'bg-blue-900/30 text-blue-400'
                                  : p.type === 'npc_politician'
                                    ? 'bg-purple-900/30 text-purple-400'
                                    : p.type === 'npc_influencer'
                                      ? 'bg-pink-900/30 text-pink-400'
                                      : 'bg-robotic-gray-200/30 text-robotic-yellow/60'
                              }`}
                            >
                              {p.type.replace('npc_', '')}
                            </span>
                          </div>
                          <div className="text-xs terminal-text font-bold mb-1">{p.name}</div>
                          <div className="text-[10px] terminal-text text-robotic-yellow/50 mb-1">
                            {p.personality}
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] terminal-text text-robotic-yellow/30">
                              Bias: {p.bias}
                            </span>
                            <span className="text-[9px] terminal-text text-robotic-yellow/30">
                              {p.follower_count.toLocaleString()} followers
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Fact Sheet */}
                  {factSheet && (
                    <div className="mb-4">
                      <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                        Fact Sheet
                      </h3>

                      <div className="mb-3">
                        <div className="text-[10px] terminal-text text-green-400/60 uppercase mb-2">
                          Confirmed Facts
                        </div>
                        <div className="space-y-1">
                          {factSheet.confirmed_facts.map((f, i) => (
                            <div
                              key={i}
                              className="flex items-start gap-2 text-xs terminal-text text-robotic-yellow/70"
                            >
                              <span className="text-green-400 mt-0.5">✓</span>
                              <span>{f}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="text-[10px] terminal-text text-red-400/60 uppercase mb-2">
                          Unconfirmed / False Claims
                        </div>
                        <div className="space-y-2">
                          {factSheet.unconfirmed_claims.map((c, i) => (
                            <div
                              key={i}
                              className="border border-robotic-gray-200 rounded px-3 py-2"
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <span
                                  className={`text-[9px] terminal-text px-1.5 py-0.5 rounded uppercase ${
                                    c.status === 'FALSE'
                                      ? 'bg-red-900/30 text-red-400'
                                      : 'bg-yellow-900/30 text-yellow-400'
                                  }`}
                                >
                                  {c.status}
                                </span>
                                <span className="text-xs terminal-text">{c.claim}</span>
                              </div>
                              <div className="text-[10px] terminal-text text-robotic-yellow/40 ml-4">
                                Truth: {c.truth}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={generatePersonasAndFacts}
                    className="text-xs terminal-text text-cyan-400 hover:text-cyan-300 underline"
                  >
                    ↻ Regenerate all
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Step 6: Compile ───────────────────────────────────── */}
          {step === 6 && (
            <div>
              <h2 className="text-lg terminal-text uppercase mb-4">[STEP 6: COMPILE SCENARIO]</h2>

              {!scenarioId && !compiling && (
                <div className="space-y-6">
                  <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
                    Configure final settings, then compile the full social crisis scenario with
                    AI-generated inject timeline.
                  </p>

                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div>
                      <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                        Difficulty
                      </label>
                      <select
                        value={difficulty}
                        onChange={(e) => setDifficulty(e.target.value)}
                        className="w-full bg-robotic-gray-300 border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
                      >
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
                        Duration (minutes)
                      </label>
                      <input
                        type="number"
                        value={duration}
                        onChange={(e) => setDuration(Number(e.target.value))}
                        min={15}
                        max={180}
                        step={15}
                        className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Summary */}
                  <div className="border border-robotic-gray-200 rounded p-4 mb-4">
                    <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                      Scenario Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-xs terminal-text">
                      <div>
                        <span className="text-robotic-yellow/40">Crisis:</span>{' '}
                        <span className="text-robotic-yellow">
                          {CRISIS_TYPES.find((c) => c.id === crisisType)?.label || crisisType}
                        </span>
                      </div>
                      <div>
                        <span className="text-robotic-yellow/40">Location:</span>{' '}
                        <span className="text-robotic-yellow">
                          {location}, {country}
                        </span>
                      </div>
                      <div>
                        <span className="text-robotic-yellow/40">Communities:</span>{' '}
                        <span className="text-robotic-yellow">{communities.join(', ')}</span>
                      </div>
                      <div>
                        <span className="text-robotic-yellow/40">Teams:</span>{' '}
                        <span className="text-robotic-yellow">{teams.length}</span>
                      </div>
                      <div>
                        <span className="text-robotic-yellow/40">SOP Steps:</span>{' '}
                        <span className="text-robotic-yellow">{sop?.steps.length || 0}</span>
                      </div>
                      <div>
                        <span className="text-robotic-yellow/40">NPC Personas:</span>{' '}
                        <span className="text-robotic-yellow">{personas.length}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={compileScenario}
                    className="military-button px-8 py-3 w-full text-center"
                  >
                    [COMPILE SCENARIO]
                  </button>
                </div>
              )}

              {compiling && (
                <div className="py-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
                    <span className="text-sm terminal-text text-robotic-yellow animate-pulse">
                      Compiling scenario...
                    </span>
                  </div>
                  <div className="border border-robotic-gray-200 rounded p-4 bg-black/30 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
                    {compileProgress.map((msg, i) => (
                      <div key={i} className="text-robotic-yellow/70">
                        <span className="text-robotic-yellow/30">
                          [{String(i + 1).padStart(2, '0')}]
                        </span>{' '}
                        {msg}
                      </div>
                    ))}
                    <div className="animate-pulse text-robotic-yellow/40">▌</div>
                  </div>
                </div>
              )}

              {scenarioId && !compiling && (
                <div className="text-center py-8">
                  <div className="text-4xl mb-4">✅</div>
                  <h3 className="text-lg terminal-text font-bold mb-2">
                    Scenario Created Successfully
                  </h3>
                  <p className="text-xs terminal-text text-robotic-yellow/50 mb-2">
                    Scenario ID: {scenarioId}
                  </p>
                  <div className="border border-robotic-gray-200 rounded p-4 bg-black/30 font-mono text-xs space-y-1 max-h-48 overflow-y-auto mb-6">
                    {compileProgress.map((msg, i) => (
                      <div key={i} className="text-robotic-yellow/70">
                        <span className="text-robotic-yellow/30">
                          [{String(i + 1).padStart(2, '0')}]
                        </span>{' '}
                        {msg}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-center gap-4">
                    <a href="/scenarios" className="military-button px-8 py-3 text-center">
                      [VIEW SCENARIOS]
                    </a>
                    <button
                      onClick={() => navigate('/sessions')}
                      className="px-8 py-3 text-xs terminal-text uppercase border border-cyan-500/50 text-cyan-400 hover:bg-cyan-900/20"
                    >
                      [CREATE SESSION]
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between items-center flex-shrink-0 pt-2">
          <button
            onClick={goBack}
            className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
          >
            {step === 1 ? '[← WAR ROOM]' : '[BACK]'}
          </button>
          <span className="text-xs terminal-text text-robotic-yellow/40">
            Step {VISIBLE_STEPS.indexOf(step) + 1} of {VISIBLE_STEPS.length}
          </span>
          {step === 6 ? (
            scenarioId ? (
              <a href="/scenarios" className="military-button px-8 py-3 text-center">
                [VIEW SCENARIOS]
              </a>
            ) : (
              <span className="text-xs terminal-text text-robotic-yellow/30">
                {compiling ? 'Compiling...' : 'Configure & compile above'}
              </span>
            )
          ) : (
            <button
              onClick={goNext}
              disabled={!canProceed}
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
