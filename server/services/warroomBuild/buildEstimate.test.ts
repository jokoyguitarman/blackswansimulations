import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { limitConcurrency, withConcurrencyLimit } from '../../lib/limitConcurrency.js';
import { batchOrgPages } from '../orgPageBatching.js';
import { personaAiCalls, personasForCountryCount } from '../personaBudget.js';
import {
  generateAllTeamStorylines,
  type FactSheet,
  type TeamDef,
} from '../socialCrisisGeneratorService.js';
import {
  estimateBuildCalls,
  stakeholderCallsFor,
  type BuildEstimateInput,
} from './buildEstimate.js';

const FIXTURE: BuildEstimateInput = {
  countries: 2,
  orgs: 2,
  teams: 4,
  customTeams: 1,
  alliesAndRivals: 9,
  pressureCountries: 2,
  injectsEstimate: 25,
};

/** Hand-counted from the pipeline's call sites for FIXTURE at the default budgets. */
const FIXTURE_CALLS = 40;

async function runStubbedPipeline(input: BuildEstimateInput): Promise<number> {
  let calls = 0;
  const ai = async () => {
    calls += 1;
  };
  if (input.orgs <= 0) return 0;
  await ai();
  await ai();
  const target = personasForCountryCount(input.countries, env.socialPersonasTotalMax);
  const perCountry = personaAiCalls(target);
  for (let country = 0; country < input.countries; country++) {
    for (let n = 0; n < perCountry; n++) await ai();
  }
  const custom = Math.min(input.teams, Math.max(0, input.customTeams));
  const preset = input.teams - custom;
  for (let n = 0; n < Math.min(input.orgs, preset); n++) await ai();
  for (let n = 0; n < custom; n++) await ai();
  for (let n = 0; n < input.teams; n++) await ai();
  for (let n = 0; n < stakeholderCallsFor(input.orgs, input.teams); n++) await ai();
  await ai();
  for (let n = 0; n < input.orgs; n++) await ai();
  await ai();
  await ai();
  if (input.teams >= 2) await ai();
  if (input.teams >= 2) {
    const map = input.teams <= 16 || input.orgs <= 1 ? 1 : input.orgs + 1;
    for (let n = 0; n < map; n++) await ai();
    const edges = Math.min(Math.ceil(input.teams * 1.5), 3 * input.teams);
    for (let n = 0; n < Math.ceil(edges / 8); n++) await ai();
  }
  if (input.injectsEstimate > 0) {
    for (let n = 0; n < Math.ceil(input.injectsEstimate / 10); n++) await ai();
  }
  await ai();
  const pages = batchOrgPages(
    Array.from({ length: input.alliesAndRivals }, (_, index) => index),
    [],
    env.warroomOrgPageBatch,
    true,
  );
  for (const _batch of pages) await ai();
  for (let n = 0; n < input.pressureCountries; n++) await ai();
  return calls;
}

describe('estimateBuildCalls', () => {
  test('grows monotonically with teams and matches the stubbed pipeline fixture', async () => {
    const previousMax = env.socialPersonasTotalMax;
    const previousBatch = env.warroomOrgPageBatch;
    env.socialPersonasTotalMax = 800;
    env.warroomOrgPageBatch = 4;
    try {
      const base: BuildEstimateInput = {
        countries: 3,
        orgs: 3,
        teams: 6,
        customTeams: 0,
        alliesAndRivals: 2,
        pressureCountries: 1,
        injectsEstimate: 10,
      };
      let previous = estimateBuildCalls(base);
      for (let teams = 7; teams <= 40; teams++) {
        const next = estimateBuildCalls({ ...base, teams });
        assert.ok(next >= previous + 1, `teams ${teams}: ${next} did not grow from ${previous}`);
        previous = next;
      }
      assert.equal(estimateBuildCalls(FIXTURE), FIXTURE_CALLS);
      assert.equal(await runStubbedPipeline(FIXTURE), estimateBuildCalls(FIXTURE));
    } finally {
      env.socialPersonasTotalMax = previousMax;
      env.warroomOrgPageBatch = previousBatch;
    }
  });

  test('a stubbed 30-org, 8-team build never exceeds WARROOM_GEN_CONCURRENCY calls in flight', async () => {
    const previousConcurrency = env.warroomGenConcurrency;
    const previousEnabled = env.aiEnabled;
    const previousKey = env.openAiApiKey;
    const previousLevel = logger.level;
    const realFetch = globalThis.fetch;
    env.warroomGenConcurrency = 4;
    env.aiEnabled = true;
    env.openAiApiKey = 'test-key-not-a-secret';
    logger.level = 'silent';
    let inFlight = 0;
    let max = 0;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"injects":[]}' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const teams: TeamDef[] = Array.from({ length: 8 }, (_, index) => ({
      team_name: `Team ${index + 1}`,
      team_description: 'Own this lane of the crisis.',
      min_participants: 1,
      max_participants: 4,
    }));
    const factSheet: FactSheet = {
      confirmed_facts: ['One confirmed fact'],
      unconfirmed_claims: [],
    };
    const crisis = {
      crisisType: 'product recall',
      location: 'Singapore',
      country: 'Singapore',
      context: 'A batch failed.',
      duration: 60,
    };
    try {
      await withConcurrencyLimit(env.warroomGenConcurrency, () =>
        limitConcurrency(
          Array.from({ length: 30 }, (_, index) => index),
          env.warroomGenConcurrency,
          () => generateAllTeamStorylines(teams, crisis, [], factSheet),
        ),
      );
      assert.equal(fetches, 30 * 8);
      assert.ok(max <= env.warroomGenConcurrency);
      assert.ok(max >= 2);
    } finally {
      globalThis.fetch = realFetch;
      env.warroomGenConcurrency = previousConcurrency;
      env.aiEnabled = previousEnabled;
      env.openAiApiKey = previousKey;
      logger.level = previousLevel;
    }
  });
});
