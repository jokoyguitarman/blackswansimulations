import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { noteAiCall, withAiCallCount } from '../../lib/aiCallScope.js';
import { emptyBriefDiff, type BriefDiff } from './affectedLayers.js';
import {
  TRIGGER_CLAMP_MINUTES,
  applyRevisionDecision,
  clampTriggerTime,
  filterConditions,
  substituteText,
} from './briefRevisionCore.js';
import { runDeltaBuild, runDeltaStage } from './deltaBuildRun.js';
import type {
  DeltaBuildContext,
  DeltaGenerators,
  DeltaInject,
  LayerRevisionResult,
} from './deltaBuildTypes.js';
import { delta } from './fixtures/remapFixtures.js';
import type { RemapPlan } from './remapPlanner.js';
import type { SetupSnapshot } from './setupSnapshotCore.js';

function plan(partial: Partial<RemapPlan> = {}): RemapPlan {
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
    ...partial,
  };
}

function inject(
  partial: Partial<DeltaInject> & Pick<DeltaInject, 'id' | 'inject_key' | 'layer'>,
): DeltaInject {
  return {
    title: partial.title ?? partial.inject_key,
    content: partial.content ?? '',
    trigger_time_minutes: partial.trigger_time_minutes ?? 20,
    delivery_config: partial.delivery_config ?? {
      app: 'email',
      inject_key: partial.inject_key,
      response_rubric: { criteria: ['answer the question'] },
      mood_ladder: { rungs: ['calm'] },
    },
    generation_source: 'war_room',
    provenance: 'ai_owned',
    has_history: false,
    requires_response: false,
    target_teams: [],
    type: 'email',
    severity: 'medium',
    inject_scope: 'universal',
    app: 'email',
    conditions_to_appear: undefined,
    conditions_to_cancel: undefined,
    ...partial,
  };
}

function edited(): SetupSnapshot {
  return {
    crisis: {
      crisis_type: 'Ammonia leak',
      context: 'The night shift',
      uploaded_doc_name: null,
      uploaded_doc_text_hash: null,
      country: 'Singapore',
      org_name: 'Acme',
      duration: 60,
      auto_antagonist: true,
    },
    organisations: [
      {
        org_uid: 'uid-acme',
        org_key: 'primary',
        display_name: 'Acme',
        short_name: 'ACME',
        country: 'Singapore',
        kind: 'company',
        operation: 'players',
        is_primary: true,
        teams: [],
      },
    ],
    pressure_organisations: [],
    competitors: [],
    inject_keys: [],
    multi_org: false,
  };
}

function context(partial: Partial<DeltaBuildContext> = {}): DeltaBuildContext {
  return {
    edit_number: 2,
    delta: delta({ brief_changed: true }),
    plan: plan(),
    edited: edited(),
    baseline_crisis: { crisis_type: 'Plant fire', context: 'Night shift' },
    injects: [],
    teams: [],
    stakeholders: [],
    personas: [],
    fact_sheet: { confirmed_facts: ['The plant is in Jurong'], unconfirmed_claims: [] },
    fact_sheet_trainer_edited: false,
    briefing: 'Watch the feed.',
    briefing_trainer_edited: false,
    narrative: { title: 'Fire', description: 'A fire', briefing: 'Watch the feed.' },
    objectives: [
      {
        objective_id: 'contain',
        objective_name: 'Contain',
        description: 'Stop it',
        weight: 50,
        has_scores: false,
      },
    ],
    pages: [],
    taken_handles: [],
    taken_emails: [],
    taken_stakeholder_ids: [],
    active_keys: [],
    page_batch_size: 4,
    team_dependencies: [],
    ...partial,
  };
}

function recording(diff: BriefDiff, layer?: (name: string) => LayerRevisionResult) {
  const calls: string[] = [];
  const note = (name: string) => {
    calls.push(name);
    noteAiCall();
  };
  const generators = {
    async briefDiff() {
      note('briefDiff');
      return diff;
    },
    async reviseFactSheet() {
      note('reviseFactSheet');
      return { confirmed_facts: ['The plant is in Jurong'], unconfirmed_claims: [] };
    },
    async generatePersonas() {
      note('generatePersonas');
      return [];
    },
    async generatePersonaGroups() {
      note('generatePersonaGroups');
      return [];
    },
    async generateCharter() {
      note('generateCharter');
      return { team_name: 'Audit', mission: 'Audit', responsibilities: [] };
    },
    async generateTeamStoryline() {
      note('generateTeamStoryline');
      return [];
    },
    async generateStakeholders() {
      note('generateStakeholders');
      return { stakeholders: [], injects: [] };
    },
    async generateSpokesperson() {
      note('generateSpokesperson');
      return { stakeholder: null, injects: [] };
    },
    async reviseLayer(input) {
      note(`reviseLayer:${input.layer}`);
      return (
        layer?.(input.layer) ?? {
          decisions: input.owned.map((row) => ({ inject_id: row.id, decision: 'keep' as const })),
          new_injects: [],
        }
      );
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
      return {
        narrative: {
          title: 'Recentred',
          description: 'Beta is at the centre.',
          briefing: 'Brief the new centre.',
        },
        objectives: [
          {
            objective_id: 'contain',
            objective_name: 'Contain',
            description: 'Stop it',
            weight: 40,
          },
        ],
      };
    },
    async regenerateBranches(input) {
      note(`regenerateBranches:${input.parentKey}`);
      return [
        {
          title: 'Follow up',
          content: 'Again',
          type: 'email',
          severity: 'high',
          inject_scope: 'universal',
          target_teams: [],
          delivery_config: { app: 'email' },
        },
      ];
    },
    async dependencyDelta() {
      note('dependencyDelta');
      return { edges: [], consequences: [], positives: [], asks: [] };
    },
    async generatePages() {
      note('generatePages');
      return [];
    },
    async revisePageHistory(input) {
      note(`revisePageHistory:${input.orgKey}`);
      return [{ content: 'New history' }];
    },
  } satisfies DeltaGenerators;
  return { calls, generators };
}

describe('brief revision guards', () => {
  test('renames are whole-word and case-preserving', () => {
    assert.equal(
      substituteText('Harbour closed. The harbourmaster stayed.', [
        { from: 'Harbour', to: 'Harbor' },
      ]),
      'Harbor closed. The harbourmaster stayed.',
    );
    assert.equal(substituteText('HARBOUR', [{ from: 'harbour', to: 'harbor' }]), 'HARBOR');
  });

  test('a minute argument is not treated as an inject key', () => {
    const active = new Set(['parent_a']);
    assert.deepEqual(filterConditions(['unopened:parent_a:10'], active), ['unopened:parent_a:10']);
    assert.deepEqual(filterConditions(['unopened:retired_key:10'], active), []);
    assert.equal(filterConditions({ all: ['inject_published:parent_a'] }, active) != null, true);
  });

  test('a facts revision cannot move a trigger by more than 15 minutes', () => {
    assert.equal(clampTriggerTime(20, 50, 'facts'), 20 + TRIGGER_CLAMP_MINUTES);
    assert.equal(clampTriggerTime(20, 50, 'story'), 50);
    assert.equal(clampTriggerTime(20, 0, 'facts'), 5);
  });

  test('a Review rejection keeps the original row active and unretired', () => {
    const original = { id: 'row-1', title: 'Old', content: 'Old text' };
    const revision = {
      decision: 'revise' as const,
      accepted: true,
      write: 'cow' as const,
      new: {
        title: 'New',
        content: 'New text',
        delivery_config: { app: 'email', inject_key: 'leak' },
      },
    };
    const accepted = applyRevisionDecision(original, revision, 'accept');
    assert.equal(accepted.retired, true);
    assert.equal(accepted.active.title, 'New');
    assert.equal('id' in accepted.active, false);
    const rejected = applyRevisionDecision(
      original,
      { ...revision, decision: 'retire', write: 'retire' },
      'reject',
    );
    assert.equal(rejected.retired, false);
    assert.deepEqual(rejected.active, original);
  });
});

describe('brief revision pipeline', () => {
  test('a cosmetic change makes one call and revises nothing', async () => {
    const { calls, generators } = recording(emptyBriefDiff('cosmetic'));
    const { result, calls: counted } = await withAiCallCount(() =>
      runDeltaBuild(context(), generators),
    );
    assert.deepEqual(calls, ['briefDiff']);
    assert.equal(counted, 1);
    assert.deepEqual(result.characters.revisions, []);
    assert.equal(result.characters.setup_source_update?.crisis_type, 'Ammonia leak');
    assert.equal(result.storyline.skipped, true);
    assert.equal(result.convergence.skipped, true);
    assert.equal(result.pages.skipped, true);
  });

  test('renamed entities are substituted in AI-owned content and only suggested for hand edits', async () => {
    const brief = emptyBriefDiff('facts');
    brief.renamed_entities = [{ from: 'Harbour', to: 'Harbor' }];
    const { calls, generators } = recording(brief);
    const owned = inject({
      id: 'ai-1',
      inject_key: 'harbour_note',
      layer: 'team:legal',
      title: 'Harbour closed',
      content: 'Harbour is shut.',
    });
    const hand = inject({
      id: 'hand-1',
      inject_key: 'harbour_hand',
      layer: 'team:legal',
      title: 'Harbour note',
      content: 'Harbour stays.',
      provenance: 'hand_edited',
      generation_source: 'trainer',
    });
    const result = await runDeltaBuild(
      context({ injects: [owned, hand], active_keys: ['harbour_note', 'harbour_hand'] }),
      generators,
    );
    assert.equal(calls.includes('reviseLayer:team:legal'), false);
    const revised = result.storyline.revisions.find((row) => row.inject_id === 'ai-1');
    assert.equal(revised?.decision, 'revise');
    assert.equal(revised?.new?.title, 'Harbor closed');
    assert.equal(revised?.new?.content, 'Harbor is shut.');
    assert.equal(
      result.storyline.revisions.some((row) => row.inject_id === 'hand-1'),
      false,
    );
    const flag = result.storyline.flags.find((row) => row.inject_id === 'hand-1');
    assert.equal(flag?.suggestion?.title, 'Harbor note');
    assert.equal(flag?.provenance, 'hand_edited');
  });

  test('an unaffected layer is not sent to the model', async () => {
    const brief = emptyBriefDiff('facts');
    brief.fact_changes = [{ kind: 'change', old: 'chlorine drum', new: 'ammonia drum' }];
    const { calls, generators } = recording(brief);
    const result = await runDeltaBuild(
      context({
        injects: [
          inject({
            id: 'a',
            inject_key: 'chem',
            layer: 'team:comms',
            content: 'A chlorine drum vented.',
          }),
          inject({
            id: 'b',
            inject_key: 'rota',
            layer: 'team:legal',
            content: 'Legal reviews the rota.',
          }),
        ],
      }),
      generators,
    );
    assert.equal(calls.includes('reviseLayer:team:comms'), true);
    assert.equal(calls.includes('reviseLayer:team:legal'), false);
    assert.ok(
      result.storyline.revisions.some((row) => row.inject_id === 'a' && row.decision === 'keep'),
    );
  });

  test('a revised inject keeps its key, app, rubric and escalation config, and its time is clamped', async () => {
    const brief = emptyBriefDiff('facts');
    brief.affected_layers = ['backbone'];
    const { generators } = recording(brief, () => ({
      decisions: [
        {
          inject_id: 'leak',
          decision: 'revise',
          title: 'Updated leak',
          content: 'The drum moved.',
          trigger_time_minutes: 80,
          reason: 'The chemical changed.',
        },
      ],
      new_injects: [],
    }));
    const source = inject({
      id: 'leak',
      inject_key: 'leak_note',
      layer: 'backbone',
      title: 'Leak',
      content: 'A drum.',
      trigger_time_minutes: 20,
    });
    const result = await runDeltaBuild(
      context({ injects: [source], active_keys: ['leak_note'] }),
      generators,
    );
    const revision = result.storyline.revisions.find((row) => row.inject_id === 'leak');
    assert.equal(revision?.decision, 'revise');
    assert.equal(revision?.inject_key, 'leak_note');
    assert.equal(revision?.new?.delivery_config.inject_key, 'leak_note');
    assert.equal(revision?.new?.delivery_config.app, 'email');
    assert.deepEqual(revision?.new?.delivery_config.response_rubric, {
      criteria: ['answer the question'],
    });
    assert.deepEqual(revision?.new?.delivery_config.mood_ladder, { rungs: ['calm'] });
    assert.equal(revision?.carried.escalation, true);
    assert.equal(revision?.new?.trigger_time_minutes, 35);
    assert.equal(revision?.accepted, true);
    const gen = revision?.new?.delivery_config.gen as { layer: string; edit: number; hash: string };
    assert.equal(gen.layer, 'backbone');
    assert.equal(gen.edit, 2);
    assert.equal(typeof gen.hash, 'string');
  });

  test('a retire referenced by a hand-edited inject is downgraded to revise', async () => {
    const brief = emptyBriefDiff('facts');
    brief.affected_layers = ['backbone'];
    const { generators } = recording(brief, () => ({
      decisions: [{ inject_id: 'leak', decision: 'retire', reason: 'No longer true.' }],
      new_injects: [],
    }));
    const leak = inject({ id: 'leak', inject_key: 'leak_note', layer: 'backbone' });
    const hand = inject({
      id: 'hand',
      inject_key: 'hand_note',
      layer: 'team:legal',
      provenance: 'hand_edited',
      generation_source: 'trainer',
      conditions_to_appear: ['inject_published:leak_note'],
    });
    const result = await runDeltaBuild(context({ injects: [leak, hand] }), generators);
    const revision = result.storyline.revisions.find((row) => row.inject_id === 'leak');
    assert.equal(revision?.decision, 'revise');
    assert.equal(revision?.write === 'retire', false);
    assert.match(revision?.reason ?? '', /hand-edited/);
  });

  test('response branches are regenerated only for revised parents', async () => {
    const brief = emptyBriefDiff('facts');
    brief.affected_layers = ['backbone'];
    const { calls, generators } = recording(brief, () => ({
      decisions: [
        { inject_id: 'a', decision: 'revise', title: 'A2', content: 'Revised', reason: 'Changed.' },
        { inject_id: 'b', decision: 'keep' },
        { inject_id: 'c', decision: 'retire', reason: 'Dropped.' },
      ],
      new_injects: [],
    }));
    const parent = (id: string, key: string): DeltaInject =>
      inject({ id, inject_key: key, layer: 'backbone', requires_response: true });
    const branch = (id: string, parentKey: string): DeltaInject =>
      inject({
        id,
        inject_key: `${parentKey}_branch`,
        layer: `branch:${parentKey}`,
        content: 'Old branch',
      });
    const result = await runDeltaBuild(
      context({
        injects: [
          parent('a', 'parent_a'),
          parent('b', 'parent_b'),
          parent('c', 'parent_c'),
          branch('ba', 'parent_a'),
          branch('bc', 'parent_c'),
        ],
      }),
      generators,
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith('regenerateBranches:')),
      ['regenerateBranches:parent_a'],
    );
    assert.equal(
      result.storyline.revisions.find((row) => row.inject_id === 'bc')?.decision,
      'retire',
    );
    assert.equal(result.storyline.generated.branches.length > 0, true);
    assert.equal(
      result.storyline.generated.branches[0]?.delivery_config.parent_inject_key,
      'parent_a',
    );
  });

  test('a primary swap with an unchanged brief revises the centre layers and leaves a pressure layer', async () => {
    const { calls, generators } = recording(emptyBriefDiff('cosmetic'));
    const swapPlan = plan({
      primary_swap: {
        from_org_uid: 'uid-acme',
        to_org_uid: 'uid-beta',
        to_is_new: false,
        map: { primary: 'org_acme', org_b: 'primary' },
        old_primary_key: 'primary',
        old_primary_new_key: 'org_acme',
        new_primary_previous_key: 'org_b',
        story: {
          severity: 'story',
          premise:
            'Beta is now the organisation at the centre of the crisis; Acme becomes a supporting organisation',
        },
      },
    });
    const result = await runDeltaBuild(
      context({
        delta: delta({
          brief_changed: false,
          primary_swap: { from_org_uid: 'uid-acme', to_org_uid: 'uid-beta', to_is_new: false },
        }),
        plan: swapPlan,
        injects: [
          inject({
            id: 'spine',
            inject_key: 'spine',
            layer: 'backbone',
            content: 'Acme is in crisis.',
          }),
          inject({
            id: 'leaflet',
            inject_key: 'leaflet',
            layer: 'pressure:org_union',
            content: 'The union printed a leaflet.',
          }),
        ],
        pages: [
          {
            org_key: 'org_b',
            display_name: 'Beta',
            history: [],
            historyText: 'Beta opened a depot.',
            is_primary: false,
          },
        ],
      }),
      generators,
    );
    assert.equal(calls.includes('briefDiff'), true);
    assert.equal(calls.includes('reviseFactSheet'), false);
    assert.equal(calls.includes('reviseLayer:backbone'), true);
    assert.equal(calls.includes('reviseLayer:pressure:org_union'), false);
    assert.equal(calls.includes('reviseNarrative'), true);
    assert.equal(calls.includes('revisePageHistory:org_b'), true);
    assert.equal(
      result.characters.brief_diff?.added_premises[0]?.includes('centre of the crisis'),
      true,
    );
    assert.equal(result.convergence.narrative_update?.briefing_kept, false);
    assert.equal(result.convergence.narrative?.title, 'Recentred');
  });

  test('a relocation without a brief change still clamps the trigger', async () => {
    const { generators } = recording(emptyBriefDiff('facts'), () => ({
      decisions: [
        {
          inject_id: 'move',
          decision: 'revise',
          title: 'Moved',
          content: 'Now in Malaysia.',
          trigger_time_minutes: 55,
          reason: 'The office moved.',
        },
      ],
      new_injects: [],
    }));
    const result = await runDeltaStage(
      'storyline',
      context({
        delta: delta({
          brief_changed: false,
          relocated_orgs: [
            { org_key: 'primary', from_country: 'Singapore', to_country: 'Malaysia' },
          ],
        }),
        injects: [
          inject({
            id: 'move',
            inject_key: 'move_note',
            layer: 'team:team-comms',
            trigger_time_minutes: 20,
          }),
        ],
        teams: [{ team_uid: 'team-comms', team_name: 'Communications', org_key: 'primary' }],
      }),
      generators,
    );
    assert.equal(
      result.revisions.find((row) => row.inject_id === 'move')?.new?.trigger_time_minutes,
      35,
    );
  });

  test('a hand-edited branch is flagged and a referenced branch is not retired', async () => {
    const brief = emptyBriefDiff('facts');
    brief.affected_layers = ['backbone'];
    const { generators } = recording(brief, () => ({
      decisions: [
        { inject_id: 'a', decision: 'revise', title: 'A2', content: 'Revised', reason: 'Changed.' },
      ],
      new_injects: [],
    }));
    const parent = inject({
      id: 'a',
      inject_key: 'parent_a',
      layer: 'backbone',
      requires_response: true,
    });
    const handBranch = inject({
      id: 'hand-branch',
      inject_key: 'hand_branch',
      layer: 'branch:parent_a',
      provenance: 'hand_edited',
      generation_source: 'trainer',
      content: 'Our wording.',
    });
    const ownedBranch = inject({
      id: 'owned-branch',
      inject_key: 'owned_branch',
      layer: 'branch:parent_a',
      content: 'Old follow-up.',
    });
    const keeper = inject({
      id: 'keeper',
      inject_key: 'keeper_note',
      layer: 'team:legal',
      provenance: 'hand_edited',
      generation_source: 'trainer',
      conditions_to_appear: ['inject_fired:owned_branch'],
    });
    const result = await runDeltaStage(
      'storyline',
      context({
        delta: delta({ brief_changed: true }),
        injects: [parent, handBranch, ownedBranch, keeper],
      }),
      generators,
      { briefDiff: brief, swapPremise: null, retiredKeys: [] },
    );
    assert.equal(
      result.revisions.some((row) => row.inject_id === 'hand-branch' && row.decision === 'retire'),
      false,
    );
    assert.equal(
      result.flags.some((flag) => flag.inject_id === 'hand-branch'),
      true,
    );
    const owned = result.revisions.find((row) => row.inject_id === 'owned-branch');
    assert.equal(owned?.decision, 'revise');
    assert.notEqual(owned?.write, 'retire');
  });

  test('a rename-only brief substitutes branch text and does not call the branch generator', async () => {
    const brief = emptyBriefDiff('facts');
    brief.renamed_entities = [{ from: 'Harbour', to: 'Harbor' }];
    const { calls, generators } = recording(brief);
    const parent = inject({
      id: 'note',
      inject_key: 'harbour_note',
      layer: 'team:legal',
      title: 'Harbour closed',
      content: 'Harbour is shut.',
      requires_response: true,
    });
    const branch = inject({
      id: 'branch',
      inject_key: 'harbour_branch',
      layer: 'branch:harbour_note',
      title: 'Harbour follow-up',
      content: 'Harbour again.',
    });
    const result = await runDeltaStage(
      'storyline',
      context({ delta: delta({ brief_changed: true }), injects: [parent, branch] }),
      generators,
      { briefDiff: brief, swapPremise: null, retiredKeys: [] },
    );
    assert.equal(
      calls.some((call) => call.startsWith('regenerateBranches:')),
      false,
    );
    const revised = result.revisions.find((row) => row.inject_id === 'branch');
    assert.equal(revised?.origin, 'substitution');
    assert.equal(revised?.new?.title, 'Harbor follow-up');
  });
});
