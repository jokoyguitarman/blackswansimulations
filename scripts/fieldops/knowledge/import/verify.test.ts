import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifierRecording } from './verify.js';

describe('verifierRecording', () => {
  it('stores an admin id and leaves a non-admin unlinked', () => {
    assert.deepEqual(verifierRecording({ id: 'admin-id', role: 'admin' }, 'owner@example.com'), {
      recordedBy: 'admin-id',
      notAdmin: false,
    });
    assert.deepEqual(
      verifierRecording({ id: 'trainer-id', role: 'trainer' }, 'trainer@example.com'),
      { recordedBy: null, notAdmin: true },
    );
  });

  it('fails when the email or id matches nobody', () => {
    assert.throws(
      () => verifierRecording(null, 'nobody@example.com'),
      /verifier nobody@example.com matches no user_profiles row/,
    );
  });
});
