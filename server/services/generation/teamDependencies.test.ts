import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConditionalInjects } from '../conditions/conditionalInjectsCore.js';
import { dependencyCallsFor } from '../../../shared/buildEstimate.js';
import {
  checkTeamNaming,
  postProcessDependencies,
  registerIntelEdges,
  type GenerationTeam,
  type KnownInject,
} from './teamDependenciesCore.js';
import {
  generateTeamDependencies,
  type DependencyChatRequest,
  type DependencyClient,
} from './teamDependencyService.js';
import { postProcessResponseBranches, type BranchParent } from './responseBranchesCore.js';

const SUPERMARKET: GenerationTeam[] = [
  {
    team_name: 'Operations',
    org_key: 'retail',
    org_name: 'FreshMart',
    function_name: 'Operations',
    mission: 'Run the stores',
  },
  {
    team_name: 'Communications',
    org_key: 'retail',
    org_name: 'FreshMart',
    function_name: 'Communications',
    mission: 'Speak for the company',
  },
  {
    team_name: 'Legal',
    org_key: 'retail',
    org_name: 'FreshMart',
    function_name: 'Legal',
    mission: 'Approve what is said',
  },
  {
    team_name: 'Customer Service',
    org_key: 'retail',
    org_name: 'FreshMart',
    function_name: 'Customer Service',
    mission: 'Answer the public',
  },
];

const KNOWN: KnownInject[] = [
  { inject_key: 'bay3_headcount_request', title: 'Bay 3 headcount', trigger_time_minutes: 8 },
  {
    inject_key: 'legal_approval_request',
    title: 'Approve the holding statement',
    trigger_time_minutes: 12,
  },
];

function keysOf(group: { all?: string[]; conditions?: string[] } | null): string[] {
  if (!group) return [];
  return group.all ?? group.conditions ?? [];
}

describe('postProcessDependencies', () => {
  test('a team uid wins over a stale display name', () => {
    const processed = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_uid_ops',
            kind: 'information',
            upstream: { team_uid: 'uid-ops', team_name: 'Old Ops' },
            downstream: ['Communications'],
            deliverable: 'Headcount',
            why: 'Comms needs it',
            signals: [{ template: 'silent', minutes: 10 }],
            met_signal: null,
            lag_minutes: 5,
            severity: 'medium',
          },
        ],
      },
      [
        { team_uid: 'uid-ops', team_name: 'Operations', playable: true },
        { team_name: 'Communications', playable: true },
      ],
      [],
      60,
    );
    assert.equal(processed.edges[0]?.upstream.team_name, 'Operations');
    assert.equal(processed.edges[0]?.upstream.team_uid, 'uid-ops');
  });

  test('drops an unknown team, caps upstream edges at 3, and adds the default cancel keys', () => {
    const downstream = 'Communications';
    const edges = [0, 1, 2, 3].map((n) => ({
      id: `dep_ops_note_${n}`,
      kind: 'information',
      upstream: n === 3 ? 'Ghost Team' : 'Operations',
      downstream: [downstream],
      deliverable: `Update ${n}`,
      why: 'Communications needs the figure',
      signals: [{ template: 'silent', minutes: 10 }],
      met_signal: null,
      lag_minutes: 5,
      severity: 'medium',
    }));
    edges.push({
      id: 'dep_ops_note_4',
      kind: 'information',
      upstream: 'Operations',
      downstream: [downstream],
      deliverable: 'Update 4',
      why: 'One more than the cap',
      signals: [{ template: 'silent', minutes: 10 }],
      met_signal: null,
      lag_minutes: 4,
      severity: 'low',
    });
    const processed = postProcessDependencies(
      {
        edges,
        consequences: edges
          .filter((edge) => edge.upstream === 'Operations')
          .map((edge) => ({
            edge_id: edge.id,
            downstream,
            title: `Chase ${edge.id}`,
            content: 'We still do not have the update.',
            app: 'email',
          })),
      },
      SUPERMARKET,
      KNOWN,
      60,
      { upstreamPerTeam: 3 },
    );
    assert.equal(
      processed.edges.some((edge) => edge.upstream.team_name === 'Ghost Team'),
      false,
    );
    assert.equal(processed.edges.length, 3);
    assert.ok(processed.consequences.length >= 1);
    for (const inject of processed.consequences) {
      assert.deepEqual(inject.conditions_to_cancel, [
        `dependency_resolved:${inject.delivery_config.cause?.dep_id}`,
        `dependency_waived:${inject.delivery_config.cause?.dep_id}`,
      ]);
    }
  });

  test('a no_reply template becomes unresponded with the upstream placeholder', () => {
    const processed = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_ops_headcount_comms',
            kind: 'information',
            upstream: 'Operations',
            downstream: ['Communications'],
            deliverable: 'Confirmed headcount for Bay 3',
            why: 'Communications cannot publish figures without it',
            signals: [{ template: 'no_reply', inject_key: 'bay3_headcount_request', minutes: 10 }],
            met_signal: null,
            lag_minutes: 5,
            severity: 'high',
          },
        ],
      },
      SUPERMARKET,
      KNOWN,
      60,
    );
    assert.deepEqual(keysOf(processed.edges[0]?.broken_when ?? null), [
      'unresponded:bay3_headcount_request:10|team=@upstream',
    ]);
  });

  test('needs_ask creates a timed ask inject and binds the signal to its key', () => {
    const processed = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_ops_ask_comms',
            kind: 'information',
            upstream: 'Operations',
            downstream: ['Communications'],
            deliverable: 'Bay 3 headcount',
            why: 'The request was never written',
            signals: [{ template: 'no_reply', minutes: 10 }],
            met_signal: null,
            needs_ask: {
              title: 'Bay 3 headcount request',
              content: 'Please confirm how many people were in Bay 3.',
              app: 'email',
              trigger_time_minutes: 8,
            },
            lag_minutes: 5,
            severity: 'high',
          },
        ],
      },
      SUPERMARKET,
      [],
      60,
    );
    assert.equal(processed.asks.length, 1);
    const ask = processed.asks[0];
    assert.equal(ask?.trigger_time_minutes, 8);
    assert.deepEqual(ask?.target_teams, ['Operations']);
    assert.equal(ask?.delivery_config.app, 'email');
    assert.deepEqual(keysOf(processed.edges[0]?.broken_when ?? null), [
      `unresponded:${ask?.delivery_config.inject_key}:10|team=@upstream`,
    ]);
  });

  test('consequences are one per downstream, on the lag key, with the dependency layer', () => {
    const processed = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_legal_statement_comms_cs',
            kind: 'approval',
            upstream: 'Legal',
            downstream: ['Communications', 'Customer Service'],
            deliverable: 'Approval of the holding statement',
            why: 'Neither team can speak without it',
            signals: [{ template: 'silent', minutes: 12 }],
            met_signal: null,
            lag_minutes: 3,
            severity: 'high',
          },
        ],
        consequences: [
          {
            edge_id: 'dep_legal_statement_comms_cs',
            downstream: 'Communications',
            title: "CEO's office asks why there's still no statement",
            content: 'The chief of staff wants the holding statement now.',
            app: 'group_chat',
          },
          {
            edge_id: 'dep_legal_statement_comms_cs',
            downstream: 'Customer Service',
            title: 'Angry callers: no official line',
            content: 'Callers are asking for a line we do not have.',
            app: 'phone_call',
          },
        ],
      },
      SUPERMARKET,
      KNOWN,
      60,
    );
    assert.equal(processed.consequences.length, 2);
    const byTeam = new Map(
      processed.consequences.map((inject) => [inject.target_teams[0], inject]),
    );
    for (const team of ['Communications', 'Customer Service']) {
      const inject = byTeam.get(team);
      assert.ok(inject, team);
      assert.deepEqual(inject?.conditions_to_appear, {
        all: ['dependency_broken_for:dep_legal_statement_comms_cs:3'],
      });
      assert.equal(inject?.gen_layer, 'dependency:dep_legal_statement_comms_cs');
      assert.equal(inject?.delivery_config.gen?.layer, 'dependency:dep_legal_statement_comms_cs');
      assert.deepEqual(inject?.delivery_config.cause, {
        kind: 'dependency',
        dep_id: 'dep_legal_statement_comms_cs',
      });
    }
  });
});

describe('registerIntelEdges', () => {
  test('registers intel items as edges and does not change their gates', () => {
    const gates = [
      {
        title: 'Manifest withheld',
        conditions_to_appear: { threshold: 1, conditions: ['intel_missing:vessel_manifest_k7'] },
        conditions_to_cancel: ['intel_shared:vessel_manifest_k7'],
      },
    ];
    const before = structuredClone(gates);
    const teams: GenerationTeam[] = [
      { team_name: 'Port Authority Operations', org_key: 'port', playable: true },
      { team_name: 'Shipping Co Operations', org_key: 'ship', playable: true },
    ];
    const edges = registerIntelEdges(
      [
        {
          intel_key: 'vessel_manifest_k7',
          holder_team: 'Port Authority Operations',
          needed_by: ['Shipping Co Operations'],
          trigger_time_minutes: 8,
          deadline_minutes: 90,
          summary: 'The vessel manifest for berth K7',
        },
      ],
      new Set(),
      teams,
      40,
    );
    assert.deepEqual(gates, before);
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.source, 'intel');
    assert.equal(edges[0]?.kind, 'information');
    assert.deepEqual(keysOf(edges[0]?.broken_when ?? null), ['intel_missing:vessel_manifest_k7']);
    assert.deepEqual(keysOf(edges[0]?.met_when ?? null), ['intel_shared:vessel_manifest_k7']);
    assert.equal(edges[0]?.upstream.team_name, 'Port Authority Operations');
    assert.deepEqual(
      edges[0]?.downstream.map((team) => team.team_name),
      ['Shipping Co Operations'],
    );
    assert.deepEqual(edges[0]?.due, { by_minute: 40 });
  });

  test('an AI-operated holder is not registered', () => {
    const edges = registerIntelEdges(
      [
        {
          intel_key: 'vessel_manifest_k7',
          holder_team: 'Port Authority Operations',
          needed_by: ['Shipping Co Operations'],
          summary: 'The vessel manifest',
        },
      ],
      new Set(),
      [
        { team_name: 'Port Authority Operations', org_key: 'port', playable: false },
        { team_name: 'Shipping Co Operations', org_key: 'ship', playable: true },
      ],
      60,
    );
    assert.deepEqual(edges, []);
  });
});

describe('example A', () => {
  test('a fixture model output reproduces the supermarket dependencies and passes validation', () => {
    const model = {
      edges: [
        {
          id: 'dep_ops_headcount_comms',
          kind: 'information',
          upstream: 'Operations',
          downstream: ['Communications'],
          deliverable: 'Confirmed headcount for Bay 3',
          why: "Communications can't publish a holding statement with figures without it",
          signals: [
            { template: 'no_reply', inject_key: 'bay3_headcount_request', minutes: 10 },
            { template: 'poor_reply', inject_key: 'bay3_headcount_request' },
          ],
          met_signal: { template: 'no_reply', inject_key: 'bay3_headcount_request' },
          due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
          lag_minutes: 5,
          severity: 'high',
        },
        {
          id: 'dep_legal_statement_comms_cs',
          kind: 'approval',
          upstream: 'Legal',
          downstream: ['Communications', 'Customer Service'],
          deliverable: 'Approval of the holding statement',
          why: 'Neither team can give the public a line without Legal',
          signals: [
            { template: 'silent', minutes: 12 },
            { template: 'duty_missed', action_id: 'legal_review_statement' },
          ],
          met_signal: { template: 'no_reply', inject_key: 'legal_approval_request' },
          due: { after_inject_key: 'legal_approval_request', within_minutes: 12 },
          lag_minutes: 3,
          severity: 'high',
        },
        {
          id: 'dep_comms_restraint_legal',
          kind: 'restraint',
          upstream: 'Communications',
          downstream: ['Legal'],
          deliverable: 'No public statement before Legal approves',
          why: 'A post before approval can admit liability',
          signals: [{ template: 'restraint_action', action_type: 'post_created', count: 1 }],
          met_signal: {
            template: 'no_reply',
            inject_key: 'legal_approval_request',
            scope: '@downstream',
          },
          due: { by_minute: 28 },
          lag_minutes: 2,
          severity: 'high',
        },
      ],
      consequences: [
        {
          edge_id: 'dep_ops_headcount_comms',
          downstream: 'Communications',
          title: 'Reporter presses for numbers',
          content: 'Maria Tan asks for the Bay 3 headcount before her next deadline.',
          app: 'email',
          sender: 'stk_maria_tan',
        },
        {
          edge_id: 'dep_legal_statement_comms_cs',
          downstream: 'Communications',
          title: "CEO's office asks why there's still no statement",
          content: 'The chief of staff wants to know why the holding statement is not out.',
          app: 'group_chat',
        },
        {
          edge_id: 'dep_legal_statement_comms_cs',
          downstream: 'Customer Service',
          title: 'Angry callers: no official line',
          content: 'The switchboard is taking calls from customers who have no statement to quote.',
          app: 'phone_call',
        },
        {
          edge_id: 'dep_comms_restraint_legal',
          downstream: 'Legal',
          title: 'Regulator: your public statement appears to admit liability',
          content: 'The regulator asks Legal to explain the statement that went out.',
          app: 'email',
        },
      ],
    };
    const processed = postProcessDependencies(model, SUPERMARKET, KNOWN, 60);
    assert.equal(processed.edges.length, 3);
    const headcount = processed.edges.find((edge) => edge.id === 'dep_ops_headcount_comms');
    assert.deepEqual(keysOf(headcount?.broken_when ?? null), [
      'unresponded:bay3_headcount_request:10|team=@upstream',
      'reply_failed:bay3_headcount_request|team=@upstream',
    ]);
    assert.equal(headcount?.lag_minutes, 5);
    const restraint = processed.edges.find((edge) => edge.id === 'dep_comms_restraint_legal');
    assert.equal(restraint?.kind, 'restraint');
    assert.deepEqual(keysOf(restraint?.broken_when ?? null), [
      'action_count_gte:post_created:1|team=@upstream',
    ]);
    assert.deepEqual(keysOf(restraint?.met_when ?? null), [
      'responded_relevant:legal_approval_request|team=@downstream',
    ]);
    const reporter = processed.consequences.find(
      (inject) => inject.title === 'Reporter presses for numbers',
    );
    assert.deepEqual(reporter?.target_teams, ['Communications']);
    assert.equal(reporter?.delivery_config.stakeholder_id, 'stk_maria_tan');
    assert.equal(reporter?.delivery_config.app, 'email');
    const parents = KNOWN.map((inject) => ({
      title: inject.title ?? undefined,
      trigger_time_minutes: inject.trigger_time_minutes ?? undefined,
      delivery_config: { app: 'email', inject_key: inject.inject_key ?? undefined },
    }));
    const validated = validateConditionalInjects({
      duration_minutes: 60,
      teams: SUPERMARKET,
      team_dependencies: { v: 1, edges: processed.edges },
      injects: [...parents, ...processed.consequences],
    });
    const errors = validated.issues.filter((issue) => issue.severity === 'error');
    assert.deepEqual(errors, []);
  });
});

describe('validateConditionalInjects dependency guards', () => {
  test('an unknown team slug is MO-COND-011 and a dependency cycle is MO-COND-003', () => {
    const unknown = validateConditionalInjects({
      duration_minutes: 60,
      teams: SUPERMARKET,
      injects: [
        {
          title: 'Headcount request',
          trigger_time_minutes: 8,
          delivery_config: { app: 'email', inject_key: 'bay3_headcount_request' },
        },
        {
          title: 'Mis-scoped',
          delivery_config: { app: 'email', inject_key: 'mis_scoped' },
          conditions_to_appear: { all: ['unresponded:bay3_headcount_request:10|team=not_a_team'] },
        },
        {
          title: 'Known slug',
          delivery_config: { app: 'email', inject_key: 'known_slug' },
          conditions_to_appear: { all: ['unresponded:bay3_headcount_request:10|team=operations'] },
        },
      ],
    });
    assert.ok(
      unknown.issues.some(
        (issue) => issue.code === 'MO-COND-011' && issue.message.includes('not_a_team'),
      ),
    );
    assert.equal(
      unknown.issues.some(
        (issue) => issue.code === 'MO-COND-011' && issue.message.includes('operations'),
      ),
      false,
    );

    const cycle = validateConditionalInjects({
      duration_minutes: 60,
      teams: SUPERMARKET,
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_ops_headcount_comms',
            kind: 'information',
            upstream: { team_uid: null, team_name: 'Operations' },
            downstream: [{ team_uid: null, team_name: 'Communications' }],
            deliverable: 'Confirmed headcount for Bay 3',
            why: 'Needed for the statement',
            due: { by_minute: 20 },
            broken_when: { all: ['unresponded:reporter_presses:10|team=@upstream'] },
            met_when: { all: ['responded_relevant:bay3_headcount_request|team=@upstream'] },
            lag_minutes: 5,
            severity: 'high',
            consequence_keys: ['reporter_presses'],
            source: 'war_room',
          },
        ],
      },
      injects: [
        {
          title: 'Headcount request',
          trigger_time_minutes: 8,
          delivery_config: { app: 'email', inject_key: 'bay3_headcount_request' },
        },
        {
          title: 'Reporter presses for numbers',
          delivery_config: { app: 'email', inject_key: 'reporter_presses' },
          target_teams: ['Communications'],
          conditions_to_appear: { all: ['dependency_broken_for:dep_ops_headcount_comms:5'] },
          conditions_to_cancel: [
            'dependency_resolved:dep_ops_headcount_comms',
            'dependency_waived:dep_ops_headcount_comms',
          ],
        },
      ],
    });
    assert.ok(cycle.issues.some((issue) => issue.code === 'MO-COND-003'));

    const teamCycle = validateConditionalInjects({
      duration_minutes: 60,
      teams: SUPERMARKET,
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_ops_to_comms',
            kind: 'information',
            upstream: { team_uid: null, team_name: 'Operations' },
            downstream: [{ team_uid: null, team_name: 'Communications' }],
            deliverable: 'Headcount',
            why: '',
            due: { by_minute: 20 },
            broken_when: { all: ['unresponded:bay3_headcount_request:10|team=@upstream'] },
            met_when: null,
            lag_minutes: 5,
            severity: 'medium',
            consequence_keys: ['comms_chase'],
            source: 'war_room',
          },
          {
            id: 'dep_comms_to_ops',
            kind: 'information',
            upstream: { team_uid: null, team_name: 'Communications' },
            downstream: [{ team_uid: null, team_name: 'Operations' }],
            deliverable: 'Approved line',
            why: '',
            due: { by_minute: 24 },
            broken_when: { all: ['team_silent:10|team=@upstream'] },
            met_when: null,
            lag_minutes: 5,
            severity: 'medium',
            consequence_keys: ['ops_chase'],
            source: 'war_room',
          },
        ],
      },
      injects: [
        {
          title: 'Headcount request',
          trigger_time_minutes: 8,
          delivery_config: { app: 'email', inject_key: 'bay3_headcount_request' },
        },
        {
          title: 'Comms chase',
          delivery_config: { app: 'email', inject_key: 'comms_chase' },
          conditions_to_appear: { all: ['dependency_broken_for:dep_ops_to_comms:5'] },
        },
        {
          title: 'Ops chase',
          delivery_config: { app: 'email', inject_key: 'ops_chase' },
          conditions_to_appear: { all: ['dependency_broken_for:dep_comms_to_ops:5'] },
        },
      ],
    });
    assert.equal(
      teamCycle.issues.some((issue) => issue.code === 'MO-COND-003'),
      false,
    );
  });
});

describe('generateTeamDependencies', () => {
  test('30 teams in 6 orgs make 7 map calls and one consequence call per 8 edges', async () => {
    const orgs = ['North', 'South', 'East', 'West', 'Central', 'Coast'];
    const teams: GenerationTeam[] = orgs.flatMap((org, orgIndex) =>
      Array.from({ length: 5 }, (_, teamIndex) => ({
        team_name: `${org} ${teamIndex + 1}`,
        org_key: `org_${orgIndex}`,
        org_name: org,
        function_name: 'Operations',
        mission: `Own the ${org} response`,
        playable: true,
      })),
    );
    const edges = Array.from({ length: 45 }, (_, index) => ({
      id: `dep_link_${index}`,
      kind: 'information',
      upstream: teams[index % teams.length]?.team_name,
      downstream: [teams[(index + 1) % teams.length]?.team_name],
      deliverable: `Update ${index}`,
      why: 'The next team cannot act without it',
      signals: [{ template: 'silent', minutes: 10 }],
      met_signal: null,
      lag_minutes: 5,
      severity: 'medium',
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const labels: string[] = [];
    const client: DependencyClient = {
      async complete(request: DependencyChatRequest) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        labels.push(request.label);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        assert.equal(request.tier, 'standard');
        assert.equal(request.json, true);
        if (request.label === 'generator.dependencyMap') return { edges };
        return { consequences: [], positives: [] };
      },
    };
    const result = await generateTeamDependencies(
      {
        teams,
        crisis: { crisisType: 'port closure', duration: 60, context: 'The berth is shut.' },
        facts: ['Berth K7 is closed'],
        storylines: {},
      },
      { client, concurrency: 4, mapBatchTeams: 16, upstreamPerTeam: 3, consequenceBatch: 8 },
    );
    const warRoom = result.team_dependencies.edges.filter((edge) => edge.source === 'war_room');
    assert.equal(labels.filter((label) => label === 'generator.dependencyMap').length, 7);
    assert.equal(
      labels.filter((label) => label === 'generator.dependencyConsequences').length,
      Math.ceil(warRoom.length / 8),
    );
    assert.equal(result.mapCalls, 7);
    assert.equal(result.consequenceCalls, Math.ceil(warRoom.length / 8));
    assert.ok(maxInFlight <= 4, `in flight ${maxInFlight}`);
    assert.ok(maxInFlight >= 2);
  });

  test('a 2-org 6-team fixture covers every team, crosses orgs, and validates', async () => {
    const teams: GenerationTeam[] = [
      { team_name: 'Retail Ops', org_key: 'retail', org_name: 'FreshMart', playable: true },
      { team_name: 'Retail Comms', org_key: 'retail', org_name: 'FreshMart', playable: true },
      { team_name: 'Retail Legal', org_key: 'retail', org_name: 'FreshMart', playable: true },
      { team_name: 'Port Ops', org_key: 'port', org_name: 'Harbour Board', playable: true },
      { team_name: 'Port Comms', org_key: 'port', org_name: 'Harbour Board', playable: true },
      { team_name: 'Port Security', org_key: 'port', org_name: 'Harbour Board', playable: true },
    ];
    const pairs: Array<[string, string]> = [
      ['Retail Ops', 'Retail Comms'],
      ['Retail Legal', 'Retail Comms'],
      ['Retail Comms', 'Retail Legal'],
      ['Port Ops', 'Port Comms'],
      ['Port Comms', 'Port Security'],
      ['Retail Ops', 'Port Ops'],
    ];
    const client: DependencyClient = {
      async complete(request) {
        if (request.label === 'generator.dependencyMap') {
          return {
            edges: pairs.map(([upstream, downstream], index) => ({
              id: `dep_pair_${index}`,
              kind: 'information',
              upstream,
              downstream: [downstream],
              deliverable: `${upstream} owes ${downstream}`,
              why: 'The other team cannot finish its own job',
              signals: [{ template: 'silent', minutes: 10 }],
              met_signal: null,
              lag_minutes: 5,
              severity: 'medium',
            })),
          };
        }
        const described = JSON.parse(
          request.user.split('Dependencies:\n')[1]?.split('\n')[0] ?? '[]',
        ) as Array<{
          id: string;
          downstream: string[];
        }>;
        return {
          consequences: described.flatMap((edge) =>
            edge.downstream.map((downstream) => ({
              edge_id: edge.id,
              downstream,
              title: `${downstream} hears about ${edge.id}`,
              content: 'The dependency was not met.',
              app: 'email',
            })),
          ),
          positives: [],
        };
      },
    };
    const result = await generateTeamDependencies(
      {
        teams,
        crisis: { crisisType: 'contamination', duration: 60 },
        facts: ['Bay 3 is closed'],
        storylines: {},
      },
      { client, concurrency: 2 },
    );
    const edges = result.team_dependencies.edges;
    assert.ok(edges.length >= 6);
    const covered = new Set(
      edges.flatMap((edge) => [
        edge.upstream.team_name,
        ...edge.downstream.map((team) => team.team_name),
      ]),
    );
    for (const team of teams) assert.ok(covered.has(team.team_name), team.team_name);
    const orgOf = new Map(teams.map((team) => [team.team_name, team.org_key]));
    assert.ok(
      edges.some((edge) =>
        edge.downstream.some(
          (team) => orgOf.get(team.team_name) !== orgOf.get(edge.upstream.team_name),
        ),
      ),
    );
    assert.ok(result.consequences.length >= 6);
    for (const inject of result.consequences) {
      assert.equal(inject.target_teams.length, 1);
      assert.ok(inject.conditions_to_appear);
    }
    const validated = validateConditionalInjects({
      duration_minutes: 60,
      teams,
      team_dependencies: result.team_dependencies,
      injects: result.consequences,
    });
    assert.deepEqual(
      validated.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
  });

  test('a public consequence that names a team is retried once and then dropped', async () => {
    let consequenceCalls = 0;
    const client: DependencyClient = {
      async complete(request) {
        if (request.label === 'generator.dependencyMap') {
          return {
            edges: [
              {
                id: 'dep_ops_public',
                kind: 'information',
                upstream: 'Operations',
                downstream: ['Communications'],
                deliverable: 'Headcount',
                why: 'The statement needs it',
                signals: [{ template: 'silent', minutes: 10 }],
                met_signal: null,
                lag_minutes: 5,
                severity: 'high',
              },
            ],
          };
        }
        consequenceCalls += 1;
        return {
          consequences: [
            {
              edge_id: 'dep_ops_public',
              downstream: 'Communications',
              title: 'The Operations team missed the deadline',
              content: 'The Operations team never sent the figures.',
              app: 'social_feed',
            },
          ],
          positives: [],
        };
      },
    };
    const result = await generateTeamDependencies(
      {
        teams: SUPERMARKET,
        crisis: { crisisType: 'contamination', duration: 60 },
        facts: [],
        storylines: {},
      },
      { client },
    );
    assert.equal(consequenceCalls, 2);
    assert.equal(result.consequences.length, 0);
    assert.equal(
      checkTeamNaming(
        { title: 'Note', content: 'The Operations team never sent the figures.', app: 'email' },
        ['Operations'],
      ).namesTeam,
      false,
    );
    assert.equal(
      checkTeamNaming(
        { title: 'Update', content: 'Daily operations continue overnight.', app: 'social_feed' },
        ['Operations'],
      ).namesTeam,
      false,
    );
    assert.equal(
      checkTeamNaming(
        { title: 'Update', content: "Operations' delay left the statement blank.", app: 'news' },
        ['Operations'],
      ).namesTeam,
      true,
    );
    assert.equal(
      checkTeamNaming(
        {
          title: 'Update',
          content: 'Customer Service has no line to give callers.',
          app: 'social_feed',
        },
        ['Customer Service'],
      ).namesTeam,
      true,
    );
  });

  test('duty_missed uses a real upstream duty, and a cross-org call drops same-org edges', async () => {
    const teams: GenerationTeam[] = [
      {
        team_name: 'Retail Legal',
        org_key: 'retail',
        org_name: 'FreshMart',
        playable: true,
        duties: [{ action_id: 'legal_review_statement', timing_benchmark_minutes: 15 }],
      },
      { team_name: 'Retail Comms', org_key: 'retail', org_name: 'FreshMart', playable: true },
      { team_name: 'Port Ops', org_key: 'port', org_name: 'Harbour Board', playable: true },
      { team_name: 'Port Comms', org_key: 'port', org_name: 'Harbour Board', playable: true },
    ];
    let sawDuty = false;
    const client: DependencyClient = {
      async complete(request) {
        if (request.label !== 'generator.dependencyMap') return { consequences: [], positives: [] };
        sawDuty = sawDuty || request.user.includes('legal_review_statement (benchmark 15 min)');
        if (request.user.includes('only for dependencies that cross')) {
          return {
            edges: [
              {
                id: 'dep_same_org',
                kind: 'approval',
                upstream: 'Retail Legal',
                downstream: ['Retail Comms'],
                deliverable: 'Same org approval',
                why: 'Inside one organisation',
                signals: [{ template: 'duty_missed', action_id: 'invented_duty' }],
                met_signal: null,
                lag_minutes: 5,
                severity: 'medium',
              },
              {
                id: 'dep_cross_org',
                kind: 'information',
                upstream: 'Retail Legal',
                downstream: ['Port Ops'],
                deliverable: 'Cross org notice',
                why: 'The port needs the approval',
                signals: [{ template: 'silent', minutes: 10 }],
                met_signal: null,
                lag_minutes: 5,
                severity: 'medium',
              },
            ],
          };
        }
        return { edges: [] };
      },
    };
    const result = await generateTeamDependencies(
      {
        teams,
        crisis: { crisisType: 'contamination', duration: 60 },
        facts: [],
        storylines: {},
      },
      { client, mapBatchTeams: 2, concurrency: 2 },
    );
    assert.equal(sawDuty, true);
    assert.deepEqual(
      result.team_dependencies.edges.map((edge) => edge.id),
      ['dep_cross_org'],
    );
    const repaired = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_legal_only_duty',
            kind: 'approval',
            upstream: 'Retail Legal',
            downstream: ['Retail Comms'],
            deliverable: 'The statement',
            why: 'Comms cannot publish',
            signals: [{ template: 'duty_missed', action_id: 'invented_duty' }],
            met_signal: null,
            lag_minutes: 4,
            severity: 'high',
          },
        ],
      },
      teams,
      [],
      60,
    );
    assert.deepEqual(keysOf(repaired.edges[0]?.broken_when ?? null), [
      'duty_missed:legal_review_statement|team=@upstream',
    ]);
    const ambiguous = postProcessDependencies(
      {
        edges: [
          {
            id: 'dep_two_duties',
            kind: 'approval',
            upstream: 'Retail Legal',
            downstream: ['Retail Comms'],
            deliverable: 'The statement',
            why: 'Comms cannot publish',
            signals: [{ template: 'duty_missed', action_id: 'invented_duty' }],
            met_signal: null,
            lag_minutes: 4,
            severity: 'high',
          },
        ],
      },
      [
        {
          ...teams[0],
          duties: [
            { action_id: 'legal_review_statement', timing_benchmark_minutes: 15 },
            { action_id: 'legal_read_intel', timing_benchmark_minutes: 10 },
          ],
        },
        teams[1],
      ],
      [],
      60,
    );
    assert.equal(ambiguous.edges.length, 0);
  });
});

describe('estimateBuildCalls dependency terms', () => {
  test('matches the worked examples', () => {
    assert.deepEqual(dependencyCallsFor(6, 1), { map: 1, consequences: 2 });
    assert.deepEqual(dependencyCallsFor(30, 6), { map: 7, consequences: 6 });
    assert.deepEqual(dependencyCallsFor(60, 12), { map: 13, consequences: 12 });
    assert.equal(dependencyCallsFor(6, 1).map + dependencyCallsFor(6, 1).consequences, 3);
    assert.equal(dependencyCallsFor(30, 6).map + dependencyCallsFor(30, 6).consequences, 13);
    assert.equal(dependencyCallsFor(60, 12).map + dependencyCallsFor(60, 12).consequences, 25);
  });
});

describe('response branch targets', () => {
  test('an unknown target team falls back to the parent teams', () => {
    const parent: BranchParent = {
      inject_key: 'supplier_4471',
      title: 'Batch hold',
      app: 'email',
      content: 'Confirm the batch.',
      window_minutes: 15,
      target_teams: ['Operations'],
    };
    const kept = postProcessResponseBranches(
      {
        branches: [
          {
            parent_inject_key: 'supplier_4471',
            branch: 'poor_reply',
            title: 'Legal is asked',
            content: 'Please review the admission.',
            target_teams: ['Legal'],
            delivery_config: { app: 'email' },
            conditions_to_appear: { all: ['reply_failed:supplier_4471'] },
          },
        ],
      },
      [parent],
      60,
      new Set(['supplier_4471']),
      ['Operations', 'Communications'],
    );
    assert.deepEqual(kept.branches[0]?.target_teams, ['Operations']);

    const known = postProcessResponseBranches(
      {
        branches: [
          {
            parent_inject_key: 'supplier_4471',
            branch: 'poor_reply',
            title: 'Comms is asked',
            content: 'Please correct the line.',
            target_teams: ['Communications'],
            delivery_config: { app: 'email' },
            conditions_to_appear: { all: ['reply_failed:supplier_4471'] },
          },
        ],
      },
      [parent],
      60,
      new Set(['supplier_4471']),
      ['Operations', 'Communications'],
    );
    assert.deepEqual(known.branches[0]?.target_teams, ['Communications']);
  });
});
