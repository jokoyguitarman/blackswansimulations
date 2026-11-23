import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"][^'"]*scripts\//;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const absolute = path.join(current, name);
      const info = statSync(absolute);
      if (info.isDirectory()) walk(absolute);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) found.push(absolute);
    }
  };
  walk(dir);
  return found;
}

describe('static checks', () => {
  it('server, shared and frontend do not import scripts/', () => {
    const hits: string[] = [];
    for (const folder of ['server', 'shared', 'frontend']) {
      const absolute = path.join(ROOT, folder);
      for (const file of sourceFiles(absolute)) {
        const text = readFileSync(file, 'utf8');
        if (IMPORT_RE.test(text)) hits.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(hits, []);
  });
});
