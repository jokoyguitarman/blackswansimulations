import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { guardRailFootprint } from './crisisFootprintService.js';

const DYSON =
  'Dyson HQ in Singapore faces a scandal over unfair labour practices at its contract manufacturing factory in Johor, Malaysia. Workers allege forced overtime and withheld wages; a Malaysian NGO has documented cases and the Ministry of Human Resources is asking questions.';
const existing = [{ display_name: 'Dyson', country: 'Singapore' }];

describe('guardRailFootprint', () => {
  test('keeps known countries with roles, adds the entered organisation country, drops unknowns', () => {
    const fp = guardRailFootprint(
      {
        countries: [
          { name: 'Malaysia', role: 'incident_location', reason: 'factory' },
          { name: 'Atlantis', role: 'spillover_market', reason: 'nope' },
          { name: 'malaysia', role: 'regulatory', reason: 'dup' },
        ],
      },
      DYSON,
      existing,
    );
    assert.deepEqual(
      fp.countries.map((c) => `${c.name}:${c.role}`),
      ['Malaysia:incident_location', 'Singapore:decision_centre'],
    );
    assert.equal(fp.labour_signal, true);
    assert.equal(fp.product_safety_signal, false);
  });
  test('implied organisations: at most 3, never one the trainer already entered, unknown countries dropped', () => {
    const fp = guardRailFootprint(
      {
        implied_organisations: [
          {
            display_name: 'Dyson Malaysia',
            kind: 'office',
            country: 'Malaysia',
            city: 'Johor Bahru',
            reason: 'factory operating company',
            suggested_roster: ['Communications', 'Operations', 'HR', 'Legal', 'Extra'],
          },
          {
            display_name: 'Dyson',
            kind: 'company',
            country: 'Singapore',
            reason: 'already entered',
            suggested_roster: [],
          },
          {
            display_name: 'Dyson Vietnam',
            kind: 'office',
            country: 'Vietnam',
            reason: 'x',
            suggested_roster: [],
          },
          {
            display_name: 'Dyson Philippines',
            kind: 'office',
            country: 'Philippines',
            reason: 'x',
            suggested_roster: [],
          },
          {
            display_name: 'Dyson Thailand',
            kind: 'office',
            country: 'Thailand',
            reason: 'x',
            suggested_roster: [],
          },
          {
            display_name: 'Dyson Narnia',
            kind: 'office',
            country: 'Narnia',
            reason: 'x',
            suggested_roster: [],
          },
        ],
      },
      DYSON,
      existing,
    );
    assert.equal(fp.implied_organisations.length, 3);
    assert.equal(fp.implied_organisations[0].display_name, 'Dyson Malaysia');
    assert.equal(
      fp.implied_organisations[0].suggested_roster.length,
      4,
      'roster suggestion capped at 4',
    );
    assert.ok(
      !fp.implied_organisations.some(
        (o) => o.display_name === 'Dyson' || o.display_name === 'Dyson Narnia',
      ),
    );
  });
  test('pressure orgs: union only with a labour signal, one regulator per country, political only with political text', () => {
    // Raw model output is untyped on purpose (the guard-rail must cope with anything).
    const proposals: Parameters<typeof guardRailFootprint>[0] = {
      pressure_organisations: [
        {
          display_name: 'Ministry of Human Resources',
          kind: 'regulator',
          country: 'Malaysia',
          register: 'statutory',
          reason: 'labour law',
        },
        {
          display_name: 'Department of Occupational Safety and Health',
          kind: 'regulator',
          country: 'Malaysia',
          register: 'statutory',
          reason: 'second regulator',
        },
        {
          display_name: 'Electrical Industry Workers Union',
          kind: 'union',
          country: 'Malaysia',
          register: 'advocacy',
          reason: 'workers',
          wants: 'Consultation and back pay',
        },
        {
          display_name: 'Opposition MP for Johor',
          kind: 'political',
          country: 'Malaysia',
          register: 'political',
          reason: 'politics',
        },
        {
          display_name: 'Some Body',
          kind: 'cartel',
          country: 'Malaysia',
          register: 'advocacy',
          reason: 'bad kind',
        },
      ] as unknown as NonNullable<
        Parameters<typeof guardRailFootprint>[0]
      >['pressure_organisations'],
    };
    const labour = guardRailFootprint(proposals, DYSON, existing);
    assert.deepEqual(
      labour.pressure_organisations.map((p) => p.display_name),
      ['Ministry of Human Resources', 'Electrical Industry Workers Union'],
    );
    assert.equal(labour.pressure_organisations[1].wants, 'Consultation and back pay');
    const noLabour = guardRailFootprint(
      proposals,
      'A data breach at Dyson exposed customer emails in Singapore.',
      existing,
    );
    assert.deepEqual(
      noLabour.pressure_organisations.map((p) => p.kind),
      ['regulator'],
    );
    const political = guardRailFootprint(
      proposals,
      `${DYSON} The opposition has asked the minister to answer in parliament.`,
      existing,
    );
    assert.ok(political.pressure_organisations.some((p) => p.kind === 'political'));
  });
  test('labour + product safety allow two regulators per country; default register by kind', () => {
    const fp = guardRailFootprint(
      {
        pressure_organisations: [
          { display_name: 'Labour Dept', kind: 'regulator', country: 'Malaysia', reason: 'x' },
          {
            display_name: 'Product Safety Authority',
            kind: 'regulator',
            country: 'Malaysia',
            reason: 'x',
          },
          {
            display_name: 'Residents Association',
            kind: 'community_group',
            country: 'Malaysia',
            reason: 'x',
          },
        ] as unknown as NonNullable<
          Parameters<typeof guardRailFootprint>[0]
        >['pressure_organisations'],
      },
      `${DYSON} A batch of defective units was recalled.`,
      existing,
    );
    assert.equal(fp.pressure_organisations.filter((p) => p.kind === 'regulator').length, 2);
    assert.equal(
      fp.pressure_organisations.find((p) => p.kind === 'community_group')?.register,
      'grassroots',
    );
    assert.equal(fp.pressure_organisations[0].register, 'statutory');
  });
  test('null input yields only the entered countries and signals', () => {
    const fp = guardRailFootprint(null, DYSON, existing);
    assert.deepEqual(
      fp.countries.map((c) => c.name),
      ['Singapore'],
    );
    assert.equal(fp.implied_organisations.length, 0);
    assert.equal(fp.pressure_organisations.length, 0);
  });
});
