/**
 * Smoke corridor test block. The geometry checks build the scene without
 * stepping and run on every PR. The spread run goes to T+600, ignition at
 * T+60, and takes about 45 s, so it is a nightly slow scene. Only the store
 * room has fuel, so every other room is reached by smoke alone.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { smokeCorridorSample, SMOKE_CORRIDOR_ROOMS } from '../src/lib/rts/smokeCorridorTest.ts';
import { runSmokeCorridor, type SmokeCorridorRun } from './scenes/smokeCorridor.ts';
import { slowScene } from './scenes/slow.ts';

const ARRIVED = 0.05;

function firstArrival(run: SmokeCorridorRun, room: string): number {
  const row = run.samples.find((sample) => sample.rooms[room].smoke >= ARRIVED);
  return row ? row.tSec : Infinity;
}

function last(run: SmokeCorridorRun, room: string) {
  return run.samples[run.samples.length - 1].rooms[room];
}

describe('Smoke corridor test block geometry', () => {
  const scene = runSmokeCorridor(0);

  test('one compartment per room', () => {
    assert.equal(scene.rooms.size, SMOKE_CORRIDOR_ROOMS.length);
    assert.equal(scene.compartments.size, SMOKE_CORRIDOR_ROOMS.length);
    for (const rooms of scene.compartments.values()) assert.equal(rooms.size, 1);
  });

  test('fuel only in the store', () => {
    assert.ok(scene.fuelStudIds.size > 0);
    for (const id of scene.fuelStudIds) assert.ok(scene.rooms.get('store')?.includes(id));
  });

  test('south exit open, atrium doors blocked', () => {
    const exits = Object.fromEntries(smokeCorridorSample.scene.exits.map((e) => [e.id, e.status]));
    assert.deepEqual(exits, { 'exit-south': 'open', 'exit-atrium-east': 'blocked' });
  });

  test('the meeting room door is the one shut leaf', () => {
    const shut = smokeCorridorSample.scene.interiorWalls.filter((w) => w.openFraction === 0);
    assert.deepEqual(
      shut.map((w) => [w.id, w.doorPinned]),
      [['w-n4-door', true]],
    );
  });
});

describe('Smoke corridor test block spread', { concurrency: 1, skip: slowScene }, () => {
  let run: SmokeCorridorRun;
  before(() => {
    run = runSmokeCorridor(600, 10);
  });

  test('only the store burns', () => {
    assert.ok((run.everBurned.get('store')?.size ?? 0) > 0);
    for (const [room, ids] of run.everBurned) {
      assert.equal(room, 'store', `${room} caught fire`);
      for (const id of ids) assert.ok(run.fuelStudIds.has(id), `${id} burned without fuel`);
    }
  });

  test('smoke travels down the corridors in order', () => {
    const west = firstArrival(run, 'corridor-west');
    const junction = firstArrival(run, 'corridor-junction');
    const south = firstArrival(run, 'corridor-south');
    assert.ok(west > run.ignitionSec, `west corridor at T+${west}`);
    assert.ok(west < junction, `west T+${west}, junction T+${junction}`);
    assert.ok(junction < south, `junction T+${junction}, south T+${south}`);
    assert.ok(south <= 600, `south corridor at T+${south}`);
  });

  test('smoke reaches the far hallway rooms', () => {
    assert.ok(last(run, 'corridor-junction').layerK > 0, 'junction forms a layer');
    for (const room of ['corridor-south', 'office-s3', 'office-s5']) {
      assert.ok(last(run, room).smoke >= 0.1, `${room} smoke ${last(run, room).smoke}`);
    }
  });

  test('the shut door keeps the meeting room cleaner than the open office beside it', () => {
    for (const sample of run.samples) {
      assert.ok(
        sample.rooms['meeting-n4'].smoke <= sample.rooms['office-n3'].smoke + 1e-9,
        `T+${sample.tSec}`,
      );
    }
    assert.equal(last(run, 'meeting-n4').layerK, 0);
  });
});
