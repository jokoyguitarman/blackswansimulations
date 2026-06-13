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

const STEP_LABELS: Record<number, string> = {
  1: 'Scenario Setup',
  2: 'Characters & Facts',
  3: 'Storyline',
  4: 'Convergence',
  7: 'Review & Compile',
};

const VISIBLE_STEPS = [1, 2, 3, 4, 7];

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

  // Extra org pages (beyond the primary crisis page) the trainer adds manually.
  const getExtraOrgs = useCallback((): Array<Record<string, unknown>> => {
    const orgs = (orgPage as { orgs?: Array<Record<string, unknown>> } | null)?.orgs || [];
    return orgs.filter((o) => !o.is_primary);
  }, [orgPage]);

  const getAllies = useCallback(
    () => getExtraOrgs().filter((o) => (o.role as string) !== 'antagonist'),
    [getExtraOrgs],
  );
  const getAntagonists = useCallback(
    () => getExtraOrgs().filter((o) => (o.role as string) === 'antagonist'),
    [getExtraOrgs],
  );

  const addExtraPage = useCallback(
    (role: 'protagonist' | 'antagonist') => {
      const name = newPageName.trim();
      if (!name || !orgPage) return;
      const fbHandle = newPageFbHandle.trim() || `@${name.replace(/[^\w]/g, '')}`;
      const xHandle = newPageXHandle.trim() || fbHandle;
      const orgKey = `org_${role}_${name.toLowerCase().replace(/[^\w]/g, '_')}_${Date.now().toString(36)}`;
      const newOrg = {
        org_key: orgKey,
        display_name: name,
        is_primary: false,
        role,
        control_mode: role === 'antagonist' ? 'ai' : 'player',
        facebook: { page_name: name, page_handle: fbHandle, page_bio: '', follower_count: 10000 },
        x_twitter: { page_name: name, page_handle: xHandle, page_bio: '', follower_count: 8000 },
      };
      setOrgPage((prev) => {
        if (!prev) return prev;
        const existing = (prev as { orgs?: Array<Record<string, unknown>> }).orgs;
        // Ensure the generated primary org is present in orgs.
        const baseOrgs =
          existing && existing.length > 0
            ? existing
            : [
                {
                  org_key: 'primary',
                  display_name:
                    (prev as { facebook?: { page_name?: string } }).facebook?.page_name ||
                    'Organization',
                  is_primary: true,
                  role: 'protagonist',
                  control_mode: 'player',
                  facebook: (prev as { facebook?: unknown }).facebook,
                  x_twitter: (prev as { x_twitter?: unknown }).x_twitter,
                },
              ];
        return { ...prev, orgs: [...baseOrgs, newOrg] };
      });
      setNewPageName('');
      setNewPageFbHandle('');
      setNewPageXHandle('');
    },
    [newPageName, newPageFbHandle, newPageXHandle, orgPage],
  );

  const removeExtraPage = useCallback((orgKey: string) => {
    setOrgPage((prev) => {
      if (!prev) return prev;
      const existing = (prev as { orgs?: Array<Record<string, unknown>> }).orgs || [];
      return { ...prev, orgs: existing.filter((o) => o.org_key !== orgKey) };
    });
  }, []);

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
      case 2:
        return personas.length > 0 && !!factSheet && !step2Loading;
      case 3:
        return storylineInjects.length > 0 && !step3Loading;
      case 4:
        return (sharedInjects.length > 0 || convergenceGates.length > 0) && !step4Loading;
      case 7:
        return true;
      default:
        return false;
    }
  }, [
    step,
    crisisDescription,
    personas,
    factSheet,
    step2Loading,
    storylineInjects,
    step3Loading,
    sharedInjects,
    convergenceGates,
    step4Loading,
  ]);

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

  const generateNPCs = useCallback(async () => {
    if (!crisisDescription) return;
    setStep2Loading(true);
    setStep2Error(null);
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
        }),
      });
      if (!res.ok) {
        setStep2Error('Failed to start NPC generation. Try again.');
        setStep2Loading(false);
        return;
      }
      const json = await res.json();

      if (json.data) {
        const d = json.data;
        if (Array.isArray(d.personas)) setPersonas(d.personas);
        if (d.factSheet || d.fact_sheet) setFactSheet((d.factSheet || d.fact_sheet) as FactSheet);
        if (Array.isArray(d.communities)) setCommunities(d.communities);
        setStep2Loading(false);
        return;
      }

      const jobId = json.job_id;
      if (!jobId) {
        setStep2Error('Unexpected server response.');
        setStep2Loading(false);
        return;
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
            const d = pollJson.data;
            if (Array.isArray(d.personas)) setPersonas(d.personas);
            if (d.factSheet || d.fact_sheet)
              setFactSheet((d.factSheet || d.fact_sheet) as FactSheet);
            if (Array.isArray(d.communities)) setCommunities(d.communities);
            setStep2Loading(false);
            return;
          }
          if (pollJson.status === 'failed') {
            setStep2Error(pollJson.error || 'NPC generation failed. Try again.');
            setStep2Loading(false);
            return;
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
  }, [crisisDescription, country]);

  const generateStoryline = useCallback(async () => {
    if (!crisisDescription) return;
    setStep3Loading(true);
    setStep3Error(null);
    setStep3Progress([]);
    setStorylineInjects([]);

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
              if (msg.type === 'progress') {
                setStep3Progress((prev) => [...prev, String(msg.message)]);
              } else if (msg.type === 'complete' && msg.injects) {
                setStorylineInjects(msg.injects);
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
  }, [crisisDescription, country, personas, factSheet]);

  const generateConvergence = useCallback(async () => {
    if (!crisisDescription) return;
    setStep4Loading(true);
    setStep4Error(null);

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
          personas,
          fact_sheet: factSheet,
          // Feed the Step-3 storyline so convergence designs shared injects and
          // gates as organic consequences of the actual storyline beats.
          team_storylines: storylineInjects.length > 0 ? { storyline: storylineInjects } : {},
        }),
      });

      if (!res.ok) {
        setStep4Error('Failed to start convergence generation. Try again.');
        setStep4Loading(false);
        return;
      }

      const json = await res.json();

      if (json.data && !json.job_id) {
        const d = json.data;
        const si = d.sharedInjects || d.shared_injects;
        if (Array.isArray(si)) setSharedInjects(si);
        const cg = d.convergenceGates || d.convergence_gates;
        if (Array.isArray(cg)) setConvergenceGates(cg);
        if (d.narrative && typeof d.narrative === 'object') setNarrative(d.narrative);
        if (Array.isArray(d.objectives)) setObjectives(d.objectives);
        const dl = d.dimensionLabels || d.dimension_labels;
        if (dl && typeof dl === 'object') setDimensionLabels(dl);
        void generateOrgPage();
        setStep4Loading(false);
        return;
      }

      const jobId = json.job_id;
      if (!jobId) {
        setStep4Error('Unexpected server response.');
        setStep4Loading(false);
        return;
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
            const d = pollJson.data;
            const si = d.sharedInjects || d.shared_injects;
            if (Array.isArray(si)) setSharedInjects(si);
            const cg = d.convergenceGates || d.convergence_gates;
            if (Array.isArray(cg)) setConvergenceGates(cg);
            if (d.narrative && typeof d.narrative === 'object') setNarrative(d.narrative);
            if (Array.isArray(d.objectives)) setObjectives(d.objectives);
            const dl = d.dimensionLabels || d.dimension_labels;
            if (dl && typeof dl === 'object') setDimensionLabels(dl);
            void generateOrgPage();
            setStep4Loading(false);
            return;
          }
          if (pollJson.status === 'failed') {
            setStep4Error(pollJson.error || 'Convergence generation failed. Try again.');
            setStep4Loading(false);
            return;
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
  }, [crisisDescription, country, communities, personas, factSheet, storylineInjects]);

  const generateOrgPage = useCallback(async () => {
    if (!crisisDescription || orgPage) return;
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
          // No competitors named at generation time -> the War Room invents one
          // hostile rival. Trainers can add named competitors below.
          auto_antagonist: true,
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
      }
    } catch {
      /* non-critical -- org page is optional */
    }
  }, [crisisDescription, country, orgPage]);

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
    if (step === 2 && storylineInjects.length === 0) {
      generateStoryline();
      return;
    }
    if (step === 3 && sharedInjects.length === 0 && convergenceGates.length === 0) {
      generateConvergence();
      return;
    }
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

  /* ── Step 1: Scenario Setup (free-form) ─────────────────────────────── */

  const renderStep1 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 1: SCENARIO SETUP]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        Describe any crisis scenario in detail. The AI will analyze your description to understand
        the crisis dynamics and generate an appropriate simulation. You can also upload a document
        with a detailed scenario brief.
      </p>

      <div className="mb-6">
        <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
          Crisis Scenario Description
        </label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={10}
          placeholder={SCENARIO_PLACEHOLDER}
          className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none resize-none"
        />
        <div className="flex justify-between mt-1">
          <span className="text-[9px] terminal-text text-robotic-yellow/30">
            {context.length < 50
              ? `Minimum 50 characters required (${50 - context.length} more)`
              : `${context.length} characters`}
          </span>
        </div>
      </div>

      {/* Document Upload */}
      <div className="mb-6">
        <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
          Upload Scenario Document (optional)
        </label>
        {!uploadedDocText ? (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-robotic-gray-200 rounded p-8 text-center cursor-pointer hover:border-robotic-yellow/50 transition-colors"
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
                <div className="text-3xl mb-3 text-robotic-yellow/30">+</div>
                <div className="text-xs terminal-text text-robotic-yellow/50 mb-1">
                  Drag & drop or click to upload
                </div>
                <div className="text-[10px] terminal-text text-robotic-yellow/30">
                  PDF, DOCX, or TXT (max 10MB)
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="border border-cyan-400/30 rounded p-4 bg-cyan-900/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-cyan-400 text-sm">&#128196;</span>
                <span className="text-xs terminal-text text-cyan-400 font-bold">
                  {uploadedDocName}
                </span>
              </div>
              <button
                onClick={() => {
                  setUploadedDocText('');
                  setUploadedDocName('');
                  setUploadError(null);
                }}
                className="text-[10px] terminal-text text-red-400 hover:text-red-300 border border-red-400/30 px-2 py-0.5 rounded"
              >
                Remove
              </button>
            </div>
            <div className="text-[10px] terminal-text text-robotic-yellow/40 mb-2">
              {uploadedDocText.split(/\s+/).length.toLocaleString()} words extracted
            </div>
            <div className="text-[10px] terminal-text text-robotic-yellow/50 max-h-24 overflow-y-auto border border-robotic-gray-200 rounded p-2 bg-black/20">
              {uploadedDocText.slice(0, 500)}
              {uploadedDocText.length > 500 && '...'}
            </div>
          </div>
        )}
        {uploadError && (
          <div className="mt-2 text-[10px] terminal-text text-yellow-400">{uploadError}</div>
        )}
      </div>

      <div className="mb-4">
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

      <div className="mb-4">
        <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
          Organization Name (optional)
        </label>
        <input
          type="text"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          placeholder="e.g., Meridian Technologies, Acme Corp"
          className="w-full bg-transparent border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow focus:border-robotic-yellow/70 focus:outline-none"
        />
        <div className="mt-1">
          <span className="text-[9px] terminal-text text-robotic-yellow/30">
            Leave blank to let the AI generate a company name
          </span>
        </div>
      </div>

      <div className="mb-4">
        <label className="text-[10px] terminal-text text-robotic-yellow/40 uppercase tracking-wider mb-2 block">
          Brand Logo (optional)
        </label>
        <div className="flex items-center gap-3">
          {brandLogoUrl && (
            <img
              src={brandLogoUrl}
              alt="Brand logo"
              className="w-12 h-12 rounded-lg object-cover border border-robotic-gray-200"
            />
          )}
          <label className="cursor-pointer border border-robotic-gray-200 px-3 py-2 text-sm terminal-text text-robotic-yellow hover:border-robotic-yellow/70 transition-colors">
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
              className="text-[10px] terminal-text text-red-400 hover:text-red-300"
            >
              Remove
            </button>
          )}
        </div>
        <div className="mt-1">
          <span className="text-[9px] terminal-text text-robotic-yellow/30">
            Upload a logo for the brand&apos;s social media pages. If none is provided, the AI will
            generate one.
          </span>
        </div>
      </div>

      {crisisDescription.length >= 50 && (
        <div className="mt-4 p-3 border border-green-400/30 rounded bg-green-900/10">
          <p className="text-[10px] terminal-text text-green-400">
            READY: The AI will analyze your scenario and generate appropriate crisis dynamics, NPCs,
            social media narratives, and public sentiment patterns for {country}.
          </p>
        </div>
      )}
    </div>
  );

  /* ── Step 2: Characters & Facts (read-only preview) ────────────────── */

  const renderStep2 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 2: CHARACTERS & FACTS]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        AI-generated NPC personas, fact sheet, and inferred affected communities. Read-only preview.
      </p>

      {step2Loading || (personas.length === 0 && !step2Error) ? (
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
          <div className="mb-6">
            {(() => {
              const keyNpcs = personas.filter((p) => p.tier === 'key' || !p.tier);
              const bgNpcs = personas.filter((p) => p.tier === 'background');
              return (
                <>
                  <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                    Key Characters ({keyNpcs.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                    {keyNpcs.map((p, i) => (
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
                          <span className="text-[9px] terminal-text bg-cyan-900/30 text-cyan-400 px-1.5 py-0.5 rounded">
                            KEY
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
                  {bgNpcs.length > 0 && (
                    <details className="mb-4">
                      <summary className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3 cursor-pointer hover:text-robotic-yellow/80">
                        Background Characters ({bgNpcs.length}) — click to expand
                      </summary>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3">
                        {bgNpcs.map((p, i) => (
                          <div key={i} className="border border-robotic-gray-200/50 rounded p-2">
                            <div className="flex items-center gap-1 mb-1">
                              <span className="text-[10px] terminal-text text-cyan-400/70">
                                {p.handle}
                              </span>
                            </div>
                            <div className="text-[10px] terminal-text font-bold">{p.name}</div>
                            <div className="text-[9px] terminal-text text-robotic-yellow/40">
                              {p.personality}
                            </div>
                            {p.normal_interests && p.normal_interests.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {p.normal_interests.map((interest, ii) => (
                                  <span
                                    key={ii}
                                    className="text-[8px] terminal-text bg-robotic-gray-200/20 text-robotic-yellow/40 px-1 py-0.5 rounded"
                                  >
                                    {interest}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              );
            })()}
          </div>

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

          {communities.length > 0 && (
            <div>
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Affected Stakeholder Groups ({communities.length})
              </h3>
              <div className="space-y-1">
                {communities.map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 border border-robotic-gray-200 px-4 py-2 rounded"
                  >
                    <span className="text-cyan-400 text-xs">&#9656;</span>
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

  /* ── Step 3: Storyline ──────────────────────────────────────────────── */

  const renderStep3 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 3: CRISIS STORYLINE]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        AI-generated crisis storyline with escalating pressure arc. All players experience the same
        events.
      </p>

      {step3Loading && (
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-5 h-5 border-2 border-robotic-yellow/30 border-t-robotic-yellow rounded-full animate-spin" />
            <span className="text-sm terminal-text text-robotic-yellow animate-pulse">
              Generating storyline...
            </span>
          </div>
          <div className="border border-robotic-gray-200 rounded p-3 bg-black/30 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
            {step3Progress.map((msg, i) => (
              <div key={i} className="text-robotic-yellow/70">
                <span className="text-robotic-yellow/30">[{String(i + 1).padStart(2, '0')}]</span>{' '}
                {msg}
              </div>
            ))}
            <div className="animate-pulse text-robotic-yellow/40">&#9612;</div>
          </div>
        </div>
      )}

      {step3Error && (
        <div className="text-center py-4 mb-4">
          <p className="text-sm terminal-text text-red-400 mb-4">{step3Error}</p>
          <button
            onClick={generateStoryline}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      )}

      {storylineInjects.length > 0 && (
        <div className="border border-robotic-gray-200 rounded p-4">
          <h3 className="text-sm terminal-text text-cyan-400 font-bold uppercase mb-3">
            Crisis Timeline
            <span className="text-[10px] text-robotic-yellow/40 ml-2 normal-case">
              ({storylineInjects.length} injects)
            </span>
          </h3>
          <div className="space-y-2">
            {storylineInjects.map((inj, i) => (
              <div
                key={i}
                className="flex items-start gap-3 border-l-2 border-robotic-yellow/20 pl-3 py-1"
              >
                <span className="text-[10px] terminal-text text-cyan-400 whitespace-nowrap mt-0.5">
                  T+{inj.trigger_time_minutes ?? '?'}m
                </span>
                <div className="flex-1">
                  <div className="text-xs terminal-text font-bold">{inj.title}</div>
                  <div className="text-[10px] terminal-text text-robotic-yellow/50">
                    {inj.content}
                  </div>
                  <div className="flex gap-2 mt-1">
                    {inj.delivery_config && (
                      <span className="text-[9px] terminal-text bg-blue-900/20 text-blue-400 px-1.5 py-0.5 rounded">
                        {String((inj.delivery_config as Record<string, unknown>).app || inj.type)}
                      </span>
                    )}
                    {inj.delivery_config &&
                      !!(inj.delivery_config as Record<string, unknown>).platform && (
                        <span className="text-[9px] terminal-text bg-purple-900/20 text-purple-400 px-1.5 py-0.5 rounded">
                          {String((inj.delivery_config as Record<string, unknown>).platform)}
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
      )}
    </div>
  );

  /* ── Step 4: Convergence + Shared Chaos ─────────────────────────────── */

  const renderStep4 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 4: CONVERGENCE]</h2>
      <p className="text-xs terminal-text text-robotic-yellow/50 mb-6">
        Merged timeline with shared injects and convergence gates. Read-only preview.
      </p>

      {step4Loading ||
      (sharedInjects.length === 0 && convergenceGates.length === 0 && !step4Error) ? (
        <Spinner text="Generating convergence layer..." />
      ) : step4Error ? (
        <div className="text-center py-8">
          <p className="text-sm terminal-text text-red-400 mb-4">{step4Error}</p>
          <button
            onClick={generateConvergence}
            className="px-6 py-2 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {narrative && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Scenario Narrative
              </h3>
              <div className="border border-robotic-gray-200 rounded p-4">
                <div className="text-sm terminal-text text-cyan-400 font-bold mb-2">
                  {narrative.title}
                </div>
                <div className="text-xs terminal-text text-robotic-yellow/70 leading-relaxed">
                  {narrative.description}
                </div>
              </div>
            </div>
          )}

          {objectives.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Training Objectives
              </h3>
              <div className="space-y-2">
                {objectives.map((obj, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs terminal-text text-robotic-yellow/70"
                  >
                    <span className="text-cyan-400 mt-0.5">{String(i + 1).padStart(2, '0')}.</span>
                    <div className="flex-1">
                      <span className="font-bold">{obj.objective_name}</span>
                      <span className="text-robotic-yellow/40 ml-2">(weight: {obj.weight})</span>
                      <div className="text-[10px] text-robotic-yellow/50 mt-0.5">
                        {obj.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {convergenceGates.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Convergence Gates ({convergenceGates.length})
              </h3>
              <div className="space-y-3">
                {convergenceGates.map((gate, i) => {
                  const conditions = gate.conditions_to_appear;
                  const condList: string[] =
                    conditions && typeof conditions === 'object'
                      ? (((conditions as Record<string, unknown>).conditions ||
                          (conditions as Record<string, unknown>).all ||
                          []) as string[])
                      : [];
                  return (
                    <div key={i} className="border border-cyan-700/30 bg-cyan-900/10 rounded p-4">
                      <div className="flex items-center gap-3 mb-2">
                        {gate.eligible_after_minutes != null && (
                          <span className="text-[10px] terminal-text text-cyan-400 whitespace-nowrap">
                            after T+{gate.eligible_after_minutes}m
                          </span>
                        )}
                        <span className="text-xs terminal-text text-cyan-300 font-bold uppercase">
                          {gate.title}
                        </span>
                        <span
                          className={`text-[9px] terminal-text px-1.5 py-0.5 rounded ${
                            gate.severity === 'critical'
                              ? 'bg-red-900/20 text-red-400'
                              : 'bg-orange-900/20 text-orange-400'
                          }`}
                        >
                          {gate.severity}
                        </span>
                      </div>
                      <div className="text-[10px] terminal-text text-robotic-yellow/50 mb-2">
                        {gate.content}
                      </div>
                      {condList.length > 0 && (
                        <div className="mt-2 space-y-1">
                          <div className="text-[9px] terminal-text text-cyan-400/60 uppercase">
                            Conditions:
                          </div>
                          {condList.map((cond, ci) => (
                            <div
                              key={ci}
                              className="text-[9px] terminal-text text-robotic-yellow/40 flex gap-1"
                            >
                              <span className="text-cyan-400">&#8226;</span> {String(cond)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Org Page Identity Preview */}
          {orgPage ? (
            <div className="mb-6">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-3">
                Organization Page Identity
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(
                  orgPage as {
                    facebook?: {
                      page_name: string;
                      page_handle: string;
                      page_bio: string;
                      follower_count: number;
                    };
                  }
                ).facebook && (
                  <div className="border border-robotic-gray-200 rounded p-4">
                    <div className="flex items-center gap-2 mb-2">
                      {(orgPage as { facebook: { page_logo_url?: string } }).facebook
                        .page_logo_url ? (
                        <img
                          src={
                            (orgPage as { facebook: { page_logo_url: string } }).facebook
                              .page_logo_url
                          }
                          alt="Logo"
                          className="w-10 h-10 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold">
                          {
                            ((orgPage as { facebook: { page_name: string } }).facebook.page_name ||
                              'O')[0]
                          }
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs terminal-text font-bold truncate">
                          {(orgPage as { facebook: { page_name: string } }).facebook.page_name}
                        </div>
                        <div className="text-[10px] terminal-text text-cyan-400">
                          {(orgPage as { facebook: { page_handle: string } }).facebook.page_handle}
                        </div>
                      </div>
                      <span className="text-[9px] bg-blue-900/30 text-blue-400 px-1.5 py-0.5 rounded flex-shrink-0">
                        Facebook
                      </span>
                    </div>
                    <div className="text-[10px] terminal-text text-robotic-yellow/50">
                      {(orgPage as { facebook: { page_bio: string } }).facebook.page_bio}
                    </div>
                    <div className="text-[9px] terminal-text text-robotic-yellow/30 mt-1">
                      {(
                        (orgPage as { facebook: { follower_count: number } }).facebook
                          .follower_count || 0
                      ).toLocaleString()}{' '}
                      followers
                    </div>
                  </div>
                )}
                {(
                  orgPage as {
                    x_twitter?: {
                      page_name: string;
                      page_handle: string;
                      page_bio: string;
                      follower_count: number;
                    };
                  }
                ).x_twitter && (
                  <div className="border border-robotic-gray-200 rounded p-4">
                    <div className="flex items-center gap-2 mb-2">
                      {(orgPage as { x_twitter: { page_logo_url?: string } }).x_twitter
                        .page_logo_url ? (
                        <img
                          src={
                            (orgPage as { x_twitter: { page_logo_url: string } }).x_twitter
                              .page_logo_url
                          }
                          alt="Logo"
                          className="w-10 h-10 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-white font-bold">
                          {
                            ((orgPage as { x_twitter: { page_name: string } }).x_twitter
                              .page_name || 'O')[0]
                          }
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs terminal-text font-bold truncate">
                          {(orgPage as { x_twitter: { page_name: string } }).x_twitter.page_name}
                        </div>
                        <div className="text-[10px] terminal-text text-cyan-400">
                          {
                            (orgPage as { x_twitter: { page_handle: string } }).x_twitter
                              .page_handle
                          }
                        </div>
                      </div>
                      <span className="text-[9px] bg-gray-700/30 text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">
                        X
                      </span>
                    </div>
                    <div className="text-[10px] terminal-text text-robotic-yellow/50">
                      {(orgPage as { x_twitter: { page_bio: string } }).x_twitter.page_bio}
                    </div>
                    <div className="text-[9px] terminal-text text-robotic-yellow/30 mt-1">
                      {(
                        (orgPage as { x_twitter: { follower_count: number } }).x_twitter
                          .follower_count || 0
                      ).toLocaleString()}{' '}
                      followers
                    </div>
                  </div>
                )}
              </div>
              {(orgPage as { branded_history?: unknown[] }).branded_history &&
                (orgPage as { branded_history: unknown[] }).branded_history.length > 0 && (
                  <div className="mt-2 p-2 border border-cyan-400/20 rounded bg-cyan-900/10">
                    <p className="text-[10px] terminal-text text-cyan-400">
                      {(orgPage as { branded_history: unknown[] }).branded_history.length}{' '}
                      pre-crisis branded posts will appear on the page timeline when the session
                      starts.
                    </p>
                  </div>
                )}

              {/* Brand pages: protagonist allies + antagonist competitors */}
              <div className="mt-4 p-3 border border-robotic-yellow/20 rounded bg-robotic-gray-200/40">
                <h4 className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                  Brand Pages
                </h4>

                {/* Shared add inputs */}
                <div className="grid grid-cols-3 gap-2">
                  <input
                    value={newPageName}
                    onChange={(e) => setNewPageName(e.target.value)}
                    placeholder="Page name"
                    className="bg-robotic-gray-300 border border-robotic-yellow/30 text-robotic-yellow terminal-text text-xs px-2 py-1 rounded"
                  />
                  <input
                    value={newPageFbHandle}
                    onChange={(e) => setNewPageFbHandle(e.target.value)}
                    placeholder="@FacebookHandle"
                    className="bg-robotic-gray-300 border border-robotic-yellow/30 text-robotic-yellow terminal-text text-xs px-2 py-1 rounded"
                  />
                  <input
                    value={newPageXHandle}
                    onChange={(e) => setNewPageXHandle(e.target.value)}
                    placeholder="@XHandle"
                    className="bg-robotic-gray-300 border border-robotic-yellow/30 text-robotic-yellow terminal-text text-xs px-2 py-1 rounded"
                  />
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => addExtraPage('protagonist')}
                    disabled={!newPageName.trim()}
                    className="military-button px-4 py-1.5 text-xs disabled:opacity-50"
                  >
                    [ADD_ALLY]
                  </button>
                  <button
                    onClick={() => addExtraPage('antagonist')}
                    disabled={!newPageName.trim()}
                    className="px-4 py-1.5 text-xs terminal-text uppercase border border-red-400/50 text-red-400 hover:bg-red-400/10 rounded disabled:opacity-50"
                  >
                    [ADD_COMPETITOR]
                  </button>
                </div>

                {/* Protagonist allies */}
                <div className="mt-4">
                  <div className="text-[10px] terminal-text text-cyan-400/70 uppercase mb-1">
                    Your side &mdash; allied pages (assignable to players)
                  </div>
                  {getAllies().length === 0 ? (
                    <div className="text-[10px] terminal-text text-robotic-yellow/30">
                      The crisis page above is the required protagonist page. Add optional allies.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {getAllies().map((o) => (
                        <div
                          key={String(o.org_key)}
                          className="flex items-center justify-between border-b border-robotic-yellow/10 py-1"
                        >
                          <span className="text-xs terminal-text">
                            {String(o.display_name)}{' '}
                            <span className="text-robotic-yellow/40">
                              {String(
                                (o.facebook as { page_handle?: string } | undefined)?.page_handle ||
                                  '',
                              )}
                            </span>
                          </span>
                          <button
                            onClick={() => removeExtraPage(String(o.org_key))}
                            className="text-[10px] terminal-text text-robotic-orange hover:underline"
                          >
                            [REMOVE]
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Antagonist competitors */}
                <div className="mt-4">
                  <div className="text-[10px] terminal-text text-red-400/70 uppercase mb-1">
                    Opposition &mdash; competitor pages (AI-driven, trainer can seize)
                  </div>
                  {getAntagonists().length === 0 ? (
                    <div className="text-[10px] terminal-text text-robotic-yellow/30">
                      A hostile rival will be auto-generated. Add named competitors (up to 10) to
                      stack the pressure.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {getAntagonists().map((o) => (
                        <div
                          key={String(o.org_key)}
                          className="flex items-center justify-between border-b border-red-400/10 py-1"
                        >
                          <span className="text-xs terminal-text text-red-300">
                            {String(o.display_name)}{' '}
                            <span className="text-red-400/40">
                              {String(
                                (o.facebook as { page_handle?: string } | undefined)?.page_handle ||
                                  '',
                              )}
                            </span>
                            {o.auto_generated ? (
                              <span className="text-[9px] text-red-400/40"> (auto)</span>
                            ) : null}
                          </span>
                          <button
                            onClick={() => removeExtraPage(String(o.org_key))}
                            className="text-[10px] terminal-text text-robotic-orange hover:underline"
                          >
                            [REMOVE]
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            !step4Loading &&
            (sharedInjects.length > 0 || convergenceGates.length > 0) && (
              <div className="mb-6">
                <Spinner text="Generating organization page identity..." />
              </div>
            )
          )}

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
                      T+{inj.trigger_time_minutes ?? '?'}m
                    </span>
                    <div className="flex-1">
                      <div className="text-xs terminal-text font-bold">{inj.title}</div>
                      <div className="text-[10px] terminal-text text-robotic-yellow/50">
                        {inj.content}
                      </div>
                      {inj.delivery_config && (
                        <span className="text-[9px] terminal-text bg-blue-900/20 text-blue-400 px-1.5 py-0.5 rounded mt-1 inline-block">
                          {String((inj.delivery_config as Record<string, unknown>).app || inj.type)}
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

  /* ── Step 5: Review & Compile ──────────────────────────────────────── */

  const renderStep7 = () => (
    <div>
      <h2 className="text-lg terminal-text uppercase mb-4">[STEP 7: REVIEW & COMPILE]</h2>

      {!scenarioId && !compiling && (
        <div className="space-y-6">
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-4">
            Review the full scenario summary, then compile to persist.
          </p>

          <div className="border border-robotic-gray-200 rounded p-4 mb-4">
            <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-4">
              Scenario Summary
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs terminal-text">
              <div className="border border-robotic-gray-200 rounded p-3 text-center col-span-2 sm:col-span-3">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Crisis Scenario</div>
                <div className="text-robotic-yellow text-xs mt-1 line-clamp-2">{crisisLabel}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Country</div>
                <div className="text-robotic-yellow font-bold">{country}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">
                  Storyline Injects
                </div>
                <div className="text-robotic-yellow font-bold text-lg">
                  {storylineInjects.length}
                </div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">NPC Count</div>
                <div className="text-robotic-yellow font-bold text-lg">{personas.length}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Team Injects</div>
                <div className="text-robotic-yellow font-bold text-lg">{totalTeamInjects}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Shared Injects</div>
                <div className="text-robotic-yellow font-bold text-lg">{sharedInjects.length}</div>
              </div>
              <div className="border border-robotic-gray-200 rounded p-3 text-center">
                <div className="text-[10px] text-robotic-yellow/40 uppercase">Conv. Gates</div>
                <div className="text-robotic-yellow font-bold text-lg">
                  {convergenceGates.length}
                </div>
              </div>
            </div>
          </div>

          {narrative && (
            <div className="border border-robotic-gray-200 rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-robotic-yellow/60 uppercase mb-2">
                Narrative
              </h3>
              <div className="text-sm terminal-text text-cyan-400 font-bold mb-1">
                {narrative.title}
              </div>
              <div className="text-[10px] terminal-text text-robotic-yellow/50 leading-relaxed line-clamp-4">
                {narrative.description}
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
            <div className="animate-pulse text-robotic-yellow/40">&#9612;</div>
          </div>
        </div>
      )}

      {scenarioId && !compiling && (
        <div className="text-center py-8">
          <div className="text-4xl mb-4">&#9989;</div>
          <h3 className="text-lg terminal-text font-bold mb-2">Scenario Created Successfully</h3>
          {scenarioTitle && (
            <p className="text-sm terminal-text text-cyan-400 mb-1">{scenarioTitle}</p>
          )}
          <p className="text-xs terminal-text text-robotic-yellow/50 mb-2">
            Scenario ID: {scenarioId}
          </p>

          <div className="border border-robotic-gray-200 rounded p-4 bg-black/20 text-xs terminal-text mb-4 text-left max-w-md mx-auto">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-robotic-yellow/40">Injects:</span>
              <span className="text-robotic-yellow">{storylineInjects.length}</span>
              <span className="text-robotic-yellow/40">NPCs:</span>
              <span className="text-robotic-yellow">{personas.length}</span>
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

          <div className="flex justify-center gap-4 flex-wrap">
            <a href="/scenarios" className="military-button px-8 py-3 text-center">
              [VIEW SCENARIOS]
            </a>
            <button
              onClick={() => navigate('/sessions')}
              className="px-8 py-3 text-xs terminal-text uppercase border border-cyan-500/50 text-cyan-400 hover:bg-cyan-900/20"
            >
              [CREATE SESSION]
            </button>
            {wizardDraftId && (
              <button
                onClick={() => {
                  setScenarioId(null);
                  setCompileProgress([]);
                  setStep(1);
                }}
                className="px-8 py-3 text-xs terminal-text uppercase border border-robotic-yellow/50 text-robotic-yellow hover:bg-robotic-yellow/10"
              >
                [MODIFY & RECOMPILE]
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
              className="text-xs terminal-text text-robotic-yellow/50 hover:text-robotic-yellow border border-robotic-gray-200 px-2 py-1"
            >
              &#8592; WAR ROOM
            </button>
            <h1 className="text-2xl terminal-text uppercase tracking-wider">
              [CRISIS SIMULATION WIZARD]
            </h1>
          </div>
          <span className="text-xs terminal-text text-robotic-yellow/50">Universal Mode</span>
        </div>

        {progressBar}

        <div className="military-border p-4 sm:p-6 mb-4 sm:mb-6">
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
          {step === 7 && renderStep7()}
        </div>

        <div className="flex justify-between items-center flex-shrink-0 pt-2">
          <button
            onClick={goBack}
            className="px-6 py-3 text-xs terminal-text uppercase border border-robotic-gray-200 text-robotic-yellow/70 hover:border-robotic-yellow/50"
          >
            {step === 1 ? '[&#8592; WAR ROOM]' : '[BACK]'}
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
