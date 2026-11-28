import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setupEditButtonState } from '../src/lib/setupEditButton.ts';

describe('setup edit library button', () => {
  test('a disabled feature, including a missing migration, shows no button', () => {
    const hidden = setupEditButtonState({
      enabled: false,
      remaining: 3,
      limit: 3,
      locked: false,
    });
    assert.equal(hidden.visible, false);
    assert.equal(hidden.label, '');
  });

  test('a trainer sees how many edits are left', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: 2,
      limit: 3,
      locked: false,
    });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, false);
    assert.equal(state.label, 'Edit setup · 2 left');
    assert.equal(state.title, 'Edit setup');
  });

  test('an admin is not counted', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: null,
      limit: 3,
      locked: false,
    });
    assert.equal(state.label, 'Edit setup');
    assert.equal(state.disabled, false);
  });

  test('nothing left disables the button with the allowance message', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: 0,
      limit: 3,
      locked: false,
    });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, true);
    assert.equal(state.label, 'Edit setup · 0 left');
    assert.equal(state.title, 'All 3 setup edits used. Ask an admin.');
  });

  test('a locked scenario keeps the button and disables it', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: 2,
      limit: 3,
      locked: true,
      lockTitle: 'A session is live — editing is locked',
    });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, true);
    assert.equal(state.label, 'Edit setup · 2 left');
    assert.equal(state.title, 'A session is live — editing is locked');
  });

  test('a limit of 0 tells the trainer none are left', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: 0,
      limit: 0,
      locked: false,
    });
    assert.equal(state.disabled, true);
    assert.equal(state.title, 'All 0 setup edits used. Ask an admin.');
  });

  test('your own open edit leaves the button unchanged', () => {
    const input = {
      enabled: true,
      remaining: null,
      limit: 3,
      locked: false,
      viewerId: 'user-a',
      isAdmin: true,
      isCreator: false,
    };
    const plain = setupEditButtonState(input);
    const own = setupEditButtonState({
      ...input,
      openEdit: { status: 'open', opened_by: 'user-a', opened_by_name: 'Amina' },
    });
    assert.deepEqual(own, plain);
    assert.equal(own.label, 'Edit setup');
    assert.equal(own.disabled, false);
    assert.equal(own.discardConfirm, null);
  });

  test("an admin or the scenario creator can discard someone else's open edit", () => {
    for (const who of [
      { isAdmin: true, isCreator: false, remaining: null as number | null },
      { isAdmin: false, isCreator: true, remaining: 2 as number | null },
    ]) {
      const state = setupEditButtonState({
        enabled: true,
        remaining: who.remaining,
        limit: 3,
        locked: false,
        viewerId: 'viewer',
        isAdmin: who.isAdmin,
        isCreator: who.isCreator,
        openEdit: { status: 'open', opened_by: 'other', opened_by_name: 'Jokoy' },
      });
      assert.equal(state.visible, true);
      assert.equal(state.disabled, false);
      assert.equal(state.label, 'Edit in progress · Jokoy');
      assert.equal(
        state.discardConfirm,
        "Discard Jokoy's unapplied setup edit? Their changes will be lost.",
      );
    }

    const unnamed = setupEditButtonState({
      enabled: true,
      remaining: null,
      limit: 3,
      locked: false,
      viewerId: 'admin',
      isAdmin: true,
      isCreator: false,
      openEdit: { status: 'open', opened_by: 'other', opened_by_name: '  ' },
    });
    assert.equal(unnamed.label, 'Edit in progress · another user');
    assert.equal(
      unnamed.discardConfirm,
      "Discard another user's unapplied setup edit? Their changes will be lost.",
    );
  });

  test("a trainer who does not own the scenario cannot take someone else's open edit", () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: 2,
      limit: 3,
      locked: false,
      viewerId: 'trainer-b',
      isAdmin: false,
      isCreator: false,
      openEdit: { status: 'open', opened_by: 'trainer-a', opened_by_name: 'Jokoy' },
    });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, true);
    assert.equal(state.label, 'Edit in progress · Jokoy');
    assert.equal(state.title, 'Jokoy has a setup edit open');
    assert.equal(state.discardConfirm, null);
  });

  test('an edit that is being applied disables the button for everyone', () => {
    const state = setupEditButtonState({
      enabled: true,
      remaining: null,
      limit: 3,
      locked: false,
      viewerId: 'user-a',
      isAdmin: true,
      isCreator: true,
      openEdit: { status: 'applying', opened_by: 'user-a', opened_by_name: 'Jokoy' },
    });
    assert.equal(state.visible, true);
    assert.equal(state.disabled, true);
    assert.equal(state.title, 'An edit is being applied');
    assert.equal(state.discardConfirm, null);
    assert.equal(state.label, 'Edit setup');
  });
});
