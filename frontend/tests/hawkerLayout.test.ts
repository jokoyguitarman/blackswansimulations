import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isInsidePolygon, nearestEdge } from '../src/lib/evacuation/geometry.ts';
import { projectPolygon } from '../src/lib/evacuation/geometry.ts';
import { HOLLAND_BOMB, layoutHawkerCentre, seatingBomb } from '../src/lib/rts/hawkerLayout.ts';
import { blastPressureAt, defaultCharge } from '../src/lib/rts/blast/blastModel.ts';
import { GAS_RUPTURE_KPA } from '../src/lib/rts/flameFront.ts';
import { generateSceneStuds, projectSceneStuds } from '../src/lib/rts/sceneStuds.ts';
import {
  EMPTY_HAWKER_FACTS,
  buildingTokens,
  citationsFromOpenAiResponse,
  extractHawkerFacts,
  htmlToText,
} from '../../shared/hawkerFacts.ts';
import type { HawkerFacts } from '../../shared/hawkerFacts.ts';

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

const NEA = 'Comprises 21 cooked food stalls and 48 market stalls.';
const BUILDING = 'Holland Village Market and Food Centre';
/** Same thickness and body radius the evacuation engine uses for these walls. */
const WALL_CLEAR_M = 0.4 + 0.25;

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Stall and table studs a person cannot walk from to a public exit. */
function stallsThatCannotReachAnExit(
  verts: { x: number; y: number }[],
  layout: ReturnType<typeof layoutHawkerCentre>,
): number {
  const shell: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const gaps = layout.exits
      .filter((exit) => exit.edgeIndex === i && exit.exitType !== 'service')
      .map((exit) => {
        const t = (exit.center.x - a.x) * ux + (exit.center.y - a.y) * uy;
        return { lo: t - exit.width / 2, hi: t + exit.width / 2 };
      })
      .sort((p, q) => p.lo - q.lo);
    let cursor = 0;
    const push = (lo: number, hi: number) => {
      if (hi - lo < 0.2) return;
      shell.push({
        ax: a.x + ux * lo,
        ay: a.y + uy * lo,
        bx: a.x + ux * hi,
        by: a.y + uy * hi,
      });
    };
    for (const gap of gaps) {
      push(cursor, Math.max(cursor, gap.lo));
      cursor = Math.max(cursor, gap.hi);
    }
    push(cursor, len);
  }
  const blocked = (x: number, y: number) => {
    for (const wall of layout.walls) {
      if (distToSeg(x, y, wall.start.x, wall.start.y, wall.end.x, wall.end.y) < WALL_CLEAR_M) {
        return true;
      }
    }
    for (const wall of shell) {
      if (distToSeg(x, y, wall.ax, wall.ay, wall.bx, wall.by) < WALL_CLEAR_M) return true;
    }
    return false;
  };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const vert of verts) {
    minX = Math.min(minX, vert.x);
    maxX = Math.max(maxX, vert.x);
    minY = Math.min(minY, vert.y);
    maxY = Math.max(maxY, vert.y);
  }
  const step = 0.4;
  const cols = Math.ceil((maxX - minX) / step);
  const rows = Math.ceil((maxY - minY) / step);
  const at = (col: number, row: number) => row * cols + col;
  const open = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = minX + (col + 0.5) * step;
      const y = minY + (row + 0.5) * step;
      if (isInsidePolygon(x, y, verts) && !blocked(x, y)) open[at(col, row)] = 1;
    }
  }
  const reach = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const seed = (x: number, y: number) => {
    const col = Math.floor((x - minX) / step);
    const row = Math.floor((y - minY) / step);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return;
    const index = at(col, row);
    if (!open[index] || reach[index]) return;
    reach[index] = 1;
    queue.push(index);
  };
  for (const exit of layout.exits) {
    if (exit.exitType === 'service') continue;
    const a = verts[exit.edgeIndex];
    const b = verts[(exit.edgeIndex + 1) % verts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (!isInsidePolygon(exit.center.x + nx, exit.center.y + ny, verts)) {
      nx = -nx;
      ny = -ny;
    }
    for (let dist = 0.8; dist <= 2.4; dist += 0.4) {
      seed(exit.center.x + nx * dist, exit.center.y + ny * dist);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    const col = index % cols;
    const row = (index - col) / cols;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      if (nextCol < 0 || nextRow < 0 || nextCol >= cols || nextRow >= rows) continue;
      const next = at(nextCol, nextRow);
      if (!open[next] || reach[next]) continue;
      reach[next] = 1;
      queue.push(next);
    }
  }
  const targets = layout.objects.filter(
    (object) =>
      object.id.startsWith('cooked-oil-') ||
      object.id.startsWith('market-') ||
      object.id.startsWith('table-'),
  );
  let closed = 0;
  for (const object of targets) {
    const col = Math.floor((object.pos.x - minX) / step);
    const row = Math.floor((object.pos.y - minY) / step);
    if (col < 0 || row < 0 || col >= cols || row >= rows || !reach[at(col, row)]) closed++;
  }
  return closed;
}

function facts(): HawkerFacts {
  return extractHawkerFacts(
    [
      {
        url: 'https://example.test/centre',
        title: 'Centre page',
        text: `Holland Village Market and Food Centre. ${NEA} National Environment Agency.`,
      },
      {
        url: 'https://example.test/stalls',
        title: 'Stall notes',
        text: 'Holland Village Market. Notes 01-33 and 01-37. Cooked food stalls are about 10.75 m².',
      },
    ],
    BUILDING,
  );
}

describe('hawker facts', () => {
  test('reads an agreed NEA sentence, a single storey, and the stall area', () => {
    const read = facts();
    assert.equal(read.cookedStalls?.value, 21);
    assert.equal(read.marketStalls?.value, 48);
    assert.equal(read.cookedStalls?.sources[0].quote, NEA);
    assert.equal(read.singleStorey?.value, true);
    assert.equal(read.cookedStallAreaM2?.value, 10.75);
    assert.deepEqual(read.disagreements, []);
  });

  test('a disagreed count is not treated as researched', () => {
    const read = extractHawkerFacts(
      [
        { url: 'https://example.test/a', title: 'Holland Village Market', text: NEA },
        {
          url: 'https://example.test/b',
          title: 'Holland Village Food Centre',
          text: 'Comprises 21 cooked food stalls and 38 market stalls.',
        },
      ],
      BUILDING,
    );
    assert.equal(read.cookedStalls, null);
    assert.equal(read.marketStalls, null);
    assert.match(read.disagreements[0], /21\/48/);
    assert.match(read.disagreements[0], /21\/38/);
  });

  test('an upper stall number keeps the storey unknown', () => {
    const read = extractHawkerFacts(
      [
        {
          url: 'https://example.test/stalls',
          title: 'Stall notes',
          text: 'Holland Village 01-33 and 02-10.',
        },
      ],
      BUILDING,
    );
    assert.equal(read.singleStorey, null);
  });

  test('strips tags, names the building, and ignores another centre’s counts', () => {
    assert.equal(htmlToText('<p>21&nbsp;cooked food stalls</p>'), '21 cooked food stalls');
    assert.deepEqual(buildingTokens(BUILDING), ['holland', 'village']);
    const cited = citationsFromOpenAiResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              annotations: [
                { type: 'url_citation', url: 'https://example.test/centre', title: 'Centre' },
                { type: 'url_citation', url: 'https://example.test/centre', title: 'Centre' },
              ],
            },
          ],
        },
      ],
    });
    assert.deepEqual(cited, [{ url: 'https://example.test/centre', title: 'Centre' }]);
    const other = extractHawkerFacts(
      [
        {
          url: 'https://example.test/other',
          title: 'A directory of centres',
          text: 'Bedok Market. Comprises 21 cooked food stalls and 48 market stalls.',
        },
      ],
      BUILDING,
    );
    assert.equal(other.cookedStalls, null);
    assert.equal(other.marketStalls, null);
  });
});

describe('hawker layout', () => {
  test('draws the Holland Village footprint from the fetched counts', () => {
    const verts = projectPolygon(HOLLAND);
    const studs = projectSceneStuds(HOLLAND, generateSceneStuds(HOLLAND, 0, ['G']))
      .filter((stud) => stud.spatialContext === 'inside_building' && stud.floor === 'G')
      .map((stud) => ({ id: stud.id, x: stud.simPos.x, y: stud.simPos.y }));
    const layout = layoutHawkerCentre({ verts, studs, facts: facts() });

    const cooked = layout.labels.find((label) => label.id === 'fact-cooked');
    assert.equal(cooked?.origin, 'researched');
    assert.equal(cooked?.text, '21 cooked-food stalls.');
    assert.equal(layout.labels.find((label) => label.id === 'row-cooked')?.origin, 'assumed');
    assert.equal(layout.labels.find((label) => label.id === 'vertical')?.origin, 'researched');
    assert.match(layout.labels.find((label) => label.id === 'vertical')?.text ?? '', /No stair/);

    const oils = layout.objects.filter((object) => object.id.startsWith('cooked-oil-'));
    assert.equal(oils.length, 21);
    for (const oil of oils) {
      const index = oil.id.replace('cooked-oil-', '');
      assert.ok(layout.objects.some((object) => object.id === `cooked-gas-${index}`));
      assert.ok(layout.objects.some((object) => object.id === `cooked-hood-${index}`));
      assert.ok(layout.objects.some((object) => object.id === `cooked-power-${index}`));
      assert.equal(oil.confirmed, true);
      assert.ok(isInsidePolygon(oil.pos.x, oil.pos.y, verts));
    }
    const market = layout.objects.filter((object) => object.id.startsWith('market-'));
    assert.equal(market.length, 48);
    assert.ok(market.every((object) => object.matches[0]?.entryId === 'wet_market'));
    const stallIds = new Set(
      layout.objects
        .filter((object) => object.id.startsWith('cooked-') || object.id.startsWith('market-'))
        .map((object) => object.studId),
    );
    const tables = layout.objects.filter((object) => object.id.startsWith('table-'));
    assert.ok(tables.length > 4);
    assert.ok(tables.every((table) => !stallIds.has(table.studId)));
    assert.ok(layout.walls.length > 0);
    for (const line of layout.walls) {
      assert.equal(line.material, 'steel');
      assert.equal(line.hasDoor, false);
      assert.ok(line.start.x === line.end.x || line.start.y === line.end.y);
    }
    assert.ok(layout.exits.filter((exit) => exit.exitType === 'public').length >= 2);
    for (const exit of layout.exits) {
      const snap = nearestEdge(exit.center.x, exit.center.y, verts);
      assert.ok(snap.dist < 0.2, `exit ${exit.id} is ${snap.dist} m off the outline`);
    }
    const [a, b] = layout.exits.filter((exit) => exit.exitType === 'public');
    assert.ok(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) > 15);
    const bomb = layout.bomb;
    const gas = layout.objects.find((object) => object.id === 'cooked-gas-0');
    assert.ok(bomb);
    assert.ok(gas);
    assert.ok(isInsidePolygon(bomb.x, bomb.y, verts));
    const reach = Math.hypot(bomb.x - gas.pos.x, bomb.y - gas.pos.y);
    assert.ok(reach <= HOLLAND_BOMB.fireballM, `bomb is ${reach} m from the gas line`);
    assert.ok(reach >= 2, `bomb is only ${reach} m from the stall`);
    const pressure = blastPressureAt(defaultCharge(), reach, false).psKpa;
    assert.ok(pressure >= GAS_RUPTURE_KPA, `incident pressure ${pressure} kPa`);
    const bombLabel = layout.labels.find((label) => label.id === 'bomb');
    assert.equal(bombLabel?.origin, 'assumed');
    assert.match(bombLabel?.text ?? '', /seating/);
    assert.equal(seatingBomb(verts, []), null);
    for (const line of layout.walls) {
      assert.ok(isInsidePolygon(line.start.x, line.start.y, verts));
      assert.ok(isInsidePolygon(line.end.x, line.end.y, verts));
    }
    assert.equal(stallsThatCannotReachAnExit(verts, layout), 0);
  });

  test('with no pages, the interior is assumed and still has two exits', () => {
    const verts = projectPolygon(HOLLAND);
    const layout = layoutHawkerCentre({ verts, studs: [], facts: EMPTY_HAWKER_FACTS });
    assert.equal(
      layout.labels.find((label) => label.id === 'fact-cooked'),
      undefined,
    );
    assert.equal(
      layout.labels.every(
        (label) =>
          label.id === 'vertical' || label.origin === 'assumed' || label.origin === 'researched',
      ),
      true,
    );
    assert.equal(layout.labels.find((label) => label.id === 'vertical')?.origin, 'assumed');
    assert.equal(layout.bomb, null);
    assert.ok(layout.exits.filter((exit) => exit.exitType === 'public').length >= 2);
  });

  test('an undesigned upper floor is labelled as a copy', () => {
    const verts = projectPolygon(HOLLAND);
    const layout = layoutHawkerCentre({
      verts,
      studs: [],
      facts: EMPTY_HAWKER_FACTS,
      upperFloorIds: ['L1'],
    });
    const upper = layout.labels.find((label) => label.id === 'upper-floors');
    assert.equal(upper?.origin, 'assumed');
    assert.match(upper?.text ?? '', /L1 copies the ground walls and exits/);
  });
});
