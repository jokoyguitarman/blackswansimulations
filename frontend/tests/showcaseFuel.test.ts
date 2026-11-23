import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isInsidePolygon } from '../src/lib/evacuation/geometry';
import { SHOWCASE } from '../src/lib/evacuation/showcaseConstants';
import { blastEffectsTriggerSec } from '../src/lib/evacuation/showcase';
import { DEFAULT_FIRE_PARAMS } from '../src/lib/rts/fireSimulation';
import type { InteriorWall } from '../src/lib/rts/types';
import { SpatialEffectsEngine, blastSmokeStudIds } from '../src/lib/rts/spatialEffects';
import { confirmedFuelCells } from '../src/lib/rts/materialLibrary';
import type { FuelCell } from '../src/lib/rts/flameFront';
import { harbourHouseFuelObjects } from '../src/lib/rts/harbourHouseShowcase';

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

const WALLS: InteriorWall[] = [
  wall('w1', 22, 0, 22, 34, true, 0.5, 'drywall'),
  wall('w2', 40, 6, 40, 40, true, 0.4, 'drywall'),
  wall('w3', 46, 0, 46, 8, false, 0.5, 'concrete'),
  wall('w4', 46, 8, 60, 8, false, 0.5, 'concrete'),
];

function wall(
  id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  hasDoor: boolean,
  doorPosition: number,
  material: string,
): InteriorWall {
  return {
    id,
    start: { x: x0, y: y0 },
    end: { x: x1, y: y1 },
    hasDoor,
    doorWidth: 1.6,
    doorPosition,
    description: id,
    material,
    photos: [],
  };
}

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
  test('the mall burns where the fuel is, and the open room then flashes over', () => {
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
    // No named fuel still stands in as light wood and flashes the whole indoor floor.
    // The mall is 70 at T+1:30 (the fuel the blast lit) and then every fuelled stud.
    assert.deepEqual(empty.burning, [0, 0, 0]);
    assert.deepEqual(standIn.burning, [74, 268, 268]);
    assert.deepEqual(furnished.burning, [inBlast.length, fuel.size, fuel.size]);
    assert.deepEqual(furnished.burning, [70, 164, 164]);

    const outside = 's_-3_18';
    assert.equal(studs.find((stud) => stud.id === outside)?.spatialContext, 'open_air');
    assert.equal(furnished.engine.studStates.get(outside)?.fire.state, 'none');

    const shop = shops.find((obj) => Math.hypot(
      (studs.find((stud) => stud.id === obj.studId)?.simPos.x ?? 0) - BLAST.x,
      (studs.find((stud) => stud.id === obj.studId)?.simPos.y ?? 0) - BLAST.y,
    ) > BLAST_R + 6);
    assert.ok(shop);
    assert.equal(furnished.engine.studStates.get(shop.studId)?.fire.state, 'burning');
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
