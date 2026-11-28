import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { env } from '../../env.js';
import { noteAiCall, withAiCallCount } from '../../lib/aiCallScope.js';
import type { PeaceFeed } from '../../../shared/peaceFeed.js';
import { PEACE_LEAK_TERM_RULE, PEACE_POST_MIN } from '../generation/peaceFeedCore.js';
import type { PeaceFeedClient } from '../generation/peaceFeedService.js';
import { emptyBriefDiff } from './affectedLayers.js';
import { runDeltaBuild, listDeltaCalls } from './deltaBuildRun.js';
import type { DeltaBuildContext, DeltaGenerators } from './deltaBuildTypes.js';
import { delta, snapshot, snapshotOrg, snapshotTeam } from './fixtures/remapFixtures.js';
import type { RemapPlan } from './remapPlanner.js';
import type { SetupDelta } from './setupDeltaCore.js';

function emptyPlan(partial: Partial<RemapPlan> = {}): RemapPlan {
  return {
    teams: { retire: partial.teams?.retire ?? [], successors: [] },
    injects: { rewrite_in_place: [], cow: [], retire: [] },
    initial_state: { patch: [], move_to_retired: [] },
    scheduled_sessions: [],
    orphans: [],
    warnings: [],
    applicable: true,
    phases: [],
    primary_swap: null,
    vacated_countries: [],
  };
}

function acme() {
  return snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      is_primary: true,
      teams: [
        snapshotTeam({ team_uid: 'team-comms', team_name: 'Communications', is_public_voice: true }),
        snapshotTeam({ team_uid: 'team-legal', team_name: 'Legal' }),
      ],
    }),
  ], {
    competitors: [
      {
        org_uid: 'uid-rival',
        org_key: 'org_rival',
        name: 'Rival',
        country: 'Singapore',
        description: 'They want the harbour contract',
        auto_generated: false,
      },
    ],
  });
}

function context(change: Partial<SetupDelta>, plan: RemapPlan = emptyPlan()): DeltaBuildContext {
  return {
    edit_number: 1,
    delta: delta(change),
    plan,
    edited: acme(),
    baseline_crisis: { crisis_type: 'Plant fire', context: 'Night shift' },
    injects: [],
    teams: [
      { team_uid: 'team-comms', team_name: 'Communications', org_key: 'primary' },
      { team_uid: 'team-legal', team_name: 'Legal', org_key: 'primary' },
    ],
    stakeholders: [],
    personas: [],
    fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
    fact_sheet_trainer_edited: false,
    briefing: '',
    briefing_trainer_edited: false,
    narrative: { title: 'Fire', description: 'A fire', briefing: '' },
    objectives: [],
    pages: [],
    taken_handles: [],
    taken_emails: [],
    taken_stakeholder_ids: [],
    active_keys: [],
    page_batch_size: 4,
  };
}

function recording() {
  const calls: string[] = [];
  const note = (name: string) => {
    calls.push(name);
    noteAiCall();
  };
  const generators = {
    async briefDiff() {
      note('briefDiff');
      return emptyBriefDiff('cosmetic');
    },
    async reviseFactSheet() {
      note('reviseFactSheet');
      return { confirmed_facts: [], unconfirmed_claims: [] };
    },
    async generatePersonas(input) {
      note(`generatePersonas:${input.country}`);
      return [];
    },
    async generatePersonaGroups() {
      note('generatePersonaGroups');
      return [];
    },
    async generateCharter(input) {
      note(`generateCharter:${input.teamName}`);
      return { team_name: input.teamName, mission: input.teamName, responsibilities: [] };
    },
    async generateTeamStoryline(input) {
      note(`generateTeamStoryline:${input.teamName}`);
      return [
        {
          title: `${input.teamName} beat`,
          content: 'A new beat',
          type: 'email',
          severity: 'medium',
          inject_scope: 'team_specific',
          target_teams: [input.teamName],
          requires_response: false,
          delivery_config: { app: 'email' },
        },
      ];
    },
    async generateStakeholders(input) {
      note(`generateStakeholders:${input.orgKey}`);
      return { stakeholders: [], injects: [] };
    },
    async generateSpokesperson(input) {
      note(`generateSpokesperson:${input.orgKey}`);
      return { stakeholder: null, injects: [] };
    },
    async reviseLayer(input) {
      note(`reviseLayer:${input.layer}`);
      return { decisions: [], new_injects: [] };
    },
    async reviseStakeholderText() {
      note('reviseStakeholderText');
      return [];
    },
    async convergenceDelta() {
      note('convergenceDelta');
      return { shared: [], gates: [] };
    },
    async reviseNarrative() {
      note('reviseNarrative');
      return { narrative: { title: '', description: '', briefing: '' }, objectives: [] };
    },
    async regenerateBranches(input) {
      note(`regenerateBranches:${input.parentKey}`);
      return [];
    },
    async generatePages(input) {
      note(`generatePages:${input.orgs.map((org) => org.org_key).join(',')}`);
      return input.orgs.map((org) => ({ org_key: org.org_key }));
    },
    async revisePageHistory(input) {
      note(`revisePageHistory:${input.orgKey}`);
      return [];
    },
  } satisfies DeltaGenerators;
  return { calls, generators };
}

describe('delta stages', () => {
  test('an added team calls only the add-team generators', async () => {
    const { calls, generators } = recording();
    const result = await runDeltaBuild(
      context({ added_teams: [{ org_key: 'primary', team_name: 'Audit' }] }),
      generators,
    );
    assert.deepEqual(calls, ['generateCharter:Audit', 'generateTeamStoryline:Audit', 'convergenceDelta']);
    assert.equal(result.storyline.generated.charters[0]?.team_name, 'Audit');
    assert.equal(result.storyline.generated.team_storylines.Audit?.[0]?.title, 'Audit beat');
    assert.equal(result.characters.skipped, true);
    assert.equal(result.pages.skipped, true);
  });

  test('a cosmetic brief change plus one added team is the add-team calls plus the diff', async () => {
    const { calls, generators } = recording();
    const built = context({
      brief_changed: true,
      added_teams: [{ org_key: 'primary', team_name: 'Audit' }],
    });
    const { calls: counted } = await withAiCallCount(() => runDeltaBuild(built, generators));
    assert.deepEqual(calls, [
      'briefDiff',
      'generateCharter:Audit',
      'generateTeamStoryline:Audit',
      'convergenceDelta',
    ]);
    assert.equal(counted, 4);
  });

  test('a text-only delta makes no AI calls and updates stance', async () => {
    const { calls, generators } = recording();
    const result = await runDeltaBuild(
      context({ changed_text: [{ key: 'org_rival', field: 'description' }] }),
      generators,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(result.pages.text_updates, [
      { org_key: 'org_rival', field: 'stance', value: 'They want the harbour contract' },
    ]);
  });

  test('removal alone makes no AI calls', async () => {
    const { calls, generators } = recording();
    await runDeltaBuild(
      context({ removed_teams: [{ team_uid: 'team-legal', team_name: 'Legal' }] }),
      generators,
    );
    assert.deepEqual(calls, []);
  });

  test('rename alone makes no AI calls, including when the plan retires the old team row', async () => {
    const { calls, generators } = recording();
    const renamed = context(
      { renamed_teams: [{ team_uid: 'team-legal', from: 'Legal', to: 'Counsel' }] },
      emptyPlan({
        teams: {
          retire: [
            {
              source_id: 'row-legal',
              team_uid: 'team-legal',
              team_name: 'Legal',
              org_key: 'primary',
              reason: 'renamed',
            },
          ],
          successors: [],
        },
      }),
    );
    assert.deepEqual(listDeltaCalls(renamed, null), []);
    await runDeltaBuild(renamed, generators);
    assert.deepEqual(calls, []);
  });

  test('a new country and an added rival call personas and one page batch, not the old teams', async () => {
    const { calls, generators } = recording();
    await runDeltaBuild(
      context({
        new_countries: ['Malaysia'],
        added_rivals: ['org_rival_2'],
        relocated_orgs: [{ org_key: 'primary', from_country: 'Singapore', to_country: 'Malaysia' }],
      }),
      generators,
    );
    assert.equal(calls.includes('generatePersonas:Malaysia'), true);
    assert.equal(calls.includes('generatePages:org_rival_2'), true);
    assert.equal(calls.includes('reviseLayer:team:team-comms'), true);
    assert.equal(calls.includes('reviseLayer:team:team-legal'), true);
    assert.equal(calls.includes('revisePageHistory:primary'), true);
    assert.equal(calls.includes('briefDiff'), false);
    assert.equal(calls.includes('generateTeamStoryline:Communications'), false);
  });
});

function storedPeace(): PeaceFeed {
  return {
    version: 1,
    seconds: 300,
    enabled: true,
    leak_terms: ['recall'],
    posts: [
      {
        ref: 'P1',
        author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
        platform: 'facebook',
        post_format: 'text',
        content: 'Saturday breakfast',
        media_description: '',
        offset_seconds: 20,
        comments: [{ author_handle: '@sam', content: 'See you there', offset_seconds: 40 }],
      },
    ],
  };
}

describe('peace feed on a setup-edit delta', { concurrency: false }, () => {
  const previous = env.enablePeaceFeedBuildStage;

  test('with the flag off the delta matches a scenario that has no peace feed', async () => {
    env.enablePeaceFeedBuildStage = false;
    const prompts: string[] = [];
    const client: PeaceFeedClient = {
      async complete(request) {
        prompts.push(request.system);
        throw new Error('peace model must not be called');
      },
    };
    const change = { brief_changed: true, added_orgs: ['org_new'] };
    const withPeace = context(change);
    withPeace.peace_period = storedPeace();
    withPeace.peaceClient = client;
    withPeace.org_page = {
      orgs: [
        {
          org_key: 'org_new',
          display_name: 'Newco',
          role: 'protagonist',
          facebook: { page_handle: '@newco', page_name: 'Newco', page_bio: '' },
        },
      ],
    };
    try {
      const { generators } = recording();
      const { generators: plainGenerators } = recording();
      const edited = await runDeltaBuild(withPeace, generators);
      const plain = await runDeltaBuild(context(change), plainGenerators);
      assert.equal('peace_period' in edited.pages, false);
      assert.deepEqual(edited.pages, plain.pages);
      assert.deepEqual(prompts, []);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('a brief change regenerates leak terms only', async () => {
    env.enablePeaceFeedBuildStage = true;
    const feed = storedPeace();
    const prompts: Array<{ system: string; user: string }> = [];
    const client: PeaceFeedClient = {
      async complete(request) {
        prompts.push(request);
        return { leak_terms: ['ammonia', 'night vent'] };
      },
    };
    const built = context({ brief_changed: true });
    built.peace_period = feed;
    built.peaceClient = client;
    built.edited = {
      ...built.edited,
      crisis: { ...built.edited.crisis, crisis_type: 'Ammonia vent', context: 'Night shift' },
    };
    try {
      const { calls, generators } = recording();
      const result = await runDeltaBuild(built, generators);
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.system.includes(PEACE_LEAK_TERM_RULE), true);
      assert.equal(prompts[0]?.system.includes(`Write ${PEACE_POST_MIN}`), false);
      assert.equal(prompts[0]?.user.includes('Ammonia vent'), true);
      assert.equal(prompts[0]?.user.includes('Saturday breakfast'), false);
      assert.equal(result.pages.peace_period?.posts, feed.posts);
      assert.deepEqual(result.pages.peace_period?.leak_terms, ['ammonia', 'night vent']);
      assert.equal(calls.includes('generatePages'), false);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('posts for an added organisation are merged and existing posts stay', async () => {
    env.enablePeaceFeedBuildStage = true;
    const feed = storedPeace();
    let calls = 0;
    const client: PeaceFeedClient = {
      async complete() {
        calls += 1;
        return {
          posts: [
            {
              author: { kind: 'page', org_key: 'org_new', platform: 'facebook' },
              content: 'Grand opening Friday.',
              offset_seconds: 30,
              comments: [{ author_handle: '@sam', content: 'I will be there', offset_seconds: 50 }],
            },
            {
              author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
              content: 'This would replace breakfast.',
              offset_seconds: 35,
            },
            {
              author: { kind: 'page', org_key: 'org_new', platform: 'facebook' },
              content: 'Please recall the opening.',
              offset_seconds: 45,
            },
          ],
        };
      },
    };
    const built = context({ added_orgs: ['org_new'] });
    built.peace_period = feed;
    built.peaceClient = client;
    built.org_page = {
      orgs: [
        {
          org_key: 'org_new',
          display_name: 'Newco',
          role: 'protagonist',
          facebook: { page_handle: '@newco', page_name: 'Newco', page_bio: '' },
        },
      ],
    };
    try {
      const result = await runDeltaBuild(built, recording().generators);
      const posts = result.pages.peace_period?.posts ?? [];
      assert.equal(calls, 1);
      assert.equal(posts[0], feed.posts[0]);
      assert.equal(posts.length, 2);
      assert.equal(posts[1]?.content, 'Grand opening Friday.');
      assert.equal(posts[1]?.author.kind === 'page' && posts[1].author.org_key, 'org_new');
      assert.deepEqual(result.pages.peace_period?.leak_terms, ['recall']);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('a brief change keeps the posts the planner already rewrote', async () => {
    env.enablePeaceFeedBuildStage = true;
    const feed = storedPeace();
    const rewrittenPost = {
      ...feed.posts[0],
      author: { kind: 'page' as const, org_key: 'org_acme_sg', platform: 'facebook' },
    };
    const rewritten = { ...feed, posts: [rewrittenPost] };
    const built = context({ brief_changed: true });
    built.peace_period = feed;
    built.plan = {
      ...built.plan,
      initial_state: {
        patch: [{ op: 'replace', path: '/peace_period', value: rewritten }],
        move_to_retired: [],
      },
    };
    built.peaceClient = {
      async complete() {
        return { leak_terms: ['ammonia'] };
      },
    };
    try {
      const result = await runDeltaBuild(built, recording().generators);
      assert.equal(result.pages.peace_period?.posts[0], rewrittenPost);
      assert.equal(result.pages.peace_period?.posts[0]?.content, 'Saturday breakfast');
      assert.deepEqual(result.pages.peace_period?.leak_terms, ['ammonia']);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('a peace failure does not fail the delta or drop existing posts', async () => {
    env.enablePeaceFeedBuildStage = true;
    const built = context({ brief_changed: true, added_orgs: ['org_new'] });
    built.peace_period = storedPeace();
    built.org_page = {
      orgs: [
        {
          org_key: 'org_new',
          display_name: 'Newco',
          role: 'protagonist',
          facebook: { page_handle: '@newco', page_name: 'Newco', page_bio: '' },
        },
      ],
    };
    built.peaceClient = {
      async complete() {
        throw new Error('model down');
      },
    };
    try {
      const result = await runDeltaBuild(built, recording().generators);
      assert.equal('peace_period' in result.pages, false);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });
});
