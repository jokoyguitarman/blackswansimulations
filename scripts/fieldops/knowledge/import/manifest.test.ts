import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildManifest, manifestDifferences, readManifest } from './manifest.js';

const MINI = path.join(import.meta.dirname, '__fixtures__', 'mini');
const CLI = path.join(import.meta.dirname, 'cli.ts');

describe('manifest', () => {
  it('passes on an unchanged copy and fails after one byte changes', () => {
    const dir = path.join(tmpdir(), `knowledge-manifest-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    cpSync(MINI, dir, { recursive: true });
    const written = buildManifest(dir, '2026-11-22');
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(written, null, 2)}\n`);
    execFileSync('npx', ['tsx', CLI, 'manifest', '--check', '--dir', dir], { stdio: 'pipe' });
    assert.deepEqual(manifestDifferences(readManifest(dir), buildManifest(dir, '2026-11-23')), []);

    const filePath = path.join(dir, '_incoming/blast-effects/human-vulnerability.pending.json');
    const text = readFileSync(filePath, 'utf8').replace('fixture_ref', 'fixture_rex');
    writeFileSync(filePath, text);
    assert.throws(
      () =>
        execFileSync('npx', ['tsx', CLI, 'manifest', '--check', '--dir', dir], { stdio: 'pipe' }),
      (error: unknown) => {
        const failed = error as { status?: number };
        return failed.status === 1;
      },
    );
  });
});
