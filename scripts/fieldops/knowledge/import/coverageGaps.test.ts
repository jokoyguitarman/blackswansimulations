import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dedupeCoverageGaps, type CoverageGap } from './stage.js';

function gap(subject: string, note: string, sourcesChecked: number): CoverageGap {
  return {
    library: 'movement',
    country: null,
    subject,
    note,
    sourcesChecked,
    runId: 'run',
  };
}

describe('dedupeCoverageGaps', () => {
  it('keeps the research note when a missing-key gap repeats the subject', () => {
    const kept = dedupeCoverageGaps([
      gap('crouch_speed_factor', 'No crouch/stoop ratio located', 1),
      gap('smoke_speed_floor_factor', 'Sources give absolute regressions', 1),
      gap('crouch_speed_factor', 'missing movement parameter', 0),
      gap('smoke_speed_floor_factor', 'missing movement parameter', 0),
      gap('crush_density', 'missing movement parameter', 0),
      gap('tenable_temp_head_c (60 C)', 'ISO gives time-to-incapacitation', 1),
      gap('tenable_temp_head_c', 'missing movement parameter', 0),
    ]);
    assert.deepEqual(
      kept.map((item) => [item.subject, item.note, item.sourcesChecked]),
      [
        ['crouch_speed_factor', 'No crouch/stoop ratio located', 1],
        ['smoke_speed_floor_factor', 'Sources give absolute regressions', 1],
        ['crush_density', 'missing movement parameter', 0],
        ['tenable_temp_head_c (60 C)', 'ISO gives time-to-incapacitation', 1],
        ['tenable_temp_head_c', 'missing movement parameter', 0],
      ],
    );
  });
});
