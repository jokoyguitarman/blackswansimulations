import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkText,
  unionStrings,
  mergeBlueprints,
  scoreCoverage,
  scoreStructure,
} from './blueprintMerge.js';
import { coerceBlueprint, emptyBlueprint } from './blueprintTypes.js';

describe('chunkText', () => {
  test('returns [] for empty / whitespace', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n  '), []);
  });

  test('returns a single chunk when shorter than size', () => {
    assert.deepEqual(chunkText('hello world', 6000, 400), ['hello world']);
  });

  test('hard-splits a single oversized block with no boundaries', () => {
    const text = 'x'.repeat(5000) + 'END_MARKER';
    const chunks = chunkText(text, 2000, 200);
    assert.ok(chunks.length > 1, 'expected multiple chunks');
    assert.equal(chunks[0].length, 2000);
    assert.ok(chunks[chunks.length - 1].endsWith('END_MARKER'), 'last chunk must reach end');
  });

  test('keeps a typical document in a single chunk (no truncation)', () => {
    assert.equal(chunkText('y'.repeat(20000)).length, 1); // default size 25000
  });

  test('section-aware: splits at paragraph boundaries, never mid-section', () => {
    const a = 'FACTION ALPHA: ' + 'a'.repeat(30);
    const b = 'FACTION BRAVO: ' + 'b'.repeat(30);
    const c = 'FACTION CHARLIE: ' + 'c'.repeat(30);
    const chunks = chunkText([a, b, c].join('\n\n'), 60, 10);
    assert.ok(chunks.length > 1, 'expected multiple chunks');
    // Each whole section appears intact in some chunk (no mid-section cut).
    for (const section of [a, b, c]) {
      assert.ok(
        chunks.some((ch) => ch.includes(section)),
        `section not intact: ${section}`,
      );
    }
  });
});

describe('unionStrings', () => {
  test('dedupes case-insensitively and drops empties, keeping first casing', () => {
    assert.deepEqual(unionStrings(['Anger', 'anger', '  '], ['ANGER', 'Fear']), ['Anger', 'Fear']);
  });
});

describe('mergeBlueprints', () => {
  test('returns an empty blueprint for no parts', () => {
    assert.deepEqual(mergeBlueprints([]), emptyBlueprint());
  });

  test('merges factions by id and unions their arrays', () => {
    const a = coerceBlueprint({
      factions: [
        {
          id: 'far_right',
          name: 'Far Right',
          alignment: 'hostile',
          escalation_triggers: ['rumours'],
          confidence: 0.7,
        },
      ],
    });
    const b = coerceBlueprint({
      factions: [
        { id: 'far_right', escalation_triggers: ['inflammatory language'], confidence: 0.9 },
      ],
    });
    const merged = mergeBlueprints([a, b]);
    assert.equal(merged.factions.length, 1);
    assert.deepEqual(merged.factions[0].escalation_triggers, ['rumours', 'inflammatory language']);
    assert.equal(merged.factions[0].confidence, 0.9);
    assert.equal(merged.factions[0].name, 'Far Right');
  });

  test('dedupes timeline by stage (first casing wins) and sorts by order', () => {
    const a = coerceBlueprint({ timeline: [{ stage: 'Breaking News', order: 1 }] });
    const b = coerceBlueprint({
      timeline: [
        { stage: 'breaking news', order: 1 }, // duplicate of a, dropped
        { stage: 'Rumour Surge', order: 2 },
      ],
    });
    const merged = mergeBlueprints([a, b]);
    assert.deepEqual(
      merged.timeline.map((t) => t.stage),
      ['Breaking News', 'Rumour Surge'],
    );
  });

  test('unions narrative_mutations across chunks', () => {
    const a = coerceBlueprint({ narrative_mutations: ['fake screenshots'] });
    const b = coerceBlueprint({ narrative_mutations: ['Fake Screenshots', 'cover-up claims'] });
    assert.deepEqual(mergeBlueprints([a, b]).narrative_mutations, [
      'fake screenshots',
      'cover-up claims',
    ]);
  });
});

describe('scoreCoverage / scoreStructure', () => {
  test('empty blueprint scores zero everywhere', () => {
    const cov = scoreCoverage(emptyBlueprint());
    assert.equal(cov.factions, 0);
    assert.equal(cov.timeline, 0);
    assert.equal(scoreStructure(emptyBlueprint()), 0);
  });

  test('populated blueprint scores higher structure confidence', () => {
    const bp = coerceBlueprint({
      premise: { crisis_type: 'product recall', confidence: 0.9 },
      factions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      timeline: [
        { stage: 's1', order: 1 },
        { stage: 's2', order: 2 },
      ],
    });
    assert.equal(scoreCoverage(bp).premise, 1);
    assert.equal(scoreCoverage(bp).factions, 1);
    assert.ok(scoreStructure(bp) > 0.6);
  });
});
