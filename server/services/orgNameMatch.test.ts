import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifyOrgName,
  orgNamesMatch,
  matchGeneratedOrgsToRoster,
  repairOrgPageKeys,
} from './orgNameMatch.js';

/**
 * Regression for the 23 Sep compile failure: the page generator asked for
 * "Dyson Malaysia (local office / operations)", the model answered "Dyson Malaysia", the
 * exact-name lookup missed, the page shipped with a minted key
 * (org_protagonist_dyson_malaysia_0) and compile failed MO-ORG-005 after a full build.
 */

const ALLY_MY = {
  name: 'Dyson Malaysia (local office / operations)',
  org_key: 'org_dyson_malaysia_my',
  country: 'Malaysia',
  kind: 'office',
};
const ALLY_HR = {
  name: 'Dyson Global Responsible Sourcing / Human Rights & Ethics function',
  org_key: 'org_dyson_global_sg',
  country: 'Singapore',
};
const COMP_MIELE = { name: 'Miele', org_key: 'org_antagonist_miele_0', country: 'Germany' };

describe('simplifyOrgName / orgNamesMatch', () => {
  test('strips parentheticals and punctuation', () => {
    assert.equal(simplifyOrgName('Dyson Malaysia (local office / operations)'), 'dyson malaysia');
    assert.equal(simplifyOrgName('  Miele & Cie. KG  '), 'miele cie kg');
  });

  test('paraphrased name matches the requested one', () => {
    assert.ok(orgNamesMatch('Dyson Malaysia', ALLY_MY.name));
    assert.ok(orgNamesMatch('Dyson Malaysia Sdn Bhd', ALLY_MY.name));
    assert.ok(orgNamesMatch('Miele Germany', 'Miele'));
    assert.ok(
      orgNamesMatch(
        'Maritime and Port Authority',
        'Maritime and Port Authority of Singapore (MPA)',
      ),
    );
  });

  test('different organisations do not match', () => {
    assert.equal(
      orgNamesMatch('Ministry of Manpower', 'Ministry of Human Resources (Malaysia)'),
      false,
    );
    assert.equal(orgNamesMatch('Shark Ninja', 'Miele'), false);
    assert.equal(orgNamesMatch('', 'Miele'), false);
  });
});

describe('matchGeneratedOrgsToRoster', () => {
  test('refs are honoured regardless of the echoed name', () => {
    const r = matchGeneratedOrgsToRoster(
      [
        { ref: 'C1', org_role: 'antagonist', display_name: 'Miele Group' },
        { ref: 'A1', org_role: 'protagonist', display_name: 'Dyson MY Ops' },
      ],
      [ALLY_MY],
      [COMP_MIELE],
      false,
    );
    assert.equal(r.dropped.length, 0);
    assert.equal(r.unmatched.length, 0);
    assert.deepEqual(
      r.matches.map((m) => [m.index, m.role, m.requested?.org_key, m.via]),
      [
        [0, 'antagonist', COMP_MIELE.org_key, 'ref'],
        [1, 'protagonist', ALLY_MY.org_key, 'ref'],
      ],
    );
  });

  test('the 23 Sep case: no ref, paraphrased name, still lands on the registry key', () => {
    const r = matchGeneratedOrgsToRoster(
      [
        { org_role: 'protagonist', display_name: 'Dyson Malaysia' },
        { org_role: 'antagonist', display_name: 'Miele' },
      ],
      [ALLY_MY],
      [COMP_MIELE],
      false,
    );
    assert.equal(r.matches[0].requested?.org_key, ALLY_MY.org_key);
    assert.equal(r.matches[0].via, 'name');
    assert.equal(r.matches[1].requested?.org_key, COMP_MIELE.org_key);
    assert.equal(r.dropped.length, 0);
  });

  test('a renamed page falls back to position when counts line up', () => {
    const r = matchGeneratedOrgsToRoster(
      [{ org_role: 'protagonist', display_name: 'Regional Distribution Centre' }],
      [{ name: 'Northstar Logistics', org_key: 'org_northstar_sg' }],
      [],
      false,
    );
    assert.equal(r.matches[0].requested?.org_key, 'org_northstar_sg');
    assert.equal(r.matches[0].via, 'position');
  });

  test('two allies, one paraphrased and one renamed: name first, position for the rest', () => {
    const r = matchGeneratedOrgsToRoster(
      [
        { org_role: 'protagonist', display_name: 'Dyson Responsible Sourcing' },
        { org_role: 'protagonist', display_name: 'Johor Operations' },
      ],
      [ALLY_MY, ALLY_HR],
      [],
      false,
    );
    const byIndex = new Map(r.matches.map((m) => [m.index, m]));
    assert.equal(byIndex.get(0)?.requested?.org_key, ALLY_HR.org_key);
    assert.equal(byIndex.get(0)?.via, 'name');
    assert.equal(byIndex.get(1)?.requested?.org_key, ALLY_MY.org_key);
    assert.equal(byIndex.get(1)?.via, 'position');
    assert.equal(r.unmatched.length, 0);
  });

  test('invented rival is kept only when inventing is allowed', () => {
    const raw = [
      { ref: 'NEW', org_role: 'antagonist', display_name: 'Shark Ninja', auto_generated: true },
    ];
    const on = matchGeneratedOrgsToRoster(raw, [], [], true);
    assert.equal(on.matches[0].requested, null);
    assert.equal(on.matches[0].via, 'invented');
    const off = matchGeneratedOrgsToRoster(raw, [], [], false);
    assert.equal(off.matches.length, 0);
    assert.equal(off.dropped.length, 1);
  });

  test('a hallucinated protagonist page is dropped, never given a minted key', () => {
    const r = matchGeneratedOrgsToRoster(
      [
        { org_role: 'protagonist', display_name: 'Dyson Malaysia' },
        { org_role: 'protagonist', display_name: 'Dyson Foundation' },
      ],
      [ALLY_MY],
      [],
      false,
    );
    assert.equal(r.matches.length, 1);
    assert.equal(r.dropped.length, 1);
    assert.match(r.dropped[0].reason, /Dyson Foundation/);
  });

  test('a page whose role the model flipped is matched by name to the other role', () => {
    const r = matchGeneratedOrgsToRoster(
      [{ org_role: 'antagonist', display_name: 'Dyson Malaysia' }],
      [ALLY_MY],
      [],
      false,
    );
    assert.equal(r.matches[0].role, 'protagonist');
    assert.equal(r.matches[0].requested?.org_key, ALLY_MY.org_key);
  });

  test('requested organisations without a page are reported', () => {
    const r = matchGeneratedOrgsToRoster([], [ALLY_MY], [COMP_MIELE], false);
    assert.deepEqual(
      r.unmatched.map((u) => [u.role, u.requested.org_key]),
      [
        ['protagonist', ALLY_MY.org_key],
        ['antagonist', COMP_MIELE.org_key],
      ],
    );
  });
});

describe('repairOrgPageKeys', () => {
  const registry = [
    { org_key: 'primary', display_name: 'Dyson', short_name: 'Dyson', country: 'Singapore' },
    {
      org_key: ALLY_MY.org_key,
      display_name: ALLY_MY.name,
      short_name: 'Dyson MY',
      country: 'Malaysia',
    },
  ];
  const competitors = [{ org_key: COMP_MIELE.org_key, name: 'Miele', country: 'Germany' }];
  const page = (
    p: Partial<{
      org_key: string;
      display_name: string;
      role: string;
      is_primary: boolean;
      auto_generated: boolean;
      country: string;
    }>,
  ) => ({
    org_key: 'x',
    display_name: 'x',
    role: 'protagonist',
    ...p,
  });

  test('known keys, the primary and pressure pages are untouched', () => {
    const pages = [
      page({ org_key: 'primary', display_name: 'Dyson', is_primary: true }),
      page({ org_key: ALLY_MY.org_key, display_name: 'Dyson Malaysia' }),
      page({ org_key: 'prs_union_1', display_name: 'Labour Movement', role: 'pressure' }),
    ];
    const r = repairOrgPageKeys(pages, registry, competitors);
    assert.deepEqual(r.pages, pages);
    assert.equal(r.fixes.length, 0);
    assert.equal(r.dropped.length, 0);
  });

  test('the failing payload: minted protagonist key is rewritten to the registry key', () => {
    const r = repairOrgPageKeys(
      [page({ org_key: 'org_protagonist_dyson_malaysia_0', display_name: 'Dyson Malaysia' })],
      registry,
      competitors,
    );
    assert.equal(r.pages[0].org_key, ALLY_MY.org_key);
    assert.equal(r.pages[0].country, 'Malaysia');
    assert.deepEqual(
      r.fixes.map((f) => [f.from, f.to, f.via]),
      [['org_protagonist_dyson_malaysia_0', ALLY_MY.org_key, 'name']],
    );
  });

  test('with one unclaimed candidate an unrecognisable name is placed by elimination', () => {
    const r = repairOrgPageKeys(
      [page({ org_key: 'org_protagonist_johor_ops_0', display_name: 'Johor Operations' })],
      registry,
      competitors,
    );
    assert.equal(r.pages[0].org_key, ALLY_MY.org_key);
    assert.equal(r.fixes[0].via, 'only_candidate');
  });

  test('antagonist pages are repaired against the named competitors; invented rivals pass through', () => {
    const r = repairOrgPageKeys(
      [
        page({
          org_key: 'org_antagonist_miele_group_1',
          display_name: 'Miele Group',
          role: 'antagonist',
        }),
        page({
          org_key: 'org_antagonist_shark_ninja_2',
          display_name: 'Shark Ninja',
          role: 'antagonist',
          auto_generated: true,
        }),
      ],
      registry,
      competitors,
    );
    assert.equal(r.pages[0].org_key, COMP_MIELE.org_key);
    assert.equal(r.pages[1].org_key, 'org_antagonist_shark_ninja_2');
    assert.equal(r.dropped.length, 0);
  });

  test('a candidate is claimed once; the second orphan is dropped', () => {
    const r = repairOrgPageKeys(
      [
        page({ org_key: 'org_protagonist_a_0', display_name: 'Dyson Malaysia' }),
        page({ org_key: 'org_protagonist_b_1', display_name: 'Dyson Foundation' }),
      ],
      registry,
      competitors,
    );
    assert.equal(r.pages.length, 1);
    assert.equal(r.pages[0].org_key, ALLY_MY.org_key);
    assert.equal(r.dropped.length, 1);
    assert.equal(r.dropped[0].display_name, 'Dyson Foundation');
  });
});
