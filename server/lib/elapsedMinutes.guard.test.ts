import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Inline `Date.now() - start_time` minute math. Deliberately not this pattern,
 * and left alone:
 * - demoAIAgentService: an in-memory agent clock (`session.startedAt`), fractional.
 * - callService.sessionMinuteFrom: an event timestamp, already floor-clamped.
 * - peopleDeteriorationService: minutes since a casualty appeared, or a critical-care clock.
 * - exitFlowService / pinResolutionService: age of an `updated_at`, not the session clock.
 * - analyticsService / intelSharingService / teamScoreService: a row's created_at minus start.
 * - aarSocialSectionService: session end minus start, for the report duration.
 */
const INLINE_ELAPSED = /(?:Date\.now\(\)|new Date\(\)\.getTime\(\))\s*-\s*(?:new Date\([^)\n]{0,160}?(?:start_time|startTime)|startTime\b|startMs\b|sessionStartMs\b)/g;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

describe('elapsed minute guard', () => {
  test('session start elapsed math lives only in sessionPhase.ts', () => {
    const failures: string[] = [];
    for (const path of walk(SERVER_ROOT)) {
      const rel = `server/${relative(SERVER_ROOT, path)}`;
      if (rel === 'server/lib/sessionPhase.ts') continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(INLINE_ELAPSED)) {
        const index = match.index ?? 0;
        const line = source.slice(0, index).split('\n').length;
        failures.push(`${rel}:${line}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
