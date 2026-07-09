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
  tier?: 'key' | 'background';
  normal_interests?: string[];
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

/* ─── Constants ─────────────────────────────────────────────────────── */

// Feature flag (default off): when enabled and a document is uploaded, an extra
// "Blueprint Review" step is inserted between Setup and Building. When off, the
// wizard behaves exactly as before.
const DOC_BLUEPRINT_ENABLED = import.meta.env.VITE_ENABLE_DOC_BLUEPRINT === 'true';

const STEP_LABELS: Record<number, string> = {
  1: 'Scenario Setup',
  3: 'Blueprint Review',
  2: 'Building',
  7: 'Review & Compile',
};

const VISIBLE_STEPS = DOC_BLUEPRINT_ENABLED ? [1, 3, 2, 7] : [1, 2, 7];

interface BlueprintView {
  detected_framework_kind?: string;
  structure_confidence?: number;
  crisis_cluster?: string;
  factions?: Array<{ id?: string; name?: string; alignment?: string; confidence?: number }>;
  timeline?: Array<{ stage?: string; order?: number }>;
  narrative_mutations?: string[];
  objectives?: string[];
  warnings?: Array<{ field?: string; issue?: string; suggested_fix?: string[] }>;
  unmapped_directives?: Array<{ source_excerpt?: string; note?: string }>;
  trainer_concepts?: Array<{ name?: string; items?: string[] }>;
  coverage?: Record<string, number>;
  // Option A editable fields (drive generation; see field->consumer registry)
  incident_types?: string[];
  cross_cutting_constraints?: Array<{ area?: string; consideration?: string }>;
  cross_stakeholder_dynamics?: string[];
  global_tone_guidance?: string;
  example_vignettes?: string[];
  // any other server fields ride along untouched on the round-trip
  [key: string]: unknown;
}

const SCENARIO_PLACEHOLDER = `Describe the crisis scenario you want to simulate. The AI will analyze your description and generate an appropriate social media crisis simulation.

Examples:
- A major electronics company announces a recall of 2 million smartphones due to battery fires. Leaked internal emails suggest the company knew about the defect for months...
- A large tech company announces layoffs affecting 15,000 employees via a company-wide email that leaks to the press before employees are notified...
- A food delivery platform experiences a massive data breach exposing 30 million users' personal data, payment information, and order histories...
- A viral video shows factory workers at a popular clothing brand working in unsafe conditions, sparking calls for boycotts...
- A pharmaceutical company's new drug is linked to severe side effects that were allegedly downplayed during clinical trials...`;

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

async function authHeadersMultipart(): Promise<Record<string, string>> {
  const { data } = await (await import('../lib/supabase')).supabase.auth.getSession();
  const token = data.session?.access_token || '';
  return { Authorization: `Bearer ${token}` };
}

/* ─── Spinner ────────────────────────────────────────────────────────── */

function Spinner({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-8 justify-center">
      <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      <span className="text-sm terminal-text text-muted animate-pulse">{text}</span>
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

  /* Step 1 — Scenario Setup (free-form) */
  const [orgName, setOrgName] = useState('');
  const [brandLogoUrl, setBrandLogoUrl] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [country, setCountry] = useState('Singapore');
  const [context, setContext] = useState('');
  const [uploadedDocText, setUploadedDocText] = useState('');
  const [uploadedDocName, setUploadedDocName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* Step 3 — Blueprint Review (feature-flagged) */
  const [blueprint, setBlueprint] = useState<BlueprintView | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const crisisDescription = useMemo(() => {
    const parts: string[] = [];
    if (context.trim()) parts.push(context.trim());
    if (uploadedDocText.trim()) parts.push(uploadedDocText.trim());
    return parts.join('\n\n--- UPLOADED DOCUMENT ---\n\n');
  }, [context, uploadedDocText]);

  /* Step 2 — NPCs, Fact Sheet & Communities */
  const [personas, setPersonas] = useState<NPCPersona[]>([]);
  const [factSheet, setFactSheet] = useState<FactSheet | null>(null);
  const [communities, setCommunities] = useState<string[]>([]);
  const [step2Loading, setStep2Loading] = useState(false);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  /* Step 3 — Unified Storyline (NDJSON streaming) */
  const [storylineInjects, setStorylineInjects] = useState<SocialInject[]>([]);
  const [step3Loading, setStep3Loading] = useState(false);
  const [step3Progress, setStep3Progress] = useState<string[]>([]);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  /* Step 4 — Convergence + Shared Chaos */
  const [sharedInjects, setSharedInjects] = useState<SocialInject[]>([]);
  const [convergenceGates, setConvergenceGates] = useState<SocialInject[]>([]);
  const [narrative, setNarrative] = useState<{
    title: string;
    description: string;
    briefing: string;
  } | null>(null);
  const [objectives, setObjectives] = useState<ObjectiveDef[]>([]);
  const [dimensionLabels, setDimensionLabels] = useState<Record<string, string> | null>(null);
  const [orgPage, setOrgPage] = useState<Record<string, unknown> | null>(null);
  const [step4Loading, setStep4Loading] = useState(false);
  const [step4Error, setStep4Error] = useState<string | null>(null);
  const [newPageName, setNewPageName] = useState('');
  const [newPageFbHandle, setNewPageFbHandle] = useState('');
  const [newPageXHandle, setNewPageXHandle] = useState('');

  // Roster of additional brand pages defined in Setup. Sent to the org-page
  // generator during the Build step. Allies = player-assignable protagonists;
  // competitors = trainer/AI-driven antagonists.
  const [allyEntries, setAllyEntries] = useState<
    Array<{ name: string; facebook_handle?: string; x_handle?: string }>
  >([]);
  const [competitorEntries, setCompetitorEntries] = useState<
    Array<{ name: string; facebook_handle?: string; x_handle?: string }>
  >([]);
  const [autoAntagonist, setAutoAntagonist] = useState(true);

  const addRosterEntry = useCallback(
    (role: 'protagonist' | 'antagonist') => {
      const name = newPageName.trim();
      if (!name) return;
      const entry = {
        name,
        facebook_handle: newPageFbHandle.trim() || undefined,
        x_handle: newPageXHandle.trim() || undefined,
      };
      if (role === 'antagonist') setCompetitorEntries((prev) => [...prev, entry]);
      else setAllyEntries((prev) => [...prev, entry]);
      setNewPageName('');
      setNewPageFbHandle('');
      setNewPageXHandle('');
    },
    [newPageName, newPageFbHandle, newPageXHandle],
  );

  const removeRosterEntry = useCallback((role: 'protagonist' | 'antagonist', idx: number) => {
    if (role === 'antagonist') setCompetitorEntries((prev) => prev.filter((_, i) => i !== idx));
    else setAllyEntries((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  /* Step 2 — Building (combined generation) progress */
  const [buildStage, setBuildStage] = useState<
    'characters' | 'storyline' | 'convergence' | 'pages' | 'done' | null
  >(null);
  const [buildError, setBuildError] = useState<
    'characters' | 'storyline' | 'convergence' | 'pages' | null
  >(null);

  /* Step 7 — Compile */
  const [compiling, setCompiling] = useState(false);
  const [compileProgress, setCompileProgress] = useState<string[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [scenarioTitle, setScenarioTitle] = useState('');

  /* ─── Draft save/resume ──────────────────────────────────────────── */

  const buildDraftInput = useCallback(
    () => ({
      sim_mode: 'social_media',
      crisis_description: crisisDescription,
      org_name: orgName,
      brand_logo_url: brandLogoUrl,
      country,
      context,
      uploaded_doc_text: uploadedDocText,
      uploaded_doc_name: uploadedDocName,
      personas,
      fact_sheet: factSheet,
      communities,
      storyline_injects: storylineInjects,
      shared_injects: sharedInjects,
      convergence_gates: convergenceGates,
      narrative,
      objectives,
      dimension_labels: dimensionLabels,
      org_page: orgPage,
      ally_entries: allyEntries,
      competitor_entries: competitorEntries,
      auto_antagonist: autoAntagonist,
    }),
    [
      crisisDescription,
      orgName,
      country,
      context,
      uploadedDocText,
      uploadedDocName,
      personas,
      factSheet,
      communities,
      storylineInjects,
      sharedInjects,
      convergenceGates,
      narrative,
      objectives,
      dimensionLabels,
      orgPage,
      allyEntries,
      competitorEntries,
      autoAntagonist,
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

        if (input.org_name) setOrgName(String(input.org_name));
        if (input.brand_logo_url) setBrandLogoUrl(String(input.brand_logo_url));
        if (input.country) setCountry(String(input.country));
        if (input.context) setContext(String(input.context));
        if (input.uploaded_doc_text) setUploadedDocText(String(input.uploaded_doc_text));
        if (input.uploaded_doc_name) setUploadedDocName(String(input.uploaded_doc_name));
        if (Array.isArray(input.communities)) setCommunities(input.communities.map(String));
        if (Array.isArray(input.personas)) setPersonas(input.personas as NPCPersona[]);
        if (input.fact_sheet) setFactSheet(input.fact_sheet as FactSheet);
        if (Array.isArray(input.storyline_injects))
          setStorylineInjects(input.storyline_injects as SocialInject[]);
        if (Array.isArray(input.shared_injects))
          setSharedInjects(input.shared_injects as SocialInject[]);
        if (Array.isArray(input.convergence_gates))
          setConvergenceGates(input.convergence_gates as SocialInject[]);
        if (input.narrative && typeof input.narrative === 'object')
          setNarrative(input.narrative as { title: string; description: string; briefing: string });
        if (Array.isArray(input.objectives)) setObjectives(input.objectives as ObjectiveDef[]);
        if (input.dimension_labels && typeof input.dimension_labels === 'object')
          setDimensionLabels(input.dimension_labels as Record<string, string>);
        if (input.org_page && typeof input.org_page === 'object')
          setOrgPage(input.org_page as Record<string, unknown>);
        if (Array.isArray(input.ally_entries))
          setAllyEntries(
            input.ally_entries as Array<{
              name: string;
              facebook_handle?: string;
              x_handle?: string;
            }>,
          );
        if (Array.isArray(input.competitor_entries))
          setCompetitorEntries(
            input.competitor_entries as Array<{
              name: string;
              facebook_handle?: string;
              x_handle?: string;
            }>,
          );
        if (typeof input.auto_antagonist === 'boolean') setAutoAntagonist(input.auto_antagonist);

        setStep(validStep);
      } catch (err) {
        console.error('Failed to resume social crisis draft', err);
      }
    };
    resume();
  }, [searchParams]);

  /* ─── Validation ───────────────────────────────────────────────────── */

  const canProceed = useMemo(() => {
    switch (step) {
      case 1:
        return crisisDescription.length >= 50;
      case 3:
        // Blueprint Review: can proceed once extraction settles.
        return !extracting;
      case 2:
        // Building runs automatically and auto-advances; no manual Next.
        return false;
      case 7:
        return true;
      default:
        return false;
    }
  }, [step, crisisDescription, extracting]);

  /* ─── File upload ───────────────────────────────────────────────────── */

  const handleFileUpload = useCallback(async (file: File) => {
    const validTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!validTypes.includes(file.type) && !['pdf', 'docx', 'txt'].includes(ext || '')) {
      setUploadError('Only PDF, DOCX, and TXT files are supported.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File must be under 10MB.');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const headers = await authHeadersMultipart();
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(apiUrl('/api/warroom/social-crisis/upload-document'), {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setUploadError(err?.error || 'Upload failed.');
        setUploading(false);
        return;
      }

      const json = await res.json();
      setUploadedDocText(json.text || '');
      setUploadedDocName(file.name);
      if (json.truncated) {
        setUploadError(
          `Document was truncated to ${json.word_count.toLocaleString()} words due to size limits.`,
        );
      }
    } catch {
      setUploadError('Network error during upload.');
    }
    setUploading(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileUpload(file);
    },
    [handleFileUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileUpload(file);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [handleFileUpload],
  );

  /* ─── API calls ──────────────────────────────────────────────────── */

  const runExtraction = useCallback(async () => {
    setExtracting(true);
    setExtractError(null);
    setBlueprint(null);
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/extract-blueprint'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: uploadedDocText }),
      });
      if (!res.ok) {
        setExtractError('Failed to start blueprint extraction.');
        setExtracting(false);
        return;
      }
      const json = await res.json();
      const jobId = json.job_id;
      if (!jobId) {
        setExtracting(false);
        return;
      }
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const pollRes = await fetchJSON(
            apiUrl(`/api/warroom/social-crisis/job-status/${jobId}`),
            { headers },
          );
          if (!pollRes.ok) continue;
          const pj = await pollRes.json();
          if (pj.status === 'completed' && pj.data) {
            setBlueprint((pj.data.blueprint as BlueprintView) ?? null);
            setExtracting(false);
            return;
          }
          if (pj.status === 'failed') {
            setExtractError(pj.error || 'Blueprint extraction failed.');
            setExtracting(false);
            return;
          }
        } catch {
          /* continue polling */
        }
      }
      setExtractError('Blueprint extraction timed out.');
    } catch {
      setExtractError('Network error during blueprint extraction.');
    }
    setExtracting(false);
  }, [uploadedDocText]);

  type NpcResult = { personas: NPCPersona[]; factSheet: FactSheet; communities: string[] };

  const generateNPCs = useCallback(async (): Promise<NpcResult | null> => {
    if (!crisisDescription) return null;
    setStep2Loading(true);
    setStep2Error(null);
    const apply = (d: Record<string, unknown>): NpcResult => {
      const p = (Array.isArray(d.personas) ? d.personas : []) as NPCPersona[];
      const fs = (d.factSheet ||
        d.fact_sheet || {
          confirmed_facts: [],
          unconfirmed_claims: [],
        }) as FactSheet;
      const comms = (Array.isArray(d.communities) ? d.communities : []) as string[];
      setPersonas(p);
      setFactSheet(fs);
      setCommunities(comms);
      return { personas: p, factSheet: fs, communities: comms };
    };
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-npcs'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_type: crisisDescription,
          country,
          context: crisisDescription,
          org_name: orgName || undefined,
          blueprint: blueprint ?? undefined,
        }),
      });
      if (!res.ok) {
        setStep2Error('Failed to start NPC generation. Try again.');
        setStep2Loading(false);
        return null;
      }
      const json = await res.json();

      if (json.data) {
        const result = apply(json.data);
        setStep2Loading(false);
        return result;
      }

      const jobId = json.job_id;
      if (!jobId) {
        setStep2Error('Unexpected server response.');
        setStep2Loading(false);
        return null;
      }

      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const pollRes = await fetchJSON(
            apiUrl(`/api/warroom/social-crisis/generate-npcs/status/${jobId}`),
            { headers },
          );
          if (!pollRes.ok) continue;
          const pollJson = await pollRes.json();
          if (pollJson.status === 'completed' && pollJson.data) {
            const result = apply(pollJson.data);
            setStep2Loading(false);
            return result;
          }
          if (pollJson.status === 'failed') {
            setStep2Error(pollJson.error || 'NPC generation failed. Try again.');
            setStep2Loading(false);
            return null;
          }
        } catch {
          /* continue polling */
        }
      }
      setStep2Error('NPC generation timed out. Try again.');
    } catch {
      setStep2Error('Network error generating NPCs.');
    }
    setStep2Loading(false);
    return null;
  }, [crisisDescription, country, orgName, blueprint]);

  const generateStoryline = useCallback(
    async (
      personasArg?: NPCPersona[],
      factSheetArg?: FactSheet | null,
    ): Promise<SocialInject[] | null> => {
      if (!crisisDescription) return null;
      const personasIn = personasArg ?? personas;
      const factSheetIn = factSheetArg ?? factSheet;
      setStep3Loading(true);
      setStep3Error(null);
      setStep3Progress([]);
      setStorylineInjects([]);
      let result: SocialInject[] | null = null;

      try {
        const headers = await authHeaders();
        const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-storyline'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            crisis_type: crisisDescription,
            country,
            context: crisisDescription,
            org_name: orgName || undefined,
            duration: 60,
            personas: personasIn,
            fact_sheet: factSheetIn,
            blueprint: blueprint ?? undefined,
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
                if (msg.type === 'progress') {
                  setStep3Progress((prev) => [...prev, String(msg.message)]);
                } else if (msg.type === 'complete' && msg.injects) {
                  result = msg.injects as SocialInject[];
                  setStorylineInjects(result);
                } else if (msg.type === 'error') {
                  setStep3Error(String(msg.message || 'Storyline generation failed'));
                }
              } catch {
                /* skip malformed */
              }
            }
          }
        } else {
          setStep3Error('Failed to generate storyline.');
        }
      } catch {
        setStep3Error('Network error generating storyline.');
      }
      setStep3Loading(false);
      return result;
    },
    [crisisDescription, country, orgName, personas, factSheet, blueprint],
  );

  const generateConvergence = useCallback(
    async (
      personasArg?: NPCPersona[],
      factSheetArg?: FactSheet | null,
      storylineArg?: SocialInject[],
    ): Promise<boolean> => {
      if (!crisisDescription) return false;
      const personasIn = personasArg ?? personas;
      const factSheetIn = factSheetArg ?? factSheet;
      const storylineIn = storylineArg ?? storylineInjects;
      setStep4Loading(true);
      setStep4Error(null);

      const apply = (d: Record<string, unknown>) => {
        const si = (d.sharedInjects || d.shared_injects) as SocialInject[] | undefined;
        if (Array.isArray(si)) setSharedInjects(si);
        const cg = (d.convergenceGates || d.convergence_gates) as SocialInject[] | undefined;
        if (Array.isArray(cg)) setConvergenceGates(cg);
        if (d.narrative && typeof d.narrative === 'object')
          setNarrative(d.narrative as { title: string; description: string; briefing: string });
        if (Array.isArray(d.objectives)) setObjectives(d.objectives as ObjectiveDef[]);
        const dl = (d.dimensionLabels || d.dimension_labels) as Record<string, string> | undefined;
        if (dl && typeof dl === 'object') setDimensionLabels(dl);
        return (Array.isArray(si) && si.length > 0) || (Array.isArray(cg) && cg.length > 0);
      };

      try {
        const headers = await authHeaders();
        const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-convergence'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            crisis_type: crisisDescription,
            location: '',
            country,
            context: crisisDescription,
            org_name: orgName || undefined,
            duration: 60,
            communities,
            personas: personasIn,
            fact_sheet: factSheetIn,
            // Feed the storyline so convergence designs shared injects and gates
            // as organic consequences of the actual storyline beats.
            team_storylines: storylineIn.length > 0 ? { storyline: storylineIn } : {},
            blueprint: blueprint ?? undefined,
          }),
        });

        if (!res.ok) {
          setStep4Error('Failed to start convergence generation. Try again.');
          setStep4Loading(false);
          return false;
        }

        const json = await res.json();

        if (json.data && !json.job_id) {
          apply(json.data);
          setStep4Loading(false);
          return true;
        }

        const jobId = json.job_id;
        if (!jobId) {
          setStep4Error('Unexpected server response.');
          setStep4Loading(false);
          return false;
        }

        for (let i = 0; i < 180; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const pollRes = await fetchJSON(
              apiUrl(`/api/warroom/social-crisis/job-status/${jobId}`),
              { headers },
            );
            if (!pollRes.ok) continue;
            const pollJson = await pollRes.json();
            if (pollJson.status === 'completed' && pollJson.data) {
              apply(pollJson.data);
              setStep4Loading(false);
              return true;
            }
            if (pollJson.status === 'failed') {
              setStep4Error(pollJson.error || 'Convergence generation failed. Try again.');
              setStep4Loading(false);
              return false;
            }
          } catch {
            /* continue polling */
          }
        }
        setStep4Error('Convergence generation timed out. Try again.');
      } catch {
        setStep4Error('Network error generating convergence.');
      }
      setStep4Loading(false);
      return false;
    },
    [
      crisisDescription,
      country,
      orgName,
      communities,
      personas,
      factSheet,
      storylineInjects,
      blueprint,
    ],
  );

  const generateOrgPage = useCallback(async (): Promise<boolean> => {
    if (!crisisDescription) return false;
    try {
      const headers = await authHeaders();
      const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/generate-org-page'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          crisis_description: crisisDescription,
          country,
          org_name: orgName || undefined,
          logo_url: brandLogoUrl || undefined,
          allies: allyEntries,
          competitors: competitorEntries,
          // If no competitors are named, the War Room invents one hostile rival.
          auto_antagonist: autoAntagonist,
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
              if (msg.type === 'complete' && msg.org_page) {
                setOrgPage(msg.org_page);
              }
            } catch {
              /* skip */
            }
          }
        }
        return true;
      }
      return false;
    } catch {
      /* non-critical -- org page is optional */
      return false;
    }
  }, [
    crisisDescription,
    country,
    orgName,
    brandLogoUrl,
    allyEntries,
    competitorEntries,
    autoAntagonist,
  ]);

  /**
   * Combined Build step: chains Characters -> Storyline -> Convergence -> Org Pages
   * in sequence (threading results, since React state is not updated mid-chain),
   * then auto-advances to Compile. Stops on a failed stage and surfaces a retry.
   */
  const generateAll = useCallback(async () => {
    setBuildError(null);

    setBuildStage('characters');
    const npc = await generateNPCs();
    if (!npc) {
      setBuildError('characters');
      return;
    }

    setBuildStage('storyline');
    const story = await generateStoryline(npc.personas, npc.factSheet);
    if (!story || story.length === 0) {
      setBuildError('storyline');
      return;
    }

    setBuildStage('convergence');
    const convOk = await generateConvergence(npc.personas, npc.factSheet, story);
    if (!convOk) {
      setBuildError('convergence');
      return;
    }

    setBuildStage('pages');
    await generateOrgPage();

    setBuildStage('done');
    await saveDraftState(7);
    setStep(7);
  }, [generateNPCs, generateStoryline, generateConvergence, generateOrgPage, saveDraftState]);

  const compileScenario = useCallback(async () => {
    if (!crisisDescription) return;
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
          crisis_type: crisisDescription,
          org_name: orgName || undefined,
          objectives,
          country,
          personas,
          fact_sheet: factSheet,
          communities,
          storyline_injects: storylineInjects,
          shared_injects: sharedInjects,
          convergence_gates: convergenceGates,
          dimension_labels: dimensionLabels,
          org_page: orgPage,
          duration: 60,
          blueprint: blueprint ?? undefined,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        addProgress(`Error: ${errJson?.error || 'Failed to compile scenario.'}`);
        setCompiling(false);
        return;
      }

      const json = await res.json();

      if (json.data && !json.job_id) {
        const d = json.data;
        setScenarioId(String(d.scenario_id));
        if (d.title) setScenarioTitle(String(d.title));
        addProgress(`Scenario created successfully! ID: ${String(d.scenario_id).slice(0, 8)}`);
        if (d.inject_count != null) addProgress(`Total injects: ${Number(d.inject_count)}`);
        setCompiling(false);
        return;
      }

      const jobId = json.job_id;
      if (!jobId) {
        addProgress('Error: Unexpected server response.');
        setCompiling(false);
        return;
      }

      addProgress('Generating strategy windows and compiling scenario...');

      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const pollRes = await fetchJSON(
            apiUrl(`/api/warroom/social-crisis/job-status/${jobId}`),
            { headers },
          );
          if (!pollRes.ok) continue;
          const pollJson = await pollRes.json();
          if (pollJson.status === 'completed' && pollJson.data) {
            const d = pollJson.data;
            setScenarioId(String(d.scenario_id));
            if (d.title) setScenarioTitle(String(d.title));
            addProgress(`Scenario created successfully! ID: ${String(d.scenario_id).slice(0, 8)}`);
            if (d.inject_count != null) addProgress(`Total injects: ${Number(d.inject_count)}`);
            setCompiling(false);
            return;
          }
          if (pollJson.status === 'failed') {
            addProgress(`Error: ${pollJson.error || 'Compilation failed.'}`);
            setCompiling(false);
            return;
          }
        } catch {
          /* continue polling */
        }
      }
      addProgress('Error: Compilation timed out. Try again.');
    } catch {
      addProgress('Error: Network error during compilation.');
    }
    setCompiling(false);
  }, [
    crisisDescription,
    country,
    communities,
    personas,
    factSheet,
    storylineInjects,
    sharedInjects,
    convergenceGates,
    narrative,
    objectives,
    orgName,
    dimensionLabels,
    orgPage,
    blueprint,
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
    // With the feature on and a document uploaded, route through Blueprint Review.
    if (step === 1 && DOC_BLUEPRINT_ENABLED && uploadedDocText.trim()) {
      await saveDraftState(3);
      setStep(3);
      void runExtraction();
      return;
    }
    // Leaving Setup (or Blueprint Review) kicks off the Build step, which auto-advances.
    if (step === 1 || step === 3) {
      await saveDraftState(2);
      setStep(2);
      void generateAll();
      return;
    }
    const nextIdx = currentStepIndex + 1;
    if (nextIdx >= VISIBLE_STEPS.length) return;
    const nextStep = VISIBLE_STEPS[nextIdx];
    await saveDraftState(nextStep);
    setStep(nextStep);
  };

  /* ─── Computed stats ────────────────────────────────────────────── */

  const totalTeamInjects = useMemo(() => {
    return storylineInjects.length;
  }, [storylineInjects]);

  const crisisLabel = useMemo(() => {
    if (!crisisDescription) return 'Not specified';
    return crisisDescription.length > 80
      ? crisisDescription.slice(0, 80) + '...'
      : crisisDescription;
  }, [crisisDescription]);

  /* ─── Render ─────────────────────────────────────────────────────── */

  const progressBar = (
    <div className="military-border p-2 sm:p-3 mb-4 sm:mb-6 bg-surface flex-shrink-0">
      <div className="flex items-center gap-1 overflow-x-auto">
        {VISIBLE_STEPS.map((s, i) => {
          const isCurrent = s === step;
          const isPast = currentStepIndex > i;
          return (
            <div key={s} className="flex items-center">
              {i > 0 && (
                <div className={`w-4 h-px mx-1 ${isPast ? 'bg-accent' : 'bg-surface-2'}`} />
              )}
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] terminal-text whitespace-nowrap ${
                  isCurrent
                    ? 'border border-accent bg-accent/10 text-ink'
                    : isPast
                      ? 'text-muted'
                      : 'text-muted'
                }`}
              >
                <span
                  className={`w-4 h-4 flex items-center justify-center rounded-full text-[9px] font-bold ${
                    isCurrent
                      ? 'bg-accent text-white'
                      : isPast
                        ? 'bg-accent/10 text-ink'
                        : 'bg-surface-2 text-muted'
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

  /* ── Step 1: Scenario Setup (free-form) ─────────────────────────────── */

  const renderStep1 = () => (
    <div>
      <h2 className="text-lg terminal-text mb-4">Step 1 · Scenario setup</h2>
      <p className="text-xs terminal-text text-muted mb-6">
        Describe any crisis scenario in detail. The AI will analyze your description to understand
        the crisis dynamics and generate an appropriate simulation. You can also upload a document
        with a detailed scenario brief.
      </p>

      <div className="mb-6">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-2 block">
          Crisis Scenario Description
        </label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={10}
          placeholder={SCENARIO_PLACEHOLDER}
          className="w-full bg-transparent border border-border px-3 py-2 text-sm terminal-text text-ink focus:border-accent focus:outline-none resize-none"
        />
        <div className="flex justify-between mt-1">
          <span className="text-[9px] terminal-text text-muted">
            {context.length < 50
              ? `Minimum 50 characters required (${50 - context.length} more)`
              : `${context.length} characters`}
          </span>
        </div>
      </div>

      {/* Document Upload */}
      <div className="mb-6">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-2 block">
          Upload Scenario Document (optional)
        </label>
        {!uploadedDocText ? (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border rounded p-8 text-center cursor-pointer hover:border-accent transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={handleFileSelect}
              className="hidden"
            />
            {uploading ? (
              <Spinner text="Extracting document text..." />
            ) : (
              <>
                <div className="text-3xl mb-3 text-muted">+</div>
                <div className="text-xs terminal-text text-muted mb-1">
                  Drag & drop or click to upload
                </div>
                <div className="text-[10px] terminal-text text-muted">
                  PDF, DOCX, or TXT (max 10MB)
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="border border-accent/30 rounded p-4 bg-accent/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-accent text-sm">&#128196;</span>
                <span className="text-xs terminal-text text-accent font-bold">
                  {uploadedDocName}
                </span>
              </div>
              <button
                onClick={() => {
                  setUploadedDocText('');
                  setUploadedDocName('');
                  setUploadError(null);
                }}
                className="text-[10px] terminal-text text-danger hover:opacity-80 border border-danger/30 px-2 py-0.5 rounded"
              >
                Remove
              </button>
            </div>
            <div className="text-[10px] terminal-text text-muted mb-2">
              {uploadedDocText.split(/\s+/).length.toLocaleString()} words extracted
            </div>
            <div className="text-[10px] terminal-text text-muted max-h-24 overflow-y-auto border border-border rounded p-2 bg-surface-2">
              {uploadedDocText.slice(0, 500)}
              {uploadedDocText.length > 500 && '...'}
            </div>
          </div>
        )}
        {uploadError && (
          <div className="mt-2 text-[10px] terminal-text text-danger">{uploadError}</div>
        )}
      </div>

      <div className="mb-4">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-2 block">
          Country
        </label>
        <input
          type="text"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-full bg-transparent border border-border px-3 py-2 text-sm terminal-text text-ink focus:border-accent focus:outline-none"
        />
      </div>

      <div className="mb-4">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-2 block">
          Organization Name (optional)
        </label>
        <input
          type="text"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="e.g., Meridian Technologies, Acme Corp"
          className="w-full bg-transparent border border-border px-3 py-2 text-sm terminal-text text-ink focus:border-accent focus:outline-none"
        />
        <div className="mt-1">
          <span className="text-[9px] terminal-text text-muted">
            Leave blank to let the AI generate a company name
          </span>
        </div>
      </div>

      <div className="mb-4">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-2 block">
          Brand Logo (optional)
        </label>
        <div className="flex items-center gap-3">
          {brandLogoUrl && (
            <img
              src={brandLogoUrl}
              alt="Brand logo"
              className="w-12 h-12 rounded-lg object-cover border border-border"
            />
          )}
          <label className="cursor-pointer border border-border px-3 py-2 text-sm terminal-text text-ink hover:border-accent transition-colors">
            {uploadingLogo ? 'Uploading...' : brandLogoUrl ? 'Change Logo' : 'Upload Logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={uploadingLogo}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploadingLogo(true);
                try {
                  const headers = await authHeadersMultipart();
                  const formData = new FormData();
                  formData.append('file', file);
                  const res = await fetch(apiUrl('/api/warroom/social-crisis/upload-brand-logo'), {
                    method: 'POST',
                    headers,
                    body: formData,
                  });
                  if (res.ok) {
                    const json = await res.json();
                    setBrandLogoUrl(json.url);
                  }
                } catch {
                  /* ignore */
                } finally {
                  setUploadingLogo(false);
                }
              }}
            />
          </label>
          {brandLogoUrl && (
            <button
              onClick={() => setBrandLogoUrl('')}
              className="text-[10px] terminal-text text-danger hover:opacity-80"
            >
              Remove
            </button>
          )}
        </div>
        <div className="mt-1">
          <span className="text-[9px] terminal-text text-muted">
            Upload a logo for the brand&apos;s social media pages. If none is provided, the AI will
            generate one.
          </span>
        </div>
      </div>

      {/* Brand pages: protagonist allies + antagonist competitors */}
      <div className="mb-4 p-3 border border-border rounded bg-surface-2">
        <label className="text-[10px] terminal-text text-muted uppercase tracking-wider mb-1 block">
          Brand Pages (optional)
        </label>
        <p className="text-[10px] terminal-text text-muted mb-3">
          Your crisis page is generated automatically. Add allied pages players can control, and
          rival competitor pages the AI drives against you.
        </p>

        <div className="grid grid-cols-3 gap-2">
          <input
            value={newPageName}
            onChange={(e) => setNewPageName(e.target.value)}
            placeholder="Page name"
            className="bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded"
          />
          <input
            value={newPageFbHandle}
            onChange={(e) => setNewPageFbHandle(e.target.value)}
            placeholder="@FacebookHandle"
            className="bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded"
          />
          <input
            value={newPageXHandle}
            onChange={(e) => setNewPageXHandle(e.target.value)}
            placeholder="@XHandle"
            className="bg-surface border border-border text-ink terminal-text text-xs px-2 py-1 rounded"
          />
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => addRosterEntry('protagonist')}
            disabled={!newPageName.trim()}
            className="military-button px-4 py-1.5 text-xs disabled:opacity-50"
          >
            Add ally
          </button>
          <button
            onClick={() => addRosterEntry('antagonist')}
            disabled={!newPageName.trim()}
            className="px-4 py-1.5 text-xs terminal-text border border-danger/50 text-danger hover:bg-danger/10 rounded disabled:opacity-50"
          >
            Add competitor
          </button>
        </div>

        <div className="mt-4">
          <div className="text-[10px] terminal-text text-accent uppercase mb-1">
            Your side &mdash; allied pages (assignable to players)
          </div>
          {allyEntries.length === 0 ? (
            <div className="text-[10px] terminal-text text-muted">
              The crisis page is the required protagonist page. Add optional allies.
            </div>
          ) : (
            <div className="space-y-1">
              {allyEntries.map((e, i) => (
                <div
                  key={`ally-${i}`}
                  className="flex items-center justify-between border-b border-border py-1"
                >
                  <span className="text-xs terminal-text">
                    {e.name} <span className="text-muted">{e.facebook_handle || ''}</span>
                  </span>
                  <button
                    onClick={() => removeRosterEntry('protagonist', i)}
                    className="text-[10px] terminal-text text-accent hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4">
          <div className="text-[10px] terminal-text text-danger uppercase mb-1">
            Opposition &mdash; competitor pages (AI-driven, trainer can seize)
          </div>
          {competitorEntries.length === 0 ? (
            <div className="text-[10px] terminal-text text-muted">
              {autoAntagonist
                ? 'A hostile rival will be auto-generated. Add named competitors (up to 10) to stack the pressure.'
                : 'No competitors. Add named competitors (up to 10).'}
            </div>
          ) : (
            <div className="space-y-1">
              {competitorEntries.map((e, i) => (
                <div
                  key={`comp-${i}`}
                  className="flex items-center justify-between border-b border-danger/10 py-1"
                >
                  <span className="text-xs terminal-text text-danger">
                    {e.name} <span className="text-danger/60">{e.facebook_handle || ''}</span>
                  </span>
                  <button
                    onClick={() => removeRosterEntry('antagonist', i)}
                    className="text-[10px] terminal-text text-accent hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 mt-2 text-[10px] terminal-text text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoAntagonist}
              onChange={(e) => setAutoAntagonist(e.target.checked)}
            />
            Auto-generate a hostile rival if no competitors are named
          </label>
        </div>
      </div>

      {crisisDescription.length >= 50 && (
        <div className="mt-4 p-3 border border-success/30 rounded bg-success/10">
          <p className="text-[10px] terminal-text text-success">
            Ready: The AI will analyze your scenario and generate appropriate crisis dynamics, NPCs,
            social media narratives, and public sentiment patterns for {country}.
          </p>
        </div>
      )}
    </div>
  );

  /* ── Step 2: Building (combined generation, progress-only) ─────────── */

  const renderBlueprintReview = () => {
    const pct = (n?: number) => `${Math.round((n ?? 0) * 100)}%`;
    const editField = (key: keyof BlueprintView, value: unknown) =>
      setBlueprint((bp) => ({ ...(bp || {}), [key]: value }) as BlueprintView);
    const linesToArr = (v: string) => v.split('\n').map((s) => s.trim());
    const constraintsToText = (cs?: Array<{ area?: string; consideration?: string }>) =>
      (cs ?? []).map((c) => `${c.area || ''}: ${c.consideration || ''}`).join('\n');
    const textToConstraints = (v: string) =>
      v
        .split('\n')
        .map((line) => {
          const idx = line.indexOf(':');
          return idx === -1
            ? { area: line.trim(), consideration: '' }
            : { area: line.slice(0, idx).trim(), consideration: line.slice(idx + 1).trim() };
        })
        .filter((c) => c.area || c.consideration);
    const Drives = () => (
      <span className="text-[10px] terminal-text text-success border border-success/40 rounded px-1 ml-2">
        drives generation
      </span>
    );
    const editArea = 'w-full bg-surface-2 border border-border text-ink text-xs p-2 mt-1';
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg terminal-text text-ink mb-1">Blueprint Review</h2>
          <p className="text-xs terminal-text text-muted">
            Structured from your uploaded document. Empty or low-confidence fields will be
            AI-generated. Press Next to build the scenario.
          </p>
        </div>

        {extracting && <Spinner text="Analyzing document and extracting blueprint..." />}

        {extractError && !extracting && (
          <div className="border border-danger/40 p-3 text-xs terminal-text text-danger">
            {extractError}
            <button onClick={() => void runExtraction()} className="ml-3 underline text-muted">
              Retry
            </button>
          </div>
        )}

        {!extracting && blueprint && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs terminal-text">
              <div className="military-border p-3">
                <div className="text-muted uppercase mb-1">Framework</div>
                <div className="text-ink">
                  {blueprint.detected_framework_kind || 'unstructured'}
                </div>
              </div>
              <div className="military-border p-3">
                <div className="text-muted uppercase mb-1">Structure confidence</div>
                <div className="text-ink">{pct(blueprint.structure_confidence)}</div>
              </div>
            </div>

            {blueprint.warnings && blueprint.warnings.length > 0 && (
              <div className="border border-amber-500/40 p-3 text-xs terminal-text">
                <div className="text-amber-400 uppercase mb-2">Gap Report — please review</div>
                {blueprint.warnings.map((w, i) => (
                  <div key={i} className="mb-2 text-muted">
                    <span className="text-amber-400">{w.field}:</span> {w.issue}
                    {w.suggested_fix && w.suggested_fix.length > 0 && (
                      <div className="text-muted">Suggested: {w.suggested_fix.join(' → ')}</div>
                    )}
                  </div>
                ))}
                <div className="text-muted mt-1">
                  Suggestions are advisory — edit the fields below to incorporate them.
                </div>
              </div>
            )}

            {/* Editable fields — these drive generation */}
            <div className="military-border p-3 text-xs terminal-text space-y-4">
              <div>
                <div className="text-muted uppercase">
                  Editable fields <Drives />
                </div>
                <div className="text-muted mt-1">
                  These were extracted from your document and feed scenario generation. Review and
                  edit them. Leave a field empty to let the AI generate it.
                </div>
              </div>

              <div>
                <label className="text-ink">Incident types</label>
                <div className="text-muted">
                  The specific kinds of incident this crisis involves. Seeds the fact sheet
                  (confirmed facts vs. rumours). One per line.
                </div>
                <textarea
                  rows={3}
                  className={editArea}
                  placeholder={
                    'e.g.\nVehicle attack at a public market\nRumours of a second attacker'
                  }
                  value={(blueprint.incident_types ?? []).join('\n')}
                  onChange={(e) => editField('incident_types', linesToArr(e.target.value))}
                />
              </div>

              <div>
                <label className="text-ink">Cross-stakeholder dynamics</label>
                <div className="text-muted">
                  How the groups react to and provoke each other. Designs the convergence gates
                  (inter-group pile-ons) and live Director beats. One interaction per line.
                </div>
                <textarea
                  rows={3}
                  className={editArea}
                  placeholder={
                    'e.g.\nFar-right blames the community -> left-wing groups counter-protest\nMedia naming religion early inflames residents'
                  }
                  value={(blueprint.cross_stakeholder_dynamics ?? []).join('\n')}
                  onChange={(e) =>
                    editField('cross_stakeholder_dynamics', linesToArr(e.target.value))
                  }
                />
              </div>

              <div>
                <label className="text-ink">Cross-cutting constraints</label>
                <div className="text-muted">
                  Competing priorities the response must balance, written as &quot;area:
                  consideration&quot;. Fed into the objectives and briefing as context. One per
                  line.
                </div>
                <textarea
                  rows={3}
                  className={editArea}
                  placeholder={
                    'e.g.\nlegal: protect investigation integrity\npublic_order: avoid disorder\ncommunity: prevent hate-crime backlash'
                  }
                  value={constraintsToText(blueprint.cross_cutting_constraints)}
                  onChange={(e) =>
                    editField('cross_cutting_constraints', textToConstraints(e.target.value))
                  }
                />
              </div>

              <div>
                <label className="text-ink">Global tone &amp; realism</label>
                <div className="text-muted">
                  Document-wide style guidance applied to every generated voice (on top of
                  per-faction tone). Free text.
                </div>
                <textarea
                  rows={3}
                  className={editArea}
                  placeholder={
                    'e.g. emotional, uncertain, internet-native; allow credible voices to calm things; represent extremists without amplifying them'
                  }
                  value={blueprint.global_tone_guidance ?? ''}
                  onChange={(e) => editField('global_tone_guidance', e.target.value)}
                />
              </div>

              <div>
                <label className="text-ink">Example vignettes</label>
                <div className="text-muted">
                  Short worked-example scenes the storyline should emulate. Used as few-shot
                  examples when generating injects. One per line.
                </div>
                <textarea
                  rows={3}
                  className={editArea}
                  placeholder={
                    'e.g.\nRumour of more attackers -> school-safety panic -> far-right blames community -> interfaith joint statement'
                  }
                  value={(blueprint.example_vignettes ?? []).join('\n')}
                  onChange={(e) => editField('example_vignettes', linesToArr(e.target.value))}
                />
              </div>
            </div>

            <div className="military-border p-3 text-xs terminal-text">
              <div className="text-muted uppercase mb-2">
                Factions ({blueprint.factions?.length ?? 0})
              </div>
              {(blueprint.factions ?? []).map((f, i) => (
                <div key={i} className="text-ink mb-1">
                  {f.name || f.id}{' '}
                  <span className="text-muted">
                    [{f.alignment || 'n/a'} · {pct(f.confidence)}]
                  </span>
                </div>
              ))}
              {(blueprint.factions?.length ?? 0) === 0 && (
                <div className="text-muted">None detected — will be AI-generated.</div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs terminal-text">
              <div className="military-border p-3">
                <div className="text-muted uppercase mb-1">
                  Timeline ({blueprint.timeline?.length ?? 0})
                </div>
                <div className="text-ink">
                  {(blueprint.timeline ?? [])
                    .map((t) => t.stage)
                    .filter(Boolean)
                    .join(' → ') || 'AI-generated'}
                </div>
              </div>
              <div className="military-border p-3">
                <div className="text-muted uppercase mb-1">
                  Narrative mutations ({blueprint.narrative_mutations?.length ?? 0})
                </div>
                <div className="text-ink">
                  {(blueprint.narrative_mutations ?? []).slice(0, 4).join(', ') || 'AI-generated'}
                </div>
              </div>
            </div>

            {blueprint.unmapped_directives && blueprint.unmapped_directives.length > 0 && (
              <div className="military-border p-3 text-xs terminal-text">
                <div className="text-muted uppercase mb-2">
                  Unmapped ({blueprint.unmapped_directives.length}) — kept for context
                </div>
                {blueprint.unmapped_directives.slice(0, 5).map((u, i) => (
                  <div key={i} className="text-muted mb-1">
                    • {u.note || u.source_excerpt}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!extracting && !blueprint && !extractError && (
          <div className="text-xs terminal-text text-muted py-6 text-center">
            No blueprint extracted. Press Next to build from the description directly.
          </div>
        )}
      </div>
    );
  };

  const renderBuilding = () => {
    const stages: Array<{
      key: 'characters' | 'storyline' | 'convergence' | 'pages';
      label: string;
    }> = [
      { key: 'characters', label: 'Characters & facts' },
      { key: 'storyline', label: 'Storyline' },
      { key: 'convergence', label: 'Convergence' },
      { key: 'pages', label: 'Org pages' },
    ];
    const order = ['characters', 'storyline', 'convergence', 'pages', 'done'];
    const curIdx = buildStage ? order.indexOf(buildStage) : -1;
    const loadingByKey: Record<string, boolean> = {
      characters: step2Loading,
      storyline: step3Loading,
      convergence: step4Loading,
      pages: buildStage === 'pages',
    };
    const errorMsg = step2Error || step3Error || step4Error;
    return (
      <div>
        <h2 className="text-lg terminal-text mb-4">Step 2 · Building scenario</h2>
        <p className="text-xs terminal-text text-muted mb-6">
          Generating characters, storyline, convergence, and brand pages. This takes a few minutes;
          you will advance to compile automatically.
        </p>
        <div className="border border-border rounded p-4 space-y-2 mb-4">
          {stages.map((s) => {
            const idx = order.indexOf(s.key);
            const isDone = buildStage === 'done' || (curIdx > -1 && curIdx > idx);
            const isRunning = buildStage === s.key && !buildError && loadingByKey[s.key] !== false;
            const isErrored = buildError === s.key;
            return (
              <div key={s.key} className="flex items-center gap-3 text-sm terminal-text">
                <span
                  className={`w-5 h-5 flex items-center justify-center rounded text-[11px] font-bold ${
                    isErrored
                      ? 'bg-danger/10 text-danger'
                      : isDone
                        ? 'bg-success/10 text-success'
                        : isRunning
                          ? 'bg-accent/10 text-ink animate-pulse'
                          : 'bg-surface-2 text-muted'
                  }`}
                >
                  {isErrored ? '!' : isDone ? '✓' : isRunning ? '●' : '·'}
                </span>
                <span className={isDone ? 'text-ink' : isRunning ? 'text-ink' : 'text-muted'}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Live storyline generation log */}
        {buildStage === 'storyline' && step3Progress.length > 0 && (
          <div className="border border-border rounded p-3 bg-surface-2 font-mono text-xs space-y-1 max-h-40 overflow-y-auto mb-4">
            {step3Progress.map((msg, i) => (
              <div key={i} className="text-muted">
                <span className="text-muted">[{String(i + 1).padStart(2, '0')}]</span> {msg}
              </div>
            ))}
            <div className="animate-pulse text-muted">&#9612;</div>
          </div>
        )}

        {buildError ? (
          <div className="text-center py-4">
            <p className="text-sm terminal-text text-danger mb-4">
              {errorMsg || `The ${buildError} stage failed.`} Retry to rebuild the scenario.
            </p>
            <button
              onClick={() => void generateAll()}
              className="px-6 py-2 text-xs terminal-text border border-accent text-ink hover:bg-accent/10"
            >
              Retry
            </button>
          </div>
        ) : (
          <Spinner text="Building scenario..." />
        )}
      </div>
    );
  };

  /* ── Step 5: Review & Compile ──────────────────────────────────────── */

  const renderStep7 = () => (
    <div>
      <h2 className="text-lg terminal-text mb-4">Step 7 · Review &amp; compile</h2>

      {!scenarioId && !compiling && (
        <div className="space-y-6">
          <p className="text-xs terminal-text text-muted mb-4">
            Review the full scenario summary, then compile to persist.
          </p>

          <div className="border border-border rounded p-4 mb-4">
            <h3 className="text-xs terminal-text text-muted uppercase mb-4">Scenario Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs terminal-text">
              <div className="border border-border rounded p-3 text-center col-span-2 sm:col-span-3">
                <div className="text-[10px] text-muted uppercase">Crisis Scenario</div>
                <div className="text-ink text-xs mt-1 line-clamp-2">{crisisLabel}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Country</div>
                <div className="text-ink font-bold">{country}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Storyline Injects</div>
                <div className="text-ink font-bold text-lg">{storylineInjects.length}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">NPC Count</div>
                <div className="text-ink font-bold text-lg">{personas.length}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Team Injects</div>
                <div className="text-ink font-bold text-lg">{totalTeamInjects}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Shared Injects</div>
                <div className="text-ink font-bold text-lg">{sharedInjects.length}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Conv. Gates</div>
                <div className="text-ink font-bold text-lg">{convergenceGates.length}</div>
              </div>
            </div>
          </div>

          {narrative && (
            <div className="border border-border rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-muted uppercase mb-2">Narrative</h3>
              <div className="text-sm terminal-text text-accent font-bold mb-1">
                {narrative.title}
              </div>
              <div className="text-[10px] terminal-text text-muted leading-relaxed line-clamp-4">
                {narrative.description}
              </div>
            </div>
          )}

          <button
            onClick={compileScenario}
            className="military-button px-8 py-3 w-full text-center"
          >
            Compile scenario
          </button>
        </div>
      )}

      {compiling && (
        <div className="py-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            <span className="text-sm terminal-text text-ink animate-pulse">
              Compiling scenario...
            </span>
          </div>
          <div className="border border-border rounded p-4 bg-surface-2 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
            {compileProgress.map((msg, i) => (
              <div key={i} className="text-muted">
                <span className="text-muted">[{String(i + 1).padStart(2, '0')}]</span> {msg}
              </div>
            ))}
            <div className="animate-pulse text-muted">&#9612;</div>
          </div>
        </div>
      )}

      {scenarioId && !compiling && (
        <div className="text-center py-8">
          <div className="text-4xl mb-4">&#9989;</div>
          <h3 className="text-lg terminal-text font-bold mb-2">Scenario Created Successfully</h3>
          {scenarioTitle && (
            <p className="text-sm terminal-text text-accent mb-1">{scenarioTitle}</p>
          )}
          <p className="text-xs terminal-text text-muted mb-2">Scenario ID: {scenarioId}</p>

          <div className="border border-border rounded p-4 bg-surface-2 text-xs terminal-text mb-4 text-left max-w-md mx-auto">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-muted">Injects:</span>
              <span className="text-ink">{storylineInjects.length}</span>
              <span className="text-muted">NPCs:</span>
              <span className="text-ink">{personas.length}</span>
              <span className="text-muted">Shared Injects:</span>
              <span className="text-ink">{sharedInjects.length}</span>
              <span className="text-muted">Convergence Gates:</span>
              <span className="text-ink">{convergenceGates.length}</span>
            </div>
          </div>

          <div className="border border-border rounded p-4 bg-surface-2 font-mono text-xs space-y-1 max-h-48 overflow-y-auto mb-6">
            {compileProgress.map((msg, i) => (
              <div key={i} className="text-muted">
                <span className="text-muted">[{String(i + 1).padStart(2, '0')}]</span> {msg}
              </div>
            ))}
          </div>

          <div className="flex justify-center gap-4 flex-wrap">
            <a href="/scenarios" className="military-button px-8 py-3 text-center">
              View scenarios
            </a>
            <button
              onClick={() => navigate('/sessions')}
              className="px-8 py-3 text-xs terminal-text border border-accent text-accent hover:bg-accent/10"
            >
              Create session
            </button>
            {wizardDraftId && (
              <button
                onClick={() => {
                  setScenarioId(null);
                  setCompileProgress([]);
                  setStep(1);
                }}
                className="px-8 py-3 text-xs terminal-text border border-accent text-ink hover:bg-accent/10"
              >
                Modify &amp; recompile
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  /* ─── Main return ──────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen scanline p-2 sm:p-6">
      <div className="w-full px-1 sm:px-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/warroom')}
              className="text-xs terminal-text text-muted hover:text-ink border border-border px-2 py-1"
            >
              &#8592; War Room
            </button>
            <h1 className="text-2xl terminal-text">Crisis Simulation Wizard</h1>
          </div>
          <span className="text-xs terminal-text text-muted">Universal Mode</span>
        </div>

        {progressBar}

        <div className="military-border p-4 sm:p-6 mb-4 sm:mb-6">
          {step === 1 && renderStep1()}
          {step === 3 && renderBlueprintReview()}
          {step === 2 && renderBuilding()}
          {step === 7 && renderStep7()}
        </div>

        <div className="flex justify-between items-center flex-shrink-0 pt-2">
          <button
            onClick={goBack}
            className="px-6 py-3 text-xs terminal-text border border-border text-muted hover:border-accent"
          >
            {step === 1 ? '\u2190 War Room' : 'Back'}
          </button>
          <span className="text-xs terminal-text text-muted">
            Step {currentStepIndex + 1} of {VISIBLE_STEPS.length}
          </span>
          {step === 7 ? (
            scenarioId ? (
              <a href="/scenarios" className="military-button px-8 py-3 text-center">
                View scenarios
              </a>
            ) : (
              <span className="text-xs terminal-text text-muted">
                {compiling ? 'Compiling…' : 'Review & compile above'}
              </span>
            )
          ) : (
            <button
              onClick={goNext}
              disabled={!canProceed}
              className="military-button px-8 py-3 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
