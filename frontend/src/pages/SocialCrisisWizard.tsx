import { useState, useCallback, useMemo, useEffect, useRef, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import {
  RosterBuilder,
  OrganisationCard,
  CountrySelect,
  organisationsErrorFor,
  newOrganisationDraft,
  migrateLegacyRoster,
  DEFAULT_TEAM_ROSTER,
  ORG_KIND_LABELS,
  PRESET_TEAM_NAMES,
  PressureOrgCard,
  newPressureOrgDraft,
  validatePressureOrg,
  type RosterEntry,
  type PresetTeamCard,
  type OrganisationDraft,
  type CompetitorDraft,
  type OrgKind,
  type PressureOrgDraft,
  type PressureKind,
  type PressureRegister,
} from '../components/Scenario/OrganisationRosterBuilder';
import { BrandMark } from '../components/BrandMark';
import { WrIcon, type WrIconName } from '../components/UI/WarRoomIcon';
import { countryCode, initialsOf } from '../components/UI/Collapsible';
import { SHELL_ART } from '../lib/scenarioArt';

/* ─── Types ─────────────────────────────────────────────────────────── */

/** Crisis footprint proposals (pressure plan §11) — nothing persisted server-side. */
interface FootprintWire {
  countries: Array<{ name: string; role: string; reason: string }>;
  implied_organisations: Array<{
    display_name: string;
    kind: OrgKind;
    country: string;
    city?: string;
    reason: string;
    suggested_roster: string[];
  }>;
  pressure_organisations: Array<{
    display_name: string;
    kind: PressureKind;
    country: string;
    city?: string;
    register: PressureRegister;
    reason: string;
    wants?: string;
  }>;
  labour_signal: boolean;
  product_safety_signal: boolean;
}

/** Map a suggested roster (names) onto presets / custom teams; always ≥ 2 teams, one public voice. */
function rosterFromSuggestion(names: string[], catalog: PresetTeamCard[]): RosterEntry[] {
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const preset = PRESET_TEAM_NAMES.find((p) => p.toLowerCase() === name.toLowerCase());
    const card = catalog.find((c) => c.team_name === (preset || name));
    out.push({
      team_name: preset || name,
      description: preset ? '' : `${name} team of this office.`,
      is_custom: !preset,
      is_public_voice: false,
    });
    if (card?.default_public_voice) out[out.length - 1].is_public_voice = true;
    if (out.length >= 4) break;
  }
  if (!out.some((t) => t.team_name === 'Communications')) {
    out.unshift({
      team_name: 'Communications',
      description: '',
      is_custom: false,
      is_public_voice: false,
    });
  }
  if (out.length < 2) {
    out.push({
      team_name: 'Operations',
      description: 'Runs the site day to day; first to know what is happening on the ground.',
      is_custom: true,
      is_public_voice: false,
    });
  }
  if (!out.some((t) => t.is_public_voice)) out[0].is_public_voice = true;
  return out.slice(0, 6);
}

interface NPCPersona {
  handle: string;
  name: string;
  type: string;
  personality: string;
  bias: string;
  follower_count: number;
  tier?: 'key' | 'background';
  normal_interests?: string[];
  /** Contract §5.3: which country's public sphere this persona belongs to. */
  country?: string;
}

/** Contract §3 stakeholder (player-visible + hidden fields; the wizard only displays the visible ones). */
interface StakeholderWire {
  id: string;
  name: string;
  title: string;
  organisation: string;
  relationship: string;
  owning_team: string;
  org_key: string | null;
  email: string;
  phone: string | null;
  handle: string;
  note: string;
  grievance: string;
  [key: string]: unknown;
}

interface OrgRegistryWire {
  org_key: string;
  display_name: string;
  short_name?: string;
  country: string;
  city?: string;
  kind?: string;
  side: 'protagonist' | 'antagonist';
  is_primary?: boolean;
}

/** Notification / consultation SOP step generated with the cast (graded at runtime). */
interface SopStepWire {
  step_id: string;
  name: string;
  description: string;
  time_limit_minutes: number;
  [key: string]: unknown;
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

/** Full charter payload streamed from the server and round-tripped into compile. */
interface TeamCharterWire {
  team_name: string;
  mission: string;
  responsibilities: string[];
  out_of_lane?: string[];
  scoring_rubric?: string;
  expected_actions?: Array<Record<string, unknown>>;
  min_participants?: number;
  max_participants?: number;
  is_custom?: boolean;
  can_post_publicly?: boolean;
  sentiment_dimension?: string;
  // Contract §5.2 — organisation identity (multi-organisation scenarios)
  org_key?: string | null;
  function_key?: string;
  country?: string;
  short_name?: string;
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

const SCENARIO_PLACEHOLDER = `Describe the crisis scenario you want to simulate. The AI will analyze your description and generate an appropriate social crisis simulation.

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

  // Payment portal: scenario generation requires a scenario credit
  // (granted when a client pays an invoice). Admins bypass; the server
  // enforces this regardless - the panel below is UX only.
  const { user } = useAuth();
  const isAdminUser = user?.role === 'admin';
  const [scenarioCredits, setScenarioCredits] = useState<number | null>(null);
  useEffect(() => {
    if (isAdminUser) {
      setScenarioCredits(1);
      return;
    }
    api.billing
      .getCredits()
      .then((res) => setScenarioCredits(res.data.scenario))
      .catch(() => setScenarioCredits(1)); // fail open in UI; server enforces
  }, [isAdminUser]);

  /* Draft persistence */
  const [wizardDraftId, setWizardDraftId] = useState<string | null>(null);

  /* Step 1 — Scenario Setup (free-form) */
  const [orgName, setOrgName] = useState('');
  const [brandLogoUrl, setBrandLogoUrl] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [country, setCountry] = useState('Singapore');
  // Primary organisation extras (contract §5.1): where it sits and what it is.
  const [primaryCity, setPrimaryCity] = useState('');
  const [primaryKind, setPrimaryKind] = useState<OrgKind>('company');
  const [primaryShortName, setPrimaryShortName] = useState('');
  // Additional protagonist organisations — each with its own country and team roster.
  const [extraOrganisations, setExtraOrganisations] = useState<OrganisationDraft[]>([]);
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

  /* Response teams: the trainer assembles a roster (2-6) of preset teams
     and/or their company's own divisions. Per-team storylines + charters are
     generated for the actual roster alongside the universal backbone. */
  const [teamStorylines, setTeamStorylines] = useState<Record<string, SocialInject[]>>({});
  const [teamCharters, setTeamCharters] = useState<TeamCharterWire[]>([]);
  const [teamRoster, setTeamRoster] = useState<RosterEntry[]>(DEFAULT_TEAM_ROSTER);
  const [presetCatalog, setPresetCatalog] = useState<PresetTeamCard[]>([]);

  useEffect(() => {
    const loadCatalog = async () => {
      try {
        const headers = await authHeaders();
        const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/team-catalog'), { headers });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.data)) setPresetCatalog(json.data as PresetTeamCard[]);
        }
      } catch {
        /* cards fall back to name-only rendering */
      }
    };
    loadCatalog();
  }, []);

  // Roster of antagonist competitor brands defined in Setup (each in its own country).
  const [competitorEntries, setCompetitorEntries] = useState<CompetitorDraft[]>([]);
  const [autoAntagonist, setAutoAntagonist] = useState(true);

  /** Organisation validity mirrors server-side validateOrganisations (server still enforces). */
  const rosterError = useMemo(
    (): string | null =>
      organisationsErrorFor(
        { display_name: orgName, country, team_roster: teamRoster },
        extraOrganisations,
        competitorEntries,
      ),
    [orgName, country, teamRoster, extraOrganisations, competitorEntries],
  );

  /** Wire shape for every generation endpoint (contract §5): primary + additional organisations. */
  const organisationsPayload = useMemo(
    () => [
      {
        display_name: orgName.trim() || 'Organisation',
        short_name: primaryShortName.trim() || undefined,
        country,
        city: primaryCity.trim() || undefined,
        kind: primaryKind,
        logo_url: brandLogoUrl || undefined,
        is_primary: true,
        team_roster: teamRoster.map((t) => ({
          team_name: t.team_name.trim(),
          description: t.description.trim() || undefined,
          is_custom: t.is_custom,
          is_public_voice: t.is_public_voice,
        })),
      },
      ...extraOrganisations.map((o) => ({
        display_name: o.display_name.trim(),
        short_name: o.short_name.trim() || undefined,
        country: o.country,
        city: o.city.trim() || undefined,
        kind: o.kind,
        facebook_handle: o.facebook_handle.trim() || undefined,
        x_handle: o.x_handle.trim() || undefined,
        is_primary: false,
        operation: o.operation === 'ai' ? ('ai' as const) : ('players' as const),
        team_roster: o.team_roster.map((t) => ({
          team_name: t.team_name.trim(),
          description: t.description.trim() || undefined,
          is_custom: t.is_custom,
          is_public_voice: t.is_public_voice,
        })),
      })),
    ],
    [
      orgName,
      primaryShortName,
      country,
      primaryCity,
      primaryKind,
      brandLogoUrl,
      teamRoster,
      extraOrganisations,
    ],
  );

  const competitorsPayload = useMemo(
    () =>
      competitorEntries.map((c) => ({
        name: c.name.trim(),
        country: c.country,
        facebook_handle: c.facebook_handle || undefined,
        x_handle: c.x_handle || undefined,
      })),
    [competitorEntries],
  );

  /* Pressure organisations (pressure plan §5.1 / §11) + crisis footprint proposals */
  const [pressureOrgs, setPressureOrgs] = useState<PressureOrgDraft[]>([]);
  const [footprint, setFootprint] = useState<FootprintWire | null>(null);
  const [footprintLoading, setFootprintLoading] = useState(false);
  const [footprintNotice, setFootprintNotice] = useState<string | null>(null);
  const footprintRanFor = useRef<string>('');

  const pressureOrganisationsPayload = useMemo(
    () =>
      pressureOrgs
        .filter((p) => p.display_name.trim().length >= 2)
        .map((p) => ({
          org_key: p.org_key,
          display_name: p.display_name.trim(),
          kind: p.kind,
          country: p.country,
          city: p.city.trim() || undefined,
          register: p.register,
          wants: p.wants.trim() || undefined,
          facebook_handle: p.facebook_handle.trim() || undefined,
          x_handle: p.x_handle.trim() || undefined,
          spokesperson_stakeholder_id: p.spokesperson_stakeholder_id,
        })),
    [pressureOrgs],
  );

  /**
   * Crisis footprint (pressure plan §11): one cheap call that proposes implied offices,
   * countries and pressure groups from the description. Proposals are pre-ticked: implied
   * offices become AI-operated organisations, pressure groups become pressure-org drafts.
   */
  const detectFootprint = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      const text = `${crisisDescription} ${context}`.trim();
      if (text.replace(/\W/g, '').length < 20) {
        if (!opts.silent) setFootprintNotice('Describe the crisis first (a sentence or two).');
        return;
      }
      setFootprintLoading(true);
      setFootprintNotice(null);
      try {
        const headers = await authHeaders();
        const res = await fetchJSON(apiUrl('/api/warroom/social-crisis/footprint'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            crisis_type: crisisDescription,
            context,
            organisations: organisationsPayload,
            competitors: competitorsPayload,
          }),
        });
        const json = (await res.json()) as { data?: FootprintWire; error?: string };
        if (!res.ok || !json.data) throw new Error(json.error || 'Footprint inference failed');
        const fp = json.data;
        setFootprint(fp);
        footprintRanFor.current = text;
        const existingOrgNames = new Set(
          [orgName, ...extraOrganisations.map((o) => o.display_name)].map((n) =>
            n.trim().toLowerCase(),
          ),
        );
        const addedOrgs: OrganisationDraft[] = fp.implied_organisations
          .filter((o) => !existingOrgNames.has(o.display_name.toLowerCase()))
          .map((o) => ({
            ...newOrganisationDraft(o.country),
            display_name: o.display_name,
            city: o.city || '',
            kind: (['company', 'office', 'agency', 'ngo', 'other'] as const).includes(o.kind)
              ? o.kind
              : 'office',
            operation: 'ai' as const,
            proposed_reason: o.reason,
            team_roster: rosterFromSuggestion(o.suggested_roster, presetCatalog),
          }));
        const existingPressure = new Set(
          pressureOrgs.map((p) => p.display_name.trim().toLowerCase()),
        );
        const addedPressure: PressureOrgDraft[] = fp.pressure_organisations
          .filter((p) => !existingPressure.has(p.display_name.toLowerCase()))
          .map((p) => ({
            ...newPressureOrgDraft(p.country, p.kind),
            display_name: p.display_name,
            city: p.city || '',
            register: p.register,
            wants: p.wants || '',
            proposed_reason: p.reason,
          }));
        if (addedOrgs.length > 0)
          setExtraOrganisations((prev) => [...prev, ...addedOrgs].slice(0, 5));
        if (addedPressure.length > 0)
          setPressureOrgs((prev) => [...prev, ...addedPressure].slice(0, 6));
        const countries = fp.countries
          .map((c) => `${c.name} (${c.role.replace('_', ' ')})`)
          .join(', ');
        setFootprintNotice(
          `${countries || 'No extra countries'}. Added ${addedOrgs.length} AI-operated organisation(s) and ${addedPressure.length} pressure organisation(s) — untick or remove anything that does not belong.`,
        );
      } catch (err) {
        setFootprintNotice(
          err instanceof Error ? err.message : 'Could not infer the crisis footprint',
        );
      } finally {
        setFootprintLoading(false);
      }
    },
    [
      crisisDescription,
      context,
      organisationsPayload,
      competitorsPayload,
      orgName,
      extraOrganisations,
      pressureOrgs,
      presetCatalog,
    ],
  );

  /* Stakeholder characters, registry and cast-generated SOP steps (contract §3 / §5.1) */
  const [stakeholders, setStakeholders] = useState<StakeholderWire[]>([]);
  const [stakeholderInjects, setStakeholderInjects] = useState<SocialInject[]>([]);
  const [orgRegistry, setOrgRegistry] = useState<OrgRegistryWire[]>([]);
  const [perCountryCounts, setPerCountryCounts] = useState<Record<string, number>>({});
  const [sopSteps, setSopSteps] = useState<SopStepWire[]>([]);
  const [decisionContext, setDecisionContext] = useState<Record<string, unknown> | null>(null);

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
  const [newPageCountry, setNewPageCountry] = useState('');

  const addCompetitor = useCallback(() => {
    const name = newPageName.trim();
    if (!name) return;
    setCompetitorEntries((prev) => [
      ...prev,
      {
        name,
        country: newPageCountry || country,
        facebook_handle: newPageFbHandle.trim() || undefined,
        x_handle: newPageXHandle.trim() || undefined,
      },
    ]);
    setNewPageName('');
    setNewPageFbHandle('');
    setNewPageXHandle('');
  }, [newPageName, newPageFbHandle, newPageXHandle, newPageCountry, country]);

  const removeCompetitor = useCallback((idx: number) => {
    setCompetitorEntries((prev) => prev.filter((_, i) => i !== idx));
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
      team_storylines: teamStorylines,
      team_charters: teamCharters,
      team_roster: teamRoster,
      shared_injects: sharedInjects,
      convergence_gates: convergenceGates,
      narrative,
      objectives,
      dimension_labels: dimensionLabels,
      org_page: orgPage,
      competitor_entries: competitorEntries,
      auto_antagonist: autoAntagonist,
      // Multi-organisation (contract §3 / §5 / §7A)
      primary_city: primaryCity,
      primary_kind: primaryKind,
      primary_short_name: primaryShortName,
      extra_organisations: extraOrganisations,
      pressure_organisations: pressureOrgs,
      footprint,
      stakeholders,
      stakeholder_injects: stakeholderInjects,
      org_registry: orgRegistry,
      per_country_counts: perCountryCounts,
      sop_steps: sopSteps,
      decision_context: decisionContext,
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
      teamStorylines,
      teamCharters,
      teamRoster,
      sharedInjects,
      convergenceGates,
      narrative,
      objectives,
      dimensionLabels,
      orgPage,
      competitorEntries,
      autoAntagonist,
      primaryCity,
      primaryKind,
      primaryShortName,
      extraOrganisations,
      pressureOrgs,
      footprint,
      stakeholders,
      stakeholderInjects,
      orgRegistry,
      perCountryCounts,
      sopSteps,
      decisionContext,
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
        if (input.team_storylines && typeof input.team_storylines === 'object')
          setTeamStorylines(input.team_storylines as Record<string, SocialInject[]>);
        if (Array.isArray(input.team_charters))
          setTeamCharters(input.team_charters as TeamCharterWire[]);
        if (Array.isArray(input.team_roster) && input.team_roster.length > 0)
          setTeamRoster(migrateLegacyRoster(input.team_roster as RosterEntry[]));
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
        const savedCountry = input.country ? String(input.country) : 'Singapore';
        // Legacy drafts: "allied pages" become additional organisations in the primary's
        // country with the default roster; competitors gain the primary's country.
        const extras: OrganisationDraft[] = Array.isArray(input.extra_organisations)
          ? (input.extra_organisations as OrganisationDraft[]).map((o) => ({
              ...o,
              team_roster: migrateLegacyRoster(o.team_roster || []),
            }))
          : [];
        if (extras.length === 0 && Array.isArray(input.ally_entries)) {
          for (const a of input.ally_entries as Array<{
            name: string;
            facebook_handle?: string;
            x_handle?: string;
          }>) {
            extras.push({
              ...newOrganisationDraft(savedCountry),
              display_name: a.name,
              facebook_handle: a.facebook_handle || '',
              x_handle: a.x_handle || '',
            });
          }
        }
        if (extras.length > 0) setExtraOrganisations(extras);
        if (Array.isArray(input.pressure_organisations))
          setPressureOrgs(input.pressure_organisations as PressureOrgDraft[]);
        if (input.footprint && typeof input.footprint === 'object') {
          setFootprint(input.footprint as FootprintWire);
          footprintRanFor.current =
            `${String(input.crisis_description || '')} ${String(input.context || '')}`.trim();
        }
        if (Array.isArray(input.competitor_entries))
          setCompetitorEntries(
            (
              input.competitor_entries as Array<{
                name: string;
                country?: string;
                facebook_handle?: string;
                x_handle?: string;
              }>
            ).map((c) => ({ ...c, country: c.country || savedCountry })),
          );
        if (typeof input.auto_antagonist === 'boolean') setAutoAntagonist(input.auto_antagonist);
        if (input.primary_city) setPrimaryCity(String(input.primary_city));
        if (input.primary_kind && typeof input.primary_kind === 'string')
          setPrimaryKind(input.primary_kind as OrgKind);
        if (input.primary_short_name) setPrimaryShortName(String(input.primary_short_name));
        if (Array.isArray(input.stakeholders))
          setStakeholders(input.stakeholders as StakeholderWire[]);
        if (Array.isArray(input.stakeholder_injects))
          setStakeholderInjects(input.stakeholder_injects as SocialInject[]);
        if (Array.isArray(input.org_registry))
          setOrgRegistry(input.org_registry as OrgRegistryWire[]);
        if (input.per_country_counts && typeof input.per_country_counts === 'object')
          setPerCountryCounts(input.per_country_counts as Record<string, number>);
        if (Array.isArray(input.sop_steps)) setSopSteps(input.sop_steps as SopStepWire[]);
        if (input.decision_context && typeof input.decision_context === 'object')
          setDecisionContext(input.decision_context as Record<string, unknown>);

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
        return crisisDescription.length >= 50 && rosterError === null;
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
  }, [step, crisisDescription, extracting, rosterError]);

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
      if (d.per_country_counts && typeof d.per_country_counts === 'object')
        setPerCountryCounts(d.per_country_counts as Record<string, number>);
      return { personas: p, factSheet: fs, communities: comms };
    };
    // A fresh build resets everything downstream that hangs off the crowd.
    setStakeholders([]);
    setStakeholderInjects([]);
    setSopSteps([]);
    setDecisionContext(null);
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
          organisations: organisationsPayload,
          competitors: competitorsPayload,
          pressure_organisations: pressureOrganisationsPayload,
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
  }, [crisisDescription, country, orgName, blueprint, organisationsPayload, competitorsPayload]);

  const generateStoryline = useCallback(
    async (
      personasArg?: NPCPersona[],
      factSheetArg?: FactSheet | null,
    ): Promise<{
      injects: SocialInject[];
      teamStorylines: Record<string, SocialInject[]>;
      personas: NPCPersona[];
      teamCharters: TeamCharterWire[];
      stakeholders: StakeholderWire[];
      pressureOrganisations: PressureOrgDraft[];
    } | null> => {
      if (!crisisDescription) return null;
      const personasIn = personasArg ?? personas;
      const factSheetIn = factSheetArg ?? factSheet;
      setStep3Loading(true);
      setStep3Error(null);
      setStep3Progress([]);
      setStorylineInjects([]);
      setTeamStorylines({});
      setTeamCharters([]);
      setStakeholders([]);
      setStakeholderInjects([]);
      let result: {
        injects: SocialInject[];
        teamStorylines: Record<string, SocialInject[]>;
        personas: NPCPersona[];
        teamCharters: TeamCharterWire[];
        stakeholders: StakeholderWire[];
        pressureOrganisations: PressureOrgDraft[];
      } | null = null;

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
            team_roster: teamRoster.map((t) => ({
              team_name: t.team_name.trim(),
              description: t.description.trim() || undefined,
              is_custom: t.is_custom,
              is_public_voice: t.is_public_voice,
            })),
            organisations: organisationsPayload,
            competitors: competitorsPayload,
            pressure_organisations: pressureOrganisationsPayload,
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
                } else if (msg.type === 'org_progress') {
                  setStep3Progress((prev) => [
                    ...prev,
                    `[${String(msg.org_key)}] ${String(msg.stage)} ready${msg.detail ? ` — ${String(msg.detail)}` : ''}`,
                  ]);
                } else if (msg.type === 'team_complete') {
                  setStep3Progress((prev) => [
                    ...prev,
                    `${String(msg.team)} storyline ready (${Number(msg.inject_count)} injects)`,
                  ]);
                } else if (msg.type === 'complete' && msg.injects) {
                  const injects = msg.injects as SocialInject[];
                  const teamMap = (msg.team_storylines || {}) as Record<string, SocialInject[]>;
                  const charters = Array.isArray(msg.team_charters)
                    ? (msg.team_charters as TeamCharterWire[])
                    : [];
                  const stks = Array.isArray(msg.stakeholders)
                    ? (msg.stakeholders as StakeholderWire[])
                    : [];
                  // Stakeholder persona twins join the crowd so their posts have an author.
                  const twins = Array.isArray(msg.persona_twins)
                    ? (msg.persona_twins as NPCPersona[])
                    : [];
                  const known = new Set(personasIn.map((p) => p.handle));
                  const mergedPersonas = [
                    ...personasIn,
                    ...twins.filter((t) => !known.has(t.handle)),
                  ];
                  const pressureWire = Array.isArray(msg.pressure_organisations)
                    ? (msg.pressure_organisations as Array<{
                        org_key: string;
                        display_name: string;
                        spokesperson_stakeholder_id?: string;
                      }>)
                    : [];
                  const mergedPressure = pressureOrgs.map((p) => {
                    const m = pressureWire.find(
                      (w) => w.display_name.toLowerCase() === p.display_name.trim().toLowerCase(),
                    );
                    return m
                      ? {
                          ...p,
                          org_key: m.org_key,
                          spokesperson_stakeholder_id: m.spokesperson_stakeholder_id,
                        }
                      : p;
                  });
                  result = {
                    injects,
                    teamStorylines: teamMap,
                    personas: mergedPersonas,
                    teamCharters: charters,
                    stakeholders: stks,
                    pressureOrganisations: mergedPressure,
                  };
                  setStorylineInjects(injects);
                  setTeamStorylines(teamMap);
                  setTeamCharters(charters);
                  setStakeholders(stks);
                  if (Array.isArray(msg.stakeholder_injects))
                    setStakeholderInjects(msg.stakeholder_injects as SocialInject[]);
                  if (twins.length > 0) setPersonas(mergedPersonas);
                  if (Array.isArray(msg.orgs)) setOrgRegistry(msg.orgs as OrgRegistryWire[]);
                  if (Array.isArray(msg.sop_steps)) setSopSteps(msg.sop_steps as SopStepWire[]);
                  if (msg.decision_context && typeof msg.decision_context === 'object')
                    setDecisionContext(msg.decision_context as Record<string, unknown>);
                  // Pressure orgs come back normalised with their spokesperson ids.
                  if (pressureWire.length > 0) setPressureOrgs(mergedPressure);
                  if (stks.length > 0)
                    setStep3Progress((prev) => [
                      ...prev,
                      `${stks.length} stakeholder contacts created (${stks.filter((s) => s.grievance).length} with a live concern)`,
                    ]);
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
    [
      crisisDescription,
      country,
      orgName,
      personas,
      factSheet,
      blueprint,
      teamRoster,
      organisationsPayload,
      competitorsPayload,
    ],
  );

  const generateConvergence = useCallback(
    async (
      personasArg?: NPCPersona[],
      factSheetArg?: FactSheet | null,
      storylineArg?: SocialInject[],
      teamStorylinesArg?: Record<string, SocialInject[]>,
      chartersArg?: TeamCharterWire[],
      stakeholdersArg?: StakeholderWire[],
    ): Promise<boolean> => {
      if (!crisisDescription) return false;
      const personasIn = personasArg ?? personas;
      const factSheetIn = factSheetArg ?? factSheet;
      const storylineIn = storylineArg ?? storylineInjects;
      const teamStorylinesIn = teamStorylinesArg ?? teamStorylines;
      const chartersIn = chartersArg ?? teamCharters;
      const stakeholdersIn = stakeholdersArg ?? stakeholders;
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
        // Cross-team intel emails: merge into the holder teams' storylines so
        // they compile as ordinary team-scoped injects.
        const intel = d.intel_injects as Record<string, SocialInject[]> | undefined;
        if (intel && typeof intel === 'object') {
          setTeamStorylines((prev) => {
            const next = { ...prev };
            for (const [team, injects] of Object.entries(intel)) {
              if (!Array.isArray(injects) || injects.length === 0) continue;
              next[team] = [...(next[team] || []), ...injects];
            }
            return next;
          });
        }
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
            // Feed the storylines so convergence designs shared injects and gates
            // as organic consequences of the actual storyline beats. Per-team
            // storylines are keyed by their fixed team names; the universal
            // backbone rides along as "Shared".
            team_storylines: {
              ...teamStorylinesIn,
              ...(storylineIn.length > 0 ? { Shared: storylineIn } : {}),
            },
            blueprint: blueprint ?? undefined,
            organisations: organisationsPayload,
            competitors: competitorsPayload,
            pressure_organisations: pressureOrganisationsPayload,
            team_charters: chartersIn.length > 0 ? chartersIn : undefined,
            stakeholders: stakeholdersIn.length > 0 ? stakeholdersIn : undefined,
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
      teamStorylines,
      teamCharters,
      stakeholders,
      blueprint,
      organisationsPayload,
      competitorsPayload,
    ],
  );

  const generateOrgPage = useCallback(
    async (
      stakeholdersArg?: StakeholderWire[],
      factSheetArg?: FactSheet | null,
      pressureArg?: PressureOrgDraft[],
    ): Promise<boolean> => {
      if (!crisisDescription) return false;
      const stakeholdersIn = stakeholdersArg ?? stakeholders;
      const factSheetIn = factSheetArg ?? factSheet;
      const pressureIn = pressureArg ?? pressureOrgs;
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
            // Legacy fields kept for the single-org server path; organisations[] drives the
            // multi-organisation path (every protagonist page in its own country).
            allies: [],
            competitors: competitorEntries.map((c) => ({
              name: c.name,
              facebook_handle: c.facebook_handle,
              x_handle: c.x_handle,
            })),
            organisations: organisationsPayload,
            competitors_with_country: competitorsPayload,
            pressure_organisations: pressureIn
              .filter((p) => p.display_name.trim().length >= 2)
              .map((p) => ({
                org_key: p.org_key,
                display_name: p.display_name.trim(),
                kind: p.kind,
                country: p.country,
                city: p.city.trim() || undefined,
                register: p.register,
                wants: p.wants.trim() || undefined,
                facebook_handle: p.facebook_handle.trim() || undefined,
                x_handle: p.x_handle.trim() || undefined,
                spokesperson_stakeholder_id: p.spokesperson_stakeholder_id,
              })),
            stakeholders: stakeholdersIn.length > 0 ? stakeholdersIn : undefined,
            fact_sheet: factSheetIn ?? undefined,
            crisis_type: crisisDescription,
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
                  if (Array.isArray(msg.orgs)) setOrgRegistry(msg.orgs as OrgRegistryWire[]);
                  // Pressure-page statements ride with the stakeholder injects; spokesperson
                  // twins join the crowd (contract v3.2 §4.4).
                  if (Array.isArray(msg.pressure_injects) && msg.pressure_injects.length > 0) {
                    const fresh = msg.pressure_injects as SocialInject[];
                    setStakeholderInjects((prev) => [
                      ...prev.filter(
                        (i) =>
                          !(i.delivery_config as Record<string, unknown> | undefined)?.page_org_key,
                      ),
                      ...fresh,
                    ]);
                  }
                  if (Array.isArray(msg.persona_twins) && msg.persona_twins.length > 0) {
                    const twins = msg.persona_twins as NPCPersona[];
                    setPersonas((prev) => {
                      const known = new Set(prev.map((p) => p.handle));
                      return [...prev, ...twins.filter((t) => !known.has(t.handle))];
                    });
                  }
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
    },
    [
      crisisDescription,
      country,
      orgName,
      brandLogoUrl,
      competitorEntries,
      autoAntagonist,
      organisationsPayload,
      competitorsPayload,
      stakeholders,
      factSheet,
      pressureOrgs,
    ],
  );

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
    if (!story || story.injects.length === 0) {
      setBuildError('storyline');
      return;
    }

    setBuildStage('convergence');
    const convOk = await generateConvergence(
      story.personas,
      npc.factSheet,
      story.injects,
      story.teamStorylines,
      story.teamCharters,
      story.stakeholders,
    );
    if (!convOk) {
      setBuildError('convergence');
      return;
    }

    setBuildStage('pages');
    await generateOrgPage(story.stakeholders, npc.factSheet, story.pressureOrganisations);

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
          team_storylines: teamStorylines,
          team_charters: teamCharters.length > 0 ? teamCharters : undefined,
          shared_injects: sharedInjects,
          convergence_gates: convergenceGates,
          dimension_labels: dimensionLabels,
          org_page: orgPage,
          duration: 60,
          blueprint: blueprint ?? undefined,
          // Multi-organisation (contract §3 / §5) — the server derives orgs[]/countries[].
          organisations: organisationsPayload,
          competitors: competitorsPayload,
          pressure_organisations: pressureOrganisationsPayload,
          stakeholders: stakeholders.length > 0 ? stakeholders : undefined,
          stakeholder_injects: stakeholderInjects.length > 0 ? stakeholderInjects : undefined,
          sop_steps: sopSteps.length > 0 ? sopSteps : undefined,
          decision_context: decisionContext ?? undefined,
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
    teamStorylines,
    teamCharters,
    sharedInjects,
    convergenceGates,
    narrative,
    objectives,
    orgName,
    dimensionLabels,
    orgPage,
    blueprint,
    organisationsPayload,
    competitorsPayload,
    stakeholders,
    stakeholderInjects,
    sopSteps,
    decisionContext,
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
    // Footprint runs once automatically when leaving Setup (pressure plan §11): the trainer
    // sees the proposals and continues with a second click.
    if (step === 1 && !footprintLoading) {
      const text = `${crisisDescription} ${context}`.trim();
      if (text.replace(/\W/g, '').length >= 20 && footprintRanFor.current !== text) {
        await detectFootprint({ silent: true });
        if (footprintRanFor.current === text) return; // stay on Setup to review proposals
      }
    }
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
    return Object.values(teamStorylines).reduce((sum, injects) => sum + injects.length, 0);
  }, [teamStorylines]);

  const crisisLabel = useMemo(() => {
    if (!crisisDescription) return 'Not specified';
    return crisisDescription.length > 80
      ? crisisDescription.slice(0, 80) + '...'
      : crisisDescription;
  }, [crisisDescription]);

  /* ─── Render ─────────────────────────────────────────────────────── */

  /*
   * Situation Map shell (docs/design/warroom/variation-c-situation-map.html, spec §5).
   * The Setup step splits into hero content (brief + footprint radar) and the map (three lanes).
   * Every input and handler below is the same as before the redesign.
   */

  const orgCount = extraOrganisations.length + 1;
  const teamCount =
    teamRoster.length + extraOrganisations.reduce((n, o) => n + o.team_roster.length, 0);
  const countrySet = new Set<string>(
    [country, ...extraOrganisations.map((o) => o.country)].filter(Boolean),
  );

  /** Is a radar proposal currently present as a draft? */
  const hasOrgProposal = (name: string) =>
    [orgName, ...extraOrganisations.map((o) => o.display_name)].some(
      (n) => n.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  const hasPressureProposal = (name: string) =>
    pressureOrgs.some((p) => p.display_name.trim().toLowerCase() === name.trim().toLowerCase());

  const toggleOrgProposal = (o: FootprintWire['implied_organisations'][number]) => {
    if (hasOrgProposal(o.display_name)) {
      setExtraOrganisations((prev) =>
        prev.filter((x) => x.display_name.trim().toLowerCase() !== o.display_name.toLowerCase()),
      );
      return;
    }
    if (extraOrganisations.length + 1 >= 6) return;
    setExtraOrganisations((prev) => [
      ...prev,
      {
        ...newOrganisationDraft(o.country),
        display_name: o.display_name,
        city: o.city || '',
        kind: (['company', 'office', 'agency', 'ngo', 'other'] as const).includes(o.kind)
          ? o.kind
          : 'office',
        operation: 'ai' as const,
        proposed_reason: o.reason,
        team_roster: rosterFromSuggestion(o.suggested_roster, presetCatalog),
      },
    ]);
  };
  const togglePressureProposal = (p: FootprintWire['pressure_organisations'][number]) => {
    if (hasPressureProposal(p.display_name)) {
      setPressureOrgs((prev) =>
        prev.filter((x) => x.display_name.trim().toLowerCase() !== p.display_name.toLowerCase()),
      );
      return;
    }
    if (pressureOrgs.length >= 6) return;
    setPressureOrgs((prev) => [
      ...prev,
      {
        ...newPressureOrgDraft(p.country, p.kind),
        display_name: p.display_name,
        city: p.city || '',
        register: p.register,
        wants: p.wants || '',
        proposed_reason: p.reason,
      },
    ]);
  };

  const PRESSURE_KIND_ICON: Record<PressureKind, WrIconName> = {
    regulator: 'landmark',
    union: 'fist',
    ngo: 'leaf',
    community_group: 'community',
    political: 'podium',
  };
  const PRESSURE_KIND_LABEL: Record<PressureKind, string> = {
    regulator: 'Regulator',
    union: 'Union',
    ngo: 'NGO',
    community_group: 'Community group',
    political: 'Political actor',
  };

  const pressureValidation = pressureOrgs.map(validatePressureOrg).find(Boolean);

  /** Hero left column for Setup: the brief, the document and the logo. */
  const renderSetupBrief = () => (
    <div>
      <div className="wr-eyebrow">Scenario setup · step 1 of {VISIBLE_STEPS.length}</div>
      <h1>What happened?</h1>
      <p className="lead">
        Describe the crisis in plain language. The countries, offices and pressure groups in the
        story are read from it and appear on the radar; everything else — contacts, crowd, injects,
        fact sheet — is generated from it.
      </p>
      <textarea
        value={context}
        onChange={(e) => setContext(e.target.value)}
        rows={7}
        placeholder={SCENARIO_PLACEHOLDER}
        className="wr-field onDark"
        style={{ minHeight: 150 }}
      />
      <div className="flex justify-between mt-1.5 text-[11px] text-white/55">
        <span>
          {context.length < 50
            ? `Minimum 50 characters required (${50 - context.length} more)`
            : `${context.length} characters`}
        </span>
        {uploadedDocText && (
          <span>
            {uploadedDocText.split(/\s+/).length.toLocaleString()} words from your document
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2.5 mt-3">
        {/* Document */}
        {!uploadedDocText ? (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 min-w-[220px] flex items-center gap-2.5 border border-dashed border-white/25 rounded-xl px-3 py-2.5 text-xs text-white/75 cursor-pointer hover:border-white/50 hover:bg-white/5 transition-colors"
            role="button"
            tabIndex={0}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={handleFileSelect}
              className="hidden"
            />
            <WrIcon name="doc" />
            {uploading
              ? 'Extracting document text…'
              : 'Attach a document (optional) — PDF, DOCX or TXT'}
          </div>
        ) : (
          <div className="flex-1 min-w-[220px] flex items-center gap-2.5 border border-amber-400/50 bg-amber-400/10 rounded-xl px-3 py-2.5 text-xs text-white">
            <WrIcon name="doc" className="text-amber-300" />
            <span className="font-bold truncate">{uploadedDocName}</span>
            <span className="text-white/55 truncate">
              · {uploadedDocText.slice(0, 60)}
              {uploadedDocText.length > 60 && '…'}
            </span>
            <button
              onClick={() => {
                setUploadedDocText('');
                setUploadedDocName('');
                setUploadError(null);
              }}
              className="ml-auto text-white/60 hover:text-white"
              aria-label="Remove document"
              title="Remove document"
            >
              <WrIcon name="x" />
            </button>
          </div>
        )}
        {/* Brand logo */}
        <label
          className={`flex items-center gap-2.5 border rounded-xl px-3 py-2.5 text-xs cursor-pointer transition-colors ${
            brandLogoUrl
              ? 'border-white/30 bg-white/5 text-white'
              : 'border-dashed border-white/25 text-white/75 hover:border-white/50 hover:bg-white/5'
          }`}
        >
          {brandLogoUrl ? (
            <img
              src={brandLogoUrl}
              alt="Brand logo"
              className="w-6 h-6 rounded-md object-cover bg-white"
            />
          ) : (
            <WrIcon name="image" />
          )}
          {uploadingLogo ? 'Uploading…' : brandLogoUrl ? 'Change logo' : 'Brand logo (optional)'}
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
            className="text-[11px] text-white/60 hover:text-white"
          >
            Remove logo
          </button>
        )}
      </div>
      {uploadError && <div className="mt-2 text-[11px] text-red-300">{uploadError}</div>}
    </div>
  );

  /** Hero right column for Setup: the crisis footprint radar. */
  const renderFootprintRadar = () => (
    <aside className="wr-radar wr-glass">
      <h3>
        <span className={footprintLoading ? 'wr-livedot' : ''} style={{ color: '#F59E0B' }}>
          {!footprintLoading && <WrIcon name="radar" size={14} />}
        </span>
        Detected footprint
        {footprint && (
          <span className="ml-auto text-[10px] font-semibold text-white/45 tracking-normal normal-case">
            {footprint.countries.length} countr{footprint.countries.length === 1 ? 'y' : 'ies'}
          </span>
        )}
      </h3>
      {!footprint ? (
        <>
          <p className="copy">
            The War Room reads your description for the countries involved, offices the story
            implies (a factory&apos;s operating company, a regional hub) and the bodies that will
            apply pressure — regulators, unions, NGOs, community groups. Proposals land on the map
            pre-ticked; remove what does not belong. It also runs once automatically when you
            continue.
          </p>
          <div className="foot">
            {footprintNotice && <span className="text-amber-300">{footprintNotice}</span>}
            <button
              type="button"
              onClick={() => void detectFootprint()}
              disabled={footprintLoading}
              className="wr-btn sm onDark ml-auto"
            >
              {footprintLoading ? (
                'Reading your description…'
              ) : (
                <>
                  <WrIcon name="radar" /> Detect countries, offices &amp; pressure groups
                </>
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          <h5>Countries</h5>
          <div className="wr-rchips">
            {footprint.countries.length === 0 && (
              <span className="text-xs text-white/50">Only {country}.</span>
            )}
            {footprint.countries.map((c) => (
              <span key={c.name} className="wr-rc" title={c.reason}>
                <span className="wr-cc dark">{countryCode(c.name)}</span> {c.name}{' '}
                <small>{c.role.replace(/_/g, ' ')}</small>
              </span>
            ))}
          </div>
          <h5>Signals</h5>
          <div className="wr-rchips">
            <span className={`wr-rc ${footprint.labour_signal ? 'on' : 'off'}`}>
              {footprint.labour_signal && <WrIcon name="check" size={12} className="tick" />} Labour
              dispute
            </span>
            <span className={`wr-rc ${footprint.product_safety_signal ? 'on' : 'off'}`}>
              {footprint.product_safety_signal && (
                <WrIcon name="check" size={12} className="tick" />
              )}{' '}
              Product safety
            </span>
          </div>
          {(footprint.implied_organisations.length > 0 ||
            footprint.pressure_organisations.length > 0) && (
            <>
              <h5>Proposed — placed on the map</h5>
              <div className="wr-rchips">
                {footprint.implied_organisations.map((o) => {
                  const on = hasOrgProposal(o.display_name);
                  return (
                    <button
                      type="button"
                      key={`o-${o.display_name}`}
                      className={`wr-rc act ${on ? 'on' : 'off'}`}
                      title={`${o.reason}${on ? ' — click to remove' : ' — click to add back'}`}
                      onClick={() => toggleOrgProposal(o)}
                    >
                      {on && <WrIcon name="check" size={12} className="tick" />} {o.display_name}{' '}
                      <small>AI {ORG_KIND_LABELS[o.kind]?.toLowerCase() ?? 'office'}</small>
                    </button>
                  );
                })}
                {footprint.pressure_organisations.map((p) => {
                  const on = hasPressureProposal(p.display_name);
                  return (
                    <button
                      type="button"
                      key={`p-${p.display_name}`}
                      className={`wr-rc act ${on ? 'on' : 'off'}`}
                      title={`${p.reason}${on ? ' — click to remove' : ' — click to add back'}`}
                      onClick={() => togglePressureProposal(p)}
                    >
                      {on && <WrIcon name="check" size={12} className="tick" />} {p.display_name}{' '}
                      <small>{PRESSURE_KIND_LABEL[p.kind]?.toLowerCase() ?? p.kind}</small>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className="foot">
            <span className="min-w-0">
              {footprintNotice ??
                (footprint.countries.some(
                  (c) =>
                    c.name !== country && !extraOrganisations.some((o) => o.country === c.name),
                )
                  ? 'A country in the story has no organisation of its own — its content will be visible to everyone as spillover.'
                  : '')}
            </span>
            <button
              type="button"
              onClick={() => void detectFootprint()}
              disabled={footprintLoading}
              className="wr-btn sm onDark ml-auto"
            >
              <WrIcon name="refresh" /> {footprintLoading ? 'Reading…' : 'Re-detect'}
            </button>
          </div>
        </>
      )}
    </aside>
  );

  /* ── Step 1: Scenario Setup — the map (three lanes) ─────────────────── */

  const renderStep1 = () => (
    <div>
      {/* Lane 1 — Organisations */}
      <div className="wr-lane" style={{ paddingTop: 0, '--g': 'var(--f-org)' } as CSSProperties}>
        <div className="wr-lanehead">
          <div className="wr-vignette">
            <img src={SHELL_ART.laneOrgs} alt="" />
            <div className="cap">Your side</div>
          </div>
          <div className="inner">
            <h2>
              <WrIcon name="building" /> Organisations
            </h2>
            <p>HQ and every office or partner agency responding with you.</p>
            <span className="cnt">
              {orgCount} of 6 · {teamCount} teams
            </span>
            <button
              onClick={() =>
                extraOrganisations.length + 1 < 6 &&
                setExtraOrganisations((prev) => [...prev, newOrganisationDraft(country)])
              }
              disabled={extraOrganisations.length + 1 >= 6}
              className="wr-btn mt-2.5 w-full"
            >
              <WrIcon name="plus" /> Add organisation
            </button>
          </div>
        </div>
        <div>
          <div className="space-y-3.5">
            {/* HQ node */}
            <div className="wr-node hq" style={{ '--g': 'var(--f-org)' } as CSSProperties}>
              <div className="kicker">
                <WrIcon name="building" size={12} /> Headquarters · players
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 mb-3">
                <div className="sm:col-span-6">
                  <label className="wr-lbl">
                    Organisation name {extraOrganisations.length === 0 ? '(optional)' : ''}
                  </label>
                  <input
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="e.g., Meridian Technologies, Acme Corp"
                    className="wr-field"
                  />
                  <div className="wr-help">
                    {extraOrganisations.length === 0
                      ? 'Leave blank to let the AI generate a company name.'
                      : 'Required when several organisations take part — it names the primary one.'}
                  </div>
                </div>
                <div className="sm:col-span-3">
                  <label className="wr-lbl">Country (headquarters)</label>
                  <CountrySelect value={country} onChange={setCountry} className="wr-field" />
                </div>
                <div className="sm:col-span-2">
                  <label className="wr-lbl">City (optional)</label>
                  <input
                    type="text"
                    value={primaryCity}
                    onChange={(e) => setPrimaryCity(e.target.value)}
                    placeholder="e.g. Singapore"
                    className="wr-field"
                  />
                </div>
                <div className="sm:col-span-1">
                  <label className="wr-lbl">Type</label>
                  <select
                    value={primaryKind}
                    onChange={(e) => setPrimaryKind(e.target.value as OrgKind)}
                    className="wr-field"
                  >
                    {(Object.keys(ORG_KIND_LABELS) as OrgKind[]).map((k) => (
                      <option key={k} value={k}>
                        {ORG_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Response teams at the primary organisation: presets + the trainer's own divisions */}
              <div className="border-t border-dashed border-border pt-3">
                <label className="wr-lbl">
                  Response teams
                  {extraOrganisations.length > 0
                    ? ` — ${orgName.trim() || 'primary organisation'}`
                    : ''}{' '}
                  ({teamRoster.length}/6)
                </label>
                <p className="text-[11.5px] text-muted mb-2.5">
                  Every company divides differently — pick from the preset teams and/or add your own
                  divisions. Each team&apos;s name and description shape its storyline pressure,
                  injects, stakeholder contacts, and scoring. Mark exactly one team as the{' '}
                  <b>public voice</b>. Add <b>Executive</b> when real leadership joins as players:
                  their decisions trigger SOP obligations and stakeholder reactions.
                </p>
                <RosterBuilder
                  roster={teamRoster}
                  onChange={setTeamRoster}
                  presetCatalog={presetCatalog}
                />
              </div>
            </div>

            {/* Additional organisations: each in its own country with its own team roster */}
            {extraOrganisations.map((org, i) => (
              <div
                key={org.id}
                className={`wr-node ${org.operation === 'ai' ? 'ai' : ''}`}
                style={
                  {
                    '--g': org.operation === 'ai' ? 'var(--f-ai)' : 'var(--f-org)',
                  } as CSSProperties
                }
              >
                <div className="kicker">
                  <WrIcon name={org.operation === 'ai' ? 'sparkle' : 'office'} size={12} />{' '}
                  {org.operation === 'ai' ? 'Office · AI-operated' : 'Office · players'}
                </div>
                <OrganisationCard
                  org={org}
                  index={i}
                  presetCatalog={presetCatalog}
                  onChange={(next) =>
                    setExtraOrganisations((prev) => prev.map((o) => (o.id === org.id ? next : o)))
                  }
                  onRemove={() =>
                    setExtraOrganisations((prev) => prev.filter((o) => o.id !== org.id))
                  }
                />
              </div>
            ))}

            {extraOrganisations.length + 1 < 6 && (
              <button
                type="button"
                className="wr-add"
                style={{ '--g': 'var(--f-org)', minHeight: 84 } as CSSProperties}
                onClick={() =>
                  setExtraOrganisations((prev) => [...prev, newOrganisationDraft(country)])
                }
              >
                <div className="flex items-center gap-3 text-left">
                  <WrIcon name="office" size={24} />
                  <div>
                    <div>Add an office, subsidiary or partner agency</div>
                    <small className="mt-0.5">
                      Own page, teams and contacts in its own country
                    </small>
                  </div>
                </div>
              </button>
            )}
          </div>
          {rosterError && <div className="mt-2 text-xs text-warning">{rosterError}</div>}
        </div>
      </div>

      {/* Lane 2 — Pressure groups */}
      <div className="wr-lane" style={{ '--g': 'var(--f-pressure)' } as CSSProperties}>
        <div className="wr-lanehead">
          <div className="wr-vignette">
            <img src={SHELL_ART.lanePressure} alt="" />
            <div className="cap">Pressure</div>
          </div>
          <div className="inner">
            <h2>
              <WrIcon name="fist" /> Pressure groups
            </h2>
            <p>
              Regulators, unions, NGOs, communities, politicians. One spokesperson each — engage
              them and they stand down, ignore them and they escalate.
            </p>
            <span className="cnt">{pressureOrgs.length} of 6</span>
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {(
                ['regulator', 'union', 'ngo', 'community_group', 'political'] as PressureKind[]
              ).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={pressureOrgs.length >= 6}
                  onClick={() =>
                    setPressureOrgs((prev) => [...prev, newPressureOrgDraft(country, k)])
                  }
                  className="wr-btn sm icon"
                  title={`Add ${PRESSURE_KIND_LABEL[k]}`}
                  aria-label={`Add ${PRESSURE_KIND_LABEL[k]}`}
                >
                  <WrIcon name={PRESSURE_KIND_ICON[k]} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="wr-cards">
            {pressureOrgs.map((p) => (
              <div
                key={p.id}
                className="wr-node"
                style={{ '--g': 'var(--f-pressure)' } as CSSProperties}
              >
                <div className="kicker">
                  <WrIcon name={PRESSURE_KIND_ICON[p.kind] ?? 'landmark'} size={12} />{' '}
                  {PRESSURE_KIND_LABEL[p.kind] ?? p.kind} · {p.register}
                </div>
                <PressureOrgCard
                  org={p}
                  onChange={(next) =>
                    setPressureOrgs((prev) => prev.map((x) => (x.id === p.id ? next : x)))
                  }
                  onRemove={() => setPressureOrgs((prev) => prev.filter((x) => x.id !== p.id))}
                />
              </div>
            ))}
            {pressureOrgs.length < 6 && (
              <button
                type="button"
                className="wr-add"
                style={{ '--g': 'var(--f-pressure)' } as CSSProperties}
                onClick={() =>
                  setPressureOrgs((prev) => [...prev, newPressureOrgDraft(country, 'regulator')])
                }
              >
                <div>
                  <WrIcon name="plus" size={24} />
                  <div className="mt-2">Pressure group</div>
                  <small>
                    {footprint
                      ? 'Or accept a proposal from the radar'
                      : 'Or let the radar propose them from your description'}
                  </small>
                </div>
              </button>
            )}
          </div>
          {pressureValidation && (
            <div className="mt-2 text-xs text-warning">{pressureValidation}</div>
          )}
        </div>
      </div>

      {/* Lane 3 — Rival pages */}
      <div className="wr-lane" style={{ '--g': 'var(--f-rival)' } as CSSProperties}>
        <div className="wr-lanehead">
          <div className="wr-vignette">
            <img src={SHELL_ART.laneRivals} alt="" />
            <div className="cap">Rivals</div>
          </div>
          <div className="inner">
            <h2>
              <WrIcon name="swords" /> Rival pages
            </h2>
            <p>Competitor pages the AI drives against you, each in its own country.</p>
            <span className="cnt">
              {competitorEntries.length} named
              {autoAntagonist && competitorEntries.length === 0 ? ' · 1 auto' : ''}
            </span>
            <label className="flex items-start gap-2 mt-3 text-[11.5px] text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={autoAntagonist}
                onChange={(e) => setAutoAntagonist(e.target.checked)}
                className="mt-0.5"
              />
              Auto-generate a hostile rival if no competitors are named
            </label>
          </div>
        </div>
        <div>
          <div className="wr-cards">
            {competitorEntries.map((e, i) => (
              <div
                key={`comp-${i}`}
                className="wr-node"
                style={{ '--g': 'var(--f-rival)' } as CSSProperties}
              >
                <div className="absolute top-2.5 right-2.5">
                  <button
                    onClick={() => removeCompetitor(i)}
                    className="wr-btn sm ghost icon"
                    aria-label={`Remove ${e.name}`}
                    title="Remove"
                  >
                    <WrIcon name="x" />
                  </button>
                </div>
                <div className="kicker">
                  <WrIcon name="swords" size={12} /> Competitor
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="wr-mono rv" style={{ width: 40, height: 40, fontSize: 13 }}>
                    {initialsOf(e.name)}
                  </div>
                  <div className="min-w-0">
                    <div className="font-extrabold text-ink truncate">{e.name}</div>
                    <div className="text-xs text-muted flex items-center gap-1.5 flex-wrap">
                      <span className="wr-cc light">{countryCode(e.country)}</span> {e.country}
                      {e.facebook_handle && <span>· {e.facebook_handle}</span>}
                      {e.x_handle && <span>· {e.x_handle}</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {competitorEntries.length === 0 && autoAntagonist && (
              <div
                className="wr-node"
                style={{ '--g': 'var(--f-rival)', borderStyle: 'dashed' } as CSSProperties}
              >
                <div className="kicker">
                  <WrIcon name="sparkle" size={12} /> Auto-generated rival
                </div>
                <div className="text-xs text-muted">
                  A hostile competitor page will be invented from the story. Name real rivals here
                  to stack the pressure (up to 10).
                </div>
              </div>
            )}
            {/* Add competitor form */}
            <div
              className="wr-node"
              style={
                {
                  '--g': 'var(--f-rival)',
                  borderStyle: 'dashed',
                  background: 'rgba(255,255,255,.75)',
                } as CSSProperties
              }
            >
              <div className="kicker">
                <WrIcon name="plus" size={12} /> Rival page
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={newPageName}
                  onChange={(e) => setNewPageName(e.target.value)}
                  placeholder="Competitor name"
                  className="wr-field col-span-2"
                />
                <CountrySelect
                  value={newPageCountry || country}
                  onChange={setNewPageCountry}
                  className="wr-field col-span-2"
                />
                <input
                  value={newPageFbHandle}
                  onChange={(e) => setNewPageFbHandle(e.target.value)}
                  placeholder="@FakebookHandle"
                  className="wr-field"
                />
                <input
                  value={newPageXHandle}
                  onChange={(e) => setNewPageXHandle(e.target.value)}
                  placeholder="@ZHandle"
                  className="wr-field"
                />
              </div>
              <button
                onClick={addCompetitor}
                disabled={!newPageName.trim()}
                className="wr-btn danger mt-2.5 w-full"
              >
                <WrIcon name="plus" /> Add competitor
              </button>
            </div>
          </div>
        </div>
      </div>
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
              <div className="wr-node p-3">
                <div className="text-muted uppercase mb-1">Framework</div>
                <div className="text-ink">
                  {blueprint.detected_framework_kind || 'unstructured'}
                </div>
              </div>
              <div className="wr-node p-3">
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
            <div className="wr-node p-3 text-xs terminal-text space-y-4">
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

            <div className="wr-node p-3 text-xs terminal-text">
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
              <div className="wr-node p-3">
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
              <div className="wr-node p-3">
                <div className="text-muted uppercase mb-1">
                  Narrative mutations ({blueprint.narrative_mutations?.length ?? 0})
                </div>
                <div className="text-ink">
                  {(blueprint.narrative_mutations ?? []).slice(0, 4).join(', ') || 'AI-generated'}
                </div>
              </div>
            </div>

            {blueprint.unmapped_directives && blueprint.unmapped_directives.length > 0 && (
              <div className="wr-node p-3 text-xs terminal-text">
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
      {!scenarioId && !compiling && (
        <div className="space-y-6">
          <p className="text-xs terminal-text text-muted mb-4">
            Review everything the War Room produced, then compile to persist. After compiling, you
            can still edit all of it — injects, NPCs, fact sheet, org pages, charters — from the
            scenario's detail page.
          </p>

          <div className="border border-border rounded p-4 mb-4">
            <h3 className="text-xs terminal-text text-muted uppercase mb-4">Scenario Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs terminal-text">
              <div className="border border-border rounded p-3 text-center col-span-2 sm:col-span-3">
                <div className="text-[10px] text-muted uppercase">Crisis Scenario</div>
                <div className="text-ink text-xs mt-1 line-clamp-2">{crisisLabel}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">
                  {extraOrganisations.length > 0 ? 'Countries' : 'Country'}
                </div>
                <div className="text-ink font-bold">
                  {extraOrganisations.length > 0
                    ? Array.from(
                        new Set([country, ...extraOrganisations.map((o) => o.country)]),
                      ).join(', ')
                    : country}
                </div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Storyline Injects</div>
                <div className="text-ink font-bold text-lg">{storylineInjects.length}</div>
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">NPC Count</div>
                <div className="text-ink font-bold text-lg">{personas.length}</div>
                {Object.keys(perCountryCounts).length > 1 && (
                  <div className="text-[9px] text-muted mt-0.5">
                    {Object.entries(perCountryCounts)
                      .map(([c, n]) => `${c}: ${n}`)
                      .join(' · ')}
                  </div>
                )}
              </div>
              <div className="border border-border rounded p-3 text-center">
                <div className="text-[10px] text-muted uppercase">Stakeholders</div>
                <div className="text-ink font-bold text-lg">{stakeholders.length}</div>
                {stakeholders.length > 0 && (
                  <div className="text-[9px] text-muted mt-0.5">
                    {stakeholders.filter((s) => s.grievance).length} with a live concern ·{' '}
                    {stakeholderInjects.filter((i) => i.trigger_time_minutes != null).length}{' '}
                    scheduled
                  </div>
                )}
              </div>
              {sopSteps.length > 0 && (
                <div className="border border-border rounded p-3 text-center">
                  <div className="text-[10px] text-muted uppercase">Notification SOP steps</div>
                  <div className="text-ink font-bold text-lg">{sopSteps.length}</div>
                  <div className="text-[9px] text-muted mt-0.5">
                    graded when leadership decisions are communicated
                  </div>
                </div>
              )}
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

          {(pressureOrgs.length > 0 || extraOrganisations.some((o) => o.operation === 'ai')) && (
            <div className="border border-warning/30 rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-muted uppercase mb-2">
                Pressure &amp; AI-operated organisations
              </h3>
              <div className="space-y-1.5">
                {extraOrganisations
                  .filter((o) => o.operation === 'ai')
                  .map((o) => (
                    <div key={o.id} className="text-[10px] terminal-text text-muted">
                      <span className="text-ink font-bold">{o.display_name}</span> · {o.country} ·{' '}
                      <span className="text-accent">operated by AI</span> — its page follows
                      headquarters&apos; line; its site leader, HR counterpart and staff answer your
                      teams as characters.
                    </div>
                  ))}
                {pressureOrgs.map((p) => {
                  const sp = p.spokesperson_stakeholder_id
                    ? stakeholders.find((s) => s.id === p.spokesperson_stakeholder_id)
                    : undefined;
                  const statements = stakeholderInjects.filter(
                    (i) =>
                      (i.delivery_config as Record<string, unknown> | undefined)?.page_org_key ===
                      p.org_key,
                  ).length;
                  return (
                    <div key={p.id} className="text-[10px] terminal-text text-muted">
                      <span className="text-ink font-bold">{p.display_name}</span> · {p.country} ·{' '}
                      <span className="text-warning">{p.kind.replace('_', ' ')}</span> ·{' '}
                      {p.register} register
                      {sp ? ` · spokesperson ${sp.name} (${sp.title})` : ''}
                      {statements > 0 ? ` · ${statements} scheduled statements` : ''}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {teamCharters.length > 0 &&
            (() => {
              // Group teams by organisation (single-org scenarios: one unnamed group).
              const groups = new Map<string, TeamCharterWire[]>();
              for (const t of teamCharters) {
                const k = t.org_key ?? '__single';
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k)!.push(t);
              }
              const registryByKey = new Map(orgRegistry.map((o) => [o.org_key, o]));
              const orgLabel = (k: string, sample: TeamCharterWire) => {
                if (k === '__single') return null;
                const reg = registryByKey.get(k);
                const name = reg?.display_name || sample.short_name || k;
                const place = reg?.country || sample.country;
                return `${name}${place ? ` · ${place}` : ''}`;
              };
              const teamCard = (team: TeamCharterWire) => {
                const contacts = stakeholders.filter(
                  (s) =>
                    (s.owning_team === (team.function_key || team.team_name) ||
                      s.owning_team === team.team_name) &&
                    (s.org_key === null || team.org_key == null || s.org_key === team.org_key),
                );
                return (
                  <div key={team.team_name} className="border border-border rounded p-3">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-xs terminal-text text-ink font-bold truncate">
                        {team.team_name}
                      </span>
                      <span className="text-[10px] terminal-text text-accent whitespace-nowrap">
                        {(teamStorylines[team.team_name] || []).length} injects
                        {contacts.length > 0 ? ` · ${contacts.length} contacts` : ''}
                      </span>
                    </div>
                    <div className="flex gap-1.5 mb-1">
                      {team.is_custom && (
                        <span className="text-[9px] terminal-text px-1.5 py-0.5 rounded border border-accent/40 text-accent">
                          Custom
                        </span>
                      )}
                      {team.function_key === 'Executive' && (
                        <span className="text-[9px] terminal-text px-1.5 py-0.5 rounded border border-warning/40 text-warning">
                          Leadership
                        </span>
                      )}
                      {team.can_post_publicly && (
                        <span className="text-[9px] terminal-text px-1.5 py-0.5 rounded border border-success/40 text-success">
                          Public voice
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] terminal-text text-muted leading-relaxed line-clamp-2">
                      {team.mission}
                    </div>
                  </div>
                );
              };
              return (
                <div className="border border-border rounded p-4 mb-4">
                  <h3 className="text-xs terminal-text text-muted uppercase mb-3">
                    Response teams ({teamCharters.length}
                    {groups.size > 1 ? ` across ${groups.size} organisations` : ''})
                  </h3>
                  {Array.from(groups.entries()).map(([k, teams]) => {
                    const label = orgLabel(k, teams[0]);
                    return (
                      <div key={k} className={groups.size > 1 ? 'mb-4' : ''}>
                        {label && (
                          <div className="text-[10px] terminal-text text-accent uppercase mb-2">
                            {label}
                          </div>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {teams.map(teamCard)}
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[9px] terminal-text text-muted mt-3">
                    Players are assigned to these teams in the session lobby. Each team has its own
                    storyline pressure, stakeholder contacts, tasks, and scoring rubric — all
                    editable after compile from the scenario&apos;s detail page.
                  </p>
                </div>
              );
            })()}

          {sopSteps.length > 0 && (
            <div className="border border-border rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-muted uppercase mb-3">
                Notification &amp; consultation SOP ({sopSteps.length} steps)
              </h3>
              <p className="text-[10px] terminal-text text-muted mb-3">
                Leadership decides by communicating — an email, a chat line, a call. When the
                simulation detects a decision, these steps are what the HR / people-facing teams are
                graded against: who they told, in what order, how quickly, and how humanely.
              </p>
              <ul className="space-y-1">
                {sopSteps.map((s) => (
                  <li key={s.step_id} className="text-[10px] terminal-text text-muted">
                    <span className="text-ink font-bold">{s.name}</span> — {s.description} (
                    {s.time_limit_minutes} min)
                  </li>
                ))}
              </ul>
            </div>
          )}

          {narrative && (
            <div className="border border-border rounded p-4 mb-4">
              <h3 className="text-xs terminal-text text-muted uppercase mb-2">Narrative</h3>
              <div className="text-sm terminal-text text-accent font-bold mb-1">
                {narrative.title}
              </div>
              <div className="text-[10px] terminal-text text-muted leading-relaxed whitespace-pre-wrap">
                {narrative.description}
              </div>
              {narrative.briefing && (
                <>
                  <h4 className="text-[10px] terminal-text text-muted uppercase mt-3 mb-1">
                    Participant briefing
                  </h4>
                  <div className="text-[10px] terminal-text text-muted leading-relaxed whitespace-pre-wrap">
                    {narrative.briefing}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Full read-through of everything the warroom generated */}
          {(() => {
            const reviewInjects = [
              ...storylineInjects,
              ...Object.values(teamStorylines).flat(),
              ...sharedInjects,
            ];
            const timedInjects = reviewInjects
              .filter((inj) => inj.trigger_time_minutes != null)
              .sort((a, b) => (a.trigger_time_minutes || 0) - (b.trigger_time_minutes || 0));
            const conditionalInjects = reviewInjects.filter(
              (inj) => inj.trigger_time_minutes == null,
            );
            const detailsCls = 'border border-border rounded mb-3';
            const summaryCls =
              'text-xs terminal-text text-ink font-bold uppercase px-4 py-3 cursor-pointer select-none hover:bg-surface-2';

            return (
              <div>
                <details className={detailsCls}>
                  <summary className={summaryCls}>
                    Inject timeline ({timedInjects.length} timed
                    {conditionalInjects.length > 0
                      ? ` + ${conditionalInjects.length} conditional`
                      : ''}
                    )
                  </summary>
                  <div className="px-4 pb-4 space-y-2 max-h-[420px] overflow-y-auto">
                    {timedInjects.map((inj, i) => {
                      const dc = (inj.delivery_config || {}) as Record<string, unknown>;
                      const app = dc.app ? String(dc.app) : inj.type;
                      return (
                        <div key={i} className="border border-border rounded p-2.5">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-[10px] terminal-text text-accent font-mono">
                              T+{inj.trigger_time_minutes}m
                            </span>
                            <span className="text-[10px] terminal-text px-1.5 py-0.5 bg-surface-2 text-muted rounded">
                              {app.replace(/_/g, ' ')}
                            </span>
                            {!!dc.author_handle && (
                              <span className="text-[10px] terminal-text text-muted">
                                {String(dc.author_handle)}
                              </span>
                            )}
                            {inj.severity === 'critical' && (
                              <span className="text-[10px] terminal-text text-danger">
                                critical
                              </span>
                            )}
                            {inj.target_teams?.length > 0 && (
                              <span className="text-[10px] terminal-text text-muted">
                                → {inj.target_teams.join(', ')}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] terminal-text text-ink">{inj.title}</div>
                          <div className="text-[10px] terminal-text text-muted mt-0.5 whitespace-pre-wrap">
                            {inj.content}
                          </div>
                        </div>
                      );
                    })}
                    {conditionalInjects.length > 0 && (
                      <div className="text-[10px] terminal-text text-muted pt-1">
                        + {conditionalInjects.length} condition-triggered inject(s) that fire on
                        participant behaviour rather than the clock.
                      </div>
                    )}
                  </div>
                </details>

                {stakeholders.length > 0 && (
                  <details className={detailsCls}>
                    <summary className={summaryCls}>
                      Stakeholder contacts ({stakeholders.length})
                    </summary>
                    <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {stakeholders.map((s) => (
                        <div key={s.id} className="border border-border rounded p-2.5">
                          <div className="text-[11px] terminal-text text-ink font-bold">
                            {s.name}{' '}
                            <span className="text-muted font-normal">
                              — {s.title}, {s.organisation}
                            </span>
                          </div>
                          <div className="text-[10px] terminal-text text-muted mt-0.5">
                            {s.relationship} · owned by {s.owning_team}
                            {s.org_key ? ` @ ${s.org_key}` : ' (all organisations)'} · {s.email}
                          </div>
                          <div className="text-[10px] terminal-text text-muted mt-1">{s.note}</div>
                          {s.grievance && (
                            <div className="text-[10px] terminal-text text-warning mt-1">
                              hidden concern: {s.grievance}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <details className={detailsCls}>
                  <summary className={summaryCls}>NPC personas ({personas.length})</summary>
                  <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {personas.map((npc, i) => (
                      <div key={i} className="border border-border rounded p-2.5">
                        <div className="text-[11px] terminal-text text-ink font-bold">
                          {npc.name} <span className="text-muted font-normal">{npc.handle}</span>
                        </div>
                        <div className="text-[10px] terminal-text text-muted mt-1">
                          {npc.personality}
                        </div>
                        {npc.bias && npc.bias !== 'none' && (
                          <div className="text-[10px] terminal-text text-accent mt-1">
                            bias: {npc.bias}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </details>

                {factSheet && (
                  <details className={detailsCls}>
                    <summary className={summaryCls}>
                      Fact sheet ({factSheet.confirmed_facts.length} facts,{' '}
                      {factSheet.unconfirmed_claims.length} claims)
                    </summary>
                    <div className="px-4 pb-4">
                      <div className="text-[10px] terminal-text text-success uppercase mb-1">
                        Confirmed facts
                      </div>
                      {factSheet.confirmed_facts.map((f, i) => (
                        <div key={i} className="text-[10px] terminal-text text-muted mb-1">
                          + {f}
                        </div>
                      ))}
                      {factSheet.unconfirmed_claims.length > 0 && (
                        <>
                          <div className="text-[10px] terminal-text text-danger uppercase mt-3 mb-1">
                            False / unverified claims
                          </div>
                          {factSheet.unconfirmed_claims.map((c, i) => (
                            <div key={i} className="text-[10px] terminal-text text-muted mb-1.5">
                              <span className="text-danger">[{c.status}]</span> {c.claim}
                              <div className="text-muted ml-4">Truth: {c.truth}</div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </details>
                )}

                {objectives.length > 0 && (
                  <details className={detailsCls}>
                    <summary className={summaryCls}>Objectives ({objectives.length})</summary>
                    <div className="px-4 pb-4 space-y-1.5">
                      {objectives.map((o, i) => (
                        <div key={i} className="text-[10px] terminal-text text-muted">
                          <span className="text-ink font-bold">{o.objective_name}</span>{' '}
                          <span className="text-accent">({o.weight}%)</span> — {o.description}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {convergenceGates.length > 0 && (
                  <details className={detailsCls}>
                    <summary className={summaryCls}>
                      Convergence gates ({convergenceGates.length})
                    </summary>
                    <div className="px-4 pb-4 space-y-2">
                      {convergenceGates.map((g, i) => (
                        <div key={i} className="border border-border rounded p-2.5">
                          <div className="text-[11px] terminal-text text-ink">{g.title}</div>
                          <div className="text-[10px] terminal-text text-muted mt-0.5">
                            {g.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {orgPage && (
                  <details className={detailsCls}>
                    <summary className={summaryCls}>Organisation pages</summary>
                    <div className="px-4 pb-4 space-y-2">
                      {(() => {
                        const orgs = (orgPage.orgs as Array<Record<string, unknown>>) || [
                          { display_name: orgName || 'Primary org', ...orgPage },
                        ];
                        return orgs.map((org, i) => {
                          const fb = (org.facebook || {}) as Record<string, unknown>;
                          const x = (org.x_twitter || {}) as Record<string, unknown>;
                          return (
                            <div key={i} className="border border-border rounded p-2.5">
                              <div className="text-[11px] terminal-text text-ink font-bold">
                                {String(org.display_name || fb.page_name || '')}
                                {org.role === 'antagonist' && (
                                  <span className="text-danger font-normal"> · antagonist</span>
                                )}
                              </div>
                              <div className="text-[10px] terminal-text text-muted mt-0.5">
                                Fakebook: {String(fb.page_name || '—')} (
                                {String(fb.page_handle || '—')}){' · '}X:{' '}
                                {String(x.page_name || '—')} ({String(x.page_handle || '—')})
                              </div>
                              {!!fb.page_bio && (
                                <div className="text-[10px] terminal-text text-muted mt-0.5">
                                  {String(fb.page_bio)}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </details>
                )}
              </div>
            );
          })()}

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

  if (scenarioCredits === 0 && !isAdminUser) {
    return (
      <div className="min-h-screen scanline flex items-center justify-center p-6">
        <div className="bg-surface border border-border rounded-xl shadow-sm p-8 text-center max-w-md">
          <div className="text-3xl mb-3">🔒</div>
          <h1 className="text-lg font-extrabold text-brand mb-2">
            Scenario generation requires a paid engagement
          </h1>
          <p className="text-sm text-muted mb-6">
            You have <b>0 scenario credits</b>. Invoice a client from the Clients page — when they
            pay, the War Room unlocks automatically with 1 scenario credit and 2 session credits.
          </p>
          <button
            onClick={() => navigate('/clients')}
            className="military-button px-6 py-2.5 text-sm"
          >
            Go to Clients &amp; billing
          </button>
        </div>
      </div>
    );
  }

  const heroArtByStep: Record<number, string> = {
    1: SHELL_ART.wizardSetup,
    2: SHELL_ART.wizardBuild,
    3: SHELL_ART.wizardReview,
    7: SHELL_ART.wizardReview,
  };
  const stepHeadline: Record<number, { title: string; lead: string }> = {
    2: {
      title: 'Building your scenario',
      lead: 'Characters, storyline, convergence and brand pages are being generated. This takes a few minutes; you will advance to review automatically.',
    },
    3: {
      title: 'Blueprint review',
      lead: 'What the War Room read from your document. Items marked "drives generation" shape the build — edit them before continuing.',
    },
    7: {
      title: 'Review & compile',
      lead: 'Read what was generated before it becomes a scenario. Everything remains editable afterwards from the library, until a session is live.',
    },
  };

  return (
    <div className="min-h-screen bg-bg">
      <header className="wr-artband wr-hero">
        <img className="wr-art" src={heroArtByStep[step] ?? SHELL_ART.wizardSetup} alt="" />
        <div className="wr-hero-top">
          <button
            type="button"
            className="wr-brandmark"
            onClick={() => navigate('/warroom')}
            title="Back to the War Room"
          >
            <BrandMark className="h-8 w-8" /> War Room{' '}
            <span className="sub">· Corporate crisis</span>
          </button>
          <div className="wr-steps" aria-label="Steps">
            {VISIBLE_STEPS.map((s, i) => {
              const isCurrent = s === step;
              const isPast = currentStepIndex > i;
              return (
                <span key={s} className={isCurrent ? 'on' : isPast ? 'done' : ''}>
                  <i>{isPast ? <WrIcon name="check" size={11} /> : i + 1}</i>
                  <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
                </span>
              );
            })}
          </div>
          <div className="wr-credits">
            <span>
              <WrIcon name="save" /> Draft <b>{wizardDraftId ? 'saved' : 'not yet saved'}</b>
            </span>
          </div>
        </div>

        <div className="wr-hero-grid">
          {step === 1 ? (
            <>
              {renderSetupBrief()}
              {renderFootprintRadar()}
            </>
          ) : (
            <div>
              <div className="wr-eyebrow">
                Corporate crisis · step {currentStepIndex + 1} of {VISIBLE_STEPS.length}
              </div>
              <h1>{stepHeadline[step]?.title ?? STEP_LABELS[step]}</h1>
              <p className="lead">{stepHeadline[step]?.lead}</p>
            </div>
          )}
        </div>
      </header>

      <main className="wr-wrap">
        <section className="wr-map">
          {step === 1 && renderStep1()}
          {step === 3 && renderBlueprintReview()}
          {step === 2 && renderBuilding()}
          {step === 7 && renderStep7()}
        </section>

        <div className="wr-ctabar sticky">
          {step === 1 && (
            <>
              <div className="s">
                <b>{orgCount}</b>organisation{orgCount === 1 ? '' : 's'}
              </div>
              <div className="s">
                <b>{teamCount}</b>teams
              </div>
              <div className="s">
                <b>{countrySet.size}</b>countr{countrySet.size === 1 ? 'y' : 'ies'}
              </div>
              <div className="s">
                <b>{pressureOrgs.length}</b>pressure
              </div>
              <div className="s">
                <b>{competitorEntries.length || (autoAntagonist ? 1 : 0)}</b>rival
                {competitorEntries.length === 1 ||
                (competitorEntries.length === 0 && autoAntagonist)
                  ? ''
                  : 's'}
              </div>
            </>
          )}
          <span className="grow" />
          <button onClick={goBack} className="wr-btn ghost">
            <WrIcon name="arrow-l" /> {step === 1 ? 'War Room' : 'Back'}
          </button>
          <span className="hint">
            Step <b>{currentStepIndex + 1}</b> of {VISIBLE_STEPS.length}
            {step === 1 && crisisDescription.length < 50 && <> · describe the crisis to continue</>}
            {step === 1 && crisisDescription.length >= 50 && rosterError && <> · {rosterError}</>}
            {step === 1 && crisisDescription.length >= 50 && !rosterError && (
              <> · ready — the build reads everything on this page</>
            )}
          </span>
          {step === 1 && (
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
              <span className="hint">{compiling ? 'Compiling…' : 'Review & compile above'}</span>
            )
          ) : (
            <button
              onClick={goNext}
              disabled={!canProceed || footprintLoading}
              className="wr-btn accent lg"
            >
              {step === 1
                ? footprintLoading
                  ? 'Reading the footprint…'
                  : footprint ||
                      footprintRanFor.current === `${crisisDescription} ${context}`.trim()
                    ? 'Build the scenario'
                    : 'Detect footprint & continue'
                : 'Next'}{' '}
              <WrIcon name="arrow" />
            </button>
          )}
        </div>
      </main>
    </div>
  );
};
