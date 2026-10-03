import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractRequired,
  hasDraftCopy,
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
  test('applicants edit, upload and submit only before review or after changes are requested', () => {
    assert.deepEqual(allowed('edit_details'), ['awaiting_signature', 'changes_requested']);
    assert.deepEqual(allowed('upload'), ['awaiting_signature', 'changes_requested']);
    assert.deepEqual(allowed('submit'), ['awaiting_signature', 'changes_requested']);
  });

  test('only submitting sends the application; uploading a signed copy does not', () => {
    assert.equal(statusAfter('submit'), 'submitted');
    // `upload` is not a status-changing action, so asking for its result must not type-check.
    // @ts-expect-error uploading only saves the signed copy
    assert.equal(statusAfter('upload'), undefined);
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

describe('hasDraftCopy', () => {
  test('a copy uploaded before anything was submitted is a draft', () => {
    assert.equal(
      hasDraftCopy({ signed_file_uploaded_at: '2026-10-03T03:00:00Z', submitted_at: null }),
      true,
    );
  });

  test('no copy means no draft', () => {
    assert.equal(hasDraftCopy({ signed_file_uploaded_at: null, submitted_at: null }), false);
    assert.equal(
      hasDraftCopy({ signed_file_uploaded_at: null, submitted_at: '2026-10-01T00:00:00Z' }),
      false,
    );
  });

  test('a copy that was submitted is no longer a draft', () => {
    assert.equal(
      hasDraftCopy({
        signed_file_uploaded_at: '2026-10-03T03:00:00Z',
        submitted_at: '2026-10-03T03:00:05Z',
      }),
      false,
    );
    // Uploaded and submitted in the same instant (how copies were saved before drafts existed).
    assert.equal(
      hasDraftCopy({
        signed_file_uploaded_at: '2026-10-03T03:00:00Z',
        submitted_at: '2026-10-03T03:00:00Z',
      }),
      false,
    );
  });

  test('after changes are requested, only a copy uploaded since then is a draft', () => {
    const submitted = '2026-10-01T00:00:00Z';
    assert.equal(
      hasDraftCopy({ signed_file_uploaded_at: submitted, submitted_at: submitted }),
      false,
    );
    assert.equal(
      hasDraftCopy({ signed_file_uploaded_at: '2026-10-02T00:00:00Z', submitted_at: submitted }),
      true,
    );
  });

  test('compares times, not strings, so different Postgres and ISO formats agree', () => {
    assert.equal(
      hasDraftCopy({
        signed_file_uploaded_at: '2026-10-03T03:00:00.250000+00:00',
        submitted_at: '2026-10-03T03:00:00.100Z',
      }),
      true,
    );
  });
});

describe('contractRequired', () => {
  const applicant = {
    role: 'participant',
    signedUpAsConsultant: true,
    enrolledFromConsole: false,
    statuses: [] as TrainerAgreementStatus[],
  };

  test('holds a consultant sign-up until they have submitted, at every step before that', () => {
    assert.equal(contractRequired(applicant), true);
    assert.equal(contractRequired({ ...applicant, statuses: ['awaiting_signature'] }), true);
    assert.equal(contractRequired({ ...applicant, statuses: ['changes_requested'] }), true);
  });

  test('lets them in once the application is submitted', () => {
    assert.equal(contractRequired({ ...applicant, statuses: ['submitted'] }), false);
    assert.equal(contractRequired({ ...applicant, statuses: ['approved'] }), false);
  });

  test('does not hold someone whose application was rejected', () => {
    assert.equal(contractRequired({ ...applicant, statuses: ['rejected'] }), false);
  });

  test('never holds an ordinary participant', () => {
    assert.equal(contractRequired({ ...applicant, signedUpAsConsultant: false }), false);
  });

  test('holds a trainer enrolled from the console until they have submitted', () => {
    const enrolled = {
      ...applicant,
      role: 'trainer',
      signedUpAsConsultant: false,
      enrolledFromConsole: true,
    };
    assert.equal(contractRequired(enrolled), true);
    assert.equal(contractRequired({ ...enrolled, statuses: ['awaiting_signature'] }), true);
    assert.equal(contractRequired({ ...enrolled, statuses: ['rejected'] }), true);
    assert.equal(contractRequired({ ...enrolled, statuses: ['submitted'] }), false);
    assert.equal(contractRequired({ ...enrolled, statuses: ['approved'] }), false);
  });

  test('leaves trainers alone who were not enrolled from the console', () => {
    const legacy = {
      ...applicant,
      role: 'trainer',
      signedUpAsConsultant: false,
      enrolledFromConsole: false,
    };
    assert.equal(contractRequired(legacy), false);
    assert.equal(contractRequired({ ...legacy, signedUpAsConsultant: true }), false);
  });

  test('never holds admins or other roles', () => {
    assert.equal(
      contractRequired({ ...applicant, role: 'admin', enrolledFromConsole: true }),
      false,
    );
    assert.equal(contractRequired({ ...applicant, role: 'police_commander' }), false);
    assert.equal(contractRequired({ ...applicant, role: undefined }), false);
  });
});
