import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { orphanTargetLists } from './planSetupEdit.js';
import type { PlannerInject, PlannerTeam, RemapPlan } from './remapPlanner.js';
import type { SetupEditBuildSource } from './prepareSetupEditBuild.js';
import { snapshot, snapshotOrg, snapshotTeam } from './fixtures/remapFixtures.js';

function team(partial: Pick<PlannerTeam, 'id' | 'team_uid' | 'team_name'>): PlannerTeam {
  return {
    org_key: 'primary',
    function_key: null,
    team_description: null,
    charter: null,
    expected_actions: null,
    scoring_rubric: null,
    ...partial,
  };
}

function inject(id: string, injectKey: string): PlannerInject {
  return { id, has_history: false, delivery_config: { inject_key: injectKey } };
}

function plan(partial: Pick<RemapPlan, 'teams' | 'injects'>): RemapPlan {
  return {
    teams: partial.teams,
    injects: { rewrite_in_place: [], cow: [], retire: partial.injects.retire },
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

describe('orphanTargetLists', () => {
  test('drops removed teams and retired injects, and uses successor names', () => {
    const retiredId = '11111111-1111-4111-8111-111111111111';
    const keptId = '22222222-2222-4222-8222-222222222222';
    const source: SetupEditBuildSource = {
      edit: {
        id: 'edit-1',
        scenario_id: 'scenario-1',
        status: 'open',
        draft_id: 'draft-1',
        baseline: null,
        edit_number: 1,
      },
      draft_input: {},
      remap: {
        initial_state: {},
        sessions: [],
        teams: [
          team({ id: 's1', team_uid: 'uid-old', team_name: 'Old desk' }),
          team({ id: 's2', team_uid: 'uid-press', team_name: 'Media' }),
          team({ id: 's3', team_uid: 'uid-legal', team_name: 'Legal' }),
        ],
        injects: [inject(retiredId, 'old_note'), inject(keptId, 'dawn_note')],
      },
    };
    const edited = snapshot(
      [
        snapshotOrg({
          org_uid: 'uid-acme',
          org_key: 'primary',
          display_name: 'Acme',
          is_primary: true,
          teams: [
            snapshotTeam({ team_uid: 'uid-press', team_name: 'Press office' }),
            snapshotTeam({ team_uid: 'uid-legal', team_name: 'Legal' }),
            snapshotTeam({ team_uid: 'uid-night', team_name: 'Night desk' }),
          ],
        }),
      ],
      {
        pressure_organisations: [
          {
            org_uid: 'uid-press',
            org_key: 'press_1',
            display_name: 'The press',
            country: 'Singapore',
            targets_org_keys: ['primary'],
          },
        ],
        competitors: [
          {
            org_uid: 'uid-rival',
            org_key: 'rival_1',
            name: 'Rival',
            country: 'Singapore',
            auto_generated: false,
          },
        ],
      },
    );
    const targets = orphanTargetLists(
      source,
      plan({
        teams: {
          retire: [
            {
              source_id: 's1',
              team_uid: 'uid-old',
              team_name: 'Old desk',
              org_key: 'primary',
              reason: 'removed',
            },
            {
              source_id: 's2',
              team_uid: 'uid-press',
              team_name: 'Media',
              org_key: 'primary',
              reason: 'renamed',
            },
          ],
          successors: [
            {
              source_id: 's2',
              team_uid: 'uid-press',
              team_name: 'Press office',
              from_name: 'Media',
              org_key: 'primary',
              function_key: null,
              team_description: null,
              charter: null,
              expected_actions: null,
              scoring_rubric: null,
              reason: 'renamed',
            },
          ],
        },
        injects: {
          rewrite_in_place: [],
          cow: [],
          retire: [{ inject_id: retiredId, inject_key: 'old_note', reason: 'team_layer' }],
        },
      }),
      edited,
    );
    assert.equal(targets.teams.includes('Old desk'), false);
    assert.equal(targets.teams.includes('Media'), false);
    assert.equal(targets.teams.includes('Press office'), true);
    assert.equal(targets.teams.includes('Legal'), true);
    assert.equal(targets.teams.includes('Night desk'), true);
    assert.deepEqual(targets.inject_keys, ['dawn_note']);
    assert.deepEqual(targets.org_keys, ['press_1', 'primary', 'rival_1']);
  });
});
