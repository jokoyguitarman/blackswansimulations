import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { env } from '../../env.js';
import { noteAiCall, withAiCallCount } from '../../lib/aiCallScope.js';
import type { PeaceFeed } from '../../../shared/peaceFeed.js';
import {
  PEACE_FEED_EMPTY_WARNING,
  PEACE_LEAK_TERM_RULE,
  PEACE_POST_MAX,
  PEACE_POST_MIN,
  usablePeaceFeed,
} from '../generation/peaceFeedCore.js';
import type { PeaceFeedClient } from '../generation/peaceFeedService.js';
import { emptyBriefDiff, type BriefDiff } from './affectedLayers.js';
import { runDeltaBuild, listDeltaCalls } from './deltaBuildRun.js';
import type { DeltaBuildContext, DeltaGenerators, DeltaInject } from './deltaBuildTypes.js';
import {
  generateDependencyDelta,
  type DependencyChatRequest,
} from '../generation/teamDependencyService.js';
import type { GenerationTeam } from '../generation/teamDependenciesCore.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';
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
  return snapshot(
    [
      snapshotOrg({
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        is_primary: true,
        teams: [
          snapshotTeam({
            team_uid: 'team-comms',
            team_name: 'Communications',
            is_public_voice: true,
          }),
          snapshotTeam({ team_uid: 'team-legal', team_name: 'Legal' }),
        ],
      }),
    ],
    {
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
    },
  );
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
    team_dependencies: [],
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
    async dependencyDelta(input) {
      const names = input.addedTeams.map((team) => team.team_name).join(',');
      note(`dependencyDelta:${names}`);
      const added = input.addedTeams[0]?.team_name ?? 'Added';
      return {
        edges: [
          {
            id: 'dep_added_team',
            kind: 'information',
            upstream: { team_uid: null, team_name: added },
            downstream: [{ team_uid: 'team-legal', team_name: 'Legal' }],
            deliverable: `${added} owes Legal a confirmed figure`,
            why: 'Legal cannot advise without it',
            due: { by_minute: 20 },
            broken_when: { all: ['team_silent:10|team=@upstream'] },
            met_when: null,
            lag_minutes: 5,
            severity: 'medium',
            consequence_keys: [],
            source: 'war_room',
          },
        ],
        consequences: [],
        positives: [],
        asks: [],
      };
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
    assert.deepEqual(calls, [
      'generateCharter:Audit',
      'generateTeamStoryline:Audit',
      'dependencyDelta:Audit',
      'convergenceDelta',
    ]);
    assert.ok(result.storyline.generated.dependency_edges.length >= 1);
    assert.equal(result.storyline.generated.dependency_edges[0]?.upstream.team_name, 'Audit');
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
      'dependencyDelta:Audit',
      'convergenceDelta',
    ]);
    assert.equal(counted, 5);
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

  test('a removal that already has dependencies makes no AI calls', async () => {
    const { calls, generators } = recording();
    const built = context({ removed_teams: [{ team_uid: 'team-legal', team_name: 'Legal' }] });
    built.team_dependencies = [existingEdge()];
    built.injects = [
      deltaInject('inj-dep', 'dependency:dep_legal_comms', 'Legal still owes the figure'),
    ];
    await runDeltaBuild(built, generators);
    assert.deepEqual(calls, []);
    assert.deepEqual(listDeltaCalls(built, null), []);
  });

  test('a brief revision does not call a dependency layer or a branch layer on its own', () => {
    const built = context({ brief_changed: true });
    built.injects = [
      deltaInject('inj-team', 'team:team-legal', 'The chlorine drum vented overnight.'),
      deltaInject(
        'inj-dep',
        'dependency:dep_legal_comms',
        'The chlorine drum is still unconfirmed.',
      ),
      deltaInject('inj-branch', 'branch:harbour_note', 'The chlorine drum reply.'),
    ];
    const diff: BriefDiff = {
      ...emptyBriefDiff('facts'),
      fact_changes: [{ kind: 'change', old: 'chlorine drum', new: 'ammonia drum' }],
    };
    const calls = listDeltaCalls(built, diff);
    assert.equal(
      calls.some((call) => call.op === 'revise_layer' && call.layer === 'team:team-legal'),
      true,
    );
    assert.equal(
      calls.some((call) => call.op === 'revise_layer' && call.layer.startsWith('dependency:')),
      false,
    );
    assert.equal(
      calls.some((call) => call.op === 'revise_layer' && call.layer.startsWith('branch:')),
      false,
    );
  });

  test('an added team gets an edge and only the calls that touch it are made', async () => {
    const acme: GenerationTeam[] = [
      {
        team_name: 'Communications',
        team_uid: 'uid-comms',
        org_key: 'acme',
        org_name: 'Acme',
        playable: true,
      },
      {
        team_name: 'Legal',
        team_uid: 'uid-legal',
        org_key: 'acme',
        org_name: 'Acme',
        playable: true,
      },
      {
        team_name: 'Audit',
        team_uid: 'uid-audit',
        org_key: 'acme',
        org_name: 'Acme',
        playable: true,
      },
    ];
    const other: GenerationTeam[] = [
      {
        team_name: 'Finance',
        team_uid: 'uid-fin',
        org_key: 'other',
        org_name: 'Other Org',
        playable: true,
      },
      {
        team_name: 'Treasury',
        team_uid: 'uid-tre',
        org_key: 'other',
        org_name: 'Other Org',
        playable: true,
      },
    ];
    const prompts: string[] = [];
    const client = {
      async complete(request: DependencyChatRequest) {
        prompts.push(`${request.label}\n${request.user}`);
        if (request.label === 'generator.dependencyMap') {
          if (request.user.includes('inside Other Org')) {
            return { edges: [modelEdge('dep_finance_treasury', 'Finance', 'Treasury')] };
          }
          if (request.user.includes('inside Acme')) {
            return {
              edges: [
                modelEdge('dep_audit_legal', 'Audit', 'Legal'),
                modelEdge('dep_legal_comms', 'Legal', 'Communications'),
              ],
            };
          }
          return { edges: [modelEdge('dep_audit_finance', 'Audit', 'Finance')] };
        }
        const described = JSON.parse(
          request.user.split('Dependencies:\n')[1]?.split('\n')[0] ?? '[]',
        ) as Array<{ id: string; downstream: string[] }>;
        return {
          consequences: described.flatMap((edge) =>
            edge.downstream.map((downstream) => ({
              edge_id: edge.id,
              downstream,
              title: `${downstream} hears about the gap`,
              content: 'The figure has not arrived.',
              app: 'email',
            })),
          ),
          positives: [],
        };
      },
    };
    const result = await generateDependencyDelta(
      {
        teams: [...acme, ...other],
        addedTeams: [acme[2] as GenerationTeam],
        existingEdges: [existingEdge()],
        crisis: { crisisType: 'Plant fire', duration: 60 },
        facts: ['Bay 3 is closed'],
        storylines: {},
      },
      { client, concurrency: 2, mapBatchTeams: 1, consequenceBatch: 8 },
    );
    const mapPrompts = prompts.filter((prompt) => prompt.startsWith('generator.dependencyMap'));
    const consequencePrompts = prompts.filter((prompt) =>
      prompt.startsWith('generator.dependencyConsequences'),
    );
    assert.equal(mapPrompts.length, 2);
    assert.equal(
      mapPrompts.some((prompt) => prompt.includes('inside Other Org')),
      false,
    );
    assert.equal(
      mapPrompts.every((prompt) => prompt.includes('Audit')),
      true,
    );
    assert.ok(result.team_dependencies.edges.length >= 1);
    assert.equal(
      result.team_dependencies.edges.every(
        (edge) =>
          edge.upstream.team_name === 'Audit' ||
          edge.downstream.some((team) => team.team_name === 'Audit'),
      ),
      true,
    );
    assert.equal(
      result.team_dependencies.edges.some((edge) => edge.id === 'dep_legal_comms'),
      false,
    );
    assert.equal(consequencePrompts.length, 1);
    assert.equal(consequencePrompts[0]?.includes('dep_audit_legal'), true);
    assert.equal(consequencePrompts[0]?.includes('dep_finance_treasury'), false);
    assert.equal(consequencePrompts[0]?.includes('dep_legal_comms'), false);
    assert.ok(result.consequences.length >= 1);
    assert.equal(
      result.consequences.some(
        (inject) => inject.delivery_config.gen?.layer === 'dependency:dep_audit_legal',
      ),
      true,
    );
  });

  test('a colliding dependency id is renamed and existing edges count toward the cap', async () => {
    const teams: GenerationTeam[] = [
      { team_name: 'Communications', team_uid: 'uid-comms', org_key: 'acme', org_name: 'Acme', playable: true },
      { team_name: 'Legal', team_uid: 'uid-legal', org_key: 'acme', org_name: 'Acme', playable: true },
      { team_name: 'Audit', team_uid: 'uid-audit', org_key: 'acme', org_name: 'Acme', playable: true },
    ];
    const client = {
      async complete(request: DependencyChatRequest) {
        if (request.label !== 'generator.dependencyMap') return { consequences: [], positives: [] };
        return {
          edges: [
            modelEdge('dep_audit_legal', 'Audit', 'Legal'),
            modelEdge('dep_audit_comms', 'Audit', 'Communications'),
          ],
        };
      },
    };
    const result = await generateDependencyDelta(
      {
        teams,
        addedTeams: [teams[2] as GenerationTeam],
        existingEdges: [
          existingEdge(),
          { ...existingEdge(), id: 'dep_audit_legal' },
        ],
        idSources: [
          {
            conditions_to_appear: { all: ['dependency_broken:dep_retired_edge'] },
            delivery_config: { cause: { kind: 'dependency', dep_id: 'dep_audit_comms' } },
          },
        ],
        crisis: { crisisType: 'Plant fire', duration: 60 },
        facts: [],
        storylines: {},
      },
      { client, mapBatchTeams: 16, upstreamPerTeam: 1 },
    );
    const ids = result.team_dependencies.edges.map((edge) => edge.id);
    assert.equal(ids.includes('dep_audit_legal'), false);
    assert.equal(ids.includes('dep_audit_comms'), false);
    assert.equal(
      result.team_dependencies.edges.some((edge) => edge.downstream[0]?.team_name === 'Legal'),
      true,
    );
    assert.equal(
      result.team_dependencies.edges.some(
        (edge) => edge.downstream[0]?.team_name === 'Communications',
      ),
      false,
      'Communications already has its upstream cap from the existing edge',
    );
  });

  test('a re-keyed ask rewrites the edge condition and due key', async () => {
    const { generators } = recording();
    const custom: DeltaGenerators = {
      ...generators,
      async dependencyDelta() {
        return {
          edges: [
            {
              ...existingEdge(),
              id: 'dep_audit_ask',
              upstream: { team_uid: 'uid-audit', team_name: 'Audit' },
              downstream: [{ team_uid: 'uid-legal', team_name: 'Legal' }],
              broken_when: { all: ['unresponded:audit_ask:10|team=@upstream'] },
              met_when: { all: ['responded_relevant:audit_ask|team=@upstream'] },
              due: { after_inject_key: 'audit_ask', within_minutes: 10 },
            },
          ],
          consequences: [],
          positives: [],
          asks: [
            {
              title: 'Ask Audit',
              content: 'Send the figure',
              type: 'email',
              severity: 'medium',
              inject_scope: 'team_specific',
              target_teams: ['Audit'],
              delivery_config: {
                app: 'email',
                inject_key: 'audit_ask',
                gen: { layer: 'dependency:dep_audit_ask' },
              },
              gen_layer: 'dependency:dep_audit_ask',
            },
          ],
        };
      },
    };
    const built = context({ added_teams: [{ org_key: 'primary', team_name: 'Audit' }] });
    built.active_keys = ['audit_ask'];
    const result = await runDeltaBuild(built, custom);
    const edge = result.storyline.generated.dependency_edges[0];
    const ask = result.storyline.generated.team_storylines.Audit?.find((inject) =>
      inject.title.includes('Ask Audit'),
    );
    const askKey = ask?.delivery_config.inject_key;
    assert.equal(typeof askKey, 'string');
    assert.notEqual(askKey, 'audit_ask');
    assert.equal(edge?.due && 'after_inject_key' in edge.due && edge.due.after_inject_key, askKey);
    const appear = edge?.broken_when && 'all' in edge.broken_when ? edge.broken_when.all[0] : '';
    assert.equal(appear, `unresponded:${askKey}:10|team=@upstream`);
    const met = edge?.met_when && 'all' in edge.met_when ? edge.met_when.all[0] : '';
    assert.equal(met, `responded_relevant:${askKey}|team=@upstream`);
  });
});

function existingEdge(): TeamDependencyEdge {
  return {
    id: 'dep_legal_comms',
    kind: 'information',
    upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
    downstream: [{ team_uid: 'uid-comms', team_name: 'Communications' }],
    deliverable: 'Confirmed headcount',
    why: 'Communications cannot publish a figure without it',
    due: { by_minute: 20 },
    broken_when: { all: ['team_silent:10|team=@upstream'] },
    met_when: null,
    lag_minutes: 5,
    severity: 'medium',
    consequence_keys: [],
    source: 'war_room',
  };
}

function modelEdge(id: string, upstream: string, downstream: string) {
  return {
    id,
    kind: 'information',
    upstream,
    downstream: [downstream],
    deliverable: `${upstream} owes ${downstream} a figure`,
    why: 'The other team cannot finish its own job',
    signals: [{ template: 'silent', minutes: 10 }],
    met_signal: null,
    lag_minutes: 5,
    severity: 'medium',
  };
}

function deltaInject(id: string, layer: string, content: string): DeltaInject {
  return {
    id,
    inject_key: id,
    layer,
    title: content,
    content,
    trigger_time_minutes: 10,
    delivery_config: { inject_key: id, gen: { layer } },
    generation_source: 'war_room',
    provenance: 'ai_owned',
    has_history: false,
    requires_response: false,
    target_teams: ['Legal'],
    type: 'email',
    severity: 'medium',
    inject_scope: 'team_specific',
    app: 'email',
  };
}

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
      assert.equal(result.pages.skipped, false);
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
    built.personas = [
      {
        handle: '@sam',
        name: 'Sam',
        type: 'npc_public',
        personality: '',
        bias: '',
        follower_count: 1,
        backstory: '',
        posting_pattern: '',
        specific_claims: [],
        normal_interests: ['breakfast'],
      },
    ];
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
    const warnings: string[] = [];
    built.peaceClient = {
      async complete() {
        throw new Error('model down');
      },
    };
    try {
      const result = await runDeltaBuild(built, recording().generators, {
        warn: (message) => warnings.push(message),
      });
      assert.equal('peace_period' in result.pages, false);
      assert.deepEqual(warnings, [PEACE_FEED_EMPTY_WARNING, PEACE_FEED_EMPTY_WARNING]);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('a full feed does not ask for more posts', async () => {
    env.enablePeaceFeedBuildStage = true;
    const posts = Array.from({ length: PEACE_POST_MAX }, (_, index) => ({
      ref: `P${index + 1}`,
      author: { kind: 'page' as const, org_key: 'primary', platform: 'facebook' },
      platform: 'facebook',
      post_format: 'text',
      content: `Ordinary note ${index + 1}`,
      media_description: '',
      offset_seconds: 20,
      comments: [],
    }));
    let calls = 0;
    const built = context({ added_orgs: ['org_new'] });
    built.peace_period = { ...storedPeace(), posts };
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
        calls += 1;
        return { posts: [] };
      },
    };
    try {
      const result = await runDeltaBuild(built, recording().generators);
      assert.equal(calls, 0);
      assert.equal('peace_period' in result.pages, false);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('new leak terms drop the posts that match them', async () => {
    env.enablePeaceFeedBuildStage = true;
    const kept = storedPeace().posts[0];
    const leaked = {
      ...kept,
      ref: 'P2',
      content: 'Please recall the menu.',
      offset_seconds: 40,
    };
    const built = context({ brief_changed: true });
    built.peace_period = { ...storedPeace(), leak_terms: ['fire'], posts: [kept, leaked] };
    built.peaceClient = {
      async complete() {
        return { leak_terms: ['recall'] };
      },
    };
    try {
      const result = await runDeltaBuild(built, recording().generators);
      const peace = result.pages.peace_period;
      assert.deepEqual(peace?.leak_terms, ['recall']);
      assert.equal(peace?.posts[0], kept);
      assert.equal(peace?.posts.length, 1);
      assert.equal(usablePeaceFeed(peace), peace);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });
});
