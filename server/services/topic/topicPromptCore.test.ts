import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../lib/logger.js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { env } from '../../env.js';
import { buildPlayerBubbleSystemPrompt } from './bubblePrompt.js';
import { buildLegacyReactionMessages } from './legacyReactionPrompt.js';
import { matchesLeakTerms } from './leakTerms.js';
import {
  insertSocialPost,
  noteTopicSchemaMissing,
  resetTopicSchemaForTests,
  topicKindColumns,
  topicSchemaMissing,
} from './topicColumns.js';
import { triggerNPCReactions, type ReactionChatClient } from '../npcReactionService.js';
import {
  assignBridgeStances,
  buildTopicAwareReactionPrompt,
  checkTopicReplies,
  isCrisisActivity,
  PERSONAL_AUTHOR_BLOCK,
  type PostKind,
  type TopicLabel,
  type TopicPhase,
} from './topicPromptCore.js';

logger.level = 'silent';

const CRISIS = 'DYSON BATTERY RECALL CRISIS: units overheated and injured two people.';

function persona(
  handle: string,
  type: string,
  extras?: { personality?: string; bias?: string; tier?: string },
) {
  return {
    persona: {
      handle,
      type,
      personality: extras?.personality ?? 'ordinary poster',
      bias: extras?.bias ?? 'none',
      tier: extras?.tier,
    },
  };
}

test('matchesLeakTerms is case-insensitive and whole word or phrase', () => {
  const terms = ['recall', 'battery fire', 'V15'];
  assert.equal(matchesLeakTerms('Love the new menu', terms), false);
  assert.equal(matchesLeakTerms('Is this the Recall?', terms), true);
  assert.equal(matchesLeakTerms('recalling the ad', terms), false);
  assert.equal(matchesLeakTerms('a battery fire started', terms), true);
  assert.equal(matchesLeakTerms('battery fires are rare', terms), false);
  assert.equal(matchesLeakTerms('the V15 pack', terms), true);
  assert.equal(matchesLeakTerms('', terms), false);
  assert.equal(matchesLeakTerms('recall', []), false);
});

test('bridge stances are deterministic, keep one stay, and a page forces media and competitors', () => {
  const cast = [
    persona('@maya', 'npc_media', { bias: 'none' }),
    persona('@pat', 'npc_public', { bias: 'hostile', tier: 'key' }),
    persona('@bee', 'npc_public', { bias: 'none', tier: 'background' }),
  ];
  const first = assignBridgeStances(cast, 'post-9', { stayShare: 0.4, unit: () => 0 });
  const second = assignBridgeStances(cast, 'post-9', { stayShare: 0.4, unit: () => 0 });
  assert.deepEqual(first, second);
  assert.equal(first.some((row) => row.stance === 'stay'), true);

  const page = assignBridgeStances(
    [
      persona('@maya', 'npc_media'),
      persona('@rival', 'npc_public', { personality: 'competitor brand', bias: 'none' }),
      persona('@bee', 'npc_public', { bias: 'none', tier: 'background' }),
    ],
    'post-9',
    { authorIsPage: true, stayShare: 0.4, unit: () => 0.99 },
  );
  assert.equal(page.find((row) => row.handle === '@maya')?.stance, 'engage');
  assert.equal(page.find((row) => row.handle === '@rival')?.stance, 'engage');
  assert.equal(page.find((row) => row.handle === '@rival')?.forcedEngage, true);
  assert.equal(page.some((row) => row.stance === 'stay'), true);

  const allMedia = assignBridgeStances(
    [
      persona('@a', 'npc_media'),
      persona('@b', 'npc_media'),
      persona('@c', 'npc_public', { personality: 'rival shop', bias: 'competitive' }),
    ],
    'post-9',
    { authorIsPage: true, unit: () => 0.99 },
  );
  assert.equal(
    allMedia.every((row) => row.stance === 'engage'),
    true,
  );

  const hashed = assignBridgeStances(cast, 'seed-a');
  assert.deepEqual(hashed, assignBridgeStances(cast, 'seed-a'));
});

test('isCrisisActivity truth table', () => {
  const labels: TopicLabel[] = ['on_topic', 'bridge', 'off_topic', 'crisis', 'unclassified'];
  const kinds: PostKind[] = ['normal', 'crisis'];
  const phases: TopicPhase[] = ['not_started', 'peace', 'crisis'];
  for (const phase of phases) {
    for (const label of labels) {
      for (const postKind of kinds) {
        const expected =
          phase === 'crisis' &&
          (label === 'bridge' ||
            label === 'crisis' ||
            label === 'unclassified' ||
            (label === 'on_topic' && postKind === 'crisis'));
        assert.equal(
          isCrisisActivity({ phase, label, postKind }),
          expected,
          `${phase} ${label} ${postKind}`,
        );
      }
    }
  }
});

test('topic prompt leads with the post, fences the crisis, and swaps in the peace block', () => {
  const shared = {
    postFormat: 'text',
    playerHandle: '@player',
    playerContent: 'Love the Big Breakfast. Shame about that Dyson recall though.',
    authorIsPage: false,
    orgName: "McDonald's",
    topicKind: 'normal' as const,
    parent: {
      content: 'Weekend deal: two Big Breakfasts for the price of one.',
      authorHandle: '@mcdonalds',
      authorDisplayName: "McDonald's",
      authorType: 'official_account',
      topicKind: 'normal' as const,
    },
    threadReplies: [{ authorHandle: '@sam', content: 'Saturday plans sorted' }],
    addressedComment: null,
    personas: [
      {
        handle: '@media_jane',
        name: 'Jane Cho',
        personality: 'city reporter',
        bias: 'none',
        type: 'npc_media',
        reactionType: 'cover',
        stance: 'engage' as const,
      },
      {
        handle: '@fan_bob',
        name: 'Bob Tan',
        personality: 'breakfast regular',
        bias: 'supportive',
        type: 'npc_public',
        reactionType: 'support',
        stance: 'stay' as const,
      },
    ],
    crisisDescription: CRISIS,
    officialScrutinyBlock: 'CONFIRMED FACT: two people were burned.',
    isReply: true,
  };
  const crisis = buildTopicAwareReactionPrompt({ ...shared, phase: 'crisis' });
  assert.ok(crisis.system.indexOf('POST CONTEXT:') < crisis.system.indexOf('PERSONAS:'));
  assert.ok(crisis.system.indexOf('PERSONAS:') < crisis.system.indexOf('CRISIS CONTEXT:'));
  assert.ok(crisis.system.indexOf('CRISIS CONTEXT:') < crisis.system.indexOf('AUTHOR:'));
  assert.match(crisis.system, /Weekend deal: two Big Breakfasts/);
  assert.match(crisis.system, /If bridge: engage/);
  assert.match(crisis.system, /If bridge: stay/);
  assert.match(crisis.system, /use ONLY if you label the comment `bridge`/);
  assert.ok(crisis.system.includes(CRISIS));
  assert.ok(crisis.system.includes('CONFIRMED FACT: two people were burned.'));
  assert.ok(crisis.system.includes(PERSONAL_AUTHOR_BLOCK));
  assert.match(crisis.system, /"classification"/);

  const peace = buildTopicAwareReactionPrompt({ ...shared, phase: 'peace' });
  assert.equal(peace.system.includes('CRISIS CONTEXT:'), false);
  assert.equal(peace.system.includes(CRISIS), false);
  assert.equal(peace.system.includes('CONFIRMED FACT'), false);
  assert.match(
    peace.system,
    /Ordinary day\. Nothing unusual has happened to McDonald's/,
  );
  assert.match(peace.system, /Never invent details/);
  assert.ok(peace.system.indexOf('POST CONTEXT:') < peace.system.indexOf('PEACE:'));
  assert.ok(peace.system.indexOf('PEACE:') < peace.system.indexOf('AUTHOR:'));

  const page = buildTopicAwareReactionPrompt({
    ...shared,
    phase: 'crisis',
    authorIsPage: true,
    orgName: "McDonald's",
  });
  assert.match(page.system, /This is McDonald's speaking officially/);
});

test("a promo jab classifies as a bridge, keeps both stances, and drops a stay reply that leaks", () => {
  const checked = checkTopicReplies({
    classification: { label: 'bridge', bridge_topic: 'Dyson recall', confidence: 0.91 },
    reactions: [
      {
        author_handle: '@media_jane',
        content: "McDonald's joking about the Dyson recall is the story.",
        action: 'reply',
      },
      { author_handle: '@fan_bob', content: 'Wait, the Dyson recall??', action: 'reply' },
      { author_handle: '@fan_bob', content: 'Two Big Breakfasts, I am in.', action: 'reply' },
    ],
    stances: { '@media_jane': 'engage', '@fan_bob': 'stay' },
    leakTerms: ['recall', 'Dyson', 'battery fire'],
    postKind: 'normal',
    isReply: true,
    minConfidence: 0.6,
  });
  assert.equal(checked.label, 'bridge');
  assert.equal(checked.bridgeTopic, 'Dyson recall');
  assert.deepEqual(
    checked.reactions.map((row) => row.author_handle),
    ['@media_jane', '@fan_bob'],
  );
  assert.equal(String(checked.reactions[1]?.content).includes('Breakfast'), true);
  assert.equal(checked.dropped.length, 1);
  assert.equal(checked.dropped[0]?.handle, '@fan_bob');
});

test('a low-confidence bridge becomes off_topic and an invalid label is unclassified', () => {
  const low = checkTopicReplies({
    classification: { label: 'bridge', bridge_topic: 'recall', confidence: 0.59 },
    reactions: [
      { author_handle: '@media_jane', content: 'The recall is the real story.', action: 'reply' },
      { author_handle: '@fan_bob', content: 'Nice deal.', action: 'reply' },
    ],
    stances: { '@media_jane': 'engage', '@fan_bob': 'stay' },
    leakTerms: ['recall'],
    postKind: 'normal',
    isReply: true,
    minConfidence: 0.6,
  });
  assert.equal(low.label, 'off_topic');
  assert.deepEqual(
    low.reactions.map((row) => row.content),
    ['Nice deal.'],
  );

  const invalid = checkTopicReplies({
    classification: { label: 'crisis', confidence: 0.9 },
    reactions: [{ author_handle: '@a', content: 'the recall again', action: 'reply' }],
    stances: {},
    leakTerms: ['recall'],
    postKind: 'crisis',
    isReply: true,
    minConfidence: 0.6,
  });
  assert.equal(invalid.label, 'unclassified');
  assert.equal(invalid.confidence, null);
  assert.equal(invalid.reactions.length, 1);

  const normalUnclassified = checkTopicReplies({
    classification: null,
    reactions: [{ author_handle: '@a', content: 'the recall again', action: 'reply' }],
    stances: {},
    leakTerms: ['recall'],
    postKind: 'normal',
    isReply: true,
    minConfidence: 0.6,
  });
  assert.equal(normalUnclassified.label, 'unclassified');
  assert.equal(normalUnclassified.reactions.length, 0);
});

test('flags off: bubble prompt and topic_kind columns match today', () => {
  const prompt = buildPlayerBubbleSystemPrompt({
    crisisDescription: 'Batteries are overheating in the warehouse',
    elapsedMinutes: 12,
    sentimentScore: 55,
    npcList: '@ann (Ann): regular user, bias: none',
    normalTopics: 'gardening, football',
    topicAware: false,
  });
  const expected = `You generate social media posts for a specific player's personalized feed in a crisis simulation. These posts should feel like what this person would naturally see in their social media bubble.

THE CRISIS: Batteries are overheating in the warehouse
Elapsed: 12min. Sentiment: 55/100.

NPCs IN THIS PLAYER'S BUBBLE:
@ann (Ann): regular user, bias: none

CONTENT MIX — generate exactly 3 posts:
- 2 posts should be crisis-related: reactions, opinions, news sharing, demands, or commentary about the crisis. Each from a different NPC.
- 1 post should be NORMAL LIFE: an NPC posting about their regular interests (gardening, football) as if the crisis isn't the only thing happening. This makes the feed feel like real social media.

For crisis posts, set content_flags as appropriate:
- is_harmful_narrative, is_misinformation, is_inflammatory, incites_violence, is_organized_pressure
Leave content_flags as {} for neutral, supportive, or normal life posts.

Return ONLY valid JSON:
{ "posts": [{ "author_handle": "@user", "author_display_name": "Name", "author_type": "npc_public", "content": "text", "sentiment": "neutral|negative|supportive|hateful|inflammatory", "virality_score": 5, "content_flags": {}, "image_prompt": "" }] }`;
  assert.equal(prompt, expected);
  assert.equal(prompt.includes('is_normal_life'), false);

  const on = buildPlayerBubbleSystemPrompt({
    crisisDescription: 'Batteries are overheating in the warehouse',
    elapsedMinutes: 12,
    sentimentScore: 55,
    npcList: '@ann (Ann): regular user, bias: none',
    normalTopics: 'gardening, football',
    topicAware: true,
  });
  assert.equal(on.includes('is_normal_life'), true);
  assert.match(on, /Set is_normal_life to true on exactly the one NORMAL LIFE post/);
  assert.deepEqual(topicKindColumns(false, 'normal', false), {});
  assert.deepEqual(topicKindColumns(true, 'normal', false), { topic_kind: 'normal' });
  assert.deepEqual(topicKindColumns(true, 'normal', true), {});
});

test('legacy reaction prompt snapshot matches the pre-topic wording', () => {
  const messages = buildLegacyReactionMessages({
    postFormat: 'text',
    playerHandle: '@player',
    npcContext:
      '@sam (Sam Lee): sceptical neighbour, bias: hostile, type: npc_public. React with: attack',
    isOfficialComms: false,
    officialScrutinyBlock: '',
    crisisDescription: 'A battery recall after units overheated in the warehouse.',
    orgName: 'Dyson',
    threadContext: '',
    isReply: false,
    playerContent: 'Nice breakfast deal',
    userHandle: '@player',
  });
  assert.equal(messages.system.includes('classification'), false);
  assert.equal(messages.system.includes('POST CONTEXT'), false);
  assert.equal(messages.system.includes('If bridge:'), false);
  assert.match(messages.system, /^You are generating NPC reactions/);
  assert.match(
    messages.system,
    /Crisis context: A battery recall after units overheated in the warehouse\.\nOrganization: Dyson/,
  );
  assert.match(
    messages.system,
    /\{ "reactions": \[\{ "author_handle": "@exact_handle", "author_display_name": "Exact Name", "author_type": "npc_public\|npc_media\|npc_politician\|npc_influencer", "content": "reaction text", "sentiment": "negative\|supportive\|neutral\|hateful", "is_reply": true, "action": "reply\|repost_with_comment\|new_post\|like" \}\] \}$/,
  );
  assert.equal(messages.user, 'Player post by @player:\n"Nice breakfast deal"');
  const digest = createHash('sha256')
    .update(messages.system)
    .update('\n---\n')
    .update(messages.user)
    .digest('hex');
  assert.equal(digest, '2ca41eb7cfab4e71d09832d051dd74043697cd11939b1ef4f0a541445b20cfc5');
});

test('topic columns warn once and a missing column is stripped on insert', async () => {
  resetTopicSchemaForTests();
  assert.equal(noteTopicSchemaMissing(), true);
  assert.equal(noteTopicSchemaMissing(), false);
  assert.equal(topicSchemaMissing(), true);
  resetTopicSchemaForTests();

  const attempts: Array<Record<string, unknown>> = [];
  const result = await insertSocialPost({ content: 'hi', topic_kind: 'normal' }, async (payload) => {
    attempts.push(payload);
    if (attempts.length === 1) return { data: null, error: { code: '42703', message: 'column' } };
    return { data: { id: 'p1' }, error: null };
  });
  assert.equal(topicSchemaMissing(), true);
  assert.deepEqual(attempts[0], { content: 'hi', topic_kind: 'normal' });
  assert.deepEqual(attempts[1], { content: 'hi' });
  assert.deepEqual(result.data, { id: 'p1' });
  resetTopicSchemaForTests();
});

function installSupabase(postResult: { data: unknown; error: unknown }): {
  updates: unknown[];
  restore: () => void;
} {
  const updates: unknown[] = [];
  const original = supabaseAdmin.from;
  const chain = (result: { data: unknown; error: unknown }) => {
    const q = {
      select() {
        return q;
      },
      eq() {
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      update(row: unknown) {
        updates.push(row);
        return q;
      },
      insert() {
        return q;
      },
      single: async () => result,
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return q;
  };
  (supabaseAdmin as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    if (table === 'sessions') return chain({ data: { scenario_id: 'sc-1' }, error: null });
    if (table === 'scenarios') {
      return chain({
        data: {
          description: 'A battery recall after units overheated in the warehouse.',
          initial_state: {
            org_name: 'Dyson',
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
    if (table === 'social_posts') return chain(postResult);
    throw new Error(`unexpected table ${table}`);
  };
  return {
    updates,
    restore() {
      supabaseAdmin.from = original;
    },
  };
}

const playerPost = {
  id: 'post-1',
  country: 'SG',
  author_handle: '@player',
  author_type: 'player',
  content: 'Nice breakfast deal',
  post_format: 'text',
  platform: 'x_twitter',
  user_id: 'user-1',
};

test('flags off: one legacy prompt is sent and the service does not grade or label', async () => {
  assert.equal(env.enableTopicAwareReplies, false);
  const seen: Array<{ messages: Array<{ content: string }>; label: string; temperature: number; maxTokens: number; tier: string }> = [];
  const client: ReactionChatClient = {
    async chatJson(options) {
      seen.push({
        messages: options.messages,
        label: options.label,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        tier: options.tier,
      });
      return { reactions: [] };
    },
  };
  const grades: string[] = [];
  const db = installSupabase({ data: null, error: null });
  try {
    await triggerNPCReactions('sess-1', playerPost, {
      client,
      random: () => 0,
      grade: async () => {
        grades.push('graded');
      },
    });
  } finally {
    db.restore();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.label, 'npcReaction.generate');
  assert.equal(seen[0]?.tier, 'standard');
  assert.equal(seen[0]?.temperature, 0.95);
  assert.equal(seen[0]?.maxTokens, 1500);
  const expected = buildLegacyReactionMessages({
    postFormat: 'text',
    playerHandle: '@player',
    npcContext:
      '@sam (Sam Lee): sceptical neighbour, bias: hostile, type: npc_public. React with: attack',
    isOfficialComms: false,
    officialScrutinyBlock: '',
    crisisDescription: 'A battery recall after units overheated in the warehouse.',
    orgName: 'Dyson',
    threadContext: '',
    isReply: false,
    playerContent: 'Nice breakfast deal',
    userHandle: '@player',
  });
  assert.equal(seen[0]?.messages[0]?.content, expected.system);
  assert.equal(seen[0]?.messages[1]?.content, expected.user);
  assert.equal(grades.length, 0);
  assert.equal(db.updates.length, 0);
});

test('flag on: one call classifies, stores the label, and grades from it', async () => {
  resetTopicSchemaForTests();
  const seen: string[] = [];
  const client: ReactionChatClient = {
    async chatJson(options) {
      seen.push(options.messages[0]?.content || '');
      return {
        classification: { label: 'bridge', bridge_topic: 'breakfast jab', confidence: 0.8 },
        reactions: [],
      };
    },
  };
  const grades: Array<{ label: string; topicAware: boolean }> = [];
  const db = installSupabase({ data: null, error: null });
  try {
    await triggerNPCReactions('sess-1', playerPost, {
      topicAware: true,
      client,
      random: () => 0,
      grade: async (input) => {
        grades.push({ label: input.label, topicAware: input.topicAware });
      },
    });
  } finally {
    db.restore();
    resetTopicSchemaForTests();
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0] || '', /POST CONTEXT:/);
  assert.ok((seen[0] || '').indexOf('POST CONTEXT:') < (seen[0] || '').indexOf('CRISIS CONTEXT:'));
  assert.deepEqual(db.updates, [
    { topic_class: 'bridge', topic_confidence: 0.8, topic_bridge: 'breakfast jab' },
  ]);
  assert.deepEqual(grades, [{ label: 'bridge', topicAware: true }]);
});

test('flag on with migration 282 missing stores nothing and grades as unclassified', async () => {
  resetTopicSchemaForTests();
  const client: ReactionChatClient = {
    async chatJson() {
      return {
        classification: { label: 'off_topic', bridge_topic: '', confidence: 0.9 },
        reactions: [],
      };
    },
  };
  const grades: string[] = [];
  const db = installSupabase({ data: null, error: { code: '42703', message: 'column topic_class' } });
  try {
    await triggerNPCReactions('sess-1', playerPost, {
      topicAware: true,
      client,
      random: () => 0,
      grade: async (input) => {
        grades.push(input.label);
      },
    });
    assert.equal(grades[0], 'unclassified');
    assert.equal(topicSchemaMissing(), true);
    const before = db.updates.length;
    await triggerNPCReactions('sess-1', { ...playerPost, id: 'post-2' }, {
      topicAware: true,
      client,
      random: () => 0,
      grade: async (input) => {
        grades.push(input.label);
      },
    });
    assert.equal(db.updates.length, before);
    assert.deepEqual(grades, ['unclassified', 'unclassified']);
  } finally {
    db.restore();
    resetTopicSchemaForTests();
  }
});
