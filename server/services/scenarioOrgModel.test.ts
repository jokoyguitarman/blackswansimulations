import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES } from '../../shared/countries.js';
import {
  validateOrganisations,
  buildOrgRegistry,
  makePressureOrgKey,
  defaultRegisterFor,
  type OrganisationInput,
  type PressureOrgInput,
  type RosterEntryInput,
} from './scenarioOrgModel.js';

const roster = [{ team_name: 'Communications', is_public_voice: true }, { team_name: 'Legal' }];
const orgs: OrganisationInput[] = [
  { display_name: 'Sigma Logistics', country: 'Singapore', is_primary: true, team_roster: roster },
  {
    display_name: 'Sigma Logistics Malaysia',
    country: 'Malaysia',
    city: 'Johor Bahru',
    kind: 'office',
    is_primary: false,
    team_roster: roster,
    operation: 'ai',
  },
];

describe('pressure organisations (MO-PRS-001..003)', () => {
  test('normalises kind/register/targets and mints org_pressure_<slug>_<cc> keys', () => {
    const r = validateOrganisations(
      orgs,
      [],
      [
        { display_name: 'Ministry of Human Resources', kind: 'regulator', country: 'Malaysia' },
        {
          display_name: 'Electrical Industry Workers Union',
          kind: 'union',
          country: 'Malaysia',
          wants: 'Consultation first',
        },
        {
          display_name: 'Consumer Watch',
          kind: 'ngo',
          country: 'Singapore',
          targets_org_keys: ['primary', 'bogus'],
        },
      ],
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pressureOrgs.length, 3);
    const [mohr, union, ngo] = r.pressureOrgs;
    assert.match(
      mohr.org_key,
      /^org_pressure_ministry_of_human_resour\w*_my$/,
      'slug may be truncated by countrySlug',
    );
    assert.equal(mohr.register, 'statutory');
    assert.deepEqual(
      mohr.targets_org_keys,
      [r.orgs[1].org_key],
      'defaults to protagonists in its country',
    );
    assert.equal(union.register, 'advocacy');
    assert.equal(union.wants, 'Consultation first');
    assert.deepEqual(ngo.targets_org_keys, ['primary'], 'unknown targets dropped');
    assert.equal(defaultRegisterFor('community_group'), 'grassroots');
  });
  test('rejects unknown kinds, unknown countries and duplicate names', () => {
    const bad = (list: PressureOrgInput[]) => {
      const r = validateOrganisations(orgs, [], list);
      return r.ok ? null : r.code;
    };
    assert.equal(
      bad([
        { display_name: 'Body X', kind: 'cartel' as PressureOrgInput['kind'], country: 'Malaysia' },
      ]),
      'MO-PRS-002',
    );
    assert.equal(bad([{ display_name: 'Body X', kind: 'union', country: 'Narnia' }]), 'MO-PRS-002');
    assert.equal(
      bad([{ display_name: 'X', kind: 'union', country: 'Malaysia' }]),
      'MO-PRS-001',
      'name too short',
    );
    assert.equal(
      bad([{ display_name: 'Sigma Logistics', kind: 'union', country: 'Malaysia' }]),
      'MO-PRS-001',
      'name clash with a protagonist',
    );
  });
  test('accepts 7 pressure groups, and 60', () => {
    const list = (count: number): PressureOrgInput[] =>
      Array.from({ length: count }, (_, i) => ({
        display_name: `Watch body ${i}`,
        kind: 'ngo' as const,
        country: 'Malaysia',
      }));
    const seven = validateOrganisations(orgs, [], list(7));
    assert.ok(seven.ok);
    if (!seven.ok) return;
    assert.equal(seven.pressureOrgs.length, 7);
    const sixty = validateOrganisations(orgs, [], list(60));
    assert.ok(sixty.ok);
    if (!sixty.ok) return;
    assert.equal(sixty.pressureOrgs.length, 60);
    assert.equal(new Set(sixty.pressureOrgs.map((group) => group.org_key)).size, 60);
  });
  test('keys never collide', () => {
    const taken = new Set<string>();
    const a = makePressureOrgKey('Union', 'Malaysia', taken);
    const b = makePressureOrgKey('Union', 'Malaysia', taken);
    assert.equal(a, 'org_pressure_union_my');
    assert.equal(b, 'org_pressure_union_my_2');
  });
});

describe('AI-operated offices (MO-ORG-007)', () => {
  test('operation defaults to players; the primary can never be AI-operated', () => {
    const ok = validateOrganisations(orgs, []);
    assert.ok(ok.ok);
    if (!ok.ok) return;
    assert.equal(ok.orgs[0].operation, 'players');
    assert.equal(ok.orgs[1].operation, 'ai');
    const bad = validateOrganisations([{ ...orgs[0], operation: 'ai' }, orgs[1]], []);
    assert.ok(!bad.ok && bad.code === 'MO-ORG-007');
  });
});

describe('registry (contract §5.1 + v3.2)', () => {
  test('protagonists carry operation + one site; pressure entries carry side pressure + spokesperson', () => {
    const r = validateOrganisations(
      orgs,
      [{ name: 'Swift Freight', country: 'Malaysia' }],
      [
        {
          display_name: 'Ministry of Human Resources',
          kind: 'regulator',
          country: 'Malaysia',
          spokesperson_stakeholder_id: 'stk_mohr',
        },
      ],
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    const registry = buildOrgRegistry(r.orgs, r.competitors, null, r.pressureOrgs);
    const primary = registry.find((e) => e.org_key === 'primary')!;
    assert.equal(primary.operation, 'players');
    assert.equal(primary.sites?.length, 1);
    assert.equal(primary.sites?.[0].country, 'Singapore');
    const slm = registry.find((e) => e.side === 'protagonist' && e.org_key !== 'primary')!;
    assert.equal(slm.operation, 'ai');
    assert.equal(slm.sites?.[0].city, 'Johor Bahru');
    const pressure = registry.find((e) => e.side === 'pressure')!;
    assert.equal(pressure.kind, 'regulator');
    assert.equal(pressure.spokesperson_stakeholder_id, 'stk_mohr');
    assert.equal(registry.filter((e) => e.side === 'antagonist').length, 1);
  });
});

function rosterOf(count: number): RosterEntryInput[] {
  const presets = [
    'Communications',
    'Legal',
    'Stakeholder Engagement',
    'Shareholder Engagement',
    'Executive',
  ];
  const teams: RosterEntryInput[] = presets
    .slice(0, Math.min(count, presets.length))
    .map((team_name) => ({
      team_name,
      is_public_voice: team_name === 'Communications',
    }));
  for (let i = teams.length; i < count; i++) {
    teams.push({
      team_name: `Desk ${i}`,
      description: `Handles the day to day work of desk ${i}`,
      is_custom: true,
      is_public_voice: false,
    });
  }
  return teams;
}

describe('large casts', () => {
  test('12 protagonists with 9 teams each get unique keys and composed names', () => {
    const input: OrganisationInput[] = COUNTRIES.slice(0, 12).map((country, index) => ({
      display_name: `${country.name} Response`,
      short_name: `R${index}`,
      country: country.name,
      is_primary: index === 0,
      team_roster: rosterOf(9),
    }));
    const result = validateOrganisations(input, []);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.orgs.length, 12);
    assert.equal(new Set(result.orgs.map((org) => org.org_key)).size, 12);
    assert.equal(result.orgs[0].org_key, 'primary');
    const names = result.orgs.flatMap((org) => org.teams.map((team) => team.team_name));
    assert.equal(names.length, 12 * 9);
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
    assert.ok(names.every((name) => name.includes('—')));
  });

  test('30 rivals get unique antagonist keys', () => {
    const rivals = Array.from({ length: 30 }, (_, index) => ({
      name: `Rival Brand ${index}`,
      country: 'Singapore',
    }));
    const result = validateOrganisations([orgs[0]], rivals);
    assert.ok(result.ok);
    if (!result.ok) return;
    const keys = result.competitors.map((rival) => rival.org_key);
    assert.equal(keys.length, 30);
    assert.ok(keys.every((key) => key.startsWith('org_antagonist_')));
    assert.equal(new Set(keys).size, 30);
  });

  test('one pressure group can target 20 protagonists', () => {
    const input: OrganisationInput[] = COUNTRIES.slice(0, 20).map((country, index) => ({
      display_name: `${country.name} Desk`,
      short_name: `D${index}`,
      country: country.name,
      is_primary: index === 0,
      team_roster: roster,
    }));
    const cast = validateOrganisations(input, []);
    assert.ok(cast.ok);
    if (!cast.ok) return;
    const keys = cast.orgs.map((org) => org.org_key);
    const pressed = validateOrganisations(
      input,
      [],
      [
        {
          display_name: 'Regional Watch',
          kind: 'ngo',
          country: input[0].country,
          targets_org_keys: keys,
        },
      ],
    );
    assert.ok(pressed.ok);
    if (!pressed.ok) return;
    assert.equal(pressed.pressureOrgs[0].targets_org_keys.length, 20);
    assert.deepEqual(new Set(pressed.pressureOrgs[0].targets_org_keys), new Set(keys));
  });
});

describe('rival descriptions', () => {
  test('keeps a trimmed description and reuses a well-formed antagonist key', () => {
    const r = validateOrganisations(orgs, [
      {
        name: 'Apex Systems',
        country: 'Singapore',
        description: '  Positions itself as the safer alternative  ',
        org_key: 'org_antagonist_apex_custom',
      },
      { name: 'Northwind', country: 'Malaysia', org_key: 'not-a-key' },
    ]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.competitors[0].description, 'Positions itself as the safer alternative');
    assert.equal(r.competitors[0].org_key, 'org_antagonist_apex_custom');
    assert.equal(r.competitors[1].description, undefined);
    assert.match(r.competitors[1].org_key, /^org_antagonist_/);
    assert.notEqual(r.competitors[1].org_key, 'not-a-key');
  });
});
