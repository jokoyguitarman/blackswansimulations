import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCrossTeamSection,
  type CrossTeamEdgeInput,
  type CrossTeamTriggerInput,
} from '../../../shared/crossTeamAar.js';
import {
  AT_RISK_WITHIN_MINUTES,
  buildPanelView,
  canHold,
  canWaive,
  lagCountdown,
  originLabel,
  panelChip,
  type PanelEdgeInput,
} from '../../../shared/crossTeamPanel.js';
import { buildCommsResponsesSection } from '../aarCommsResponses.js';
import { CROSS_TEAM_READ_LIMITS } from '../crossTeam/crossTeamReads.js';

const edges: CrossTeamEdgeInput[] = [
  {
    id: 'dep_ops_headcount_comms',
    upstream: 'Operations',
    downstream: ['Communications'],
    deliverable: 'Confirmed headcount for Bay 3',
    due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
    consequence_keys: ['comms_reporter_presses'],
    status: 'broken',
    broken_minute: 18,
    met_minute: null,
    recovered_minute: null,
    evidence: [{ detail: "didn't reply to 'Bay 3 headcount'" }],
  },
  {
    id: 'dep_legal_statement_comms_cs',
    upstream: 'Legal',
    downstream: ['Communications', 'Customer Service'],
    deliverable: 'Approval of the holding statement',
    due: { after_inject_key: 'legal_approval_request', within_minutes: 12 },
    consequence_keys: ['comms_ceo_asks', 'cs_angry_callers'],
    status: 'broken',
    broken_minute: 24,
    met_minute: null,
    recovered_minute: null,
    evidence: [{ detail: 'was silent for 12 min' }],
  },
  {
    id: 'dep_comms_restraint_legal',
    upstream: 'Communications',
    downstream: ['Legal'],
    deliverable: 'Do not publish before Legal approves',
    due: { by_minute: 20 },
    consequence_keys: ['legal_regulator'],
    status: 'broken',
    broken_minute: 28,
    met_minute: null,
    recovered_minute: null,
    evidence: [{ detail: 'published before Legal approved' }],
  },
];

function trigger(partial: CrossTeamTriggerInput): CrossTeamTriggerInput {
  return partial;
}

const exampleA: CrossTeamTriggerInput[] = [
  trigger({
    inject_key: 'bay3_headcount_request',
    title: 'Bay 3 headcount',
    minute: 8,
    origin: 'timed',
    source_teams: [],
    target_teams: ['Operations'],
    dep_id: null,
    cause_depth: 0,
    parent_inject_keys: [],
  }),
  trigger({
    inject_key: 'legal_approval_request',
    title: 'Approval request',
    minute: 12,
    origin: 'timed',
    source_teams: [],
    target_teams: ['Legal'],
    dep_id: null,
    cause_depth: 0,
    parent_inject_keys: [],
  }),
  trigger({
    inject_key: 'comms_reporter_presses',
    title: 'Reporter presses for numbers',
    minute: 23,
    origin: 'dependency',
    source_teams: ['Operations'],
    target_teams: ['Communications'],
    dep_id: 'dep_ops_headcount_comms',
    cause_depth: 1,
    parent_inject_keys: ['bay3_headcount_request'],
  }),
  trigger({
    inject_key: 'comms_ceo_asks',
    title: "CEO's office asks why there's still no statement",
    minute: 27,
    origin: 'dependency',
    source_teams: ['Legal'],
    target_teams: ['Communications'],
    dep_id: 'dep_legal_statement_comms_cs',
    cause_depth: 1,
    parent_inject_keys: ['legal_approval_request'],
  }),
  trigger({
    inject_key: 'cs_angry_callers',
    title: 'Angry callers: no official line',
    minute: 27,
    origin: 'dependency',
    source_teams: ['Legal'],
    target_teams: ['Customer Service'],
    dep_id: 'dep_legal_statement_comms_cs',
    cause_depth: 1,
    parent_inject_keys: ['legal_approval_request'],
  }),
  trigger({
    inject_key: 'comms_post',
    title: 'Holding statement',
    minute: 28,
    origin: 'conditional',
    source_teams: ['Communications'],
    target_teams: ['Communications'],
    dep_id: null,
    cause_depth: 0,
    parent_inject_keys: [],
  }),
  trigger({
    inject_key: 'legal_regulator',
    title: 'Regulator: your public statement appears to admit liability',
    minute: 28,
    origin: 'dependency',
    source_teams: ['Communications'],
    target_teams: ['Legal'],
    dep_id: 'dep_comms_restraint_legal',
    cause_depth: 1,
    parent_inject_keys: ['comms_post'],
  }),
];

describe('cross-team cause chains', () => {
  test('example A names the teams and the minutes on each chain', () => {
    const section = buildCrossTeamSection({
      triggers: exampleA,
      edges,
      replies: [
        {
          inject_key: 'comms_reporter_presses',
          team: 'Communications',
          minute: 26,
          tone: 'defensive',
          criteria_met: 1,
          criteria_total: 4,
        },
      ],
    });
    assert.equal(section.provenance, 'recorded');
    assert.deepEqual(
      section.chains.map((chain) => chain.minute),
      [18, 24, 28],
    );
    const ops = section.chains[0]?.text ?? '';
    assert.match(ops, /T\+18 Operations didn't reply to 'Bay 3 headcount'/);
    assert.match(ops, /dependency broken/);
    assert.match(ops, /T\+23 Communications receives "Reporter presses for numbers"/);
    assert.match(ops, /Communications replied T\+26 \(defensive, 1\/4\)/);
    const legal = section.chains[1]?.text ?? '';
    assert.match(legal, /T\+24 Legal was silent for 12 min/);
    assert.match(
      legal,
      /T\+27 Communications receives "CEO's office asks why there's still no statement"/,
    );
    assert.match(legal, /T\+27 Customer Service receives "Angry callers: no official line"/);
    const restraint = section.chains[2]?.text ?? '';
    assert.match(restraint, /T\+28 Communications published before Legal approved/);
    assert.match(
      restraint,
      /T\+28 Legal receives "Regulator: your public statement appears to admit liability"/,
    );
    const reporter = section.edges[0]?.consequences[0];
    assert.equal(reporter?.response, 'Communications replied T+26 (defensive, 1/4)');
    assert.equal(reporter?.origin_label, 'Cross-team consequence');
  });

  test('a later consequence follows its parent and keeps its depth', () => {
    const section = buildCrossTeamSection({
      triggers: [
        exampleA[2]!,
        trigger({
          inject_key: 'legal_regulator_follow',
          title: 'Regulator asks about the statement',
          minute: 31,
          origin: 'dependency',
          source_teams: ['Communications'],
          target_teams: ['Legal'],
          dep_id: 'dep_follow',
          cause_depth: 2,
          parent_inject_keys: ['comms_reporter_presses'],
        }),
      ],
      edges: [
        edges[0]!,
        {
          id: 'dep_follow',
          upstream: 'Communications',
          downstream: ['Legal'],
          deliverable: 'A statement Legal can defend',
          due: { by_minute: 30 },
          consequence_keys: ['legal_regulator_follow'],
          status: 'broken',
          broken_minute: 30,
          met_minute: null,
          recovered_minute: null,
          evidence: [{ detail: 'answered the reporter before Legal had approved' }],
        },
      ],
      replies: [
        {
          inject_key: 'comms_reporter_presses',
          team: 'Communications',
          minute: 26,
          tone: 'defensive',
          criteria_met: 1,
          criteria_total: 4,
        },
      ],
    });
    assert.equal(section.chains.length, 1);
    const text = section.chains[0]?.text ?? '';
    assert.ok(text.indexOf('Reporter presses for numbers') < text.indexOf('(depth 2)'));
    assert.match(text, /T\+31 Legal receives "Regulator asks about the statement" \(depth 2\)/);
    assert.equal(section.chains[0]?.depth, 2);
  });

  test('a missing parent is named and the chain is kept', () => {
    const section = buildCrossTeamSection({
      triggers: [
        trigger({
          inject_key: 'comms_reporter_presses',
          title: 'Reporter presses for numbers',
          minute: 23,
          origin: 'dependency',
          source_teams: ['Operations'],
          target_teams: ['Communications'],
          dep_id: 'dep_ops_headcount_comms',
          cause_depth: 1,
          parent_inject_keys: ['gone_key'],
        }),
      ],
      edges: [edges[0]!],
      replies: [],
    });
    assert.equal(section.chains.length, 1);
    assert.deepEqual(section.chains[0]?.missing_parents, ['gone_key']);
    assert.match(section.chains[0]?.text ?? '', /parent 'gone_key' was not recorded/);
    assert.match(section.chains[0]?.text ?? '', /Communications receives/);
  });

  test('no trigger rows fall back to static links marked inferred', () => {
    const section = buildCrossTeamSection({
      triggers: [],
      edges: [edges[0]!],
      replies: [],
      inferred: [
        trigger({
          inject_key: 'comms_reporter_presses',
          title: 'Reporter presses for numbers',
          minute: null,
          origin: 'conditional',
          source_teams: ['Operations'],
          target_teams: ['Communications'],
          dep_id: 'dep_ops_headcount_comms',
          cause_depth: 1,
          parent_inject_keys: ['bay3_headcount_request'],
        }),
      ],
    });
    assert.equal(section.provenance, 'inferred');
    assert.equal(section.chains[0]?.provenance, 'inferred');
    assert.match(section.chains[0]?.text ?? '', /inferred$/);
    assert.deepEqual(section.chains[0]?.missing_parents, ['bay3_headcount_request']);
    assert.equal(section.edges[0]?.outcome, 'broken');
  });

  test('a null trigger list is the same inferred fallback', () => {
    const section = buildCrossTeamSection({ triggers: null, edges: [], replies: [] });
    assert.equal(section.provenance, 'inferred');
    assert.deepEqual(section.chains, []);
  });

  test('per-team counts split caused, received and the pressure share', () => {
    const section = buildCrossTeamSection({ triggers: exampleA, edges, replies: [] });
    const byTeam = Object.fromEntries(section.teams.map((team) => [team.team, team]));
    assert.equal(byTeam.Operations?.caused, 1);
    assert.equal(byTeam.Operations?.received, 0);
    assert.deepEqual(byTeam.Operations?.share, { authored: 100, cross_team: 0, unscripted: 0 });
    assert.equal(byTeam.Communications?.caused, 1);
    assert.equal(byTeam.Communications?.received, 2);
    assert.equal(byTeam.Communications?.pressure.authored, 1);
    assert.equal(byTeam.Communications?.pressure.cross_team, 2);
    assert.deepEqual(byTeam.Communications?.share, { authored: 33, cross_team: 67, unscripted: 0 });
    assert.equal(byTeam.Legal?.caused, 2);
    assert.equal(byTeam.Legal?.received, 1);
    assert.deepEqual(byTeam.Legal?.share, { authored: 50, cross_team: 50, unscripted: 0 });
    assert.equal(byTeam['Customer Service']?.received, 1);
    assert.equal(byTeam['Customer Service']?.pressure.cross_team, 1);
  });

  test('the director origin is labelled even when no director table exists', () => {
    assert.equal(originLabel('director'), 'Unscripted (AI director)');
    assert.equal(originLabel('timed'), 'Authored (timed)');
    assert.equal(originLabel('conditional'), 'Authored (conditional)');
    assert.equal(originLabel('conditional', true), 'Cross-team consequence');
    assert.equal(originLabel('dependency'), 'Cross-team consequence');
    assert.equal(originLabel('chain'), 'Escalation step');
    assert.equal(originLabel('mood'), 'Mood consequence');
    assert.equal(originLabel('decision'), 'Decision reaction');
    assert.equal(originLabel('trainer'), 'Trainer');
    assert.equal(originLabel('mystery'), 'inferred');
    const section = buildCrossTeamSection({
      triggers: [
        trigger({
          inject_key: 'dir_3',
          title: 'Comment on the Bay 3 incident',
          minute: 32,
          origin: 'director',
          source_teams: [],
          target_teams: ['Legal'],
          dep_id: null,
          cause_depth: 0,
          parent_inject_keys: [],
        }),
      ],
      edges: [],
      replies: [],
    });
    assert.match(section.chains[0]?.text ?? '', /Unscripted \(AI director\)/);
    assert.equal(section.teams[0]?.pressure.unscripted, 1);
    assert.equal(section.teams[0]?.received, 1);
  });
});

describe('branch rows', () => {
  const injects = [
    {
      id: 'root',
      inject_key: 'bay3_headcount_request',
      title: 'Bay 3 headcount',
      requires_response: true,
      app: 'email',
    },
    {
      id: 'inj-reporter',
      inject_key: 'comms_reporter_presses',
      title: 'Reporter presses for numbers',
      app: 'email',
      conditions_to_appear: { all: ['unresponded:bay3_headcount_request:10'] },
    },
  ];
  const deliveries = [
    {
      id: 'del-root',
      inject_id: 'root',
      inject_key: 'bay3_headcount_request',
      channel: 'email',
      delivered_minute: 8,
      requires_response: true,
    },
  ];

  test('who and the origin come from the trigger', () => {
    const section = buildCommsResponsesSection({
      injects,
      deliveries,
      events: [{ event_type: 'inject', minute: 23, inject_id: 'inj-reporter' }],
      triggers: [
        {
          inject_id: 'inj-reporter',
          inject_key: 'comms_reporter_presses',
          origin: 'dependency',
          source_teams: ['Operations'],
          target_teams: ['Communications'],
        },
      ],
    });
    const branch = section.timeline.find((row) => row.event === 'branch');
    assert.equal(branch?.who, 'Operations');
    assert.equal(branch?.origin, 'Cross-team consequence');
    assert.equal(branch?.detail, 'published: Reporter presses for numbers');
  });

  test('a session without trigger rows marks the branch inferred', () => {
    const section = buildCommsResponsesSection({
      injects,
      deliveries,
      events: [{ event_type: 'inject', minute: 23, inject_id: 'inj-reporter' }],
    });
    const branch = section.timeline.find((row) => row.event === 'branch');
    assert.equal(branch?.who, '');
    assert.equal(branch?.origin, 'inferred');
  });
});

describe('dependency panel state', () => {
  test('at risk starts when the due minute is 5 minutes away', () => {
    assert.equal(AT_RISK_WITHIN_MINUTES, 5);
    assert.equal(panelChip('pending', 20, 14), 'pending');
    assert.equal(panelChip('pending', 20, 15), 'at_risk');
    assert.equal(panelChip('pending', 20, 20), 'at_risk');
    assert.equal(panelChip('pending', 20, 25), 'at_risk');
    assert.equal(panelChip('pending', null, 25), 'pending');
    assert.equal(panelChip('broken', 20, 19), 'broken');
    assert.equal(panelChip('met', 20, 19), 'met');
    assert.equal(panelChip('recovered', 20, 19), 'late');
    assert.equal(panelChip('waived', 20, 19), 'waived');
  });

  test('the lag countdown counts the hold when it runs past the lag', () => {
    assert.equal(
      lagCountdown({
        status: 'broken',
        brokenMinute: 18,
        lagMinutes: 5,
        holdUntilMinute: null,
        elapsed: 20,
      }),
      3,
    );
    assert.equal(
      lagCountdown({
        status: 'broken',
        brokenMinute: 18,
        lagMinutes: 5,
        holdUntilMinute: null,
        elapsed: 23,
      }),
      null,
    );
    assert.equal(
      lagCountdown({
        status: 'broken',
        brokenMinute: 18,
        lagMinutes: 5,
        holdUntilMinute: 28,
        elapsed: 23,
      }),
      5,
    );
    assert.equal(
      lagCountdown({
        status: 'met',
        brokenMinute: 18,
        lagMinutes: 5,
        holdUntilMinute: null,
        elapsed: 20,
      }),
      null,
    );
    assert.equal(canWaive('broken'), true);
    assert.equal(canWaive('waived'), false);
    assert.equal(canHold('broken'), true);
    assert.equal(canHold('pending'), true);
    assert.equal(canHold('met'), false);
  });

  test('the panel groups by downstream team and windows the pressure strip', () => {
    const panelEdges: PanelEdgeInput[] = [
      {
        id: 'dep_ops_headcount_comms',
        upstream_name: 'Operations',
        downstream_names: ['Communications'],
        deliverable: 'Confirmed headcount for Bay 3',
        why: 'Communications cannot publish figures without it',
        due: { after_inject_key: 'bay3_headcount_request', within_minutes: 10 },
        lag_minutes: 5,
        status: 'broken',
        broken_minute: 18,
        met_minute: null,
        recovered_minute: null,
        hold_until_minute: null,
      },
      {
        id: 'dep_legal_statement_comms_cs',
        upstream_name: 'Legal',
        downstream_names: ['Communications', 'Customer Service'],
        deliverable: 'Approval of the holding statement',
        why: 'Neither team can speak without it',
        due: { by_minute: 24 },
        lag_minutes: 3,
        status: 'pending',
        broken_minute: null,
        met_minute: null,
        recovered_minute: null,
        hold_until_minute: null,
      },
    ];
    const view = buildPanelView({
      edges: panelEdges,
      elapsed: 20,
      anchors: { bay3_headcount_request: 8 },
      events: [
        { minute: 4, origin: 'timed', source_teams: [], target_teams: ['Operations'] },
        { minute: 4, origin: 'timed', source_teams: [], target_teams: ['Communications'] },
        {
          minute: 16,
          origin: 'dependency',
          source_teams: ['Operations'],
          target_teams: ['Communications'],
        },
        { minute: 19, origin: 'director', source_teams: [], target_teams: ['Legal'] },
      ],
      held: [
        { inject_key: 'comms_ceo_asks', reason: 'throttle', minute: 19 },
        { inject_key: 'comms_ceo_asks', reason: 'throttle', minute: 18 },
        { inject_key: 'legal_loop', reason: 'cross_team_loop_held', minute: 20 },
      ],
    });
    assert.deepEqual(
      view.groups.map((group) => group.team),
      ['Communications', 'Customer Service'],
    );
    assert.equal(view.groups[0]?.edges.length, 2);
    const headcount = view.groups[0]?.edges.find((edge) => edge.id === 'dep_ops_headcount_comms');
    assert.equal(headcount?.chip, 'broken');
    assert.equal(headcount?.countdown_minutes, 3);
    assert.equal(headcount?.due_minute, 18);
    const statement = view.groups[1]?.edges[0];
    assert.equal(statement?.chip, 'at_risk');
    const comms = view.pressure.find((row) => row.team === 'Communications');
    assert.deepEqual(comms, { team: 'Communications', authored: 0, cross_team: 1, unscripted: 0 });
    const legal = view.pressure.find((row) => row.team === 'Legal');
    assert.equal(legal?.unscripted, 1);
    assert.equal(
      view.pressure.some((row) => row.team === 'Operations'),
      false,
    );
    assert.equal(view.held.length, 2);
    assert.match(view.held[0]?.reason_label ?? '', /answering this consequence/);
    assert.match(view.held[1]?.reason_label ?? '', /cross-team limit/);
  });
});

describe('cross-team read limits', () => {
  test('trigger, state, reply, chain-step and name reads are capped', () => {
    for (const limit of Object.values(CROSS_TEAM_READ_LIMITS)) {
      assert.equal(Number.isFinite(limit), true);
      assert.ok(limit > 0);
      assert.ok(limit <= 2000);
    }
    assert.equal(CROSS_TEAM_READ_LIMITS.chainSteps, 2000);
    assert.equal(CROSS_TEAM_READ_LIMITS.names, 2000);
    assert.equal(CROSS_TEAM_READ_LIMITS.triggers, 2000);
  });
});
