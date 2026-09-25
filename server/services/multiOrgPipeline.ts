import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import type { ScenarioBlueprint } from './blueprint/blueprintTypes.js';
import {
  generateUnifiedStoryline,
  generateOrgPageConfig,
  normalizeOrgPages,
  type NPCPersona,
  type FactSheet,
  type SocialInject,
  type TeamDef,
  type OrgPageConfig,
  type OrgConfig,
  type SOPStep,
} from './socialCrisisGeneratorService.js';
import { repairOrgPageKeys } from './orgNameMatch.js';
import {
  validateOrganisations,
  buildOrgRegistry,
  buildCountries,
  getCatalogCharterByFunction,
  EXECUTIVE_FUNCTION,
  GENERATOR_PRESET_FUNCTIONS,
  type OrganisationInput,
  type CompetitorInput,
  type PressureOrgInput,
  type NormalisedOrg,
  type NormalisedCompetitor,
  type NormalisedPressureOrg,
  type OrgTeamCharter,
  type OrganisationsValidation,
} from './scenarioOrgModel.js';
import { inferCrisisFootprint, type CrisisFootprint } from './crisisFootprintService.js';
import {
  alignedPostureFor,
  buildPressureStatements,
  ensureSpokespersons,
  generatePressureOrgPages,
} from './pressureOrgGenerationService.js';
import {
  generateFactSheetAndCommunities,
  generatePersonasForCountry,
  buildOrgCharters,
  generateOrgTeamStorylines,
  newTakenIdentifiers,
  type CrisisContext,
  type TakenIdentifiers,
} from './multiOrgGenerationService.js';
import {
  generateStakeholdersForOrg,
  generateCommonStakeholders,
  ensurePersonaTwins,
} from './stakeholderGenerationService.js';
import { sanitizeExpectedActions, SENTIMENT_DIMENSIONS } from './teamCharterService.js';
import type { Stakeholder, OrgRegistryEntry, CountryEntry } from '../lib/stakeholderContract.js';
import {
  completeCast,
  detectLabourSignal,
  detectProductSafetySignal,
  ensureRequiredCarriers,
  ownerFunctionFor,
} from './castCompletenessService.js';

/** Private planner hints persisted at initial_state.decision_context (organic decisions §4.1). */
export interface DecisionContext {
  leakiness: number;
  labour_signal: boolean;
  product_safety_signal: boolean;
  statutory_notice_days?: number;
  notification_function?: string;
}

/**
 * Multi-organisation War Room pipeline (contract §5): the per-endpoint
 * orchestration the routes delegate to whenever the wizard sends
 * `organisations[]`. Legacy single-org requests never reach this file.
 */

// ─── Zod schemas shared by the routes ────────────────────────────────────────

export const organisationInputSchema = z.object({
  org_key: z.string().optional(),
  display_name: z.string().min(1).max(120),
  short_name: z.string().max(20).optional(),
  country: z.string().min(1).max(80),
  city: z.string().max(80).optional(),
  kind: z.enum(['company', 'office', 'agency', 'ngo', 'other']).optional(),
  facebook_handle: z.string().max(60).optional(),
  x_handle: z.string().max(60).optional(),
  logo_url: z.string().max(2000).optional(),
  is_primary: z.boolean(),
  team_roster: z
    .array(
      z.object({
        team_name: z.string().min(1).max(60),
        description: z.string().max(2000).optional(),
        is_custom: z.boolean().optional(),
        is_public_voice: z.boolean().optional(),
      }),
    )
    .max(6),
  operation: z.enum(['players', 'ai']).optional(),
});

export const organisationsSchema = z.array(organisationInputSchema).min(1).max(6);

export const pressureOrganisationsSchema = z
  .array(
    z.object({
      org_key: z.string().optional(),
      display_name: z.string().min(1).max(120),
      kind: z.enum(['union', 'regulator', 'ngo', 'community_group', 'political']),
      country: z.string().min(1).max(80),
      city: z.string().max(80).optional(),
      register: z.enum(['statutory', 'advocacy', 'grassroots', 'political']).optional(),
      wants: z.string().max(300).optional(),
      facebook_handle: z.string().max(60).optional(),
      x_handle: z.string().max(60).optional(),
      spokesperson_stakeholder_id: z.string().max(80).optional(),
      targets_org_keys: z.array(z.string()).max(6).optional(),
    }),
  )
  .max(6);

export const competitorsSchema = z.array(
  z.object({
    name: z.string().min(1).max(120),
    country: z.string().min(1).max(80),
    facebook_handle: z.string().max(60).optional(),
    x_handle: z.string().max(60).optional(),
  }),
);

export const teamCharterWireSchema = z.object({
  team_name: z.string(),
  mission: z.string(),
  responsibilities: z.array(z.string()),
  out_of_lane: z.array(z.string()).optional(),
  scoring_rubric: z.string().optional(),
  expected_actions: z.array(z.unknown()).optional(),
  min_participants: z.number().optional(),
  max_participants: z.number().optional(),
  is_custom: z.boolean().optional(),
  can_post_publicly: z.boolean().optional(),
  sentiment_dimension: z.string().optional(),
  org_key: z.string().nullable().optional(),
  function_key: z.string().optional(),
  country: z.string().optional(),
  short_name: z.string().optional(),
});
export type TeamCharterWire = z.infer<typeof teamCharterWireSchema>;

export function resolveOrganisations(
  organisations: OrganisationInput[] | undefined,
  competitors: CompetitorInput[] | undefined,
  pressureOrganisations?: PressureOrgInput[] | undefined,
): OrganisationsValidation | null {
  if (!organisations || organisations.length === 0) return null;
  return validateOrganisations(organisations, competitors || [], pressureOrganisations || []);
}

export function crisisContextFrom(body: {
  crisis_type: string;
  context?: string;
  duration?: number;
  org_name?: string;
  blueprint?: unknown;
}): CrisisContext {
  return {
    crisisType: body.crisis_type,
    context: body.context || '',
    duration: body.duration || 60,
    orgName: body.org_name,
    blueprint: null,
  };
}

/** Full charter payload streamed to the wizard and round-tripped into compile. */
export function orgCharterWire(c: OrgTeamCharter): TeamCharterWire {
  return {
    team_name: c.team_name,
    mission: c.mission,
    responsibilities: c.responsibilities,
    out_of_lane: c.out_of_lane,
    scoring_rubric: c.scoring_rubric,
    expected_actions: c.expected_actions,
    min_participants: c.min_participants,
    max_participants: c.max_participants,
    is_custom: !!c.is_custom,
    can_post_publicly: !!c.can_post_publicly,
    sentiment_dimension: c.sentiment_dimension || 'public_trust',
    org_key: c.org_key,
    function_key: c.function_key,
    country: c.country,
    short_name: c.short_name,
  };
}

function countriesOf(orgs: NormalisedOrg[]): string[] {
  return Array.from(new Set(orgs.map((o) => o.country)));
}

/**
 * Countries where HUMANS play (a protagonist organisation with operation 'players').
 * Pressure plan §11: content from any other country — an AI-operated office's crowd, a pressure
 * page there, stakeholder posts — is emitted UNSCOPED (no `country`) so the players present see
 * it as regional spillover. The feed shows a viewer only `country IS NULL` or their own country.
 */
export function humanCountries(orgs: NormalisedOrg[]): Set<string> {
  return new Set(orgs.filter((o) => o.operation !== 'ai').map((o) => o.country));
}

/** Strip `delivery_config.country` from injects whose country hosts no human players (mutates). */
export function unscopeInjectsForCountriesWithoutPlayers(
  injects: SocialInject[],
  human: Set<string>,
): number {
  let n = 0;
  for (const inj of injects) {
    const dc = inj.delivery_config;
    if (dc?.country && !human.has(dc.country)) {
      delete dc.country;
      n++;
    }
  }
  return n;
}

/** Strip `country` from personas whose country hosts no human players (returns new objects). */
export function unscopePersonasForCountriesWithoutPlayers(
  personas: NPCPersona[],
  human: Set<string>,
): NPCPersona[] {
  return personas.map((p) => {
    if (!p.country || human.has(p.country)) return p;
    const copy = { ...p } as NPCPersona & { country?: string };
    delete copy.country;
    copy.backstory = /Based in /.test(copy.backstory || '')
      ? copy.backstory
      : `${copy.backstory || ''} (Based in ${p.country}.)`.trim();
    return copy as NPCPersona;
  });
}

function personasPerCountryTarget(): number {
  const raw = Number(process.env.SOCIAL_PERSONAS_PER_COUNTRY);
  return Number.isFinite(raw) && raw >= 20 ? Math.min(400, Math.round(raw)) : 200;
}

// ─── generate-npcs ───────────────────────────────────────────────────────────

export interface NpcsPipelineResult {
  personas: NPCPersona[];
  factSheet: FactSheet;
  communities: string[];
  countries: CountryEntry[];
  per_country_counts: Record<string, number>;
  /** Pressure plan §11: proposals for the wizard (nothing persisted). */
  footprint: CrisisFootprint;
}

/** Spillover crowd size for a footprint country that hosts no protagonist organisation. */
const SPILLOVER_PERSONAS = 40;
const MAX_SPILLOVER_COUNTRIES = 2;

export async function runNpcsPipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisis: CrisisContext,
  opts: { footprint?: CrisisFootprint | null } = {},
): Promise<NpcsPipelineResult> {
  const { orgs, competitors, pressureOrgs } = orgsResult;
  const crisisText = `${crisis.crisisType}. ${crisis.context}`;
  const [{ factSheet, communities }, footprint] = await Promise.all([
    generateFactSheetAndCommunities(crisis, orgs),
    opts.footprint
      ? Promise.resolve(opts.footprint)
      : inferCrisisFootprint(crisisText, orgs).catch((err) => {
          logger.warn({ err }, 'crisis_footprint_failed');
          return null;
        }),
  ]);
  const taken = newTakenIdentifiers();
  const target = personasPerCountryTarget();
  const countries = countriesOf(orgs);

  // Footprint countries without a protagonist org (incident / regulatory) still get a crowd —
  // emitted UNSCOPED (no persona.country) so the players present see it as regional spillover.
  const spilloverCountries = (footprint?.countries || [])
    .filter(
      (c) =>
        (c.role === 'incident_location' || c.role === 'regulatory') &&
        !countries.includes(c.name) &&
        !pressureOrgs.some((p) => p.country === c.name && countries.includes(p.country)),
    )
    .map((c) => c.name)
    .slice(0, MAX_SPILLOVER_COUNTRIES);

  const [perCountry, spillover] = await Promise.all([
    Promise.all(
      countries.map((country) =>
        generatePersonasForCountry(
          crisis,
          country,
          orgs.filter((o) => o.country === country),
          factSheet,
          taken,
          target,
        ),
      ),
    ),
    Promise.all(
      spilloverCountries.map((country) =>
        generatePersonasForCountry(crisis, country, [], factSheet, taken, SPILLOVER_PERSONAS).then(
          (list) =>
            list.map((p) => {
              const copy = { ...p } as NPCPersona & { country?: string };
              delete copy.country; // unscoped: visible in every country's feed
              copy.backstory = `${copy.backstory || ''} (Based in ${country}.)`.trim();
              return copy as NPCPersona;
            }),
        ),
      ),
    ),
  ]);
  // Countries whose protagonist organisations are ALL AI-operated behave like spillover countries:
  // their crowd is unscoped so the humans elsewhere see it.
  const human = humanCountries(orgs);
  const personas = [
    ...unscopePersonasForCountriesWithoutPlayers(perCountry.flat(), human),
    ...spillover.flat(),
  ];
  const per_country_counts: Record<string, number> = {};
  countries.forEach(
    (c, i) =>
      (per_country_counts[human.has(c) ? c : `${c} (AI-operated, unscoped)`] =
        perCountry[i].length),
  );
  spilloverCountries.forEach(
    (c, i) => (per_country_counts[`${c} (spillover)`] = spillover[i].length),
  );

  const registry = buildOrgRegistry(orgs, competitors, null, pressureOrgs);
  return {
    personas,
    factSheet,
    communities,
    countries: buildCountries(registry),
    per_country_counts,
    footprint: footprint ?? {
      countries: countries.map((name) => ({
        name,
        role: 'decision_centre' as const,
        reason: 'Organisation entered by the trainer',
      })),
      implied_organisations: [],
      pressure_organisations: [],
      labour_signal: detectLabourSignal(crisisText),
      product_safety_signal: detectProductSafetySignal(crisisText),
    },
  };
}

// ─── generate-storyline ──────────────────────────────────────────────────────

export type StreamWriter = (msg: Record<string, unknown>) => void;

export interface StorylinePipelineResult {
  injects: SocialInject[];
  team_storylines: Record<string, SocialInject[]>;
  team_charters: TeamCharterWire[];
  stakeholders: Stakeholder[];
  stakeholder_injects: SocialInject[];
  persona_twins: NPCPersona[];
  orgs: OrgRegistryEntry[];
  countries: CountryEntry[];
  /** Cast-generated notification / consultation SOP steps (organic decisions §4.1). */
  sop_steps: SOPStep[];
  /** Private planner hints (persisted as initial_state.decision_context). */
  decision_context: DecisionContext;
  /** Pressure organisations with their spokesperson ids filled (round-trip to org-page + compile). */
  pressure_organisations: NormalisedPressureOrg[];
}

export async function runStorylinePipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisis: CrisisContext,
  personas: NPCPersona[],
  factSheet: FactSheet,
  blueprint: ScenarioBlueprint | null,
  write: StreamWriter,
): Promise<StorylinePipelineResult> {
  const { orgs, competitors, pressureOrgs, multiOrg } = orgsResult;
  const taken: TakenIdentifiers = newTakenIdentifiers();
  for (const p of personas) taken.handles.add(p.handle);

  // 1. Charters per organisation (parallel).
  write({ type: 'progress', message: `Preparing charters for ${orgs.length} organisation(s)...` });
  const chartersByOrg = await Promise.all(
    orgs.map(async (org) => {
      const charters = await buildOrgCharters(org, orgs, crisis);
      write({
        type: 'org_progress',
        org_key: org.org_key,
        stage: 'charters',
        detail: `${charters.length} teams`,
      });
      return charters;
    }),
  );
  const allCharters = chartersByOrg.flat();

  // 2. Team storylines per organisation (parallel) with that country's crowd.
  const storylineMaps = await Promise.all(
    orgs.map((org, i) =>
      generateOrgTeamStorylines(
        org,
        orgs,
        chartersByOrg[i],
        crisis,
        personas.filter((p) => !p.country || p.country === org.country),
        factSheet,
        (teamName, injectCount) =>
          write({
            type: 'team_complete',
            team: teamName,
            org_key: org.org_key,
            inject_count: injectCount,
          }),
      ),
    ),
  );
  const teamStorylines: Record<string, SocialInject[]> = Object.assign({}, ...storylineMaps);

  // 3. Stakeholders per organisation + common (parallel).
  const keyPersonas = personas.filter((p) => p.tier === 'key');
  const stakeholderResults = await Promise.all([
    ...orgs.map(async (org, i) => {
      const r = await generateStakeholdersForOrg(
        org,
        chartersByOrg[i],
        personas.filter((p) => !p.country || p.country === org.country),
        factSheet,
        crisis,
        taken,
        multiOrg,
      );
      write({
        type: 'org_progress',
        org_key: org.org_key,
        stage: 'stakeholders',
        detail: `${r.stakeholders.length} contacts`,
      });
      return r;
    }),
    generateCommonStakeholders(orgs, allCharters, keyPersonas, factSheet, crisis, taken),
  ]);
  const stakeholders = stakeholderResults.flatMap((r) => r.stakeholders);
  const stakeholderInjects = stakeholderResults.flatMap((r) => r.injects);
  const personaTwins = stakeholderResults.flatMap((r) => r.personaTwins);

  // 3b. Cast completeness (organic decisions §4.1): every path a decision can travel has a
  // contactable carrier — site leader, HR counterpart, workforce rep, roster + distribution
  // list, local reporter, regulator, executive shadow. Sequential so identifiers stay unique.
  const crisisText = `${crisis.crisisType} ${crisis.context}`;
  const labourSignal = detectLabourSignal(crisisText);
  const castOpts = { labourSignal, multiOrg };
  const sopSteps: SOPStep[] = [];
  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
    write({
      type: 'org_progress',
      org_key: org.org_key,
      stage: 'cast',
      detail: 'completing carriers',
    });
    const r = await completeCast(
      org,
      chartersByOrg[i],
      stakeholders,
      factSheet,
      crisis,
      taken,
      castOpts,
    );
    stakeholders.push(...r.added);
    if (i === 0 || (r.sopSteps.length > 0 && sopSteps.length === 0)) sopSteps.push(...r.sopSteps);
    write({
      type: 'org_progress',
      org_key: org.org_key,
      stage: 'cast',
      detail: `${r.added.length} carriers added (${r.gaps.flatMap((g) => g.missing).join(', ') || 'complete'})`,
    });
  }

  // 3c. Pressure organisations: one spokesperson each (reuse a matching contact or generate).
  if (pressureOrgs.length > 0) {
    write({
      type: 'progress',
      message: `Anchoring ${pressureOrgs.length} pressure organisation(s) to spokespersons...`,
    });
    const spokespersons = await ensureSpokespersons(
      pressureOrgs,
      stakeholders,
      orgs,
      allCharters,
      crisis,
      taken,
      multiOrg,
    );
    stakeholders.push(...spokespersons);
  }

  const hrFunction =
    ownerFunctionFor('hr_counterpart', allCharters) ??
    allCharters[0]?.function_key ??
    'Communications';
  const decisionContext: DecisionContext = {
    leakiness: 0.5,
    labour_signal: labourSignal,
    product_safety_signal: detectProductSafetySignal(crisisText),
    notification_function: hrFunction,
  };

  // 4. Universal backbone once (primary country; orgs by country in the prompt).
  const primary = orgs.find((o) => o.is_primary) ?? orgs[0];
  const teamDefs: TeamDef[] = allCharters.map((c) => ({
    team_name: c.team_name,
    team_description: `${c.mission} Responsibilities: ${c.responsibilities.join('; ')}`,
    min_participants: c.min_participants,
    max_participants: c.max_participants,
  }));
  const injects = await generateUnifiedStoryline(
    {
      crisisType: crisis.crisisType,
      country: primary.country,
      context: crisis.context,
      duration: crisis.duration,
      orgName: crisis.orgName || primary.display_name,
    },
    keyPersonas.length > 0 ? keyPersonas : personas.slice(0, 20),
    factSheet,
    (msg) => write({ type: 'progress', message: msg }),
    env.enableDocumentBlueprint && blueprint ? blueprint : null,
    teamDefs,
    multiOrg
      ? orgs.map((o) => ({
          display_name: o.display_name,
          country: o.country,
          team_names: o.teams.map((t) => t.team_name),
        }))
      : undefined,
  );
  // Backbone posts: country from the author persona (feed visibility); no org_key (public).
  if (multiOrg) {
    const countryByHandle = new Map(personas.map((p) => [p.handle, p.country]));
    for (const inj of injects) {
      const dc = inj.delivery_config;
      if (dc?.author_handle && !dc.country) {
        const c = countryByHandle.get(dc.author_handle);
        if (c) dc.country = c;
      }
    }
  }

  // Visibility rule (pressure plan §11): content from countries where nobody plays is unscoped.
  const human = humanCountries(orgs);
  const unscoped =
    unscopeInjectsForCountriesWithoutPlayers(injects, human) +
    unscopeInjectsForCountriesWithoutPlayers(stakeholderInjects, human) +
    unscopeInjectsForCountriesWithoutPlayers(Object.values(teamStorylines).flat(), human);
  if (unscoped > 0) {
    write({
      type: 'progress',
      message: `${unscoped} injects unscoped (countries without human players)`,
    });
  }
  const twins = unscopePersonasForCountriesWithoutPlayers(personaTwins, human);

  const registry = buildOrgRegistry(orgs, competitors, null, pressureOrgs);
  return {
    injects,
    team_storylines: teamStorylines,
    team_charters: allCharters.map(orgCharterWire),
    stakeholders,
    stakeholder_injects: stakeholderInjects,
    persona_twins: twins,
    orgs: registry,
    countries: buildCountries(registry),
    sop_steps: sopSteps,
    decision_context: decisionContext,
    pressure_organisations: pressureOrgs,
  };
}

/** Rehydrate OrgTeamCharter[] from the wire payload (client wording; machinery re-derived server-side). */
export function chartersFromWire(
  wire: TeamCharterWire[],
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
): OrgTeamCharter[] {
  const { orgs, multiOrg } = orgsResult;
  const out: OrgTeamCharter[] = [];
  for (const org of orgs) {
    for (const t of org.teams) {
      const w =
        wire.find((c) => c.team_name === t.team_name) ??
        wire.find(
          (c) =>
            c.function_key === t.function_key &&
            (c.org_key ?? null) === (multiOrg ? org.org_key : null),
        );
      const base =
        t.function_key === EXECUTIVE_FUNCTION || GENERATOR_PRESET_FUNCTIONS.includes(t.function_key)
          ? getCatalogCharterByFunction(t.function_key)
          : null;
      const responsibilities = (w?.responsibilities || [])
        .filter((r) => typeof r === 'string')
        .slice(0, 6);
      const dimension = String(
        w?.sentiment_dimension || base?.sentiment_dimension || 'public_trust',
      );
      out.push({
        team_name: t.team_name,
        mission: (w?.mission || '').trim() || base?.mission || t.description || t.function_key,
        responsibilities:
          responsibilities.length > 0 ? responsibilities : base?.responsibilities || [],
        out_of_lane: base && !t.is_custom ? base.out_of_lane : (w?.out_of_lane || []).slice(0, 4),
        scoring_rubric:
          base && !t.is_custom
            ? base.scoring_rubric
            : (w?.scoring_rubric || '').trim() ||
              `Judge as output of the "${t.function_key}" team. Reward factual precision, professionalism, timeliness, and staying within the team's lane.`,
        expected_actions:
          base && !t.is_custom
            ? base.expected_actions
            : sanitizeExpectedActions(w?.expected_actions, t.team_name),
        min_participants: 1,
        max_participants: Math.max(
          2,
          Math.min(6, Number(w?.max_participants) || base?.max_participants || 4),
        ),
        is_custom: t.is_custom,
        can_post_publicly: t.is_public_voice,
        sentiment_dimension: (SENTIMENT_DIMENSIONS as readonly string[]).includes(dimension)
          ? dimension
          : 'public_trust',
        org_key: multiOrg ? org.org_key : null,
        function_key: t.function_key,
        country: org.country,
        short_name: org.short_name,
      });
    }
  }
  return out;
}

// ─── generate-org-page ───────────────────────────────────────────────────────

export interface OrgPagePipelineResult {
  orgPage: OrgPageConfig;
  orgs: OrgRegistryEntry[];
  countries: CountryEntry[];
  /** Page-authored statements from pressure pages (append to stakeholder_injects). */
  pressure_injects: SocialInject[];
  /** Persona twins for pressure spokespersons (merge into personas). */
  persona_twins: NPCPersona[];
}

export async function runOrgPagePipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisisDescription: string,
  logoUrl: string | undefined,
  autoAntagonist: boolean,
  onProgress?: (msg: string) => void,
  extras: {
    stakeholders?: Stakeholder[];
    factSheet?: FactSheet | null;
    crisis?: CrisisContext | null;
  } = {},
): Promise<OrgPagePipelineResult> {
  const { orgs, competitors, pressureOrgs } = orgsResult;
  const primary = orgs.find((o) => o.is_primary) ?? orgs[0];
  const allies = orgs
    .filter((o) => o.org_key !== primary.org_key)
    .map((o) => ({
      name: o.display_name,
      facebook_handle: o.facebook_handle,
      x_handle: o.x_handle,
      country: o.country,
      city: o.city,
      org_key: o.org_key,
      kind: o.kind,
    }));
  const rivals = competitors.map((c) => ({
    name: c.name,
    facebook_handle: c.facebook_handle,
    x_handle: c.x_handle,
    country: c.country,
    org_key: c.org_key,
  }));

  const orgPage = await generateOrgPageConfig(
    crisisDescription,
    primary.country,
    primary.display_name,
    onProgress,
    logoUrl || primary.logo_url,
    { allies, competitors: rivals, auto_antagonist: autoAntagonist },
    { country: primary.country, city: primary.city },
  );

  // Every page must carry a registry key (MO-ORG-005). The generator assigns keys from the
  // roster; this repairs anything that still slipped through (an older payload, a model that
  // ignored its ref) and drops what cannot be placed, instead of failing at compile.
  orgPage.orgs = applyOrgPageKeyRepair(orgPage.orgs || [], orgs, competitors, 'pages_stage');
  stampAiOperatedPages(orgPage.orgs, orgs);

  // Pressure organisations: pages with posture + page-authored statements.
  let pressureInjects: SocialInject[] = [];
  let personaTwins: NPCPersona[] = [];
  if (pressureOrgs.length > 0) {
    const crisis =
      extras.crisis ??
      crisisContextFrom({
        crisis_type: crisisDescription.slice(0, 80),
        context: crisisDescription,
        duration: 60,
        org_name: primary.display_name,
      });
    const factSheet: FactSheet = extras.factSheet ?? {
      confirmed_facts: [],
      unconfirmed_claims: [],
    };
    const pages = await generatePressureOrgPages(pressureOrgs, orgs, crisis, factSheet, onProgress);
    orgPage.orgs = [...(orgPage.orgs || []), ...pages];
    if (extras.stakeholders && extras.stakeholders.length > 0) {
      const r = buildPressureStatements(pages, extras.stakeholders, orgs, humanCountries(orgs));
      pressureInjects = r.injects;
      personaTwins = unscopePersonasForCountriesWithoutPlayers(
        r.personaTwins,
        humanCountries(orgs),
      );
    }
  }

  const autoRival = normalizeOrgPages(orgPage).find(
    (o) => o.role === 'antagonist' && o.auto_generated,
  );
  const registry = buildOrgRegistry(
    orgs,
    competitors,
    autoRival
      ? {
          org_key: autoRival.org_key,
          display_name: autoRival.display_name,
          country: autoRival.country || primary.country,
        }
      : null,
    pressureOrgs,
  );
  return {
    orgPage,
    orgs: registry,
    countries: buildCountries(registry),
    pressure_injects: pressureInjects,
    persona_twins: personaTwins,
  };
}

// ─── compile ─────────────────────────────────────────────────────────────────

export interface CompileArtifacts {
  charters: OrgTeamCharter[];
  teamDefs: TeamDef[];
  registry: OrgRegistryEntry[];
  countries: CountryEntry[];
  primaryCountry: string;
  stakeholders: Stakeholder[];
  extraInjects: SocialInject[];
  personas: NPCPersona[];
  /** Notification / consultation SOP steps generated with the cast (organic-decisions plan §4.1). */
  sop_steps: SOPStep[];
  decision_context?: DecisionContext;
  /** The wizard's org_page with every page pointing at a registry key (or dropped). */
  orgPage: OrgPageConfig | null;
}

/**
 * Repair page keys against the registry and log what changed. Shared by the pages stage and
 * compile so a payload generated before this fix still compiles.
 */
function applyOrgPageKeyRepair(
  pages: OrgConfig[],
  orgs: NormalisedOrg[],
  competitors: NormalisedCompetitor[],
  where: string,
): OrgConfig[] {
  const r = repairOrgPageKeys(pages, orgs, competitors);
  for (const f of r.fixes) {
    logger.warn({ where, ...f }, 'org_page_key_repaired');
  }
  for (const d of r.dropped) {
    logger.warn({ where, ...d }, 'org_page_dropped');
  }
  return r.pages;
}

/**
 * AI-operated offices (pressure plan §12): their page is AI-run in the `aligned` register.
 * Idempotent; runs after key repair so a page that only just acquired its registry key is
 * stamped too (before the fix, a mismatched key silently left such a page player-controlled).
 */
function stampAiOperatedPages(pages: OrgConfig[], orgs: NormalisedOrg[]): void {
  const primary = orgs.find((o) => o.is_primary) ?? orgs[0];
  for (const cfg of pages) {
    const org = orgs.find((o) => o.org_key === cfg.org_key);
    if (org && org.operation === 'ai' && cfg.role === 'protagonist') {
      cfg.control_mode = 'ai';
      cfg.operation = 'ai';
      if (!cfg.posture) cfg.posture = alignedPostureFor(org, primary);
    }
  }
}

export function buildCompileArtifacts(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  body: {
    team_charters?: TeamCharterWire[];
    stakeholders?: Stakeholder[];
    stakeholder_injects?: SocialInject[];
    personas: NPCPersona[];
    org_page?: OrgPageConfig | null;
    sop_steps?: SOPStep[];
    decision_context?: Partial<DecisionContext> | null;
  },
): CompileArtifacts {
  const { orgs, competitors, multiOrg } = orgsResult;
  const charters = chartersFromWire(body.team_charters || [], orgsResult);
  const teamDefs: TeamDef[] = charters.map((c) => ({
    team_name: c.team_name,
    team_description: c.mission,
    min_participants: c.min_participants,
    max_participants: c.max_participants,
  }));

  // Pages must point at registry keys (MO-ORG-005); repair before anything reads them.
  const orgPage: OrgPageConfig | null = body.org_page
    ? {
        ...body.org_page,
        orgs: applyOrgPageKeyRepair(
          normalizeOrgPages(body.org_page),
          orgs,
          competitors as NormalisedCompetitor[],
          'compile',
        ),
      }
    : null;
  if (orgPage?.orgs) stampAiOperatedPages(orgPage.orgs, orgs);
  const pages = orgPage ? normalizeOrgPages(orgPage) : [];
  const autoRival = pages.find((o) => o.role === 'antagonist' && o.auto_generated);
  const primary = orgs.find((o) => o.is_primary) ?? orgs[0];
  // Pressure orgs: spokesperson ids come back from the wizard (filled by the storyline stage);
  // if a page config carries one and the input does not, take the page's.
  const pagesByKey = new Map(pages.map((p) => [p.org_key, p]));
  for (const p of orgsResult.pressureOrgs) {
    if (!p.spokesperson_stakeholder_id) {
      const page = pagesByKey.get(p.org_key);
      if (page?.spokesperson_stakeholder_id)
        p.spokesperson_stakeholder_id = page.spokesperson_stakeholder_id;
    }
  }
  const registry = buildOrgRegistry(
    orgs,
    competitors as NormalisedCompetitor[],
    autoRival
      ? {
          org_key: autoRival.org_key,
          display_name: autoRival.display_name,
          country: autoRival.country || primary.country,
        }
      : null,
    orgsResult.pressureOrgs,
  );
  const countries = buildCountries(registry);

  // Retired menu-layer fields are stripped so no new scenario carries them (handover §2.2);
  // page-authored / stakeholder-authored injects that depended on decision_recorded:* are dropped.
  const stakeholders = (body.stakeholders || [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const copy = { ...s } as Stakeholder & { latent_grievances?: unknown };
      delete copy.latent_grievances;
      return copy as Stakeholder;
    });
  const extraInjects = [...(body.stakeholder_injects || [])].filter((inj) => {
    const dc = (inj.delivery_config || {}) as unknown as Record<string, unknown>;
    const conds = (inj.conditions_to_appear as { conditions?: string[] } | undefined)?.conditions;
    const menuGated =
      Array.isArray(conds) && conds.some((c) => String(c).startsWith('decision_recorded:'));
    if (dc.decision_key || menuGated) return false;
    return true;
  });

  // Single-org: stakeholders and injects carry no org_key/country (contract §5.3 "identical to today").
  if (!multiOrg) {
    for (const s of stakeholders) s.org_key = null;
    for (const inj of extraInjects) {
      if (inj.delivery_config) {
        delete inj.delivery_config.org_key;
        delete inj.delivery_config.country;
      }
    }
  }

  // Carrier rule (MO-CAST-*): a required carrier the build left unfilled, or filled with a title
  // the validator cannot recognise (payloads built before carriers were tagged), gets a
  // deterministic one here rather than failing compile after a full build.
  const carriers = ensureRequiredCarriers(
    orgs,
    charters,
    stakeholders,
    takenIdentifiersOf(stakeholders, body.personas, pages),
    { labourSignal: !!body.decision_context?.labour_signal, multiOrg },
  );
  for (const f of carriers.filled) {
    logger.warn({ org_key: f.org_key, roles: f.roles }, 'cast_carriers_synthesized_at_compile');
  }
  stakeholders.push(...carriers.added);

  // Visibility rule (pressure plan §11), applied again at compile so wizard state saved before
  // an organisation was switched to AI-operated still comes out right.
  const human = humanCountries(orgs);
  unscopeInjectsForCountriesWithoutPlayers(extraInjects, human);

  // Defensive: persona twins for every feed-authoring stakeholder (idempotent).
  const countryByOrg = new Map(registry.map((r) => [r.org_key, r.country]));
  const personas = unscopePersonasForCountriesWithoutPlayers([...body.personas], human);
  personas.push(
    ...unscopePersonasForCountriesWithoutPlayers(
      ensurePersonaTwins(stakeholders, extraInjects, personas, countryByOrg),
      human,
    ),
  );

  return {
    charters,
    teamDefs,
    registry,
    countries,
    primaryCountry: primary.country,
    stakeholders,
    extraInjects,
    personas,
    orgPage,
    sop_steps: (body.sop_steps || []).filter(
      (s) => !(s as unknown as Record<string, unknown>).triggered_by_decision_key,
    ),
    decision_context: body.decision_context
      ? {
          leakiness: clamp01(Number(body.decision_context.leakiness ?? 0.5)),
          labour_signal: !!body.decision_context.labour_signal,
          product_safety_signal: !!body.decision_context.product_safety_signal,
          ...(body.decision_context.statutory_notice_days
            ? { statutory_notice_days: Number(body.decision_context.statutory_notice_days) }
            : {}),
          ...(body.decision_context.notification_function
            ? { notification_function: String(body.decision_context.notification_function) }
            : {}),
        }
      : undefined,
  };
}

/** Identifiers already in use by the payload (MO-STK-004 checks all three, handles also vs pages). */
function takenIdentifiersOf(
  stakeholders: Stakeholder[],
  personas: NPCPersona[],
  pages: OrgConfig[],
): TakenIdentifiers {
  const taken = newTakenIdentifiers();
  for (const s of stakeholders) {
    taken.ids.add(s.id);
    taken.emails.add(String(s.email).toLowerCase());
    taken.handles.add(String(s.handle).toLowerCase());
  }
  for (const p of personas) if (p.handle) taken.handles.add(String(p.handle).toLowerCase());
  for (const p of pages) {
    if (p.facebook?.page_handle) taken.handles.add(p.facebook.page_handle.toLowerCase());
    if (p.x_twitter?.page_handle) taken.handles.add(p.x_twitter.page_handle.toLowerCase());
  }
  return taken;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

export function logCompileSummary(
  scenarioId: string,
  a: CompileArtifacts,
  injectCount: number,
): void {
  logger.info(
    {
      scenarioId,
      orgs: a.registry.length,
      countries: a.countries.length,
      teams: a.charters.length,
      stakeholders: a.stakeholders.length,
      injects: injectCount,
      sop_steps: a.sop_steps.length,
    },
    'scenario_persisted_multi_org',
  );
}
