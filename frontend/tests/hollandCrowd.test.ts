import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolygonEvacuationEngine } from '../src/lib/evacuation/engine.ts';
import { projectPolygon } from '../src/lib/evacuation/geometry.ts';
import { SHOWCASE } from '../src/lib/evacuation/showcaseConstants.ts';
import { DEFAULT_POLYGON_CONFIG } from '../src/lib/evacuation/types.ts';
import { layoutHawkerCentre } from '../src/lib/rts/hawkerLayout.ts';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import { extractHawkerFacts } from '../../shared/hawkerFacts.ts';

const HOLLAND: [number, number][] = [
  [1.3109098, 103.794894],
  [1.3108498, 103.7947684],
  [1.3109805, 103.7947079],
  [1.3111669, 103.7946216],
  [1.3111884, 103.7946664],
  [1.3112402, 103.7947744],
  [1.3112871, 103.7948339],
  [1.3113087, 103.7949064],
  [1.3113019, 103.7949818],
  [1.3112678, 103.7950494],
  [1.3112112, 103.7950996],
  [1.31114, 103.7951254],
  [1.3110644, 103.795123],
  [1.3109949, 103.7950929],
  [1.3109416, 103.7950392],
  [1.3109118, 103.7949696],
];

// A flood fill only checks that a gap exists. The crowd used to stop about
// 0.7 m short of a door-less counter and never leave, so this runs the engine.
test('the Holland Village crowd leaves with no fire or smoke', { skip: !process.env.RUN_SLOW_TESTS && 'slow scene run: nightly, or npm run test:slow' }, () => {
  const verts = projectPolygon(HOLLAND);
  const studs = projectSceneStuds(HOLLAND, generateSceneStuds(HOLLAND, 0, ['G']))
    .filter((stud) => stud.spatialContext === 'inside_building' && stud.floor === 'G')
    .map((stud) => ({ id: stud.id, x: stud.simPos.x, y: stud.simPos.y }));
  const facts = extractHawkerFacts(
    [
      {
        url: 'https://example.test/centre',
        title: 'Holland Village Market and Food Centre',
        text: 'Holland Village Market and Food Centre. Comprises 21 cooked food stalls and 48 market stalls.',
      },
    ],
    'Holland Village Market and Food Centre',
  );
  const layout = layoutHawkerCentre({ verts, studs, facts });
  const walls = layout.walls.map((wall) => ({
    startX: wall.start.x,
    startY: wall.start.y,
    endX: wall.end.x,
    endY: wall.end.y,
    hasDoor: wall.hasDoor,
    doorWidth: wall.doorWidth,
    doorPosition: wall.doorPosition,
  }));
  const engine = new PolygonEvacuationEngine(
    { ...DEFAULT_POLYGON_CONFIG, vertices: verts, pedestrianCount: 120 },
    layout.exits,
    walls,
    [],
    { afterExit: 'disperse', zones: [], seed: SHOWCASE.RNG_SEED, buildingHeightM: 4 },
  );
  const site = {
    x: verts.reduce((sum, vert) => sum + vert.x, 0) / verts.length,
    y: verts.reduce((sum, vert) => sum + vert.y, 0) / verts.length,
  };
  engine.triggerBlast(site, 0.2);
  const steps = Math.round(420 / DEFAULT_POLYGON_CONFIG.dt);
  const mark = Math.round(60 / DEFAULT_POLYGON_CONFIG.dt);
  for (let i = 0; i < steps; i++) {
    engine.step();
    if ((i + 1) % mark !== 0) continue;
    const now = engine.getSnapshots();
    const still = now.filter(
      (snap) => snap.state === 'idle' || snap.state === 'reacting' || snap.state === 'evacuating',
    ).length;
    if (still === 0) break;
  }
  const snaps = engine.getSnapshots();
  const inside = snaps.filter(
    (snap) => snap.state === 'idle' || snap.state === 'reacting' || snap.state === 'evacuating',
  );
  engine.destroy();
  assert.equal(
    inside.length,
    0,
    `${inside.length} people still inside after 7 minutes with no fire: ${inside
      .slice(0, 5)
      .map((snap) => `${snap.state} (${snap.x.toFixed(1)},${snap.y.toFixed(1)})`)
      .join('; ')}`,
  );
});
