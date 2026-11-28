import {
  COMMON_STAKEHOLDERS_MIN,
  MAX_SPILLOVER_COUNTRIES,
  MOOD_LADDER_BATCH,
  SPILLOVER_PERSONAS,
  STAKEHOLDERS_PER_TEAM_MIN,
} from './generationBudgets.js';
import { batchOrgPages } from '../server/services/orgPageBatching.js';
import {
  PERSONA_PER_COUNTRY_CAP,
  PERSONA_PER_COUNTRY_FLOOR,
  PERSONA_TOTAL_MAX_DEFAULT,
  personaAiCalls,
  personasForCountryCount,
} from '../server/services/personaBudget.js';

/** Response-branch parents per AI call (`responseBranchService` BATCH_SIZE). */
const RESPONSE_BRANCH_BATCH = 10;
/** Stakeholders per call (`generateStakeholdersForOrg` chunks charters by 2). */
const STAKEHOLDER_CHUNK = 2;
/** Page-generation batch when the caller does not pass one (`WARROOM_ORG_PAGE_BATCH`). */
const PAGE_BATCH_DEFAULT = 4;
/** One dependency-map call at or below this many playable teams (`WARROOM_DEPENDENCY_MAP_BATCH_TEAMS`). */
const DEPENDENCY_MAP_BATCH_DEFAULT = 16;
/** Max upstream edges per downstream team (`WARROOM_DEPENDENCY_UPSTREAM_PER_TEAM`). */
const DEPENDENCY_UPSTREAM_DEFAULT = 3;
/** Edges per consequence call (`WARROOM_DEPENDENCY_CONSEQUENCE_BATCH`). */
const DEPENDENCY_CONSEQUENCE_BATCH_DEFAULT = 8;

export interface BuildEstimateInput {
  countries: number;
  orgs: number;
  teams: number;
  customTeams: number;
  alliesAndRivals: number;
  pressureCountries: number;
  /** Pressure organisations. One spokesperson call each (no reused contact). */
  pressureOrgs: number;
  /**
   * Footprint spillover countries. Capped at {@link MAX_SPILLOVER_COUNTRIES};
   * each costs the spillover persona calls.
   */
  spilloverCountries: number;
  /** Branch-parent injects. Batches of {@link RESPONSE_BRANCH_BATCH}. */
  injectsEstimate: number;
}

export interface BuildEstimateOptions {
  personasTotalMax: number;
  pageBatch: number;
  personaCap: number;
  personaFloor: number;
  dependencyMapBatchTeams: number;
  dependencyUpstreamPerTeam: number;
  dependencyConsequenceBatch: number;
}

export interface BuildCallBreakdown {
  factSheet: number;
  footprint: number;
  personas: number;
  spilloverPersonas: number;
  adaptCharters: number;
  customCharters: number;
  teamStorylines: number;
  stakeholders: number;
  commonStakeholders: number;
  cast: number;
  spokespersons: number;
  backbone: number;
  convergence: number;
  intel: number;
  dependencyMap: number;
  dependencyConsequences: number;
  responseBranches: number;
  moodLadders: number;
  primaryPage: number;
  secondaryPages: number;
  pressurePages: number;
  total: number;
}

function nonNegative(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Per-org stakeholder calls when `teams` are spread as evenly as possible and
 * the first attempt succeeds (no retry).
 */
export function stakeholderCallsFor(orgs: number, teams: number): number {
  const orgCount = nonNegative(orgs);
  const teamCount = nonNegative(teams);
  if (orgCount === 0 || teamCount === 0) return 0;
  const base = Math.floor(teamCount / orgCount);
  const extra = teamCount % orgCount;
  let calls = 0;
  for (let i = 0; i < orgCount; i++) {
    const here = base + (i < extra ? 1 : 0);
    if (here > 0) calls += Math.ceil(here / STAKEHOLDER_CHUNK);
  }
  return calls;
}

function estimateOptions(over?: Partial<BuildEstimateOptions>): BuildEstimateOptions {
  return {
    personasTotalMax: over?.personasTotalMax ?? PERSONA_TOTAL_MAX_DEFAULT,
    pageBatch: over?.pageBatch ?? PAGE_BATCH_DEFAULT,
    personaCap: over?.personaCap ?? PERSONA_PER_COUNTRY_CAP,
    personaFloor: over?.personaFloor ?? PERSONA_PER_COUNTRY_FLOOR,
    dependencyMapBatchTeams: over?.dependencyMapBatchTeams ?? DEPENDENCY_MAP_BATCH_DEFAULT,
    dependencyUpstreamPerTeam: over?.dependencyUpstreamPerTeam ?? DEPENDENCY_UPSTREAM_DEFAULT,
    dependencyConsequenceBatch: over?.dependencyConsequenceBatch ?? DEPENDENCY_CONSEQUENCE_BATCH_DEFAULT,
  };
}

/** At most this many edges per playable team, and at most `upstreamPerTeam` each. */
export function dependencyEdgeBudget(teamCount: number, upstreamPerTeam: number): number {
  const teams = nonNegative(teamCount);
  const upstream = nonNegative(upstreamPerTeam);
  if (teams < 2 || upstream < 1) return 0;
  return Math.min(Math.ceil(teams * 1.5), upstream * teams);
}

/**
 * Map calls for a cast. One call when the teams fit in a batch or there is a
 * single organisation; otherwise one call per organisation plus one cross-org
 * call. The estimate assumes every organisation has at least two teams.
 */
export function dependencyMapCallCount(teamCount: number, orgCount: number, batchTeams: number): number {
  const teams = nonNegative(teamCount);
  if (teams < 2) return 0;
  const batch = Math.max(1, nonNegative(batchTeams) || 1);
  const orgs = nonNegative(orgCount);
  if (teams <= batch || orgs <= 1) return 1;
  return orgs + 1;
}

/**
 * Map calls: {@link dependencyMapCallCount}. Edges: {@link dependencyEdgeBudget}.
 * Consequence calls are batches of those edges.
 */
export function dependencyCallsFor(
  teams: number,
  orgs: number,
  options?: Partial<
    Pick<
      BuildEstimateOptions,
      'dependencyMapBatchTeams' | 'dependencyUpstreamPerTeam' | 'dependencyConsequenceBatch'
    >
  >,
): { map: number; consequences: number } {
  const teamCount = nonNegative(teams);
  if (teamCount < 2) return { map: 0, consequences: 0 };
  const batch = Math.max(1, nonNegative(options?.dependencyMapBatchTeams ?? DEPENDENCY_MAP_BATCH_DEFAULT) || 1);
  const upstream = Math.max(1, nonNegative(options?.dependencyUpstreamPerTeam ?? DEPENDENCY_UPSTREAM_DEFAULT) || 1);
  const size = Math.max(1, nonNegative(options?.dependencyConsequenceBatch ?? DEPENDENCY_CONSEQUENCE_BATCH_DEFAULT) || 1);
  const map = dependencyMapCallCount(teamCount, nonNegative(orgs), batch);
  const edges = dependencyEdgeBudget(teamCount, upstream);
  return { map, consequences: edges > 0 ? Math.ceil(edges / size) : 0 };
}

/**
 * Stakeholders the first generation attempt asks for: the low end of "6-8" per
 * team, the low end of "3-6" common contacts, plus one spokesperson per
 * pressure organisation. Roster contacts are not included. A build with the
 * minimum two teams already exceeds eight people, which is when mood ladders
 * drop the roster tier. Cast-gap principals are omitted: they are generated
 * only when a carrier is missing.
 */
export function ladderStakeholderCount(teams: number, orgs: number, pressureOrgs: number): number {
  if (nonNegative(orgs) === 0) return 0;
  return (
    nonNegative(teams) * STAKEHOLDERS_PER_TEAM_MIN +
    COMMON_STAKEHOLDERS_MIN +
    nonNegative(pressureOrgs)
  );
}

/** Mood-ladder calls: one per {@link MOOD_LADDER_BATCH} ladder stakeholders. */
export function moodLadderCalls(stakeholders: number): number {
  const count = nonNegative(stakeholders);
  if (count === 0) return 0;
  return Math.ceil(count / MOOD_LADDER_BATCH);
}

/**
 * Persona calls for spillover countries. Each country uses the pipeline's
 * fixed crowd of {@link SPILLOVER_PERSONAS}, and the country count is capped
 * at {@link MAX_SPILLOVER_COUNTRIES}.
 */
export function spilloverPersonaCalls(spilloverCountries: number): number {
  const countries = Math.min(nonNegative(spilloverCountries), MAX_SPILLOVER_COUNTRIES);
  if (countries === 0) return 0;
  return countries * personaAiCalls(SPILLOVER_PERSONAS);
}

/**
 * Expected AI calls for one full social-crisis build. There is no enforced
 * budget (decision O2); this is the number shown before Build.
 *
 * Assumptions, because the input is counts rather than a roster:
 * - the key-voice call returns 14 personas, then background batches fill the country target;
 * - spillover countries use the same crowd and cap as `runNpcsPipeline`;
 * - mood ladders use {@link ladderStakeholderCount} batched by {@link MOOD_LADDER_BATCH};
 * - one spokesperson call per pressure organisation (generated when no contact matches);
 * - one adapt-charter call per organisation that has a preset team, presets spread
 *   one per org (executives are not distinguished);
 * - one cast call per organisation (a fresh cast has carrier gaps);
 * - one pressure-page call per pressure country (that country's groups fit in one batch);
 * - no named rivals (`alliesAndRivals === 0`) still costs one call to invent a rival;
 * - stakeholder and branch calls assume the first attempt succeeds (retries are not counted);
 * - dependency generation is 1 map call up to WARROOM_DEPENDENCY_MAP_BATCH_TEAMS
 *   (otherwise orgs + 1) plus one consequence call per 8 estimated edges
 *   (ceil(1.5 × teams), also capped by the upstream-per-team budget).
 *
 * Defaults match the server env defaults. The server wrapper passes the live
 * `WARROOM_ORG_PAGE_BATCH` and `SOCIAL_PERSONAS_TOTAL_MAX`.
 */
export function explainBuildCalls(
  input: BuildEstimateInput,
  over?: Partial<BuildEstimateOptions>,
): BuildCallBreakdown {
  const opts = estimateOptions(over);
  const countries = nonNegative(input.countries);
  const orgs = nonNegative(input.orgs);
  const teams = nonNegative(input.teams);
  const customTeams = Math.min(teams, nonNegative(input.customTeams));
  const presetTeams = teams - customTeams;
  const pageBatch = Math.max(1, nonNegative(opts.pageBatch) || 1);
  const alliesAndRivals = nonNegative(input.alliesAndRivals);
  const pressureCountries = nonNegative(input.pressureCountries);
  const pressureOrgs = nonNegative(input.pressureOrgs);
  const parents = nonNegative(input.injectsEstimate);

  const perCountry = personasForCountryCount(
    countries,
    opts.personasTotalMax,
    opts.personaFloor,
    opts.personaCap,
  );
  const personas = countries * personaAiCalls(perCountry);
  const building = orgs > 0;
  const dependencies = building ? dependencyCallsFor(teams, orgs, opts) : { map: 0, consequences: 0 };
  // Invention does not add a call: it rides on the first batch, or is the only
  // batch when the trainer named neither allies nor rivals.
  const secondaryPages = batchOrgPages(
    Array.from({ length: alliesAndRivals }, (_, index) => index),
    [],
    pageBatch,
    true,
  ).length;

  const parts = {
    factSheet: building ? 1 : 0,
    footprint: building ? 1 : 0,
    personas,
    spilloverPersonas: building ? spilloverPersonaCalls(input.spilloverCountries) : 0,
    adaptCharters: Math.min(orgs, presetTeams),
    customCharters: customTeams,
    teamStorylines: teams,
    stakeholders: stakeholderCallsFor(orgs, teams),
    commonStakeholders: building ? 1 : 0,
    cast: orgs,
    spokespersons: building ? pressureOrgs : 0,
    backbone: building ? 1 : 0,
    convergence: building ? 1 : 0,
    intel: building && teams >= 2 ? 1 : 0,
    dependencyMap: dependencies.map,
    dependencyConsequences: dependencies.consequences,
    responseBranches: building && parents > 0 ? Math.ceil(parents / RESPONSE_BRANCH_BATCH) : 0,
    moodLadders: moodLadderCalls(ladderStakeholderCount(teams, orgs, pressureOrgs)),
    primaryPage: building ? 1 : 0,
    secondaryPages: building ? secondaryPages : 0,
    pressurePages: building ? pressureCountries : 0,
  };
  const total = Object.values(parts).reduce((sum, n) => sum + n, 0);
  return { ...parts, total };
}

export function estimateBuildCalls(
  input: BuildEstimateInput,
  over?: Partial<BuildEstimateOptions>,
): number {
  return explainBuildCalls(input, over).total;
}
