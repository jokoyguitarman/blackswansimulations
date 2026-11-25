import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isInsidePolygon } from '../src/lib/evacuation/geometry';
import { SHOWCASE } from '../src/lib/evacuation/showcaseConstants';
import { blastEffectsTriggerSec } from '../src/lib/evacuation/showcase';
import { DEFAULT_FIRE_PARAMS, FireSimulation } from '../src/lib/rts/fireSimulation';
import type { InteriorWall } from '../src/lib/rts/types';
import { SpatialEffectsEngine, blastSmokeStudIds } from '../src/lib/rts/spatialEffects';
import { confirmedFuelCells } from '../src/lib/rts/materialLibrary';
import type { FuelCell } from '../src/lib/rts/flameFront';
import { harbourHouseFuelObjects, harbourHouseWalls } from '../src/lib/rts/harbourHouseShowcase';

/**
 * The review harness floor. Origin at the south-west corner, +y north.
 * Blast at (10, 20), radius 15 m. Same walls as the Harbour House sample,
 * before that sample is mirrored into editor metres.
 */
const VERTS = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 40 },
  { x: 0, y: 40 },
];

const WALLS: InteriorWall[] = harbourHouseWalls('plan');

interface Stud {
  id: string;
  simPos: { x: number; y: number };
  spatialContext: 'inside_building' | 'open_air';
}

function harnessStuds(): Stud[] {
  const out: Stud[] = [];
  for (let x = -15; x <= 75; x += 3) {
    for (let y = -15; y <= 55; y += 3) {
      const inside = isInsidePolygon(x + 0.5, y + 0.5, VERTS);
      out.push({
        id: `s_${x}_${y}`,
        simPos: { x: x + 0.5, y: y + 0.5 },
        spatialContext: inside ? 'inside_building' : 'open_air',
      });
    }
  }
  return out;
}

const BLAST = { x: 10, y: 20 };
const BLAST_R = 15;
const MARKS = [90, 180, 300];

function runShowcase(fuel: ReadonlyMap<string, FuelCell> | null) {
  const studs = harnessStuds();
  const engine = new SpatialEffectsEngine({
    ...DEFAULT_FIRE_PARAMS,
    ambientSpread: true,
    ambientHeatSec: SHOWCASE.AMBIENT_HEAT_S,
  });
  engine.init(studs);
  if (fuel) engine.setFuelCells(fuel);
  const inRadius = studs
    .filter((stud) => Math.hypot(stud.simPos.x - BLAST.x, stud.simPos.y - BLAST.y) <= BLAST_R)
    .map((stud) => stud.id);
  engine.registerHazard(
    'blast-direct',
    [
      {
        triggerTimeSec: blastEffectsTriggerSec(engine.timeScale),
        eventType: 'explode',
        spreadType: 'fire',
        spreadRadius: BLAST_R,
        spreadRate: 10,
        description: 'Direct blast ignition',
        severity: 'critical',
        smokeGeneration: 'heavy',
        affectedStuds: blastSmokeStudIds(inRadius, fuel ? new Set(fuel.keys()) : null),
      },
    ],
    { initial: 'a', triggered: 'b', worsening: 'c', critical: 'd' },
  );
  const zone = {
    id: 'blast-direct',
    pos: BLAST,
    radius: BLAST_R,
    hazardType: 'ignitable' as const,
    severity: 'high' as const,
    label: 'Blast',
    description: 'Direct blast ignition',
    photos: [] as string[],
  };
  const burning: number[] = [];
  let mark = 0;
  const frames = MARKS[MARKS.length - 1] * 60;
  for (let frame = 1; frame <= frames; frame++) {
    engine.step(1 / 60, WALLS, [zone]);
    const gameT = frame / 60;
    if (mark < MARKS.length && gameT + 1e-9 >= MARKS[mark]) {
      burning.push(engine.getStats().fire.burning);
      mark += 1;
    }
  }
  return { engine, studs, burning };
}

describe('Harbour House showcase fuel', () => {
  test('the west shop, the mall, the east shop and the kitchen are separate rooms', () => {
    const studs = harnessStuds();
    const sim = new FireSimulation();
    sim.init(studs);
    const rooms = sim.compartmentIds(WALLS);
    const room = (x: number, y: number) => rooms.get(`s_${x}_${y}`);
    const west = room(9, 18);
    const kitchen = room(9, 3);
    const mall = room(30, 18);
    const east = room(42, 18);
    assert.ok(west && kitchen && mall && east);
    assert.equal(new Set([west, kitchen, mall, east]).size, 4);
    assert.notEqual(room(48, 3), mall);
    const sizes = new Map<string, number>();
    for (const id of rooms.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    assert.ok((sizes.get(west) ?? 0) > 50);
    assert.ok((sizes.get(east) ?? 0) > 50);
    assert.ok((sizes.get(kitchen) ?? 0) < 40);
  });

  test('joined wall ends still split the studs on either side', () => {
    const sim = new FireSimulation();
    sim.init([
      { id: 'west', simPos: { x: 21.5, y: 33.5 }, spatialContext: 'inside_building' },
      { id: 'east', simPos: { x: 24.5, y: 36.5 }, spatialContext: 'inside_building' },
    ]);
    const piece = (id: string, y0: number, y1: number): InteriorWall => ({
      id,
      start: { x: 22, y: y0 },
      end: { x: 22, y: y1 },
      hasDoor: false,
      doorWidth: 1.6,
      doorPosition: 0.5,
      description: id,
      material: 'drywall',
      photos: [],
    });
    const rooms = sim.compartmentIds([piece('a', 0, 34), piece('b', 34, 40)]);
    assert.notEqual(rooms.get('west'), rooms.get('east'));
  });

  test('the west shop burns through, and the east shop stays dark', { skip: !process.env.RUN_SLOW_TESTS && 'slow scene run: nightly, or npm run test:slow' }, () => {
    const studs = harnessStuds();
    const objects = harbourHouseFuelObjects(studs);
    const fuel = confirmedFuelCells(objects, studs);
    const indoor = studs.filter((stud) => stud.spatialContext === 'inside_building');
    assert.ok(fuel.size > 0 && fuel.size < indoor.length);

    const entry = (id: string) => objects.find((obj) => obj.studId === id)?.matches[0]?.entryId;
    const gas = objects.filter((obj) => obj.matches[0]?.entryId === 'gas_line');
    const shops = objects.filter((obj) => obj.matches[0]?.entryId === 'shop_contents');
    assert.ok(gas.length > 0);
    assert.ok(shops.length > 50);
    for (const obj of gas) assert.equal(fuel.has(obj.studId), false);
    for (const obj of objects) {
      if (obj.matches[0]?.entryId === 'ceramic_tile' || obj.matches[0]?.entryId === 'concrete') {
        assert.equal(fuel.has(obj.studId), false);
      }
    }

    const inBlast = studs.filter(
      (stud) => fuel.has(stud.id) && Math.hypot(stud.simPos.x - BLAST.x, stud.simPos.y - BLAST.y) <= BLAST_R,
    );
    const beyond = studs.filter(
      (stud) => fuel.has(stud.id) && Math.hypot(stud.simPos.x - BLAST.x, stud.simPos.y - BLAST.y) > BLAST_R + 6,
    );
    assert.ok(beyond.length > 0);

    const standIn = runShowcase(null);
    const empty = runShowcase(new Map());
    const furnished = runShowcase(fuel);

    // Master, wood on every indoor stud and the 8 m / 30 s rule, was 74 / 126 / 192.
    // The blast lights 70, including 67 of the 72 west-shop studs. By T+3:00 the
    // front has lit the other 5 and the kitchen has flashed, and that is still
    // the count at T+5:00. The east shop stays dark.
    // No named fuel stands in as light wood. The mall is too big to flash, so
    // the count stays 74 until the kitchen, which is under 500 m², flashes.
    assert.deepEqual(empty.burning, [0, 0, 0]);
    assert.deepEqual(standIn.burning, [74, 74, 93]);
    assert.deepEqual(furnished.burning, [70, 94, 94]);
    assert.equal(furnished.burning[0], inBlast.length);
    assert.ok(furnished.burning[2] < fuel.size);

    const outside = 's_-3_18';
    assert.equal(studs.find((stud) => stud.id === outside)?.spatialContext, 'open_air');
    assert.equal(furnished.engine.studStates.get(outside)?.fire.state, 'none');

    const posOf = (id: string) => studs.find((stud) => stud.id === id)?.simPos;
    const east = shops.filter((obj) => (posOf(obj.studId)?.x ?? 0) >= 40);
    const west = shops.filter((obj) => (posOf(obj.studId)?.x ?? 0) < 22);
    assert.ok(east.length > 50);
    assert.ok(west.length > 50);
    for (const obj of east) assert.equal(furnished.engine.studStates.get(obj.studId)?.fire.state, 'none');
    for (const obj of west) assert.equal(furnished.engine.studStates.get(obj.studId)?.fire.state, 'burning');
    const leftTheBlast = beyond.filter((stud) => furnished.engine.studStates.get(stud.id)?.fire.state === 'burning');
    assert.ok(leftTheBlast.length > 0);
    assert.ok(leftTheBlast.every((stud) => stud.simPos.x < 40));
    assert.equal(entry('s_9_18'), 'shop_contents');
    assert.equal(furnished.engine.studStates.get('s_9_18')?.fire.state, 'burning');
    assert.equal(empty.engine.studStates.get('s_9_18')?.fire.state, 'none');

    const sealed = objects.find((obj) => obj.matches[0]?.entryId === 'concrete');
    assert.ok(sealed);
    assert.equal(furnished.engine.studStates.get(sealed.studId)?.fire.state, 'none');
    for (const obj of gas) assert.equal(furnished.engine.studStates.get(obj.studId)?.fire.state, 'none');
    const tile = objects.find((obj) => obj.matches[0]?.entryId === 'ceramic_tile');
    assert.ok(tile);
    assert.equal(furnished.engine.studStates.get(tile.studId)?.fire.state, 'none');
  });
});
