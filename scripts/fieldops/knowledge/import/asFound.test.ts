import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { countByKind, loadSeeds } from './classify.js';
import type { Manifest } from './manifest.js';

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
    if (!dir) return;
    const expected = JSON.parse(
      readFileSync(path.join(FIXTURES, 'expected-counts.json'), 'utf8'),
    ) as Record<string, ExpectedFile>;
    const receivedPath = path.join(dir, 'manifest.received.json');
    if (!existsSync(receivedPath)) {
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
      return;
    }
    const received = JSON.parse(readFileSync(receivedPath, 'utf8')) as Manifest;
    for (const [key, want] of Object.entries(expected)) {
      const file = received.files.find((item) => item.path === `_incoming/${key}`);
      assert.ok(file, key);
      assert.equal(file.sha256, want.sha256, key);
      assert.equal(file.bytes, want.bytes, key);
      assert.deepEqual(file.records, want.records, key);
    }
    const loaded = loadSeeds(dir);
    assert.deepEqual(loaded.errors, []);
    const approved = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    for (const file of loaded.files) {
      const listed = approved.files.find((item) => item.path === file.entry.path);
      assert.ok(listed, file.entry.path);
      assert.equal(listed.sha256, file.sha256, file.entry.path);
      assert.deepEqual(listed.records, countByKind(file.records), file.entry.path);
    }
    const explosive = loaded.files.find((file) =>
      file.entry.path.endsWith('explosive-materials.pending.json'),
    );
    assert.equal(countByKind(explosive?.records ?? []).table_row, 13);
    const planning = loaded.files.find(
      (file) => file.entry.path === 'planning/spread-materials.planning.json',
    );
    assert.equal(planning?.records.length, 29);
  });
});
