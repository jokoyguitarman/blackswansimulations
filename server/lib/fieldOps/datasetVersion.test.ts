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
});
