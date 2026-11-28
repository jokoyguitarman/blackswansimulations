import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modeSwitchEffect,
  modeWithinCeiling,
  needsTrainerApproval,
  resolveDirectorMode,
} from './directorModes.js';

const auto = { enabled: true, modeMax: 'auto' as const, defaultMode: 'auto' as const };

test('with no settings the mode is auto', () => {
  assert.equal(resolveDirectorMode(auto, null, null), 'auto');
  assert.equal(resolveDirectorMode(auto, { mode: null }, { mode: null }), 'auto');
});

test('the session override beats the scenario, and the ops ceiling caps both', () => {
  assert.equal(
    resolveDirectorMode(auto, { mode: 'suggest' }, { mode: 'off' }),
    'suggest',
  );
  assert.equal(
    resolveDirectorMode(
      { enabled: true, modeMax: 'suggest', defaultMode: 'auto' },
      null,
      { mode: 'auto' },
    ),
    'suggest',
  );
  assert.equal(
    resolveDirectorMode({ enabled: true, modeMax: 'off', defaultMode: 'auto' }, { mode: 'auto' }, null),
    'off',
  );
  assert.equal(resolveDirectorMode({ ...auto, enabled: false }, { mode: 'auto' }, null), 'off');
  assert.equal(modeWithinCeiling('auto', 'suggest'), false);
  assert.equal(modeWithinCeiling('off', 'suggest'), true);
});

test('high inside auto needs approval, and mode switches convert or expire', () => {
  assert.equal(needsTrainerApproval('auto', 'medium', 'medium'), false);
  assert.equal(needsTrainerApproval('auto', 'high', 'medium'), true);
  assert.equal(needsTrainerApproval('suggest', 'low', 'medium'), true);
  assert.equal(modeSwitchEffect('auto', 'suggest'), 'convert_countdowns');
  assert.equal(modeSwitchEffect('auto', 'off'), 'expire_pending');
  assert.equal(modeSwitchEffect('suggest', 'off'), 'expire_pending');
  assert.equal(modeSwitchEffect('suggest', 'auto'), 'none');
});
