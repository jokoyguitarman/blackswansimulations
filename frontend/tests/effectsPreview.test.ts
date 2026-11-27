/**
 * The setup preview's schedule: events the engine makes itself get the same
 * fine window as registered ones, through a rollback that replays exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PREVIEW_COARSE_DT,
  PREVIEW_FINE_S,
  PREVIEW_PRE_BLAST_DT,
  PreviewRun,
  buildPreviewEngine,
  previewSteps,
} from '../src/lib/rts/effectsPreview.ts';
import { FX } from '../src/lib/rts/fx/fxConstants.ts';
import { cloneState } from '../src/lib/rts/stateClone.ts';
import { sceneHash } from './scenes/hash.ts';
import { officePreviewInput } from './scenes/officePreview.ts';
import { effectsState } from './scenes/stateHash.ts';

/** previewSteps as it was before the schedule ran one step at a time. */
function listedSteps(t0: number, seconds: number, eventTimes: readonly number[] = []): number[] {
  const end = t0 + Math.max(0, seconds);
  const windows = [t0, ...eventTimes]
    .filter((e) => e >= t0 && e < end)
    .sort((a, b) => a - b)
    .map((e) => [Math.max(0, e - FX.EFFECTS_DT), Math.min(end, e + PREVIEW_FINE_S)]);
  const steps: number[] = [];
  let t = 0;
  const pushUntil = (until: number, dt: number) => {
    while (until - t > 1e-9) {
      const h = Math.min(dt, until - t);
      steps.push(h);
      t += h;
    }
  };
  for (const [from, to] of windows) {
    if (to <= t + 1e-9) continue;
    pushUntil(from, t < t0 - 1e-9 ? PREVIEW_PRE_BLAST_DT : PREVIEW_COARSE_DT);
    pushUntil(to, FX.EFFECTS_DT);
  }
  pushUntil(end, PREVIEW_COARSE_DT);
  return steps;
}

const hashOf = (engine: Parameters<typeof effectsState>[0]) => sceneHash(effectsState(engine));

test('the registered-event schedule is the same steps as before', () => {
  const cases: Array<[number, number, number[]]> = [
    [60, 300, []],
    [60, 30, [80]],
    [60, 120, [62, 64, 100, 400]],
    [0, 20, [3]],
    [60.4, 45.3, [61.05, 90]],
  ];
  for (const [t0, seconds, events] of cases) {
    assert.deepEqual(previewSteps(t0, seconds, events), listedSteps(t0, seconds, events));
  }
});

test('a snapshot steps exactly as the engine it was taken from', () => {
  const { input, walls } = officePreviewInput();
  const { engine, t0, hazards } = buildPreviewEngine(input);
  const steps = previewSteps(t0, 12);
  for (const h of steps) engine.step(h, walls, hazards);
  const copy = engine.snapshot([walls, ...walls, hazards, ...hazards]);
  assert.equal(hashOf(copy), hashOf(engine));
  for (let i = 0; i < 6; i++) {
    engine.step(PREVIEW_COARSE_DT, walls, hazards);
    copy.step(PREVIEW_COARSE_DT, walls, hazards);
  }
  assert.equal(hashOf(copy), hashOf(engine));
  assert.ok(copy.studStates !== engine.studStates);
});

test('a state copy refuses what it cannot carry', () => {
  const none = new Set<object>();
  assert.throws(() => cloneState({ f: () => 1 }, none, new Set()), /function/);
  assert.throws(() => cloneState({ w: new WeakMap() }, none, new Set()), /WeakMap/);
  class Kept {
    n = 1;
  }
  const kept = cloneState({ k: new Kept(), a: [1, 2] }, none, new Set([Kept]));
  assert.ok(kept.k instanceof Kept);
  const shared = { s: 1 };
  const twice = { a: shared, b: shared };
  const copied = cloneState(twice, none, new Set());
  assert.ok(copied.a === copied.b && copied.a !== shared);
  assert.ok(cloneState(twice, new Set([shared]), new Set()).a === shared);
});

test('a cell that catches fire mid-run gets the fine window, by an exact rollback', () => {
  // On the office fire three more cells catch fire about 97 s after the blast.
  const seconds = 100;
  const { input, walls } = officePreviewInput();
  const run = new PreviewRun(input, seconds, walls);
  while (run.advance());
  assert.ok(run.rollbacks >= 1, 'the late ignition fell inside a coarse step');

  // Replaying the kept steps from scratch lands on the same state.
  const kept = run.schedule();
  const { engine, t0, hazards } = buildPreviewEngine(input);
  const onsetSteps: number[] = [];
  let seen = engine.onsets();
  kept.forEach((h, i) => {
    engine.step(h, walls, hazards);
    const now = engine.onsets();
    if (now !== seen) onsetSteps.push(i);
    seen = now;
  });
  assert.equal(hashOf(engine), hashOf(run.engine));
  const total = kept.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - (t0 + seconds)) < 1e-6);

  // Every step that made an onset is fine, and so is every step in the
  // PREVIEW_FINE_S after it, the blast's onsets and the late one alike.
  const ends: number[] = [];
  kept.reduce((t, h) => (ends.push(t + h), t + h), 0);
  const late = onsetSteps.filter((i) => ends[i]! > t0 + PREVIEW_FINE_S + 1);
  assert.ok(late.length >= 1, 'an onset after the blast window');
  for (const i of onsetSteps) {
    const at = ends[i]!;
    kept.forEach((h, j) => {
      if (ends[j]! >= at - 1e-9 && ends[j]! <= Math.min(at + PREVIEW_FINE_S, t0 + seconds) - 1e-9) {
        assert.ok(h <= FX.EFFECTS_DT + 1e-9, `step ending at ${ends[j]} after the onset at ${at}`);
      }
    });
  }

  // Without the rollback the late onset lands in a 0.5 s step.
  const plain = previewSteps(t0, seconds, [t0]);
  const fresh = buildPreviewEngine(input);
  let before = fresh.engine.onsets();
  let t = 0;
  let coarseOnset = false;
  for (const h of plain) {
    fresh.engine.step(h, walls, fresh.hazards);
    t += h;
    const now = fresh.engine.onsets();
    if (now !== before && t > t0 + PREVIEW_FINE_S + 1 && h > FX.EFFECTS_DT + 1e-9) {
      coarseOnset = true;
    }
    before = now;
  }
  assert.ok(coarseOnset, 'the fixed schedule should take that onset in a coarse step');
});
