import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stageForElapsed, shouldDirectorAct, hostileFactions } from './directorLogic.js';
import { coerceBlueprint } from './blueprintTypes.js';

const timeline = [
  { stage: 'Breaking News', description: '', order: 1 },
  { stage: 'Rumour Surge', description: '', order: 2 },
  { stage: 'Backlash', description: '', order: 3 },
  { stage: 'Stabilisation', description: '', order: 4 },
];

describe('stageForElapsed', () => {
  test('returns null for empty timeline', () => {
    assert.equal(stageForElapsed([], 30, 60), null);
  });
  test('maps start / middle / end to the right stages', () => {
    assert.equal(stageForElapsed(timeline, 0, 60)?.stage, 'Breaking News');
    assert.equal(stageForElapsed(timeline, 30, 60)?.stage, 'Backlash'); // ratio .5 -> idx 2
    assert.equal(stageForElapsed(timeline, 59, 60)?.stage, 'Stabilisation');
  });
  test('clamps past-duration elapsed to the last stage', () => {
    assert.equal(stageForElapsed(timeline, 999, 60)?.stage, 'Stabilisation');
  });
  test('sorts by order regardless of input order', () => {
    const shuffled = [timeline[3], timeline[0], timeline[2], timeline[1]];
    assert.equal(stageForElapsed(shuffled, 0, 60)?.stage, 'Breaking News');
  });
});

describe('shouldDirectorAct', () => {
  const base = {
    enabled: true,
    isSocialSession: true,
    hasUsableBlueprint: true,
    elapsedMinutes: 30,
    minutesSinceLastAction: null as number | null,
    escalationRisk: 20, // gap = 9
  };
  test('acts when enabled, social, usable, breathed, never acted', () => {
    assert.equal(shouldDirectorAct(base), true);
  });
  test('skips when disabled / non-social / no blueprint', () => {
    assert.equal(shouldDirectorAct({ ...base, enabled: false }), false);
    assert.equal(shouldDirectorAct({ ...base, isSocialSession: false }), false);
    assert.equal(shouldDirectorAct({ ...base, hasUsableBlueprint: false }), false);
  });
  test('lets the crisis breathe first', () => {
    assert.equal(shouldDirectorAct({ ...base, elapsedMinutes: 1 }), false);
  });
  test('respects the cadence gap (tightens with escalation)', () => {
    assert.equal(shouldDirectorAct({ ...base, minutesSinceLastAction: 5 }), false); // < 9
    assert.equal(shouldDirectorAct({ ...base, minutesSinceLastAction: 9 }), true); // == 9
    // high escalation shrinks the gap to 3
    assert.equal(
      shouldDirectorAct({ ...base, escalationRisk: 70, minutesSinceLastAction: 4 }),
      true,
    );
  });
});

describe('hostileFactions', () => {
  test('filters to agitator-aligned factions only', () => {
    const bp = coerceBlueprint({
      factions: [
        { id: 'far_right', alignment: 'hostile' },
        { id: 'residents', alignment: 'defender' },
        { id: 'competitor', alignment: 'opportunist' },
      ],
    });
    assert.deepEqual(
      hostileFactions(bp).map((f) => f.id),
      ['far_right', 'competitor'],
    );
  });
});
