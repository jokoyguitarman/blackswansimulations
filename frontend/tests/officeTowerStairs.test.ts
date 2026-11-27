/**
 * Three-storey office fire, stairs only: 200 people on L1 and L2 leave by
 * three 1.2 m stairs while the ground floor burns, and four responders
 * climb one of the stairs against them at T+90.
 *
 * Checked: no flight holds more than its storage (3.76 p/m², SFPE); the
 * L1 landings merge the L2 stream with the L1 floor; the climbing crew
 * narrows the descent to single file (1.01 p/s/m × 0.45 m, the Fruin lane
 * capped at half a 1.2 m stair) and reaches L2.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { LEVEL } from '../src/lib/evacuation/levelConstants.ts';
import { runOfficeFrames } from './scenes/officeTowerFrames.ts';
import { slowScene } from './scenes/slow.ts';

test(
  'office fire: flights stay within storage, L1 landings merge, a climbing crew gets single file',
  { skip: slowScene, timeout: 20 * 60 * 1000 },
  () => {
    let worstOver = -Infinity;
    let merged = 0;
    let counterflowRate: number | null = null;
    let crewStair: string | null = null;
    let crewIds: string[] = [];
    let crewAt = 0;
    const onCrowdStep = (evac: PolygonEvacuationEngine, t: number) => {
      const flights = evac.getStairFlights();
      for (const f of flights) {
        if (f.dir !== 'down') continue;
        const atFoot =
          flights.find(
            (g) => g.stairId === f.stairId && g.dir === 'down' && g.fromLevel === f.toLevel,
          )?.landing ?? 0;
        worstOver = Math.max(worstOver, f.moving + atFoot - f.storage);
        if (f.fromLevel === 'L1' && f.door > 0 && f.landing > 0) merged++;
        if (f.stairId === crewStair && f.counterflow) counterflowRate = f.flowPerS;
      }
      if (crewStair == null && t >= 90) {
        const busiest = flights
          .filter((f) => f.dir === 'down' && f.fromLevel === 'L1')
          .sort((a, b) => b.door + b.landing + b.moving - (a.door + a.landing + a.moving))[0];
        if (busiest) {
          crewStair = busiest.stairId;
          crewAt = t;
          crewIds = evac.sendStairResponders(busiest.stairId, 4, { idPrefix: 'crew' });
        }
      }
      if (crewIds.length > 0 && t >= 239.9) {
        const arrived = evac.getResponderArrivals().filter((a) => crewIds.includes(a.id));
        assert.equal(arrived.length, 4, `crew arrived ${arrived.length} of 4`);
        assert.ok(arrived.every((a) => a.level === 'L2'));
        // Two flights of 3 m at the free climbing speed is the fastest a crew can arrive.
        const climb = (2 * 3 * LEVEL.STAIR_TRAVEL_FACTOR) / LEVEL.STAIR_SPEED_UP;
        assert.ok(
          arrived[0].atS - crewAt >= climb - 0.1,
          `crew up in ${arrived[0].atS - crewAt} s`,
        );
        crewIds = [];
      }
    };
    const result = runOfficeFrames(1, 1 / 60, 240, { onCrowdStep });
    assert.ok(crewStair, 'no busy stair at T+90 to send the crew up');
    assert.equal(crewIds.length, 0, 'crew arrivals were not checked');
    assert.ok(worstOver <= 1, `a flight held ${worstOver} over its storage`);
    assert.ok(merged > 0, 'no L1 landing merged the L2 stream with the L1 floor');
    assert.ok(counterflowRate != null, 'the crew never met the crowd');
    assert.ok(Math.abs(counterflowRate - 1.01 * 0.45) < 1e-9, `rate ${counterflowRate}`);
    assert.ok(result.out > 0, JSON.stringify(result));
  },
);
