import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCastGaps,
  buildRosterAndList,
  notificationSopSteps,
  ownerFunctionFor,
  validateCast,
  defaultSensitivities,
  detectLabourSignal,
  sitesFor,
  MIN_ROSTER_FOR_VALIDATION,
  ROSTER_SIZE,
} from './castCompletenessService.js';
import type { NormalisedOrg, OrgTeamCharter } from './scenarioOrgModel.js';
import { newTakenIdentifiers } from './multiOrgGenerationService.js';
import type { Stakeholder } from '../lib/stakeholderContract.js';

const org: NormalisedOrg = {
  org_key: 'org_slm_my',
  display_name: 'Sigma Logistics Malaysia',
  short_name: 'SLM',
  country: 'Malaysia',
  city: 'Johor Bahru',
  kind: 'office',
  is_primary: false,
  teams: [],
  operation: 'players',
};
const charter = (function_key: string, mission = ''): OrgTeamCharter =>
  ({
    team_name: `${function_key} — SLM`,
    mission,
    responsibilities: [],
    expected_actions: [],
    scoring_rubric: '',
    out_of_lane: [],
    min_participants: 1,
    max_participants: 4,
    org_key: 'org_slm_my',
    function_key,
    country: 'Malaysia',
    short_name: 'SLM',
  }) as unknown as OrgTeamCharter;
const charters = [
  charter('Communications'),
  charter('Stakeholder Engagement'),
  charter('Legal'),
  charter('Executive'),
];

const stk = (over: Partial<Stakeholder> & { id: string }): Stakeholder => ({
  name: over.id,
  title: 'Contact',
  organisation: 'Sigma Logistics Malaysia',
  relationship: 'internal',
  owning_team: 'Stakeholder Engagement',
  org_key: 'org_slm_my',
  email: `${over.id}@slm.sim`,
  phone: null,
  handle: `@${over.id}`,
  note: '',
  personality: '',
  stance: '',
  knowledge: [],
  will_not_disclose: [],
  grievance: '',
  resolution_criteria: [],
  persuadability: 'medium',
  hard_constraints: [],
  ...over,
});

describe('signals + owners', () => {
  test('labour signal detection', () => {
    assert.equal(
      detectLabourSignal('Unfair labour practices at the Johor factory; workers on night shift'),
      true,
    );
    assert.equal(detectLabourSignal('A data breach exposed customer emails'), false);
  });
  test('owner function by role prefers HR-like custom teams, then presets', () => {
    const withHr = [
      ...charters,
      charter('People Ops', 'Looks after employees, HR policy and welfare.'),
    ];
    assert.equal(ownerFunctionFor('hr_counterpart', withHr), 'People Ops');
    assert.equal(ownerFunctionFor('hr_counterpart', charters), 'Stakeholder Engagement');
    assert.equal(ownerFunctionFor('regulator', charters), 'Legal');
    assert.equal(ownerFunctionFor('local_reporter', charters), 'Communications');
    assert.equal(ownerFunctionFor('site_leader', charters), 'Executive');
    assert.equal(
      ownerFunctionFor(
        'exec_assistant',
        charters.filter((c) => c.function_key !== 'Executive'),
      ),
      null,
    );
  });
});

describe('gap detection', () => {
  test('an empty cast misses every carrier; labour adds rep/roster/list; Executive adds the shadow', () => {
    const gaps = detectCastGaps(org, charters, [], { labourSignal: true, multiOrg: true });
    assert.equal(gaps.length, 1);
    assert.deepEqual(
      gaps[0].missing.sort(),
      [
        'board_contact',
        'distribution_list',
        'exec_assistant',
        'hr_counterpart',
        'local_reporter',
        'regulator',
        'roster',
        'site_leader',
        'workforce_rep',
      ].sort(),
    );
    const noLabour = detectCastGaps(
      org,
      charters.filter((c) => c.function_key !== 'Executive'),
      [],
      { labourSignal: false, multiOrg: true },
    );
    assert.deepEqual(noLabour[0].missing.sort(), [
      'hr_counterpart',
      'local_reporter',
      'regulator',
      'site_leader',
    ]);
  });
  test('existing carriers are recognised by relationship + title, scoped to the organisation', () => {
    const site = sitesFor(org)[0];
    const cast = [
      stk({ id: 'mgr', title: 'Depot Manager (Johor)', site_key: site.site_key }),
      stk({ id: 'hr', title: 'HR Business Partner', site_key: site.site_key }),
      stk({ id: 'rep', title: 'Branch Secretary', relationship: 'union', organisation: 'Union' }),
      stk({ id: 'rep_sg', title: 'Reporter', relationship: 'media', org_key: 'primary' }),
      stk({ id: 'reg', title: 'Officer', relationship: 'regulator', org_key: null }),
    ];
    const gaps = detectCastGaps(
      org,
      charters.filter((c) => c.function_key !== 'Executive'),
      cast,
      { labourSignal: true, multiOrg: true },
    );
    assert.deepEqual(
      gaps[0].missing.sort(),
      ['distribution_list', 'local_reporter', 'roster'],
      'the SG-only reporter does not count for SLM; the common regulator does',
    );
  });
});

describe('roster + list synthesis (deterministic)', () => {
  test('roster entries carry tier/site/sensitivities; the list resolves to the roster and is owned by the same function', () => {
    const site = sitesFor(org)[0];
    const out = buildRosterAndList(org, site, 'Stakeholder Engagement', newTakenIdentifiers(), {
      labourSignal: true,
      multiOrg: true,
    });
    const roster = out.filter((s) => s.tier === 'roster');
    const list = out.find((s) => s.kind === 'group')!;
    assert.equal(roster.length, ROSTER_SIZE);
    assert.ok(
      roster.every(
        (r) =>
          r.site_key === site.site_key &&
          r.org_key === 'org_slm_my' &&
          r.grievance === '' &&
          (r.sensitivities?.length ?? 0) > 0,
      ),
    );
    assert.ok(new Set(out.map((s) => s.id)).size === out.length, 'unique ids');
    assert.ok(new Set(out.map((s) => s.email)).size === out.length, 'unique emails');
    assert.deepEqual(
      list.members,
      roster.map((r) => r.id),
    );
    assert.equal(list.owning_team, 'Stakeholder Engagement');
    assert.ok(/all-staff/.test(list.email));
    assert.ok(
      roster.every((r) => /^[a-z0-9_]+$/.test(r.id) && /^@[a-z0-9_]{3,30}$/.test(r.handle)),
      'contract-shaped ids and handles',
    );
  });
  test('single-org scenarios keep org_key null on roster entries', () => {
    const out = buildRosterAndList(
      { ...org, org_key: 'primary' },
      sitesFor(org)[0],
      'Stakeholder Engagement',
      newTakenIdentifiers(),
      { labourSignal: true, multiOrg: false },
      6,
    );
    assert.ok(out.every((s) => s.org_key === null));
  });
});

describe('notification SOP + sensitivities', () => {
  test('four ordered steps owned by the HR-like function (public statement by Communications)', () => {
    const steps = notificationSopSteps('People Ops', 'Communications', ['SLM — Johor Bahru']);
    assert.deepEqual(
      steps.map((s) => s.step_id),
      [
        'brief_site_leadership',
        'notify_workforce_representatives',
        'notify_affected_employees',
        'public_statement_after_staff',
      ],
    );
    assert.ok(
      steps
        .slice(0, 3)
        .every((s) => s.owner_function === 'People Ops' && s.trigger === 'decision_notification'),
    );
    assert.equal(steps[3].owner_function, 'Communications');
    assert.deepEqual(steps[1].must_precede, ['notify_affected_employees']);
  });
  test('default sensitivities depend on relationship', () => {
    assert.match(
      defaultSensitivities(stk({ id: 'r', relationship: 'regulator' }), 'Sigma', 'Malaysia')[0],
      /compliance|statutory/i,
    );
    assert.match(
      defaultSensitivities(stk({ id: 'u', relationship: 'union' }), 'Sigma', null)[0],
      /jobs|shifts|pay/i,
    );
  });
});

describe('validateCast (MO-CAST-*)', () => {
  const teams = charters.map((c) => ({
    team_name: c.team_name,
    function_key: c.function_key,
    org_key: c.org_key,
  }));
  const protagonists = [{ org_key: 'org_slm_my', display_name: 'SLM', country: 'Malaysia' }];
  const site = sitesFor(org)[0];
  const full = () => [
    stk({ id: 'mgr', title: 'Depot Manager', site_key: site.site_key }),
    stk({ id: 'hr', title: 'HR Business Partner', site_key: site.site_key }),
    stk({ id: 'rep', title: 'Branch Secretary', relationship: 'union' }),
    stk({ id: 'rep_media', title: 'Reporter', relationship: 'media' }),
    stk({ id: 'reg', title: 'Officer', relationship: 'regulator' }),
    ...buildRosterAndList(org, site, 'Stakeholder Engagement', newTakenIdentifiers(), {
      labourSignal: true,
      multiOrg: true,
    }),
  ];
  test('a complete labour cast passes', () => {
    assert.deepEqual(
      validateCast(full(), teams, protagonists, {
        labourSignal: true,
        injectsByStakeholder: new Map(),
      }),
      [],
    );
  });
  test('each carrier gap has its own code', () => {
    const codes = (cast: Stakeholder[], labour = true) =>
      validateCast(cast, teams, protagonists, {
        labourSignal: labour,
        injectsByStakeholder: new Map(),
      }).map((i) => i.code);
    assert.ok(codes(full().filter((s) => s.id !== 'mgr')).includes('MO-CAST-001'));
    assert.ok(codes(full().filter((s) => s.id !== 'hr')).includes('MO-CAST-002'));
    assert.ok(codes(full().filter((s) => s.id !== 'rep')).includes('MO-CAST-003'));
    assert.ok(
      codes(
        full()
          .filter((s) => s.tier !== 'roster')
          .slice(0, 5),
      ).includes('MO-CAST-004'),
    );
    assert.ok(codes(full().filter((s) => s.id !== 'rep_media')).includes('MO-CAST-005'));
    assert.ok(codes(full().filter((s) => s.id !== 'reg')).includes('MO-CAST-006'));
    assert.ok(
      !codes(
        full().filter((s) => s.id !== 'rep'),
        false,
      ).includes('MO-CAST-003'),
      'no labour signal → no rep required',
    );
  });
  test('roster entries never author injects (MO-CAST-007); list owner must match members (MO-CAST-008)', () => {
    const cast = full();
    const rosterId = cast.find((s) => s.tier === 'roster')!.id;
    const issues = validateCast(cast, teams, protagonists, {
      labourSignal: true,
      injectsByStakeholder: new Map([[rosterId, 1]]),
    });
    assert.ok(issues.some((i) => i.code === 'MO-CAST-007'));
    const list = cast.find((s) => s.kind === 'group')!;
    list.owning_team = 'Legal';
    assert.ok(
      validateCast(cast, teams, protagonists, {
        labourSignal: true,
        injectsByStakeholder: new Map(),
      }).some((i) => i.code === 'MO-CAST-008'),
    );
    assert.ok(MIN_ROSTER_FOR_VALIDATION <= ROSTER_SIZE);
  });
});
