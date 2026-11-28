import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConditionalInjects } from '../conditions/conditionalInjectsCore.js';
import { validateEscalation, type EscalationConfig } from '../escalation/escalationCore.js';
import { responseRubricError } from '../judging/judgeCore.js';
import { validateMoodLadder } from '../mood/moodCore.js';
import type { SocialInject } from '../socialCrisisGeneratorService.js';
import {
  attachResponseBranches,
  moodLadderChatOptions,
  type ResponseBranchClient,
} from './responseBranchService.js';
import {
  countChasers,
  escalatedVariantFor,
  postProcessEscalation,
  postProcessMoodLadder,
  pruneDoubleChase,
  redialForCaller,
  stakeholdersForLadders,
  teamsMissingCrossChannelChain,
  type ChainStakeholder,
} from './chainLadderCore.js';

const stakeholders: ChainStakeholder[] = [
  {
    id: 'stk_supplier',
    name: 'Priya Raman',
    relationship: 'supplier',
    persuadability: 'medium',
    organisation: 'Mill Co',
    title: 'Account manager',
    owning_team: 'Ops',
  },
  {
    id: 'stk_director',
    name: 'Helen Cho',
    relationship: 'supplier',
    persuadability: 'low',
    organisation: 'Mill Co',
    title: 'Operations Director',
    owning_team: 'Ops',
  },
  {
    id: 'stk_union',
    name: 'Alex Tan',
    relationship: 'union',
    persuadability: 'low',
    organisation: 'Union Hall',
    title: 'Representative',
    owning_team: 'Comms',
  },
  {
    id: 'stk_partner',
    name: 'Pastor Daniel',
    relationship: 'partner',
    persuadability: 'high',
    title: 'Pastor',
    organisation: 'Fellowship',
    owning_team: 'Comms',
  },
];

describe('chain post-processing', () => {
  test('fixes a decreasing urgency, drops an invented sender, and clamps intervals', () => {
    const result = postProcessEscalation(
      {
        max_steps: 3,
        steps: [
          {
            after_minutes: 1,
            urgency: 'urgent',
            app: 'email',
            content_mode: 'template',
            template: 'Checking after 2 minutes.',
          },
          {
            after_minutes: 90,
            urgency: 'follow_up',
            app: 'npc_dm',
            sender_stakeholder_id: 'stk_nobody',
            content_mode: 'template',
            template: 'It has been 90 minutes.',
          },
          {
            after_minutes: 5,
            urgency: 'escalated',
            app: 'social_feed',
            content_mode: 'template',
            template: 'No answer after {minutes_waiting} minutes.',
          },
        ],
      },
      {
        rootKey: 'supplier_4471',
        rootApp: 'email',
        rootStakeholderId: 'stk_supplier',
        rootTriggerMinute: 10,
        durationMinutes: 90,
        stakeholders,
      },
    );
    assert.equal(result.dropped, false);
    const steps = result.escalation?.steps ?? [];
    assert.equal(steps.length, 3);
    assert.equal(steps[0]?.after_minutes, 3);
    assert.equal(steps[0]?.urgency, 'urgent');
    assert.match(steps[0]?.template ?? '', /\{minutes_waiting\}/);
    assert.equal(steps[1]?.after_minutes, 15);
    assert.equal(steps[1]?.urgency, 'urgent');
    assert.equal(steps[1]?.sender_stakeholder_id, undefined);
    assert.equal(steps[2]?.urgency, 'escalated');
    assert.equal(steps[2]?.app, 'social_feed');
    assert.equal(JSON.stringify(result.escalation).includes('stk_nobody'), false);
    assert.ok(result.repairs.includes('urgency'));
    assert.ok(result.repairs.includes('sender'));
    assert.ok(result.repairs.includes('interval'));
    assert.deepEqual(
      validateEscalation({
        escalation: result.escalation,
        rootApp: 'email',
        rootStakeholderId: 'stk_supplier',
        stakeholderIds: stakeholders.map((stakeholder) => stakeholder.id),
        durationMinutes: 90,
        rootKey: 'supplier_4471',
        rootTriggerMinute: 10,
        otherInjects: [],
      }).filter((issue) => issue.level === 'error'),
      [],
    );
  });

  test('drops a chain that cannot finish inside the scenario', () => {
    const result = postProcessEscalation(
      {
        steps: [{ after_minutes: 10, urgency: 'final', app: 'email', content_mode: 'template' }],
      },
      {
        rootKey: 'late_note',
        rootApp: 'email',
        rootStakeholderId: null,
        rootTriggerMinute: 0,
        durationMinutes: 5,
        stakeholders: [],
      },
    );
    assert.equal(result.escalation, null);
    assert.equal(result.dropped, true);
  });
});

describe('ladder post-processing', () => {
  test('forces the first rung when to {} and moves a terminal rung last', () => {
    const result = postProcessMoodLadder(
      {
        gave_up_after_minutes: 40,
        escalated_variant: 'angry',
        recovery: 'one_rung_per_good_reply',
        rungs: [
          {
            id: 'calm',
            label: 'Calm',
            when: { any: [{ wait_minutes_gte: 1 }] },
            reply_style: 'Polite.',
            script: { opening: 'Hello.', lines: ['I can wait.'] },
            consequences: [],
          },
          {
            id: 'gave_up',
            label: 'Gave up',
            terminal: true,
            when: { all: [{ wait_minutes_gte: 'gave_up_after' }] },
            reply_style: 'Cold.',
            script: { opening: 'I stopped waiting.', lines: ['I have spoken to the press.'] },
            consequences: [{ type: 'publish_inject', inject_key: 'missing_key' }],
          },
          {
            id: 'upset',
            label: 'Upset',
            when: { any: [{ wait_minutes_gte: 12 }] },
            reply_style: 'Frustrated.',
            script: { opening: 'You ignored me.', lines: [] },
            consequences: [],
          },
        ],
      },
      { stakeholder: stakeholders[2], goPublicKey: 'union_goes_public', durationMinutes: 90 },
    );
    assert.deepEqual(result.ladder.rungs[0]?.when, {});
    assert.equal(result.ladder.rungs.at(-1)?.id, 'gave_up');
    assert.equal(result.ladder.rungs.at(-1)?.terminal, true);
    assert.ok(result.repairs.includes('first_when'));
    assert.ok(result.repairs.includes('terminal_last'));
    const publish = result.ladder.rungs.at(-1)?.consequences.find((item) => item.type === 'publish_inject');
    assert.equal(publish && 'inject_key' in publish ? publish.inject_key : '', 'union_goes_public');
    assert.equal(result.ladder.escalated_variant, 'angry');
    const upset = result.ladder.rungs.find((rung) => rung.id === 'upset');
    assert.deepEqual(upset?.script.lines, ['You ignored me.']);
    assert.deepEqual(validateMoodLadder({ ladder: result.ladder }), []);
  });

  test('angry for union and activists, disappointed for partners and elders', () => {
    assert.equal(escalatedVariantFor(stakeholders[2]), 'angry');
    assert.equal(escalatedVariantFor(stakeholders[3]), 'disappointed');
    assert.equal(
      escalatedVariantFor({ id: 'stk_act', relationship: 'community', title: 'Activist' }),
      'angry',
    );
  });
});

describe('double-chase pruning', () => {
  test('keeps exactly one chaser per key', () => {
    const escalation: EscalationConfig = {
      max_steps: 2,
      scope: 'per_team',
      stop_on: 'any_response',
      stop_on_contact: true,
      steps: [
        { after_minutes: 5, urgency: 'follow_up', app: 'npc_dm', content_mode: 'template', template: 'Checking {ask}.' },
        { after_minutes: 5, urgency: 'escalated', app: 'social_feed', content_mode: 'template', template: 'Still waiting on {ask}.' },
      ],
    };
    const branches = [
      branch('no_reply', 'Chaser', 'email', 'supplier_chaser', ['email_unreplied:supplier_4471:10']),
      branch('no_reply', 'Supplier phones', 'phone_call', 'supplier_phone', ['email_unreplied:supplier_4471:15']),
      branch('no_reply', 'Public complaint', 'social_feed', 'supplier_public', [
        'email_unreplied:supplier_4471:15',
        'call_missed:supplier_phone',
      ]),
      branch('poor_reply', 'Escalates to legal', 'email', 'supplier_legal', ['reply_tone:supplier_4471:defensive']),
    ];
    const kept = pruneDoubleChase(branches, new Map([['supplier_4471', escalation]]));
    assert.equal(countChasers('supplier_4471', kept, true), 1);
    assert.equal(kept.filter((item) => item.delivery_config?.branch === 'no_reply').length, 1);
    assert.equal(kept.some((item) => item.title === 'Public complaint'), true);
    assert.equal(kept.some((item) => item.title === 'Escalates to legal'), true);
    assert.equal(kept.some((item) => item.title === 'Chaser'), false);
    assert.equal(escalation.on_exhausted?.publish_inject_key, 'supplier_public');
    const complaint = kept.find((item) => item.title === 'Public complaint');
    assert.deepEqual(complaint?.conditions_to_appear, { all: ['chain_exhausted:supplier_4471'] });
  });
});

describe('redials', () => {
  test('stakeholders who push, and media, community or union, redial inside the authored range', () => {
    const pushing = redialForCaller({ persuadability: 'medium', relationship: 'supplier' }, 'supplier_call');
    assert.ok(pushing.attempts === 2 || pushing.attempts === 3);
    assert.ok(
      pushing.interval_minutes === 2 || pushing.interval_minutes === 3 || pushing.interval_minutes === 4,
    );
    assert.deepEqual(redialForCaller({ persuadability: 'low', relationship: 'union' }, 'union_call').attempts > 1, true);
    assert.deepEqual(redialForCaller({ persuadability: 'high', relationship: 'investor' }, 'investor_call'), {
      attempts: 1,
    });
    assert.deepEqual(redialForCaller(null, 'stray_call'), { attempts: 1 });
    assert.deepEqual(
      redialForCaller({ persuadability: 'medium', relationship: 'supplier' }, 'supplier_call'),
      pushing,
    );
  });
});

describe('who gets a ladder', () => {
  test('a cast of 8 or fewer includes roster stakeholders; a larger cast keeps principals', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      tier: index === 7 ? 'roster' : 'principal',
    }));
    assert.equal(stakeholdersForLadders(eight).length, 8);
    const nine = [...eight, { id: 's8', tier: 'principal' }];
    const selected = stakeholdersForLadders(nine);
    assert.equal(selected.some((stakeholder) => stakeholder.tier === 'roster'), false);
    assert.equal(selected.length, 8);
  });
});

describe('generated scenario', () => {
  test('chains, redials and ladders pass the validators', async () => {
    const calls = { branches: 0, ladders: 0 };
    const client: ResponseBranchClient = {
      async complete(request) {
        if (request.system.includes('mood ladder')) {
          calls.ladders += 1;
          return {
            ladders: [
              {
                stakeholder_id: 'stk_union',
                mood_ladder: {
                  gave_up_after_minutes: 40,
                  escalated_variant: 'angry',
                  recovery: 'one_rung_per_good_reply',
                  rungs: [
                    {
                      id: 'calm',
                      label: 'Calm',
                      when: { any: [{ wait_minutes_gte: 1 }] },
                      reply_style: 'Steady.',
                      script: { opening: 'Alex here.', lines: ['I can give you a few minutes.'] },
                      consequences: [],
                    },
                    {
                      id: 'gave_up',
                      label: 'Gave up',
                      terminal: true,
                      when: { all: [{ wait_minutes_gte: 'gave_up_after' }] },
                      reply_style: 'Cold.',
                      script: { opening: 'I stopped waiting.', lines: ['The hall will hear about this.'] },
                      consequences: [{ type: 'publish_inject', inject_key: 'missing_key' }],
                    },
                    {
                      id: 'upset',
                      label: 'Upset',
                      when: { any: [{ wait_minutes_gte: 12 }] },
                      reply_style: 'Short.',
                      script: { opening: 'You left the workers waiting.', lines: ['Name a time.'] },
                      consequences: [],
                    },
                  ],
                },
                goes_public: {
                  inject_key: 'union_goes_public',
                  title: 'Union takes the silence public',
                  content: 'Alex Tan says the company stopped answering and the hall is going to the press.',
                },
              },
            ],
          };
        }
        calls.branches += 1;
        return {
          branches: [
            noReply('supplier_4471', 'Supplier chaser', 'email', 'supplier_chaser', [
              'email_unreplied:supplier_4471:10',
            ]),
            noReply('supplier_4471', 'Supplier phones', 'phone_call', 'supplier_phone', [
              'email_unreplied:supplier_4471:15',
            ]),
            noReply('supplier_4471', 'Supplier goes public', 'social_feed', 'supplier_public', [
              'email_unreplied:supplier_4471:15',
              'call_missed:supplier_phone',
            ]),
            noReply('union_call', 'Union chaser', 'phone_call', 'union_chaser', ['call_missed:union_call']),
            noReply('union_call', 'Union posts', 'social_feed', 'union_public', ['call_unreturned:union_call:10']),
            {
              parent_inject_key: 'supplier_4471',
              branch: 'poor_reply',
              title: 'Counsel writes',
              content: 'Your reply dodged the deadline. Counsel will write.',
              delivery_config: { app: 'email', inject_key: 'supplier_legal' },
              conditions_to_appear: { all: ['reply_tone:supplier_4471:defensive'] },
              conditions_to_cancel: ['reply_best_passed:supplier_4471'],
            },
          ],
          rubrics: [
            {
              inject_key: 'supplier_4471',
              asks: ['state when the notice goes out'],
              criteria: ['names a time', 'does not admit liability', 'stays professional'],
              expected_tone: ['professional'],
              pass_threshold: 2,
            },
          ],
          escalations: [
            {
              inject_key: 'supplier_4471',
              escalation: {
                max_steps: 3,
                steps: [
                  {
                    after_minutes: 1,
                    urgency: 'urgent',
                    app: 'email',
                    content_mode: 'template',
                    template: 'Checking after 2 minutes.',
                  },
                  {
                    after_minutes: 90,
                    urgency: 'follow_up',
                    app: 'npc_dm',
                    sender_stakeholder_id: 'stk_nobody',
                    content_mode: 'template',
                    template: 'It has been 90 minutes.',
                  },
                  {
                    after_minutes: 5,
                    urgency: 'escalated',
                    app: 'social_feed',
                    content_mode: 'template',
                    template: 'No answer after {minutes_waiting} minutes.',
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const email = inject('email', 'supplier_4471', 'stk_supplier', ['Ops'], 10, 'When does the notice go out?');
    const unionCall = inject('phone_call', 'union_call', 'stk_union', ['Comms'], 12, 'Who speaks to the workers?');
    const investorCall = inject(
      'phone_call',
      'investor_call',
      'stk_investor',
      ['Board'],
      14,
      'What do we tell the board?',
    );
    const cast: ChainStakeholder[] = [
      ...stakeholders,
      {
        id: 'stk_investor',
        name: 'Rita Shah',
        relationship: 'investor',
        persuadability: 'high',
        organisation: 'North Fund',
        title: 'Partner',
        owning_team: 'Board',
      },
    ];
    const sink: SocialInject[] = [];
    await attachResponseBranches({
      crisis: { crisisType: 'recall', duration: 90, country: 'Singapore', context: 'batch 4471' },
      factSheet: { confirmed_facts: ['Batch 4471 failed a check'], unconfirmed_claims: [] },
      stakeholders: cast,
      injects: [email, unionCall, investorCall],
      branchSink: sink,
      client,
    });

    assert.equal(calls.branches, 1);
    assert.equal(calls.ladders, 1);
    assert.deepEqual(teamsMissingCrossChannelChain([email, unionCall, investorCall, ...sink], cast), []);
    assert.equal(countChasers('supplier_4471', sink, true), 1);
    assert.equal(countChasers('union_call', sink, true), 1);

    const supplierChain = email.delivery_config.escalation as EscalationConfig;
    assert.equal(supplierChain.steps[0]?.after_minutes, 3);
    assert.equal(supplierChain.steps[1]?.urgency, 'urgent');
    assert.equal(JSON.stringify(supplierChain).includes('stk_nobody'), false);
    assert.equal(supplierChain.on_exhausted?.publish_inject_key, 'supplier_public');

    const unionRedial = unionCall.delivery_config.redial as { attempts: number; interval_minutes?: number };
    const investorRedial = investorCall.delivery_config.redial as { attempts: number };
    assert.ok(unionRedial.attempts >= 2 && unionRedial.attempts <= 3);
    assert.equal(investorRedial.attempts, 1);

    for (const stakeholder of cast) {
      assert.ok(stakeholder.mood_ladder, stakeholder.id);
      const article = sink.find((item) =>
        item.conditions_to_appear &&
        'all' in item.conditions_to_appear &&
        item.conditions_to_appear.all?.some((key) => key === `stakeholder_gave_up:${stakeholder.id}`),
      );
      assert.ok(article, stakeholder.id);
      assert.equal(article?.trigger_time_minutes ?? null, null);
      assert.deepEqual(
        validateMoodLadder({
          ladder: stakeholder.mood_ladder,
          knownInjects: sink
            .map((item) => ({
              key: item.delivery_config.inject_key ?? '',
              conditional: item.trigger_time_minutes == null,
            }))
            .filter((item) => item.key),
        }),
        [],
      );
    }
    const unionLadder = cast.find((stakeholder) => stakeholder.id === 'stk_union')?.mood_ladder as {
      escalated_variant: string;
      rungs: Array<{ id: string; when: unknown; terminal?: boolean }>;
    };
    assert.equal(unionLadder.escalated_variant, 'angry');
    assert.deepEqual(unionLadder.rungs[0]?.when, {});
    assert.equal(unionLadder.rungs.at(-1)?.terminal, true);

    const validated = validateConditionalInjects({
      duration_minutes: 90,
      injects: [email, unionCall, investorCall, ...sink],
      stakeholders: cast.map((stakeholder) => ({
        id: stakeholder.id,
        mood_ladder: stakeholder.mood_ladder,
      })),
    });
    assert.deepEqual(
      validated.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
    for (const root of [email, unionCall, investorCall]) {
      assert.equal(responseRubricError(root.delivery_config.response_rubric), null);
      assert.deepEqual(
        validateEscalation({
          escalation: root.delivery_config.escalation,
          rootApp: root.delivery_config.app,
          rootStakeholderId: root.delivery_config.stakeholder_id ?? null,
          stakeholderIds: cast.map((stakeholder) => stakeholder.id),
          durationMinutes: 90,
          rootKey: root.delivery_config.inject_key ?? null,
          rootTriggerMinute: root.trigger_time_minutes ?? null,
          otherInjects: sink.map((item) => ({
            key: item.delivery_config.inject_key ?? '',
            trigger_time_minutes: item.trigger_time_minutes ?? null,
            condition_keys: item.conditions_to_appear && 'all' in item.conditions_to_appear
              ? (item.conditions_to_appear.all ?? [])
              : [],
          })),
        }).filter((issue) => issue.level === 'error'),
        [],
      );
    }
  });

  test('compiling again reuses the press inject the ladder publishes', async () => {
    const client: ResponseBranchClient = {
      async complete(request) {
        if (!request.system.includes('mood ladder')) return { branches: [], rubrics: [], escalations: [] };
        return {
          ladders: [
            {
              stakeholder_id: 'stk_union',
              mood_ladder: {
                gave_up_after_minutes: 40,
                escalated_variant: 'angry',
                recovery: 'one_rung_per_good_reply',
                rungs: [
                  {
                    id: 'calm',
                    label: 'Calm',
                    when: {},
                    reply_style: 'Steady.',
                    script: { opening: 'Alex here.', lines: ['I can wait.'] },
                    consequences: [],
                  },
                  {
                    id: 'gave_up',
                    label: 'Gave up',
                    terminal: true,
                    when: { all: [{ wait_minutes_gte: 'gave_up_after' }] },
                    reply_style: 'Cold.',
                    script: { opening: 'I stopped waiting.', lines: ['The hall will hear this.'] },
                    consequences: [{ type: 'publish_inject', inject_key: 'union_goes_public' }],
                  },
                ],
              },
              goes_public: {
                inject_key: 'union_goes_public',
                title: 'Union takes the silence public',
                content: 'Alex Tan says the company stopped answering.',
              },
            },
          ],
        };
      },
    };
    const crisis = { crisisType: 'recall', duration: 90, country: 'Singapore' };
    const factSheet = { confirmed_facts: ['Batch 4471 failed a check'], unconfirmed_claims: [] };
    const firstCast: ChainStakeholder[] = [
      { id: 'stk_union', name: 'Alex Tan', relationship: 'union', organisation: 'Union Hall' },
    ];
    const convergenceGates: SocialInject[] = [];
    await attachResponseBranches({
      crisis,
      factSheet,
      stakeholders: firstCast,
      injects: [],
      branchSink: convergenceGates,
      client,
    });
    const article = convergenceGates.find((item) => item.delivery_config.inject_key === 'union_goes_public');
    assert.ok(article);

    const compileCast: ChainStakeholder[] = [
      { id: 'stk_union', name: 'Alex Tan', relationship: 'union', organisation: 'Union Hall' },
    ];
    const compileSink = [...convergenceGates];
    await attachResponseBranches({
      crisis,
      factSheet,
      stakeholders: compileCast,
      injects: [...convergenceGates],
      branchSink: compileSink,
      client,
    });

    const publish = publishKey(compileCast[0]?.mood_ladder);
    assert.equal(publish, 'union_goes_public');
    assert.equal(
      compileSink.filter((item) => item.delivery_config.inject_key === 'union_goes_public').length,
      1,
    );
    assert.equal(
      compileSink.some((item) => item.delivery_config.inject_key === 'goes_public_stk_union'),
      false,
    );
    const validated = validateConditionalInjects({
      duration_minutes: 90,
      injects: compileSink,
      stakeholders: compileCast.map((stakeholder) => ({
        id: stakeholder.id,
        mood_ladder: stakeholder.mood_ladder,
      })),
    });
    assert.deepEqual(
      validated.issues.filter((issue) => issue.severity === 'error'),
      [],
    );
  });

  test('mood ladders use one standard-tier call per six stakeholders', async () => {
    const options = moodLadderChatOptions('system', 'user');
    assert.equal(options.tier, 'standard');
    assert.equal(options.json, true);
    assert.equal(options.label, 'generator.moodLadders');
    const cast: ChainStakeholder[] = Array.from({ length: 7 }, (_, index) => ({
      id: `stk_n${index}`,
      name: `Person ${index}`,
      relationship: 'supplier',
    }));
    let calls = 0;
    const client: ResponseBranchClient = {
      async complete(request) {
        if (!request.system.includes('mood ladder')) return { branches: [], rubrics: [] };
        calls += 1;
        return { ladders: [] };
      },
    };
    await attachResponseBranches({
      crisis: { crisisType: 'recall', duration: 60 },
      factSheet: { confirmed_facts: [], unconfirmed_claims: [] },
      stakeholders: cast,
      injects: [],
      branchSink: [],
      client,
    });
    assert.equal(calls, 2);
    assert.equal(cast.every((stakeholder) => stakeholder.mood_ladder != null), true);
  });
});

function publishKey(ladder: unknown): string {
  const rungs = (ladder as { rungs?: Array<{ consequences?: Array<{ type?: string; inject_key?: string }> }> })
    ?.rungs;
  for (const rung of rungs ?? []) {
    const publish = rung.consequences?.find((item) => item.type === 'publish_inject');
    if (publish?.inject_key) return publish.inject_key;
  }
  return '';
}

function inject(
  app: 'email' | 'phone_call',
  key: string,
  stakeholderId: string,
  teams: string[],
  minute: number,
  content: string,
): SocialInject {
  return {
    trigger_time_minutes: minute,
    type: app === 'email' ? 'email_inbound' : 'phone_call',
    title: key,
    content,
    severity: 'high',
    inject_scope: 'team_specific',
    target_teams: teams,
    requires_response: true,
    delivery_config: {
      app,
      inject_key: key,
      stakeholder_id: stakeholderId,
      from_name: stakeholderId,
    },
  };
}

function noReply(
  parent: string,
  title: string,
  app: string,
  key: string,
  appear: string[],
): Record<string, unknown> {
  return {
    parent_inject_key: parent,
    branch: 'no_reply',
    title,
    content: `${title} still has no answer.`,
    delivery_config: { app, inject_key: key },
    conditions_to_appear: { all: appear },
    conditions_to_cancel: [],
  };
}

function branch(
  kind: string,
  title: string,
  app: string,
  key: string,
  appear: string[],
): {
  title: string;
  conditions_to_appear: { all: string[] };
  conditions_to_cancel: string[];
  delivery_config: { branch: string; parent_inject_key: string; app: string; inject_key: string };
} {
  return {
    title,
    conditions_to_appear: { all: appear },
    conditions_to_cancel: [],
    delivery_config: {
      branch: kind,
      parent_inject_key: 'supplier_4471',
      app,
      inject_key: key,
    },
  };
}
