/**
 * Offline verification of the multi-organisation model (no AI, no DB).
 *
 *   npx tsx scripts/verify-multi-org-model.ts
 *
 * Covers: validateOrganisations (MO-ORG/TEAM/EXE codes, composed names, keys,
 * public-voice defaulting), resolveTeamFunction, the registry/countries
 * builders, stakeholder finalisation + note-leak check + inject authorship,
 * and validateScenarioPayload on a hand-built fixture (positive run + every
 * negative rule that the compile must refuse).
 */
import {
  validateOrganisations,
  buildOrgRegistry,
  buildCountries,
  composeTeamName,
  EXECUTIVE_CHARTER,
} from '../server/services/scenarioOrgModel.js';
import {
  resolveTeamFunction,
  isStakeholderVisibleToTeam,
  type Stakeholder,
} from '../server/services/stakeholderShapes.js';
import {
  validateScenarioPayload,
  MultiOrgValidationError,
} from '../server/services/scenarioValidationService.js';
import {
  finalizeStakeholder,
  buildStakeholderInjects,
  noteLeaks,
  personaTwinFor,
} from '../server/services/stakeholderGenerationService.js';
import { newTakenIdentifiers } from '../server/services/multiOrgGenerationService.js';
import type {
  SocialCrisisPayload,
  SocialInject,
} from '../server/services/socialCrisisGeneratorService.js';
import type { PersistableTeamCharter } from '../server/services/socialCrisisPersistenceService.js';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── 1. Organisation validation + naming ─────────────────────────────────────
console.log('\n[1] validateOrganisations');
const orgsInput = [
  {
    display_name: 'Sigma Logistics',
    country: 'Singapore',
    city: 'Singapore',
    kind: 'company' as const,
    is_primary: true,
    team_roster: [
      { team_name: 'Communications', is_public_voice: true },
      { team_name: 'Legal' },
      { team_name: 'Executive' },
      {
        team_name: 'Fleet Operations',
        is_custom: true,
        description: 'Runs the truck fleet, drivers and depots across the region',
      },
    ],
  },
  {
    display_name: 'Sigma Logistics Malaysia',
    short_name: 'SLM',
    country: 'Malaysia',
    city: 'Johor Bahru',
    kind: 'office' as const,
    is_primary: false,
    team_roster: [
      { team_name: 'Communications' },
      { team_name: 'Sales' },
      {
        team_name: 'Driver Relations',
        is_custom: true,
        description: 'Handles driver welfare, union liaison and depot staff issues',
      },
    ],
  },
];
const competitors = [{ name: 'Swift Freight', country: 'Malaysia' }];
const v = validateOrganisations(orgsInput, competitors);
check('two orgs validate', v.ok, v.ok ? undefined : `${v.code}: ${v.message}`);
if (v.ok) {
  const [hq, my] = v.orgs;
  check('primary keeps org_key "primary"', hq.org_key === 'primary', hq.org_key);
  check('secondary key is org_<slug>_<cc>', my.org_key === 'org_slm_my', my.org_key);
  check('derived short name from initials', hq.short_name === 'SL', hq.short_name);
  check(
    'composed team names in multi-org',
    hq.teams[0].team_name === 'Communications — SL' && my.teams[1].team_name === 'Sales — SLM',
    `${hq.teams[0].team_name} / ${my.teams[1].team_name}`,
  );
  check(
    'custom function key title-cased',
    hq.teams[3].function_key === 'Fleet Operations' && hq.teams[3].is_custom,
    hq.teams[3].function_key,
  );
  check(
    'public voice defaulted to Communications for SLM',
    my.teams.find((t) => t.is_public_voice)?.function_key === 'Communications',
  );
  check(
    'competitor gets antagonist key',
    v.competitors[0].org_key.startsWith('org_antagonist_swift_freight'),
    v.competitors[0].org_key,
  );
  const registry = buildOrgRegistry(v.orgs, v.competitors, {
    org_key: 'org_antagonist_auto_0',
    display_name: 'Rival',
    country: 'Singapore',
  });
  check(
    'registry has 2 protagonists + 2 antagonists',
    registry.filter((r) => r.side === 'protagonist').length === 2 &&
      registry.filter((r) => r.side === 'antagonist').length === 2,
  );
  const countries = buildCountries(registry);
  check(
    'countries derived (SG, MY)',
    countries
      .map((c) => c.code)
      .sort()
      .join(',') === 'MY,SG',
    countries.map((c) => `${c.name}:${c.code}`).join(' '),
  );
}
check(
  'single org keeps bare names',
  composeTeamName('Legal', { short_name: 'SL' }, false) === 'Legal',
);
check(
  'long name truncates short name to fit 100',
  composeTeamName('A'.repeat(95), { short_name: 'LONGSHORT' }, true).length <= 100,
);

const bad1 = validateOrganisations(
  [{ ...orgsInput[0], is_primary: false }, { ...orgsInput[1] }],
  [],
);
check(
  'MO-ORG-002 when no primary among several',
  !bad1.ok && bad1.code === 'MO-ORG-002',
  bad1.ok ? 'accepted' : bad1.code,
);
const bad2 = validateOrganisations([{ ...orgsInput[0], country: 'Narnia' }], []);
check(
  'MO-ORG-004 unknown country',
  !bad2.ok && bad2.code === 'MO-ORG-004',
  bad2.ok ? 'accepted' : bad2.code,
);
const bad3 = validateOrganisations(
  [{ ...orgsInput[0], team_roster: [{ team_name: 'Executive' }, { team_name: 'Executive' }] }],
  [],
);
check(
  'MO-EXE-001 two Executive teams',
  !bad3.ok && bad3.details.some((d) => d.code === 'MO-EXE-001'),
  bad3.ok ? 'accepted' : bad3.details.map((d) => d.code).join(','),
);
const bad4 = validateOrganisations(
  [
    {
      ...orgsInput[0],
      team_roster: [
        { team_name: 'Communications', is_public_voice: true },
        { team_name: 'Legal', is_public_voice: true },
      ],
    },
  ],
  [],
);
check(
  'MO-TEAM-004 two public voices',
  !bad4.ok && bad4.details.some((d) => d.code === 'MO-TEAM-004'),
);
const bad5 = validateOrganisations(
  [
    {
      ...orgsInput[0],
      team_roster: [
        { team_name: 'Communications' },
        { team_name: 'Ops', is_custom: true, description: 'short' },
      ],
    },
  ],
  [],
);
check(
  'MO-TEAM-005 custom description too short',
  !bad5.ok && bad5.details.some((d) => d.code === 'MO-TEAM-005'),
);
const bad6 = validateOrganisations(
  [{ ...orgsInput[0], team_roster: [{ team_name: 'Communications' }] }],
  [],
);
check(
  'MO-TEAM-001 fewer than 2 teams',
  !bad6.ok && bad6.details.some((d) => d.code === 'MO-TEAM-001'),
);

// ─── 2. resolveTeamFunction + visibility ─────────────────────────────────────
console.log('\n[2] contract resolvers');
check(
  'resolveTeamFunction prefers function_key',
  resolveTeamFunction({ team_name: 'Communications — SL', function_key: 'Communications' }) ===
    'Communications',
);
check(
  'resolveTeamFunction falls back to name',
  resolveTeamFunction({ team_name: 'Franchise Relations', function_key: null }) ===
    'Franchise Relations',
);
const common: Pick<Stakeholder, 'owning_team' | 'org_key'> = {
  owning_team: 'Communications',
  org_key: null,
};
check(
  'common stakeholder visible to Communications in any org',
  isStakeholderVisibleToTeam(common, {
    team_name: 'Communications — SLM',
    function_key: 'Communications',
    org_key: 'org_slm_my',
  }),
);
check(
  'org stakeholder hidden from other org',
  !isStakeholderVisibleToTeam(
    { owning_team: 'Legal', org_key: 'primary' },
    { team_name: 'Legal — SLM', function_key: 'Legal', org_key: 'org_slm_my' },
  ),
);

// ─── 3. Stakeholder finalisation ─────────────────────────────────────────────
console.log('\n[3] stakeholder finalisation');
const taken = newTakenIdentifiers();
const raw = {
  name: 'Datuk Rahim Ismail',
  title: 'Chief Executive Officer',
  organisation: 'Sigma Logistics Malaysia',
  relationship: 'internal',
  note: 'Long-standing contact. Will post publicly at T+25 if ignored.',
  grievance: 'Learned about the depot closure from a driver WhatsApp group, not from HQ.',
  resolution_criteria: ['Direct briefing from HQ leadership'],
  persuadability: 'high',
  scheduled_injects: [
    {
      channel: 'email',
      trigger_time_minutes: 4,
      title: 'Why did I hear this from drivers?',
      content: 'Subject: Depot closure\n\nI heard from the drivers first.',
    },
    {
      channel: 'social_post',
      trigger_time_minutes: 12,
      title: 'Public post',
      content: 'Sigma HQ left its own people in the dark.',
      platform: 'x_twitter',
    },
  ],
};
const s = finalizeStakeholder(raw, 'Driver Relations', 'org_slm_my', 'slm', taken);
check('finalize returns a stakeholder', !!s);
if (s) {
  check(
    'internal C-suite title downgraded (MO-STK-010)',
    s.title === 'Operations Coordinator',
    s.title,
  );
  check('leaky note neutralised (MO-STK-009)', !/T\+25|post publicly/.test(s.note), s.note);
  check(
    'id/email/handle generated',
    /^stk_slm_/.test(s.id) &&
      /@sigmalogisticsmalaysia\.sim$/.test(s.email) &&
      /^@[a-z0-9_]{3,30}$/.test(s.handle),
    `${s.id} ${s.email} ${s.handle}`,
  );
  const { injects, twin } = buildStakeholderInjects(s, raw, {
    targetTeams: ['Driver Relations — SLM'],
    orgKey: 'org_slm_my',
    country: 'Malaysia',
    dial: '+60',
  });
  check('two injects built (email + social)', injects.length === 2, `${injects.length}`);
  check(
    'email shifted to T+10 minimum (MO-INJ-006)',
    injects[0].trigger_time_minutes === 10,
    `${injects[0].trigger_time_minutes}`,
  );
  check(
    'social shifted to T+20 minimum',
    injects[1].trigger_time_minutes === 20,
    `${injects[1].trigger_time_minutes}`,
  );
  check(
    'email author fields copied from record',
    injects[0].delivery_config.from_address === s.email &&
      injects[0].delivery_config.from_name === s.name &&
      injects[0].delivery_config.stakeholder_id === s.id,
  );
  check(
    'email scoped org_key + country, targets composed team',
    injects[0].delivery_config.org_key === 'org_slm_my' &&
      injects[0].delivery_config.country === 'Malaysia' &&
      injects[0].target_teams[0] === 'Driver Relations — SLM',
  );
  check(
    'social post universal with author handle + country',
    injects[1].inject_scope === 'universal' &&
      injects[1].delivery_config.author_handle === s.handle &&
      injects[1].delivery_config.country === 'Malaysia',
  );
  check(
    'persona twin created for the feed author',
    !!twin && twin.handle === s.handle && twin.country === 'Malaysia',
  );
}
check('noteLeaks flags timing tokens', noteLeaks('Plans to escalate within 15 minutes', '', []));
check(
  'noteLeaks passes neutral note',
  !noteLeaks(
    'Regional distribution partner since 2019; prefers email.',
    'Angry about late payment of invoices',
    [],
  ),
);

// ─── 4. validateScenarioPayload fixture ──────────────────────────────────────
console.log('\n[4] validateScenarioPayload');
function fixture(): { payload: SocialCrisisPayload; charters: PersistableTeamCharter[] } {
  const stk: Stakeholder = {
    id: 'stk_sl_mei_tan',
    name: 'Mei Tan',
    title: 'Transport Correspondent',
    organisation: 'Straits Business Daily',
    relationship: 'media',
    owning_team: 'Communications',
    org_key: 'primary',
    email: 'mei.tan@straitsbusinessdaily.sim',
    phone: null,
    handle: '@meit_straits',
    note: 'Covers logistics; fair but persistent.',
    personality: 'Direct.',
    stance: 'Sceptical.',
    knowledge: ['Has the recall memo'],
    will_not_disclose: ['Her source'],
    grievance: 'No reply to two requests for comment.',
    resolution_criteria: ['A named spokesperson replies with confirmed facts'],
    persuadability: 'medium',
    hard_constraints: [],
  };
  const pure: Stakeholder = {
    ...stk,
    id: 'stk_sl_ops_desk',
    name: 'Ops Desk',
    title: 'Operations Coordinator',
    organisation: 'Sigma Logistics',
    relationship: 'internal',
    email: 'ops.desk@sigmalogistics.sim',
    handle: '@opsdesk_sl',
    note: 'Internal desk.',
    grievance: '',
    resolution_criteria: [],
  };
  const pureMy: Stakeholder = {
    ...pure,
    id: 'stk_slm_sales_desk',
    name: 'Sales Desk',
    organisation: 'Sigma Logistics Malaysia',
    owning_team: 'Sales',
    org_key: 'org_slm_my',
    email: 'sales.desk@slm.sim',
    handle: '@salesdesk_slm',
  };
  const commonPure: Stakeholder = {
    ...pure,
    id: 'stk_common_ministry',
    name: 'Ministry Duty Officer',
    organisation: 'Ministry of Transport',
    relationship: 'regulator',
    owning_team: 'Communications',
    org_key: null,
    email: 'duty@mot.sim',
    handle: '@mot_duty',
    persuadability: 'none',
  };
  const email: SocialInject = {
    trigger_time_minutes: 12,
    type: 'email_inbound',
    title: 'Request for comment',
    content: 'Subject: Comment',
    severity: 'medium',
    inject_scope: 'team_specific',
    target_teams: ['Communications — SL'],
    delivery_config: {
      app: 'email',
      stakeholder_id: stk.id,
      from_name: stk.name,
      from_address: stk.email,
      email_category: 'general',
      org_key: 'primary',
      country: 'Singapore',
    },
  };
  const post: SocialInject = {
    trigger_time_minutes: 25,
    type: 'social_post',
    title: 'Still no comment',
    content: 'Two requests, no answer.',
    severity: 'high',
    inject_scope: 'universal',
    target_teams: [],
    delivery_config: {
      app: 'social_feed',
      platform: 'x_twitter',
      stakeholder_id: stk.id,
      author_handle: stk.handle,
      author_display_name: stk.name,
      author_type: 'npc_media',
      country: 'Singapore',
    },
  };
  const template: SocialInject = {
    type: 'social_post',
    title: 'Eruption',
    content: 'Leak',
    severity: 'critical',
    inject_scope: 'universal',
    target_teams: [],
    delivery_config: {
      app: 'social_feed',
      platform: 'x_twitter',
      stakeholder_id: stk.id,
      author_handle: stk.handle,
      author_display_name: stk.name,
      author_type: 'npc_media',
      inject_key: 'erupt_close_depot_mei',
      decision_key: 'close_depot',
      country: 'Singapore',
    },
    conditions_to_appear: { threshold: 1, conditions: ['decision_recorded:close_depot'] },
  };
  stk.latent_grievances = {
    close_depot: {
      grievance: 'Heard about closure from drivers',
      resolution_criteria: ['Briefed first'],
      persuadability: 'low',
      hard_constraints: [],
      eruption_inject_keys: ['erupt_close_depot_mei'],
    },
  };
  const charters: PersistableTeamCharter[] = [
    {
      team_name: 'Communications — SL',
      mission: 'm',
      responsibilities: [],
      expected_actions: [],
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 4,
      can_post_publicly: true,
      org_key: 'primary',
      function_key: 'Communications',
    },
    {
      team_name: 'Legal — SL',
      mission: 'm',
      responsibilities: [],
      expected_actions: [],
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 4,
      org_key: 'primary',
      function_key: 'Legal',
    },
    {
      team_name: 'Executive — SL',
      mission: 'm',
      responsibilities: [],
      expected_actions: EXECUTIVE_CHARTER.expected_actions,
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 6,
      org_key: 'primary',
      function_key: 'Executive',
    },
    {
      team_name: 'Communications — SLM',
      mission: 'm',
      responsibilities: [],
      expected_actions: [],
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 4,
      can_post_publicly: true,
      org_key: 'org_slm_my',
      function_key: 'Communications',
    },
    {
      team_name: 'Sales — SLM',
      mission: 'm',
      responsibilities: [],
      expected_actions: [],
      scoring_rubric: '',
      out_of_lane: [],
      min_participants: 1,
      max_participants: 4,
      org_key: 'org_slm_my',
      function_key: 'Sales',
    },
  ];
  const legalPure: Stakeholder = {
    ...pure,
    id: 'stk_sl_legal_desk',
    name: 'Legal Desk',
    owning_team: 'Legal',
    email: 'legal.desk@sigmalogistics.sim',
    handle: '@legaldesk_sl',
  };
  const execPure: Stakeholder = {
    ...pure,
    id: 'stk_sl_cos_desk',
    name: 'Chief of Staff Office',
    owning_team: 'Executive',
    email: 'cos.office@sigmalogistics.sim',
    handle: '@cosoffice_sl',
  };
  const payload: SocialCrisisPayload = {
    scenario: {
      title: 'Fixture',
      description: 'd',
      briefing: 'b',
      category: 'social_media_crisis',
      difficulty: 'expert',
      duration_minutes: 60,
      initial_state: {
        npc_personas: [
          {
            handle: '@sg_voice',
            name: 'SG Voice',
            type: 'npc_public',
            personality: '',
            bias: 'none',
            follower_count: 100,
            backstory: '',
            posting_pattern: '',
            specific_claims: [],
            country: 'Singapore',
          },
          personaTwinFor(stk, 'Singapore'),
        ],
        fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
        sentiment_curve: {
          baseline: 65,
          crisis_drop: -30,
          natural_recovery_per_10min: 2,
          good_response_boost: 10,
          poor_response_penalty: -8,
          hate_speech_penalty_per_unaddressed: -3,
          community_engagement_boost: 12,
        },
        affected_communities: [],
        research_guidelines: {
          per_team: [],
          group_wide: {
            coordination_guidelines: [],
            escalation_protocols: [],
            timing_benchmarks: {},
            case_studies: [],
          },
        },
        country: 'Singapore',
        orgs: [
          {
            org_key: 'primary',
            display_name: 'Sigma Logistics',
            short_name: 'SL',
            country: 'Singapore',
            kind: 'company',
            side: 'protagonist',
            is_primary: true,
          },
          {
            org_key: 'org_slm_my',
            display_name: 'Sigma Logistics Malaysia',
            short_name: 'SLM',
            country: 'Malaysia',
            kind: 'office',
            side: 'protagonist',
          },
          {
            org_key: 'org_antagonist_swift_freight_0',
            display_name: 'Swift Freight',
            country: 'Malaysia',
            kind: 'company',
            side: 'antagonist',
          },
        ],
        countries: [
          { name: 'Singapore', code: 'SG' },
          { name: 'Malaysia', code: 'MY' },
        ],
        stakeholders: [stk, pure, legalPure, execPure, pureMy, commonPure],
        decision_space: [
          {
            decision_key: 'close_depot',
            label: 'Close the Johor depot',
            title: 'Close the Johor depot',
            description: 'Shut the depot for 30 days',
            decidable_by_org_keys: ['primary'],
            affected_org_keys: ['org_slm_my'],
            severity: 'high',
            sop_obligations: [
              {
                obligation_key: 'brief_staff',
                description: 'Brief depot staff before external comms',
                owed_to_stakeholder_ids: [pureMy.id],
                owed_by_function: 'Sales',
                by_function: 'Sales',
                window_minutes: 30,
                detection: 'stakeholder_contacted',
              },
            ],
            eruption_inject_keys: ['erupt_close_depot_mei'],
            spillover_inject_keys: [],
            public_statement_expected: true,
          },
        ],
      },
    },
    teams: charters.map((c) => ({
      team_name: c.team_name,
      team_description: c.mission,
      min_participants: 1,
      max_participants: 4,
    })),
    objectives: [],
    sop: {
      sop_name: 's',
      description: '',
      steps: [],
      response_time_limit_minutes: 30,
      content_guidelines: { tone: [], avoid: [], include: [], language_sensitivity: [] },
    },
    time_injects: [email, post],
    condition_injects: [template],
    decision_injects: [],
  };
  return { payload, charters };
}

function expectPass(name: string) {
  const { payload, charters } = fixture();
  try {
    validateScenarioPayload(payload, charters);
    check(name, true);
  } catch (err) {
    check(
      name,
      false,
      err instanceof MultiOrgValidationError
        ? err.all.map((e) => `${e.code} ${e.message}`).join(' | ')
        : String(err),
    );
  }
}
function expectCode(
  name: string,
  code: string,
  mutate: (p: SocialCrisisPayload, c: PersistableTeamCharter[]) => void,
) {
  const { payload, charters } = fixture();
  mutate(payload, charters);
  try {
    validateScenarioPayload(payload, charters);
    check(name, false, 'accepted');
  } catch (err) {
    const codes = err instanceof MultiOrgValidationError ? err.all.map((e) => e.code) : [];
    check(name, codes.includes(code), codes.join(','));
  }
}
expectPass('valid multi-org fixture passes');
expectCode('MO-STK-001 owning_team not in org', 'MO-STK-001', (p) => {
  p.scenario.initial_state.stakeholders![0].owning_team = 'Procurement';
});
expectCode('MO-STK-002 stakeholder org_key is antagonist', 'MO-STK-002', (p) => {
  p.scenario.initial_state.stakeholders![0].org_key = 'org_antagonist_swift_freight_0';
});
expectCode('MO-STK-004 duplicate email', 'MO-STK-004', (p) => {
  p.scenario.initial_state.stakeholders![1].email = p.scenario.initial_state.stakeholders![0].email;
});
expectCode('MO-STK-006 feed author without persona twin', 'MO-STK-006', (p) => {
  p.scenario.initial_state.npc_personas = p.scenario.initial_state.npc_personas.filter(
    (x) => x.handle !== '@meit_straits',
  );
});
expectCode('MO-STK-007 pure contact authoring an inject', 'MO-STK-007', (p) => {
  p.time_injects[0].delivery_config.stakeholder_id = 'stk_sl_ops_desk';
  p.time_injects[0].delivery_config.from_address = 'ops.desk@sigmalogistics.sim';
  p.time_injects[0].delivery_config.from_name = 'Ops Desk';
});
expectCode('MO-STK-008 team without contacts', 'MO-STK-008', (p) => {
  p.scenario.initial_state.stakeholders = p.scenario.initial_state.stakeholders!.filter(
    (x) => x.id !== 'stk_sl_legal_desk',
  );
});
expectCode('MO-STK-009 note leaks timing', 'MO-STK-009', (p) => {
  p.scenario.initial_state.stakeholders![0].note = 'Will post at T+25 if ignored';
});
expectCode('MO-INJ-001 unknown stakeholder_id', 'MO-INJ-001', (p) => {
  p.time_injects[0].delivery_config.stakeholder_id = 'stk_nope';
});
expectCode('MO-INJ-002 unknown org_key on inject', 'MO-INJ-002', (p) => {
  p.time_injects[0].delivery_config.org_key = 'org_ghost';
});
expectCode('MO-INJ-004 org/country mismatch', 'MO-INJ-004', (p) => {
  p.time_injects[0].delivery_config.country = 'Malaysia';
});
expectCode('MO-INJ-005 author fields drift from record', 'MO-INJ-005', (p) => {
  p.time_injects[0].delivery_config.from_address = 'someone.else@x.sim';
});
expectCode('MO-INJ-006 stakeholder inject before T+10', 'MO-INJ-006', (p) => {
  p.time_injects[0].trigger_time_minutes = 3;
});
expectCode('MO-TEAM-002 team org_key not protagonist', 'MO-TEAM-002', (_p, c) => {
  c[1].org_key = 'org_antagonist_swift_freight_0';
});
expectCode('MO-TEAM-004 two public voices in one org', 'MO-TEAM-004', (_p, c) => {
  c[1].can_post_publicly = true;
});
expectCode('MO-ORG-002 two primaries', 'MO-ORG-002', (p) => {
  p.scenario.initial_state.orgs![1].is_primary = true;
});
expectCode('MO-ORG-006 initial_state.country ≠ primary country', 'MO-ORG-006', (p) => {
  p.scenario.initial_state.country = 'Malaysia';
});
expectCode('MO-DEC-003 decision template missing', 'MO-DEC-003', (p) => {
  p.condition_injects = [];
});
expectCode('MO-DEC-005 template with a trigger time', 'MO-DEC-005', (p) => {
  p.condition_injects[0].trigger_time_minutes = 30;
});
expectCode('MO-DEC-002 obligation owed to unknown stakeholder', 'MO-DEC-002', (p) => {
  p.scenario.initial_state.decision_space![0].sop_obligations[0].owed_to_stakeholder_ids = [
    'stk_ghost',
  ];
});

// ─── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  process.exit(1);
}
