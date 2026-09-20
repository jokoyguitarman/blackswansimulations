import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateScenarioPayload, MultiOrgValidationError } from './scenarioValidationService.js';
import type { SocialCrisisPayload, SocialInject } from './socialCrisisGeneratorService.js';
import type { PersistableTeamCharter } from './socialCrisisPersistenceService.js';
import type { Stakeholder } from '../lib/stakeholderContract.js';

/**
 * Compact single-organisation payload (registry present → multi-org-path rules apply) with a
 * pressure page and its spokesperson. Exercises the v3.2 rules the offline verify script does not:
 * page-authored injects (MO-PRS-005/006), pressure registry links (MO-PRS-004/007) and the
 * retired latent_grievances field being ignored.
 */
function stk(over: Partial<Stakeholder> & { id: string }): Stakeholder {
  return {
    name: over.id,
    title: 'Contact',
    organisation: 'Sigma Logistics',
    relationship: 'internal',
    owning_team: 'Communications',
    org_key: null,
    email: `${over.id}@sigma.sim`,
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
  };
}

function fixture() {
  const spokesperson = stk({
    id: 'stk_mom_officer',
    name: 'Officer Lim',
    title: 'Director of Enforcement',
    organisation: 'Ministry of Manpower',
    relationship: 'regulator',
    owning_team: 'Legal',
    persuadability: 'low',
    grievance: 'No statutory notice received',
    resolution_criteria: ['Notice filed', 'Named compliance contact'],
    page_org_key: 'org_pressure_mom_sg',
  });
  const statement: SocialInject = {
    trigger_time_minutes: 20,
    type: 'social_post',
    title: 'MOM: statement',
    content: 'MOM statement on Sigma Logistics: we have requested records.',
    severity: 'high',
    inject_scope: 'universal',
    target_teams: [],
    delivery_config: {
      app: 'social_feed',
      platform: 'x_twitter',
      page_org_key: 'org_pressure_mom_sg',
      stakeholder_id: spokesperson.id,
      author_handle: '@MOMsg',
      author_display_name: 'Ministry of Manpower',
      author_type: 'official_account',
      inject_key: 'pressure_org_pressure_mom_sg_1',
      country: 'Singapore',
    },
  };
  const charters = [
    { team_name: 'Communications', function_key: 'Communications', org_key: null },
    { team_name: 'Legal', function_key: 'Legal', org_key: null },
  ].map(
    (c) =>
      ({
        ...c,
        mission: 'm',
        responsibilities: [],
        expected_actions: [],
        scoring_rubric: '',
        out_of_lane: [],
        min_participants: 1,
        max_participants: 4,
        can_post_publicly: c.team_name === 'Communications',
      }) as unknown as PersistableTeamCharter,
  );
  const payload = {
    scenario: {
      title: 't',
      description: 'd',
      briefing: 'b',
      initial_state: {
        npc_personas: [],
        fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
        sentiment_curve: [],
        affected_communities: [],
        research_guidelines: { best_practices: [], response_standards: [] },
        country: 'Singapore',
        orgs: [
          {
            org_key: 'primary',
            display_name: 'Sigma Logistics',
            country: 'Singapore',
            kind: 'company',
            side: 'protagonist',
            is_primary: true,
          },
          {
            org_key: 'org_pressure_mom_sg',
            display_name: 'Ministry of Manpower',
            country: 'Singapore',
            kind: 'regulator',
            side: 'pressure',
            spokesperson_stakeholder_id: spokesperson.id,
          },
        ],
        countries: [{ name: 'Singapore', code: 'SG' }],
        org_page: {
          facebook: { page_name: 'Sigma', page_handle: '@Sigma', page_bio: '', follower_count: 1 },
          x_twitter: { page_name: 'Sigma', page_handle: '@Sigma', page_bio: '', follower_count: 1 },
          branded_history: [],
          orgs: [
            {
              org_key: 'primary',
              display_name: 'Sigma Logistics',
              is_primary: true,
              role: 'protagonist',
              control_mode: 'player',
              facebook: {
                page_name: 'Sigma',
                page_handle: '@Sigma',
                page_bio: '',
                follower_count: 1,
              },
              x_twitter: {
                page_name: 'Sigma',
                page_handle: '@Sigma',
                page_bio: '',
                follower_count: 1,
              },
            },
            {
              org_key: 'org_pressure_mom_sg',
              display_name: 'Ministry of Manpower',
              is_primary: false,
              role: 'pressure',
              control_mode: 'ai',
              kind: 'regulator',
              spokesperson_stakeholder_id: spokesperson.id,
              x_twitter: {
                page_name: 'Ministry of Manpower',
                page_handle: '@MOMsg',
                page_bio: '',
                follower_count: 1,
              },
              facebook: {
                page_name: 'Ministry of Manpower',
                page_handle: '@MOMsingapore',
                page_bio: '',
                follower_count: 1,
              },
            },
          ],
        },
        stakeholders: [
          stk({ id: 'stk_site_mgr', title: 'Site Operations Manager' }),
          stk({ id: 'stk_hr', title: 'HR Business Partner' }),
          stk({
            id: 'stk_reporter',
            title: 'Reporter',
            relationship: 'media',
            organisation: 'Straits Times',
          }),
          stk({ id: 'stk_legal_desk', owning_team: 'Legal' }),
          spokesperson,
        ],
      },
    },
    teams: charters.map((c) => ({
      team_name: c.team_name,
      team_description: 'x',
      min_participants: 1,
      max_participants: 4,
    })),
    objectives: [],
    sop: {
      sop_name: 's',
      description: '',
      steps: [],
      response_time_limit_minutes: 30,
      content_guidelines: { tone: [], must_include: [], must_avoid: [] },
    },
    time_injects: [statement],
    condition_injects: [],
    decision_injects: [],
  } as unknown as SocialCrisisPayload;
  return { payload, charters, spokesperson, statement };
}

function codes(run: () => void): string[] {
  try {
    run();
    return [];
  } catch (err) {
    if (err instanceof MultiOrgValidationError) return err.all.map((e) => e.code);
    throw err;
  }
}

describe('page-authored injects (contract v3.2 §4.4)', () => {
  test('a pressure page statement with page identity + spokesperson passes', () => {
    const { payload, charters } = fixture();
    assert.deepEqual(
      codes(() => validateScenarioPayload(payload, charters)),
      [],
    );
  });
  test('wrong page handle, wrong author_type or a foreign spokesperson fail MO-PRS-005', () => {
    let f = fixture();
    f.statement.delivery_config.author_handle = '@SomeoneElse';
    assert.ok(codes(() => validateScenarioPayload(f.payload, f.charters)).includes('MO-PRS-005'));
    f = fixture();
    f.statement.delivery_config.author_type = 'npc_media';
    assert.ok(codes(() => validateScenarioPayload(f.payload, f.charters)).includes('MO-PRS-005'));
    f = fixture();
    f.statement.delivery_config.stakeholder_id = 'stk_reporter';
    assert.ok(codes(() => validateScenarioPayload(f.payload, f.charters)).includes('MO-PRS-005'));
  });
  test('page statements never fire before T+15 (MO-PRS-006)', () => {
    const f = fixture();
    f.statement.trigger_time_minutes = 10;
    assert.ok(codes(() => validateScenarioPayload(f.payload, f.charters)).includes('MO-PRS-006'));
  });
});

describe('pressure registry links', () => {
  test('a pressure org without a spokesperson or without a page fails', () => {
    let f = fixture();
    delete (f.payload.scenario.initial_state.orgs![1] as { spokesperson_stakeholder_id?: string })
      .spokesperson_stakeholder_id;
    assert.ok(codes(() => validateScenarioPayload(f.payload, f.charters)).includes('MO-PRS-004'));
    f = fixture();
    (f.payload.scenario.initial_state.org_page as { orgs: unknown[] }).orgs.pop();
    const c = codes(() => validateScenarioPayload(f.payload, f.charters));
    assert.ok(c.includes('MO-PRS-007'));
  });
  test('a pressure page saved with control_mode player is normalised to ai (never player-run)', () => {
    const f = fixture();
    (
      f.payload.scenario.initial_state.org_page as { orgs: Array<{ control_mode: string }> }
    ).orgs[1].control_mode = 'player';
    assert.deepEqual(
      codes(() => validateScenarioPayload(f.payload, f.charters)),
      [],
    );
  });
});

describe('retired menu layer', () => {
  test('legacy latent_grievances on a stakeholder are ignored, not validated', () => {
    const f = fixture();
    (
      f.payload.scenario.initial_state.stakeholders![0] as unknown as {
        latent_grievances?: unknown;
      }
    ).latent_grievances = {
      close_depot: {
        grievance: 'x',
        resolution_criteria: [],
        persuadability: 'low',
        hard_constraints: [],
        eruption_inject_keys: ['ghost'],
      },
    };
    assert.deepEqual(
      codes(() => validateScenarioPayload(f.payload, f.charters)),
      [],
    );
  });
  test('duplicate inject_key is MO-INJ-008 (no MO-DEC codes remain)', () => {
    const f = fixture();
    f.payload.time_injects.push({ ...f.statement, title: 'dup', trigger_time_minutes: 40 });
    const c = codes(() => validateScenarioPayload(f.payload, f.charters));
    assert.ok(c.includes('MO-INJ-008'));
    assert.ok(!c.some((x) => x.startsWith('MO-DEC')));
  });
});
