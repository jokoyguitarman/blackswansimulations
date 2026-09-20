import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StakeholderSchema,
  StakeholdersSchema,
  OrgRegistrySchema,
  isStakeholderVisibleToTeam,
  resolveTeamFunction,
  toPlayerVisible,
  criteriaThreshold,
  ALLOWED_VERDICTS,
  sheetLabel,
  isInjectKeyCondition,
  type Stakeholder,
} from './stakeholderContract.js';

const base = (over: Partial<Stakeholder> = {}): Stakeholder =>
  StakeholderSchema.parse({
    id: 'stk_meridian_jtan',
    name: 'Jasmine Tan',
    title: 'Head of Procurement',
    organisation: 'Meridian Logistics',
    relationship: 'client',
    owning_team: 'Sales',
    org_key: null,
    email: 'jasmine.tan@meridian.sim',
    phone: '+65 6123 4567',
    handle: '@jtan_meridian',
    note: 'Key account.',
    personality: 'Direct.',
    stance: 'Alarmed.',
    knowledge: ['3 containers in transit'],
    will_not_disclose: [],
    grievance: 'No contact since the story broke.',
    resolution_criteria: ['Told whether batch is affected', 'Given a named contact'],
    persuadability: 'medium',
    hard_constraints: [],
    ...over,
  });

describe('resolveTeamFunction', () => {
  test('prefers function_key, falls back to team_name', () => {
    assert.equal(
      resolveTeamFunction({ team_name: 'Communications — PNP', function_key: 'Communications' }),
      'Communications',
    );
    assert.equal(resolveTeamFunction({ team_name: 'Sales', function_key: null }), 'Sales');
    assert.equal(resolveTeamFunction({ team_name: 'Sales' }), 'Sales');
  });
});

describe('isStakeholderVisibleToTeam', () => {
  const sales = { team_name: 'Sales', function_key: null, org_key: null };
  const commsPNP = {
    team_name: 'Communications — PNP',
    function_key: 'Communications',
    org_key: 'org_pnp',
  };
  const commsNBI = {
    team_name: 'Communications — NBI',
    function_key: 'Communications',
    org_key: 'org_nbi',
  };
  const invPNP = {
    team_name: 'Investigations — PNP',
    function_key: 'Investigations',
    org_key: 'org_pnp',
  };
  const invNBI = {
    team_name: 'Investigations — NBI',
    function_key: 'Investigations',
    org_key: 'org_nbi',
  };

  test('single-org: exact team name matches, other teams do not', () => {
    const s = base({ owning_team: 'Sales', org_key: null });
    assert.equal(isStakeholderVisibleToTeam(s, sales), true);
    assert.equal(
      isStakeholderVisibleToTeam(s, { team_name: 'Legal', function_key: null, org_key: null }),
      false,
    );
  });

  test('common stakeholder is visible to every team sharing the function', () => {
    const maria = base({ owning_team: 'Communications', org_key: null });
    assert.equal(isStakeholderVisibleToTeam(maria, commsPNP), true);
    assert.equal(isStakeholderVisibleToTeam(maria, commsNBI), true);
    assert.equal(isStakeholderVisibleToTeam(maria, invPNP), false);
  });

  test('org-specific stakeholder is visible only to the same function in the same org', () => {
    const informant = base({ owning_team: 'Investigations', org_key: 'org_pnp' });
    assert.equal(isStakeholderVisibleToTeam(informant, invPNP), true);
    assert.equal(isStakeholderVisibleToTeam(informant, invNBI), false);
    assert.equal(isStakeholderVisibleToTeam(informant, commsPNP), false);
  });

  test('team with null org_key sees org-specific stakeholders of its function', () => {
    const s = base({ owning_team: 'Sales', org_key: 'sg_hq' });
    assert.equal(isStakeholderVisibleToTeam(s, sales), true);
  });

  test('custom team without function_key matches by exact name', () => {
    const s = base({ owning_team: 'Field Ops', org_key: null });
    assert.equal(
      isStakeholderVisibleToTeam(s, { team_name: 'Field Ops', function_key: null, org_key: null }),
      true,
    );
  });

  test('v1-style data: owning_team equal to a composed team_name still matches', () => {
    const s = base({ owning_team: 'Communications — PNP', org_key: null });
    assert.equal(isStakeholderVisibleToTeam(s, commsPNP), true);
    assert.equal(isStakeholderVisibleToTeam(s, commsNBI), false);
  });
});

describe('toPlayerVisible', () => {
  test('drops every hidden field and keeps contact fields', () => {
    const v = toPlayerVisible(base({ sensitivities: ['any change to Johor headcount'] })) as Record<
      string,
      unknown
    >;
    for (const hidden of [
      'personality',
      'stance',
      'knowledge',
      'will_not_disclose',
      'grievance',
      'resolution_criteria',
      'persuadability',
      'hard_constraints',
      'latent_grievances',
      'sensitivities',
    ]) {
      assert.equal(hidden in v, false, `${hidden} leaked`);
    }
    assert.equal(v.email, 'jasmine.tan@meridian.sim');
    assert.equal(v.handle, '@jtan_meridian');
    assert.equal(v.note, 'Key account.');
  });

  test('keeps v3.2 structural fields (kind, members, tier, site_key)', () => {
    const v = toPlayerVisible(
      base({ kind: 'group', members: ['stk_a', 'stk_b'], tier: 'principal', site_key: 'johor' }),
    ) as Record<string, unknown>;
    assert.equal(v.kind, 'group');
    assert.deepEqual(v.members, ['stk_a', 'stk_b']);
    assert.equal(v.tier, 'principal');
    assert.equal(v.site_key, 'johor');
  });
});

describe('StakeholderSchema', () => {
  test('rejects uppercase email, bad handle, bad id', () => {
    assert.equal(StakeholderSchema.safeParse({ ...base(), email: 'Jasmine@x.sim' }).success, false);
    assert.equal(StakeholderSchema.safeParse({ ...base(), handle: 'jtan' }).success, false);
    assert.equal(StakeholderSchema.safeParse({ ...base(), id: 'Stk-1' }).success, false);
  });

  test('grievance and criteria must agree', () => {
    assert.equal(
      StakeholderSchema.safeParse({ ...base(), grievance: '', resolution_criteria: ['x'] }).success,
      false,
    );
    assert.equal(
      StakeholderSchema.safeParse({ ...base(), grievance: 'x', resolution_criteria: [] }).success,
      false,
    );
    assert.equal(
      StakeholderSchema.safeParse({ ...base(), grievance: '', resolution_criteria: [] }).success,
      true,
    );
  });

  test('still parses retired latent_grievances and preserves unknown keys', () => {
    const parsed = StakeholderSchema.parse({
      ...base(),
      latent_grievances: {
        recall_all: {
          grievance: 'g',
          resolution_criteria: ['c'],
          persuadability: 'low',
          hard_constraints: [],
          eruption_inject_keys: ['inj_a'],
        },
      },
      future_field: 42,
    }) as Record<string, unknown>;
    assert.ok(parsed.latent_grievances);
    assert.equal(parsed.future_field, 42);
  });

  test('array form rejects duplicate email/handle/id', () => {
    const a = base();
    const b = base({ id: 'stk_other', handle: '@other_h' }); // same email
    assert.equal(StakeholdersSchema.safeParse([a, b]).success, false);
    const c = base({ id: 'stk_other', email: 'other@x.sim' }); // same handle
    assert.equal(StakeholdersSchema.safeParse([a, c]).success, false);
    const d = base({ id: 'stk_other', email: 'other@x.sim', handle: '@other_h' });
    assert.equal(StakeholdersSchema.safeParse([a, d]).success, true);
  });
});

describe('OrgRegistrySchema', () => {
  test('rejects duplicate org_key and two primaries', () => {
    const a = {
      org_key: 'a',
      display_name: 'A',
      country: 'X',
      side: 'protagonist',
      is_primary: true,
    };
    assert.equal(OrgRegistrySchema.safeParse([a, { ...a }]).success, false);
    assert.equal(OrgRegistrySchema.safeParse([a, { ...a, org_key: 'b' }]).success, false);
    assert.equal(
      OrgRegistrySchema.safeParse([a, { ...a, org_key: 'b', is_primary: false }]).success,
      true,
    );
  });
});

describe('persuadability rules', () => {
  test('criteriaThreshold table', () => {
    assert.equal(criteriaThreshold('none', 3), Number.POSITIVE_INFINITY);
    assert.equal(criteriaThreshold('low', 3), Number.POSITIVE_INFINITY);
    assert.equal(criteriaThreshold('medium', 3), 3);
    assert.equal(criteriaThreshold('high', 3), 2);
    assert.equal(criteriaThreshold('high', 1), 1);
  });
  test('allowed verdict sets', () => {
    assert.equal(ALLOWED_VERDICTS.none.has('cancel'), false);
    assert.equal(ALLOWED_VERDICTS.none.has('delay'), false);
    assert.equal(ALLOWED_VERDICTS.low.has('delay'), true);
    assert.equal(ALLOWED_VERDICTS.low.has('cancel'), false);
    assert.equal(ALLOWED_VERDICTS.medium.has('cancel'), true);
  });
});

describe('misc', () => {
  test('sheetLabel and inject_key condition detection', () => {
    assert.equal(sheetLabel('client'), 'Clients');
    assert.equal(sheetLabel('other'), 'Other');
    assert.equal(isInjectKeyCondition('inject_published:inj_a'), true);
    assert.equal(isInjectKeyCondition('inject_cancelled:inj_a'), true);
    // Retired menu-layer primitive: no longer recognised.
    assert.equal(isInjectKeyCondition('decision_recorded:recall_all'), false);
    assert.equal(isInjectKeyCondition('gate_met:x'), false);
  });
});
