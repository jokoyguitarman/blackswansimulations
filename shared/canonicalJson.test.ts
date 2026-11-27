import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson } from './canonicalJson.js';

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined fields', () => {
    const a = { b: 1, a: { d: 1, c: 2, gone: undefined }, z: undefined };
    const b = { a: { c: 2, d: 1 }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":{"c":2,"d":1},"b":1}');
  });

  test('keeps array order and turns undefined elements into null', () => {
    assert.equal(canonicalJson([1, undefined, 2]), '[1,null,2]');
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test('sorts keys inside array elements without reordering the array', () => {
    assert.equal(canonicalJson([{ b: 1, a: 2 }, { a: 3 }]), '[{"a":2,"b":1},{"a":3}]');
  });
});
