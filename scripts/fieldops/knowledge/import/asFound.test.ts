import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { countByKind, loadSeeds } from './classify.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__');

interface ExpectedFile {
  sha256: string;
  bytes: number;
  records: Record<string, number>;
}

describe('as-found schemas', () => {
  it('parses the committed mini fixture and counts its records', () => {
    const loaded = loadSeeds(path.join(FIXTURES, 'mini'));
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.files.length, 1);
    const file = loaded.files[0];
    assert.ok(file);
    assert.equal(file.entry.format, 'reference_rows_v0');
    assert.deepEqual(countByKind(file.records), { reference: 1 });
    assert.equal(file.records[0]?.recordKey, 'fixture_ref');
  });

  it('matches Appendix A when KNOWLEDGE_SEEDS_DIR is set', () => {
    const dir = process.env.KNOWLEDGE_SEEDS_DIR;
    if (!dir) {
      return;
    }
    const expected = JSON.parse(
      readFileSync(path.join(FIXTURES, 'expected-counts.json'), 'utf8'),
    ) as Record<string, ExpectedFile>;
    const loaded = loadSeeds(dir);
    assert.deepEqual(loaded.errors, []);
    const byPath = new Map(
      loaded.files.map((file) => [file.entry.path.replace(/^_incoming\//, ''), file]),
    );
    const missing = Object.keys(expected).filter((key) => !byPath.has(key));
    assert.deepEqual(missing, []);
    for (const [key, want] of Object.entries(expected)) {
      const file = byPath.get(key);
      assert.ok(file, key);
      assert.equal(file.sha256, want.sha256, key);
      assert.equal(file.bytes.length, want.bytes, key);
      assert.deepEqual(countByKind(file.records), want.records, key);
    }
  });
});
