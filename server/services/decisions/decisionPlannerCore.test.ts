import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampDelay,
  normalisePlan,
  injectRowForNode,
  reversalOutcome,
  MAX_NODES,
  MAX_DEPTH,
  type PlanContext,
} from './decisionPlannerCore.js';
import type { CastEntry, PlanNode } from './decisionTypes.js';

const cast = (over: Partial<CastEntry> & { id: string }): CastEntry => ({
  name: over.id,
  title: 'Contact',
  organisation: 'Sigma',
  relationship: 'internal',
  org_key: 'primary',
  owning_team: 'Communications',
  kind: 'person',
  tier: 'principal',
  site_key: null,
  sensitivities: [],
  ...over,
});

const ctx: PlanContext = {
  cast: new Map(
    [
      cast({
        id: 'stk_site_mgr',
        relationship: 'internal',
        org_key: 'org_slm_my',
        owning_team: 'Stakeholder Engagement',
      }),
      cast({
        id: 'stk_union',
        relationship: 'union',
        org_key: 'org_slm_my',
        owning_team: 'Stakeholder Engagement',
        page_org_key: 'org_pressure_union_my',
      }),
      cast({
        id: 'stk_reporter',
        relationship: 'media',
        org_key: null,
        owning_team: 'Communications',
      }),
      cast({
        id: 'stk_regulator',
        relationship: 'regulator',
        org_key: 'org_slm_my',
        owning_team: 'Legal',
      }),
      cast({
        id: 'stk_roster_1',
        relationship: 'internal',
        org_key: 'org_slm_my',
        tier: 'roster',
        owning_team: 'Stakeholder Engagement',
      }),
      cast({
        id: 'stk_sg_client',
        relationship: 'client',
        org_key: 'primary',
        owning_team: 'Stakeholder Engagement',
      }),
      cast({
        id: 'stk_list',
        relationship: 'internal',
        org_key: 'org_slm_my',
        kind: 'group',
        members: ['stk_roster_1'],
        owning_team: 'Stakeholder Engagement',
      }),
    ].map((c) => [c.id, c]),
  ),
  pressurePages: new Map([
    [
      'org_pressure_union_my',
      { spokesperson_id: 'stk_union', display_name: 'Union', country: 'Malaysia' },
    ],
  ]),
  decisionOrgKey: 'org_slm_my',
  decisionCountry: 'Malaysia',
  orgCountry: new Map([
    ['primary', 'Singapore'],
    ['org_slm_my', 'Malaysia'],
  ]),
  unscopedCountries: new Set(),
};

describe('delay bands', () => {
  test('clamps into the relationship band and never before the parent', () => {
    assert.equal(clampDelay('internal', 1), 5);
    assert.equal(clampDelay('internal', 999), 20);
    assert.equal(clampDelay('regulator', 30), 60);
    assert.equal(clampDelay('media', 45), 45);
    assert.equal(clampDelay('internal', 5, 30), 33, 'child fires >= parent + 3');
    assert.equal(clampDelay('union', NaN), 30);
  });
});

describe('normalisePlan', () => {
  test('budget, depth, unknown actors, roster authors and dangling parents', () => {
    const nodes = [];
    for (let i = 1; i <= MAX_NODES + 3; i++) {
      nodes.push({
        id: `n${i}`,
        kind: 'reaction',
        actor_kind: 'stakeholder',
        actor_id: 'stk_site_mgr',
        channel: 'email',
        delay_minutes: 10,
        title: `t${i}`,
        body: 'A long enough body for the inject.',
      });
    }
    nodes.push({
      id: 'ghost',
      kind: 'reaction',
      actor_kind: 'stakeholder',
      actor_id: 'nope',
      channel: 'email',
      delay_minutes: 10,
      title: 'x',
      body: 'A long enough body for the inject.',
    });
    nodes.push({
      id: 'roster',
      kind: 'reaction',
      actor_kind: 'stakeholder',
      actor_id: 'stk_roster_1',
      channel: 'social_post',
      delay_minutes: 10,
      title: 'x',
      body: 'A long enough body for the inject.',
    });
    nodes.push({
      id: 'orphan',
      kind: 'reaction',
      actor_kind: 'stakeholder',
      actor_id: 'stk_site_mgr',
      channel: 'email',
      delay_minutes: 10,
      parent_node_id: 'missing',
      title: 'x',
      body: 'A long enough body for the inject.',
    });
    const plan = normalisePlan(nodes, ctx, 12);
    assert.equal(plan.nodes.length, MAX_NODES);
    assert.ok(
      plan.nodes.every(
        (n) => n.actor_id !== 'nope' && n.actor_id !== 'stk_roster_1' && n.id !== 'orphan',
      ),
    );
    assert.equal(plan.planned_at_minute, 12);
  });
  test('depth is capped and children fire after parents', () => {
    const chain = [
      {
        id: 'a',
        kind: 'relay',
        actor_kind: 'stakeholder',
        actor_id: 'stk_site_mgr',
        channel: 'chat_dm',
        delay_minutes: 5,
        title: 'relay',
        body: '',
        learners: ['stk_roster_1', 'stk_list'],
      },
      {
        id: 'b',
        kind: 'reaction',
        actor_kind: 'stakeholder',
        actor_id: 'stk_union',
        channel: 'email',
        delay_minutes: 20,
        parent_node_id: 'a',
        title: 'union',
        body: 'We were not consulted about the suspension.',
      },
      {
        id: 'c',
        kind: 'public',
        actor_kind: 'stakeholder',
        actor_id: 'stk_reporter',
        channel: 'news',
        delay_minutes: 30,
        parent_node_id: 'b',
        title: 'press',
        body: 'Union says workers heard about the suspension from colleagues.',
      },
      {
        id: 'd',
        kind: 'reaction',
        actor_kind: 'stakeholder',
        actor_id: 'stk_regulator',
        channel: 'email',
        delay_minutes: 60,
        parent_node_id: 'c',
        title: 'too deep',
        body: 'Depth four should be dropped by the normaliser.',
      },
    ];
    const plan = normalisePlan(chain, ctx, 0);
    const ids = plan.nodes.map((n) => n.id);
    assert.deepEqual(ids, ['a', 'b', 'c'], `depth ${MAX_DEPTH} cap`);
    const a = plan.nodes[0];
    const b = plan.nodes[1];
    const c = plan.nodes[2];
    assert.deepEqual(a.learners, ['stk_roster_1', 'stk_list']);
    assert.ok(
      b.delay_minutes >= a.delay_minutes + 3 && b.delay_minutes >= 30,
      'union band + after parent',
    );
    assert.ok(c.delay_minutes >= b.delay_minutes + 3);
    assert.equal(c.kind, 'public');
  });
  test('pressure spokesperson public statements route to the page; private mail stays personal', () => {
    const plan = normalisePlan(
      [
        {
          id: 'p',
          kind: 'public',
          actor_kind: 'stakeholder',
          actor_id: 'stk_union',
          channel: 'social_post',
          delay_minutes: 40,
          title: 'statement',
          body: 'The union condemns the suspension announced without consultation.',
        },
        {
          id: 'm',
          kind: 'reaction',
          actor_kind: 'stakeholder',
          actor_id: 'stk_union',
          channel: 'email',
          delay_minutes: 40,
          title: 'letter',
          body: 'Formal letter demanding consultation within 48 hours.',
        },
      ],
      ctx,
      0,
    );
    const p = plan.nodes.find((n) => n.id === 'p')!;
    const m = plan.nodes.find((n) => n.id === 'm')!;
    assert.equal(p.actor_kind, 'page');
    assert.equal(p.actor_id, 'org_pressure_union_my');
    assert.equal(p.channel, 'page_statement');
    assert.equal(m.actor_kind, 'stakeholder');
    assert.equal(m.channel, 'email');
    assert.deepEqual(m.target_teams, ['Stakeholder Engagement']);
  });
  test('scope rule: a private cross-country reaction is dropped; common actors and public nodes pass', () => {
    const plan = normalisePlan(
      [
        {
          id: 'sg',
          kind: 'reaction',
          actor_kind: 'stakeholder',
          actor_id: 'stk_sg_client',
          channel: 'email',
          delay_minutes: 30,
          title: 'sg client',
          body: 'A Singapore client reacting privately to a Malaysian decision.',
        },
        {
          id: 'press',
          kind: 'public',
          actor_kind: 'stakeholder',
          actor_id: 'stk_reporter',
          channel: 'news',
          delay_minutes: 45,
          title: 'common media',
          body: 'Regional desk report on the Johor suspension for every country.',
        },
      ],
      ctx,
      0,
    );
    assert.deepEqual(
      plan.nodes.map((n) => n.id),
      ['press'],
    );
    assert.equal(plan.nodes[0].org_key, null);
  });
  test('regulator grievance overrides are never more persuadable than low', () => {
    const plan = normalisePlan(
      [
        {
          id: 'r',
          kind: 'reaction',
          actor_kind: 'stakeholder',
          actor_id: 'stk_regulator',
          channel: 'email',
          delay_minutes: 70,
          title: 'regulator',
          body: 'Formal request for the statutory notice documentation.',
          grievance_override: {
            grievance: 'Statutory notice was not filed before the suspension',
            resolution_criteria: ['File the notice'],
            persuadability: 'high',
          },
        },
      ],
      ctx,
      0,
    );
    assert.equal(plan.nodes[0].grievance_override?.persuadability, 'low');
  });
});

describe('inject rows', () => {
  const base: PlanNode = {
    id: 'n1',
    kind: 'reaction',
    actor_kind: 'stakeholder',
    actor_id: 'stk_union',
    channel: 'email',
    delay_minutes: 35,
    parent_node_id: null,
    depth: 0,
    content: { title: 'Union demands consultation', body: 'We were not consulted.' },
    target_teams: ['Stakeholder Engagement'],
    org_key: 'org_slm_my',
    country: 'Malaysia',
  };
  const meta = {
    sessionId: 's1',
    scenarioId: 'sc1',
    decisionId: 'd1',
    decisionKey: 'close_johor',
    detectedAtMinute: 12,
  };
  test('stakeholder email: author fields from the record, decision linkage, clock trigger', () => {
    const row = injectRowForNode(
      base,
      {
        stakeholder: {
          id: 'stk_union',
          name: 'Ahmad',
          email: 'ahmad@union.sim',
          handle: '@ahmad',
          phone: null,
          organisation: 'Union',
        },
      },
      meta,
    )!;
    assert.equal(row.generation_source, 'decision_response');
    assert.equal(row.trigger_time_minutes, 47);
    assert.equal(row.session_id, 's1');
    const dc = row.delivery_config as Record<string, unknown>;
    assert.equal(dc.app, 'email');
    assert.equal(dc.from_address, 'ahmad@union.sim');
    assert.equal(dc.from_name, 'Ahmad');
    assert.equal(dc.stakeholder_id, 'stk_union');
    assert.equal(dc.decision_id, 'd1');
    assert.equal(dc.inject_key, 'dec_close_johor_n1');
    assert.equal(row.inject_scope, 'team_specific');
  });
  test('chained node waits for its parent via inject_published:*', () => {
    const child: PlanNode = {
      ...base,
      id: 'n2',
      parent_node_id: 'n1',
      depth: 1,
      channel: 'news',
      actor_id: 'stk_reporter',
      kind: 'public',
      target_teams: [],
    };
    const row = injectRowForNode(
      child,
      {
        stakeholder: {
          id: 'stk_reporter',
          name: 'Suresh',
          email: 's@star.sim',
          handle: '@suresh',
          phone: null,
          organisation: 'The Star',
        },
      },
      meta,
    )!;
    assert.equal(row.trigger_time_minutes, null);
    assert.deepEqual(row.conditions_to_appear, {
      threshold: 1,
      conditions: ['inject_published:dec_close_johor_n1'],
    });
    assert.equal(
      (row.delivery_config as Record<string, unknown>).parent_inject_key,
      'dec_close_johor_n1',
    );
    assert.equal((row.delivery_config as Record<string, unknown>).outlet_name, 'The Star');
    assert.equal(row.inject_scope, 'universal');
  });
  test('page routing: page identity as author, spokesperson as stakeholder_id', () => {
    const node: PlanNode = {
      ...base,
      actor_kind: 'page',
      actor_id: 'org_pressure_union_my',
      channel: 'page_statement',
      kind: 'public',
      target_teams: [],
    };
    const row = injectRowForNode(
      node,
      {
        page: {
          org_key: 'org_pressure_union_my',
          page_name: 'Union MY',
          page_handle: '@UnionMY',
          platform: 'x_twitter',
          spokesperson_id: 'stk_union',
        },
      },
      meta,
    )!;
    const dc = row.delivery_config as Record<string, unknown>;
    assert.equal(dc.page_org_key, 'org_pressure_union_my');
    assert.equal(dc.author_handle, '@UnionMY');
    assert.equal(dc.author_type, 'official_account');
    assert.equal(dc.stakeholder_id, 'stk_union');
  });
  test('chat DMs are not injects (delivered by the tick)', () => {
    assert.equal(
      injectRowForNode(
        { ...base, channel: 'chat_dm' },
        {
          stakeholder: {
            id: 'x',
            name: 'x',
            email: 'x@x.sim',
            handle: '@x',
            phone: null,
            organisation: 'x',
          },
        },
        meta,
      ),
      null,
    );
  });
});

describe('reversal rule (plan §1 answer #3)', () => {
  test('within 15 min and nothing public → cancel; later → modify; after a public artefact → second wave', () => {
    assert.equal(
      reversalOutcome({
        originalDetectedAtMinute: 10,
        reversalAtMinute: 20,
        anyPublicArtefactFired: false,
      }),
      'cancel',
    );
    assert.equal(
      reversalOutcome({
        originalDetectedAtMinute: 10,
        reversalAtMinute: 40,
        anyPublicArtefactFired: false,
      }),
      'modify',
    );
    assert.equal(
      reversalOutcome({
        originalDetectedAtMinute: 10,
        reversalAtMinute: 12,
        anyPublicArtefactFired: true,
      }),
      'second_wave',
    );
  });
});
