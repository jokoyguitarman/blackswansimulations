import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthLinkError } from '../../shared/authLinkError.js';

describe('parseAuthLinkError', () => {
  test('reads the expired-link error Supabase puts in the address hash', () => {
    const found = parseAuthLinkError(
      '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      '',
    );
    assert.deepEqual(found, {
      code: 'otp_expired',
      description: 'Email link is invalid or has expired',
      expired: true,
    });
  });

  test('reads the same error from the query string', () => {
    const found = parseAuthLinkError(
      '',
      '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    );
    assert.equal(found?.expired, true);
    assert.equal(found?.code, 'otp_expired');
  });

  test('treats an expiry described only in words as expired', () => {
    const found = parseAuthLinkError(
      '#error=access_denied&error_description=The+link+has+expired',
      '',
    );
    assert.equal(found?.expired, true);
  });

  test('reports other link errors without calling them expired', () => {
    const found = parseAuthLinkError(
      '#error=server_error&error_code=unexpected_failure&error_description=Something+broke',
      '',
    );
    assert.deepEqual(found, {
      code: 'unexpected_failure',
      description: 'Something broke',
      expired: false,
    });
  });

  test('ignores a successful sign-in hash', () => {
    assert.equal(
      parseAuthLinkError('#access_token=abc&refresh_token=def&expires_in=3600&type=signup', ''),
      null,
    );
  });

  test('ignores an unrelated error parameter on some other page', () => {
    assert.equal(parseAuthLinkError('', '?error=cancelled'), null);
    assert.equal(parseAuthLinkError('#error=oops', ''), null);
  });

  test('ignores an empty address', () => {
    assert.equal(parseAuthLinkError('', ''), null);
    assert.equal(parseAuthLinkError('#', '?'), null);
  });
});
