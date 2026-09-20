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
  type SOPStep,
} from './socialCrisisGeneratorService.js';
import {
  validateOrganisations,
  buildOrgRegistry,
  buildCountries,
  getCatalogCharterByFunction,
  EXECUTIVE_FUNCTION,
  GENERATOR_PRESET_FUNCTIONS,
  type OrganisationInput,
  type CompetitorInput,
  type NormalisedOrg,
  type NormalisedCompetitor,
  type OrgTeamCharter,
  type OrganisationsValidation,
} from './scenarioOrgModel.js';
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
import { generateDecisionLayer, hasExecutiveTeam } from './decisionLayerService.js';
import { sanitizeExpectedActions, SENTIMENT_DIMENSIONS } from './teamCharterService.js';
import type {
  Stakeholder,
  OrgRegistryEntry,
  CountryEntry,
  ExecutiveDecision,
  ChainOfCommandEdge,
} from './stakeholderShapes.js';

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
});

export const organisationsSchema = z.array(organisationInputSchema).min(1).max(6);

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
): OrganisationsValidation | null {
  if (!organisations || organisations.length === 0) return null;
  return validateOrganisations(organisations, competitors || []);
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
}

export async function runNpcsPipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisis: CrisisContext,
): Promise<NpcsPipelineResult> {
  const { orgs, competitors } = orgsResult;
  const { factSheet, communities } = await generateFactSheetAndCommunities(crisis, orgs);
  const taken = newTakenIdentifiers();
  const target = personasPerCountryTarget();
  const countries = countriesOf(orgs);

  const perCountry = await Promise.all(
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
  );
  const personas = perCountry.flat();
  const per_country_counts: Record<string, number> = {};
  countries.forEach((c, i) => (per_country_counts[c] = perCountry[i].length));

  const registry = buildOrgRegistry(orgs, competitors);
  return {
    personas,
    factSheet,
    communities,
    countries: buildCountries(registry),
    per_country_counts,
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
}

export async function runStorylinePipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisis: CrisisContext,
  personas: NPCPersona[],
  factSheet: FactSheet,
  blueprint: ScenarioBlueprint | null,
  write: StreamWriter,
): Promise<StorylinePipelineResult> {
  const { orgs, competitors, multiOrg } = orgsResult;
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

  const registry = buildOrgRegistry(orgs, competitors);
  return {
    injects,
    team_storylines: teamStorylines,
    team_charters: allCharters.map(orgCharterWire),
    stakeholders,
    stakeholder_injects: stakeholderInjects,
    persona_twins: personaTwins,
    orgs: registry,
    countries: buildCountries(registry),
  };
}

// ─── generate-convergence extras (decision layer) ────────────────────────────

export interface DecisionLayerWire {
  decision_space: ExecutiveDecision[];
  stakeholders: Stakeholder[];
  templates: SocialInject[];
  chain_of_command: ChainOfCommandEdge[];
  sop_steps: SOPStep[];
}

export async function runDecisionLayer(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  charters: OrgTeamCharter[],
  stakeholders: Stakeholder[],
  personas: NPCPersona[],
  factSheet: FactSheet,
  crisis: CrisisContext,
): Promise<DecisionLayerWire | null> {
  if (!hasExecutiveTeam(orgsResult.orgs)) return null;
  const r = await generateDecisionLayer(
    orgsResult.orgs,
    charters,
    stakeholders,
    personas,
    factSheet,
    crisis,
  );
  return {
    decision_space: r.decision_space,
    stakeholders: r.stakeholders,
    templates: r.templates,
    chain_of_command: r.chain_of_command,
    sop_steps: r.sop_steps,
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

export async function runOrgPagePipeline(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  crisisDescription: string,
  logoUrl: string | undefined,
  autoAntagonist: boolean,
  onProgress?: (msg: string) => void,
): Promise<{ orgPage: OrgPageConfig; orgs: OrgRegistryEntry[]; countries: CountryEntry[] }> {
  const { orgs, competitors } = orgsResult;
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
  );
  return { orgPage, orgs: registry, countries: buildCountries(registry) };
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
  decision_space?: ExecutiveDecision[];
  chain_of_command?: ChainOfCommandEdge[];
  sop_steps: SOPStep[];
}

export function buildCompileArtifacts(
  orgsResult: Extract<OrganisationsValidation, { ok: true }>,
  body: {
    team_charters?: TeamCharterWire[];
    stakeholders?: Stakeholder[];
    stakeholder_injects?: SocialInject[];
    personas: NPCPersona[];
    org_page?: OrgPageConfig | null;
    decision_space?: ExecutiveDecision[];
    chain_of_command?: ChainOfCommandEdge[];
    sop_steps?: SOPStep[];
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

  const autoRival = body.org_page
    ? normalizeOrgPages(body.org_page).find((o) => o.role === 'antagonist' && o.auto_generated)
    : undefined;
  const primary = orgs.find((o) => o.is_primary) ?? orgs[0];
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
  );
  const countries = buildCountries(registry);

  const stakeholders = (body.stakeholders || []).filter((s) => s && typeof s === 'object');
  const extraInjects = [...(body.stakeholder_injects || [])];

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

  // Defensive: persona twins for every feed-authoring stakeholder (idempotent).
  const countryByOrg = new Map(registry.map((r) => [r.org_key, r.country]));
  const personas = [...body.personas];
  personas.push(...ensurePersonaTwins(stakeholders, extraInjects, personas, countryByOrg));

  // Decision layer aliases (contract module names): drafts generated before the aliases
  // existed still compile — title mirrors label, by_function mirrors owed_by_function.
  const decisionSpace = (body.decision_space || []).map((d) => ({
    ...d,
    title: d.title || d.label,
    sop_obligations: (d.sop_obligations || []).map((ob) => ({
      ...ob,
      by_function: ob.by_function || ob.owed_by_function,
      owed_by_function: ob.owed_by_function || ob.by_function,
    })),
  }));
  const chainOfCommand = (body.chain_of_command || []).map((edge) => ({
    ...edge,
    to: (edge.to as unknown[])
      .map((t) =>
        typeof t === 'string'
          ? t
          : String(
              (t as { stakeholder_id?: string; function?: string }).stakeholder_id ||
                (t as { function?: string }).function ||
                '',
            ),
      )
      .filter(Boolean),
  }));

  return {
    charters,
    teamDefs,
    registry,
    countries,
    primaryCountry: primary.country,
    stakeholders,
    extraInjects,
    personas,
    decision_space: decisionSpace.length > 0 ? decisionSpace : undefined,
    chain_of_command: chainOfCommand.length > 0 ? chainOfCommand : undefined,
    sop_steps: body.sop_steps || [],
  };
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
      decisions: a.decision_space?.length ?? 0,
    },
    'scenario_persisted_multi_org',
  );
}
