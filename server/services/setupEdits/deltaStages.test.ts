import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { noteAiCall, withAiCallCount } from '../../lib/aiCallScope.js';
import { emptyBriefDiff } from './affectedLayers.js';
import { runDeltaBuild, listDeltaCalls } from './deltaBuildRun.js';
import type { DeltaBuildContext, DeltaGenerators } from './deltaBuildTypes.js';
import { delta, snapshot, snapshotOrg, snapshotTeam } from './fixtures/remapFixtures.js';
import type { RemapPlan } from './remapPlanner.js';
import type { SetupDelta } from './setupDeltaCore.js';

function emptyPlan(partial: Partial<RemapPlan> = {}): RemapPlan {
  return {
    teams: { retire: partial.teams?.retire ?? [], successors: [] },
    injects: { rewrite_in_place: [], cow: [], retire: [] },
    initial_state: { patch: [], move_to_retired: [] },
    scheduled_sessions: [],
    orphans: [],
    warnings: [],
    applicable: true,
    phases: [],
    primary_swap: null,
    vacated_countries: [],
  };
}

function acme() {
  return snapshot([
    snapshotOrg({
      org_uid: 'uid-acme',
      org_key: 'primary',
      display_name: 'Acme',
      short_name: 'ACME',
      is_primary: true,
      teams: [
        snapshotTeam({ team_uid: 'team-comms', team_name: 'Communications', is_public_voice: true }),
        snapshotTeam({ team_uid: 'team-legal', team_name: 'Legal' }),
      ],
    }),
  ], {
    competitors: [
      {
        org_uid: 'uid-rival',
        org_key: 'org_rival',
        name: 'Rival',
        country: 'Singapore',
        description: 'They want the harbour contract',
        auto_generated: false,
      },
    ],
  });
}

function context(change: Partial<SetupDelta>, plan: RemapPlan = emptyPlan()): DeltaBuildContext {
  return {
    edit_number: 1,
    delta: delta(change),
    plan,
    edited: acme(),
    baseline_crisis: { crisis_type: 'Plant fire', context: 'Night shift' },
    injects: [],
    teams: [
      { team_uid: 'team-comms', team_name: 'Communications', org_key: 'primary' },
      { team_uid: 'team-legal', team_name: 'Legal', org_key: 'primary' },
    ],
    stakeholders: [],
    personas: [],
    fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
    fact_sheet_trainer_edited: false,
    briefing: '',
    briefing_trainer_edited: false,
    narrative: { title: 'Fire', description: 'A fire', briefing: '' },
    objectives: [],
    pages: [],
    taken_handles: [],
    taken_emails: [],
    taken_stakeholder_ids: [],
    active_keys: [],
    page_batch_size: 4,
  };
}

function recording() {
  const calls: string[] = [];
  const note = (name: string) => {
    calls.push(name);
    noteAiCall();
  };
  const generators = {
    async briefDiff() {
      note('briefDiff');
      return emptyBriefDiff('cosmetic');
    },
    async reviseFactSheet() {
      note('reviseFactSheet');
      return { confirmed_facts: [], unconfirmed_claims: [] };
    },
    async generatePersonas(input) {
      note(`generatePersonas:${input.country}`);
      return [];
    },
    async generatePersonaGroups() {
      note('generatePersonaGroups');
      return [];
    },
    async generateCharter(input) {
      note(`generateCharter:${input.teamName}`);
      return { team_name: input.teamName, mission: input.teamName, responsibilities: [] };
    },
    async generateTeamStoryline(input) {
      note(`generateTeamStoryline:${input.teamName}`);
      return [
        {
          title: `${input.teamName} beat`,
          content: 'A new beat',
          type: 'email',
          severity: 'medium',
          inject_scope: 'team_specific',
          target_teams: [input.teamName],
          requires_response: false,
          delivery_config: { app: 'email' },
        },
      ];
    },
    async generateStakeholders(input) {
      note(`generateStakeholders:${input.orgKey}`);
      return { stakeholders: [], injects: [] };
    },
    async generateSpokesperson(input) {
      note(`generateSpokesperson:${input.orgKey}`);
      return { stakeholder: null, injects: [] };
    },
    async reviseLayer(input) {
      note(`reviseLayer:${input.layer}`);
      return { decisions: [], new_injects: [] };
    },
    async reviseStakeholderText() {
      note('reviseStakeholderText');
      return [];
    },
    async convergenceDelta() {
      note('convergenceDelta');
      return { shared: [], gates: [] };
    },
    async reviseNarrative() {
      note('reviseNarrative');
      return { narrative: { title: '', description: '', briefing: '' }, objectives: [] };
    },
    async regenerateBranches(input) {
      note(`regenerateBranches:${input.parentKey}`);
      return [];
    },
    async generatePages(input) {
      note(`generatePages:${input.orgs.map((org) => org.org_key).join(',')}`);
      return input.orgs.map((org) => ({ org_key: org.org_key }));
    },
    async revisePageHistory(input) {
      note(`revisePageHistory:${input.orgKey}`);
      return [];
    },
  } satisfies DeltaGenerators;
  return { calls, generators };
}

describe('delta stages', () => {
  test('an added team calls only the add-team generators', async () => {
    const { calls, generators } = recording();
    const result = await runDeltaBuild(
      context({ added_teams: [{ org_key: 'primary', team_name: 'Audit' }] }),
      generators,
    );
    assert.deepEqual(calls, ['generateCharter:Audit', 'generateTeamStoryline:Audit', 'convergenceDelta']);
    assert.equal(result.storyline.generated.charters[0]?.team_name, 'Audit');
    assert.equal(result.storyline.generated.team_storylines.Audit?.[0]?.title, 'Audit beat');
    assert.equal(result.characters.skipped, true);
    assert.equal(result.pages.skipped, true);
  });

  test('a cosmetic brief change plus one added team is the add-team calls plus the diff', async () => {
    const { calls, generators } = recording();
    const built = context({
      brief_changed: true,
      added_teams: [{ org_key: 'primary', team_name: 'Audit' }],
    });
    const { calls: counted } = await withAiCallCount(() => runDeltaBuild(built, generators));
    assert.deepEqual(calls, [
      'briefDiff',
      'generateCharter:Audit',
      'generateTeamStoryline:Audit',
      'convergenceDelta',
    ]);
    assert.equal(counted, 4);
  });

  test('a text-only delta makes no AI calls and updates stance', async () => {
    const { calls, generators } = recording();
    const result = await runDeltaBuild(
      context({ changed_text: [{ key: 'org_rival', field: 'description' }] }),
      generators,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(result.pages.text_updates, [
      { org_key: 'org_rival', field: 'stance', value: 'They want the harbour contract' },
    ]);
  });

  test('removal alone makes no AI calls', async () => {
    const { calls, generators } = recording();
    await runDeltaBuild(
      context({ removed_teams: [{ team_uid: 'team-legal', team_name: 'Legal' }] }),
      generators,
    );
    assert.deepEqual(calls, []);
  });

  test('rename alone makes no AI calls, including when the plan retires the old team row', async () => {
    const { calls, generators } = recording();
    const renamed = context(
      { renamed_teams: [{ team_uid: 'team-legal', from: 'Legal', to: 'Counsel' }] },
      emptyPlan({
        teams: {
          retire: [
            {
              source_id: 'row-legal',
              team_uid: 'team-legal',
              team_name: 'Legal',
              org_key: 'primary',
              reason: 'renamed',
            },
          ],
          successors: [],
        },
      }),
    );
    assert.deepEqual(listDeltaCalls(renamed, null), []);
    await runDeltaBuild(renamed, generators);
    assert.deepEqual(calls, []);
  });

  test('a new country and an added rival call personas and one page batch, not the old teams', async () => {
    const { calls, generators } = recording();
    await runDeltaBuild(
      context({
        new_countries: ['Malaysia'],
        added_rivals: ['org_rival_2'],
        relocated_orgs: [{ org_key: 'primary', from_country: 'Singapore', to_country: 'Malaysia' }],
      }),
      generators,
    );
    assert.equal(calls.includes('generatePersonas:Malaysia'), true);
    assert.equal(calls.includes('generatePages:org_rival_2'), true);
    assert.equal(calls.includes('reviseLayer:team:team-comms'), true);
    assert.equal(calls.includes('reviseLayer:team:team-legal'), true);
    assert.equal(calls.includes('revisePageHistory:primary'), true);
    assert.equal(calls.includes('briefDiff'), false);
    assert.equal(calls.includes('generateTeamStoryline:Communications'), false);
  });
});
