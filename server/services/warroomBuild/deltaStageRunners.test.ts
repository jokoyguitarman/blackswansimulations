import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyBriefDiff } from '../setupEdits/affectedLayers.js';
import type { DeltaBuildContext, DeltaGenerators } from '../setupEdits/deltaBuildTypes.js';
import { delta } from '../setupEdits/fixtures/remapFixtures.js';
import type { RemapPlan } from '../setupEdits/remapPlanner.js';
import { stageInput } from './assemble.js';
import { buildRequestSchema } from './buildTypes.js';
import { createStageRunners } from './stageRunners.js';

function emptyPlan(): RemapPlan {
  return {
    teams: { retire: [], successors: [] },
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

function loaded(status = 'open'): DeltaBuildContext {
  return {
    edit_status: status,
    edit_number: 1,
    delta: delta({ brief_changed: true }),
    plan: emptyPlan(),
    edited: {
      crisis: {
        crisis_type: 'Ammonia leak',
        context: 'Night shift',
        uploaded_doc_name: null,
        uploaded_doc_text_hash: null,
        country: 'Singapore',
        org_name: 'Acme',
        duration: 60,
        auto_antagonist: true,
      },
      organisations: [],
      pressure_organisations: [],
      competitors: [],
      inject_keys: [],
      multi_org: false,
    },
    baseline_crisis: { crisis_type: 'Plant fire', context: 'Night shift' },
    injects: [],
    teams: [],
    stakeholders: [],
    personas: [],
    fact_sheet: { confirmed_facts: [], unconfirmed_claims: [] },
    fact_sheet_trainer_edited: false,
    briefing: '',
    briefing_trainer_edited: false,
    narrative: { title: 'Fire', description: '', briefing: '' },
    objectives: [],
    pages: [],
    taken_handles: [],
    taken_emails: [],
    taken_stakeholder_ids: [],
    active_keys: [],
    page_batch_size: 4,
  };
}

function generators(calls: string[]): DeltaGenerators {
  const unused = async () => {
    throw new Error('not used');
  };
  return {
    briefDiff: async () => {
      calls.push('briefDiff');
      return emptyBriefDiff('cosmetic');
    },
    reviseFactSheet: unused,
    generatePersonas: unused,
    generatePersonaGroups: unused,
    generateCharter: unused,
    generateTeamStoryline: unused,
    generateStakeholders: unused,
    generateSpokesperson: unused,
    reviseLayer: async () => ({ decisions: [], new_injects: [] }),
    reviseStakeholderText: unused,
    convergenceDelta: unused,
    reviseNarrative: unused,
    regenerateBranches: unused,
    generatePages: unused,
    revisePageHistory: unused,
  };
}

const request = buildRequestSchema.parse({
  crisis_type: 'Ammonia leak',
  context: 'Night shift',
  mode: 'setup_edit',
  setup_edit_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  organisations: [
    {
      display_name: 'Acme',
      country: 'Singapore',
      is_primary: true,
      team_roster: [{ team_name: 'Communications' }, { team_name: 'Legal' }],
    },
  ],
});

describe('edit-mode stage runners', () => {
  test('characters stores the brief diff and storyline does not call it again', async () => {
    const calls: string[] = [];
    let status = 'open';
    const runners = createStageRunners({
      loadDeltaContext: async () => loaded(status),
      deltaGenerators: generators(calls),
    });
    const ctx = { log() {}, signal: new AbortController().signal };
    const characters = (await runners.characters({ stage: 'characters', request }, ctx)) as {
      brief_diff: unknown;
      fact_sheet: DeltaBuildContext['fact_sheet'];
      personas: [];
    };
    assert.deepEqual(calls, ['briefDiff']);
    const storylineInput = stageInput('storyline', request, {
      characters: {
        personas: [],
        fact_sheet: characters.fact_sheet,
        communities: [],
        countries: [],
        brief_diff: characters.brief_diff,
        swap_premise: null,
        revisions: [],
      },
    });
    assert.equal(storylineInput.stage, 'storyline');
    if (storylineInput.stage !== 'storyline') return;
    assert.equal(storylineInput.brief_diff != null, true);
    await runners.storyline(storylineInput, ctx);
    assert.deepEqual(calls, ['briefDiff']);
    status = 'abandoned';
    await assert.rejects(() => runners.characters({ stage: 'characters', request }, ctx), /SETUP_EDIT_NOT_OPEN/);
    assert.deepEqual(calls, ['briefDiff']);
  });
});
