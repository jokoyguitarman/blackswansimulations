import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOrganisations,
  buildOrgRegistry,
  makePressureOrgKey,
  defaultRegisterFor,
  type OrganisationInput,
  type PressureOrgInput,
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
  test('rejects unknown kinds, unknown countries, duplicate names and > 6 entries', () => {
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
    assert.equal(
      bad(
        Array.from({ length: 7 }, (_, i) => ({
          display_name: `Body ${i}`,
          kind: 'ngo' as const,
          country: 'Malaysia',
        })),
      ),
      'MO-PRS-001',
    );
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
