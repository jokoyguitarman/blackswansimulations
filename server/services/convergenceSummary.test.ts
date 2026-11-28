import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERGENCE_SUMMARY_MAX_CHARS,
  buildConvergenceStorylineSummary,
} from './convergenceSummary.js';

describe('convergence storyline summary', () => {
  test('40 teams × 30 injects stay within 12,000 characters and name every team', () => {
    const storylines: Record<string, Array<{ trigger_time_minutes: number; title: string }>> = {};
    for (let team = 0; team < 40; team++) {
      const name = `Squad ${String(team).padStart(2, '0')}`;
      storylines[name] = Array.from({ length: 30 }, (_, beat) => ({
        trigger_time_minutes: beat,
        title: `Beat ${beat} ${'detail '.repeat(12)}`.trim(),
      }));
    }
    const summary = buildConvergenceStorylineSummary(storylines);
    assert.ok(summary.length <= CONVERGENCE_SUMMARY_MAX_CHARS);
    assert.equal(CONVERGENCE_SUMMARY_MAX_CHARS, 12_000);
    for (let team = 0; team < 40; team++) {
      assert.ok(summary.includes(`Squad ${String(team).padStart(2, '0')}`));
      assert.ok(summary.includes(`Squad ${String(team).padStart(2, '0')} (30 injects)`));
    }
    const titleCounts = summary.split('\n\n').map((line) => (line.match(/Beat /g) || []).length);
    assert.equal(titleCounts.length, 40);
    assert.ok(Math.max(...titleCounts) - Math.min(...titleCounts) <= 1);
  });
});
