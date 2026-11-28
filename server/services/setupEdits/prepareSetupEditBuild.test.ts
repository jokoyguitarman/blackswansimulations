import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { draftInputFromSnapshot } from './setupSnapshotCore.js';
import { snapshot, snapshotOrg, snapshotTeam } from './fixtures/remapFixtures.js';
import { recomputeSetupEdit, type SetupEditBuildSource } from './prepareSetupEditBuild.js';

function source(draft: unknown): SetupEditBuildSource {
  const baseline = snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      is_primary: true,
      teams: [snapshotTeam({ team_uid: 'uid-comms', team_name: 'Communications' })],
    }),
  ]);
  return {
    edit: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scenario_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'open',
      draft_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      baseline,
      edit_number: 1,
    },
    draft_input: draft,
    remap: {
      initial_state: { orgs: [{ org_key: 'primary', org_uid: 'uid-acme', display_name: 'Acme', is_primary: true }] },
      teams: [],
      injects: [],
      sessions: [],
    },
  };
}

describe('recomputeSetupEdit', () => {
  test('an untouched draft is empty and a brief change returns a plan without writing', () => {
    const baseline = source(null).edit.baseline;
    const draft = draftInputFromSnapshot(baseline as never, {
      edit_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scenario_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      scenario_title: 'Acme',
      remaining: 3,
    });
    const same = recomputeSetupEdit(source(draft));
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.code, 'SETUP_EDIT_EMPTY');

    const changed = recomputeSetupEdit(source({ ...draft, context: 'The leak started at dawn.' }));
    assert.equal(changed.ok, true);
    if (changed.ok) {
      assert.equal(changed.delta.brief_changed, true);
      assert.equal(changed.plan.applicable, true);
    }
  });

  test('a preview draft is planned and the saved draft is left as it was passed in', () => {
    const saved = source({ context: 'Night shift' });
    const preview = recomputeSetupEdit(saved, { draft_input: { ...((saved.draft_input as object) ?? {}), context: 'Dawn' } });
    assert.equal(preview.ok, true);
    assert.equal((saved.draft_input as { context?: string }).context, 'Night shift');
  });
});
