import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, sha256Hex } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts keys, keeps array order and stringifies numbers', () => {
    const nested = { b: 1, a: [2, { d: 1, c: true }] };
    assert.equal(canonicalJson(nested), '{"a":[2,{"c":true,"d":1}],"b":1}');
    assert.equal(canonicalJson({ n: 1.5, s: 'x', z: null }), '{"n":1.5,"s":"x","z":null}');
    assert.equal(canonicalJson(1), '1');
    assert.equal(canonicalJson('quote "'), '"quote \\""');
  });

  it('hashes two fixed inputs to stored constants', () => {
    const first = sha256Hex(canonicalJson({ b: 1, a: [2, { d: 1, c: true }] }));
    const second = sha256Hex(canonicalJson({ n: 1.5, s: 'x', z: null }));
    assert.equal(first, 'c894898e04844d083dcd3696610193bbea89082c32ca47c04434aced34d1eb43');
    assert.equal(second, '14dee041e690820dea15f5962b9bc9c526f3b61a86d83d24ae1649048e03711a');
  });
});
