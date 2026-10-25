import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrganisationName } from '../../shared/orgNames';
import {
  MAX_DISMISSED,
  clearDismissal,
  isOnMap,
  mergeSpokespersonLinks,
  parseDismissedProposals,
  recordDismissal,
  selectFootprintAdditions,
  type DismissedProposal,
  type SetupLists,
} from '../src/components/Scenario/setupOrganisations';

const lists = (over: Partial<SetupLists> = {}): SetupLists => ({
  primary: { display_name: 'Dyson', country: 'Singapore' },
  offices: [
    { display_name: 'Dyson Malaysia', country: 'Malaysia', proposed_from: 'Dyson Malaysia' },
  ],
  pressure: [{ display_name: 'Ministry of Human Resources', country: 'Malaysia' }],
  ...over,
});

describe('sameOrganisationName', () => {
  const rows: Array<[string, string, boolean]> = [
    ['Dyson Malaysia', 'dyson malaysia.', true],
    ['Dyson Malaysia', 'Dyson Malaysia Sdn Bhd', true],
    ['Ministry of Human Resources', 'Ministry of Human Resources (MOHR)', true],
    ['Médecins Sans Frontières', 'Medecins Sans Frontieres', true],
    ['Dyson', 'Dyson Malaysia', false],
    ['Ministry of Labour', 'Ministry of Labourers', false],
    ['', 'Dyson', false],
  ];
  for (const [a, b, expected] of rows) {
    test(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`, () => {
      assert.equal(sameOrganisationName(a, b), expected);
    });
  }
});

describe('dismissals', () => {
  test('records the current name and the proposal it came from, and ignores blanks and duplicates', () => {
    const once = recordDismissal([], 'pressure', {
      display_name: ' Ministry of Human Resources ',
      proposed_from: 'Ministry of Human Resources (MOHR)',
    });
    // The variant is the same organisation, so one entry covers both.
    assert.deepEqual(
      once.map((d) => d.name),
      ['Ministry of Human Resources'],
    );
    const distinct = recordDismissal([], 'office', {
      display_name: 'Dyson',
      proposed_from: 'Dyson Malaysia',
    });
    assert.deepEqual(
      distinct.map((d) => d.name),
      ['Dyson', 'Dyson Malaysia'],
    );
    const again = recordDismissal(once, 'pressure', {
      display_name: 'ministry of human resources',
      proposed_from: '',
    });
    assert.equal(again.length, once.length);
  });

  test('keeps the newest entries once the cap is reached', () => {
    let list: DismissedProposal[] = [];
    for (let i = 0; i < MAX_DISMISSED + 5; i++) {
      list = recordDismissal(list, 'office', { display_name: `Office number ${i} regional` });
    }
    assert.equal(list.length, MAX_DISMISSED);
    assert.equal(list[list.length - 1].name, `Office number ${MAX_DISMISSED + 4} regional`);
    assert.equal(list[0].name, 'Office number 5 regional');
  });

  test('clearing removes name variants on the same side only', () => {
    const list: DismissedProposal[] = [
      { side: 'office', name: 'Dyson Malaysia Sdn Bhd' },
      { side: 'pressure', name: 'Dyson Malaysia' },
      { side: 'office', name: 'Dyson Vietnam' },
    ];
    const cleared = clearDismissal(list, 'office', 'Dyson Malaysia');
    assert.deepEqual(
      cleared.map((d) => `${d.side}:${d.name}`),
      ['pressure:Dyson Malaysia', 'office:Dyson Vietnam'],
    );
  });
});

describe('isOnMap', () => {
  test('matches a card by its current name when the countries agree', () => {
    assert.equal(
      isOnMap('office', { display_name: 'dyson malaysia.', country: 'Malaysia' }, lists()),
      true,
    );
  });

  test('does not match the same name in a different country', () => {
    assert.equal(
      isOnMap(
        'pressure',
        { display_name: 'Ministry of Human Resources', country: 'Singapore' },
        lists(),
      ),
      false,
    );
  });

  test('matches by the original proposal even after the card moved country', () => {
    const moved = lists({
      offices: [
        { display_name: 'Johor Plant', country: 'Singapore', proposed_from: 'Dyson Malaysia' },
      ],
    });
    assert.equal(
      isOnMap('office', { display_name: 'Dyson Malaysia', country: 'Vietnam' }, moved),
      true,
    );
  });

  test('matches the primary organisation on the office side', () => {
    assert.equal(isOnMap('office', { display_name: 'Dyson', country: 'Singapore' }, lists()), true);
    assert.equal(
      isOnMap('pressure', { display_name: 'Dyson', country: 'Singapore' }, lists()),
      false,
    );
  });
});

describe('selectFootprintAdditions', () => {
  const footprint = {
    implied_organisations: [
      { display_name: 'Dyson Malaysia', country: 'Malaysia' },
      { display_name: 'Dyson Johor Plant', country: 'Malaysia', proposed_from_target: true },
      { display_name: 'Dyson Vietnam', country: 'Vietnam' },
      { display_name: 'Ministry of Human Resources', country: 'Malaysia' },
      { display_name: 'Dyson Philippines', country: 'Philippines' },
    ],
    pressure_organisations: [
      { display_name: 'Ministry of Human Resources (MOHR)', country: 'Malaysia' },
      { display_name: 'Dyson Malaysia', country: 'Malaysia' },
      { display_name: 'Dyson Malaysia Workers Union', country: 'Malaysia' },
      { display_name: 'Electrical Industry Workers Union', country: 'Malaysia' },
      { display_name: 'Electrical Industry Workers Union Malaysia', country: 'Malaysia' },
    ],
  };

  test('skips what is on the map, removed, clashing or duplicated, and keeps order', () => {
    const renamed = lists({
      offices: [
        { display_name: 'Dyson Malaysia', country: 'Malaysia' },
        { display_name: 'Johor Plant', country: 'Malaysia', proposed_from: 'Dyson Johor Plant' },
      ],
    });
    const dismissed: DismissedProposal[] = [{ side: 'office', name: 'Dyson Vietnam' }];
    const picked = selectFootprintAdditions(footprint, renamed, dismissed, {
      offices: 5,
      pressure: 6,
    });
    assert.deepEqual(
      picked.offices.map((o) => o.display_name),
      ['Dyson Philippines'],
    );
    assert.deepEqual(picked.keptOff, ['Dyson Vietnam']);
    assert.deepEqual(
      picked.pressure.map((p) => p.display_name),
      ['Dyson Malaysia Workers Union', 'Electrical Industry Workers Union'],
    );
  });

  test('a pressure dismissal does not block an office proposal', () => {
    const picked = selectFootprintAdditions(
      {
        implied_organisations: [{ display_name: 'Dyson Vietnam', country: 'Vietnam' }],
        pressure_organisations: [],
      },
      lists({ offices: [] }),
      [{ side: 'pressure', name: 'Dyson Vietnam' }],
      { offices: 5, pressure: 6 },
    );
    assert.deepEqual(
      picked.offices.map((o) => o.display_name),
      ['Dyson Vietnam'],
    );
  });

  test('reports proposals that do not fit', () => {
    const picked = selectFootprintAdditions(
      {
        implied_organisations: [
          { display_name: 'Dyson Vietnam', country: 'Vietnam' },
          { display_name: 'Dyson Philippines', country: 'Philippines' },
        ],
        pressure_organisations: [],
      },
      lists({ offices: [] }),
      [],
      { offices: 1, pressure: 0 },
    );
    assert.deepEqual(
      picked.offices.map((o) => o.display_name),
      ['Dyson Vietnam'],
    );
    assert.deepEqual(picked.noRoom, ['Dyson Philippines']);
  });
});

describe('mergeSpokespersonLinks', () => {
  const drafts = [
    { display_name: 'Ministry of Human Resources', wants: 'back pay' },
    { display_name: 'Electrical Union', wants: 'consultation' },
  ];

  test('annotates matches and never adds a wire entry that has no card', () => {
    const merged = mergeSpokespersonLinks(drafts, [
      {
        display_name: ' ministry of human resources ',
        org_key: 'org_pressure_mhr_my',
        spokesperson_stakeholder_id: 'stk_1',
      },
      {
        display_name: 'Somebody Else',
        org_key: 'org_pressure_else_my',
        spokesperson_stakeholder_id: 'stk_2',
      },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].org_key, 'org_pressure_mhr_my');
    assert.equal(merged[0].spokesperson_stakeholder_id, 'stk_1');
    assert.equal(merged[0].wants, 'back pay');
    assert.equal(merged[1].org_key, undefined);
  });

  test('an empty wire returns the cards unchanged', () => {
    assert.deepEqual(mergeSpokespersonLinks(drafts, []), drafts);
  });
});

describe('parseDismissedProposals', () => {
  test('keeps only well-formed entries, trims them, and caps the list', () => {
    assert.deepEqual(parseDismissedProposals(undefined), []);
    assert.deepEqual(parseDismissedProposals({ side: 'office' }), []);
    const raw = [
      { side: 'office', name: '  Dyson Malaysia  ' },
      { side: 'rival', name: 'Apex' },
      { side: 'pressure' },
      { side: 'pressure', name: '   ' },
      null,
      ...Array.from({ length: MAX_DISMISSED }, (_, i) => ({
        side: 'office',
        name: `Kept office ${i}`,
      })),
    ];
    const parsed = parseDismissedProposals(raw);
    assert.equal(parsed.length, MAX_DISMISSED);
    assert.equal(parsed[0].name, 'Kept office 0');
    assert.equal(parsed[parsed.length - 1].name, `Kept office ${MAX_DISMISSED - 1}`);
    assert.ok(parsed.every((d) => d.side === 'office' || d.side === 'pressure'));
  });
});
