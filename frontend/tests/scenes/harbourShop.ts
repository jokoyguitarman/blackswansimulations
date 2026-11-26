/**
 * Harbour House shop and kitchen under the oxygen limit, one person in the
 * crowd. The burn figures are the Decision 9 shop band. Effects step at the
 * frame dt, the same loop as the crowd run.
 */
import { confirmedFuelCells } from '../../src/lib/rts/materialLibrary.ts';
import { harbourHouseFuelObjects } from '../../src/lib/rts/harbourHouseShowcase.ts';
import { ventilationLimitedKw } from '../../src/lib/rts/twoZone.ts';
import { HarbourRun } from './harbourHarness.ts';
import { effectsView, type LayerLive } from './effectsView.ts';
import { fixed } from './round.ts';

const DT = 1 / 60;

export interface ShopRoomSample {
  tSec: number;
  prescribedMw: number;
  burnedMw: number;
  o2Upper: number;
  doorMw: number;
}

export interface HarbourShopResult {
  shop: {
    doorMw: number;
    at180: { prescribedMw: number; burnedMw: number; o2Upper: number };
    burnedMw: { t200: number; t290: number; t320: number; minFrom180: number; maxFrom180: number };
  };
  kitchen: {
    doorMw: number;
    burnedMw: {
      t210: number;
      t250: number;
      t290: number;
      t370: number;
      minFrom210: number;
      maxFrom210: number;
    };
  };
}

function doorMw(run: HarbourRun, room: string): number {
  const enclosures = effectsView(run.effects).layerEnclosures;
  const enc = [...enclosures.entries()].find(([key]) => key.startsWith(`${room}@`))?.[1];
  if (!enc) return 0;
  const kaw = enc.spec.vents.reduce(
    (sum, vent) =>
      sum +
      ventilationLimitedKw(vent.widthM * (vent.soffitM - vent.sillM), vent.soffitM - vent.sillM),
    0,
  );
  return fixed(kaw / 1000, 1);
}

function sampleRoom(
  run: HarbourRun,
  live: LayerLive,
  tSec: number,
): ShopRoomSample & { room: string } {
  const fire = effectsView(run.effects).fireSim;
  let prescribed = 0;
  let burned = 0;
  for (const id of live.members) {
    const release = fire.fuelReleaseKw(id) ?? 0;
    prescribed += release;
    burned += release * fire.burnFraction(id);
  }
  const room =
    [...effectsView(run.effects).layerState.entries()].find(([, value]) => value === live)?.[0] ??
    '';
  return {
    room,
    tSec,
    prescribedMw: fixed(prescribed / 1000, 1),
    burnedMw: fixed(burned / 1000, 1),
    o2Upper: fixed(live.zone.upperO2 ?? 0.23, 3),
    doorMw: doorMw(run, room),
  };
}

export function runHarbourShop(): HarbourShopResult {
  const run = new HarbourRun({
    peds: 1,
    afterExit: 'zone',
    zones: [{ pos: { x: -30, y: -10 }, kind: 'assembly' }],
  });
  run.start();
  run.effects.setFuelCells(confirmedFuelCells(harbourHouseFuelObjects(run.studs), run.studs));
  const samples: Array<ShopRoomSample & { room: string }> = [];
  const marks = Array.from({ length: 23 }, (_, index) => 150 + 10 * index);
  let mark = 0;
  while (run.rts.state.clock.elapsed < 370.5) {
    run.frame(DT);
    const t = run.rts.state.clock.elapsed;
    if (mark >= marks.length || t < marks[mark]) continue;
    const tSec = Math.round(t);
    mark += 1;
    for (const live of effectsView(run.effects).layerState.values()) {
      let prescribed = 0;
      const fire = effectsView(run.effects).fireSim;
      for (const id of live.members) prescribed += fire.fuelReleaseKw(id) ?? 0;
      if (prescribed < 1) continue;
      samples.push(sampleRoom(run, live, tSec));
    }
  }

  const byDoor = (door: number) => samples.filter((sample) => sample.doorMw === door);
  const shop = byDoor(22.1);
  const kitchen = byDoor(6.8);
  const at = (rows: typeof shop, tSec: number) => {
    const found = rows.find((row) => row.tSec === tSec);
    if (!found) throw new Error(`missing shop sample at T+${tSec}`);
    return found;
  };
  const from180 = shop.filter((row) => row.tSec >= 180 && row.tSec <= 370);
  const burned = from180.map((row) => row.burnedMw);
  const kitchenFrom210 = kitchen
    .filter((row) => row.tSec >= 210 && row.tSec <= 370)
    .map((row) => row.burnedMw);
  if (burned.length === 0 || kitchenFrom210.length === 0) {
    throw new Error('Harbour shop did not record the shop and kitchen rooms');
  }
  const at180 = at(shop, 180);
  return {
    shop: {
      doorMw: 22.1,
      at180: {
        prescribedMw: at180.prescribedMw,
        burnedMw: at180.burnedMw,
        o2Upper: at180.o2Upper,
      },
      burnedMw: {
        t200: at(shop, 200).burnedMw,
        t290: at(shop, 290).burnedMw,
        t320: at(shop, 320).burnedMw,
        minFrom180: Math.min(...burned),
        maxFrom180: Math.max(...burned),
      },
    },
    kitchen: {
      doorMw: 6.8,
      burnedMw: {
        t210: at(kitchen, 210).burnedMw,
        t250: at(kitchen, 250).burnedMw,
        t290: at(kitchen, 290).burnedMw,
        t370: at(kitchen, 370).burnedMw,
        minFrom210: Math.min(...kitchenFrom210),
        maxFrom210: Math.max(...kitchenFrom210),
      },
    },
  };
}
