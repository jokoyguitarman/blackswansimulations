/**
 * The RTS page advances the crowd, the effects field and the game clock by the
 * same simulated time every frame, so a fast or heavily loaded run plays out
 * like a 1x run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTSEngine } from '../src/lib/rts/engine.ts';
import { FX } from '../src/lib/rts/fx/fxConstants.ts';
import {
  MAX_FRAME_SIM_S,
  advanceSharedFrame,
  cappedFrameDt,
  createSharedClock,
} from '../src/lib/rts/fx/simClock.ts';

function play(frames: number[], speed: number) {
  const rts = new RTSEngine();
  rts.startDetonation();
  rts.setSpeed(speed);
  const clock = createSharedClock();
  let crowd = 0;
  let effects = 0;
  for (const dt of frames) {
    rts.tick(cappedFrameDt(dt, speed));
    const before = { crowd, effects };
    advanceSharedFrame(clock, dt, speed, {
      crowdStep: () => crowd++,
      effectsStep: () => effects++,
    });
    rts.syncElapsed(clock.crowdSteps * FX.FIXED_DT);
    const frameCrowdS = (crowd - before.crowd) * FX.FIXED_DT;
    assert.ok(frameCrowdS <= MAX_FRAME_SIM_S + 1e-9, `frame ran ${frameCrowdS} s`);
  }
  return {
    clockS: rts.state.clock.elapsed,
    crowdS: crowd * FX.FIXED_DT,
    effectsS: effects * FX.EFFECTS_DT,
  };
}

test('the effects field never runs ahead of the crowd or the clock', () => {
  const loaded = [0.016, 1.2, 0.5, 2, 0.033, 0.9, 3, 0.25];
  for (const speed of [1, 2, 5, 10]) {
    const r = play(loaded, speed);
    assert.ok(
      Math.abs(r.clockS - r.crowdS) < 1e-9,
      `${speed}x clock ${r.clockS} crowd ${r.crowdS}`,
    );
    assert.ok(r.crowdS - r.effectsS >= -1e-9, `${speed}x effects ahead`);
    assert.ok(r.crowdS - r.effectsS < FX.EFFECTS_DT, `${speed}x effects behind`);
  }
});

test('a heavy frame at 10x is capped for everyone, so the clock slows instead', () => {
  const r = play([1, 1, 1], 10);
  assert.ok(Math.abs(r.crowdS - 3 * MAX_FRAME_SIM_S) < 1e-9);
  assert.ok(Math.abs(r.effectsS - 3 * MAX_FRAME_SIM_S) < 1e-9);
  assert.ok(Math.abs(r.clockS - 3 * MAX_FRAME_SIM_S) < 1e-9);
});

test('1x at 60 fps runs one crowd step a frame and an effects slice every sixth', () => {
  const clock = createSharedClock();
  const pattern: string[] = [];
  for (let i = 0; i < 12; i++) {
    let mark = '';
    advanceSharedFrame(clock, 1 / 60, 1, {
      crowdStep: () => (mark += 'c'),
      effectsStep: () => (mark += 'e'),
    });
    pattern.push(mark);
  }
  assert.deepEqual(pattern, ['c', 'c', 'c', 'c', 'c', 'ce', 'c', 'c', 'c', 'c', 'c', 'ce']);
});

function budgetedFrames(
  costMs: number,
  budgetMs: number,
  frames: number,
  frameDt: number,
  speed: number,
) {
  const clock = createSharedClock();
  let nowMs = 0;
  const budget = { budgetMs, now: () => nowMs };
  const perFrame: number[] = [];
  for (let i = 0; i < frames; i++) {
    const ran = advanceSharedFrame(
      clock,
      frameDt,
      speed,
      { crowdStep: () => (nowMs += costMs) },
      budget,
    );
    perFrame.push(ran.crowdSteps);
  }
  return { clock, perFrame };
}

test('a wall-time budget runs only the steps that fit, and the clock slows', () => {
  const { clock, perFrame } = budgetedFrames(4, 33, 5, 1, 10);
  // The first frame has no measured cost yet, so only the 4 s cap applies.
  assert.deepEqual(perFrame, [240, 8, 8, 8, 8]);
  assert.equal(clock.msPerStep, 4);
  assert.equal(clock.dropped, 5 * 600 - 240 - 4 * 8);
  assert.ok(clock.acc < FX.FIXED_DT);
  assert.equal(clock.effectSteps, Math.floor(clock.crowdSteps / 6));
});

test('a budget always runs at least one step, and leaves a cheap 1x frame alone', () => {
  assert.deepEqual(budgetedFrames(50, 33, 4, 1 / 30, 1).perFrame, [2, 1, 1, 1]);
  const cheap = budgetedFrames(4, 33, 12, 1 / 60, 1);
  assert.deepEqual(cheap.perFrame, Array(12).fill(1));
  assert.equal(cheap.clock.dropped, 0);
});
