import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBlueprint, coerceBlueprint, hasUsableStructure } from './blueprintTypes.js';
import { scoreCoverage } from './blueprintMerge.js';
import {
  BLUEPRINT_HONOR_THRESHOLD,
  BLUEPRINT_MIN_STRUCTURE_CONFIDENCE,
} from './blueprintConfig.js';

describe('blueprint schema', () => {
  test('emptyBlueprint is valid and inert', () => {
    const bp = emptyBlueprint();
    assert.deepEqual(bp.factions, []);
    assert.deepEqual(bp.unmapped_directives, []);
    assert.equal(bp.structure_confidence, 0);
    assert.deepEqual(bp.coverage, {});
  });

  test('coerceBlueprint never throws on garbage input', () => {
    assert.doesNotThrow(() => coerceBlueprint(null));
    assert.doesNotThrow(() => coerceBlueprint('not an object'));
    assert.doesNotThrow(() => coerceBlueprint(42));
    assert.deepEqual(coerceBlueprint(undefined), emptyBlueprint());
  });

  test('coerceBlueprint fills defaults for partial factions (open alignment vocab)', () => {
    const bp = coerceBlueprint({
      factions: [{ id: 'competitor_brands', name: 'Competitors', alignment: 'opportunist' }],
    });
    assert.equal(bp.factions[0].alignment, 'opportunist'); // open vocab, not enum-restricted
    assert.deepEqual(bp.factions[0].emotional_drivers, []);
    assert.equal(bp.factions[0].confidence, 0);
  });

  test('hasUsableStructure respects the floor threshold', () => {
    assert.equal(hasUsableStructure(emptyBlueprint(), BLUEPRINT_MIN_STRUCTURE_CONFIDENCE), false);
    const strong = coerceBlueprint({ structure_confidence: 0.9 });
    assert.equal(hasUsableStructure(strong, BLUEPRINT_MIN_STRUCTURE_CONFIDENCE), true);
  });
});

describe('no-regression: empty-document path falls back', () => {
  test('an empty blueprint never triggers the faction honor path', () => {
    // generateNPCsAndFactSheet only honors factions when coverage >= threshold.
    // The no-document path yields an empty blueprint, so coverage.factions must
    // stay below the threshold -> the original fixed-archetype generation runs.
    const cov = scoreCoverage(emptyBlueprint());
    assert.ok(cov.factions < BLUEPRINT_HONOR_THRESHOLD);
  });
});
