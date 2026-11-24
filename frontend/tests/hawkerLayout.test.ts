import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isInsidePolygon, nearestEdge } from '../src/lib/evacuation/geometry.ts';
import { projectPolygon } from '../src/lib/evacuation/geometry.ts';
import { layoutHawkerCentre } from '../src/lib/rts/hawkerLayout.ts';
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
    for (const line of layout.walls) {
      assert.ok(isInsidePolygon(line.start.x, line.start.y, verts));
      assert.ok(isInsidePolygon(line.end.x, line.end.y, verts));
    }
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
