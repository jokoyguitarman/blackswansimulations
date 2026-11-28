import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crisisContextFrom } from '../multiOrgPipeline.js';
import { assembleReview, stageInput } from './assemble.js';
import { buildRequestSchema, type BuildRequest, type StageOutputs } from './buildTypes.js';
import type { NPCPersona, SocialInject } from '../socialCrisisGeneratorService.js';
import type { OrgRegistryEntry, Stakeholder } from '../../lib/stakeholderContract.js';

function persona(handle: string, name: string): NPCPersona {
  return {
    handle,
    name,
    type: 'npc_public',
    personality: '',
    bias: '',
    follower_count: 1,
    backstory: '',
    posting_pattern: '',
    specific_claims: [],
  };
}

function inject(title: string, pageOrgKey?: string): SocialInject {
  return {
    type: 'social_post',
    title,
    content: title,
    severity: 'low',
    inject_scope: 'team',
    target_teams: [],
    delivery_config: pageOrgKey
      ? { app: 'social_feed', page_org_key: pageOrgKey }
      : { app: 'social_feed' },
  };
}

function registry(orgKey: string, name: string): OrgRegistryEntry {
  return { org_key: orgKey, display_name: name, country: 'Singapore', side: 'protagonist' };
}

const stakeholder = { id: 'stk_1', name: 'Ada', grievance: 'pay' } as Stakeholder;

function request(extra: Record<string, unknown> = {}): BuildRequest {
  return buildRequestSchema.parse({
    crisis_type: 'Plant fire',
    context: 'A fire at the Johor plant.',
    country: 'Malaysia',
    duration: 45,
    org_name: 'Meridian',
    organisations: [
      {
        display_name: 'Meridian',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }],
      },
    ],
    pressure_organisations: [
      { display_name: 'Ministry of Labour', kind: 'regulator', country: 'Malaysia' },
      { display_name: 'No Match Union', kind: 'union', country: 'Malaysia' },
    ],
    ...extra,
  });
}

function outputs(patch: Partial<StageOutputs> = {}): StageOutputs {
  const storyOrg = registry('org_story', 'Storyline registry');
  const base: StageOutputs = {
    characters: {
      personas: [persona('ada', 'Characters Ada')],
      fact_sheet: { confirmed_facts: ['the plant burned'], unconfirmed_claims: [] },
      communities: ['Johor'],
      countries: [{ name: 'Malaysia' }],
      per_country_counts: { Malaysia: 12 },
    },
    storyline: {
      injects: [inject('backbone')],
      team_storylines: { Legal: [inject('legal beat')] },
      team_charters: [{ team_name: 'Legal', mission: 'Hold the line', responsibilities: [] }],
      stakeholders: [stakeholder],
      stakeholder_injects: [inject('kept'), inject('old page', 'org_page_old')],
      persona_twins: [persona('ada', 'Storyline Ada'), persona('bea', 'Storyline Bea')],
      orgs: [storyOrg],
      sop_steps: [
        { step_id: 'notify', name: 'Notify', description: 'Call', time_limit_minutes: 30 },
      ],
      decision_context: { leakiness: 0.4, labour_signal: true, product_safety_signal: false },
      pressure_organisations: [
        {
          display_name: ' ministry of labour ',
          org_key: 'org_mol',
          spokesperson_stakeholder_id: 'stk_mol',
        },
      ],
    },
    convergence: {
      shared_injects: [inject('shared snake')],
      convergence_gates: [inject('gate snake')],
      narrative: { title: 'Fire', description: 'A fire.', briefing: 'Brief.' },
      objectives: [
        { objective_id: 'o1', objective_name: 'Hold trust', description: 'Hold it', weight: 1 },
      ],
      dimension_labels: { public_trust: 'Snake trust' },
      intel_injects: {
        Legal: [inject('intel legal')],
        Comms: [],
        Unknown: [inject('intel unknown')],
      },
    },
    pages: {
      org_page: { page_name: 'Meridian' },
      orgs: [registry('org_pages', 'Pages registry')],
      pressure_injects: [inject('fresh page', 'org_page_new')],
      persona_twins: [persona('bea', 'Pages Bea'), persona('cy', 'Pages Cy')],
    },
  };
  return {
    characters: 'characters' in patch ? patch.characters : base.characters,
    storyline: 'storyline' in patch ? patch.storyline : base.storyline,
    convergence: 'convergence' in patch ? patch.convergence : base.convergence,
    pages: 'pages' in patch ? patch.pages : base.pages,
  };
}

function asConvergence(input: ReturnType<typeof stageInput>) {
  if (input.stage !== 'convergence') throw new Error(`expected convergence, got ${input.stage}`);
  return input;
}

function asPages(input: ReturnType<typeof stageInput>) {
  if (input.stage !== 'pages') throw new Error(`expected pages, got ${input.stage}`);
  return input;
}

describe('A1 persona twins', () => {
  test('dedupes by handle across storyline and pages, first wins', () => {
    const review = assembleReview(request(), outputs());
    assert.deepEqual(
      review.personas.map((p) => `${p.handle}:${p.name}`),
      ['ada:Characters Ada', 'bea:Storyline Bea', 'cy:Pages Cy'],
    );
    assert.deepEqual(review.per_country_counts, { Malaysia: 12 });
    assert.deepEqual(review.communities, ['Johor']);
    assert.deepEqual(review.fact_sheet.confirmed_facts, ['the plant burned']);
  });
});

describe('A2 intel injects', () => {
  test('appends to existing teams, creates unknown ones, and skips empty arrays', () => {
    const review = assembleReview(request(), outputs());
    assert.deepEqual(
      review.team_storylines.Legal.map((i) => i.title),
      ['legal beat', 'intel legal'],
    );
    assert.deepEqual(
      review.team_storylines.Unknown.map((i) => i.title),
      ['intel unknown'],
    );
    assert.equal('Comms' in review.team_storylines, false);
    assert.equal(review.storyline_injects[0]?.title, 'backbone');
  });
});

describe('A3 pressure injects', () => {
  test('replaces only injects with page_org_key, and only when non-empty', () => {
    const replaced = assembleReview(request(), outputs());
    assert.deepEqual(
      replaced.stakeholder_injects.map((i) => i.title),
      ['kept', 'fresh page'],
    );

    const kept = assembleReview(
      request(),
      outputs({
        pages: {
          org_page: { page_name: 'Meridian' },
          orgs: [registry('org_pages', 'Pages registry')],
          pressure_injects: [],
          persona_twins: [],
        },
      }),
    );
    assert.deepEqual(
      kept.stakeholder_injects.map((i) => i.title),
      ['kept', 'old page'],
    );
  });
});

describe('A4 org registry', () => {
  test('prefers pages, then falls back to storyline', () => {
    const preferred = assembleReview(request(), outputs());
    assert.deepEqual(
      preferred.org_registry.map((o) => o.org_key),
      ['org_pages'],
    );

    const fallback = assembleReview(
      request(),
      outputs({
        pages: {
          org_page: { page_name: 'Meridian' },
          orgs: [],
          pressure_injects: [],
          persona_twins: [],
        },
      }),
    );
    assert.deepEqual(
      fallback.org_registry.map((o) => o.org_key),
      ['org_story'],
    );
    assert.deepEqual(fallback.org_page, { page_name: 'Meridian' });
  });
});

describe('A5 convergence input', () => {
  test('carries Shared only when the backbone injects exist', () => {
    const req = request();
    const withBackbone = asConvergence(stageInput('convergence', req, outputs()));
    assert.deepEqual(
      withBackbone.teamStorylines.Shared.map((i) => i.title),
      ['backbone'],
    );
    assert.equal(withBackbone.teamStorylines.Legal.length, 1);
    assert.deepEqual(
      withBackbone.personas.map((p) => p.name),
      ['Characters Ada', 'Storyline Bea'],
    );
    assert.equal(withBackbone.factSheet.confirmed_facts[0], 'the plant burned');
    assert.deepEqual(withBackbone.crisisCtx, {
      crisisType: 'Plant fire',
      location: '',
      country: 'Malaysia',
      context: 'A fire at the Johor plant.',
      duration: 45,
    });

    const storyline = outputs().storyline!;
    const without = asConvergence(
      stageInput('convergence', req, outputs({ storyline: { ...storyline, injects: [] } })),
    );
    assert.equal('Shared' in without.teamStorylines, false);
    assert.equal(without.teamStorylines.Legal.length, 1);
  });
});

describe('A6 pages pressure organisations', () => {
  test('carries the storyline spokesperson ids, matched by display name, case-insensitively', () => {
    const req = request();
    const input = asPages(stageInput('pages', req, outputs()));
    assert.equal(input.pressure_organisations.length, 2);
    assert.equal(input.pressure_organisations[0]?.display_name, 'Ministry of Labour');
    assert.equal(input.pressure_organisations[0]?.org_key, 'org_mol');
    assert.equal(input.pressure_organisations[0]?.spokesperson_stakeholder_id, 'stk_mol');
    assert.equal(input.pressure_organisations[1]?.display_name, 'No Match Union');
    assert.equal(input.pressure_organisations[1]?.spokesperson_stakeholder_id, undefined);
    assert.equal(input.stakeholders[0]?.id, 'stk_1');
    assert.deepEqual(
      input.crisis,
      crisisContextFrom({
        crisis_type: req.crisis_type,
        context: req.crisis_type,
        duration: 60,
        org_name: req.org_name,
      }),
    );
  });
});

describe('A7 pages skipped', () => {
  test('has org_page null and does not throw', () => {
    const req = request();
    const skipped = assembleReview(
      req,
      outputs({
        pages: {
          skipped: true,
          org_page: { page_name: 'Should be ignored' },
          orgs: [registry('org_ignored', 'Ignored')],
          pressure_injects: [inject('should not replace', 'org_x')],
          persona_twins: [persona('cy', 'Should not appear')],
        },
        convergence: {
          sharedInjects: [inject('shared camel')],
          shared_injects: [inject('shared snake')],
          convergenceGates: [inject('gate camel')],
          convergence_gates: [inject('gate snake')],
          dimensionLabels: { public_trust: 'Camel trust' },
          dimension_labels: { public_trust: 'Snake trust' },
          narrative: { title: 'Fire', description: 'A fire.', briefing: 'Brief.' },
          objectives: [],
          intel_injects: {},
        },
      }),
    );
    assert.equal(skipped.org_page, null);
    assert.deepEqual(
      skipped.org_registry.map((o) => o.org_key),
      ['org_story'],
    );
    assert.deepEqual(
      skipped.personas.map((p) => p.handle),
      ['ada', 'bea'],
    );
    assert.deepEqual(
      skipped.stakeholder_injects.map((i) => i.title),
      ['kept', 'old page'],
    );
    assert.equal(skipped.shared_injects[0]?.title, 'shared camel');
    assert.equal(skipped.convergence_gates[0]?.title, 'gate camel');
    assert.deepEqual(skipped.dimension_labels, { public_trust: 'Camel trust' });
    assert.deepEqual(skipped.narrative, {
      title: 'Fire',
      description: 'A fire.',
      briefing: 'Brief.',
    });
    assert.equal(skipped.decision_context.labour_signal, true);
    assert.equal(skipped.sop_steps[0]?.step_id, 'notify');
    assert.equal(skipped.pressure_links[0]?.spokesperson_stakeholder_id, 'stk_mol');
    assert.equal(skipped.peace_period, undefined);

    const absent = assembleReview(req, outputs({ pages: undefined }));
    assert.equal(absent.org_page, null);
    assert.equal(absent.peace_period, undefined);
    assert.equal(absent.team_charters[0]?.team_name, 'Legal');
  });

  test('a pages stage that ran contributes its peace feed', () => {
    const review = assembleReview(
      request(),
      outputs({
        pages: {
          org_page: { page_name: 'Meridian' },
          peace_period: {
            version: 1,
            seconds: 300,
            enabled: true,
            leak_terms: ['recall'],
            posts: [
              {
                ref: 'P1',
                author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
                platform: 'facebook',
                post_format: 'text',
                content: 'Saturday breakfast',
                media_description: '',
                offset_seconds: 20,
                comments: [],
              },
            ],
          },
        },
      }),
    );
    assert.equal(review.org_page?.page_name, 'Meridian');
    assert.equal(review.peace_period?.posts[0]?.content, 'Saturday breakfast');
  });
});
