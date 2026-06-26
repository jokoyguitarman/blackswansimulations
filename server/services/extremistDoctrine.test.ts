import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCell, resolveFrame, EXTREMIST_CELL } from './extremistDoctrine.js';
import { coerceBlueprint, emptyBlueprint } from './blueprint/blueprintTypes.js';

describe('resolveCell (blueprint-gated, fallback to fixed cell)', () => {
  test('no blueprint -> the existing fixed 6-bot cell (no regression)', () => {
    assert.deepEqual(resolveCell(null), EXTREMIST_CELL);
    assert.deepEqual(resolveCell(emptyBlueprint()), EXTREMIST_CELL);
  });

  test('blueprint hostile factions -> faction-derived personas', () => {
    const bp = coerceBlueprint({
      factions: [
        { id: 'far_right', name: 'Far Right', alignment: 'hostile', tone_guidance: 'paraphrase' },
        { id: 'jihadist', name: 'Jihadist exploiters', alignment: 'hostile' },
        { id: 'residents', name: 'Residents', alignment: 'defender' }, // ignored (not hostile)
      ],
    });
    const cell = resolveCell(bp);
    assert.equal(cell.length, 2);
    assert.ok(cell.some((p) => p.handle.includes('far_right')));
    assert.ok(cell.some((p) => p.handle.includes('jihadist')));
  });

  test('headcount_hint expands a faction to up to 2 personas', () => {
    const bp = coerceBlueprint({
      factions: [{ id: 'far_right', name: 'Far Right', alignment: 'hostile', headcount_hint: 2 }],
    });
    assert.equal(resolveCell(bp).length, 2);
  });
});

describe('resolveFrame (blueprint wedge, else built-in)', () => {
  test('no blueprint -> a built-in grievance frame with a non-empty wedge', () => {
    const frame = resolveFrame('a product recall cover-up scandal', 'sess-1', null);
    assert.ok(frame.wedge.length > 0);
  });

  test('blueprint hostile faction -> wedge derived from its narratives', () => {
    const bp = coerceBlueprint({
      factions: [
        {
          id: 'far_right',
          name: 'Far Right',
          alignment: 'hostile',
          typical_narratives: ['the incident proves an elite conspiracy'],
        },
      ],
    });
    const frame = resolveFrame('terror attack', 'sess-2', bp);
    assert.match(frame.wedge, /elite conspiracy/);
  });
});
