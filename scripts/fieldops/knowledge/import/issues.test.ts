import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadSeeds } from './classify.js';
import { annotateIssues } from './issues.js';
import type { ClassifiedRecord } from './types.js';

const DIR = path.join(import.meta.dirname, '__fixtures__', 'issues');

function codes(record: ClassifiedRecord | undefined): string[] {
  return (record?.issues ?? []).map((issue) => issue.code);
}

function find(records: ClassifiedRecord[], key: string): ClassifiedRecord | undefined {
  return records.find((record) => record.recordKey === key);
}

describe('issue codes', () => {
  const loaded = loadSeeds(DIR);
  annotateIssues(loaded.files);
  const records = loaded.files.flatMap((file) => file.records);

  it('parses the real-row fixtures', () => {
    assert.deepEqual(loaded.errors, []);
  });

  it('flags D1 on smokeless powder and not on anfo', () => {
    assert.ok(codes(find(records, 'smokeless_powder')).includes('null_not_null:tnt_eq_pressure'));
    assert.equal(codes(find(records, 'anfo')).includes('null_not_null:tnt_eq_pressure'), false);
  });

  it('flags D6 on an unaccessed source and not on an accessed one', () => {
    const nfpa = records.find(
      (record) => record.recordKind === 'source' && record.recordKey === 'nfpa-855',
    );
    const accessed = records.find(
      (record) =>
        record.recordKind === 'source' && record.recordKey === 'scdf-fire-code-2023-cl10-3',
    );
    assert.ok(codes(nfpa).includes('source_not_accessed'));
    assert.equal(codes(accessed).includes('source_not_accessed'), false);
  });

  it('flags D7 and D8 on the building rows and not on a clean sibling', () => {
    assert.ok(codes(find(records, 'aerosol_stock')).includes('no_located_source'));
    assert.ok(codes(find(records, 'pool_chemical_mix')).includes('threshold_scale_mismatch'));
    assert.equal(
      codes(find(records, 'lpg_bank_blast_rupture')).includes('threshold_scale_mismatch'),
      false,
    );
  });

  it('flags D10 only while two live records disagree', () => {
    const both = records.filter((record) => record.recordKey === 'chlorine');
    assert.equal(both.length, 2);
    assert.ok(both.every((record) => codes(record).includes('conflicting_approved_records')));
    const physics = loaded.files.filter((file) =>
      file.entry.path.includes('physics-movement/release-agents'),
    );
    for (const file of physics) for (const record of file.records) record.issues = [];
    annotateIssues(physics);
    assert.equal(codes(physics[0]?.records[0]).includes('conflicting_approved_records'), false);
  });

  it('flags D12, D15, D19, D20, D21 and D22 on the real rows', () => {
    assert.ok(codes(find(records, 'sg_airport_rffs_response')).includes('site_bound_expected'));
    assert.equal(
      codes(find(records, 'sg_fire_rescue_response')).includes('site_bound_expected'),
      false,
    );
    assert.ok(codes(find(records, 'sg_hosp_wh')).includes('beds_unknown'));
    assert.equal(codes(find(records, 'sg_hosp_sgh')).includes('beds_unknown'), false);
    const partial = records.find(
      (record) => record.recordKind === 'source' && codes(record).includes('published_partial'),
    );
    const full = records.find(
      (record) =>
        record.recordKind === 'source' &&
        record.recordKey !== 'en_1991_1_2_2002' &&
        record.recordKey !== 'ustc_running_2020' &&
        !codes(record).includes('published_partial') &&
        !codes(record).includes('source_not_accessed'),
    );
    assert.ok(partial);
    assert.ok(full);
    assert.ok(codes(find(records, 'ustc_running_2020')).includes('url_not_https'));
    const variants = records.filter((record) => record.recordKey === 'en_1991_1_2_2002');
    assert.equal(variants.length, 2);
    assert.ok(variants.every((record) => codes(record).includes('source_key_variant')));
    assert.ok(
      codes(find(records, 'kb_surface_time_of_arrival_ms_per_kg13')).includes('locator_too_long'),
    );
    assert.equal(codes(find(records, 'clean_short_locator')).includes('locator_too_long'), false);
  });
});
