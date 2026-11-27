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
  advanceGameFrame,
  advanceSharedFrame,
  cappedFrameDt,
  createSharedClock,
  createSpeedMeter,
  noteFrameSpeed,
  resetSharedClock,
  speedLabel,
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
  assert.deepEqual(perFrame, [8, 8, 8, 8, 8]);
  assert.equal(clock.msPerStep, 4);
  assert.equal(clock.dropped, 5 * 600 - 5 * 8);
  assert.ok(clock.acc < FX.FIXED_DT);
  assert.equal(clock.effectSteps, Math.floor(clock.crowdSteps / 6));
});

test('a budget always runs at least one step, and leaves a cheap 1x frame alone', () => {
  assert.deepEqual(budgetedFrames(50, 33, 4, 1 / 30, 1).perFrame, [2, 2, 1, 1]);
  const cheap = budgetedFrames(4, 33, 12, 1 / 60, 1);
  assert.deepEqual(cheap.perFrame, Array(12).fill(1));
  assert.equal(cheap.clock.dropped, 0);
});

test('the first frame after a start or a reset is budgeted', () => {
  // Before any measurement the budget uses the seed cost.
  assert.equal(budgetedFrames(1, 33, 1, 1, 10).perFrame[0], Math.floor(33 / FX.SIM_STEP_SEED_MS));
  // A cold start: frame 0's steps are slow while the JIT warms up, then 4 ms.
  const clock = createSharedClock();
  let nowMs = 0;
  const perFrame: number[] = [];
  for (let frame = 0; frame < 4; frame++) {
    const costMs = frame === 0 ? 14 : 4;
    const ran = advanceSharedFrame(
      clock,
      1,
      10,
      { crowdStep: () => (nowMs += costMs) },
      { budgetMs: 33, now: () => nowMs },
    );
    perFrame.push(ran.crowdSteps);
  }
  // The warm-up frame eases the estimate from the seed (4 -> 6 ms) instead of
  // replacing it with 14 ms, which would have left frames 1-3 at 2 steps.
  assert.deepEqual(perFrame, [8, 5, 5, 6]);
  // A reset keeps the measured cost.
  const measured = clock.msPerStep;
  resetSharedClock(clock);
  assert.equal(clock.crowdSteps, 0);
  assert.equal(clock.msPerStep, measured);
});

test('responder units move by the sim time the crowd ran, under the budget', () => {
  const loaded = [0.016, 1.2, 0.5, 2, 0.033, 0.9, 3, 0.25, 1, 1, 1, 1 / 60, 1 / 144];
  for (const speed of [1, 2, 5, 10]) {
    for (const costMs of [0.5, 4, 50]) {
      const rts = new RTSEngine();
      rts.startDetonation();
      rts.setSpeed(speed);
      const unit = rts.spawnUnit('marshal', { x: 0, y: 0 });
      rts.issueMove([unit.id], { x: 100000, y: 0 }, false);
      const clock = createSharedClock();
      let nowMs = 0;
      let effects = 0;
      for (const dt of loaded) {
        advanceGameFrame(
          rts,
          clock,
          dt,
          speed,
          { crowdStep: () => (nowMs += costMs), effectsStep: () => effects++ },
          { budgetMs: FX.SIM_BUDGET_MS, now: () => nowMs },
        );
      }
      const crowdS = clock.crowdSteps * FX.FIXED_DT;
      const unitS = unit.pos.x / unit.def.speed;
      const tag = `${speed}x at ${costMs} ms/step`;
      assert.ok(Math.abs(unitS - crowdS) < 1e-6, `${tag}: unit ${unitS} s, crowd ${crowdS} s`);
      assert.ok(Math.abs(rts.state.clock.elapsed - crowdS) < 1e-9, tag);
      const effectsS = effects * FX.EFFECTS_DT;
      assert.ok(crowdS - effectsS >= -1e-9 && crowdS - effectsS < FX.EFFECTS_DT, tag);
    }
  }
});

test('the speed meter reads simulated seconds per real second', () => {
  const meter = createSpeedMeter();
  let readings = 0;
  for (let i = 0; i < 40; i++) if (noteFrameSpeed(meter, 10, 0.05, 0.155)) readings++;
  assert.equal(readings, 2);
  assert.ok(Math.abs((meter.effective ?? 0) - 3.1) < 1e-9);
  assert.equal(speedLabel(10, meter.effective), '10x (running 3.1x)');
  // A new speed starts a new window.
  noteFrameSpeed(meter, 5, 0.05, 0.25);
  assert.equal(meter.effective, null);
  assert.equal(speedLabel(5, meter.effective), '5x');
  // Within 10% of the chosen speed the label stays plain.
  assert.equal(speedLabel(1, 0.95), '1x');
  assert.equal(speedLabel(1, 0.6), '1x (running 0.6x)');
});
