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
import { runOfficeFrames } from './scenes/officeTowerFrames.ts';

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

test('office fire: a loaded 10x run matches a 1x run', () => {
  const untilS = 210;
  const real = runOfficeFrames(1, 1 / 60, untilS);
  // One second a frame at 10x asks for 10 s; every subsystem gets 4 s.
  const fast = runOfficeFrames(10, 1, untilS);
  for (const r of [real, fast]) {
    assert.ok(Math.abs(r.clockS - r.crowdS) < 1e-6, JSON.stringify(r));
    assert.ok(r.crowdS - r.effectsS >= 0 && r.crowdS - r.effectsS < FX.EFFECTS_DT);
  }
  assert.ok(fast.frames <= Math.ceil(untilS / MAX_FRAME_SIM_S) + 1, 'the clock slowed');
  assert.ok(Math.abs(fast.out - real.out) <= 10, `out ${fast.out} vs ${real.out}`);
  assert.ok(Math.abs(fast.down - real.down) <= 3, `down ${fast.down} vs ${real.down}`);
  assert.ok(
    Math.abs(fast.sheltering - real.sheltering) <= 3,
    `sheltering ${fast.sheltering} vs ${real.sheltering}`,
  );
  assert.ok(
    Math.abs(fast.burning - real.burning) <= 3,
    `burning ${fast.burning} vs ${real.burning}`,
  );
});
