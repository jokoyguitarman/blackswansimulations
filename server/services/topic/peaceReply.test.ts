import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { env } from '../../env.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { gradePlayerPostFromReactions } from './playerTopicGrade.js';
import { shouldSkipGrade } from './gradeIfCrisisActivity.js';
import { triggerNPCReactions, type ReactionChatClient } from '../npcReactionService.js';
import { mediaScenarioContext } from '../peace/mediaContext.js';
import type { GradeRuntime } from './gradeIfCrisisActivity.js';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalPeace = env.enablePeacePeriod;
const originalTopic = env.enableTopicAwareReplies;
const originalRandom = Math.random;

const CRISIS = 'A battery recall after units overheated in the warehouse.';

function install(startTime: string) {
  const updates: Array<Record<string, unknown>> = [];
  const selects: string[] = [];
  const chain = (result: { data: unknown; error: unknown }) => {
    const query = {
      select(columns: string) {
        selects.push(columns);
        return query;
      },
      eq() {
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      update(row: Record<string, unknown>) {
        updates.push(row);
        return query;
      },
      insert() {
        return query;
      },
      single: async () => result,
      maybeSingle: async () => result,
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  };
  (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
    if (table === 'sessions') {
      return chain({ data: { scenario_id: 'sc-1', start_time: startTime }, error: null });
    }
    if (table === 'scenarios') {
      return chain({
        data: {
          description: CRISIS,
          initial_state: {
            org_name: 'Dyson',
            peace_period: { leak_terms: ['recall'] },
            npc_personas: [
              {
                handle: '@sam',
                name: 'Sam Lee',
                type: 'npc_public',
                personality: 'sceptical neighbour',
                bias: 'hostile',
                follower_count: 12,
                specific_claims: [],
              },
            ],
          },
        },
        error: null,
      });
    }
    if (table === 'social_posts') {
      const parent = {
        data: {
          content: 'Weekend deal',
          author_handle: '@brand',
          author_display_name: 'Brand',
          author_type: 'official_account',
          topic_kind: 'normal',
        },
        error: null,
      };
      const query = chain(parent);
      const single = query.single;
      query.single = single;
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject);
      return query;
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { updates, selects };
}

function runtime(): GradeRuntime & { graded: number } {
  const graded = { graded: 0 };
  const impl: GradeRuntime & { graded: number } = {
    get graded() {
      return graded.graded;
    },
    set graded(value: number) {
      graded.graded = value;
    },
    async loadSession() {
      return { scenario_id: 'sc-1', start_time: new Date().toISOString() };
    },
    async loadScenario() {
      return { description: CRISIS, initial_state: {} };
    },
    async loadParentContent() {
      return 'parent';
    },
    async getPlayerTeamContext() {
      return null;
    },
    async gradePlayerContent() {
      graded.graded += 1;
      return {
        format: 'text',
        accuracy: 10,
        tone: 10,
        cultural_sensitivity: 10,
        persuasiveness: 10,
        completeness: 10,
        clarity: 10,
        overall: 10,
        feedback: 'no',
        strengths: [],
        improvements: [],
        dimensions: {},
        signals: {},
      };
    },
    async updateScore() {},
    async startSnapshot() {},
    async startConsequence() {},
  };
  return impl;
}

const playerPost = {
  id: 'post-1',
  country: 'SG',
  author_handle: '@player',
  author_type: 'player',
  content: 'Is this the recall?',
  post_format: 'text',
  platform: 'facebook',
  user_id: 'user-1',
  reply_to_post_id: 'parent-1',
};

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  env.enablePeacePeriod = originalPeace;
  env.enableTopicAwareReplies = originalTopic;
  Math.random = originalRandom;
});

test('peace media gets no crisis description; any other phase keeps the slice', () => {
  const description = 'A battery recall after units overheated in the warehouse.';
  assert.equal(mediaScenarioContext('peace', description), undefined);
  assert.equal(mediaScenarioContext('crisis', description), description.substring(0, 200));
  assert.equal(mediaScenarioContext(undefined, description), description.substring(0, 200));
  assert.equal(mediaScenarioContext('crisis', ''), undefined);
});

test('flags off keeps the crisis prompt even when start_time is in the future', async () => {
  env.enablePeacePeriod = false;
  env.enableTopicAwareReplies = false;
  Math.random = () => 0;
  const seen: string[] = [];
  const client: ReactionChatClient = {
    async chatJson(options) {
      seen.push(options.messages.map((message) => String(message.content)).join('\n'));
      return { reactions: [] };
    },
  };
  const db = install(new Date(Date.now() + 5 * 60_000).toISOString());
  const topic = await triggerNPCReactions('sess-1', playerPost, { client });
  assert.equal(topic, null);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /Crisis context:/);
  assert.match(seen[0] ?? '', /battery recall/);
  assert.equal(db.updates.length, 0);
  assert.equal(db.selects.some((columns) => columns.includes('start_time')), false);
});

test('a peace reply has no crisis text, drops a leaked reply, and stores the bridge unscored', async () => {
  env.enablePeacePeriod = true;
  env.enableTopicAwareReplies = true;
  Math.random = () => 0;
  const seen: string[] = [];
  const client: ReactionChatClient = {
    async chatJson(options) {
      seen.push(options.messages.map((message) => String(message.content)).join('\n'));
      return {
        classification: { label: 'on_topic', bridge_topic: '', confidence: 0.95 },
        reactions: [{ author_handle: '@sam', content: 'The recall is already public', action: 'reply' }],
      };
    },
  };
  const db = install(new Date(Date.now() + 5 * 60_000).toISOString());
  const grades = runtime();
  await gradePlayerPostFromReactions(
    {
      sessionId: 'sess-1',
      post: playerPost,
      userId: 'user-1',
      content: playerPost.content,
      postFormat: 'text',
      imagePrompt: undefined,
      replyToPostId: 'parent-1',
      postAsPage: false,
    },
    { client, phase: 'peace' },
    grades,
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /Ordinary day/);
  assert.doesNotMatch(seen[0] ?? '', /Crisis context/);
  assert.doesNotMatch(seen[0] ?? '', /battery recall/);
  assert.equal(
    db.updates.some((row) => row.topic_class === 'bridge'),
    true,
  );
  assert.equal(grades.graded, 0);
  assert.equal(
    shouldSkipGrade({
      sessionId: 'sess-1',
      postId: 'post-1',
      userId: 'user-1',
      content: playerPost.content,
      postFormat: 'text',
      imagePrompt: undefined,
      replyToPostId: 'parent-1',
      postAsPage: false,
      topicAware: false,
      label: 'bridge',
      phase: 'peace',
      postKind: 'normal',
      columnsAvailable: true,
    }),
    true,
  );
});
