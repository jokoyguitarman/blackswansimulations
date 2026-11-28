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
});
