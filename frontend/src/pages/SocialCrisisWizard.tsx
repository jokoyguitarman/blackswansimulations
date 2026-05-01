import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/* ─── Types ─────────────────────────────────────────────────────────── */

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

interface TeamDef {
  team_name: string;
  team_description: string;
  min_participants: number;
  max_participants: number;
}

interface SocialInject {
  trigger_time_minutes?: number;
  type: string;
  title: string;
  content: string;
  severity: string;
  inject_scope: string;
  target_teams: string[];
  requires_response?: boolean;
  response_deadline_minutes?: number;
  delivery_config?: Record<string, unknown>;
  conditions_to_appear?: unknown;
  conditions_to_cancel?: string[];
  eligible_after_minutes?: number;
}

interface ObjectiveDef {
  objective_id: string;
  objective_name: string;
  description: string;
  weight: number;
}

interface ResearchGuidelines {
  per_team: Array<{
    team_name: string;
    guidelines: Array<{
      guideline_id: string;
      best_practice: string;
      source_basis: string;
      timing_window?: string;
      if_violated: string;
      if_followed: string;
      detection_signals: string[];
    }>;
  }>;
  group_wide: {
    coordination_guidelines: string[];
    escalation_protocols: string[];
    timing_benchmarks: Record<string, number>;
    case_studies: Array<{ name: string; summary: string; lessons: string[] }>;
  };
}

/* ─── Constants ─────────────────────────────────────────────────────── */

const CRISIS_TYPES = [
  {
    id: 'racial_tension',
    label: 'Racial Tension',
    icon: '⚡',
    description: 'Hate speech and scapegoating targeting ethnic communities',
    default_context:
      'A violent assault has occurred in a public area. Bystander video goes viral showing the attacker, who appears to be of a specific ethnicity. Social media erupts with racist generalizations, calls to "send them back", and threats against the attacker\'s perceived ethnic community. Community members who share the attacker\'s ethnicity report receiving threats and harassment online. Several viral posts falsely claim the attack was coordinated by a larger group.',
  },
  {
    id: 'religious_incident',
    label: 'Religious Incident',
    icon: '🕌',
    description: 'Inflammatory posts targeting religious communities',
    default_context:
      'A place of worship has been vandalized with hate symbols and threatening graffiti overnight. Photos spread rapidly on social media. Inflammatory accounts claim this is "justified payback" for a recent overseas terror attack attributed to the same religion. Counter-posts from the affected religious community express fear and anger. Unverified claims circulate that the vandalism is a false flag. Community leaders call for calm while demanding police action. A local politician\'s ambiguous statement about "understanding frustrations" goes viral and is interpreted as endorsing the vandalism.',
  },
  {
    id: 'xenophobic_attack',
    label: 'Xenophobic Attack',
    icon: '🌍',
    description: 'Anti-immigrant sentiment and misinformation',
    default_context:
      'A workplace accident at a construction site has resulted in multiple injuries. Initial reports indicate the site employed a large number of foreign workers. Social media narratives quickly shift from sympathy for the injured to blaming foreign workers for "taking local jobs" and "lowering safety standards." Viral posts falsely claim foreign workers are paid to undercut locals. Anti-immigration hashtags trend. Foreign worker dormitory addresses are shared online with threatening messages. Migrant advocacy groups report a spike in harassment.',
  },
  {
    id: 'terror_aftermath',
    label: 'Terror Aftermath',
    icon: '💥',
    description: 'Social media backlash after a terror event',
    default_context:
      "An explosion has occurred at a crowded public transit station during morning rush hour. At least 15 people injured, 3 in critical condition. Police confirm it was caused by an improvised explosive device. No arrests have been made and no group has claimed responsibility. Social media immediately attributes the attack to a specific ethnic and religious minority community without any evidence. Hate speech surges with calls for deportation, travel bans, and vigilante action. A fake video claiming to show the bomber's face goes viral — it is actually footage from an unrelated incident in another country years ago. Muslim community members report being verbally and physically harassed on public transport.",
  },
  {
    id: 'police_incident',
    label: 'Police Incident',
    icon: '🚔',
    description: 'Viral video of a controversial police encounter',
    default_context:
      "A bystander video shows police officers using force during an arrest of a person from a visible minority group. The 45-second clip, which does not show what preceded the arrest, goes viral with millions of views. Social media splits between those accusing police of racial profiling and excessive force, and those defending police actions. Protest hashtags trend alongside counter-hashtags. Doxxing attempts target both the officers and the arrested individual. Unverified claims about the arrested person's criminal history circulate. Community organizations demand an independent investigation. A planned vigil is co-opted online by extremist groups on both sides.",
  },
  {
    id: 'fake_news_spiral',
    label: 'Fake News Spiral',
    icon: '📰',
    description: 'Viral misinformation causing real-world harm',
    default_context:
      'A fabricated news article claiming that a specific ethnic community is responsible for a disease outbreak has gone viral across multiple social media platforms. The article cites a non-existent "health ministry report" and includes manipulated photos. It has been shared over 50,000 times in 3 hours. Real-world consequences are emerging: businesses owned by the targeted community report customers refusing to enter, children from the community are being bullied at school, and a popular restaurant has been vandalized. The actual health ministry has not issued any such report. Mainstream media has not yet picked up the debunking. Influencer accounts with large followings are amplifying the false claims.',
  },
];

const STEP_LABELS: Record<number, string> = {
  1: 'Crisis Event',
  2: 'Characters & Facts',
  3: 'Response Teams',
  4: 'Team Storylines',
  5: 'Convergence',
  6: 'Research',
  7: 'Review & Compile',
};

const VISIBLE_STEPS = [1, 2, 3, 4, 5, 6, 7];

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

/* ─── Spinner ────────────────────────────────────────────────────────── */

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-8 justify-center">
      <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
      <span className="text-sm terminal-text text-robotic-yellow/60 animate-pulse">{text}</span>
    </div>
  );
}

/* ─── Component ─────────────────────────────────────────────────────── */

export const SocialCrisisWizard = () => {
  const [step, setStep] = useState(1);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const resumedRef = useRef(false);

  /* Draft persistence */
  const [wizardDraftId, setWizardDraftId] = useState<string | null>(null);

  /* Step 1 — Crisis Event */
  const [crisisType, setCrisisType] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('Singapore');
  const [context, setContext] = useState('');

  /* Step 2 — NPCs, Fact Sheet & Communities */
  const [personas, setPersonas] = useState<NPCPersona[]>([]);
  const [factSheet, setFactSheet] = useState<FactSheet | null>(null);
  const [communities, setCommunities] = useState<string[]>([]);
  const [step2Loading, setStep2Loading] = useState(false);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  /* Step 3 — Response Teams */
  const [teams, setTeams] = useState<TeamDef[]>([]);
  const [step3Loading, setStep3Loading] = useState(false);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  /* Step 4 — Per-Team Storylines (NDJSON streaming) */
  const [teamStorylines, setTeamStorylines] = useState<Record<string, SocialInject[]>>({});
  const [step4Loading, setStep4Loading] = useState(false);
  const [step4Progress, setStep4Progress] = useState<string[]>([]);
  const [step4Error, setStep4Error] = useState<string | null>(null);

  /* Step 5 — Convergence + Shared Chaos */
  const [sharedInjects, setSharedInjects] = useState<SocialInject[]>([]);
  const [convergenceGates, setConvergenceGates] = useState<SocialInject[]>([]);
  const [narrative, setNarrative] = useState<{
    title: string;
    description: string;
    briefing: string;
  } | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveDef[]>([]);
  const [step5Loading, setStep5Loading] = useState(false);
  const [step5Error, setStep5Error] = useState<string | null>(null);

  /* Step 6 — Research (NDJSON streaming) */
  const [research, setResearch] = useState<ResearchGuidelines | null>(null);
  const [step6Loading, setStep6Loading] = useState(false);
  const [step6Progress, setStep6Progress] = useState<string[]>([]);
  const [step6Error, setStep6Error] = useState<string | null>(null);

  /* Step 7 — Compile */
  const [compiling, setCompiling] = useState(false);
  const [compileProgress, setCompileProgress] = useState<string[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [scenarioTitle, setScenarioTitle] = useState('');

  /* ─── Draft save/resume ──────────────────────────────────────────── */

  const buildDraftInput = useCallback(
    () => ({
      sim_mode: 'social_media',
      crisis_type: crisisType,
      location,
      country,
      context,
      personas,
      fact_sheet: factSheet,
      communities,
      teams,
      team_storylines: teamStorylines,
      shared_injects: sharedInjects,
      convergence_gates: convergenceGates,
      narrative,
      objectives,
      research,
    }),
    [
      crisisType,
      location,
      country,
      context,
      personas,
      factSheet,
      communities,
      teams,
      teamStorylines,
      sharedInjects,
      convergenceGates,
      narrative,
      objectives,
      research,
    ],
  );

  const saveDraftState = useCallback(
    async (nextStep: number) => {
      try {
        const headers = await authHeaders();
        if (!wizardDraftId) {
          const res = await fetchJSON(apiUrl('/api/warroom/wizard/drafts'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: buildDraftInput() }),
          });
          if (res.ok) {
            const json = await res.json();
            const newId = String(json.data?.draft_id || '');
            if (newId) {
              setWizardDraftId(newId);
              setSearchParams({ draft: newId }, { replace: true });
            }
            return newId;
          }
          return null;
        }
        await fetchJSON(apiUrl(`/api/warroom/wizard/drafts/${wizardDraftId}`), {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ current_step: nextStep, input: buildDraftInput() }),
        });
        return wizardDraftId;
      } catch (err) {
        console.error('Failed to save social crisis draft', err);
        return wizardDraftId;
      }
    },
    [wizardDraftId, buildDraftInput, setSearchParams],
  );

  useEffect(() => {
    if (resumedRef.current) return;
    const draftParam = searchParams.get('draft');
    if (!draftParam) return;
    resumedRef.current = true;

    const resume = async () => {
      try {
        const headers = await authHeaders();
        const res = await fetchJSON(apiUrl(`/api/warroom/wizard/drafts/${draftParam}`), {
          headers,
        });
        if (!res.ok) return;
        const json = await res.json();
        const draft = json.data;
        if (!draft) return;

        setWizardDraftId(draftParam);
        const input = (draft.input ?? {}) as Record<string, unknown>;
        const savedStep = Number(draft.current_step) || 1;
        const validStep = VISIBLE_STEPS.includes(savedStep) ? savedStep : 1;

        if (input.crisis_type) setCrisisType(String(input.crisis_type));
        if (input.location) setLocation(String(input.location));
        if (input.country) setCountry(String(input.country));
        if (input.context) setContext(String(input.context));
        if (Array.isArray(input.communities)) setCommunities(input.communities.map(String));
        if (Array.isArray(input.personas)) setPersonas(input.personas as NPCPersona[]);
        if (input.fact_sheet) setFactSheet(input.fact_sheet as FactSheet);
        if (Array.isArray(input.teams)) setTeams(input.teams as TeamDef[]);
        if (input.team_storylines && typeof input.team_storylines === 'object') {
          setTeamStorylines(input.team_storylines as Record<string, SocialInject[]>);
        }
        if (Array.isArray(input.shared_injects))
          setSharedInjects(input.shared_injects as SocialInject[]);
        if (Array.isArray(input.convergence_gates))
          setConvergenceGates(input.convergence_gates as ConvergenceGate[]);
        if (input.narrative) setNarrative(String(input.narrative));
        if (Array.isArray(input.objectives)) setObjectives(input.objectives.map(String));
        if (input.research) setResearch(input.research as ResearchGuidelines);

        setStep(validStep);
      } catch (err) {
        console.error('Failed to resume social crisis draft', err);
      }
    };
    resume();
  }, [searchParams]);

  /* ─── Effective context (use default_context as fallback) ────────── */

  const effectiveContext = useMemo(() => {
    if (context.trim()) return context.trim();
    const match = CRISIS_TYPES.find((t) => t.id === crisisType);
    return match?.default_context || '';
  }, [context, crisisType]);

  /* ─── Validation ───────────────────────────────────────────────────── */

  const canProceed = useMemo(() => {
    switch (step) {
      case 1:
        return !!crisisType && location.trim().length > 0;
      case 2:
        return personas.length > 0 && !!factSheet && !step2Loading;
      case 3:
        return teams.length > 0 && !step3Loading;
      case 4:
        return Object.keys(teamStorylines).length > 0 && !step4Loading;
      case 5:
        return (sharedInjects.length > 0 || convergenceGates.length > 0) && !step5Loading;
      case 6:
        return !!research && !step6Loading;
      case 7:
        return true;
      default:
        return false;
    }
  }, [
    step,
    crisisType,
    location,
    personas,
    factSheet,
    step2Loading,
    teams,
    step3Loading,
    teamStorylines,
    step4Loading,
    sharedInjects,
    convergenceGates,
    step5Loading,
    research,
    step6Loading,
  ]);

  /* ─── API calls ──────────────────────────────────────────────────── */

  const generateNPCs = useCallback(async () => {
    if (!crisisType) return;
    setStep2Loading(true);
    setStep2Error(null);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-npcs'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          location,
          country,
          context: effectiveContext,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const d = json.data || json;
        if (Array.isArray(d.personas)) setPersonas(d.personas);
        if (d.factSheet || d.fact_sheet) setFactSheet((d.factSheet || d.fact_sheet) as FactSheet);
        if (Array.isArray(d.communities)) setCommunities(d.communities);
      } else {
        setStep2Error('Failed to generate NPCs. Try again.');
      }
    } catch {
      setStep2Error('Network error generating NPCs.');
    }
    setStep2Loading(false);
  }, [crisisType, location, country, effectiveContext]);

  const generateTeams = useCallback(async () => {
    if (!crisisType) return;
    setStep3Loading(true);
    setStep3Error(null);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/suggest-teams'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          communities,
          context: effectiveContext,
          country,
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const d = json.data;
        setTeams(Array.isArray(d) ? d : d?.teams || []);
      } else {
        setStep3Error('Failed to suggest teams. Try again.');
      }
    } catch {
      setStep3Error('Network error suggesting teams.');
    }
    setStep3Loading(false);
  }, [crisisType, communities, effectiveContext, country]);

  const generateStorylines = useCallback(async () => {
    if (!crisisType || teams.length === 0) return;
    setStep4Loading(true);
    setStep4Error(null);
    setStep4Progress([]);
    setTeamStorylines({});

    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-storylines'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          location,
          country,
          context: effectiveContext,
          communities,
          teams,
          personas,
          fact_sheet: factSheet,
        }),
      });

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'team_complete') {
                setStep4Progress((prev) => [
                  ...prev,
                  `Generated ${Number(msg.inject_count)} injects for ${String(msg.team)}`,
                ]);
              } else if (msg.type === 'complete' && msg.storylines) {
                setTeamStorylines(msg.storylines);
              } else if (msg.type === 'error') {
                setStep4Error(String(msg.message || 'Storyline generation failed'));
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      } else {
        setStep4Error('Failed to generate storylines.');
      }
    } catch {
      setStep4Error('Network error generating storylines.');
    }
    setStep4Loading(false);
  }, [crisisType, location, country, effectiveContext, communities, teams, personas, factSheet]);

  const generateConvergence = useCallback(async () => {
    if (!crisisType || Object.keys(teamStorylines).length === 0) return;
    setStep5Loading(true);
    setStep5Error(null);

    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-convergence'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          location,
          country,
          context: effectiveContext,
          communities,
          teams,
          personas,
          fact_sheet: factSheet,
          team_storylines: teamStorylines,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const d = json.data || json;
        const si = d.sharedInjects || d.shared_injects;
        if (Array.isArray(si)) setSharedInjects(si);
        const cg = d.convergenceGates || d.convergence_gates;
        if (Array.isArray(cg)) setConvergenceGates(cg);
        if (d.narrative && typeof d.narrative === 'object') setNarrative(d.narrative);
        if (Array.isArray(d.objectives)) setObjectives(d.objectives);
      } else {
        setStep5Error('Failed to generate convergence. Try again.');
      }
    } catch {
      setStep5Error('Network error generating convergence.');
    }
    setStep5Loading(false);
  }, [
    crisisType,
    location,
    country,
    effectiveContext,
    communities,
    teams,
    personas,
    factSheet,
    teamStorylines,
  ]);

  const generateResearch = useCallback(async () => {
    if (!crisisType) return;
    setStep6Loading(true);
    setStep6Error(null);
    setStep6Progress([]);
    setResearch(null);

    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/research'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisType,
          context: effectiveContext,
          teams,
          team_storylines: teamStorylines,
        }),
      });

      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'team_research_complete') {
                setStep6Progress((prev) => [...prev, `Completed research for ${String(msg.team)}`]);
              } else if (msg.type === 'complete' && msg.research) {
                setResearch(msg.research);
              } else if (msg.type === 'error') {
                setStep6Error(String(msg.message || 'Research generation failed'));
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      } else {
        setStep6Error('Failed to generate research.');
      }
    } catch {
      setStep6Error('Network error generating research.');
    }
    setStep6Loading(false);
  }, [crisisType, effectiveContext, teams, teamStorylines]);

  const compileScenario = useCallback(async () => {
    if (!crisisType) return;
    setCompiling(true);
    setCompileProgress([]);

    const addProgress = (msg: string) => setCompileProgress((prev) => [...prev, msg]);
    addProgress('Initiating scenario compilation...');

    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/compile'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          narrative,
          teams,
          objectives,
          personas,
          fact_sheet: factSheet,
          communities,
          team_storylines: teamStorylines,
          shared_injects: sharedInjects,
          convergence_gates: convergenceGates,
          research,
          duration: 60,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const d = json.data;
        if (d) {
          setScenarioId(String(d.scenario_id));
          if (d.title) setScenarioTitle(String(d.title));
          addProgress(`Scenario created successfully! ID: ${String(d.scenario_id).slice(0, 8)}`);
          if (d.inject_count != null) {
            addProgress(`Total injects: ${Number(d.inject_count)}`);
          }
        }
      } else {
        const errJson = await res.json().catch(() => null);
        addProgress(`Error: ${errJson?.error || 'Failed to compile scenario.'}`);
      }
    } catch {
      addProgress('Error: Network error during compilation.');
    }
    setCompiling(false);
  }, [
    crisisType,
    location,
    country,
    effectiveContext,
    communities,
    teams,
    personas,
    factSheet,
    teamStorylines,
    sharedInjects,
    convergenceGates,
    narrative,
    objectives,
    research,
  ]);

  /* ─── Step transition ────────────────────────────────────────────── */

  const currentStepIndex = VISIBLE_STEPS.indexOf(step);
  const canGoBack = currentStepIndex > 0;

  const goBack = () => {
    if (step === 1) {
      navigate('/warroom');
      return;
    }
    if (canGoBack) {
      setStep(VISIBLE_STEPS[currentStepIndex - 1]);
    }
  };

  const goNext = async () => {
    const nextIdx = currentStepIndex + 1;
    if (nextIdx >= VISIBLE_STEPS.length) return;
    const nextStep = VISIBLE_STEPS[nextIdx];

    await saveDraftState(nextStep);
    setStep(nextStep);

    if (step === 1 && personas.length === 0) {
      generateNPCs();
      return;
    }
    if (step === 2 && teams.length === 0) {
      generateTeams();
      return;
    }
    if (step === 3 && Object.keys(teamStorylines).length === 0) {
      generateStorylines();
      return;
    }
    if (step === 4 && sharedInjects.length === 0 && convergenceGates.length === 0) {
      generateConvergence();
      return;
    }
    if (step === 5 && !research) {
      generateResearch();
      return;
    }
  };

  /* ─── Computed stats for step 7 ──────────────────────────────────── */

  const totalTeamInjects = useMemo(() => {
    let count = 0;
    for (const key of Object.keys(teamStorylines)) {
      count += teamStorylines[key].length;
    }
    return count;
  }, [teamStorylines]);

  const crisisLabel = useMemo(() => {
    return CRISIS_TYPES.find((c) => c.id === crisisType)?.label || crisisType || 'Unknown';
  }, [crisisType]);

  /* ─── Render ─────────────────────────────────────────────────────── */

  const progressBar = (
    <div className="military-border p-2 sm:p-3 mb-4 sm:mb-6 bg-robotic-gray-300 flex-shrink-0">
      <div className="flex items-center gap-1 overflow-x-auto">
        {VISIBLE_STEPS.map((s, i) => {
          const isCurrent = s === step;
          const isPast = currentStepIndex > i;
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
  );

  /* ── Step 1: Crisis Event ──────────────────────────────────────────── */

  const renderStep1 = () => (
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
  );

  /* ── Step 2: Characters & Facts (read-only preview) ────────────────── */

  const renderStep2 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 2: CHARACTERS & FACTS]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        AI-generated NPC personas, fact sheet, and inferred affected communities. Read-only preview.
      </p>

      {step2Loading ? (
        <Spinner text="Generating NPC personas, fact sheet & communities..." />
      ) : step2Error ? (
        <div className="text-center py-8">
          <p className="text-sm terminal-text text-red-400 mb-4">{step2Error}</p>
          <button
            onClick={generateNPCs}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* NPC Personas */}
          <div className="mb-6">
            <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
              NPC Personas ({personas.length})
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {personas.map((p, i) => (
                <div key={i} className="border border-robotic-gray-200 rounded p-3">
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
            <div className="mb-6">
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
                    <div key={i} className="border border-robotic-gray-200 rounded px-3 py-2">
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

          {/* Inferred Communities */}
          {communities.length > 0 && (
            <div>
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Inferred Communities ({communities.length})
              </h3>
              <div className="space-y-1">
                {communities.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 border border-robotic-gray-200 px-4 py-2 rounded"
                  >
                    <span className="text-cyan-400 text-xs">▸</span>
                    <span className="text-sm terminal-text">{c}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  /* ── Step 3: Response Teams (read-only preview) ────────────────────── */

  const renderStep3 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 3: RESPONSE TEAMS]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        AI-suggested response team structure. Read-only preview.
      </p>

      {step3Loading ? (
        <Spinner text="Generating response team structure..." />
      ) : step3Error ? (
        <div className="text-center py-8">
          <p className="text-sm terminal-text text-red-400 mb-4">{step3Error}</p>
          <button
            onClick={generateTeams}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {teams.map((t, i) => (
            <div key={i} className="border border-robotic-gray-200 rounded p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="text-sm terminal-text text-robotic-yellow font-bold mb-1">
                    {t.team_name}
                  </div>
                  <div className="text-xs terminal-text text-robotic-yellow/60 mb-2">
                    {t.team_description}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] terminal-text text-robotic-yellow/40">
                      Participants: {t.min_participants}–{t.max_participants}
                    </span>
                  </div>
                </div>
                <span className="text-lg">
                  {i === 0 ? '🛡️' : i === 1 ? '📢' : i === 2 ? '🤝' : '📋'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ── Step 4: Team Storylines (NDJSON streaming, read-only) ─────────── */

  const renderStep4 = () => {
    const teamNames = Object.keys(teamStorylines);
    return (
      <div>
        <h2 className="text-lg terminal-text uppercase mb-4">[STEP 4: TEAM STORYLINES]</h2>
        <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
          AI-generated per-team inject timelines via streaming. Read-only preview.
        </p>

        {step4Loading && (
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
              <span className="text-sm terminal-text text-robotic-yellow animate-pulse">
                Generating storylines...
              </span>
            </div>
            <div className="border border-robotic-gray-200 rounded p-3 bg-black/30 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
              {step4Progress.map((msg, i) => (
                <div key={i} className="text-robotic-yellow/70">
                  <span className="text-robotic-yellow/30">[{String(i + 1).padStart(2, '0')}]</span>{' '}
                  {msg}
                </div>
              ))}
              <div className="animate-pulse text-robotic-yellow/40">▌</div>
            </div>
          </div>
        )}

        {step4Error && (
          <div className="text-center py-4 mb-4">
            <p className="text-sm terminal-text text-red-400 mb-4">{step4Error}</p>
            <button
              onClick={generateStorylines}
              className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
            >
              Retry
            </button>
          </div>
        )}

        {teamNames.length > 0 && (
          <div className="space-y-6">
            {teamNames.map((teamName) => {
              const injects = teamStorylines[teamName];
              return (
                <div key={teamName} className="border border-robotic-gray-200 rounded p-4">
                  <h3 className="text-sm terminal-text text-cyan-400 font-bold uppercase mb-3">
                    {teamName}
                    <span className="text-[10px] text-robotic-yellow/40 ml-2 normal-case">
                      ({injects.length} injects)
                    </span>
                  </h3>
                  <div className="space-y-2">
                    {injects.map((inj, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-3 border-l-2 border-robotic-yellow/20 pl-3 py-1"
                      >
                        <span className="text-[10px] terminal-text text-cyan-400 whitespace-nowrap mt-0.5">
                          T+{inj.trigger_time_minutes}m
                        </span>
                        <div className="flex-1">
                          <div className="text-xs terminal-text font-bold">{inj.title}</div>
                          <div className="text-[10px] terminal-text text-robotic-yellow/50">
                            {inj.description}
                          </div>
                          <div className="flex gap-2 mt-1">
                            {inj.platform && (
                              <span className="text-[9px] terminal-text bg-blue-900/20 text-blue-400 px-1.5 py-0.5 rounded">
                                {inj.platform}
                              </span>
                            )}
                            {inj.severity && (
                              <span
                                className={`text-[9px] terminal-text px-1.5 py-0.5 rounded ${
                                  inj.severity === 'critical'
                                    ? 'bg-red-900/20 text-red-400'
                                    : inj.severity === 'high'
                                      ? 'bg-orange-900/20 text-orange-400'
                                      : 'bg-yellow-900/20 text-yellow-400'
                                }`}
                              >
                                {inj.severity}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /* ── Step 5: Convergence + Shared Chaos (read-only) ────────────────── */

  const renderStep5 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 5: CONVERGENCE]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        Merged timeline with shared injects and convergence gates. Read-only preview.
      </p>

      {step5Loading ? (
        <Spinner text="Generating convergence layer..." />
      ) : step5Error ? (
        <div className="text-center py-8">
          <p className="text-sm terminal-text text-red-400 mb-4">{step5Error}</p>
          <button
            onClick={generateConvergence}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Narrative */}
          {narrative && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Scenario Narrative
              </h3>
              <div className="border border-robotic-gray-200 rounded p-4 text-xs terminal-text text-robotic-yellow/70 leading-relaxed">
                {narrative}
              </div>
            </div>
          )}

          {/* Objectives */}
          {objectives.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Training Objectives
              </h3>
              <div className="space-y-1">
                {objectives.map((obj, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs terminal-text text-robotic-yellow/70"
                  >
                    <span className="text-cyan-400 mt-0.5">{String(i + 1).padStart(2, '0')}.</span>
                    <span>{obj}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Convergence Gates */}
          {convergenceGates.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Convergence Gates ({convergenceGates.length})
              </h3>
              <div className="space-y-3">
                {convergenceGates.map((gate, i) => (
                  <div key={i} className="border border-cyan-700/30 bg-cyan-900/10 rounded p-4">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-[10px] terminal-text text-cyan-400 whitespace-nowrap">
                        T+{gate.trigger_time_minutes}m
                      </span>
                      <span className="text-xs terminal-text text-cyan-300 font-bold uppercase">
                        {gate.title}
                      </span>
                    </div>
                    <div className="text-[10px] terminal-text text-robotic-yellow/50 mb-2">
                      {gate.description}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {gate.required_teams.map((team, ti) => (
                        <span
                          key={ti}
                          className="text-[9px] terminal-text bg-cyan-900/30 text-cyan-400 px-1.5 py-0.5 rounded"
                        >
                          {team}
                        </span>
                      ))}
                    </div>
                    {gate.conditions.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {gate.conditions.map((cond, ci) => (
                          <div
                            key={ci}
                            className="text-[9px] terminal-text text-robotic-yellow/40 flex gap-1"
                          >
                            <span className="text-cyan-400">•</span> {cond}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shared Injects */}
          {sharedInjects.length > 0 && (
            <div>
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Shared Injects ({sharedInjects.length})
              </h3>
              <div className="space-y-2">
                {sharedInjects.map((inj, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-l-2 border-cyan-400/30 pl-3 py-1"
                  >
                    <span className="text-[10px] terminal-text text-cyan-400 whitespace-nowrap mt-0.5">
                      T+{inj.trigger_time_minutes}m
                    </span>
                    <div className="flex-1">
                      <div className="text-xs terminal-text font-bold">{inj.title}</div>
                      <div className="text-[10px] terminal-text text-robotic-yellow/50">
                        {inj.description}
                      </div>
                      {inj.platform && (
                        <span className="text-[9px] terminal-text bg-blue-900/20 text-blue-400 px-1.5 py-0.5 rounded mt-1 inline-block">
                          {inj.platform}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  /* ── Step 6: Research (NDJSON streaming, read-only) ─────────────────── */

  const renderStep6 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 6: RESEARCH]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        AI-researched guidelines and best practices for this crisis type. Read-only preview.
      </p>

      {step6Loading && (
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
            <span className="text-sm terminal-text text-robotic-yellow animate-pulse">
              Researching best practices...
            </span>
          </div>
          <div className="border border-robotic-gray-200 rounded p-3 bg-black/30 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
            {step6Progress.map((msg, i) => (
              <div key={i} className="text-robotic-yellow/70">
                <span className="text-robotic-yellow/30">[{String(i + 1).padStart(2, '0')}]</span>{' '}
                {msg}
              </div>
            ))}
            <div className="animate-pulse text-robotic-yellow/40">▌</div>
          </div>
        </div>
      )}

      {step6Error && (
        <div className="text-center py-4 mb-4">
          <p className="text-sm terminal-text text-red-400 mb-4">{step6Error}</p>
          <button
            onClick={generateResearch}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      )}

      {research && (
        <>
          {/* Guidelines */}
          {research.guidelines.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Guidelines ({research.guidelines.length})
              </h3>
              <div className="space-y-3">
                {research.guidelines.map((g, i) => (
                  <div key={i} className="border border-robotic-gray-200 rounded p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[9px] terminal-text bg-green-900/20 text-green-400 px-1.5 py-0.5 rounded uppercase">
                        {g.category}
                      </span>
                      {g.source && (
                        <span className="text-[9px] terminal-text text-robotic-yellow/30">
                          Source: {g.source}
                        </span>
                      )}
                    </div>
                    <div className="text-xs terminal-text font-bold mb-1">{g.title}</div>
                    <div className="text-[10px] terminal-text text-robotic-yellow/50 mb-2">
                      {g.summary}
                    </div>
                    {g.recommendations.length > 0 && (
                      <div className="space-y-1">
                        {g.recommendations.map((r, ri) => (
                          <div
                            key={ri}
                            className="text-[10px] terminal-text text-robotic-yellow/40 flex gap-1"
                          >
                            <span className="text-green-400">▸</span> {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Best Practices */}
          {research.best_practices.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Best Practices ({research.best_practices.length})
              </h3>
              <div className="space-y-1">
                {research.best_practices.map((bp, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs terminal-text text-robotic-yellow/70"
                  >
                    <span className="text-green-400 mt-0.5">✓</span>
                    <span>{bp}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Case Studies */}
          {research.case_studies.length > 0 && (
            <div>
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Case Studies ({research.case_studies.length})
              </h3>
              <div className="space-y-2">
                {research.case_studies.map((cs, i) => (
                  <div key={i} className="border border-robotic-gray-200 rounded px-4 py-3">
                    <div className="text-xs terminal-text text-robotic-yellow/70">{cs}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  /* ── Step 7: Review & Compile ──────────────────────────────────────── */

  const renderStep7 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 7: REVIEW & COMPILE]</h2>

      {!scenarioId && !compiling && (
        <div className="space-y-6">
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
            Review the full scenario summary, then compile to persist.
          </p>

          {/* Summary Dashboard */}
          <div className="border border-robotic-gray-200 rounded p-4 mb-4">
            <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-4">
              Scenario Summary
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs terminal-text">
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">
                  {CRISIS_TYPES.find((c) => c.id === crisisType)?.icon || '📋'}
                </div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Crisis Type</div>
                <div className="text-robotic-yellow font-bold">{crisisLabel}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">📍</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Location</div>
                <div className="text-robotic-yellow font-bold">
                  {location}, {country}
                </div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">👥</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Teams</div>
                <div className="text-robotic-yellow font-bold text-lg">{teams.length}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">🎭</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">NPC Count</div>
                <div className="text-robotic-yellow font-bold text-lg">{personas.length}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">💉</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Team Injects</div>
                <div className="text-robotic-yellow font-bold text-lg">{totalTeamInjects}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">🌐</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Shared Injects</div>
                <div className="text-robotic-yellow font-bold text-lg">{sharedInjects.length}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">🚪</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Conv. Gates</div>
                <div className="text-robotic-yellow font-bold text-lg">
                  {convergenceGates.length}
                </div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">📚</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">
                  Research Guidelines
                </div>
                <div className="text-robotic-yellow font-bold text-lg">
                  {research?.guidelines.length || 0}
                </div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-2xl mb-1">🏆</div>
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Best Practices</div>
                <div className="text-robotic-yellow font-bold text-lg">
                  {research?.best_practices.length || 0}
                </div>
              </div>
            </div>
          </div>

          {/* Per-team inject breakdown */}
          {Object.keys(teamStorylines).length > 0 && (
            <div className="border border-robotic-gray-200 rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Injects Per Team
              </h3>
              <div className="space-y-2">
                {Object.keys(teamStorylines).map((teamName) => (
                  <div
                    key={teamName}
                    className="flex items-center justify-between text-xs terminal-text"
                  >
                    <span className="text-robotic-yellow/70">{teamName}</span>
                    <span className="text-cyan-400 font-bold">
                      {teamStorylines[teamName].length} injects
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Narrative preview */}
          {narrative && (
            <div className="border border-robotic-gray-200 rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Narrative
              </h3>
              <div className="text-[10px] terminal-text text-robotic-yellow/50 leading-relaxed line-clamp-4">
                {narrative}
              </div>
            </div>
          )}

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
                <span className="text-robotic-yellow/30">[{String(i + 1).padStart(2, '0')}]</span>{' '}
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
          <h3 className="text-lg terminal-text font-bold mb-2">Scenario Created Successfully</h3>
          {scenarioTitle && (
            <p className="text-sm terminal-text text-cyan-400 mb-1">{scenarioTitle}</p>
          )}
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-2">
            Scenario ID: {scenarioId}
          </p>

          {/* Final stats */}
          <div className="border border-robotic-gray-200 rounded p-4 bg-black/20 text-xs terminal-text mb-4 text-left max-w-md mx-auto">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-robotic-yellow/40">Teams:</span>
              <span className="text-robotic-yellow">{teams.length}</span>
              <span className="text-robotic-yellow/40">NPCs:</span>
              <span className="text-robotic-yellow">{personas.length}</span>
              <span className="text-robotic-yellow/40">Team Injects:</span>
              <span className="text-robotic-yellow">{totalTeamInjects}</span>
              <span className="text-robotic-yellow/40">Shared Injects:</span>
              <span className="text-robotic-yellow">{sharedInjects.length}</span>
              <span className="text-robotic-yellow/40">Convergence Gates:</span>
              <span className="text-robotic-yellow">{convergenceGates.length}</span>
            </div>
          </div>

          <div className="border border-robotic-gray-200 rounded p-4 bg-black/30 font-mono text-xs space-y-1 max-h-48 overflow-y-auto mb-6">
            {compileProgress.map((msg, i) => (
              <div key={i} className="text-robotic-yellow/70">
                <span className="text-robotic-yellow/30">[{String(i + 1).padStart(2, '0')}]</span>{' '}
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
  );

  /* ─── Main return ──────────────────────────────────────────────────── */

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
        {progressBar}

        {/* Step content */}
        <div className="military-border p-4 sm:p-6 mb-4 sm:mb-6">
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
          {step === 5 && renderStep5()}
          {step === 6 && renderStep6()}
          {step === 7 && renderStep7()}
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
            Step {currentStepIndex + 1} of {VISIBLE_STEPS.length}
          </span>
          {step === 7 ? (
            scenarioId ? (
              <a href="/scenarios" className="military-button px-8 py-3 text-center">
                [VIEW SCENARIOS]
              </a>
            ) : (
              <span className="text-xs terminal-text text-robotic-yellow/30">
                {compiling ? 'Compiling...' : 'Review & compile above'}
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
