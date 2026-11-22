import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadSeeds } from './classify.js';
import { applyBulkReview } from './reviewEdit.js';
import {
  fileReleased,
  forceRoleSatisfied,
  normaliseReview,
  ownerApprovalSatisfies,
} from './review.js';
import type { NormalisedReview, RegistryEntry } from './types.js';

const r1: RegistryEntry = {
  path: '_incoming/physics-movement/spread-materials.pending.json',
  format: 'table_rows_v0',
  library: 'spread',
  targetTable: 'fieldops_spread_materials',
};
const r2: RegistryEntry = {
  path: '_incoming/building-hazards/building-types.json',
  format: 'table_rows_v0',
  library: 'building_hazards',
  targetTable: 'fieldops_building_types',
};
const r3: RegistryEntry = {
  path: '_incoming/doctrines/sg/sg_spf.police_security.json',
  format: 'doctrine_seed_v1',
  library: 'doctrines',
  targetTable: 'doctrines',
};

function ownerReview(over: Partial<NormalisedReview> = {}): NormalisedReview {
  return {
    state: 'approved',
    reviewerName: 'Jokoy Tabbada',
    reviewerQualification: 'country',
    decidedOn: '2026-11-22',
    notes: null,
    reviewerRole: 'country',
    history: [],
    requiredRoles: [],
    stored: {},
    ...over,
  };
}

describe('review normalisation', () => {
  it('keeps every row pending while the header is unreleased', () => {
    const document = {
      review_status: 'pending',
      rows: [],
    };
    const row = {
      review: {
        decision: 'approved',
        reviewer_name: 'A',
        reviewer_qualification: 'B',
        decided_on: '2026-11-22',
      },
    };
    assert.equal(fileReleased(document, r1), false);
    assert.equal(normaliseReview(document, r1, 'k', row).state, 'pending');
  });

  it('applies the section 9.2 table for a released R1 file', () => {
    const document = { review_status: 'reviewed' };
    assert.equal(
      normaliseReview(document, r1, 'k', { review: { decision: null } }).state,
      'pending',
    );
    const approved = {
      review: {
        decision: 'approved',
        reviewer_name: 'Ada',
        reviewer_qualification: 'owner',
        decided_on: '2026-11-22',
      },
    };
    assert.equal(normaliseReview(document, r1, 'k', approved).state, 'approved');
    const amendedBare = {
      review: {
        decision: 'amended',
        reviewer_name: 'Ada',
        reviewer_qualification: 'owner',
        decided_on: '2026-11-22',
      },
    };
    assert.equal(normaliseReview(document, r1, 'k', amendedBare).state, 'pending');
    const amended = {
      review: {
        decision: 'amended',
        reviewer_name: 'Ada',
        reviewer_qualification: 'owner',
        decided_on: '2026-11-22',
        notes: 'threshold',
      },
    };
    assert.equal(normaliseReview(document, r1, 'k', amended).state, 'amended');
    const rejected = { review: { decision: 'rejected' } };
    assert.equal(normaliseReview(document, r1, 'k', rejected).state, 'rejected');
    const incomplete = { review: { decision: 'approved', reviewer_name: 'Ada' } };
    assert.equal(normaliseReview(document, r1, 'k', incomplete).state, 'pending');
  });

  it('reads R2 row decisions from the file review', () => {
    const document = {
      review_status: 'reviewed',
      review: {
        reviewer_name: 'Ada',
        reviewer_qualification: 'owner',
        reviewed_on: '2026-11-22',
        row_decisions: { mall: { decision: 'approved', notes: 'ok' } },
      },
    };
    assert.equal(normaliseReview(document, r2, 'mall', {}).state, 'approved');
    assert.equal(normaliseReview(document, r2, 'other', {}).state, 'pending');
  });

  it('maps an R3 approved_for_import review to approved', () => {
    const document = {
      review: {
        status: 'approved_for_import',
        reviewer: 'Jokoy Tabbada',
        reviewer_role: 'country',
        reviewed_at: '2026-11-22',
        notes: 'Owner approval.',
        required_reviewer_roles: ['country', 'legal or police_service'],
      },
    };
    const review = normaliseReview(document, r3, 'sg_spf.police_security', document);
    assert.equal(review.state, 'approved');
    assert.equal(review.reviewerRole, 'country');
  });

  it('lets owner approval stand in for free-text roles except use of force', () => {
    const review = ownerReview();
    assert.equal(ownerApprovalSatisfies(review, 'country'), true);
    assert.equal(ownerApprovalSatisfies(review, 'aviation rescue and firefighting'), true);
    assert.equal(ownerApprovalSatisfies(review, 'legal or police_service'), false);
    assert.equal(forceRoleSatisfied(review, 'legal or police_service'), false);
    const withHistory = ownerReview({
      history: [{ reviewer_role: 'police_service', decision: 'approved_for_import' }],
    });
    assert.equal(ownerApprovalSatisfies(withHistory, 'legal or police_service'), true);
  });

  it('responder files stay unreleased while seed_status is PENDING', () => {
    const entry: RegistryEntry = {
      path: '_incoming/responder-units/unit-kinds.json',
      format: 'table_rows_v0',
      library: 'units',
      targetTable: 'fieldops_unit_kinds',
    };
    assert.equal(fileReleased({ review_status: 'reviewed', seed_status: 'PENDING' }, entry), false);
    assert.equal(fileReleased({ review_status: 'reviewed', seed_status: 'REVIEWED' }, entry), true);
  });
});

describe('review --bulk', () => {
  it('writes a decision once and skips a record that already has one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'knowledge-review-'));
    const relative = '_incoming/blast-effects/explosive-materials.pending.json';
    const source = path.join(import.meta.dirname, '__fixtures__/issues', relative);
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.parse(readFileSync(source, 'utf8')) as {
      rows: Array<Record<string, unknown>>;
    };
    const anfo = original.rows.find((row) => row.material_key === 'anfo');
    assert.ok(anfo);
    anfo.review = { decision: 'rejected', notes: 'kept' };
    writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`);

    const input = {
      decision: 'approved' as const,
      reviewer: 'Jokoy Tabbada',
      qualification:
        'Project owner (Prophyion); reviewed and approved all knowledge research seed files',
      date: '2026-11-22',
      notes: 'Owner approval of 22 Nov 2026.',
    };
    applyBulkReview(dir, input, ['blast-effects']);
    applyBulkReview(dir, input, ['blast-effects']);
    const after = JSON.parse(readFileSync(target, 'utf8')) as {
      review_status: string;
      rows: Array<{
        material_key: string;
        review: { decision: string; notes: string; reviewer_name: string };
      }>;
    };
    assert.equal(after.review_status, 'reviewed');
    const kept = after.rows.find((row) => row.material_key === 'anfo');
    const filled = after.rows.find((row) => row.material_key === 'smokeless_powder');
    assert.equal(kept?.review.decision, 'rejected');
    assert.equal(kept?.review.notes, 'kept');
    assert.equal(filled?.review.decision, 'approved');
    assert.equal(filled?.review.reviewer_name, 'Jokoy Tabbada');
    assert.equal(readFileSync(target, 'utf8').endsWith('\n'), true);

    const loaded = loadSeeds(dir, { folders: ['blast-effects'] });
    assert.deepEqual(loaded.errors, []);
    const states = Object.fromEntries(
      loaded.files[0]?.records.map((record) => [record.recordKey, record.review.state]) ?? [],
    );
    assert.equal(states.anfo, 'rejected');
    assert.equal(states.smokeless_powder, 'approved');
  });
});
