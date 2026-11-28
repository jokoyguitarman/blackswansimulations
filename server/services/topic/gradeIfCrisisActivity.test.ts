import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../lib/logger.js';
import {
  gradeIfCrisisActivity,
  routeGradesPlayerPost,
  type GradeActivityInput,
  type GradeRuntime,
} from './gradeIfCrisisActivity.js';
import type { ContentGrade } from '../contentGraderService.js';

logger.level = 'silent';

function grade(overall: number): ContentGrade {
  return {
    format: 'text',
    accuracy: overall,
    tone: overall,
    cultural_sensitivity: overall,
    persuasiveness: overall,
    completeness: overall,
    clarity: overall,
    overall,
    feedback: 'ok',
    strengths: [],
    improvements: [],
    dimensions: {},
    signals: {},
  };
}

function input(overrides: Partial<GradeActivityInput> = {}): GradeActivityInput {
  return {
    sessionId: 'sess-1',
    postId: 'post-1',
    userId: 'user-1',
    content: 'We are sorry and here is the confirmed update.',
    postFormat: 'text',
    imagePrompt: undefined,
    replyToPostId: 'parent-1',
    postAsPage: false,
    topicAware: false,
    label: 'off_topic',
    phase: 'crisis',
    postKind: 'normal',
    columnsAvailable: true,
    ...overrides,
  };
}

function runtime(overall: number): {
  calls: string[];
  consequences: unknown[][];
  contexts: unknown[];
  hang: Promise<void>;
  impl: GradeRuntime;
} {
  const calls: string[] = [];
  const consequences: unknown[][] = [];
  const contexts: unknown[] = [];
  let release = () => {};
  const hang = new Promise<void>((resolve) => {
    release = resolve;
  });
  void release;
  const impl: GradeRuntime = {
    async loadSession() {
      calls.push('session');
      return {
        scenario_id: 'sc-1',
        start_time: new Date(Date.now() - (5 * 60_000 + 30_000)).toISOString(),
      };
    },
    async loadScenario() {
      calls.push('scenario');
      return {
        description: 'Battery recall',
        initial_state: {
          fact_sheet: { confirmed_facts: ['Two people were hurt'] },
          research_guidelines: {
            per_team: [
              {
                guidelines: [
                  { best_practice: 'Acknowledge fast', source_basis: 'case' },
                  { best_practice: 'extra', source_basis: 'case' },
                ],
              },
            ],
          },
        },
      };
    },
    async loadParentContent() {
      calls.push('parent');
      return 'The rumour post';
    },
    async getPlayerTeamContext() {
      calls.push('team');
      return {
        team_name: 'Comms',
        charter: {
          mission: 'Speak for the brand',
          scoring_rubric: 'Accuracy first',
          out_of_lane: ['Do not brief legal'],
        },
      };
    },
    async gradePlayerContent(_content, context) {
      calls.push('grade');
      contexts.push(context);
      return grade(overall);
    },
    async updateScore() {
      calls.push('update');
    },
    async startSnapshot() {
      calls.push('snapshot');
      void hang;
    },
    async startConsequence(...args) {
      calls.push('consequence');
      consequences.push(args);
      void hang;
    },
  };
  return { calls, consequences, contexts, hang, impl };
}

test('flags off grades every label, with the same consequence calls, without waiting on them', async () => {
  const good = runtime(75);
  const pending = gradeIfCrisisActivity(input({ label: 'off_topic', topicAware: false }), good.impl);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  assert.equal(settled, false);
  await pending;
  assert.deepEqual(good.calls, [
    'session',
    'scenario',
    'parent',
    'team',
    'grade',
    'update',
    'snapshot',
    'consequence',
  ]);
  const context = good.contexts[0] as {
    crisis_description: string;
    confirmed_facts: string[];
    hateful_post_being_addressed: string;
    research_guidelines: unknown[];
    post_format: string;
    is_official_page_post: boolean;
    elapsed_minutes: number;
    team_charter: { team_name: string };
  };
  assert.equal(context.crisis_description, 'Battery recall');
  assert.deepEqual(context.confirmed_facts, ['Two people were hurt']);
  assert.equal(context.hateful_post_being_addressed, 'The rumour post');
  assert.equal(context.research_guidelines.length, 2);
  assert.equal(context.post_format, 'text');
  assert.equal(context.is_official_page_post, false);
  assert.equal(context.elapsed_minutes, 5);
  assert.equal(context.team_charter.team_name, 'Comms');
  assert.deepEqual(good.consequences[0], [
    'sess-1',
    'player_good_response',
    'A player posted a high-quality text response (scored 75/100). Generate a supportive reaction amplifying the good response.',
    'supportive',
    true,
  ]);

  const poor = runtime(39);
  await gradeIfCrisisActivity(input({ label: 'on_topic', postKind: 'normal' }), poor.impl);
  assert.equal(poor.consequences.length, 1);
  assert.equal(poor.consequences[0]?.[1], 'player_poor_response');
  assert.match(String(poor.consequences[0]?.[2]), /poor text response \(scored 39\/100\)/);
  assert.equal(poor.consequences[0]?.[3], 'negative');
  assert.equal(poor.consequences[0]?.[4], false);

  const mid = runtime(40);
  await gradeIfCrisisActivity(input({ label: 'unclassified' }), mid.impl);
  assert.equal(mid.calls.includes('grade'), true);
  assert.equal(mid.consequences.length, 0);

  const top = runtime(70);
  await gradeIfCrisisActivity(
    input({ replyToPostId: undefined, postFormat: undefined, postAsPage: true }),
    top.impl,
  );
  assert.equal(top.calls.includes('parent'), false);
  assert.equal(top.consequences[0]?.[1], 'player_good_response');
  assert.match(String(top.consequences[0]?.[2]), /high-quality text response/);
});

test('grading failure is swallowed with the same log line', async () => {
  const warnings: unknown[] = [];
  const original = logger.warn.bind(logger);
  logger.warn = ((...args: unknown[]) => {
    warnings.push(args);
    return undefined;
  }) as typeof logger.warn;
  const broken = runtime(10);
  broken.impl.loadSession = async () => {
    throw new Error('db down');
  };
  try {
    await gradeIfCrisisActivity(input(), broken.impl);
  } finally {
    logger.warn = original as typeof logger.warn;
  }
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as unknown[])[1], 'Auto-grade failed (non-critical)');
});

test('topic-aware grading follows crisis activity, and a missing migration grades as unclassified', async () => {
  const off = runtime(80);
  await gradeIfCrisisActivity(
    input({ topicAware: true, label: 'off_topic', postKind: 'crisis' }),
    off.impl,
  );
  assert.deepEqual(off.calls, []);

  const normal = runtime(80);
  await gradeIfCrisisActivity(
    input({ topicAware: true, label: 'on_topic', postKind: 'normal' }),
    normal.impl,
  );
  assert.deepEqual(normal.calls, []);

  const bridge = runtime(80);
  await gradeIfCrisisActivity(
    input({ topicAware: true, label: 'bridge', postKind: 'normal' }),
    bridge.impl,
  );
  assert.equal(bridge.calls.includes('grade'), true);

  const peace = runtime(80);
  await gradeIfCrisisActivity(
    input({ topicAware: true, label: 'bridge', phase: 'peace' }),
    peace.impl,
  );
  assert.deepEqual(peace.calls, []);

  const missing = runtime(80);
  await gradeIfCrisisActivity(
    input({ topicAware: true, label: 'off_topic', columnsAvailable: false }),
    missing.impl,
  );
  assert.equal(missing.calls.includes('grade'), true);
});

test('the route grades unless topic replies and AI are both on, and the call stays fire-and-forget', () => {
  assert.equal(routeGradesPlayerPost(false, true), true);
  assert.equal(routeGradesPlayerPost(false, false), true);
  assert.equal(routeGradesPlayerPost(true, false), true);
  assert.equal(routeGradesPlayerPost(true, true), false);

  const src = readFileSync(new URL('../../routes/socialMedia.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post(\n  '/posts'");
  const end = src.indexOf("router.post('/posts/:postId/like'");
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  const replyTrigger = body.indexOf('NPC reply reaction failed');
  const gradeAt = body.indexOf('void gradeIfCrisisActivity');
  const broadcastAt = body.indexOf("type: 'social_post.created'");
  const topTrigger = body.indexOf('NPC reaction trigger failed');
  const statusAt = body.indexOf('res.status(201)');
  assert.ok(replyTrigger > 0);
  assert.ok(replyTrigger < gradeAt);
  assert.ok(gradeAt < broadcastAt);
  assert.ok(broadcastAt < topTrigger);
  assert.ok(topTrigger < statusAt);
  assert.equal(body.includes('await gradeIfCrisisActivity'), false);
  assert.equal(body.includes('routeGradesPlayerPost'), true);
});
