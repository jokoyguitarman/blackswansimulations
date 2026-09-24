import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summariseAgreement,
  type TrainerAgreementStatus,
} from '../../../shared/trainerAgreements.js';
import { canPerform, statusAfter, statusesAllowing } from './status.js';

const ALL: TrainerAgreementStatus[] = [
  'awaiting_signature',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
];

const allowed = (action: Parameters<typeof canPerform>[0]) =>
  ALL.filter((status) => canPerform(action, status));

describe('agreement transitions', () => {
  test('applicants edit and upload only before review or after changes are requested', () => {
    assert.deepEqual(allowed('edit_details'), ['awaiting_signature', 'changes_requested']);
    assert.deepEqual(allowed('upload'), ['awaiting_signature', 'changes_requested']);
    assert.equal(statusAfter('upload'), 'submitted');
  });

  test('approval and change requests apply only to submitted agreements', () => {
    assert.deepEqual(allowed('approve'), ['submitted']);
    assert.deepEqual(allowed('request_changes'), ['submitted']);
    assert.equal(statusAfter('approve'), 'approved');
    assert.equal(statusAfter('request_changes'), 'changes_requested');
  });

  test('anything still in progress can be rejected, a decision cannot be undone', () => {
    assert.deepEqual(allowed('reject'), ['awaiting_signature', 'submitted', 'changes_requested']);
    assert.equal(statusAfter('reject'), 'rejected');
  });

  test('statusesAllowing returns a copy callers can pass to queries', () => {
    const statuses = statusesAllowing('upload');
    statuses.push('approved');
    assert.deepEqual(statusesAllowing('upload'), ['awaiting_signature', 'changes_requested']);
  });
});

describe('summariseAgreement', () => {
  const row = (
    id: string,
    status: TrainerAgreementStatus,
    reviewed_at: string | null = null,
    created_at = '2026-09-01T00:00:00Z',
  ) => ({ id, status, agreement_version: '2026-09', reviewed_at, created_at });

  test('no rows means no agreement on file', () => {
    assert.equal(summariseAgreement([]).status, 'none');
    assert.equal(summariseAgreement([row('a', 'rejected', '2026-09-02T00:00:00Z')]).status, 'none');
  });

  test('an approved agreement wins over one in progress', () => {
    const summary = summariseAgreement([
      row('old', 'approved', '2026-09-02T00:00:00Z'),
      row('new', 'submitted', null, '2026-09-10T00:00:00Z'),
    ]);
    assert.deepEqual(summary, {
      status: 'signed',
      id: 'old',
      version: '2026-09',
      signed_at: '2026-09-02T00:00:00Z',
    });
  });

  test('uses the latest approval when there are several', () => {
    const summary = summariseAgreement([
      row('first', 'approved', '2026-09-02T00:00:00Z'),
      row('second', 'approved', '2026-09-20T00:00:00Z'),
    ]);
    assert.equal(summary.id, 'second');
  });

  test('maps each in-progress status to its badge', () => {
    assert.equal(summariseAgreement([row('a', 'submitted')]).status, 'under_review');
    assert.equal(summariseAgreement([row('a', 'changes_requested')]).status, 'changes_requested');
    assert.equal(summariseAgreement([row('a', 'awaiting_signature')]).status, 'awaiting_signature');
  });
});
