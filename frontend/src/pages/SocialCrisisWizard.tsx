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
import { WrIcon, teamIcon, type WrIconName } from '../components/UI/WarRoomIcon';
import { WrFold, countryCode, initialsOf } from '../components/UI/Collapsible';
import { OriginBadge } from '../components/UI/OriginBadge';
import { SHELL_ART, artFor } from '../lib/scenarioArt';

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
      desc: string;
      icon: WrIconName;
    }> = [
      {
        key: 'characters',
        label: 'Characters & facts',
        desc: 'Stakeholder contacts, crowd personas, the fact sheet',
        icon: 'users',
      },
      {
        key: 'storyline',
        label: 'Storyline',
        desc: 'Per-team pressure, shared injects, timing',
        icon: 'layers',
      },
      {
        key: 'convergence',
        label: 'Convergence',
        desc: 'Gates where the teams’ threads meet',
        icon: 'target',
      },
      {
        key: 'pages',
        label: 'Pages',
        desc: 'Fakebook and Z pages for every organisation',
        icon: 'phone',
      },
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
    const doneCount = stages.filter(
      (s) => buildStage === 'done' || (curIdx > -1 && curIdx > order.indexOf(s.key)),
    ).length;
    return (
      <div>
        <div className="wr-phase" aria-hidden>
          {stages.map((s, i) => (
            <span
              key={s.key}
              style={{
                width: '25%',
                background:
                  i < doneCount
                    ? 'var(--success)'
                    : buildStage === s.key && !buildError
                      ? 'var(--accent)'
                      : buildError === s.key
                        ? 'var(--danger)'
                        : 'var(--surface-2)',
              }}
            />
          ))}
        </div>
        <div className="wr-groups" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {stages.map((s) => {
            const idx = order.indexOf(s.key);
            const isDone = buildStage === 'done' || (curIdx > -1 && curIdx > idx);
            const isRunning = buildStage === s.key && !buildError && loadingByKey[s.key] !== false;
            const isErrored = buildError === s.key;
            const family = isErrored
              ? 'var(--danger)'
              : isDone
                ? 'var(--success)'
                : isRunning
                  ? 'var(--accent)'
                  : 'var(--muted)';
            return (
              <div
                key={s.key}
                className="wr-node"
                style={
                  {
                    '--g': family,
                    opacity: !isDone && !isRunning && !isErrored ? 0.6 : 1,
                  } as CSSProperties
                }
              >
                <div className="kicker">
                  {isErrored ? 'failed' : isDone ? 'done' : isRunning ? 'running' : 'queued'}
                </div>
                <div className="flex items-center gap-2.5">
                  <div
                    className={`wr-tile ${isDone || isRunning || isErrored ? '' : 'soft'}`}
                    style={{ width: 40, height: 40 }}
                  >
                    {isRunning ? (
                      <span className="wr-livedot" style={{ color: '#fff' }} />
                    ) : (
                      <WrIcon name={isDone ? 'check' : isErrored ? 'alert' : s.icon} size={18} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="font-extrabold text-ink">{s.label}</div>
                    <div className="text-xs text-muted">{s.desc}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Live storyline generation log */}
        {buildStage === 'storyline' && step3Progress.length > 0 && (
          <div
            className="mt-4 rounded-2xl p-4 font-mono text-xs space-y-1 max-h-48 overflow-y-auto"
            style={{ background: 'var(--wr-deep)', color: 'rgba(255,255,255,.75)' }}
          >
            {step3Progress.map((msg, i) => (
              <div key={i}>
                <span style={{ color: 'var(--accent)' }}>[{String(i + 1).padStart(2, '0')}]</span>{' '}
                {msg}
              </div>
            ))}
            <div className="animate-pulse">&#9612;</div>
          </div>
        )}

        {buildError ? (
          <div className="wr-empty mt-4" style={{ '--g': 'var(--danger)' } as CSSProperties}>
            <div className="wr-tile">
              <WrIcon name="alert" size={24} />
            </div>
            <div>
              <h4>The {buildError} stage failed</h4>
              <p>
                {errorMsg || 'The generator did not return a result.'} Retry to rebuild the scenario
                from this stage.
              </p>
            </div>
            <button onClick={() => void generateAll()} className="wr-btn accent">
              <WrIcon name="refresh" /> Retry
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <Spinner
              text={`Building scenario — ${doneCount} of ${stages.length} stages complete…`}
            />
          </div>
        )}
      </div>
    );
  };

  /* ── Step 7: Review & Compile ──────────────────────────────────────── */

  const renderStep7 = () => {
    const reviewInjects = [
      ...storylineInjects,
      ...Object.values(teamStorylines).flat(),
      ...sharedInjects,
    ];
    const timedInjects = reviewInjects
      .filter((inj) => inj.trigger_time_minutes != null)
      .sort((a, b) => (a.trigger_time_minutes || 0) - (b.trigger_time_minutes || 0));
    const conditionalInjects = reviewInjects.filter((inj) => inj.trigger_time_minutes == null);
    const countries = Array.from(new Set([country, ...extraOrganisations.map((o) => o.country)]));
    const liveConcerns = stakeholders.filter((s) => s.grievance).length;
    const scheduledStatements = stakeholderInjects.filter(
      (i) => i.trigger_time_minutes != null,
    ).length;
    const registryByKey = new Map(orgRegistry.map((o) => [o.org_key, o]));

    const kpi = (value: string | number, label: string, sub?: string, family = 'var(--brand)') => (
      <div
        className="wr-node text-center"
        style={{ '--g': family, padding: '14px 10px 12px' } as CSSProperties}
      >
        <div
          className="font-extrabold text-ink"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 22, color: family }}
        >
          {value}
        </div>
        <div className="wr-lbl m-0" style={{ marginTop: 2 }}>
          {label}
        </div>
        {sub && <div className="text-[11px] text-muted mt-1 leading-snug">{sub}</div>}
      </div>
    );

    return (
      <div>
        {!scenarioId && !compiling && (
          <div className="space-y-5">
            {/* narrative — the scenario as it will appear in the library */}
            {narrative && (
              <div className="wr-artband rounded-2xl" style={{ padding: '22px 24px' }}>
                <img
                  className="wr-art"
                  src={artFor(
                    {
                      id: wizardDraftId ?? narrative.title,
                      category: 'social_media_crisis',
                      title: narrative.title,
                      description: narrative.description,
                    },
                    'full',
                  )}
                  alt=""
                />
                <div className="wr-eyebrow">
                  <WrIcon name="phone" size={12} /> Corporate crisis · {countries.join(' · ')} · 60
                  minutes
                </div>
                <h2
                  className="text-white font-extrabold mt-2 mb-2"
                  style={{ fontSize: 24, lineHeight: 1.15, letterSpacing: '-.015em' }}
                >
                  {narrative.title}
                </h2>
                <p
                  className="text-sm whitespace-pre-wrap"
                  style={{ color: 'rgba(255,255,255,.75)', maxWidth: 820 }}
                >
                  {narrative.description}
                </p>
                {narrative.briefing && (
                  <details className="mt-3">
                    <summary
                      className="cursor-pointer text-xs font-bold"
                      style={{ color: 'var(--accent)' }}
                    >
                      Participant briefing
                    </summary>
                    <p
                      className="text-xs whitespace-pre-wrap mt-2"
                      style={{ color: 'rgba(255,255,255,.7)', maxWidth: 820 }}
                    >
                      {narrative.briefing}
                    </p>
                  </details>
                )}
              </div>
            )}

            {/* summary tiles */}
            <div>
              <div className="wr-sech" style={{ margin: '0 0 10px' }}>
                <h2>What was generated</h2>
                <p className="truncate" style={{ maxWidth: 640 }}>
                  From: {crisisLabel}
                </p>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {kpi(
                  countries.length,
                  countries.length === 1 ? 'country' : 'countries',
                  countries.join(', '),
                  'var(--f-org)',
                )}
                {kpi(
                  personas.length,
                  'crowd personas',
                  Object.keys(perCountryCounts).length > 1
                    ? Object.entries(perCountryCounts)
                        .map(([c, n]) => `${c} ${n}`)
                        .join(' · ')
                    : undefined,
                  'var(--f-intel)',
                )}
                {kpi(
                  stakeholders.length,
                  'contacts',
                  stakeholders.length > 0
                    ? `${liveConcerns} with a live concern · ${scheduledStatements} scheduled`
                    : undefined,
                  'var(--f-intel)',
                )}
                {kpi(
                  storylineInjects.length + totalTeamInjects + sharedInjects.length,
                  'injects',
                  `${storylineInjects.length} storyline · ${totalTeamInjects} team · ${sharedInjects.length} shared`,
                  'var(--brand)',
                )}
                {kpi(
                  convergenceGates.length,
                  'convergence gates',
                  'where the teams’ threads meet',
                  'var(--f-intel)',
                )}
                {kpi(
                  teamCharters.length,
                  'teams',
                  orgRegistry.length > 1
                    ? `across ${orgRegistry.filter((o) => o.side === 'protagonist').length || orgRegistry.length} organisations`
                    : undefined,
                  'var(--f-org)',
                )}
                {kpi(
                  pressureOrgs.length,
                  'pressure groups',
                  pressureOrgs.length
                    ? pressureOrgs.map((p) => p.kind.replace('_', ' ')).join(' · ')
                    : 'none',
                  'var(--f-pressure)',
                )}
                {kpi(
                  sopSteps.length,
                  'SOP steps',
                  sopSteps.length ? 'graded when leadership decides' : 'no notification SOP',
                  'var(--f-pressure)',
                )}
              </div>
            </div>

            {/* pressure + AI-operated organisations */}
            {(pressureOrgs.length > 0 || extraOrganisations.some((o) => o.operation === 'ai')) && (
              <div>
                <div className="wr-sech" style={{ margin: '0 0 10px' }}>
                  <h2>
                    Run by the AI{' '}
                    <span className="n" style={{ '--g': 'var(--f-pressure)' } as CSSProperties}>
                      {pressureOrgs.length +
                        extraOrganisations.filter((o) => o.operation === 'ai').length}
                    </span>
                  </h2>
                  <p>
                    Pages the simulation drives on its own; their spokespeople answer your teams as
                    characters.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {extraOrganisations
                    .filter((o) => o.operation === 'ai')
                    .map((o) => (
                      <div
                        key={o.id}
                        className="wr-node ai"
                        style={{ '--g': 'var(--f-ai)' } as CSSProperties}
                      >
                        <div className="kicker">
                          <WrIcon name="sparkle" size={12} /> Office · AI-operated
                        </div>
                        <div className="flex items-center gap-2.5">
                          <div
                            className="wr-mono ai"
                            style={{ width: 40, height: 40, fontSize: 13 }}
                          >
                            {initialsOf(o.display_name)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-extrabold text-ink truncate">{o.display_name}</div>
                            <div className="text-xs text-muted flex items-center gap-1.5">
                              <span className="wr-cc">{countryCode(o.country)}</span> {o.country}
                            </div>
                          </div>
                        </div>
                        <div className="text-xs text-muted mt-2.5">
                          Its page follows headquarters’ line; its site leader, HR counterpart and
                          staff answer your teams as characters.
                        </div>
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
                      <div
                        key={p.id}
                        className="wr-node"
                        style={{ '--g': 'var(--f-pressure)' } as CSSProperties}
                      >
                        <div className="kicker">
                          <WrIcon name={PRESSURE_KIND_ICON[p.kind] ?? 'landmark'} size={12} />{' '}
                          {PRESSURE_KIND_LABEL[p.kind] ?? p.kind} · {p.register}
                        </div>
                        <div className="flex items-center gap-2.5">
                          <div className="wr-tile" style={{ width: 40, height: 40 }}>
                            <WrIcon name={PRESSURE_KIND_ICON[p.kind] ?? 'landmark'} size={18} />
                          </div>
                          <div className="min-w-0">
                            <div className="font-extrabold text-ink truncate">{p.display_name}</div>
                            <div className="text-xs text-muted flex items-center gap-1.5">
                              <span className="wr-cc light">{countryCode(p.country)}</span>{' '}
                              {p.country}
                            </div>
                          </div>
                        </div>
                        <div className="text-xs text-muted mt-2.5">
                          {sp ? (
                            <>
                              Spokesperson <b className="text-ink">{sp.name}</b>, {sp.title}.
                            </>
                          ) : (
                            'Spokesperson assigned at compile.'
                          )}
                          {statements > 0
                            ? ` ${statements} scheduled statement${statements === 1 ? '' : 's'}.`
                            : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* response teams */}
            {teamCharters.length > 0 &&
              (() => {
                const groups = new Map<string, TeamCharterWire[]>();
                for (const t of teamCharters) {
                  const k = t.org_key ?? '__single';
                  if (!groups.has(k)) groups.set(k, []);
                  groups.get(k)!.push(t);
                }
                const orgLabel = (k: string, sample: TeamCharterWire) => {
                  if (k === '__single') return null;
                  const reg = registryByKey.get(k);
                  const name = reg?.display_name || sample.short_name || k;
                  const place = reg?.country || sample.country;
                  return { name, place };
                };
                return (
                  <div>
                    <div className="wr-sech" style={{ margin: '0 0 10px' }}>
                      <h2>
                        Response teams <span className="n">{teamCharters.length}</span>
                      </h2>
                      <p>
                        Players are assigned to these in the session lobby. Each has its own
                        pressure, contacts and scoring rubric — all editable after compile.
                      </p>
                    </div>
                    {Array.from(groups.entries()).map(([k, teams]) => {
                      const label = orgLabel(k, teams[0]);
                      return (
                        <div key={k} className={groups.size > 1 ? 'mb-4' : ''}>
                          {label && (
                            <div
                              className="flex items-center gap-2 mb-2 text-xs font-extrabold uppercase tracking-wider"
                              style={{ color: 'var(--f-org)' }}
                            >
                              {label.place && (
                                <span className="wr-cc">{countryCode(label.place)}</span>
                              )}
                              {label.name}
                              {label.place && (
                                <span className="text-muted font-semibold normal-case tracking-normal">
                                  · {label.place}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {teams.map((team) => {
                              const contacts = stakeholders.filter(
                                (s) =>
                                  (s.owning_team === (team.function_key || team.team_name) ||
                                    s.owning_team === team.team_name) &&
                                  (s.org_key === null ||
                                    team.org_key == null ||
                                    s.org_key === team.org_key),
                              );
                              const injN = (teamStorylines[team.team_name] || []).length;
                              return (
                                <div
                                  key={team.team_name}
                                  className="wr-node"
                                  style={
                                    {
                                      '--g': team.can_post_publicly
                                        ? 'var(--accent)'
                                        : team.function_key === 'Executive'
                                          ? 'var(--f-pressure)'
                                          : 'var(--f-org)',
                                    } as CSSProperties
                                  }
                                >
                                  <div className="flex items-center gap-2.5">
                                    <div className="wr-tile" style={{ width: 38, height: 38 }}>
                                      <WrIcon
                                        name={teamIcon(team.function_key || team.team_name)}
                                        size={17}
                                      />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="font-extrabold text-ink truncate">
                                        {team.team_name}
                                      </div>
                                      <div className="text-[11.5px] text-muted">
                                        {injN} inject{injN === 1 ? '' : 's'}
                                        {contacts.length > 0
                                          ? ` · ${contacts.length} contact${contacts.length === 1 ? '' : 's'}`
                                          : ''}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex gap-1.5 mt-2.5 flex-wrap">
                                    {team.can_post_publicly && (
                                      <span className="wr-p live">public voice</span>
                                    )}
                                    {team.function_key === 'Executive' && (
                                      <span className="wr-p speaks">
                                        leadership · decides by communicating
                                      </span>
                                    )}
                                    {team.is_custom && <span className="wr-p rel">custom</span>}
                                  </div>
                                  <div className="text-xs text-muted mt-2.5 leading-relaxed line-clamp-3">
                                    {team.mission}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

            {/* notification SOP */}
            {sopSteps.length > 0 && (
              <div>
                <div
                  className="wr-sech"
                  style={{ margin: '0 0 10px', '--g': 'var(--f-pressure)' } as CSSProperties}
                >
                  <h2>
                    Notification &amp; consultation SOP <span className="n">{sopSteps.length}</span>
                  </h2>
                  <p>
                    Leadership decides by communicating. When a decision is detected, these steps
                    grade the people-facing teams: who they told, in what order, how quickly, how
                    humanely.
                  </p>
                </div>
                <div className="grid gap-2">
                  {sopSteps.map((s, i) => (
                    <div
                      key={s.step_id}
                      className="wr-node flex items-center gap-3"
                      style={{ padding: '10px 14px' }}
                    >
                      <div
                        className="wr-mono plain"
                        style={{
                          width: 32,
                          height: 32,
                          fontSize: 12,
                          fontFamily: 'JetBrains Mono, monospace',
                        }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-ink text-sm">{s.name}</div>
                        <div className="text-xs text-muted">{s.description}</div>
                      </div>
                      <span className="wr-p">{s.time_limit_minutes} min</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* full read-through */}
            <div>
              <div className="wr-sech" style={{ margin: '0 0 10px' }}>
                <h2>Read everything</h2>
                <p>Every inject, contact, persona and fact — fold what you have already checked.</p>
              </div>

              <WrFold
                title="Inject timeline"
                count={timedInjects.length}
                sub={
                  conditionalInjects.length > 0
                    ? `+ ${conditionalInjects.length} conditional`
                    : undefined
                }
                lead={<WrIcon name="layers" size={14} className="text-muted" />}
              >
                <div className="max-h-[480px] overflow-y-auto pr-1">
                  {timedInjects.map((inj, i) => {
                    const dc = (inj.delivery_config || {}) as Record<string, unknown>;
                    return (
                      <div
                        key={i}
                        className="wr-inj"
                        style={{ gridTemplateColumns: '60px auto 1fr auto', alignItems: 'start' }}
                      >
                        <span className="t">
                          T+{String(inj.trigger_time_minutes).padStart(2, '0')}
                        </span>
                        <OriginBadge
                          inject={
                            inj as {
                              type: string;
                              delivery_config?: Record<string, unknown> | null;
                            }
                          }
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="ttl">{inj.title}</div>
                          <div className="by">
                            {dc.author_display_name || dc.author_handle
                              ? String(dc.author_display_name ?? dc.author_handle)
                              : ''}
                            {(dc.author_display_name || dc.author_handle) &&
                            inj.target_teams?.length
                              ? ' → '
                              : ''}
                            {inj.target_teams?.length ? inj.target_teams.join(', ') : ''}
                          </div>
                          <div className="text-xs text-muted mt-1 whitespace-pre-wrap leading-relaxed">
                            {inj.content}
                          </div>
                        </div>
                        <div className="tags">
                          {inj.severity === 'critical' && (
                            <span className="wr-p rival">critical</span>
                          )}
                          {!!dc.stakeholder_id && <span className="wr-p live">stakeholder</span>}
                          {!!dc.page_org_key && <span className="wr-p speaks">page statement</span>}
                          {!!dc.country && (
                            <span className="wr-cc light">{countryCode(String(dc.country))}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {conditionalInjects.length > 0 && (
                    <div className="text-xs text-muted pt-2 px-2">
                      + {conditionalInjects.length} condition-triggered inject
                      {conditionalInjects.length === 1 ? '' : 's'} that fire on participant
                      behaviour rather than the clock.
                    </div>
                  )}
                </div>
              </WrFold>

              {stakeholders.length > 0 && (
                <WrFold
                  title="Stakeholder contacts"
                  count={stakeholders.length}
                  sub={`${liveConcerns} with a live concern`}
                  lead={<WrIcon name="target" size={14} className="text-muted" />}
                >
                  <div className="max-h-[480px] overflow-y-auto pr-1">
                    {stakeholders.map((s) => (
                      <div key={s.id} className="wr-row" style={{ alignItems: 'start' }}>
                        <div className={`wr-mono av ${s.page_org_key ? 'pr' : ''}`}>
                          {initialsOf(s.name)}
                        </div>
                        <div className="min-w-0">
                          <div className="nm">
                            <span>{s.name}</span>
                            <span className="wr-p rel">{s.relationship}</span>
                            {s.grievance ? (
                              <span className="wr-p live">live concern</span>
                            ) : (
                              <span className="wr-p pure">pure contact</span>
                            )}
                            {!!s.page_org_key && (
                              <span className="wr-p speaks">
                                speaks for{' '}
                                {registryByKey.get(String(s.page_org_key))?.display_name ??
                                  String(s.page_org_key)}
                              </span>
                            )}
                          </div>
                          <div className="ti">
                            {s.title}, {s.organisation} · owned by {s.owning_team}
                            {s.org_key
                              ? ` @ ${registryByKey.get(s.org_key)?.display_name ?? s.org_key}`
                              : ' · all organisations'}
                          </div>
                          {s.note && (
                            <div className="text-[11.5px] text-muted mt-0.5">{s.note}</div>
                          )}
                          {s.grievance && (
                            <div
                              className="text-[11.5px] mt-0.5"
                              style={{ color: 'var(--accent-strong)' }}
                            >
                              Hidden concern: {s.grievance}
                            </div>
                          )}
                        </div>
                        <div className="pills">
                          <span className="wr-p font-mono">{s.email}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </WrFold>
              )}

              <WrFold
                title="Crowd personas"
                count={personas.length}
                sub={
                  Object.keys(perCountryCounts).length > 1
                    ? Object.entries(perCountryCounts)
                        .map(([c, n]) => `${c} ${n}`)
                        .join(' · ')
                    : undefined
                }
                lead={<WrIcon name="feed" size={14} className="text-muted" />}
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-[480px] overflow-y-auto pr-1">
                  {personas.map((npc, i) => (
                    <div key={i} className="wr-row" style={{ gridTemplateColumns: '36px 1fr' }}>
                      <div className="wr-mono av plain">{initialsOf(npc.name)}</div>
                      <div className="min-w-0">
                        <div className="nm">
                          <span>{npc.name}</span>
                          <span className="text-muted font-medium text-xs">{npc.handle}</span>
                          {npc.bias && npc.bias !== 'none' && (
                            <span className="wr-p key">{npc.bias}</span>
                          )}
                        </div>
                        <div className="ti line-clamp-2">{npc.personality}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </WrFold>

              {factSheet && (
                <WrFold
                  title="Fact sheet"
                  count={factSheet.confirmed_facts.length + factSheet.unconfirmed_claims.length}
                  sub={`${factSheet.confirmed_facts.length} confirmed · ${factSheet.unconfirmed_claims.length} claims`}
                  lead={<WrIcon name="shield" size={14} className="text-muted" />}
                >
                  <div className="wr-facts p-2">
                    <div>
                      <h5>Confirmed</h5>
                      <ul className="m-0 p-0 list-none space-y-1.5">
                        {factSheet.confirmed_facts.map((f, i) => (
                          <li key={i} className="text-xs text-ink flex gap-2">
                            <WrIcon
                              name="check"
                              size={12}
                              className="mt-0.5 flex-none"
                              style={{ color: 'var(--success)' }}
                            />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {factSheet.unconfirmed_claims.length > 0 && (
                      <div>
                        <h5>Claims — and the truth</h5>
                        <ul className="m-0 p-0 list-none space-y-2">
                          {factSheet.unconfirmed_claims.map((c, i) => (
                            <li key={i} className="text-xs">
                              <div className="flex gap-2 text-ink">
                                <span className="wr-p rival flex-none">{c.status}</span>
                                <span>{c.claim}</span>
                              </div>
                              <div className="text-muted mt-0.5 pl-1">Truth: {c.truth}</div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </WrFold>
              )}

              {objectives.length > 0 && (
                <WrFold
                  title="Objectives"
                  count={objectives.length}
                  lead={<WrIcon name="target" size={14} className="text-muted" />}
                >
                  <div className="space-y-2 p-1">
                    {objectives.map((o, i) => (
                      <div
                        key={i}
                        className="wr-node flex items-center gap-3"
                        style={{ padding: '10px 14px' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-ink text-sm">{o.objective_name}</div>
                          <div className="text-xs text-muted">{o.description}</div>
                        </div>
                        <span className="font-mono font-bold" style={{ color: 'var(--brand)' }}>
                          {o.weight}%
                        </span>
                      </div>
                    ))}
                  </div>
                </WrFold>
              )}

              {convergenceGates.length > 0 && (
                <WrFold
                  title="Convergence gates"
                  count={convergenceGates.length}
                  lead={<WrIcon name="target" size={14} className="text-muted" />}
                >
                  <div className="space-y-2 p-1">
                    {convergenceGates.map((g, i) => (
                      <div key={i} className="wr-node" style={{ padding: '10px 14px' }}>
                        <div className="font-bold text-ink text-sm">{g.title}</div>
                        <div className="text-xs text-muted mt-0.5">{g.content}</div>
                      </div>
                    ))}
                  </div>
                </WrFold>
              )}

              {orgPage && (
                <WrFold
                  title="Organisation pages"
                  lead={<WrIcon name="phone" size={14} className="text-muted" />}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-1">
                    {(() => {
                      const orgs = (orgPage.orgs as Array<Record<string, unknown>>) || [
                        { display_name: orgName || 'Primary org', ...orgPage },
                      ];
                      return orgs.map((org, i) => {
                        const fb = (org.facebook || {}) as Record<string, unknown>;
                        const x = (org.x_twitter || {}) as Record<string, unknown>;
                        const role = String(org.role ?? 'protagonist');
                        return (
                          <div
                            key={i}
                            className="wr-node"
                            style={
                              {
                                '--g':
                                  role === 'antagonist'
                                    ? 'var(--f-rival)'
                                    : role === 'pressure'
                                      ? 'var(--f-pressure)'
                                      : 'var(--f-org)',
                                padding: '12px 14px',
                              } as CSSProperties
                            }
                          >
                            <div className="kicker">
                              <WrIcon
                                name={
                                  role === 'antagonist'
                                    ? 'swords'
                                    : role === 'pressure'
                                      ? 'landmark'
                                      : 'building'
                                }
                                size={12}
                              />{' '}
                              {role}
                            </div>
                            <div className="font-extrabold text-ink">
                              {String(org.display_name || fb.page_name || '')}
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              <span className="wr-ch fb sm">Fakebook</span>
                              <span className="text-xs text-muted">
                                {String(fb.page_name || '—')} · {String(fb.page_handle || '—')}
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              <span className="wr-ch z sm">Z</span>
                              <span className="text-xs text-muted">
                                {String(x.page_name || '—')} · {String(x.page_handle || '—')}
                              </span>
                            </div>
                            {!!fb.page_bio && (
                              <div className="text-xs text-muted mt-1.5">{String(fb.page_bio)}</div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                </WrFold>
              )}
            </div>

            <div className="wr-ctabar" style={{ marginTop: 4 }}>
              <span className="hint">
                Compiling spends <b>1 scenario credit</b> and persists everything above. You can
                still edit all of it from the library afterwards.
              </span>
              <span className="grow" />
              <button onClick={compileScenario} className="wr-btn accent lg">
                <WrIcon name="bolt" /> Compile scenario
              </button>
            </div>
          </div>
        )}

        {compiling && (
          <div className="py-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-sm font-bold text-ink">Compiling scenario…</span>
            </div>
            <div
              className="rounded-2xl p-4 font-mono text-xs space-y-1 max-h-72 overflow-y-auto"
              style={{ background: 'var(--wr-deep)', color: 'rgba(255,255,255,.75)' }}
            >
              {compileProgress.map((msg, i) => (
                <div key={i}>
                  <span style={{ color: 'var(--accent)' }}>[{String(i + 1).padStart(2, '0')}]</span>{' '}
                  {msg}
                </div>
              ))}
              <div className="animate-pulse">&#9612;</div>
            </div>
          </div>
        )}

        {scenarioId && !compiling && (
          <div>
            <div
              className="wr-artband center rounded-2xl text-center"
              style={{ padding: '34px 24px 28px' }}
            >
              <img
                className="wr-art"
                src={artFor(
                  {
                    id: scenarioId,
                    category: 'social_media_crisis',
                    title: scenarioTitle ?? narrative?.title ?? '',
                    description: narrative?.description,
                  },
                  'full',
                )}
                alt=""
              />
              <div
                className="wr-tile mx-auto"
                style={
                  {
                    width: 56,
                    height: 56,
                    borderRadius: 18,
                    '--g': 'var(--success)',
                  } as CSSProperties
                }
              >
                <WrIcon name="check" size={26} />
              </div>
              <div className="wr-eyebrow justify-center mt-4">Scenario compiled</div>
              <h2
                className="text-white font-extrabold mt-2"
                style={{ fontSize: 26, lineHeight: 1.12, letterSpacing: '-.015em' }}
              >
                {scenarioTitle ?? narrative?.title ?? 'Your scenario'}
              </h2>
              <div className="font-mono text-[11px] mt-2" style={{ color: 'rgba(255,255,255,.5)' }}>
                {scenarioId}
              </div>
              <div className="wr-kpis onDark mx-auto mt-5" style={{ maxWidth: 560 }}>
                <div>
                  <b>{storylineInjects.length + totalTeamInjects + sharedInjects.length}</b>
                  <span>injects</span>
                </div>
                <div>
                  <b>{personas.length}</b>
                  <span>crowd</span>
                </div>
                <div>
                  <b>{stakeholders.length}</b>
                  <span>contacts</span>
                </div>
                <div>
                  <b>{convergenceGates.length}</b>
                  <span>gates</span>
                </div>
              </div>
              <div className="flex justify-center gap-2.5 flex-wrap mt-6">
                <a href="/scenarios" className="wr-btn accent lg">
                  <WrIcon name="layers" /> View in the library
                </a>
                <button
                  onClick={() => navigate(`/sessions?create=${scenarioId}`)}
                  className="wr-btn onDark lg"
                >
                  <WrIcon name="play" /> Create a session
                </button>
                {wizardDraftId && (
                  <button
                    onClick={() => {
                      setScenarioId(null);
                      setCompileProgress([]);
                      setStep(1);
                    }}
                    className="wr-btn onDark lg"
                  >
                    <WrIcon name="edit" /> Modify &amp; recompile
                  </button>
                )}
              </div>
            </div>
            <div className="mt-4">
              <WrFold
                title="Compile log"
                count={compileProgress.length}
                lead={<WrIcon name="doc" size={14} className="text-muted" />}
              >
                <div className="font-mono text-xs space-y-1 p-2 max-h-56 overflow-y-auto text-muted">
                  {compileProgress.map((msg, i) => (
                    <div key={i}>
                      <span style={{ color: 'var(--accent)' }}>
                        [{String(i + 1).padStart(2, '0')}]
                      </span>{' '}
                      {msg}
                    </div>
                  ))}
                </div>
              </WrFold>
            </div>
          </div>
        )}
      </div>
    );
  };

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
                View in the library <WrIcon name="arrow" />
              </a>
            ) : compiling ? (
              <span className="hint">Compiling…</span>
            ) : (
              <button onClick={compileScenario} className="wr-btn accent lg">
                <WrIcon name="bolt" /> Compile scenario
              </button>
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
