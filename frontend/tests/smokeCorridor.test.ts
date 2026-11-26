/**
 * Smoke corridor test block through T+600, ignition at T+60. Only the store
 * room has fuel, so every other room is reached by smoke alone.
 * About 45 s.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { smokeCorridorSample, SMOKE_CORRIDOR_ROOMS } from '../src/lib/rts/smokeCorridorTest.ts';
import { runSmokeCorridor, type SmokeCorridorRun } from './scenes/smokeCorridor.ts';

const ARRIVED = 0.05;

function firstArrival(run: SmokeCorridorRun, room: string): number {
  const row = run.samples.find((sample) => sample.rooms[room].smoke >= ARRIVED);
  return row ? row.tSec : Infinity;
}

function last(run: SmokeCorridorRun, room: string) {
  return run.samples[run.samples.length - 1].rooms[room];
}

describe('Smoke corridor test block', { concurrency: 1 }, () => {
  let run: SmokeCorridorRun;
  before(() => {
    run = runSmokeCorridor(600, 10);
  });

  test('loads with one compartment per room and fuel only in the store', () => {
    assert.equal(run.rooms.size, SMOKE_CORRIDOR_ROOMS.length);
    assert.equal(run.compartments.size, SMOKE_CORRIDOR_ROOMS.length);
    for (const rooms of run.compartments.values()) assert.equal(rooms.size, 1);
    assert.ok(run.fuelStudIds.size > 0);
    for (const id of run.fuelStudIds) assert.ok(run.rooms.get('store')?.includes(id));
    const exits = Object.fromEntries(smokeCorridorSample.scene.exits.map((e) => [e.id, e.status]));
    assert.deepEqual(exits, { 'exit-south': 'open', 'exit-atrium-east': 'blocked' });
    const shut = smokeCorridorSample.scene.interiorWalls.filter((w) => w.openFraction === 0);
    assert.deepEqual(
      shut.map((w) => w.id),
      ['w-n4-door'],
    );
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
