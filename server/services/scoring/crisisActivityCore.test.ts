import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { env } from '../../env.js';
import { resetPeaceColumnsForTests } from '../../lib/peaceSchema.js';
import { resetTopicSchemaForTests } from '../topic/topicColumns.js';
import { dropUnavailableColumns } from './crisisActivityLookup.js';
import {
  MASTER_EMAIL_GRADE_SELECT,
  MASTER_POST_GRADE_SELECT,
  PEACE_EMAIL_GRADE_SELECT,
  PEACE_POST_GRADE_SELECT,
  actionCountsAsCrisisActivity,
  attributedPlayerId,
  buildBeforeCrisisSection,
  buildContentIndex,
  contentRefsFromPosts,
  crisisEventMinute,
  emailGradeSelect,
  playerTopicLabels,
  postGradePlan,
  rowCountsAsCrisisActivity,
  type ActionRef,
  type GradeAuthor,
} from './crisisActivityCore.js';

/**
 * Master rules this fixture is scored against (pre-WP10):
 * every row counts, post grades attribute only through posted_by_user_id,
 * and only author_type player is queried. Minutes clamp at 0.
 * The numbers below are those results, written out, not computed by this file's helpers.
 */

const START = '2026-06-01T12:00:00.000Z';
const OPENED = '2026-06-01T11:55:00.000Z';
const START_MS = Date.parse(START);

interface FixturePost extends GradeAuthor {
  id: string;
  created_at: string;
  overall: number;
  reply_to_post_id?: string | null;
  topic_class?: string | null;
  topic_kind?: string | null;
}

const PARENT = 'parent-normal';

const POSTS: FixturePost[] = [
  {
    id: 'p-personal',
    author_type: 'player',
    user_id: 'u1',
    posted_by_user_id: null,
    created_at: '2026-06-01T12:10:00.000Z',
    overall: 80,
  },
  {
    id: 'p-page',
    author_type: 'official_account',
    user_id: 'u1',
    posted_by_user_id: 'u1',
    created_at: '2026-06-01T12:12:00.000Z',
    overall: 40,
    topic_class: 'crisis',
  },
  {
    id: 'p-legacy',
    author_type: 'player',
    user_id: 'u2',
    posted_by_user_id: 'u2',
    created_at: '2026-06-01T12:20:00.000Z',
    overall: 90,
  },
  {
    id: 'p-peace',
    author_type: 'player',
    user_id: 'u1',
    posted_by_user_id: 'u1',
    created_at: '2026-06-01T11:56:00.000Z',
    overall: 10,
  },
  {
    id: 'p-off',
    author_type: 'player',
    user_id: 'u1',
    posted_by_user_id: 'u1',
    created_at: '2026-06-01T12:30:00.000Z',
    overall: 70,
    reply_to_post_id: PARENT,
    topic_class: 'off_topic',
  },
  {
    id: 'p-bridge',
    author_type: 'player',
    user_id: 'u1',
    posted_by_user_id: 'u1',
    created_at: '2026-06-01T12:40:00.000Z',
    overall: 100,
    reply_to_post_id: PARENT,
    topic_class: 'bridge',
  },
  {
    id: 'p-on-normal',
    author_type: 'player',
    user_id: 'u1',
    posted_by_user_id: 'u1',
    created_at: '2026-06-01T12:50:00.000Z',
    overall: 60,
    reply_to_post_id: PARENT,
    topic_class: 'on_topic',
  },
  {
    id: PARENT,
    author_type: 'npc_public',
    user_id: null,
    posted_by_user_id: null,
    created_at: '2026-06-01T11:50:00.000Z',
    overall: 0,
    topic_kind: 'normal',
  },
];

const ACTIONS: ActionRef[] = [
  {
    action_type: 'reply_posted',
    player_id: 'u1',
    target_id: PARENT,
    created_at: '2026-06-01T11:57:00.000Z',
  },
  {
    action_type: 'reply_posted',
    player_id: 'u1',
    target_id: PARENT,
    created_at: '2026-06-01T12:31:00.000Z',
  },
  {
    action_type: 'reply_posted',
    player_id: 'u1',
    target_id: PARENT,
    created_at: '2026-06-01T12:41:00.000Z',
  },
];

const MESSAGES = [
  '2026-06-01T11:58:00.000Z',
  '2026-06-01T12:10:00.000Z',
  '2026-06-01T12:20:00.000Z',
];

function indexFor(posts: FixturePost[]) {
  return buildContentIndex(
    contentRefsFromPosts(
      posts.map((post) => ({
        id: post.id,
        user_id: post.user_id,
        reply_to_post_id: post.reply_to_post_id,
        created_at: post.created_at,
        topic_class: post.topic_class,
        topic_kind: post.topic_kind,
      })),
    ),
  );
}

function countedPosts(flags: { peace: boolean; topic: boolean; attribution: boolean }) {
  const filtersActive = flags.peace || flags.topic;
  const plan = postGradePlan(flags);
  const index = indexFor(POSTS);
  const authors = plan.authorTypes as readonly string[];
  const queried = POSTS.filter(
    (post) => post.overall > 0 && authors.includes(post.author_type ?? ''),
  );
  const counted: Array<{ id: string; overall: number; bridge: boolean }> = [];
  for (const post of queried) {
    const ref = index.byKey.get(`post:${post.id}`);
    if (
      !rowCountsAsCrisisActivity({
        filtersActive,
        createdAt: post.created_at,
        startTime: START,
        label: ref?.label,
        postKind: ref?.postKind,
      })
    ) {
      continue;
    }
    const playerId = attributedPlayerId(post, flags.attribution);
    if (!playerId) continue;
    counted.push({
      id: post.id,
      overall: post.overall,
      bridge: filtersActive && ref?.label === 'bridge',
    });
  }
  const quality =
    counted.length === 0
      ? null
      : Math.round(counted.reduce((sum, row) => sum + row.overall, 0) / counted.length);
  return {
    ids: counted.map((row) => row.id),
    quality,
    bridges: counted.filter((row) => row.bridge).length,
  };
}

function firstDuty(filtersActive: boolean): string | null {
  const index = indexFor(POSTS);
  const hit = ACTIONS.find((action) =>
    actionCountsAsCrisisActivity(action, index, START, filtersActive),
  );
  return hit?.created_at ?? null;
}

function countedMessages(filtersActive: boolean): string[] {
  return MESSAGES.filter((at) =>
    rowCountsAsCrisisActivity({ filtersActive, createdAt: at, startTime: START }),
  );
}

const saved = {
  peace: env.enablePeacePeriod,
  topic: env.enableTopicAwareReplies,
  attribution: env.teamScorePostAttributionFix,
};

afterEach(() => {
  env.enablePeacePeriod = saved.peace;
  env.enableTopicAwareReplies = saved.topic;
  env.teamScorePostAttributionFix = saved.attribution;
  resetPeaceColumnsForTests();
  resetTopicSchemaForTests();
});

describe('flags off match master scoring', () => {
  test('grade queries stay on the master column lists', () => {
    const flags = { peace: false, topic: false, attribution: false };
    assert.deepEqual(postGradePlan(flags), {
      select: 'id, posted_by_user_id, sop_compliance_score',
      authorTypes: ['player'],
    });
    assert.equal(postGradePlan(flags).select, MASTER_POST_GRADE_SELECT);
    assert.equal(emailGradeSelect(flags), 'id, sent_by_player_id, sop_compliance_score');
    assert.equal(emailGradeSelect(flags), MASTER_EMAIL_GRADE_SELECT);
    assert.equal(
      postGradePlan({ peace: true, topic: false, attribution: false }).select,
      PEACE_POST_GRADE_SELECT,
    );
    assert.equal(emailGradeSelect({ peace: true, topic: false }), PEACE_EMAIL_GRADE_SELECT);
  });

  test('scores, duties, SOP and participant rows match the master results', () => {
    const scored = countedPosts({ peace: false, topic: false, attribution: false });
    assert.deepEqual(scored, {
      ids: ['p-legacy', 'p-peace', 'p-off', 'p-bridge', 'p-on-normal'],
      quality: 66,
      bridges: 0,
    });
    assert.equal(firstDuty(false), '2026-06-01T11:57:00.000Z');
    assert.deepEqual(countedMessages(false), MESSAGES);
    assert.equal(
      crisisEventMinute('2026-06-01T11:56:00.000Z', START_MS, { peace: false, round: 'floor' }),
      0,
    );
    assert.equal(
      crisisEventMinute('2026-06-01T12:10:00.000Z', START_MS, { peace: false, round: 'floor' }),
      10,
    );
    assert.equal(
      buildBeforeCrisisSection({ openedAt: OPENED, crisisStart: START, rows: [] }),
      null,
    );
  });

  test('crisis minutes with the flag off equal the previous clamp', () => {
    const samples = [
      '2026-06-01T11:56:00.000Z',
      '2026-06-01T12:00:00.000Z',
      '2026-06-01T12:10:30.000Z',
    ];
    for (const iso of samples) {
      const at = Date.parse(iso);
      const floor = Math.max(0, Math.floor((at - START_MS) / 60000));
      const round = Math.max(0, Math.round((at - START_MS) / 60000));
      assert.equal(crisisEventMinute(iso, START_MS, { peace: false, round: 'floor' }), floor);
      assert.equal(crisisEventMinute(iso, START_MS, { peace: false, round: 'round' }), round);
    }
  });
});

describe('crisis activity and attribution', () => {
  test('peace, off-topic and on-topic normal rows drop, and a bridge counts', () => {
    const scored = countedPosts({ peace: true, topic: true, attribution: false });
    assert.deepEqual(scored, {
      ids: ['p-legacy', 'p-bridge'],
      quality: 95,
      bridges: 1,
    });
    assert.equal(firstDuty(true), '2026-06-01T12:41:00.000Z');
    assert.deepEqual(countedMessages(true), [
      '2026-06-01T12:10:00.000Z',
      '2026-06-01T12:20:00.000Z',
    ]);
    assert.equal(
      crisisEventMinute('2026-06-01T11:56:00.000Z', START_MS, { peace: true, round: 'floor' }),
      null,
    );
    assert.equal(
      crisisEventMinute('2026-06-01T12:10:00.000Z', START_MS, { peace: true, round: 'round' }),
      10,
    );
  });

  test('topic replies without a peace period still drop off-topic rows', () => {
    const scored = countedPosts({ peace: false, topic: true, attribution: false });
    assert.deepEqual(scored.ids, ['p-legacy', 'p-bridge']);
    assert.equal(scored.bridges, 1);
  });

  test('player posts attribute by user_id and page posts by posted_by_user_id', () => {
    assert.equal(
      attributedPlayerId({ author_type: 'player', user_id: 'u1', posted_by_user_id: null }, false),
      null,
    );
    assert.equal(
      attributedPlayerId(
        { author_type: 'official_account', user_id: 'u1', posted_by_user_id: 'u1' },
        false,
      ),
      'u1',
    );
    const scored = countedPosts({ peace: true, topic: true, attribution: true });
    assert.deepEqual(scored, {
      ids: ['p-personal', 'p-page', 'p-legacy', 'p-bridge'],
      quality: 78,
      bridges: 1,
    });
    assert.deepEqual(postGradePlan({ peace: false, topic: false, attribution: true }).authorTypes, [
      'player',
      'official_account',
    ]);
  });
});

describe('AAR peace section and topic labels', () => {
  test('before the crisis lists peace rows from opened_at and marks them unscored', () => {
    const section = buildBeforeCrisisSection({
      openedAt: OPENED,
      crisisStart: START,
      rows: [
        {
          at: '2026-06-01T11:00:00.000Z',
          kind: 'post',
          author: 'Archive',
          content: 'Last month',
        },
        {
          at: '2026-06-01T11:56:00.000Z',
          kind: 'post',
          author: 'Northwind',
          content: 'Morning coffee',
          peaceRef: 'peace-1',
        },
        {
          at: '2026-06-01T11:57:00.000Z',
          kind: 'comment',
          author: 'Sam',
          content: 'Looks good',
          topic_class: 'off_topic',
        },
        {
          at: '2026-06-01T12:10:00.000Z',
          kind: 'post',
          author: 'Sam',
          content: 'We are recalling the batch',
          topic_class: 'crisis',
        },
      ],
    });
    assert.deepEqual(section, {
      unscored: true,
      opened_at: OPENED,
      crisis_start: START,
      minutes_before_crisis: 5,
      items: [
        {
          minute_from_open: 1,
          kind: 'post',
          author: 'Northwind',
          content: 'Morning coffee',
          unscored: true,
        },
        {
          minute_from_open: 2,
          kind: 'comment',
          author: 'Sam',
          content: 'Looks good',
          topic_class: 'off_topic',
          unscored: true,
        },
      ],
    });
  });

  test('topic labels are attached only when a comment, email or DM has one', () => {
    const labels = playerTopicLabels(
      [
        {
          kind: 'comment',
          at: '2026-06-01T12:30:00.000Z',
          who: 'Sam',
          content: 'Nice deal',
          topic_class: 'off_topic',
        },
        {
          kind: 'email',
          at: '2026-06-01T12:10:00.000Z',
          who: 'Sam',
          content: 'The recall',
          topic_class: 'bridge',
        },
        {
          kind: 'dm',
          at: '2026-06-01T11:58:00.000Z',
          who: 'Sam',
          content: 'Coffee?',
          topic_class: 'on_topic',
        },
        {
          kind: 'comment',
          at: '2026-06-01T12:20:00.000Z',
          who: 'Sam',
          content: 'Noted',
          topic_class: null,
        },
      ],
      START_MS,
      true,
    );
    assert.deepEqual(labels, [
      { kind: 'comment', minute: 30, who: 'Sam', topic_class: 'off_topic', content: 'Nice deal' },
      { kind: 'email', minute: 10, who: 'Sam', topic_class: 'bridge', content: 'The recall' },
    ]);
    assert.deepEqual(playerTopicLabels([], START_MS, false), []);
  });
});

describe('unapplied topic and peace columns', () => {
  test('a missing topic column narrows the select and warns once', () => {
    const next = dropUnavailableColumns('id, topic_class, topic_kind', {
      code: '42703',
      message: 'column topic_class does not exist',
    });
    assert.equal(next, 'id');
    assert.equal(
      dropUnavailableColumns('id, topic_class', {
        code: 'PGRST204',
        message: "Could not find the 'topic_class' column",
      }),
      'id',
    );
  });

  test('a missing peace_ref narrows the select through the peace marker', () => {
    const next = dropUnavailableColumns('id, peace_ref, topic_class', {
      code: '42703',
      message: 'column peace_ref does not exist',
    });
    assert.equal(next, 'id, topic_class');
  });
});
