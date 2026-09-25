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
  carrierRoleOf,
  isCarrier,
  stampCarrier,
  ensureRequiredCarriers,
  MIN_ROSTER_FOR_VALIDATION,
  ROSTER_SIZE,
} from './castCompletenessService.js';
import type { NormalisedOrg, OrgTeamCharter, OrganisationInput } from './scenarioOrgModel.js';
import { newTakenIdentifiers } from './multiOrgGenerationService.js';
import { buildCompileArtifacts, resolveOrganisations } from './multiOrgPipeline.js';
import { StakeholdersSchema, type Stakeholder } from '../lib/stakeholderContract.js';

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

/**
 * Regression for the 25 Sep compile failure (Western Mindanao Command / ESSCOM / Indonesian MFA /
 * TNI): cast completion generated a site leader and HR counterpart for every organisation, the
 * model titled them authentically for a military or a ministry, and the validator — which
 * re-identified carriers from corporate title words — reported MO-CAST-001/002 after a full build.
 */
describe('carrier tags and public-sector titles', () => {
  const site = (title: string) => isCarrier(stk({ id: 'x', title }), 'site_leader');
  const hr = (title: string) => isCarrier(stk({ id: 'x', title }), 'hr_counterpart');

  test('a tagged carrier counts whatever its title, and the tag fixes its relationship', () => {
    const untagged = stk({
      id: 'dir_pwni',
      title: 'Director for the Protection of Indonesian Nationals',
      relationship: 'other',
    });
    assert.equal(isCarrier({ ...untagged, relationship: 'internal' }, 'site_leader'), false);
    const tagged = stampCarrier({ ...untagged }, 'site_leader');
    assert.equal(carrierRoleOf(tagged), 'site_leader');
    assert.equal(tagged.relationship, 'internal');
    assert.ok(isCarrier(tagged, 'site_leader'));
    assert.equal(isCarrier(tagged, 'hr_counterpart'), false);

    const liaison = stampCarrier(
      stk({ id: 'fam', title: 'Family Liaison Officer' }),
      'hr_counterpart',
    );
    const cast = [
      tagged,
      liaison,
      stk({ id: 'rep_media', title: 'Defence Reporter', relationship: 'media' }),
      stk({ id: 'reg', title: 'Commissioner', relationship: 'regulator' }),
    ];
    const codes = validateCast(
      cast,
      [],
      [{ org_key: 'org_slm_my', display_name: 'SLM', country: 'Malaysia' }],
      { labourSignal: false, injectsByStakeholder: new Map() },
    ).map((i) => i.code);
    assert.deepEqual(codes, []);
  });

  test('military, ministry and Malay / Indonesian site-leader titles are recognised untagged', () => {
    for (const t of [
      'Commander, Joint Task Force Sulu',
      'Commanding Officer, Naval Forces Western Mindanao',
      'Officer-in-Charge, Coast Guard Station Zamboanga',
      'Komandan Pangkalan TNI AL Tarakan',
      'Kepala Kantor Wilayah Sabah',
      'Consul General, Kota Kinabalu',
      'Director, Directorate for the Protection of Citizens',
      'Head, Crisis Management Centre',
      'Plant Manager',
      'Depot Manager (Johor)',
      'Site Operations Manager',
    ])
      assert.ok(site(t), t);
  });

  test('personnel, welfare and HR titles are recognised untagged', () => {
    for (const t of [
      'Human Resource Management Officer',
      'Personnel Officer (J1)',
      'Asisten Personel',
      'Kepala Biro SDM',
      'Family Welfare Officer',
      'HRD Manager',
      'HR Business Partner',
    ])
      assert.ok(hr(t), t);
  });

  test('titles that do not lead a site stay unrecognised', () => {
    for (const t of [
      'Operations Coordinator',
      'Chief Executive Officer',
      'Executive Assistant to the CEO',
      'Intelligence Analyst',
      'OIC Desk Officer',
    ])
      assert.equal(site(t), false, t);
    assert.equal(hr('Depot Manager (Johor)'), false);
    assert.equal(
      isCarrier(stk({ id: 'u', title: 'Branch Secretary', relationship: 'union' }), 'site_leader'),
      false,
    );
    assert.equal(
      isCarrier(stk({ id: 'r', title: 'Depot Manager', tier: 'roster' }), 'site_leader'),
      false,
    );
  });

  test('carrierRoleOf ignores anything that is not a carrier role', () => {
    assert.equal(carrierRoleOf(stk({ id: 'a' })), null);
    assert.equal(carrierRoleOf({ ...stk({ id: 'b' }), carrier_role: 'ceo' } as Stakeholder), null);
  });
});

describe('ensureRequiredCarriers (compile-time guarantee)', () => {
  const agency: NormalisedOrg = {
    org_key: 'org_tni_id',
    display_name: 'Tentara Nasional Indonesia (TNI)',
    short_name: 'TNI',
    country: 'Indonesia',
    city: 'Jakarta',
    kind: 'agency',
    is_primary: false,
    teams: [],
    operation: 'ai',
  };
  const tniCharter = (function_key: string, mission = ''): OrgTeamCharter =>
    ({
      ...charter(function_key, mission),
      team_name: `${function_key} — TNI`,
      org_key: 'org_tni_id',
      country: 'Indonesia',
      short_name: 'TNI',
    }) as OrgTeamCharter;
  const tniCharters = [
    tniCharter('Communications'),
    tniCharter('Operations', 'Plans and runs maritime operations with partner navies.'),
    tniCharter('Intelligence', 'Tracks the kidnappers and the hostages.'),
  ];
  const commons = [
    stk({ id: 'reporter', title: 'Defence Correspondent', relationship: 'media', org_key: null }),
    stk({ id: 'komnas', title: 'Commissioner', relationship: 'regulator', org_key: null }),
  ];
  const opts = { labourSignal: false, multiOrg: true };

  test('fills a missing site leader and HR counterpart with tagged, agency-titled carriers', () => {
    const cast = [
      ...commons,
      stk({ id: 'intel', title: 'Perwira Staf Intelijen', org_key: 'org_tni_id' }),
    ];
    const r = ensureRequiredCarriers([agency], tniCharters, cast, newTakenIdentifiers(), opts);
    assert.deepEqual(r.filled, [
      { org_key: 'org_tni_id', roles: ['site_leader', 'hr_counterpart'] },
    ]);
    assert.deepEqual(
      r.added.map((s) => [carrierRoleOf(s), s.title, s.org_key, s.relationship, s.owning_team]),
      [
        ['site_leader', 'Officer-in-Charge', 'org_tni_id', 'internal', 'Operations'],
        ['hr_counterpart', 'Personnel Officer', 'org_tni_id', 'internal', 'Communications'],
      ],
    );
    assert.ok(r.added.every((s) => (s.sensitivities || []).length > 0));
    assert.deepEqual(
      validateCast(
        [...cast, ...r.added],
        [],
        [{ org_key: 'org_tni_id', display_name: agency.display_name, country: 'Indonesia' }],
        { labourSignal: false, injectsByStakeholder: new Map() },
      ),
      [],
    );
    assert.ok(StakeholdersSchema.safeParse([...cast, ...r.added]).success);
  });

  test('adds nothing when every role is filled, and is idempotent', () => {
    const first = ensureRequiredCarriers(
      [agency],
      tniCharters,
      [...commons],
      newTakenIdentifiers(),
      opts,
    );
    const again = ensureRequiredCarriers(
      [agency],
      tniCharters,
      [...commons, ...first.added],
      newTakenIdentifiers(),
      opts,
    );
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.filled, []);
  });

  test('a public body missing a regulator gets an ombudsman, not a labour ministry', () => {
    const r = ensureRequiredCarriers(
      [agency],
      tniCharters,
      [commons[0]],
      newTakenIdentifiers(),
      opts,
    );
    const reg = r.added.find((s) => carrierRoleOf(s) === 'regulator')!;
    assert.equal(reg.relationship, 'regulator');
    assert.equal(reg.organisation, 'Office of the Ombudsman, Indonesia');
  });

  test('a labour crisis also requires a workforce representative', () => {
    const cast = [
      stk({ id: 'mgr', title: 'Depot Manager' }),
      stk({ id: 'hr', title: 'HR Business Partner' }),
      stk({ id: 'media', title: 'Reporter', relationship: 'media' }),
      stk({ id: 'reg', title: 'Officer', relationship: 'regulator' }),
    ];
    const noLabour = ensureRequiredCarriers([org], charters, cast, newTakenIdentifiers(), opts);
    assert.deepEqual(noLabour.added, []);
    const labour = ensureRequiredCarriers([org], charters, cast, newTakenIdentifiers(), {
      ...opts,
      labourSignal: true,
    });
    assert.deepEqual(
      labour.added.map((s) => [carrierRoleOf(s), s.relationship]),
      [['workforce_rep', 'union']],
    );
  });

  test('new identifiers never reuse ones already claimed', () => {
    const taken = newTakenIdentifiers();
    const probe = ensureRequiredCarriers(
      [agency],
      tniCharters,
      [...commons],
      newTakenIdentifiers(),
      opts,
    );
    for (const s of probe.added) {
      taken.ids.add(s.id);
      taken.emails.add(s.email);
      taken.handles.add(s.handle);
    }
    const r = ensureRequiredCarriers([agency], tniCharters, [...commons], taken, opts);
    for (const [a, b] of r.added.map((s, i) => [s, probe.added[i]] as const)) {
      assert.notEqual(a.id, b.id);
      assert.notEqual(a.email, b.email);
      assert.notEqual(a.handle, b.handle);
    }
  });
});

describe('compile repairs the 25 Sep cast without a rebuild', () => {
  const organisations: OrganisationInput[] = [
    {
      display_name: 'Western Mindanao Command',
      short_name: 'WMC',
      country: 'Philippines',
      city: 'Zamboanga',
      kind: 'agency',
      is_primary: true,
      operation: 'players',
      team_roster: [
        { team_name: 'Communications', is_public_voice: true },
        { team_name: 'Executive' },
        {
          team_name: 'Armed Forces of the Philippines',
          is_custom: true,
          description: 'Deal with the deployment of the military on the ground.',
        },
      ],
    },
    {
      display_name: 'Eastern Sabah Security Command',
      short_name: 'ESSCOM',
      country: 'Malaysia',
      city: 'Sabah',
      kind: 'agency',
      is_primary: false,
      operation: 'players',
      team_roster: [
        { team_name: 'Communications', is_public_voice: true },
        { team_name: 'Stakeholder Engagement' },
      ],
    },
    {
      display_name: 'Tentara Nasional Indonesia (TNI)',
      short_name: 'TNI',
      country: 'Indonesia',
      city: 'Jakarta',
      kind: 'agency',
      is_primary: false,
      operation: 'ai',
      team_roster: [
        { team_name: 'Communications', is_public_voice: true },
        {
          team_name: 'Operations',
          is_custom: true,
          description: 'Plans and runs maritime operations with partner navies.',
        },
      ],
    },
  ];
  // Untagged, as the wizard holds it today: carriers titled for a military, no carrier_role.
  const cast = [
    stk({
      id: 'wmc_plans',
      title: 'Senior Staff Officer for Civil-Military Affairs',
      organisation: 'Western Mindanao Command',
      org_key: 'primary',
      owning_team: 'Executive',
    }),
    stk({
      id: 'wmc_hrmo',
      title: 'Human Resource Management Officer',
      organisation: 'Western Mindanao Command',
      org_key: 'primary',
      owning_team: 'Communications',
    }),
    stk({
      id: 'esscom_ops',
      title: 'Operations Director',
      organisation: 'Eastern Sabah Security Command',
      org_key: 'org_esscom_my',
    }),
    stk({
      id: 'esscom_pers',
      title: 'Personnel Officer',
      organisation: 'Eastern Sabah Security Command',
      org_key: 'org_esscom_my',
    }),
    stk({
      id: 'tni_intel',
      title: 'Perwira Staf Intelijen',
      organisation: 'Tentara Nasional Indonesia',
      org_key: 'org_tni_id',
      owning_team: 'Operations',
    }),
    stk({ id: 'reporter', title: 'Defence Correspondent', relationship: 'media', org_key: null }),
    stk({ id: 'chr', title: 'Commissioner', relationship: 'regulator', org_key: null }),
  ];

  test('missing carriers are synthesised, tagged, owned inside their organisation and valid', () => {
    const res = resolveOrganisations(organisations, [], []);
    assert.ok(res && res.ok, 'organisations validate');
    if (!res || !res.ok) return;
    const artifacts = buildCompileArtifacts(res, {
      team_charters: [],
      stakeholders: cast,
      personas: [],
      org_page: null,
      decision_context: { labour_signal: false },
    });
    const added = artifacts.stakeholders.filter((s) => carrierRoleOf(s) !== null);
    assert.deepEqual(
      added.map((s) => [s.org_key, carrierRoleOf(s), s.title]),
      [
        ['primary', 'site_leader', 'Officer-in-Charge'],
        ['org_tni_id', 'site_leader', 'Officer-in-Charge'],
        ['org_tni_id', 'hr_counterpart', 'Personnel Officer'],
      ],
    );
    for (const s of added) {
      assert.ok(
        artifacts.charters.some((c) => c.org_key === s.org_key && c.function_key === s.owning_team),
        `${s.id} owned by ${s.owning_team} inside ${s.org_key}`,
      );
    }
    const issues = validateCast(
      artifacts.stakeholders,
      artifacts.charters.map((c) => ({
        team_name: c.team_name,
        function_key: c.function_key,
        org_key: c.org_key,
      })),
      artifacts.registry
        .filter((o) => o.side === 'protagonist')
        .map((o) => ({
          org_key: o.org_key,
          display_name: o.display_name,
          country: o.country ?? null,
        })),
      { labourSignal: false, injectsByStakeholder: new Map() },
    );
    assert.deepEqual(issues, []);
    assert.ok(StakeholdersSchema.safeParse(artifacts.stakeholders).success);
    assert.equal(cast.length, 7, 'the wizard payload itself is not mutated');

    const again = buildCompileArtifacts(res, {
      team_charters: [],
      stakeholders: artifacts.stakeholders,
      personas: [],
      org_page: null,
      decision_context: { labour_signal: false },
    });
    assert.equal(again.stakeholders.length, artifacts.stakeholders.length, 'idempotent');
  });
});
