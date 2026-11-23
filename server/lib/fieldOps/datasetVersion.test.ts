import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { datasetVersionOf } from './datasetVersion.js';

describe('datasetVersionOf', () => {
  const row = { material_key: 'tnt', tnt_eq_pressure: 1.5, status: 'active', updated_at: 'today' };

  it('ignores order and bookkeeping columns, and normalises numbers', () => {
    const first = datasetVersionOf('physics', {
      fieldops_explosive_materials: [row, { material_key: 'anfo', tnt_eq_pressure: '1.50' }],
      fieldops_injury_thresholds: [],
      fieldops_device_presets: [],
    });
    const second = datasetVersionOf('physics', {
      fieldops_explosive_materials: [
        { material_key: 'anfo', tnt_eq_pressure: 1.5, review_state: 'reviewed', id: 9 },
        { ...row, created_at: 'x', version: 4 },
      ],
    });
    assert.equal(first, second);
    assert.equal(first.length, 16);
    const changed = datasetVersionOf('physics', {
      fieldops_explosive_materials: [{ ...row, tnt_eq_pressure: 1.6 }],
    });
    assert.notEqual(changed, first);
    const empty = datasetVersionOf('physics', {});
    assert.equal(datasetVersionOf('physics', { fieldops_device_presets: [] }), empty);
  });

  it('sorts row keys by UTF-16 code unit', () => {
    const rows = {
      fieldops_explosive_materials: [
        { material_key: 'a', tnt_eq_pressure: 1 },
        { material_key: 'A', tnt_eq_pressure: 1 },
      ],
    };
    const forward = datasetVersionOf('physics', rows);
    const reverse = datasetVersionOf('physics', {
      fieldops_explosive_materials: [...rows.fieldops_explosive_materials].reverse(),
    });
    assert.equal(forward, reverse);
    // 'A' then 'a'. en-US localeCompare puts 'a' first and hashes to 6fa0ebbfbf0a188b.
    assert.equal(forward, 'c7625fc6e8ab91fd');
    assert.notEqual(forward, '6fa0ebbfbf0a188b');
  });
});
