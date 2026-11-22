import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derivedPhysicsRunId, uuidv5 } from './ids.js';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the RFC 9562 DNS vectors', () => {
    assert.equal(uuidv5(DNS, 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
    assert.equal(uuidv5(DNS, 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('derives a stable physics run id', () => {
    assert.equal(derivedPhysicsRunId(), derivedPhysicsRunId());
    assert.equal(derivedPhysicsRunId(), '2e29e439-b48c-5ad4-ae98-484474e9326c');
  });
});
