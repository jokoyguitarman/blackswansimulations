import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { rowsValidAt, orgsForSession } from '../../lib/templateRows.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { MultiOrgValidationError } from '../scenarioValidationService.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';
import type { PeaceFeed } from '../../../shared/peaceFeed.js';
import { computeDelta } from './setupDeltaCore.js';
import { planRemap, EDIT_TOKEN, type RemapPlannerInput } from './remapPlanner.js';
import type { TeamDependencyEdge } from '../../../shared/teamDependencies.js';
import {
  applySqlRecordColumns,
  mergeSetupEdit,
  orgPagesSeededBy,
  SetupMergeError,
  threeWayText,
  type ApplyBundle,
  type MergeInjectRow,
  type MergeObjective,
  type MergeTeamRow,
} from './setupMergeCore.js';
import {
  acmeSnapshot,
  applyInput,
  baseState,
  defaultTeams,
  emptyOutputs,
  emptyPlan,
  injectRow,
  orgPage,
  teamRow,
} from './fixtures/applyWorld.js';
import { emptySession, inject, input, snapshot, snapshotOrg, snapshotTeam, team } from './fixtures/remapFixtures.js';
import type { SetupSnapshot } from './setupSnapshotCore.js';

const EDIT = '11111111-1111-4111-8111-111111111111';

function bundleOf(partial: Parameters<typeof applyInput>[0] = {}): ApplyBundle {
  const spec = applyInput(partial);
  spec.edit.id = partial.edit?.id ?? EDIT;
  return mergeSetupEdit(spec);
}

describe('setup merge', () => {
  test('additions leave every existing row unchanged', () => {
    const outputs = emptyOutputs();
    outputs[2].generated.shared_injects = [freshInject('Dock note', 'dock_note')];
    const edited = acmeSnapshot([
      ...defaultTeams(),
      snapshotTeam({ team_uid: 'uid-ops', team_name: 'Operations', function_key: 'Operations' }),
    ]);
    const before = applyInput({ edit: { edited }, outputs });
    const snapshotBefore = structuredClone(before.current);
    const bundle = mergeSetupEdit({ ...before, edit: { ...before.edit, id: EDIT } });
    assert.deepEqual(before.current, snapshotBefore);
    const touchedTeams = new Set([
      ...bundle.teams.retire.map((row) => row.id),
      ...bundle.teams.insert.map((row) => row.id),
    ]);
    assert.equal(touchedTeams.has('team-comms'), false);
    assert.equal(touchedTeams.has('team-legal'), false);
    assert.equal(bundle.injects.patch.length, 0);
    assert.equal(bundle.injects.retire.length, 0);
    assert.equal(bundle.injects.insert.length, 1);
    assert.equal(bundle.new_team_names.includes('Operations'), true);
    assert.deepEqual(
      (bundle.scenario.initial_state as { player_roles: unknown }).player_roles,
      (snapshotBefore.scenario.initial_state as { player_roles: unknown }).player_roles,
    );
  });

  test('new keys never collide with active keys', () => {
    const outputs = emptyOutputs();
    outputs[1].generated.layer_injects = [freshInject('Plant update', '')];
    const bundle = bundleOf({ outputs });
    const keys = bundle.injects.insert.map((row) => injectKeyOf({ id: row.id, delivery_config: row.delivery_config }));
    assert.equal(keys.includes('plant_update'), false);
    assert.equal(keys.includes('plant_update_2'), true);
  });

  test('single-to-multi keeps bare team names', () => {
    const edited = snapshot([
      snapshotOrg({
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        is_primary: true,
        teams: defaultTeams(),
      }),
      snapshotOrg({
        org_uid: 'uid-bravo',
        org_key: 'org_bravo_sg',
        display_name: 'Bravo',
        short_name: 'BRAVO',
        teams: [snapshotTeam({ team_uid: 'uid-bravo', team_name: 'Communications — BRAVO' })],
      }),
    ]);
    const bundle = bundleOf({ edit: { edited } });
    assert.equal(bundle.teams.retire.some((row) => row.id === 'team-comms'), false);
    assert.equal(bundle.new_team_names.includes('Communications'), false);
    assert.equal(bundle.new_team_names.includes('Communications — BRAVO'), true);
  });

  test('a setup value overwrites a field only while it still equals the baseline', () => {
    assert.deepEqual(threeWayText('Night desk', 'Night desk', 'Wizard'), { value: 'Wizard', kept: false });
    assert.deepEqual(threeWayText('Night desk', 'Edited live', 'Wizard'), { value: 'Edited live', kept: true });

    const moved = structuredClone(applyInput().current);
    moved.teams = moved.teams.map((row) =>
      row.team_uid === 'uid-legal' ? { ...row, team_description: 'Edited live' } : row,
    );
    const outputs = emptyOutputs();
    outputs[0].text_updates = [{ org_key: 'primary', field: 'team_description', team_uid: 'uid-legal', value: 'Wizard' }];
    const kept = bundleOf({ current: moved, outputs });
    assert.equal(kept.summary.text_kept.includes('team_description:uid-legal'), true);
    assert.equal(kept.teams.retire.some((row) => row.id === 'team-legal'), false);

    const applied = bundleOf({ outputs });
    const successor = applied.teams.insert.find((row) => row.team_uid === 'uid-legal');
    assert.equal(successor?.team_description, 'Wizard');
    assert.equal(applied.teams.retire.some((row) => row.id === 'team-legal'), true);
  });

  test('roles, the coverage gate, escalation and mood survive onto a successor', () => {
    const current = applyInput().current;
    const injects = current.injects.map((row) => ({ ...row, has_history: true }));
    const outputs = emptyOutputs();
    outputs[1].revisions = [
      {
        inject_id: 'inj-plant',
        inject_key: 'plant_update',
        layer: 'backbone',
        decision: 'revise',
        reason: 'The brief changed the hour.',
        accepted: true,
        write: 'cow',
        new: {
          title: 'Plant update',
          content: 'The fire started at dawn.',
          delivery_config: { inject_key: 'plant_update', app: 'email' },
        },
        carried: { escalation: true },
      },
    ];
    const bundle = bundleOf({ current: { ...current, injects }, outputs });
    const state = bundle.scenario.initial_state as {
      player_roles: Array<{ role_id: string }>;
      call_coverage_gate: string;
    };
    assert.equal(state.player_roles[0].role_id, 'cs_head');
    assert.equal(state.call_coverage_gate, 'warn');
    const successor = bundle.injects.insert[0];
    assert.equal(successor.content, 'The fire started at dawn.');
    assert.deepEqual(successor.delivery_config.escalation, current.injects[0].delivery_config?.escalation);
    assert.deepEqual(successor.delivery_config.mood_ladder, current.injects[0].delivery_config?.mood_ladder);
    assert.deepEqual(successor.delivery_config.response_rubric, current.injects[0].delivery_config?.response_rubric);
    assert.equal(bundle.injects.retire[0].id, 'inj-plant');
    assert.equal(bundle.injects.retire[0].superseded_by, successor.id);

    outputs[1].revisions[0].accepted = false;
    const rejected = bundleOf({ current: { ...current, injects }, outputs });
    assert.equal(rejected.injects.retire.length, 0);
    assert.equal(rejected.injects.insert.length, 0);
    assert.equal(rejected.injects.patch.length, 0);
  });

  test('a validator failure or unresolved orphans produce no bundle', () => {
    const orphans = applyInput({
      plan: emptyPlan({
        applicable: false,
        orphans: [
          {
            id: 'role-1',
            kind: 'player_role',
            message: 'Communications lost its role',
            choices: ['move_to_retired', 'reassign'],
            role_id: 'cs_head',
          },
        ],
      }),
    });
    const before = structuredClone(orphans);
    assert.throws(() => mergeSetupEdit(orphans), (err: unknown) => {
      assert.ok(err instanceof SetupMergeError);
      assert.equal(err.code, 'ORPHANS_UNRESOLVED');
      return true;
    });
    assert.deepEqual(orphans, before);

    const invalid = applyInput({
      plan: emptyPlan({
        initial_state: {
          patch: [
            {
              op: 'replace',
              path: '/orgs',
              value: [
                { org_key: 'primary', display_name: 'Acme', country: 'Singapore', side: 'protagonist', is_primary: true },
                { org_key: 'org_other_sg', display_name: 'Other', country: 'Singapore', side: 'protagonist', is_primary: true },
              ],
            },
          ],
          move_to_retired: [],
        },
      }),
    });
    const invalidBefore = structuredClone(invalid);
    assert.throws(() => mergeSetupEdit(invalid), (err: unknown) => {
      assert.ok(err instanceof MultiOrgValidationError);
      assert.equal(err.code, 'MO-ORG-002');
      return true;
    });
    assert.deepEqual(invalid, invalidBefore);
  });

  test('rename and removal bundles follow the remap plan', () => {
    const renamed = planAndMerge(renameSource());
    assert.deepEqual(
      renamed.bundle.teams.retire.map((row) => row.id).sort(),
      renamed.plan.teams.retire.map((row) => row.source_id).sort(),
    );
    assert.deepEqual(
      renamed.bundle.teams.insert.map((row) => ({
        team_uid: row.team_uid,
        team_name: row.team_name,
        org_key: row.org_key,
      })),
      renamed.plan.teams.successors.map((row) => ({
        team_uid: row.team_uid,
        team_name: row.team_name,
        org_key: row.org_key,
      })),
    );
    assert.deepEqual(
      renamed.bundle.injects.patch.map((row) => row.id).sort(),
      renamed.plan.injects.rewrite_in_place.map((row) => row.inject_id).sort(),
    );
    const patched = renamed.bundle.injects.patch.find((row) => row.id === 'inj-legal');
    assert.deepEqual(patched?.target_teams, ['Counsel']);
    assert.deepEqual(renamed.bundle.scheduled_sessions[0]?.rename.call_lines[0]?.steps, [
      'insert_line',
      'move_takers',
      'delete_old_line',
    ]);

    assert.throws(() => mergeSetupEdit(planAndMerge(removalSource()).spec), SetupMergeError);
    const decided = planAndMerge(removalSource(), {
      'role:cs_head': { choice: 'move_to_retired' },
    });
    assert.equal(decided.plan.applicable, true);
    assert.deepEqual(
      decided.bundle.teams.retire.map((row) => ({ id: row.id, reason: row.reason })),
      decided.plan.teams.retire.map((row) => ({ id: row.source_id, reason: row.reason })),
    );
    assert.ok(decided.bundle.injects.retire.some((row) => row.id === 'inj-comms'));
  });

  test('a primary swap rewrites both organisations in one pass', () => {
    const swapped = planAndMerge(swapSource());
    const plan = swapped.plan;
    const bundle = swapped.bundle;
    const fresh = plan.primary_swap?.old_primary_new_key;
    assert.ok(fresh);
    for (const successor of plan.teams.successors) {
      const written = bundle.teams.insert.find((row) => row.team_uid === successor.team_uid);
      assert.equal(written?.org_key, successor.org_key);
      assert.equal(written?.team_uid, successor.team_uid);
      assert.ok(bundle.teams.retire.some((row) => row.id === successor.source_id && row.superseded_by === written?.id));
    }
    assert.equal(bundle.teams.insert.find((row) => row.team_uid === 'uid-bravo')?.org_key, 'primary');
    assert.equal(bundle.teams.insert.find((row) => row.team_uid === 'uid-comms')?.org_key, fresh);
    const historyInject = bundle.injects.insert.find((row) => row.delivery_config.inject_key === 'bravo_note');
    const liveInject = bundle.injects.patch.find((row) => row.id === 'inj-acme');
    assert.equal(historyInject?.delivery_config.org_key, 'primary');
    assert.equal(liveInject?.delivery_config.org_key, fresh);
    assert.equal(bundle.history_free_inject_ids.includes('inj-acme'), true);
    assert.equal(bundle.history_free_inject_ids.includes('inj-bravo'), false);

    const state = bundle.scenario.initial_state as {
      country: string;
      org_name: string;
      orgs: Array<{ org_uid: string; org_key: string; is_primary?: boolean }>;
      org_key_history: Array<{ org_uid: string; org_key: string; from_edit: string | null; until_edit: string | null }>;
    };
    const primaries = state.orgs.filter((org) => org.is_primary && org.org_key === 'primary');
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0].org_uid, 'uid-bravo');
    assert.equal(state.country, 'Malaysia');
    assert.equal(state.org_name, 'Bravo');
    assert.equal(JSON.stringify(state.org_key_history).includes(EDIT_TOKEN), false);
    assert.ok(state.org_key_history.some((row) => row.org_uid === 'uid-acme' && row.org_key === 'primary' && row.until_edit === EDIT));
    assert.ok(state.org_key_history.some((row) => row.org_uid === 'uid-bravo' && row.org_key === 'org_bravo_my' && row.until_edit === EDIT));
    assert.ok(state.org_key_history.some((row) => row.org_uid === 'uid-acme' && row.org_key === fresh && row.from_edit === EDIT && row.until_edit == null));
    assert.ok(state.org_key_history.some((row) => row.org_uid === 'uid-bravo' && row.org_key === 'primary' && row.from_edit === EDIT && row.until_edit == null));
  });

  test('a completed session still labels the old primary and a new session labels the new one', () => {
    const swapped = planAndMerge(swapSource());
    const before = swapSource().initial_state;
    const completed = orgsForSession({
      start_time: '2026-01-01T00:00:00.000Z',
      current_state: before,
      initial_state: swapped.bundle.scenario.initial_state,
    });
    assert.equal(completed.find((org) => org.org_key === 'primary')?.display_name, 'Acme');
    const opened = orgsForSession({
      start_time: null,
      current_state: before,
      initial_state: swapped.bundle.scenario.initial_state,
    });
    assert.equal(opened.find((org) => org.is_primary)?.display_name, 'Bravo');
    assert.equal(opened.find((org) => org.is_primary)?.org_key, 'primary');
    assert.equal(JSON.stringify(swapped.bundle).includes('session_decisions'), false);
    assert.equal(swapped.bundle.teams.insert.find((row) => row.team_uid === 'uid-bravo')?.org_key, 'primary');
  });

  test('scheduled pages re-seed onto the swapped keys', () => {
    const swapped = planAndMerge(swapSource());
    const session = swapped.bundle.scheduled_sessions[0];
    assert.equal(session?.reseed_org_pages, true);
    assert.equal(session?.delete_sim_org_pages, true);
    const pages = orgPagesSeededBy(swapped.bundle.scenario.initial_state);
    const fresh = swapped.plan.primary_swap?.old_primary_new_key;
    for (const platform of ['facebook', 'x_twitter'] as const) {
      const onPlatform = pages.filter((row) => row.platform === platform);
      assert.equal(onPlatform.filter((row) => row.is_primary).length, 1);
      assert.equal(onPlatform.find((row) => row.is_primary)?.org_key, 'primary');
      assert.equal(onPlatform.some((row) => row.org_key === fresh), true);
      assert.equal(onPlatform.some((row) => row.org_key === 'org_bravo_my'), false);
    }
  });

  test('a completed session keeps the pre-edit names and a later session sees the revision', () => {
    const renamed = planAndMerge(renameSource());
    const appliedAt = '2026-06-01T00:00:00.000Z';
    const teams = [
      { team_name: 'Legal', valid_from: '2026-01-01T00:00:00.000Z', retired_at: appliedAt },
      { team_name: 'Counsel', valid_from: appliedAt, retired_at: null },
    ];
    const injects = [
      { title: 'Legal note', content: 'Ask counsel tonight.', valid_from: '2026-01-01T00:00:00.000Z', retired_at: appliedAt },
      { title: 'Counsel note', content: 'Ask counsel at dawn.', valid_from: appliedAt, retired_at: null },
    ];
    const started = '2026-03-01T00:00:00.000Z';
    const later = '2026-07-01T00:00:00.000Z';
    assert.deepEqual(rowsValidAt(teams, started).map((row) => row.team_name), ['Legal']);
    assert.deepEqual(rowsValidAt(teams, later).map((row) => row.team_name), ['Counsel']);
    assert.equal(rowsValidAt(injects, started)[0].content, 'Ask counsel tonight.');
    assert.equal(rowsValidAt(injects, later)[0].content, 'Ask counsel at dawn.');
    assert.equal(renamed.bundle.injects.patch.find((row) => row.id === 'inj-legal')?.content, 'Ask counsel tonight.');
  });
});

describe('peace period on apply', () => {
  test('a pages-stage feed is written and the remap peace_period patch is dropped', () => {
    const stage = peaceFeed('Hawker centre lunch', 'warehouse fire');
    const planned = peaceFeed('Planner draft only', 'old leak');
    const outputs = emptyOutputs();
    outputs[3].peace_period = stage;
    const bundle = bundleOf({
      outputs,
      plan: emptyPlan({
        initial_state: {
          patch: [
            { op: 'replace', path: '/peace_period', value: planned },
            { op: 'replace', path: '/org_name', value: 'Kept org' },
          ],
          move_to_retired: [],
        },
      }),
    });
    const state = bundle.scenario.initial_state as { peace_period: PeaceFeed; org_name: string };
    assert.equal(state.peace_period.posts[0].content, 'Hawker centre lunch');
    assert.deepEqual(state.peace_period.leak_terms, ['warehouse fire']);
    assert.equal(state.org_name, 'Kept org');
  });

  test('without a pages-stage feed the remap peace_period patch is applied', () => {
    const planned = peaceFeed('Planner draft only', 'old leak');
    const bundle = bundleOf({
      plan: emptyPlan({
        initial_state: {
          patch: [{ op: 'replace', path: '/peace_period', value: planned }],
          move_to_retired: [],
        },
      }),
    });
    const state = bundle.scenario.initial_state as { peace_period: PeaceFeed };
    assert.equal(state.peace_period.posts[0].content, 'Planner draft only');
    assert.deepEqual(state.peace_period.leak_terms, ['old leak']);
  });
});

describe('objective revisions', () => {
  function withObjective(write: 'in_place' | 'cow') {
    const outputs = emptyOutputs();
    outputs[1].objective_updates = [{
      objective_id: 'hold_the_line',
      write,
      fields: { objective_name: 'Hold the story', description: 'Updated line', weight: 30 },
    }];
    const objectives: MergeObjective[] = [{
      id: 'obj-row',
      objective_id: 'hold_the_line',
      objective_name: 'Hold',
      description: 'Old line',
      weight: 25,
      success_criteria: { evidence: 'a statement' },
    }];
    const spec = applyInput({ outputs });
    spec.current.scenario.objectives = objectives;
    spec.edit.id = EDIT;
    return mergeSetupEdit(spec);
  }

  test('an in-place revision updates the row matched by the text slug', () => {
    const bundle = withObjective('in_place');
    assert.equal(bundle.objectives.update.length, 1);
    assert.equal(bundle.objectives.update[0].id, 'obj-row');
    assert.equal(bundle.objectives.update[0].objective_name, 'Hold the story');
    assert.equal(bundle.objectives.insert.length, 0);
    assert.equal(bundle.objectives.retire.length, 0);
  });

  test('a copy-on-write revision retires the row and keeps the slug', () => {
    const bundle = withObjective('cow');
    assert.equal(bundle.objectives.update.length, 0);
    assert.deepEqual(bundle.objectives.retire, [{ id: 'obj-row' }]);
    assert.equal(bundle.objectives.insert.length, 1);
    assert.equal(bundle.objectives.insert[0].objective_id, 'hold_the_line');
    assert.notEqual(bundle.objectives.insert[0].id, 'obj-row');
    assert.equal(bundle.objectives.insert[0].objective_name, 'Hold the story');
  });
});

describe('inject revision fields', () => {
  test('a time-only revision is written in place', () => {
    const outputs = emptyOutputs();
    outputs[1].revisions = [{
      inject_id: 'inj-plant',
      inject_key: 'plant_update',
      layer: 'storyline',
      decision: 'revise',
      reason: 'Move it later',
      accepted: true,
      write: 'in_place',
      new: {
        title: 'plant_update',
        content: 'The night shift reported smoke.',
        trigger_time_minutes: 45,
        delivery_config: { inject_key: 'plant_update', app: 'email' },
      },
      carried: { escalation: true },
    }];
    const bundle = bundleOf({ outputs });
    assert.equal(bundle.injects.patch.length, 1);
    assert.equal(bundle.injects.patch[0].id, 'inj-plant');
    assert.equal(bundle.injects.patch[0].trigger_time_minutes, 45);
    assert.equal(bundle.injects.patch[0].title, 'plant_update');
    assert.equal(bundle.injects.insert.length, 0);
  });
});

describe('dependency rows on apply', () => {
  test('a renamed team and an added team keep a valid edge and insert its inject', () => {
    const baseline = acmeSnapshot();
    const edited = acmeSnapshot([
      snapshotTeam({
        team_uid: 'uid-comms',
        team_name: 'Communications',
        function_key: 'Communications',
        description: 'Night desk',
        is_public_voice: true,
      }),
      snapshotTeam({ team_uid: 'uid-legal', team_name: 'Counsel', function_key: 'Legal', description: 'Counsel' }),
      snapshotTeam({ team_uid: 'uid-ops', team_name: 'Operations', function_key: 'Operations' }),
    ]);
    const source = input({
      delta: computeDelta(baseline, edited),
      edited,
      initial_state: baseState({
        team_dependencies: {
          v: 1,
          edges: [dependencyEdge('dep_comms_legal', 'Communications', 'Legal')],
        },
      }),
      teams: [
        team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications', function_key: 'Communications' }),
        team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal', function_key: 'Legal', team_description: 'Counsel' }),
      ],
      injects: [
        inject({
          id: 'inj-legal',
          inject_key: 'legal_note',
          title: 'Legal note',
          content: 'Ask counsel tonight.',
          target_teams: ['Legal'],
          has_history: false,
          delivery_config: { app: 'email' },
        }),
      ],
      sessions: [
        emptySession({
          session_id: 'sess-rename',
          teams: [{ user_id: 'user-1', team_name: 'Legal' }],
          channels: [{ team_name: 'Legal', message_count: 1 }],
          call_lines: [{ team_name: 'Legal' }],
          call_takers: [{ team_name: 'Legal', user_id: 'user-1' }],
        }),
      ],
    });
    const plan = planRemap(source);
    const outputs = emptyOutputs();
    outputs[1].generated.dependency_edges = [dependencyEdge('dep_counsel_ops', 'Counsel', 'Operations')];
    outputs[1].generated.dependency_injects = [{
      title: 'Counsel missed the handoff',
      content: 'Operations is waiting on the night report.',
      type: 'social_post',
      severity: 'high',
      inject_scope: 'team_specific',
      target_teams: ['Operations'],
      delivery_config: {
        app: 'email',
        cause: { kind: 'dependency', dep_id: 'dep_counsel_ops' },
      },
    }];
    const spec = applyInput({
      plan,
      outputs,
      edit: { id: EDIT, baseline, edited },
      current: {
        scenario: {
          title: 'Warehouse fire',
          description: 'Smoke in the loading bay',
          briefing: 'The warehouse is burning',
          category: 'social_media_crisis',
          difficulty: 'intermediate',
          duration_minutes: 60,
          initial_state: source.initial_state,
          objectives: [],
        },
        teams: source.teams.map((row) => teamRow({
          id: row.id,
          team_uid: row.team_uid,
          team_name: row.team_name,
          org_key: row.org_key,
          function_key: row.function_key,
          team_description: row.team_description,
        })),
        injects: source.injects.map((row) => injectRow({
          id: row.id,
          inject_key: injectKeyOf(row),
          has_history: row.has_history,
          title: row.title ?? '',
          content: row.content ?? '',
          target_teams: row.target_teams ?? [],
          delivery_config: row.delivery_config ?? undefined,
        })),
      },
    });
    const bundle = mergeSetupEdit(spec);
    assert.equal(bundle.teams.insert.some((row) => row.team_name === 'Counsel'), true);
    assert.equal(bundle.teams.insert.some((row) => row.team_name === 'Operations'), true);
    const state = bundle.scenario.initial_state as { team_dependencies: { v: number; edges: TeamDependencyEdge[] } };
    assert.deepEqual(
      state.team_dependencies.edges.map((edge) => edge.id),
      ['dep_comms_legal', 'dep_counsel_ops'],
    );
    const created = bundle.injects.insert.find((row) => row.title === 'Counsel missed the handoff');
    assert.ok(created);
    assert.equal(created.response_type, 'standard');
    assert.equal((created.delivery_config.gen as { layer: string }).layer, 'dependency:dep_counsel_ops');
    const session = bundle.scheduled_sessions[0];
    assert.deepEqual(Object.keys(session.rename.team_names[0]).sort(), ['from', 'to']);
    assert.deepEqual(Object.keys(session.rename.channels[0]).sort(), ['from', 'to']);
    assert.deepEqual(Object.keys(session.rename.call_lines[0]).sort(), ['from_team', 'steps', 'to_team']);
  });
});

describe('apply migration guards', () => {
  const sql = readFileSync(new URL('../../../migrations/277_apply_scenario_setup_edit.sql', import.meta.url), 'utf8');

  test('absent 268–273 and dependency tables are reached only through to_regclass', () => {
    assert.match(sql, /NOT APPLIED/);
    for (const table of [
      'inject_deliveries',
      'session_call_lines',
      'session_call_takers',
      'session_role_assignments',
      'session_dependency_states',
    ]) {
      assert.match(sql, new RegExp(`to_regclass\\('public\\.${table}'\\)`));
    }
    assert.doesNotMatch(sql, /EXECUTE[\s\S]*public\.escalation_chains/);
    assert.doesNotMatch(sql, /EXECUTE[\s\S]*public\.stakeholder_moods/);
    assert.match(sql, /inject_publications/);
    assert.match(sql, /count_scenario_setup_edit/);
    assert.doesNotMatch(sql, /public\.escalation_chains/);
    assert.doesNotMatch(sql, /public\.escalation_chain_steps/);
    assert.doesNotMatch(sql, /public\.stakeholder_moods/);
    assert.doesNotMatch(sql, /history_free_inject_ids/);
    assert.match(sql, /JOIN jsonb_array_elements\(p_bundle->'injects'->'patch'\)/);
    assert.match(
      sql,
      /INSERT INTO public\.session_call_lines \(session_id, team_name, version, unattended_since\)/,
    );
  });

  test('jsonb_to_recordset columns are the keys the merge bundle writes', () => {
    const parsed = parseRecordsetColumns(sql);
    const expected = applySqlRecordColumns();
    assert.deepEqual(
      [...parsed.keys()].sort(),
      Object.keys(expected).map((key) => key.replace(/\s+/g, '')).sort(),
    );
    for (const [argument, keys] of Object.entries(expected)) {
      assert.deepEqual(
        parsed.get(argument.replace(/\s+/g, ''))?.slice().sort(),
        [...keys].sort(),
        argument,
      );
    }
    const swapped = planRemap(swapSource());
    const controller = swapped.scheduled_sessions[0]?.remap_page_controllers[0];
    assert.ok(controller);
    assert.deepEqual(Object.keys(controller).sort(), ['from', 'to', 'user_id']);
  });
});

function parseRecordsetColumns(sql: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const needle = 'jsonb_to_recordset(';
  let cursor = 0;
  while (cursor < sql.length) {
    const start = sql.indexOf(needle, cursor);
    if (start < 0) break;
    const argOpen = start + needle.length - 1;
    const argEnd = matchingParen(sql, argOpen);
    const argument = sql.slice(argOpen + 1, argEnd).replace(/\s+/g, '');
    let index = argEnd + 1;
    while (/\s/.test(sql[index] ?? '')) index += 1;
    if (sql.slice(index, index + 2) !== 'AS') throw new Error(`expected AS after ${argument}`);
    index += 2;
    while (/\s/.test(sql[index] ?? '')) index += 1;
    while (/[A-Za-z0-9_]/.test(sql[index] ?? '')) index += 1;
    while (/\s/.test(sql[index] ?? '')) index += 1;
    if (sql[index] !== '(') throw new Error(`expected columns after ${argument}`);
    const colsEnd = matchingParen(sql, index);
    const names = splitTopLevel(sql.slice(index + 1, colsEnd)).map((part) =>
      part.trim().split(/\s+/)[0]?.replace(/"/g, '') ?? '',
    );
    const previous = found.get(argument);
    if (previous && previous.join('\0') !== names.join('\0')) {
      throw new Error(`${argument} declares two column lists`);
    }
    found.set(argument, names);
    cursor = colsEnd + 1;
  }
  return found;
}

function matchingParen(sql: string, open: number): number {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    else if (sql[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('unbalanced parenthesis');
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function dependencyEdge(id: string, upstream: string, downstream: string): TeamDependencyEdge {
  return {
    id,
    kind: 'information',
    upstream: { team_uid: null, team_name: upstream },
    downstream: [{ team_uid: null, team_name: downstream }],
    deliverable: 'the night report',
    why: 'the next team cannot post without it',
    due: { by_minute: 30 },
    broken_when: { all: ['team_silent:8|team=@upstream'] },
    met_when: null,
    lag_minutes: 0,
    severity: 'high',
    consequence_keys: [],
    source: 'war_room',
  };
}

function peaceFeed(content: string, leak: string): PeaceFeed {
  return {
    version: 1,
    seconds: 300,
    enabled: true,
    leak_terms: [leak],
    posts: [
      {
        ref: 'p1',
        author: { kind: 'persona', handle: '@mina' },
        platform: 'facebook',
        post_format: 'text',
        content,
        media_description: '',
        offset_seconds: 120,
        comments: [],
      },
    ],
  };
}

function freshInject(title: string, key: string): SocialInject {
  return {
    title,
    content: 'New copy',
    type: 'social_post',
    severity: 'low',
    inject_scope: 'team_specific',
    target_teams: ['Communications'],
    trigger_time_minutes: 25,
    delivery_config: { app: 'email', ...(key ? { inject_key: key } : {}) },
  };
}

function renameSource(): RemapPlannerInput {
  const baseline = acmeSnapshot();
  const edited = acmeSnapshot([
    snapshotTeam({
      team_uid: 'uid-comms',
      team_name: 'Communications',
      function_key: 'Communications',
      description: 'Night desk',
      is_public_voice: true,
    }),
    snapshotTeam({ team_uid: 'uid-legal', team_name: 'Counsel', function_key: 'Legal', description: 'Counsel' }),
  ]);
  return input({
    delta: computeDelta(baseline, edited),
    edited,
    initial_state: baseState(),
    teams: [
      team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications', function_key: 'Communications' }),
      team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal', function_key: 'Legal', team_description: 'Counsel' }),
    ],
    injects: [
      inject({
        id: 'inj-legal',
        inject_key: 'legal_note',
        title: 'Legal note',
        content: 'Ask counsel tonight.',
        target_teams: ['Legal'],
        has_history: false,
        delivery_config: { app: 'email' },
      }),
    ],
    sessions: [
      emptySession({
        session_id: 'sess-rename',
        teams: [{ user_id: 'user-1', team_name: 'Legal' }],
        call_lines: [{ team_name: 'Legal' }],
        call_takers: [{ team_name: 'Legal', user_id: 'user-1' }],
      }),
    ],
  });
}

function removalSource(): RemapPlannerInput {
  const baseline = acmeSnapshot();
  const edited = acmeSnapshot([
    snapshotTeam({
      team_uid: 'uid-legal',
      team_name: 'Legal',
      function_key: 'Legal',
      description: 'Counsel',
    }),
  ]);
  return input({
    delta: computeDelta(baseline, edited),
    edited,
    initial_state: baseState(),
    teams: [
      team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications', function_key: 'Communications' }),
      team({ id: 'team-legal', team_uid: 'uid-legal', team_name: 'Legal', function_key: 'Legal' }),
    ],
    injects: [
      inject({
        id: 'inj-comms',
        inject_key: 'comms_note',
        target_teams: ['Communications'],
        has_history: false,
        delivery_config: { app: 'email', org_key: 'primary' },
      }),
    ],
  });
}

function swapSource(): RemapPlannerInput {
  const baseline = snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      country: 'Singapore',
      is_primary: true,
      teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications', function_key: 'Communications' })],
    }),
    snapshotOrg({
      org_uid: 'uid-bravo',
      org_key: 'org_bravo_my',
      display_name: 'Bravo',
      short_name: 'BRAVO',
      country: 'Malaysia',
      teams: [snapshotTeam({ team_uid: 'uid-bravo', team_name: 'Communications — BRAVO', function_key: 'Communications' })],
    }),
  ]);
  const edited: SetupSnapshot = snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      country: 'Singapore',
      is_primary: false,
      teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications', function_key: 'Communications' })],
    }),
    snapshotOrg({
      org_uid: 'uid-bravo',
      org_key: 'org_bravo_my',
      display_name: 'Bravo',
      short_name: 'BRAVO',
      country: 'Malaysia',
      is_primary: true,
      teams: [snapshotTeam({ team_uid: 'uid-bravo', team_name: 'Communications — BRAVO', function_key: 'Communications' })],
    }),
  ]);
  return input({
    delta: computeDelta(baseline, edited),
    edited,
    initial_state: {
      country: 'Singapore',
      org_name: 'Acme',
      orgs: [
        {
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          short_name: 'ACME',
          country: 'Singapore',
          kind: 'company',
          side: 'protagonist',
          is_primary: true,
          operation: 'players',
        },
        {
          org_uid: 'uid-bravo',
          org_key: 'org_bravo_my',
          display_name: 'Bravo',
          short_name: 'BRAVO',
          country: 'Malaysia',
          kind: 'company',
          side: 'protagonist',
          is_primary: false,
          operation: 'players',
        },
      ],
      countries: [
        { name: 'Singapore', code: 'SG' },
        { name: 'Malaysia', code: 'MY' },
      ],
      org_page: {
        orgs: [orgPage('primary', 'Acme', true, 'uid-acme'), orgPage('org_bravo_my', 'Bravo', false, 'uid-bravo')],
      },
      stakeholders: [],
      npc_personas: [],
      org_key_history: [
        { org_uid: 'uid-acme', org_key: 'primary', from_edit: null, until_edit: null },
        { org_uid: 'uid-bravo', org_key: 'org_bravo_my', from_edit: null, until_edit: null },
      ],
    },
    teams: [
      team({ id: 'team-comms', team_uid: 'uid-comms', team_name: 'Communications', org_key: 'primary', function_key: 'Communications' }),
      team({ id: 'team-bravo', team_uid: 'uid-bravo', team_name: 'Communications — BRAVO', org_key: 'org_bravo_my', function_key: 'Communications' }),
    ],
    injects: [
      inject({ id: 'inj-acme', inject_key: 'acme_note', has_history: false, delivery_config: { app: 'email', org_key: 'primary' } }),
      inject({ id: 'inj-bravo', inject_key: 'bravo_note', has_history: true, delivery_config: { app: 'email', org_key: 'org_bravo_my' } }),
    ],
    sessions: [
      emptySession({
        session_id: 'sess-1',
        teams: [{ user_id: 'user-1', team_name: 'Communications' }],
        call_lines: [{ team_name: 'Communications' }],
        call_takers: [{ team_name: 'Communications', user_id: 'user-1' }],
        page_controllers: [{ org_key: 'primary', user_id: 'user-1' }],
        org_pages: [{ org_key: 'primary' }, { org_key: 'org_bravo_my' }],
      }),
    ],
  });
}

function planAndMerge(
  source: RemapPlannerInput,
  resolutions?: RemapPlannerInput['resolutions'],
): { spec: ReturnType<typeof applyInput>; plan: ReturnType<typeof planRemap>; bundle: ApplyBundle } {
  const plan = planRemap({ ...source, resolutions });
  const teams: MergeTeamRow[] = source.teams.map((row) =>
    teamRow({
      id: row.id,
      team_uid: row.team_uid,
      team_name: row.team_name,
      org_key: row.org_key,
      function_key: row.function_key,
      team_description: row.team_description,
      charter: row.charter ?? {
        function_key: row.function_key,
        is_custom: false,
        can_post_publicly: row.team_name === 'Communications',
        mission: row.team_name,
      },
    }),
  );
  const injects: MergeInjectRow[] = source.injects.map((row) =>
    injectRow({
      id: row.id,
      inject_key: injectKeyOf(row),
      has_history: row.has_history,
      title: row.title ?? injectKeyOf(row),
      content: row.content ?? '',
      target_teams: row.target_teams ?? [],
      delivery_config: row.delivery_config ?? undefined,
    }),
  );
  const edited = source.edited;
  const spec = applyInput({
    current: {
      scenario: {
        title: 'Warehouse fire',
        description: textOf(asRecord(source.initial_state)?.description) || 'Smoke in the loading bay',
        briefing: 'The warehouse is burning',
        category: 'social_media_crisis',
        difficulty: 'intermediate',
        duration_minutes: 60,
        initial_state: source.initial_state,
        objectives: [],
      },
      teams,
      injects,
    },
    plan,
    edit: { id: EDIT, baseline: source.edited, edited },
    resolutions,
  });
  spec.edit.baseline = baselineFrom(source);
  if (!plan.applicable) return { spec, plan, bundle: emptyPlan() as unknown as ApplyBundle };
  return { spec, plan, bundle: mergeSetupEdit(spec) };
}

function baselineFrom(source: RemapPlannerInput): SetupSnapshot {
  if (source.delta.primary_swap) {
    return snapshot([
      snapshotOrg({
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        country: 'Singapore',
        is_primary: true,
        teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
      }),
      snapshotOrg({
        org_uid: 'uid-bravo',
        org_key: 'org_bravo_my',
        display_name: 'Bravo',
        short_name: 'BRAVO',
        country: 'Malaysia',
        teams: [snapshotTeam({ team_uid: 'uid-bravo', team_name: 'Communications — BRAVO' })],
      }),
    ]);
  }
  return acmeSnapshot();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
