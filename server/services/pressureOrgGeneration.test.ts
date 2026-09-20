import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPressureStatements,
  alignedPostureFor,
  spokespersonOwnerFor,
} from './pressureOrgGenerationService.js';
import {
  humanCountries,
  unscopeInjectsForCountriesWithoutPlayers,
  unscopePersonasForCountriesWithoutPlayers,
} from './multiOrgPipeline.js';
import type { NormalisedOrg, OrgTeamCharter } from './scenarioOrgModel.js';
import type { OrgConfig, NPCPersona, SocialInject } from './socialCrisisGeneratorService.js';
import type { Stakeholder } from '../lib/stakeholderContract.js';

const sg: NormalisedOrg = {
  org_key: 'primary',
  display_name: 'Dyson',
  short_name: 'Dyson',
  country: 'Singapore',
  kind: 'company',
  is_primary: true,
  teams: [],
  operation: 'players',
};
const my: NormalisedOrg = {
  ...sg,
  org_key: 'org_dyson_my',
  display_name: 'Dyson Malaysia',
  short_name: 'DysonMY',
  country: 'Malaysia',
  city: 'Johor Bahru',
  kind: 'office',
  is_primary: false,
  operation: 'ai',
};

const spokesperson: Stakeholder = {
  id: 'stk_mohr',
  name: 'Encik Rahman',
  title: 'Director of Enforcement',
  organisation: 'Ministry of Human Resources',
  relationship: 'regulator',
  owning_team: 'Legal',
  org_key: 'org_dyson_my',
  email: 'rahman@mohr.sim',
  phone: null,
  handle: '@rahman_mohr',
  note: '',
  personality: '',
  stance: '',
  knowledge: [],
  will_not_disclose: [],
  grievance: 'No statutory notice',
  resolution_criteria: ['Notice filed'],
  persuadability: 'low',
  hard_constraints: [],
  page_org_key: 'org_pressure_mohr_my',
};
const page: OrgConfig = {
  org_key: 'org_pressure_mohr_my',
  display_name: 'Ministry of Human Resources',
  is_primary: false,
  role: 'pressure',
  control_mode: 'ai',
  kind: 'regulator',
  spokesperson_stakeholder_id: 'stk_mohr',
  country: 'Malaysia',
  posture: {
    register: 'statutory',
    mandate: 'Enforce labour law.',
    demands: ['Records within 48 hours'],
    escalation_ladder: ['Statement', 'Request for records', 'Inspection notice'],
    targets_org_keys: ['org_dyson_my'],
    stand_down_signals: ['Records provided'],
  },
  facebook: { page_name: 'MOHR', page_handle: '@MOHRmy', page_bio: '', follower_count: 1 },
  x_twitter: { page_name: 'MOHR', page_handle: '@MOHR_my', page_bio: '', follower_count: 1 },
};

describe('visibility rule — countries without human players (pressure plan §11)', () => {
  test('humanCountries excludes AI-operated offices', () => {
    assert.deepEqual(Array.from(humanCountries([sg, my])), ['Singapore']);
    assert.deepEqual(Array.from(humanCountries([sg, { ...my, operation: 'players' }])).sort(), [
      'Malaysia',
      'Singapore',
    ]);
  });
  test('pressure statements in a country nobody plays are UNSCOPED; scoped when humans are there', () => {
    const unscoped = buildPressureStatements(
      [page],
      [spokesperson],
      [sg, my],
      humanCountries([sg, my]),
    );
    assert.equal(unscoped.injects.length, 2);
    assert.ok(unscoped.injects.every((i) => i.delivery_config.country === undefined));
    assert.ok(
      unscoped.injects.every(
        (i) =>
          i.delivery_config.page_org_key === 'org_pressure_mohr_my' &&
          i.delivery_config.stakeholder_id === 'stk_mohr',
      ),
    );
    assert.ok(unscoped.injects.every((i) => (i.trigger_time_minutes ?? 0) >= 15));
    const scoped = buildPressureStatements(
      [page],
      [spokesperson],
      [sg, { ...my, operation: 'players' }],
      new Set(['Singapore', 'Malaysia']),
    );
    assert.ok(scoped.injects.every((i) => i.delivery_config.country === 'Malaysia'));
  });
  test('injects and personas from an AI-only country lose their country; human-country content keeps it', () => {
    const injects: SocialInject[] = [
      {
        type: 'social_post',
        title: 'a',
        content: 'a',
        severity: 'low',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: { app: 'social_feed', country: 'Malaysia' },
      },
      {
        type: 'social_post',
        title: 'b',
        content: 'b',
        severity: 'low',
        inject_scope: 'universal',
        target_teams: [],
        delivery_config: { app: 'social_feed', country: 'Singapore' },
      },
    ];
    assert.equal(unscopeInjectsForCountriesWithoutPlayers(injects, humanCountries([sg, my])), 1);
    assert.equal(injects[0].delivery_config.country, undefined);
    assert.equal(injects[1].delivery_config.country, 'Singapore');
    const personas = unscopePersonasForCountriesWithoutPlayers(
      [
        {
          handle: '@a',
          name: 'A',
          type: 'npc_public',
          personality: '',
          bias: '',
          follower_count: 1,
          backstory: 'Driver.',
          posting_pattern: '',
          specific_claims: [],
          country: 'Malaysia',
        } as NPCPersona,
        {
          handle: '@b',
          name: 'B',
          type: 'npc_public',
          personality: '',
          bias: '',
          follower_count: 1,
          backstory: 'Nurse.',
          posting_pattern: '',
          specific_claims: [],
          country: 'Singapore',
        } as NPCPersona,
      ],
      humanCountries([sg, my]),
    );
    assert.equal(personas[0].country, undefined);
    assert.match(personas[0].backstory, /Based in Malaysia/);
    assert.equal(personas[1].country, 'Singapore');
  });
});

describe('AI-operated office + spokesperson owners', () => {
  test('aligned posture follows HQ and never demands', () => {
    const p = alignedPostureFor(my, sg);
    assert.equal(p.register, 'aligned');
    assert.deepEqual(p.demands, []);
    assert.deepEqual(p.targets_org_keys, ['primary']);
    assert.ok(p.escalation_ladder.length >= 2);
  });
  test('spokesperson owner by kind', () => {
    const charters = ['Communications', 'Legal', 'Stakeholder Engagement'].map(
      (fn) => ({ function_key: fn, mission: '' }) as unknown as OrgTeamCharter,
    );
    assert.equal(spokespersonOwnerFor('regulator', charters), 'Legal');
    assert.equal(spokespersonOwnerFor('union', charters), 'Stakeholder Engagement');
    assert.equal(spokespersonOwnerFor('ngo', charters), 'Communications');
    const hr = [
      ...charters,
      {
        function_key: 'Driver Relations',
        mission: 'Driver welfare, rosters and union liaison',
      } as unknown as OrgTeamCharter,
    ];
    assert.equal(spokespersonOwnerFor('union', hr), 'Driver Relations');
  });
});
