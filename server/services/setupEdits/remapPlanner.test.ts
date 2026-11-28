import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson } from '../../../shared/canonicalJson.js';
import { makeOrgKey } from '../scenarioOrgModel.js';
import {
  CALL_LINE_STEPS,
  EDIT_TOKEN,
  planRemap,
  type JsonPatch,
  type OrphanResolution,
  type PlannerInject,
  type PlannerTeam,
  type RemapPlan,
  type RemapPlannerInput,
} from './remapPlanner.js';
import { collectInjectsWithHistory, isRemapTableMissing } from './remapPlanLoader.js';
import {
  delta,
  emptySession,
  inject,
  input,
  snapshot,
  snapshotOrg,
  snapshotTeam,
  team,
} from './fixtures/remapFixtures.js';

/**
 * §4.7 coverage:
 * scenario_teams rename/remove — tests 1, 3, 9
 * target_teams — tests 1, 3
 * condition |team= and retired inject keys — tests 1, 3
 * stakeholder_team and parent_target_teams — tests 1, 3
 * delivery_config.org_key stable on rename, retired on org removal, remapped on swap — tests 1, 4, 9
 * player_roles — tests 1, 3
 * stakeholders owning_team and org_key — tests 1, 3, 4, 10
 * strategic_benchmarks — tests 1, 3
 * orgs, org_page.orgs, countries — tests 4, 5, 9
 * scheduled session_teams, channels, call lines, role assignments, page controllers — tests 1, 2, 3, 4, 11
 * started-session history — tests 2, 11
 * team_dependencies — tests 1, 3, and the dependency remap tests
 */

function replaced(plan: RemapPlan, path: string): unknown {
  const patch = plan.initial_state.patch.find((item) => item.path === path);
  assert.ok(patch, `missing initial_state patch ${path}`);
  return (patch as JsonPatch).value;
}

const LEGAL = '11111111-1111-4111-8111-111111111111';
const COMMS = '22222222-2222-4222-8222-222222222222';
const OPS = '33333333-3333-4333-8333-333333333333';

function reassignWorld(): RemapPlannerInput {
  return input({
    delta: delta({ removed_teams: [{ team_uid: LEGAL, team_name: 'Legal' }] }),
    edited: snapshot([
      snapshotOrg({
        org_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        is_primary: true,
        teams: [
          snapshotTeam({ team_uid: COMMS, team_name: 'Communications' }),
          snapshotTeam({ team_uid: OPS, team_name: 'Operations' }),
        ],
      }),
    ]),
    teams: [
      team({ id: 'team-legal', team_uid: LEGAL, team_name: 'Legal' }),
      team({ id: 'team-comms', team_uid: COMMS, team_name: 'Communications' }),
      team({ id: 'team-ops', team_uid: OPS, team_name: 'Operations' }),
    ],
    injects: [
      inject({
        id: 'inj-brief',
        inject_key: 'legal_brief',
        target_teams: ['Communications'],
      }),
    ],
    initial_state: {
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_brief',
            kind: 'information',
            upstream: { team_uid: LEGAL, team_name: 'Legal' },
            downstream: [{ team_uid: COMMS, team_name: 'Communications' }],
            deliverable: 'Confirmed headcount',
            why: 'Communications cannot publish a figure without it',
            due: { by_minute: 20 },
            broken_when: { all: ['unresponded:legal_brief:10|team=@upstream'] },
            met_when: null,
            lag_minutes: 5,
            severity: 'medium',
            consequence_keys: [],
            source: 'war_room',
          },
        ],
      },
    },
  });
}

function resolutionFor(orphan: {
  kind: string;
  condition_key?: string;
  target_key?: string;
}): OrphanResolution {
  if (orphan.kind === 'player_role') return { choice: 'reassign', team_name: 'Communications' };
  if (orphan.kind === 'condition' && orphan.condition_key?.includes('|team=')) {
    return { choice: 'retarget', team_name: 'Communications' };
  }
  if (orphan.kind === 'condition') return { choice: 'keep' };
  if (orphan.kind === 'stakeholder') return { choice: 'reassign', team_name: 'Communications' };
  if (orphan.kind === 'pressure_targets') return { choice: 'retarget', org_keys: ['primary'] };
  if (orphan.kind === 'chain_target' && orphan.target_key) {
    return { choice: 'retarget', inject_key: 'mixed_mail' };
  }
  if (orphan.kind === 'chain_target') return { choice: 'retarget', team_name: 'Communications' };
  if (orphan.kind === 'mood_consequence') return { choice: 'clear' };
  if (orphan.kind === 'team_dependency' && orphan.condition_key) return { choice: 'clear' };
  if (orphan.kind === 'team_dependency' && !orphan.target_key) return { choice: 'remove' };
  if (orphan.kind === 'team_dependency') return { choice: 'clear' };
  return { choice: 'keep' };
}

function patchOr<T>(plan: RemapPlan, path: string, fallback: T): T {
  const patch = plan.initial_state.patch.find((item) => item.path === path);
  return (patch ? patch.value : fallback) as T;
}

function renameWorld(): RemapPlannerInput {
  const legal = team({
    id: 'team-legal',
    team_uid: 'uid-legal',
    team_name: 'Legal',
    function_key: 'Legal',
    charter: { mission: 'Hold the line', team_name: 'Legal', org_key: 'primary' },
    scoring_rubric: 'Be precise',
    expected_actions: [{ action_id: 'notify' }],
  });
  const comms = team({
    id: 'team-comms',
    team_uid: 'uid-comms',
    team_name: 'Communications',
    function_key: 'Communications',
  });
  const live = inject({
    id: 'inj-live',
    inject_key: 'briefing_mail',
    has_history: false,
    title: 'Ask Legal now',
    content: 'The Legal team acts. Legally fine.',
    target_teams: ['Legal', 'Communications'],
    conditions_to_appear: { all: ['responded:briefing_mail|team=legal'] },
    conditions_to_cancel: ['responded:other_mail|team=legal'],
    delivery_config: {
      org_key: 'primary',
      stakeholder_team: 'Legal',
      parent_target_teams: ['Legal'],
    },
  });
  const historic = inject({
    id: 'inj-hist',
    inject_key: 'briefing_mail_hist',
    has_history: true,
    title: 'Legal update',
    content: 'Legal wrote this.',
    target_teams: ['Legal'],
    conditions_to_appear: { all: ['responded:briefing_mail_hist|team=legal'] },
    delivery_config: {
      stakeholder_team: 'Legal',
      parent_target_teams: ['Legal'],
      org_key: 'primary',
    },
  });
  return input({
    delta: delta({
      renamed_teams: [{ team_uid: 'uid-legal', from: 'Legal', to: 'Counsel' }],
    }),
    edited: snapshot([
      snapshotOrg({
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        is_primary: true,
        teams: [
          snapshotTeam({ team_uid: 'uid-legal', team_name: 'Counsel', function_key: 'Legal' }),
          snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' }),
        ],
      }),
    ]),
    teams: [legal, comms],
    injects: [live, historic],
    sessions: [
      emptySession({
        session_id: 'sess-scheduled',
        teams: [{ user_id: 'user-1', team_name: 'Legal' }],
        channels: [{ team_name: 'Legal', message_count: 1 }],
        call_lines: [{ team_name: 'Legal' }],
        call_takers: [{ team_name: 'Legal', user_id: 'user-1' }],
        role_assignments: [{ role_id: 'cs_head', user_id: 'user-1' }],
      }),
      emptySession({
        session_id: 'sess-completed-9f3a',
        status: 'completed',
        start_time: '2026-01-01T00:00:00.000Z',
        teams: [{ user_id: 'completed-user-9f3a', team_name: 'Legal' }],
        call_lines: [{ team_name: 'Legal' }],
        call_takers: [{ team_name: 'Legal', user_id: 'completed-user-9f3a' }],
      }),
    ],
    initial_state: {
      player_roles: [
        { role_id: 'cs_head', title: 'Head of Legal', team_name: 'Legal', max_per_session: 1 },
        { role_id: 'press', title: 'Press', team_name: 'Communications', max_per_session: 1 },
      ],
      stakeholders: [
        { id: 'stk_counsel', name: 'Ada', owning_team: 'Legal', org_key: 'primary' },
        { id: 'stk_fn', name: 'Bea', owning_team: 'Operations', org_key: 'primary' },
      ],
      strategic_benchmarks: [
        {
          team: 'Legal',
          description: 'Legal fulfilled: notify',
          consequence_if_done: 'Legal fulfilled: notify',
          consequence_if_missed: 'Legal missed: notify',
        },
        { team: 'Communications', description: 'Communications fulfilled: post' },
      ],
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_brief',
            upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
            downstream: [{ team_uid: 'uid-comms', team_name: 'Communications' }],
            broken_when: { all: ['responded:briefing_mail|team=legal'] },
            met_when: null,
            consequence_keys: [],
            due: { by_minute: 10 },
          },
        ],
      },
    },
  });
}

function removalWorld(): RemapPlannerInput {
  return input({
    delta: delta({
      removed_teams: [{ team_uid: 'uid-legal', team_name: 'Legal' }],
    }),
    edited: snapshot([
      snapshotOrg({
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        is_primary: true,
        teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
      }),
    ]),
    teams: [
      team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
      team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
    ],
    injects: [
      inject({
        id: 'inj-only',
        inject_key: 'only_legal',
        target_teams: ['Legal'],
        delivery_config: { stakeholder_team: 'Legal', parent_target_teams: ['Legal'] },
      }),
      inject({
        id: 'inj-layer',
        inject_key: 'layer_legal',
        target_teams: ['Communications'],
        delivery_config: { gen: { layer: 'team:uid-legal', edit: 0, hash: 'abc' } },
      }),
      inject({
        id: 'inj-mixed',
        inject_key: 'mixed_mail',
        target_teams: ['Legal', 'Communications'],
        conditions_to_appear: {
          all: ['inject_fired:only_legal', 'responded:mixed_mail|team=legal'],
        },
        delivery_config: {
          org_key: 'primary',
          stakeholder_team: 'Legal',
          parent_target_teams: ['Legal', 'Communications'],
          target_role_id: 'cs_head',
          escalation: {
            max_steps: 1,
            steps: [{ target_team: 'Legal', cc_team: 'Communications' }],
            on_exhausted: { publish_inject_key: 'only_legal' },
          },
          mood_ladder: {
            rungs: [
              { id: 'angry', consequences: [{ type: 'publish_inject', inject_key: 'only_legal' }] },
            ],
          },
        },
      }),
    ],
    sessions: [
      emptySession({
        session_id: 'sess-scheduled',
        teams: [
          { user_id: 'user-1', team_name: 'Legal' },
          { user_id: 'user-2', team_name: 'Communications' },
        ],
        channels: [
          { team_name: 'Legal', message_count: 0 },
          { team_name: 'Communications', message_count: 2 },
        ],
        call_lines: [{ team_name: 'Legal' }],
        call_takers: [{ team_name: 'Legal', user_id: 'user-1' }],
        role_assignments: [{ role_id: 'cs_head', user_id: 'user-1' }],
      }),
    ],
    initial_state: {
      player_roles: [
        { role_id: 'cs_head', title: 'Head of Legal', team_name: 'Legal', max_per_session: 1 },
      ],
      stakeholders: [{ id: 'stk_ada', name: 'Ada', owning_team: 'Legal', org_key: 'primary' }],
      strategic_benchmarks: [
        { team: 'Legal', description: 'Legal fulfilled: notify' },
        { team: 'Communications', description: 'Communications fulfilled: post' },
      ],
      team_dependencies: {
        v: 1,
        edges: [
          {
            id: 'dep_brief',
            upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
            downstream: [{ team_uid: 'uid-comms', team_name: 'Communications' }],
            broken_when: { all: ['team_silent:10|team=legal'] },
            met_when: null,
            consequence_keys: ['only_legal'],
            due: { by_minute: 10 },
          },
        ],
      },
    },
  });
}

interface OrgRow {
  org_uid?: string;
  org_key?: string;
  display_name?: string;
  is_primary?: boolean;
  logo_url?: string;
  targets_org_keys?: string[];
  sites?: Array<{ site_key: string }>;
  posture?: { targets_org_keys?: string[] };
}

function acme(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_uid: 'uid-a',
    org_key: 'primary',
    display_name: 'Acme',
    short_name: 'ACME',
    country: 'Singapore',
    city: 'Singapore',
    side: 'protagonist',
    is_primary: true,
    operation: 'players',
    kind: 'company',
    sites: [{ site_key: 'hq_singapore', name: 'Acme — Singapore', country: 'Singapore' }],
    ...partial,
  };
}

function bravo(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_uid: 'uid-b',
    org_key: 'org_bravo_my',
    display_name: 'Bravo',
    short_name: 'BRAVO',
    country: 'Malaysia',
    city: 'Kuala Lumpur',
    side: 'protagonist',
    is_primary: false,
    operation: 'players',
    kind: 'company',
    sites: [{ site_key: 'bravo_kualalumpur', name: 'Bravo — Kuala Lumpur', country: 'Malaysia' }],
    ...partial,
  };
}

function charlie(): Record<string, unknown> {
  return {
    org_uid: 'uid-c',
    org_key: 'org_charlie_sg',
    display_name: 'Charlie',
    short_name: 'CHAS',
    country: 'Singapore',
    side: 'protagonist',
    is_primary: false,
    operation: 'players',
    kind: 'company',
    sites: [{ site_key: 'chas_singapore', name: 'Charlie — Singapore', country: 'Singapore' }],
  };
}

function history(): unknown[] {
  return [
    { org_uid: 'uid-a', org_key: 'primary', from_edit: null, until_edit: null },
    { org_uid: 'uid-b', org_key: 'org_bravo_my', from_edit: null, until_edit: null },
    { org_uid: 'uid-c', org_key: 'org_charlie_sg', from_edit: null, until_edit: null },
    { org_uid: 'uid-old', org_key: 'org_old_sg', from_edit: null, until_edit: 'edit-old' },
  ];
}

function swapEdited(primaryUid: string) {
  return [
    snapshotOrg({
      org_uid: 'uid-a',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      country: 'Singapore',
      city: 'Singapore',
      is_primary: primaryUid === 'uid-a',
      teams: [snapshotTeam({ team_uid: 'uid-a-comms', team_name: 'Communications' })],
    }),
    snapshotOrg({
      org_uid: 'uid-b',
      org_key: 'org_bravo_my',
      display_name: 'Bravo',
      short_name: 'BRAVO',
      country: 'Malaysia',
      city: 'Kuala Lumpur',
      is_primary: primaryUid === 'uid-b',
      teams: [snapshotTeam({ team_uid: 'uid-b-comms', team_name: 'Communications — BRAVO' })],
    }),
    snapshotOrg({
      org_uid: 'uid-c',
      org_key: 'org_charlie_sg',
      display_name: 'Charlie',
      short_name: 'CHAS',
      country: 'Singapore',
      is_primary: false,
      teams: [snapshotTeam({ team_uid: 'uid-c-comms', team_name: 'Communications — CHAS' })],
    }),
  ];
}

function swapTeams(): PlannerTeam[] {
  return [
    team({
      id: 'a-comms',
      team_uid: 'uid-a-comms',
      team_name: 'Communications',
      org_key: 'primary',
      charter: { org_key: null, mission: 'Acme voice' },
    }),
    team({
      id: 'b-comms',
      team_uid: 'uid-b-comms',
      team_name: 'Communications — BRAVO',
      org_key: 'org_bravo_my',
    }),
    team({
      id: 'c-comms',
      team_uid: 'uid-c-comms',
      team_name: 'Communications — CHAS',
      org_key: 'org_charlie_sg',
    }),
  ];
}

function swapInjects(): PlannerInject[] {
  return [
    inject({
      id: 'inj-a',
      inject_key: 'acme_note',
      has_history: false,
      target_teams: ['Communications'],
      delivery_config: { org_key: 'primary' },
    }),
    inject({
      id: 'inj-b',
      inject_key: 'bravo_note',
      has_history: true,
      target_teams: ['Communications — BRAVO'],
      delivery_config: { org_key: 'org_bravo_my' },
    }),
    inject({
      id: 'inj-hand',
      inject_key: 'hand_note',
      has_history: false,
      generation_source: 'trainer',
      title: 'Acme speaks',
      content: 'Acme is the company in crisis',
      delivery_config: { org_key: 'primary' },
    }),
  ];
}

function swapState(): Record<string, unknown> {
  return {
    country: 'Singapore',
    org_name: 'Acme',
    orgs: [
      acme(),
      bravo(),
      charlie(),
      {
        org_uid: 'uid-union',
        org_key: 'org_pressure_union_sg',
        display_name: 'Union',
        side: 'pressure',
        country: 'Singapore',
        targets_org_keys: ['primary', 'org_charlie_sg'],
      },
    ],
    org_page: {
      orgs: [
        {
          org_uid: 'uid-a',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          logo_url: 'logo-acme',
          role: 'protagonist',
        },
        {
          org_uid: 'uid-b',
          org_key: 'org_bravo_my',
          display_name: 'Bravo',
          is_primary: false,
          logo_url: 'logo-bravo',
          role: 'protagonist',
        },
        {
          org_uid: 'uid-c',
          org_key: 'org_charlie_sg',
          display_name: 'Charlie',
          is_primary: false,
          logo_url: 'logo-charlie',
          role: 'protagonist',
        },
        {
          org_uid: 'uid-union',
          org_key: 'org_pressure_union_sg',
          display_name: 'Union',
          role: 'pressure',
          posture: { targets_org_keys: ['primary', 'org_charlie_sg'] },
        },
      ],
    },
    stakeholders: [
      { id: 'stk_null', name: 'Pat', owning_team: 'Communications', org_key: null },
      { id: 'stk_b', name: 'Bo', owning_team: 'Communications — BRAVO', org_key: 'org_bravo_my' },
    ],
    org_key_history: history(),
    decision_context: {
      leakiness: 0.2,
      labour_signal: false,
      product_safety_signal: false,
      note: { org_key: 'primary' },
    },
    sop_steps: [{ step_id: 'notify', org_key: 'org_bravo_my' }],
  };
}

function swapInput(): RemapPlannerInput {
  return input({
    delta: delta({
      primary_swap: { from_org_uid: 'uid-a', to_org_uid: 'uid-b', to_is_new: false },
    }),
    edited: snapshot(swapEdited('uid-b'), {
      pressure_organisations: [
        {
          org_uid: 'uid-union',
          org_key: 'org_pressure_union_sg',
          display_name: 'Union',
          country: 'Singapore',
          targets_org_keys: ['primary', 'org_charlie_sg'],
        },
      ],
    }),
    initial_state: swapState(),
    teams: swapTeams(),
    injects: swapInjects(),
  });
}

function freshPrimaryKey(): string {
  return makeOrgKey(
    { display_name: 'Acme', short_name: 'ACME', country: 'Singapore', is_primary: false },
    new Set(['primary', 'org_bravo_my', 'org_charlie_sg', 'org_pressure_union_sg', 'org_old_sg']),
  );
}

describe('remap planner', () => {
  test('renaming a team rewrites targets, scopes, roles, benchmarks and copies the team', () => {
    const plan = planRemap(renameWorld());
    const successor = plan.teams.successors.find((row) => row.team_uid === 'uid-legal');
    assert.ok(successor, 'scenario_teams rename is a successor');
    assert.equal(successor.team_name, 'Counsel');
    assert.equal(successor.from_name, 'Legal');
    assert.equal(successor.source_id, 'team-legal');
    assert.equal(plan.teams.retire.find((row) => row.team_uid === 'uid-legal')?.reason, 'renamed');
    assert.equal(
      plan.teams.retire.find((row) => row.team_uid === 'uid-legal')?.source_id,
      successor.source_id,
    );
    assert.equal(successor.scoring_rubric, 'Be precise');
    assert.deepEqual(successor.expected_actions, [{ action_id: 'notify' }]);
    assert.equal((successor.charter as { team_name: string }).team_name, 'Counsel');
    assert.equal(
      plan.teams.successors.some((row) => row.team_uid === 'uid-comms'),
      false,
    );

    const live = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-live');
    assert.ok(live);
    assert.equal(live.has_history, false);
    assert.equal(live.inject_key, 'briefing_mail');
    assert.deepEqual(live.changes.target_teams, ['Counsel', 'Communications']);
    assert.deepEqual(live.changes.conditions_to_appear, {
      all: ['responded:briefing_mail|team=counsel'],
    });
    assert.deepEqual(live.changes.conditions_to_cancel, ['responded:other_mail|team=counsel']);
    assert.equal(live.changes.title, 'Ask Counsel now');
    assert.equal(live.changes.content, 'The Counsel team acts. Legally fine.');
    const liveConfig = live.changes.delivery_config as {
      org_key: string;
      stakeholder_team: string;
      parent_target_teams: string[];
    };
    assert.equal(liveConfig.stakeholder_team, 'Counsel');
    assert.deepEqual(liveConfig.parent_target_teams, ['Counsel']);
    assert.equal(
      liveConfig.org_key,
      'primary',
      'a team rename does not re-key delivery_config.org_key',
    );

    const historic = plan.injects.cow.find((row) => row.source_id === 'inj-hist');
    assert.ok(historic, 'an inject with history is copy-on-write');
    assert.equal(historic.inject_key, 'briefing_mail_hist');
    assert.equal(historic.has_history, true);
    assert.deepEqual(historic.changes.target_teams, ['Counsel']);
    assert.equal(
      plan.injects.rewrite_in_place.some((row) => row.inject_id === 'inj-hist'),
      false,
    );
    assert.equal(
      plan.injects.cow.some((row) => row.source_id === 'inj-live'),
      false,
    );

    const roles = replaced(plan, '/player_roles') as Array<{ role_id: string; team_name: string }>;
    assert.equal(roles.find((role) => role.role_id === 'cs_head')?.team_name, 'Counsel');
    assert.equal(roles.find((role) => role.role_id === 'press')?.team_name, 'Communications');

    const stakeholders = replaced(plan, '/stakeholders') as Array<{
      id: string;
      owning_team: string;
    }>;
    assert.equal(stakeholders.find((row) => row.id === 'stk_counsel')?.owning_team, 'Counsel');
    assert.equal(stakeholders.find((row) => row.id === 'stk_fn')?.owning_team, 'Operations');

    const benchmarks = replaced(plan, '/strategic_benchmarks') as Array<{
      team: string;
      consequence_if_done?: string;
    }>;
    const legalBench = benchmarks.find((row) => row.team === 'Counsel');
    assert.ok(legalBench);
    assert.equal(legalBench.consequence_if_done, 'Counsel fulfilled: notify');
    assert.equal(
      benchmarks.some((row) => row.team === 'Legal'),
      false,
    );

    const dependencies = replaced(plan, '/team_dependencies') as {
      edges: Array<{ upstream: { team_name: string }; broken_when: { all: string[] } }>;
    };
    assert.equal(dependencies.edges[0].upstream.team_name, 'Counsel');
    assert.deepEqual(dependencies.edges[0].broken_when.all, ['responded:briefing_mail|team=counsel']);

    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.deepEqual(session.rename.team_names, [{ from: 'Legal', to: 'Counsel' }]);
    assert.deepEqual(session.rename.channels, [{ from: 'Legal', to: 'Counsel' }]);
    assert.equal(session.retire_roles.length, 0, 'role_id stays put when the team is only renamed');
    assert.equal(plan.applicable, true);
  });

  test('a scheduled call line moves takers in order and a completed session is absent', () => {
    const plan = planRemap(renameWorld());
    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.deepEqual(session.rename.call_lines, [
      { from_team: 'Legal', to_team: 'Counsel', steps: CALL_LINE_STEPS },
    ]);
    assert.deepEqual([...CALL_LINE_STEPS], ['insert_line', 'move_takers', 'delete_old_line']);
    const encoded = JSON.stringify(plan);
    assert.equal(encoded.includes('sess-completed-9f3a'), false);
    assert.equal(encoded.includes('completed-user-9f3a'), false);
    assert.equal(
      plan.scheduled_sessions.some((row) => row.session_id === 'sess-completed-9f3a'),
      false,
    );
  });

  test('removing a team retires single-target injects, trims mixed targets, and lists orphans', () => {
    const plan = planRemap(removalWorld());
    assert.deepEqual(
      plan.teams.retire.map((row) => row.team_uid),
      ['uid-legal'],
    );
    assert.equal(plan.teams.successors.length, 0);
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-only')?.reason,
      'targets_only_removed',
    );
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-layer')?.reason,
      'team_layer',
    );
    assert.equal(
      plan.injects.retire.some((row) => row.inject_id === 'inj-mixed'),
      false,
    );

    const mixed = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-mixed');
    assert.ok(mixed);
    assert.deepEqual(mixed.changes.target_teams, ['Communications']);
    const config = mixed.changes.delivery_config as {
      org_key?: string;
      stakeholder_team?: string;
      parent_target_teams: string[];
      escalation: { steps: Array<{ target_team?: string; cc_team?: string }> };
    };
    assert.equal(config.stakeholder_team, undefined);
    assert.deepEqual(config.parent_target_teams, ['Communications']);
    assert.equal(config.org_key, 'primary');
    assert.equal(
      config.escalation.steps[0].target_team,
      'Legal',
      'a chain step aimed at a removed team stays for the trainer',
    );
    assert.equal(config.escalation.steps[0].cc_team, 'Communications');

    assert.ok(plan.orphans.some((row) => row.kind === 'player_role' && row.role_id === 'cs_head'));
    assert.ok(
      plan.orphans.some(
        (row) =>
          row.kind === 'condition' && row.condition_key === 'responded:mixed_mail|team=legal',
      ),
    );
    assert.ok(
      plan.orphans.some((row) => row.kind === 'condition' && row.target_key === 'only_legal'),
    );
    assert.ok(
      plan.orphans.some((row) => row.kind === 'stakeholder' && row.stakeholder_id === 'stk_ada'),
    );
    assert.ok(
      plan.orphans.some((row) => row.kind === 'chain_target' && row.target_key === 'only_legal'),
    );
    assert.ok(plan.orphans.some((row) => row.kind === 'chain_target' && row.team_name === 'Legal'));
    assert.ok(
      plan.orphans.some(
        (row) => row.kind === 'mood_consequence' && row.target_key === 'only_legal',
      ),
    );
    assert.ok(
      plan.orphans.some(
        (row) => row.kind === 'team_dependency' && row.dependency_id === 'dep_brief',
      ),
    );
    assert.ok(
      plan.warnings.some(
        (row) => row.code === 'retired_role_fallback' && row.role_id === 'cs_head',
      ),
    );

    const roles = patchOr(plan, '/player_roles', [
      { role_id: 'cs_head', team_name: 'Legal' },
    ]) as Array<{ role_id: string }>;
    assert.ok(
      roles.some((role) => role.role_id === 'cs_head'),
      'the role stays until the trainer decides',
    );
    const benchmarks = replaced(plan, '/strategic_benchmarks') as Array<{ team: string }>;
    assert.deepEqual(
      benchmarks.map((row) => row.team),
      ['Communications'],
    );

    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.deepEqual(session.remove_teams, ['Legal']);
    assert.deepEqual(session.unassigned_players, [{ user_id: 'user-1', team_name: 'Legal' }]);
    assert.deepEqual(session.delete_call_lines, ['Legal']);
    assert.deepEqual(session.delete_channels, ['Legal']);
    assert.equal(session.delete_channels.includes('Communications'), false);
    assert.deepEqual(session.retire_roles, ['cs_head']);
    assert.equal(plan.applicable, false);
  });

  test('removing an organisation retires its registry, page, stakeholders and scoped injects', () => {
    const plan = planRemap(
      input({
        delta: delta({
          removed_orgs: ['org_bravo_my'],
          removed_teams: [{ team_uid: 'uid-b-comms', team_name: 'Communications — BRAVO' }],
          removed_pressure: ['org_pressure_only_sg'],
          vacated_countries: ['Malaysia'],
        }),
        edited: snapshot(
          [
            snapshotOrg({
              org_uid: 'uid-a',
              org_key: 'primary',
              display_name: 'Acme',
              short_name: 'ACME',
              country: 'Singapore',
              is_primary: true,
            }),
          ],
          {
            pressure_organisations: [
              {
                org_uid: 'uid-press',
                org_key: 'org_pressure_press_sg',
                display_name: 'Press',
                country: 'Singapore',
                targets_org_keys: ['org_bravo_my'],
              },
            ],
          },
        ),
        teams: [
          team({ id: 'a', team_uid: 'uid-a-comms', team_name: 'Legal', org_key: 'primary' }),
          team({
            id: 'b',
            team_uid: 'uid-b-comms',
            team_name: 'Communications — BRAVO',
            org_key: 'org_bravo_my',
          }),
        ],
        injects: [
          inject({
            id: 'inj-b',
            inject_key: 'bravo_mail',
            delivery_config: { org_key: 'org_bravo_my' },
          }),
          inject({
            id: 'inj-pressure',
            inject_key: 'pressure_mail',
            delivery_config: {
              org_key: 'org_pressure_only_sg',
              gen: { layer: 'pressure:org_pressure_only_sg', edit: 0, hash: 'abc' },
            },
          }),
        ],
        sessions: [
          emptySession({
            session_id: 'sess-scheduled',
            page_controllers: [{ org_key: 'org_bravo_my', user_id: 'page-user' }],
            org_pages: [{ org_key: 'org_bravo_my' }],
          }),
        ],
        initial_state: {
          country: 'Singapore',
          org_name: 'Acme',
          orgs: [
            acme(),
            bravo(),
            {
              org_uid: 'uid-press',
              org_key: 'org_pressure_press_sg',
              display_name: 'Press',
              side: 'pressure',
              country: 'Singapore',
              targets_org_keys: ['org_bravo_my'],
            },
            {
              org_uid: 'uid-only',
              org_key: 'org_pressure_only_sg',
              display_name: 'Only',
              side: 'pressure',
              country: 'Singapore',
              spokesperson_stakeholder_id: 'stk_spoke',
            },
          ],
          org_page: {
            orgs: [
              { org_uid: 'uid-a', org_key: 'primary', display_name: 'Acme', role: 'protagonist' },
              {
                org_uid: 'uid-b',
                org_key: 'org_bravo_my',
                display_name: 'Bravo',
                logo_url: 'logo-bravo',
                role: 'protagonist',
              },
              {
                org_uid: 'uid-only',
                org_key: 'org_pressure_only_sg',
                display_name: 'Only',
                role: 'pressure',
              },
            ],
          },
          stakeholders: [
            {
              id: 'stk_gone',
              name: 'Gone',
              owning_team: 'Communications — BRAVO',
              org_key: 'org_bravo_my',
            },
            { id: 'stk_kept', name: 'Kept', owning_team: 'Legal', org_key: 'org_bravo_my' },
            {
              id: 'stk_spoke',
              name: 'Spoke',
              owning_team: 'Only',
              org_key: 'org_pressure_only_sg',
            },
          ],
          countries: [
            { name: 'Singapore', code: 'SG' },
            { name: 'Malaysia', code: 'MY' },
          ],
          personas: [{ id: 'persona-my', country: 'Malaysia', backstory: 'Reporter' }],
        },
      }),
    );

    const orgs = replaced(plan, '/orgs') as OrgRow[];
    assert.equal(
      orgs.some((org) => org.org_key === 'org_bravo_my'),
      false,
    );
    assert.equal(
      orgs.some((org) => org.org_key === 'org_pressure_only_sg'),
      false,
    );
    assert.ok(orgs.some((org) => org.org_key === 'primary'));
    const movedOrg = plan.initial_state.move_to_retired.find(
      (row) => row.bucket === 'orgs' && row.key === 'org_bravo_my',
    );
    const movedPage = plan.initial_state.move_to_retired.find(
      (row) => row.bucket === 'org_page_orgs' && row.key === 'org_bravo_my',
    );
    assert.equal((movedPage?.value as OrgRow).logo_url, 'logo-bravo');
    assert.ok(movedOrg);
    const movedStakeholders = plan.initial_state.move_to_retired.filter(
      (row) => row.bucket === 'stakeholders',
    );
    assert.ok(movedStakeholders.some((row) => row.key === 'stk_gone'));
    assert.ok(movedStakeholders.some((row) => row.key === 'stk_spoke'));
    assert.equal(
      movedStakeholders.some((row) => row.key === 'stk_kept'),
      false,
    );
    assert.ok(
      plan.orphans.some((row) => row.kind === 'stakeholder' && row.stakeholder_id === 'stk_kept'),
    );

    assert.equal(plan.injects.retire.find((row) => row.inject_id === 'inj-b')?.reason, 'org_key');
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-b')?.org_key,
      'org_bravo_my',
    );
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-pressure')?.reason,
      'pressure_layer',
    );
    assert.ok(
      plan.orphans.some(
        (row) => row.kind === 'pressure_targets' && row.org_key === 'org_pressure_press_sg',
      ),
    );

    const countries = replaced(plan, '/countries') as Array<{ name: string }>;
    assert.deepEqual(
      countries.map((row) => row.name),
      ['Singapore'],
    );
    assert.ok(
      plan.initial_state.move_to_retired.some(
        (row) => row.bucket === 'countries' && row.key === 'Malaysia',
      ),
    );
    const personas = replaced(plan, '/personas') as Array<{ country?: string; backstory: string }>;
    assert.equal(personas[0].country, undefined);
    assert.match(personas[0].backstory, /Based in Malaysia/);
    assert.deepEqual(plan.vacated_countries, ['Malaysia']);

    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.deepEqual(session.remove_org_keys, ['org_bravo_my']);
    assert.equal(session.reseed_org_pages, true);
    assert.equal(session.delete_sim_org_pages, true);
  });

  test('removing a rival from the middle leaves the other rivals untouched', () => {
    const north = {
      org_uid: 'uid-n',
      org_key: 'org_antagonist_north_1',
      name: 'North',
      country: 'Singapore',
      role: 'antagonist',
      logo_url: 'logo-north',
    };
    const mid = {
      org_uid: 'uid-m',
      org_key: 'org_antagonist_mid_2',
      name: 'Mid',
      country: 'Singapore',
      role: 'antagonist',
      logo_url: 'logo-mid',
    };
    const south = {
      org_uid: 'uid-s',
      org_key: 'org_antagonist_south_3',
      name: 'South',
      country: 'Singapore',
      role: 'antagonist',
      logo_url: 'logo-south',
    };
    const registry = [north, mid, south].map((org) => ({
      org_uid: org.org_uid,
      org_key: org.org_key,
      display_name: org.name,
      country: org.country,
      side: 'antagonist',
      kind: 'company',
    }));
    const pages = [north, mid, south].map((org) => ({ ...org }));
    const plan = planRemap(
      input({
        delta: delta({ removed_rivals: ['org_antagonist_mid_2'] }),
        edited: snapshot(
          [
            snapshotOrg({
              org_uid: 'uid-a',
              org_key: 'primary',
              display_name: 'Acme',
              is_primary: true,
            }),
          ],
          {
            competitors: [
              {
                org_uid: 'uid-n',
                org_key: 'org_antagonist_north_1',
                name: 'North',
                country: 'Singapore',
                auto_generated: false,
              },
              {
                org_uid: 'uid-s',
                org_key: 'org_antagonist_south_3',
                name: 'South',
                country: 'Singapore',
                auto_generated: false,
              },
            ],
          },
        ),
        initial_state: {
          orgs: registry,
          org_page: { orgs: pages },
        },
      }),
    );
    const page = replaced(plan, '/org_page') as { orgs: typeof pages };
    assert.deepEqual(page.orgs, [pages[0], pages[2]]);
    assert.deepEqual(
      (replaced(plan, '/orgs') as Array<{ org_key: string }>).map((org) => org.org_key),
      ['org_antagonist_north_1', 'org_antagonist_south_3'],
    );
    assert.equal(
      (
        plan.initial_state.move_to_retired.find((row) => row.bucket === 'org_page_orgs')?.value as {
          logo_url: string;
        }
      ).logo_url,
      'logo-mid',
    );
  });

  test('a text-only rename of a hand-edited inject warns and does not rewrite it', () => {
    const plan = planRemap(
      input({
        delta: delta({ renamed_teams: [{ team_uid: 'uid-legal', from: 'Legal', to: 'Counsel' }] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            is_primary: true,
            teams: [snapshotTeam({ team_uid: 'uid-legal', team_name: 'Counsel' })],
          }),
        ]),
        teams: [team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' })],
        injects: [
          inject({
            id: 'inj-hand',
            inject_key: 'hand_note',
            generation_source: 'trainer',
            title: 'Note',
            content: 'Tell Legal today',
            target_teams: ['Communications'],
            delivery_config: { org_key: 'primary' },
          }),
        ],
      }),
    );
    assert.equal(plan.injects.rewrite_in_place.length, 0);
    assert.equal(plan.injects.cow.length, 0);
    assert.equal(plan.warnings.length, 1);
    assert.equal(plan.warnings[0].code, 'hand_edit_team_mention');
    assert.equal(plan.warnings[0].inject_id, 'inj-hand');
    assert.equal(plan.applicable, true);
  });

  test('a plan with unresolved orphans is not applicable', () => {
    const removed = planRemap(removalWorld());
    assert.equal(removed.applicable, false);
    assert.ok(removed.orphans.length > 0);
    const renamed = planRemap(renameWorld());
    assert.equal(renamed.applicable, true);
    assert.equal(renamed.orphans.length, 0);
  });

  test('planning twice from the same state returns the same plan', () => {
    const source = swapInput();
    const before = canonicalJson(source);
    const first = planRemap(source);
    const second = planRemap(source);
    assert.equal(canonicalJson(source), before);
    assert.deepEqual(first, second);
    assert.equal(canonicalJson(first), canonicalJson(second));
  });

  test('a primary swap re-keys both organisations in one pass', () => {
    const fresh = freshPrimaryKey();
    const plan = planRemap(swapInput());
    assert.equal(plan.primary_swap?.old_primary_new_key, fresh);
    assert.equal(plan.primary_swap?.new_primary_previous_key, 'org_bravo_my');
    assert.deepEqual(plan.primary_swap?.map, { org_bravo_my: 'primary', primary: fresh });
    assert.equal(plan.primary_swap?.story.severity, 'story');
    assert.match(
      plan.primary_swap?.story.premise ?? '',
      /Bravo is now the organisation at the centre of the crisis/,
    );
    assert.equal(
      history().some((row) => (row as { org_key: string }).org_key === fresh),
      false,
    );

    const orgs = replaced(plan, '/orgs') as OrgRow[];
    const keys = orgs.map((org) => org.org_key);
    assert.equal(new Set(keys).size, keys.length, 'no two organisations share a key');
    assert.equal(orgs.find((org) => org.org_uid === 'uid-b')?.org_key, 'primary');
    assert.equal(orgs.find((org) => org.org_uid === 'uid-b')?.is_primary, true);
    assert.equal(orgs.find((org) => org.org_uid === 'uid-a')?.org_key, fresh);
    assert.equal(orgs.find((org) => org.org_uid === 'uid-a')?.is_primary, false);
    assert.equal(orgs.find((org) => org.org_uid === 'uid-c')?.org_key, 'org_charlie_sg');
    assert.equal(
      orgs.find((org) => org.org_uid === 'uid-a')?.sites?.[0].site_key,
      'acme_singapore',
    );
    assert.equal(
      orgs.find((org) => org.org_uid === 'uid-b')?.sites?.[0].site_key,
      'hq_kualalumpur',
    );
    assert.equal(
      orgs.find((org) => org.org_uid === 'uid-c')?.sites?.[0].site_key,
      'chas_singapore',
    );
    assert.deepEqual(
      orgs.find((org) => org.org_key === 'org_pressure_union_sg')?.targets_org_keys,
      [fresh, 'org_charlie_sg'],
    );

    const pages = (replaced(plan, '/org_page') as { orgs: OrgRow[] }).orgs;
    const acmePage = pages.find((org) => org.org_uid === 'uid-a');
    const bravoPage = pages.find((org) => org.org_uid === 'uid-b');
    assert.equal(acmePage?.org_key, fresh);
    assert.equal(acmePage?.logo_url, 'logo-acme');
    assert.equal(acmePage?.is_primary, false);
    assert.equal(bravoPage?.org_key, 'primary');
    assert.equal(bravoPage?.logo_url, 'logo-bravo');
    assert.equal(bravoPage?.is_primary, true);
    assert.deepEqual(pages.find((org) => org.org_uid === 'uid-union')?.posture?.targets_org_keys, [
      fresh,
      'org_charlie_sg',
    ]);

    assert.equal(replaced(plan, '/country'), 'Malaysia');
    assert.equal(replaced(plan, '/org_name'), 'Bravo');
    const context = replaced(plan, '/decision_context') as { note: { org_key: string } };
    assert.equal(context.note.org_key, fresh);
    assert.equal(
      (replaced(plan, '/sop_steps') as Array<{ org_key: string }>)[0].org_key,
      'primary',
    );

    const rows = replaced(plan, '/org_key_history') as Array<{
      org_uid: string;
      org_key: string;
      from_edit: string | null;
      until_edit: string | null;
    }>;
    assert.ok(
      rows.some(
        (row) =>
          row.org_uid === 'uid-a' && row.org_key === 'primary' && row.until_edit === EDIT_TOKEN,
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row.org_uid === 'uid-b' &&
          row.org_key === 'org_bravo_my' &&
          row.until_edit === EDIT_TOKEN,
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row.org_uid === 'uid-a' &&
          row.org_key === fresh &&
          row.from_edit === EDIT_TOKEN &&
          row.until_edit == null,
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row.org_uid === 'uid-b' &&
          row.org_key === 'primary' &&
          row.from_edit === EDIT_TOKEN &&
          row.until_edit == null,
      ),
    );
    assert.ok(
      rows.some(
        (row) =>
          row.org_uid === 'uid-c' && row.org_key === 'org_charlie_sg' && row.until_edit == null,
      ),
    );

    const acmeTeam = plan.teams.successors.find((row) => row.team_uid === 'uid-a-comms');
    const bravoTeam = plan.teams.successors.find((row) => row.team_uid === 'uid-b-comms');
    assert.equal(acmeTeam?.org_key, fresh);
    assert.equal(acmeTeam?.team_uid, 'uid-a-comms');
    assert.equal((acmeTeam?.charter as { org_key: string }).org_key, fresh);
    assert.equal(bravoTeam?.org_key, 'primary');
    assert.equal(
      plan.teams.successors.some((row) => row.team_uid === 'uid-c-comms'),
      false,
    );

    const acmeInject = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-a');
    const bravoInject = plan.injects.cow.find((row) => row.source_id === 'inj-b');
    assert.equal((acmeInject?.changes.delivery_config as { org_key: string }).org_key, fresh);
    assert.equal(bravoInject?.inject_key, 'bravo_note');
    assert.equal((bravoInject?.changes.delivery_config as { org_key: string }).org_key, 'primary');
    const hand = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-hand');
    assert.equal(hand?.changes.content, undefined);
    assert.equal(hand?.changes.title, undefined);
    assert.ok(
      plan.warnings.some(
        (row) => row.code === 'hand_edit_names_former_primary' && row.inject_id === 'inj-hand',
      ),
    );
    assert.equal(plan.applicable, true);
  });

  test('null stakeholder keys stay shared in multi-org and follow the old primary when it was the only one', () => {
    const source = swapInput();
    source.teams = [
      team({
        id: 'a-null',
        team_uid: 'uid-a-null',
        team_name: 'Legal',
        org_key: null,
        charter: { org_key: null, mission: 'Counsel' },
      }),
      ...source.teams.filter((row) => row.team_uid !== 'uid-a-comms'),
    ];
    const plan = planRemap(source);
    const fresh = plan.primary_swap?.old_primary_new_key;
    assert.equal(
      plan.teams.successors.find((row) => row.team_uid === 'uid-a-null')?.org_key,
      fresh,
    );
    assert.equal(
      (
        plan.teams.successors.find((row) => row.team_uid === 'uid-a-null')?.charter as {
          org_key: string;
        }
      ).org_key,
      fresh,
    );
    const stakeholders = replaced(plan, '/stakeholders') as Array<{
      id: string;
      org_key: string | null;
    }>;
    assert.equal(stakeholders.find((row) => row.id === 'stk_null')?.org_key, null);
    assert.equal(stakeholders.find((row) => row.id === 'stk_b')?.org_key, 'primary');

    const single = planRemap(
      input({
        delta: delta({
          primary_swap: { from_org_uid: 'uid-a', to_org_uid: 'uid-d', to_is_new: true },
        }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            country: 'Singapore',
            is_primary: false,
            teams: [snapshotTeam({ team_uid: 'uid-a', team_name: 'Legal' })],
          }),
          snapshotOrg({
            org_uid: 'uid-d',
            org_key: 'org_delta_id',
            display_name: 'Delta',
            short_name: 'DELTA',
            country: 'Indonesia',
            is_primary: true,
            teams: [snapshotTeam({ team_uid: 'uid-d', team_name: 'Communications' })],
          }),
        ]),
        initial_state: {
          orgs: [acme()],
          stakeholders: [{ id: 'stk_only', name: 'Pat', owning_team: 'Legal', org_key: null }],
          org_key_history: [
            { org_uid: 'uid-a', org_key: 'primary', from_edit: null, until_edit: null },
          ],
        },
        teams: [team({ id: 'a', team_uid: 'uid-a', team_name: 'Legal', org_key: null })],
      }),
    );
    const only = (
      replaced(single, '/stakeholders') as Array<{ id: string; org_key: string | null }>
    ).find((row) => row.id === 'stk_only');
    assert.equal(only?.org_key, single.primary_swap?.old_primary_new_key);
    assert.notEqual(only?.org_key, null);
    assert.notEqual(only?.org_key, 'primary');
  });

  test('a swap remaps scheduled page controllers and re-seeds pages', () => {
    const source = swapInput();
    source.sessions = [
      emptySession({
        session_id: 'sess-scheduled',
        page_controllers: [
          { org_key: 'primary', user_id: 'page-user-o' },
          { org_key: 'org_bravo_my', user_id: 'page-user-p' },
        ],
        org_pages: [
          { org_key: 'primary' },
          { org_key: 'org_bravo_my' },
          { org_key: 'org_charlie_sg' },
        ],
      }),
      emptySession({
        session_id: 'sess-completed-11',
        status: 'completed',
        start_time: '2026-02-02T00:00:00.000Z',
        page_controllers: [{ org_key: 'primary', user_id: 'completed-page-user' }],
        org_pages: [{ org_key: 'primary' }],
        teams: [{ user_id: 'completed-page-user', team_name: 'Communications' }],
      }),
    ];
    const plan = planRemap(source);
    const fresh = plan.primary_swap?.old_primary_new_key;
    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.deepEqual(session.remap_page_controllers, [
      { from: 'primary', to: fresh, user_id: 'page-user-o' },
      { from: 'org_bravo_my', to: 'primary', user_id: 'page-user-p' },
    ]);
    assert.equal(session.reseed_org_pages, true);
    assert.equal(session.delete_sim_org_pages, true);
    assert.equal(JSON.stringify(plan).includes('sess-completed-11'), false);
    assert.equal(JSON.stringify(plan).includes('completed-page-user'), false);
  });

  test('swap then remove the old primary acts on the old primary new key', () => {
    const source = swapInput();
    source.delta = delta({
      primary_swap: { from_org_uid: 'uid-a', to_org_uid: 'uid-b', to_is_new: false },
      removed_orgs: ['primary'],
      removed_teams: [{ team_uid: 'uid-a-comms', team_name: 'Communications' }],
    });
    source.edited = snapshot(
      swapEdited('uid-b').filter((org) => org.org_uid !== 'uid-a'),
      {
        pressure_organisations: [
          {
            org_uid: 'uid-union',
            org_key: 'org_pressure_union_sg',
            display_name: 'Union',
            country: 'Singapore',
            targets_org_keys: ['primary', 'org_charlie_sg'],
          },
        ],
      },
    );
    const plan = planRemap(source);
    const fresh = plan.primary_swap?.old_primary_new_key ?? '';
    assert.ok(plan.phases.indexOf('swap') < plan.phases.indexOf('remove'));
    assert.equal(plan.injects.retire.find((row) => row.inject_id === 'inj-a')?.org_key, fresh);
    assert.equal(
      plan.injects.retire.some((row) => row.inject_id === 'inj-b'),
      false,
    );
    assert.equal(
      (
        plan.injects.cow.find((row) => row.source_id === 'inj-b')?.changes.delivery_config as {
          org_key: string;
        }
      ).org_key,
      'primary',
    );
    const orgs = replaced(plan, '/orgs') as OrgRow[];
    assert.equal(
      orgs.some((org) => org.org_uid === 'uid-a'),
      false,
    );
    assert.equal(orgs.find((org) => org.org_uid === 'uid-b')?.org_key, 'primary');
    const retired = plan.initial_state.move_to_retired.find(
      (row) => row.bucket === 'orgs' && (row.value as OrgRow).org_uid === 'uid-a',
    );
    assert.equal((retired?.value as OrgRow).org_key, fresh);
    assert.notEqual(fresh, 'primary');
    assert.equal(
      plan.teams.retire.some((row) => row.team_uid === 'uid-a-comms' && row.org_key === fresh),
      true,
    );
    assert.equal(
      plan.teams.successors.some(
        (row) => row.team_uid === 'uid-b-comms' && row.org_key === 'primary',
      ),
      true,
    );
  });

  test('a swap to a newly added organisation creates it as primary', () => {
    const source = swapInput();
    const created = snapshotOrg({
      org_uid: 'uid-d',
      org_key: 'org_delta_id',
      display_name: 'Delta',
      short_name: 'DELTA',
      country: 'Indonesia',
      is_primary: true,
      teams: [snapshotTeam({ team_uid: 'uid-d-comms', team_name: 'Communications' })],
    });
    source.delta = delta({
      primary_swap: { from_org_uid: 'uid-a', to_org_uid: 'uid-d', to_is_new: true },
      added_orgs: ['org_delta_id'],
    });
    source.edited = snapshot([...swapEdited('uid-d'), created]);
    const plan = planRemap(source);
    const orgs = replaced(plan, '/orgs') as OrgRow[];
    const deltaOrg = orgs.find((org) => org.org_uid === 'uid-d');
    assert.equal(deltaOrg?.org_key, 'primary');
    assert.equal(deltaOrg?.is_primary, true);
    assert.equal(deltaOrg?.display_name, 'Delta');
    assert.equal(orgs.find((org) => org.org_uid === 'uid-a')?.org_key === 'primary', false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(plan.primary_swap?.map ?? {}, 'org_delta_id'),
      false,
    );
    assert.equal(plan.primary_swap?.new_primary_previous_key, null);
    assert.equal(
      plan.teams.successors.some((row) => row.org_key === 'org_delta_id'),
      false,
    );
    assert.equal(replaced(plan, '/country'), 'Indonesia');
    assert.equal(replaced(plan, '/org_name'), 'Delta');
    assert.ok(plan.phases.includes('add'));
    const rows = replaced(plan, '/org_key_history') as Array<{
      org_uid: string;
      org_key: string;
      until_edit: string | null;
    }>;
    assert.ok(
      rows.some(
        (row) => row.org_uid === 'uid-d' && row.org_key === 'primary' && row.until_edit == null,
      ),
    );
  });

  test('a pressure group that exists only on the page is an orphan when every target is removed', () => {
    const plan = planRemap(
      input({
        delta: delta({ removed_orgs: ['org_bravo_my'] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
          }),
        ]),
        initial_state: {
          orgs: [acme()],
          org_page: {
            orgs: [
              {
                org_key: 'org_pressure_page_sg',
                display_name: 'Page Press',
                role: 'pressure',
                targets_org_keys: ['org_bravo_my'],
              },
            ],
          },
        },
      }),
    );
    assert.ok(
      plan.orphans.some(
        (row) => row.kind === 'pressure_targets' && row.org_key === 'org_pressure_page_sg',
      ),
    );
  });

  test('a resolution for every orphan kind is applied and the plan becomes applicable', () => {
    const source = removalWorld();
    const state = source.initial_state as Record<string, unknown>;
    state.org_page = {
      orgs: [
        {
          org_key: 'org_pressure_page_sg',
          display_name: 'Page Press',
          role: 'pressure',
          targets_org_keys: ['org_gone'],
        },
      ],
    };
    source.delta = delta({ ...source.delta, removed_orgs: ['org_gone'] });
    const open = planRemap(source);
    const kinds = new Set(open.orphans.map((row) => row.kind));
    for (const kind of [
      'player_role',
      'condition',
      'stakeholder',
      'pressure_targets',
      'chain_target',
      'mood_consequence',
      'team_dependency',
    ]) {
      assert.ok(kinds.has(kind as 'player_role'), kind);
    }
    const resolutions: Record<string, OrphanResolution> = {};
    for (const orphan of open.orphans) {
      if (orphan.kind === 'player_role')
        resolutions[orphan.id] = { choice: 'reassign', team_name: 'Communications' };
      else if (orphan.kind === 'condition' && orphan.condition_key?.includes('|team=')) {
        resolutions[orphan.id] = { choice: 'retarget', team_name: 'Communications' };
      } else if (orphan.kind === 'condition') resolutions[orphan.id] = { choice: 'keep' };
      else if (orphan.kind === 'stakeholder')
        resolutions[orphan.id] = { choice: 'reassign', team_name: 'Communications' };
      else if (orphan.kind === 'pressure_targets')
        resolutions[orphan.id] = { choice: 'retarget', org_keys: ['primary'] };
      else if (orphan.kind === 'chain_target' && orphan.target_key) {
        resolutions[orphan.id] = { choice: 'retarget', inject_key: 'mixed_mail' };
      } else if (orphan.kind === 'chain_target')
        resolutions[orphan.id] = { choice: 'retarget', team_name: 'Communications' };
      else if (orphan.kind === 'mood_consequence') resolutions[orphan.id] = { choice: 'clear' };
      else if (orphan.kind === 'team_dependency' && orphan.condition_key)
        resolutions[orphan.id] = { choice: 'clear' };
      else if (orphan.kind === 'team_dependency' && !orphan.target_key)
        resolutions[orphan.id] = { choice: 'remove' };
      else if (orphan.kind === 'team_dependency') resolutions[orphan.id] = { choice: 'clear' };
    }
    const plan = planRemap({ ...source, resolutions });
    assert.equal(plan.orphans.length, 0);
    assert.equal(plan.applicable, true);
    const roles = replaced(plan, '/player_roles') as Array<{ role_id: string; team_name: string }>;
    assert.equal(roles.find((row) => row.role_id === 'cs_head')?.team_name, 'Communications');
    const session = plan.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.ok(session);
    assert.equal(session.retire_roles.includes('cs_head'), false);
    assert.deepEqual(session.reassign_roles, [{ role_id: 'cs_head', team_name: 'Communications' }]);
    const mixed = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-mixed');
    assert.ok(mixed);
    assert.deepEqual(mixed.changes.conditions_to_appear, {
      all: ['inject_fired:only_legal', 'responded:mixed_mail|team=communications'],
    });
    const stakeholders = replaced(plan, '/stakeholders') as Array<{
      id: string;
      owning_team: string;
    }>;
    assert.equal(stakeholders.find((row) => row.id === 'stk_ada')?.owning_team, 'Communications');
    const page = replaced(plan, '/org_page') as {
      orgs: Array<{ org_key: string; targets_org_keys?: string[] }>;
    };
    assert.deepEqual(
      page.orgs.find((row) => row.org_key === 'org_pressure_page_sg')?.targets_org_keys,
      ['primary'],
    );
    const config = mixed.changes.delivery_config as {
      escalation: {
        on_exhausted?: { publish_inject_key?: string };
        steps: Array<{ target_team?: string }>;
      };
      mood_ladder: { rungs: Array<{ consequences: unknown[] }> };
    };
    assert.equal(config.escalation.on_exhausted?.publish_inject_key, 'mixed_mail');
    assert.equal(config.escalation.steps[0].target_team, 'Communications');
    assert.deepEqual(config.mood_ladder.rungs[0].consequences, []);
    const dependencies = replaced(plan, '/team_dependencies') as { edges: unknown[] };
    assert.deepEqual(dependencies.edges, []);
  });

  test('a rename refreshes dependency names and leaves keys byte-identical', () => {
    const source = renameWorld();
    const state = structuredClone(source.initial_state) as {
      team_dependencies: { edges: Array<Record<string, unknown>> };
    };
    const edge = state.team_dependencies.edges[0];
    if (!edge) throw new Error('missing edge');
    edge.broken_when = { all: ['unresponded:briefing_mail:10|team=@upstream'] };
    edge.met_when = { all: ['reply_failed:briefing_mail|team=@downstream'] };
    const plan = planRemap({
      ...source,
      initial_state: state,
      injects: [
        inject({
          id: 'inj-live',
          inject_key: 'briefing_mail',
          has_history: false,
          title: 'Ask Legal now',
          content: 'The Legal team acts. Legally fine.',
          target_teams: ['Legal', 'Communications'],
          conditions_to_appear: {
            all: [
              'responded:briefing_mail|team=legal',
              'unresponded:briefing_mail:10|team=@upstream',
            ],
          },
          delivery_config: {
            org_key: 'primary',
            stakeholder_team: 'Legal',
            parent_target_teams: ['Legal'],
          },
        }),
        ...source.injects.slice(1),
      ],
    });
    const dependencies = replaced(plan, '/team_dependencies') as {
      edges: Array<{
        id: string;
        upstream: { team_uid: string; team_name: string };
        broken_when: { all: string[] };
        met_when: { all: string[] };
      }>;
    };
    const next = dependencies.edges[0];
    assert.ok(next);
    assert.equal(next.id, 'dep_brief');
    assert.equal(next.upstream.team_uid, 'uid-legal');
    assert.equal(next.upstream.team_name, 'Counsel');
    assert.deepEqual(next.broken_when.all, ['unresponded:briefing_mail:10|team=@upstream']);
    assert.deepEqual(next.met_when.all, ['reply_failed:briefing_mail|team=@downstream']);
    const live = plan.injects.rewrite_in_place.find((row) => row.inject_id === 'inj-live');
    assert.deepEqual(live?.changes.conditions_to_appear, {
      all: ['responded:briefing_mail|team=counsel', 'unresponded:briefing_mail:10|team=@upstream'],
    });
  });

  test('removing an upstream team is an orphan that can be retired or reassigned', () => {
    const base = removalWorld();
    const source = {
      ...base,
      injects: [
        ...base.injects,
        inject({
          id: 'inj-dep',
          inject_key: 'editor_consequence',
          target_teams: ['Communications'],
          delivery_config: {
            cause: { kind: 'dependency', dep_id: 'dep_brief' },
            gen: { layer: 'team:uid-comms', edit: 0, hash: 'abc' },
          },
        }),
      ],
    };
    const open = planRemap(source);
    const orphan = open.orphans.find(
      (row) =>
        row.kind === 'team_dependency' &&
        row.dependency_id === 'dep_brief' &&
        !row.target_key &&
        !row.condition_key,
    );
    assert.ok(orphan);
    assert.deepEqual(orphan.choices, ['remove', 'reassign']);
    assert.ok(
      open.orphans.some((row) => row.condition_key === 'team_silent:10|team=legal'),
      'an explicit slug of a removed team is an orphan',
    );
    assert.equal(
      open.injects.retire.some((row) => row.inject_id === 'inj-dep'),
      false,
    );

    const retired = planRemap({
      ...source,
      resolutions: Object.fromEntries(open.orphans.map((row) => [row.id, resolutionFor(row)])),
    });
    assert.equal(retired.applicable, true);
    const gone = replaced(retired, '/team_dependencies') as { edges: unknown[] };
    assert.deepEqual(gone.edges, []);
    assert.equal(
      retired.injects.retire.some(
        (row) => row.inject_id === 'inj-dep' && row.reason === 'dependent',
      ),
      true,
    );

    const refused = planRemap({
      ...reassignWorld(),
      resolutions: { 'dependency:dep_brief': { choice: 'reassign', team_name: 'Communications' } },
    });
    assert.equal(
      refused.orphans.some((row) => row.id === 'dependency:dep_brief'),
      true,
      'reassigning upstream onto its own downstream stays unresolved',
    );
    const reassigned = planRemap({
      ...reassignWorld(),
      resolutions: { 'dependency:dep_brief': { choice: 'reassign', team_name: 'Operations' } },
    });
    assert.equal(
      reassigned.orphans.some((row) => row.id === 'dependency:dep_brief'),
      false,
    );
    const edges = replaced(reassigned, '/team_dependencies') as {
      edges: Array<{
        upstream: { team_uid: string; team_name: string };
        downstream: Array<{ team_name: string }>;
        broken_when: { all: string[] };
      }>;
    };
    assert.equal(edges.edges[0]?.upstream.team_uid, OPS);
    assert.equal(edges.edges[0]?.upstream.team_name, 'Operations');
    assert.deepEqual(
      edges.edges[0]?.downstream.map((team) => team.team_name),
      ['Communications'],
    );
    assert.deepEqual(edges.edges[0]?.broken_when.all, [
      'unresponded:legal_brief:10|team=@upstream',
    ]);
  });

  test('removing a downstream team drops it and retires only its consequence', () => {
    const plan = planRemap(
      input({
        delta: delta({ removed_teams: [{ team_uid: 'uid-cs', team_name: 'Customer Service' }] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-acme',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
            teams: [
              snapshotTeam({ team_uid: 'uid-legal', team_name: 'Legal' }),
              snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' }),
            ],
          }),
        ]),
        teams: [
          team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
          team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
          team({ id: 'team-cs', team_uid: 'uid-cs', team_name: 'Customer Service' }),
        ],
        injects: [
          inject({
            id: 'inj-cs',
            inject_key: 'cs_call',
            target_teams: ['Customer Service'],
            delivery_config: {
              gen: { layer: 'dependency:dep_legal_statement', edit: 0, hash: 'a' },
            },
          }),
          inject({
            id: 'inj-comms',
            inject_key: 'comms_chat',
            target_teams: ['Communications'],
            delivery_config: {
              gen: { layer: 'dependency:dep_legal_statement', edit: 0, hash: 'b' },
            },
          }),
          inject({
            id: 'inj-editor-cs',
            inject_key: 'editor_cs_call',
            target_teams: ['Customer Service'],
            delivery_config: {
              cause: { kind: 'dependency', dep_id: 'dep_legal_statement' },
              gen: { layer: 'team:uid-legal', edit: 0, hash: 'c' },
            },
          }),
        ],
        initial_state: {
          team_dependencies: {
            v: 1,
            edges: [
              {
                id: 'dep_legal_statement',
                upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
                downstream: [
                  { team_uid: 'uid-comms', team_name: 'Communications' },
                  { team_uid: 'uid-cs', team_name: 'Customer Service' },
                ],
                broken_when: { all: ['team_silent:12|team=@upstream'] },
                met_when: null,
                consequence_keys: ['cs_call', 'comms_chat', 'editor_cs_call'],
                due: { by_minute: 20 },
              },
            ],
          },
        },
      }),
    );
    assert.equal(plan.applicable, true);
    assert.equal(
      plan.orphans.some((row) => row.kind === 'team_dependency'),
      false,
    );
    const dependencies = replaced(plan, '/team_dependencies') as {
      edges: Array<{
        downstream: Array<{ team_name: string }>;
        consequence_keys: string[];
        broken_when: { all: string[] };
      }>;
    };
    assert.deepEqual(
      dependencies.edges[0]?.downstream.map((ref) => ref.team_name),
      ['Communications'],
    );
    assert.deepEqual(dependencies.edges[0]?.consequence_keys, ['comms_chat']);
    assert.deepEqual(dependencies.edges[0]?.broken_when.all, ['team_silent:12|team=@upstream']);
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-cs')?.reason,
      'dependent',
    );
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-editor-cs')?.reason,
      'dependent',
    );
    assert.equal(
      plan.orphans.some((row) => row.target_key === 'editor_cs_call'),
      false,
    );
    assert.equal(
      plan.injects.retire.some((row) => row.inject_id === 'inj-comms'),
      false,
    );
  });

  test('removing the last downstream retires the edge and its consequences', () => {
    const plan = planRemap(
      input({
        delta: delta({ removed_teams: [{ team_uid: 'uid-cs', team_name: 'Customer Service' }] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-acme',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
            teams: [snapshotTeam({ team_uid: 'uid-legal', team_name: 'Legal' })],
          }),
        ]),
        teams: [
          team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
          team({ id: 'team-cs', team_uid: 'uid-cs', team_name: 'Customer Service' }),
        ],
        injects: [
          inject({
            id: 'inj-cs',
            inject_key: 'cs_call',
            target_teams: ['Customer Service'],
            delivery_config: { gen: { layer: 'dependency:dep_only_cs', edit: 0, hash: 'a' } },
          }),
        ],
        initial_state: {
          team_dependencies: {
            v: 1,
            edges: [
              {
                id: 'dep_only_cs',
                upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
                downstream: [{ team_uid: 'uid-cs', team_name: 'Customer Service' }],
                broken_when: { all: ['team_silent:12|team=@upstream'] },
                met_when: null,
                consequence_keys: ['cs_call'],
                due: { by_minute: 12 },
              },
            ],
          },
        },
      }),
    );
    const dependencies = replaced(plan, '/team_dependencies') as { edges: unknown[] };
    assert.deepEqual(dependencies.edges, []);
    assert.equal(
      plan.injects.retire.find((row) => row.inject_id === 'inj-cs')?.reason,
      'dependent',
    );
    assert.equal(
      plan.orphans.some((row) => row.kind === 'team_dependency' && !row.target_key),
      false,
    );
    assert.equal(plan.applicable, true);
  });

  test('removing an organisation follows the same rules as removing its teams', () => {
    const plan = planRemap(
      input({
        delta: delta({ removed_orgs: ['org_logistics'] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-acme',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
            teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
          }),
        ]),
        teams: [
          team({
            id: 'team-log',
            team_uid: 'uid-log',
            team_name: 'Logistics',
            org_key: 'org_logistics',
          }),
          team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
        ],
        initial_state: {
          team_dependencies: {
            v: 1,
            edges: [
              {
                id: 'dep_logistics',
                upstream: { team_uid: 'uid-log', team_name: 'Logistics' },
                downstream: [{ team_uid: 'uid-comms', team_name: 'Communications' }],
                broken_when: { all: ['team_silent:10|team=@upstream'] },
                met_when: null,
                consequence_keys: [],
                due: { by_minute: 15 },
              },
            ],
          },
        },
      }),
    );
    const orphan = plan.orphans.find((row) => row.dependency_id === 'dep_logistics');
    assert.ok(orphan);
    assert.deepEqual(orphan.choices, ['remove', 'reassign']);
    assert.equal(plan.applicable, false);
  });

  test('removing an edge drops its scope orphan, and retarget needs an active team', () => {
    const source = input({
      delta: delta({ removed_teams: [{ team_uid: 'uid-legal', team_name: 'Legal' }] }),
      edited: snapshot([
        snapshotOrg({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          short_name: 'ACME',
          is_primary: true,
          teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
        }),
      ]),
      teams: [
        team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
        team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
      ],
      initial_state: {
        team_dependencies: {
          v: 1,
          edges: [
            {
              id: 'dep_brief',
              upstream: { team_uid: 'uid-legal', team_name: 'Legal' },
              downstream: [{ team_uid: 'uid-comms', team_name: 'Communications' }],
              broken_when: { all: ['responded:brief|team=legal'] },
              met_when: null,
              consequence_keys: [],
              due: { by_minute: 10 },
            },
          ],
        },
      },
    });
    const open = planRemap(source);
    const scope = open.orphans.find((row) => row.condition_key === 'responded:brief|team=legal');
    assert.ok(scope);
    const bogus = planRemap({
      ...source,
      resolutions: { [scope.id]: { choice: 'retarget', team_name: 'Nobody' } },
    });
    assert.ok(bogus.orphans.some((row) => row.id === scope.id));
    const removed = planRemap({
      ...source,
      resolutions: { 'dependency:dep_brief': { choice: 'remove' } },
    });
    assert.equal(
      removed.orphans.some((row) => row.condition_key),
      false,
    );
    assert.equal(removed.applicable, true);
    const dependencies = replaced(removed, '/team_dependencies') as { edges: unknown[] };
    assert.deepEqual(dependencies.edges, []);
  });

  test('a name-only dependency is stamped with team_uid on the first plan', () => {
    const plan = planRemap(
      input({
        delta: delta({}),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-acme',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
            teams: [
              snapshotTeam({ team_uid: 'uid-legal', team_name: 'Legal' }),
              snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' }),
            ],
          }),
        ]),
        teams: [
          team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
          team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
        ],
        initial_state: {
          team_dependencies: {
            v: 1,
            edges: [
              {
                id: 'dep_names',
                upstream: { team_name: 'Legal' },
                downstream: [{ team_name: 'Communications' }],
                broken_when: { all: ['team_silent:10|team=@upstream'] },
                met_when: null,
                consequence_keys: [],
                due: { by_minute: 10 },
              },
            ],
          },
        },
      }),
    );
    const dependencies = replaced(plan, '/team_dependencies') as {
      edges: Array<{
        upstream: { team_uid?: string; team_name: string };
        downstream: Array<{ team_uid?: string; team_name: string }>;
        broken_when: { all: string[] };
      }>;
    };
    assert.equal(dependencies.edges[0]?.upstream.team_uid, 'uid-legal');
    assert.equal(dependencies.edges[0]?.upstream.team_name, 'Legal');
    assert.equal(dependencies.edges[0]?.downstream[0]?.team_uid, 'uid-comms');
    assert.deepEqual(dependencies.edges[0]?.broken_when.all, ['team_silent:10|team=@upstream']);
    assert.equal(plan.applicable, true);
    assert.equal(plan.orphans.length, 0);
  });

  test('history lookup batches ids and pages past a row cap', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `id-${String(index).padStart(2, '0')}`);
    const publications = ids.flatMap((id) => Array.from({ length: 8 }, () => ({ inject_id: id })));
    const calls: Array<{ ids: readonly string[]; from: number; to: number }> = [];
    const found = await collectInjectsWithHistory(
      ids,
      async (table, batch, from, to) => {
        calls.push({ ids: batch, from, to });
        if (batch.length > 4) throw new Error('id batch exceeded the URL-sized limit');
        if (to - from + 1 > 10) throw new Error('page exceeded the row cap');
        const pool = table === 'inject_publications' ? publications : [];
        const matched = pool
          .filter((row) => batch.includes(row.inject_id))
          .sort((a, b) => a.inject_id.localeCompare(b.inject_id));
        return { data: matched.slice(from, to + 1), error: null };
      },
      { batchSize: 4, pageSize: 10 },
    );
    for (const id of ids) assert.equal(found.has(id), true, id);
    assert.ok(calls.every((call) => call.ids.length <= 4));
    assert.ok(calls.some((call) => call.from > 0));
  });

  test('missing lobby tables are recognised without a database', () => {
    assert.equal(isRemapTableMissing({ code: '42P01' }), true);
    assert.equal(isRemapTableMissing({ code: 'PGRST205' }), true);
    assert.equal(isRemapTableMissing({ code: '23505' }), false);
  });

  test('a scenario without a peace feed, and one whose feed the edit does not touch, plan the same', () => {
    const bare = planRemap(renameWorld());
    assert.equal(
      bare.initial_state.patch.some((item) => item.path === '/peace_period'),
      false,
    );
    const world = renameWorld();
    const state = world.initial_state as Record<string, unknown>;
    state.peace_period = {
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
    assert.deepEqual(planRemap(world), bare);
  });

  test('a primary swap rewrites peace page authors and keeps the other posts', () => {
    const persona = {
      ref: 'P3',
      author: { kind: 'persona', handle: '@sam' },
      platform: 'facebook',
      post_format: 'text',
      content: 'Saturday market.',
      media_description: '',
      offset_seconds: 60,
      comments: [{ author_handle: '@sam', content: 'See you there', offset_seconds: 70 }],
    };
    const plan = planRemap(
      input({
        delta: delta({
          primary_swap: { from_org_uid: 'uid-a', to_org_uid: 'uid-b', to_is_new: false },
        }),
        edited: snapshot(swapEdited('uid-b').filter((org) => org.org_uid !== 'uid-c')),
        initial_state: {
          orgs: [acme(), bravo()],
          peace_period: {
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
                content: 'Acme breakfast.',
                media_description: '',
                offset_seconds: 20,
                comments: [],
              },
              {
                ref: 'P2',
                author: { kind: 'page', org_key: 'org_bravo_my', platform: 'facebook' },
                platform: 'facebook',
                post_format: 'text',
                content: 'Bravo hours.',
                media_description: '',
                offset_seconds: 40,
                comments: [],
              },
              persona,
            ],
          },
        },
      }),
    );
    const fresh = plan.primary_swap?.old_primary_new_key;
    const peace = replaced(plan, '/peace_period') as {
      leak_terms: string[];
      posts: Array<{ ref: string; content: string; author: { kind: string; org_key?: string; handle?: string } }>;
    };
    assert.equal(peace.posts[0]?.author.org_key, fresh);
    assert.equal(peace.posts[0]?.content, 'Acme breakfast.');
    assert.equal(peace.posts[1]?.author.org_key, 'primary');
    assert.equal(peace.posts[1]?.content, 'Bravo hours.');
    assert.deepEqual(peace.posts[2], persona);
    assert.deepEqual(peace.leak_terms, ['recall']);
  });

  test('removing an organisation drops its peace posts and keeps the rest', () => {
    const kept = {
      ref: 'P1',
      author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
      platform: 'facebook',
      post_format: 'text',
      content: 'Acme breakfast.',
      media_description: '',
      offset_seconds: 20,
      comments: [
        { author_handle: '@sam', content: 'Nice', offset_seconds: 30 },
        { author_handle: '@bravo', content: 'Our hours too', offset_seconds: 35 },
      ],
    };
    const persona = {
      ref: 'P3',
      author: { kind: 'persona', handle: '@sam' },
      platform: 'facebook',
      post_format: 'text',
      content: 'Saturday market.',
      media_description: '',
      offset_seconds: 60,
      comments: [],
    };
    const plan = planRemap(
      input({
        delta: delta({ removed_orgs: ['org_bravo_my'] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            is_primary: true,
          }),
        ]),
        initial_state: {
          orgs: [acme(), bravo({ facebook_handle: '@bravo' })],
          org_page: {
            orgs: [
              {
                org_uid: 'uid-b',
                org_key: 'org_bravo_my',
                side: 'protagonist',
                facebook: { page_handle: '@bravo', page_name: 'Bravo' },
              },
            ],
          },
          peace_period: {
            version: 1,
            seconds: 300,
            enabled: true,
            leak_terms: ['recall'],
            posts: [
              kept,
              {
                ref: 'P2',
                author: { kind: 'page', org_key: 'org_bravo_my', platform: 'x_twitter' },
                platform: 'x_twitter',
                post_format: 'text',
                content: 'Bravo hours.',
                media_description: '',
                offset_seconds: 40,
                comments: [],
              },
              persona,
            ],
          },
        },
      }),
    );
    const peace = replaced(plan, '/peace_period') as {
      posts: Array<{ ref: string; comments: Array<{ author_handle: string }> }>;
      leak_terms: string[];
    };
    assert.deepEqual(
      peace.posts.map((item) => item.ref),
      ['P1', 'P3'],
    );
    assert.deepEqual(
      peace.posts[0]?.comments.map((comment) => comment.author_handle),
      ['@sam'],
    );
    assert.equal(peace.posts[1], persona);
    assert.deepEqual(peace.leak_terms, ['recall']);
  });

  test('a renamed handle rewrites peace persona authors and comment authors', () => {
    const other = {
      ref: 'P2',
      author: { kind: 'persona', handle: '@other' },
      platform: 'facebook',
      post_format: 'text',
      content: 'Evening walk.',
      media_description: '',
      offset_seconds: 40,
      comments: [{ author_handle: '@other', content: 'Same', offset_seconds: 50 }],
    };
    const plan = planRemap(
      input({
        delta: delta({
          changed_text: [{ key: 'primary', field: 'facebook_handle' }],
        }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            is_primary: true,
            facebook_handle: '@sam_new',
          }),
        ]),
        initial_state: {
          orgs: [acme({ facebook_handle: '@sam_k' })],
          org_page: {
            orgs: [
              {
                org_uid: 'uid-a',
                org_key: 'primary',
                display_name: 'Acme',
                side: 'protagonist',
                facebook_handle: '@sam_k',
                facebook: { page_handle: '@sam_k', page_name: 'Acme' },
              },
            ],
          },
          personas: [{ id: 'p1', name: 'Sam', handle: '@sam_k' }],
          peace_period: {
            version: 1,
            seconds: 300,
            enabled: true,
            leak_terms: ['recall'],
            posts: [
              {
                ref: 'P1',
                author: { kind: 'persona', handle: '@sam_k' },
                platform: 'facebook',
                post_format: 'text',
                content: 'Saturday market.',
                media_description: '',
                offset_seconds: 20,
                comments: [{ author_handle: '@Sam_K', content: 'Saturday plans', offset_seconds: 30 }],
              },
              other,
              {
                ref: 'P3',
                author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
                platform: 'facebook',
                post_format: 'text',
                content: 'Acme breakfast.',
                media_description: '',
                offset_seconds: 60,
                comments: [],
              },
            ],
          },
        },
      }),
    );
    const peace = replaced(plan, '/peace_period') as {
      posts: Array<{
        ref: string;
        content: string;
        author: { kind: string; handle?: string; org_key?: string };
        comments: Array<{ author_handle: string }>;
      }>;
    };
    assert.equal(peace.posts[0]?.author.handle, '@sam_new');
    assert.equal(peace.posts[0]?.comments[0]?.author_handle, '@sam_new');
    assert.equal(peace.posts[0]?.content, 'Saturday market.');
    assert.deepEqual(peace.posts[1], other);
    assert.equal(peace.posts[2]?.author.org_key, 'primary');
    assert.equal(peace.posts[2]?.content, 'Acme breakfast.');
  });

  test('a rename retires the source team without a remove phase', () => {
    const plan = planRemap(renameWorld());
    assert.ok(plan.teams.retire.length > 0);
    assert.ok(plan.teams.retire.every((row) => row.reason !== 'removed'));
    assert.equal(plan.phases.includes('remove'), false);
    assert.ok(plan.phases.includes('rename'));
    const removed = planRemap(removalWorld());
    assert.ok(removed.teams.retire.some((row) => row.reason === 'removed'));
    assert.ok(removed.phases.includes('remove'));
  });

  test('retiring a dependent inject raises knock-on orphans and drops decisions on that inject', () => {
    const source = input({
      delta: delta({ removed_teams: [{ team_uid: 'uid-legal', team_name: 'Legal' }] }),
      edited: snapshot([
        snapshotOrg({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          short_name: 'ACME',
          is_primary: true,
          teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
        }),
      ]),
      teams: [
        team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
        team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
      ],
      injects: [
        inject({ id: 'inj-only', inject_key: 'only_legal', target_teams: ['Legal'] }),
        inject({
          id: 'inj-bridge',
          inject_key: 'bridge_mail',
          target_teams: ['Communications'],
          conditions_to_appear: ['inject_fired:only_legal'],
          delivery_config: {
            escalation: { on_exhausted: { publish_inject_key: 'only_legal' } },
            mood_ladder: {
              rungs: [
                { id: 'angry', consequences: [{ type: 'publish_inject', inject_key: 'only_legal' }] },
              ],
            },
          },
        }),
        inject({
          id: 'inj-watch',
          inject_key: 'watch_mail',
          target_teams: ['Communications'],
          conditions_to_appear: ['inject_fired:bridge_mail'],
          delivery_config: {
            escalation: { on_exhausted: { publish_inject_key: 'bridge_mail' } },
          },
        }),
      ],
    });
    const open = planRemap(source);
    const bridge = open.orphans.find(
      (row) => row.inject_id === 'inj-bridge' && row.kind === 'condition',
    );
    assert.ok(bridge);
    assert.ok(open.orphans.some((row) => row.id === 'chain:inj-bridge:only_legal'));
    assert.equal(
      open.orphans.some((row) => row.inject_id === 'inj-watch'),
      false,
    );
    const plan = planRemap({
      ...source,
      resolutions: {
        [bridge.id]: { choice: 'retire' },
        'chain:inj-bridge:only_legal': { choice: 'clear' },
      },
    });
    assert.ok(
      plan.injects.retire.some((row) => row.inject_id === 'inj-bridge' && row.reason === 'dependent'),
    );
    assert.equal(
      plan.orphans.some((row) => row.inject_id === 'inj-bridge'),
      false,
    );
    assert.ok(
      plan.orphans.some(
        (row) =>
          row.inject_id === 'inj-watch' &&
          row.kind === 'condition' &&
          row.target_key === 'bridge_mail',
      ),
    );
    assert.ok(
      plan.orphans.some(
        (row) =>
          row.inject_id === 'inj-watch' &&
          row.kind === 'chain_target' &&
          row.target_key === 'bridge_mail',
      ),
    );
    assert.equal(plan.applicable, false);
  });

  test('retargeting onto an inject this pass retires becomes a new orphan', () => {
    const source = input({
      delta: delta({ removed_teams: [{ team_uid: 'uid-legal', team_name: 'Legal' }] }),
      edited: snapshot([
        snapshotOrg({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          short_name: 'ACME',
          is_primary: true,
          teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
        }),
      ]),
      teams: [
        team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal' }),
        team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications' }),
      ],
      injects: [
        inject({ id: 'inj-only', inject_key: 'only_legal', target_teams: ['Legal'] }),
        inject({
          id: 'inj-bridge',
          inject_key: 'bridge_mail',
          target_teams: ['Communications'],
          conditions_to_appear: ['inject_fired:only_legal'],
        }),
        inject({
          id: 'inj-watch',
          inject_key: 'watch_mail',
          target_teams: ['Communications'],
          conditions_to_appear: ['inject_fired:only_legal'],
        }),
      ],
    });
    const open = planRemap(source);
    const bridge = open.orphans.find((row) => row.inject_id === 'inj-bridge');
    const watch = open.orphans.find((row) => row.inject_id === 'inj-watch');
    assert.ok(bridge && watch);
    const plan = planRemap({
      ...source,
      resolutions: {
        [bridge.id]: { choice: 'retarget', inject_key: 'watch_mail' },
        [watch.id]: { choice: 'retire' },
      },
    });
    assert.ok(plan.injects.retire.some((row) => row.inject_id === 'inj-watch' && row.reason === 'dependent'));
    assert.equal(plan.orphans.some((row) => row.inject_id === 'inj-watch'), false);
    const knock = plan.orphans.find((row) => row.inject_id === 'inj-bridge');
    assert.ok(knock);
    assert.equal(knock.target_key, 'watch_mail');
    assert.equal(knock.condition_key, 'inject_fired:watch_mail');
    assert.equal(plan.applicable, false);
  });

  test('a resolution aimed at an inactive team, inject key, or organisation stays unresolved', () => {
    const source = removalWorld();
    const state = source.initial_state as Record<string, unknown>;
    state.org_page = {
      orgs: [
        {
          org_key: 'org_pressure_page_sg',
          display_name: 'Page Press',
          role: 'pressure',
          targets_org_keys: ['org_gone'],
        },
      ],
    };
    source.delta = delta({ ...source.delta, removed_orgs: ['org_gone'] });
    const open = planRemap(source);
    const role = open.orphans.find((row) => row.kind === 'player_role');
    const condition = open.orphans.find((row) => row.kind === 'condition' && row.target_key);
    const pressure = open.orphans.find((row) => row.kind === 'pressure_targets');
    assert.ok(role && condition && pressure);

    const badTeam = planRemap({
      ...source,
      resolutions: { [role.id]: { choice: 'reassign', team_name: 'Ghost' } },
    });
    const roleOrphan = badTeam.orphans.find((row) => row.id === role.id);
    assert.match(roleOrphan?.unresolved_reason ?? '', /Ghost/);
    const session = badTeam.scheduled_sessions.find((row) => row.session_id === 'sess-scheduled');
    assert.equal(session?.reassign_roles.some((row) => row.role_id === 'cs_head') ?? false, false);

    const badKey = planRemap({
      ...source,
      resolutions: { [condition.id]: { choice: 'retarget', inject_key: 'not_generated_yet' } },
    });
    assert.match(
      badKey.orphans.find((row) => row.id === condition.id)?.unresolved_reason ?? '',
      /not_generated_yet/,
    );

    const retiredKey = planRemap({
      ...source,
      resolutions: { [condition.id]: { choice: 'retarget', inject_key: 'only_legal' } },
    });
    assert.match(
      retiredKey.orphans.find((row) => row.id === condition.id)?.unresolved_reason ?? '',
      /only_legal/,
    );

    const badOrg = planRemap({
      ...source,
      resolutions: { [pressure.id]: { choice: 'retarget', org_keys: ['org_gone', 'primary'] } },
    });
    assert.match(
      badOrg.orphans.find((row) => row.id === pressure.id)?.unresolved_reason ?? '',
      /org_gone/,
    );
    assert.equal(badOrg.applicable, false);
  });

  test('a registry row without an org key is kept and warned', () => {
    const plan = planRemap(
      input({
        delta: delta({ removed_orgs: ['org_bravo_my'] }),
        edited: snapshot([
          snapshotOrg({
            org_uid: 'uid-a',
            org_key: 'primary',
            display_name: 'Acme',
            short_name: 'ACME',
            is_primary: true,
          }),
        ]),
        initial_state: {
          orgs: [acme(), bravo(), { org_uid: 'uid-loose', display_name: 'Loose office' }],
        },
      }),
    );
    const warning = plan.warnings.find((row) => row.code === 'registry_missing_org_key');
    assert.ok(warning);
    assert.match(warning.message, /Loose office/);
    const orgs = replaced(plan, '/orgs') as Array<{ org_uid?: string; org_key?: string }>;
    const loose = orgs.find((org) => org.org_uid === 'uid-loose');
    assert.ok(loose);
    assert.equal(loose.org_key, undefined);
    assert.equal(
      orgs.some((org) => org.org_key === 'org_bravo_my'),
      false,
    );
    assert.ok(plan.initial_state.move_to_retired.some((row) => row.key === 'org_bravo_my'));
  });
});
