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

export interface BuildEstimateInput {
  countries: number;
  orgs: number;
  teams: number;
  customTeams: number;
  alliesAndRivals: number;
  pressureCountries: number;
  /** Branch-parent injects. Batches of {@link RESPONSE_BRANCH_BATCH}. */
  injectsEstimate: number;
}

export interface BuildEstimateOptions {
  personasTotalMax: number;
  pageBatch: number;
  personaCap: number;
  personaFloor: number;
}

export interface BuildCallBreakdown {
  factSheet: number;
  footprint: number;
  personas: number;
  adaptCharters: number;
  customCharters: number;
  teamStorylines: number;
  stakeholders: number;
  commonStakeholders: number;
  cast: number;
  backbone: number;
  convergence: number;
  intel: number;
  responseBranches: number;
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
  };
}

/**
 * Expected AI calls for one full social-crisis build. There is no enforced
 * budget (decision O2); this is the number shown before Build.
 *
 * Assumptions, because the input is counts rather than a roster:
 * - the key-voice call returns 14 personas, then background batches fill the country target;
 * - spillover countries and mood-ladder calls are not in the input and are not counted;
 * - one adapt-charter call per organisation that has a preset team, presets spread
 *   one per org (executives are not distinguished);
 * - one cast call per organisation (a fresh cast has carrier gaps);
 * - one pressure-page call per pressure country (that country's groups fit in one batch);
 * - no named rivals (`alliesAndRivals === 0`) still costs one call to invent a rival;
 * - stakeholder and branch calls assume the first attempt succeeds.
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
  const parents = nonNegative(input.injectsEstimate);

  const perCountry = personasForCountryCount(
    countries,
    opts.personasTotalMax,
    opts.personaFloor,
    opts.personaCap,
  );
  const personas = countries * personaAiCalls(perCountry);
  const building = orgs > 0;
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
    adaptCharters: Math.min(orgs, presetTeams),
    customCharters: customTeams,
    teamStorylines: teams,
    stakeholders: stakeholderCallsFor(orgs, teams),
    commonStakeholders: building ? 1 : 0,
    cast: orgs,
    backbone: building ? 1 : 0,
    convergence: building ? 1 : 0,
    intel: building && teams >= 2 ? 1 : 0,
    responseBranches: building && parents > 0 ? Math.ceil(parents / RESPONSE_BRANCH_BATCH) : 0,
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
