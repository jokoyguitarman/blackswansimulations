import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { confirmProjectMatches, resolveDbTarget, SafetyError } from './safety.js';

const DIRECT = 'postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres';
const POOLER =
  'postgresql://postgres.abcdefgh:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

describe('confirmProjectMatches', () => {
  it('accepts the project ref as the host label or the pooler user', () => {
    assert.equal(confirmProjectMatches(DIRECT, 'abcdefgh'), true);
    assert.equal(confirmProjectMatches(POOLER, 'abcdefgh'), true);
  });

  it('rejects a wrong ref, a substring, and an empty ref', () => {
    assert.equal(confirmProjectMatches(DIRECT, 'zzzzzzzz'), false);
    assert.equal(confirmProjectMatches(DIRECT, 'abc'), false);
    assert.equal(confirmProjectMatches(DIRECT, 'supabase'), false);
    assert.equal(confirmProjectMatches(DIRECT, 'db'), false);
    assert.equal(confirmProjectMatches(DIRECT, ''), false);
    assert.equal(confirmProjectMatches(POOLER, 'postgres'), false);
    assert.equal(confirmProjectMatches(POOLER, 'abc'), false);
  });

  it('does not treat a password or a longer host label as the project ref', () => {
    const password = 'postgresql://postgres:abcdefgh@db.zzzzzzzz.supabase.co:5432/postgres';
    assert.equal(confirmProjectMatches(password, 'abcdefgh'), false);
    const longer = 'postgresql://postgres:secret@db.abcdefghij.supabase.co:5432/postgres';
    assert.equal(confirmProjectMatches(longer, 'abcdefgh'), false);
  });
});

describe('resolveDbTarget shared confirmation', () => {
  const previous = {
    url: process.env.KNOWLEDGE_DB_URL,
    target: process.env.KNOWLEDGE_TARGET,
  };

  afterEach(() => {
    if (previous.url === undefined) delete process.env.KNOWLEDGE_DB_URL;
    else process.env.KNOWLEDGE_DB_URL = previous.url;
    if (previous.target === undefined) delete process.env.KNOWLEDGE_TARGET;
    else process.env.KNOWLEDGE_TARGET = previous.target;
  });

  it('refuses a shared apply until the ref matches the host or the pooler user', () => {
    process.env.KNOWLEDGE_DB_URL = DIRECT;
    process.env.KNOWLEDGE_TARGET = 'shared';
    assert.throws(() => resolveDbTarget({ apply: true }), SafetyError);
    assert.throws(() => resolveDbTarget({ apply: true, confirmProject: 'supabase' }), SafetyError);
    assert.throws(() => resolveDbTarget({ apply: true, confirmProject: '' }), SafetyError);
    const target = resolveDbTarget({ apply: true, confirmProject: 'abcdefgh' });
    assert.equal(target.target, 'shared');
  });
});
