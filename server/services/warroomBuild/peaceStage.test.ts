import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { env } from '../../env.js';
import { assembleReview } from './assemble.js';
import { activeStages, initialStageStates, nextStage, toView } from './buildCore.js';
import { estimateBuildCalls, explainBuildCalls } from './buildEstimate.js';
import { buildRequestSchema, STAGES, type BuildRow } from './buildTypes.js';
import { validPeaceFeed } from '../generation/peaceFeedFixture.js';
import { runPeaceStage, type PeaceFeedClient } from '../generation/peaceFeedService.js';

const INPUT = {
  countries: 2,
  orgs: 2,
  teams: 4,
  customTeams: 1,
  alliesAndRivals: 9,
  pressureCountries: 2,
  injectsEstimate: 25,
};

function request() {
  return buildRequestSchema.parse({
    crisis_type: 'Battery fire',
    context: 'A V15 recall',
    organisations: [
      {
        display_name: 'Acme',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }],
      },
    ],
  });
}

const orgPage = {
  orgs: [
    {
      org_key: 'primary',
      display_name: 'Acme',
      is_primary: true,
      role: 'protagonist',
      control_mode: 'player',
      facebook: { page_name: 'Acme', page_handle: '@acme', page_bio: 'Breakfast', follower_count: 10 },
      x_twitter: { page_name: 'Acme', page_handle: '@acme_x', page_bio: 'Breakfast', follower_count: 10 },
    },
    {
      org_key: 'rival',
      display_name: 'Rival',
      is_primary: false,
      role: 'antagonist',
      control_mode: 'ai',
      facebook: { page_name: 'Rival', page_handle: '@rival', page_bio: 'Lunch', follower_count: 10 },
      x_twitter: { page_name: 'Rival', page_handle: '@rival_x', page_bio: '', follower_count: 1 },
    },
    {
      org_key: 'watch',
      display_name: 'Watch',
      is_primary: false,
      role: 'pressure',
      control_mode: 'ai',
      facebook: { page_name: 'Watch', page_handle: '@watch', page_bio: 'Union', follower_count: 10 },
      x_twitter: { page_name: 'Watch', page_handle: '@watch_x', page_bio: '', follower_count: 1 },
    },
  ],
};

const personas = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  handle: `@${id}`,
  type: 'npc_public' as const,
  normal_interests: [id === 'a' ? 'cooking' : id],
  name: id,
  personality: '',
  bias: 'none',
  follower_count: 10,
  backstory: '',
  posting_pattern: '',
  specific_claims: [],
}));

function row(): BuildRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'build-1',
    draft_id: 'draft-1',
    created_by: 'user-1',
    pool: 'dev',
    status: 'succeeded',
    current_stage: 'pages',
    stage_states: initialStageStates(),
    request: request(),
    request_hash: 'abc',
    idempotency_key: 'key-1',
    error: null,
    error_code: null,
    cancel_requested_at: null,
    cancel_reason: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    interruptions: 0,
    last_seen_at: now,
    log_count: 0,
    compile_status: null,
    compile_heartbeat_at: null,
    credit_ledger_id: null,
    credit_invoice_id: null,
    scenario_id: null,
    started_at: now,
    finished_at: now,
    created_at: now,
    updated_at: now,
  };
}

describe('peace build stage', { concurrency: false }, () => {
  const previous = env.enablePeaceFeedBuildStage;

  test('assembles a stage feed and raises the estimate by one call plus its retry', async () => {
    env.enablePeaceFeedBuildStage = true;
    try {
      let calls = 0;
      const client: PeaceFeedClient = {
        async complete() {
          calls += 1;
          return validPeaceFeed();
        },
      };
      const output = await runPeaceStage(
        { personas, orgPage, crisisBrief: 'A V15 battery fire forces a recall.' },
        { log: () => undefined },
        client,
      );
      assert.equal(calls, 1);
      assert.equal(output.peace_period?.posts.length, 12);
      const review = assembleReview(request(), { peace: output });
      assert.equal(review.peace_period?.posts.length, 12);
      assert.equal(
        review.peace_period?.posts.some((post) => /recall|battery fire/i.test(post.content)),
        false,
      );

      env.enablePeaceFeedBuildStage = false;
      const flaggedOff = estimateBuildCalls(INPUT);
      assert.equal(explainBuildCalls(INPUT).peaceFeed, undefined);
      env.enablePeaceFeedBuildStage = true;
      const flaggedOn = estimateBuildCalls(INPUT);
      assert.ok(flaggedOn - flaggedOff >= 1 && flaggedOn - flaggedOff <= 2);
      assert.equal(explainBuildCalls(INPUT).peaceFeed, 2);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('flags off leave the stage list, the view and the estimate as they are today', async () => {
    env.enablePeaceFeedBuildStage = false;
    try {
      assert.deepEqual([...activeStages(false)], [...STAGES]);
      assert.deepEqual(Object.keys(initialStageStates()), [...STAGES]);
      const states = initialStageStates();
      for (const stage of STAGES) states[stage] = { status: 'done', attempts: 1 };
      assert.equal(nextStage(states, false), null);
      const view = toView(row(), false);
      assert.deepEqual(Object.keys(view.stages), [...STAGES]);
      assert.equal('peace' in view.stages, false);
      const before = estimateBuildCalls(INPUT);
      assert.equal(explainBuildCalls(INPUT).peaceFeed, undefined);
      assert.equal(estimateBuildCalls(INPUT), before);
      let calls = 0;
      const output = await runPeaceStage(
        { personas, orgPage, crisisBrief: 'A V15 battery fire forces a recall.' },
        { log: () => undefined },
        {
          async complete() {
            calls += 1;
            return validPeaceFeed();
          },
        },
      );
      assert.equal(calls, 0);
      assert.equal(output.peace_period ?? null, null);
      const review = assembleReview(request(), {});
      assert.equal(review.peace_period, undefined);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });
});
