import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampIntellect,
  intellectBand,
  intellectToParams,
  DEFAULT_INTELLECT,
} from './intellect.js';

describe('intellectToParams', () => {
  test('clamps and defaults', () => {
    assert.equal(clampIntellect(undefined), DEFAULT_INTELLECT);
    assert.equal(clampIntellect('abc'), DEFAULT_INTELLECT);
    assert.equal(clampIntellect(-10), 0);
    assert.equal(clampIntellect(140), 100);
    assert.equal(clampIntellect(64.6), 65);
  });

  test('anchors reproduce exactly', () => {
    const novice = intellectToParams(0);
    assert.deepEqual(novice.cadenceSec, [150, 300]);
    assert.equal(novice.counterRate, 0.05);
    assert.equal(novice.knowsRubric, false);
    assert.equal(novice.modelTier, 'fast');

    const expert = intellectToParams(85);
    assert.deepEqual(expert.cadenceSec, [35, 80]);
    assert.equal(expert.counterRate, 0.95);
    assert.equal(expert.laneDiscipline, 1);
    assert.equal(expert.knowsRubric, true);
    assert.equal(expert.critiquePass, true);
    assert.equal(expert.modelTier, 'strong');

    const ceiling = intellectToParams(100);
    assert.equal(ceiling.counterRate, 1);
    assert.equal(ceiling.idleRate, 0.04);
  });

  test('numbers interpolate linearly between anchors', () => {
    const mid = intellectToParams(15); // halfway between 0 and 30
    assert.equal(mid.counterRate, 0.15);
    assert.equal(mid.idleRate, 0.425);
    assert.deepEqual(mid.cadenceSec, [130, 270]);
  });

  test('monotonic: faster, more disciplined, more coordinated as the slider rises', () => {
    let prev = intellectToParams(0);
    for (let n = 1; n <= 100; n++) {
      const cur = intellectToParams(n);
      assert.ok(cur.cadenceSec[0] <= prev.cadenceSec[0], `cadence min at ${n}`);
      assert.ok(cur.cadenceSec[1] <= prev.cadenceSec[1], `cadence max at ${n}`);
      assert.ok(cur.reactionDelaySec[1] <= prev.reactionDelaySec[1], `reaction at ${n}`);
      assert.ok(cur.counterRate >= prev.counterRate, `counterRate at ${n}`);
      assert.ok(cur.idleRate <= prev.idleRate, `idleRate at ${n}`);
      assert.ok(cur.factDiscipline >= prev.factDiscipline, `factDiscipline at ${n}`);
      assert.ok(cur.laneDiscipline >= prev.laneDiscipline, `laneDiscipline at ${n}`);
      assert.ok(cur.coordination >= prev.coordination, `coordination at ${n}`);
      prev = cur;
    }
  });

  test('booleans switch on at their anchors and never off again', () => {
    assert.equal(intellectToParams(59).knowsRubric, false);
    assert.equal(intellectToParams(60).knowsRubric, true);
    assert.equal(intellectToParams(59).modelTier, 'fast');
    assert.equal(intellectToParams(60).modelTier, 'strong');
    assert.equal(intellectToParams(84).critiquePass, false);
    assert.equal(intellectToParams(85).critiquePass, true);
    for (let n = 85; n <= 100; n++) {
      assert.equal(intellectToParams(n).critiquePass, true, `critique at ${n}`);
      assert.equal(intellectToParams(n).knowsRubric, true, `rubric at ${n}`);
    }
  });

  test('bands', () => {
    assert.equal(intellectBand(0), 'Novice');
    assert.equal(intellectBand(24), 'Novice');
    assert.equal(intellectBand(25), 'Competent');
    assert.equal(intellectBand(49), 'Competent');
    assert.equal(intellectBand(50), 'Proficient');
    assert.equal(intellectBand(74), 'Proficient');
    assert.equal(intellectBand(75), 'Expert');
    assert.equal(intellectBand(100), 'Expert');
  });
});
