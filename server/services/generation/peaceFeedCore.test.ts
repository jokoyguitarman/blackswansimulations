import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PEACE_LEAK_TERM_RULE,
  PEACE_LEAK_TERM_SOURCE_HEADER,
  PEACE_POST_MIN,
  buildPeaceFeedPrompt,
  buildPeaceLeakTermsPrompt,
  checkPeaceFeed,
  dropOffendingPosts,
  matchesLeakTerms,
  mergeAddedPeacePosts,
  normalisePeaceFeed,
  peaceHandleRenames,
  replacePeaceLeakTerms,
  rewritePeacePeriod,
  type PeaceCast,
  type PeaceFeed,
  type PeaceFeedPost,
} from './peaceFeedCore.js';

const cast: PeaceCast = {
  personas: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    handle: `@${id}`,
    type: 'npc_public',
    normal_interests: [id === 'a' ? 'cooking' : id],
  })),
  pages: [
    page('primary', 'protagonist', true, 'facebook', '@acme'),
    page('primary', 'protagonist', true, 'x_twitter', '@acme_x'),
    page('rival', 'antagonist', false, 'facebook', '@rival'),
    page('watch', 'pressure', false, 'facebook', '@watch'),
  ],
};

function page(
  orgKey: string,
  role: 'protagonist' | 'antagonist' | 'pressure',
  playable: boolean,
  platform: string,
  handle: string,
): PeaceCast['pages'][number] {
  return { org_key: orgKey, role, playable, platform, handle, name: orgKey };
}

function post(
  ref: string,
  author: PeaceFeedPost['author'],
  content: string,
  offset: number,
  comments: PeaceFeedPost['comments'] = [],
): PeaceFeedPost {
  const platform = author.kind === 'page' ? author.platform : 'facebook';
  return {
    ref,
    author,
    platform,
    post_format: 'text',
    content,
    media_description: '',
    offset_seconds: offset,
    comments,
  };
}

function validFeed(): PeaceFeed {
  return {
    version: 1,
    seconds: 300,
    enabled: true,
    leak_terms: ['recall', 'battery fire'],
    posts: [
      post(
        'P1',
        { kind: 'page', org_key: 'primary', platform: 'facebook' },
        'Two breakfasts this Saturday.',
        20,
      ),
      post(
        'P2',
        { kind: 'page', org_key: 'primary', platform: 'facebook' },
        'Kitchen closes at nine tonight.',
        40,
      ),
      post(
        'P3',
        { kind: 'page', org_key: 'primary', platform: 'x_twitter' },
        'New opening hours posted.',
        60,
      ),
      post(
        'P4',
        { kind: 'page', org_key: 'primary', platform: 'x_twitter' },
        'Thank you for a busy week.',
        80,
      ),
      post(
        'P5',
        { kind: 'page', org_key: 'rival', platform: 'facebook' },
        'Our lunch deal runs all month.',
        100,
      ),
      post(
        'P6',
        { kind: 'page', org_key: 'watch', platform: 'facebook' },
        'Member meeting on Thursday.',
        120,
      ),
      post('P7', { kind: 'persona', handle: '@a' }, 'Saturday cooking plans sorted.', 140, [
        { author_handle: '@b', content: 'Save me a seat', offset_seconds: 150 },
      ]),
      post('P8', { kind: 'persona', handle: '@b' }, 'b was the theme of the match.', 160),
      post('P9', { kind: 'persona', handle: '@c' }, 'A quiet afternoon of c.', 180),
      post('P10', { kind: 'persona', handle: '@d' }, 'Brought d into the office.', 200),
      post('P11', { kind: 'persona', handle: '@e' }, 'e before dinner.', 220),
      post('P12', { kind: 'persona', handle: '@f' }, 'f and an early night.', 240),
    ],
  };
}

describe('matchesLeakTerms', () => {
  test('matches a word on a boundary, ignoring case, and not a longer word', () => {
    assert.equal(matchesLeakTerms('Please Recall the batch', ['recall']), true);
    assert.equal(matchesLeakTerms('precall', ['recall']), false);
    assert.equal(matchesLeakTerms('recalling the team', ['recall']), false);
    assert.equal(matchesLeakTerms('the V15 unit', ['V15']), true);
    assert.equal(matchesLeakTerms('model V150', ['V15']), false);
    assert.equal(matchesLeakTerms('XV15', ['V15']), false);
  });

  test('matches a multi-word phrase and ignores blank terms', () => {
    assert.equal(matchesLeakTerms('a battery   fire started', ['battery fire']), true);
    assert.equal(matchesLeakTerms('battery firesale', ['battery fire']), false);
    assert.equal(matchesLeakTerms('nothing unusual', ['', '   ']), false);
    assert.equal(matchesLeakTerms('', ['recall']), false);
  });
});

describe('checkPeaceFeed', () => {
  test('accepts a feed that meets every rule', () => {
    assert.deepEqual(checkPeaceFeed(validFeed(), cast), []);
  });

  test('rejects a count outside 10 to 24', () => {
    const feed = validFeed();
    feed.posts = feed.posts.slice(0, 3);
    assert.ok(checkPeaceFeed(feed, cast).some((issue) => issue.code === 'count'));
  });

  test('rejects a playable protagonist page with fewer than two posts', () => {
    const feed = validFeed();
    feed.posts[0].author = { kind: 'persona', handle: '@a' };
    feed.posts[0].content = 'More Saturday cooking.';
    feed.posts[1].author = { kind: 'persona', handle: '@a' };
    feed.posts[1].content = 'cooking again tomorrow';
    const issues = checkPeaceFeed(feed, cast);
    assert.ok(
      issues.some((issue) => issue.code === 'protagonist' && /facebook/.test(issue.message)),
    );
  });

  test('rejects a cast with rivals or pressure pages that never post', () => {
    const feed = validFeed();
    feed.posts[4].author = { kind: 'page', org_key: 'primary', platform: 'facebook' };
    assert.ok(checkPeaceFeed(feed, cast).some((issue) => issue.code === 'rival'));
    const pressure = validFeed();
    pressure.posts[5].author = { kind: 'page', org_key: 'primary', platform: 'facebook' };
    assert.ok(checkPeaceFeed(pressure, cast).some((issue) => issue.code === 'pressure'));
  });

  test('rejects fewer than six distinct personas when the cast has six', () => {
    const feed = validFeed();
    for (const item of feed.posts) {
      if (item.author.kind === 'persona') {
        item.author = { kind: 'persona', handle: '@a' };
        item.content = 'Saturday cooking.';
      }
      item.comments = [];
    }
    assert.ok(checkPeaceFeed(feed, cast).some((issue) => issue.code === 'personas'));
  });

  test('rejects an offset outside the window, too many comments, a missing interest, a leak and an unknown author', () => {
    const offset = validFeed();
    offset.posts[0].offset_seconds = 299;
    assert.ok(
      checkPeaceFeed(offset, cast).some((issue) => issue.code === 'offset' && issue.ref === 'P1'),
    );

    const comments = validFeed();
    comments.posts[0].comments = [1, 2, 3, 4].map((n) => ({
      author_handle: '@a',
      content: `note ${n}`,
      offset_seconds: 30 + n,
    }));
    assert.ok(
      checkPeaceFeed(comments, cast).some(
        (issue) => issue.code === 'comments' && issue.ref === 'P1',
      ),
    );

    const interests = validFeed();
    interests.posts[6].content = 'hello there';
    assert.ok(
      checkPeaceFeed(interests, cast).some(
        (issue) => issue.code === 'interests' && issue.ref === 'P7',
      ),
    );

    const leak = validFeed();
    leak.posts[0].content = 'Please recall the breakfast.';
    assert.ok(
      checkPeaceFeed(leak, cast).some((issue) => issue.code === 'leak' && issue.ref === 'P1'),
    );

    const author = validFeed();
    author.posts[6].author = { kind: 'persona', handle: '@nobody' };
    assert.ok(
      checkPeaceFeed(author, cast).some((issue) => issue.code === 'author' && issue.ref === 'P7'),
    );
  });

  test('rejects an empty leak list and a window that cannot hold an offset', () => {
    const feed = validFeed();
    feed.leak_terms = [];
    feed.seconds = 10;
    const codes = checkPeaceFeed(feed, cast).map((issue) => issue.code);
    assert.ok(codes.includes('leak_terms'));
    assert.ok(codes.includes('seconds'));
  });
});

describe('normalisePeaceFeed', () => {
  test('resolves handles, canonicalises platforms and sorts by offset', () => {
    const raw = {
      leak_terms: ['Recall', 'recall', 'battery fire'],
      posts: [
        {
          author: { kind: 'persona', handle: 'f' },
          content: 'f and an early night.',
          offset_seconds: 240,
          platform: 'Facebook',
        },
        {
          author: { kind: 'page', org_key: 'Primary', platform: 'twitter' },
          content: 'Thank you for a busy week.',
          offset_seconds: 80,
          comments: [
            { author_handle: 'b', content: 'Nice', offset_seconds: 90 },
            { author_handle: 'a', content: 'Agreed', offset_seconds: 85 },
          ],
        },
      ],
    };
    const feed = normalisePeaceFeed(raw, cast, { seconds: 300, enabled: false });
    assert.ok(feed);
    assert.equal(feed?.enabled, false);
    assert.deepEqual(feed?.leak_terms, ['Recall', 'battery fire']);
    assert.equal(feed?.posts[0].offset_seconds, 80);
    assert.equal(feed?.posts[0].author.kind, 'page');
    if (feed?.posts[0].author.kind === 'page') {
      assert.equal(feed.posts[0].author.org_key, 'primary');
      assert.equal(feed.posts[0].author.platform, 'x_twitter');
    }
    assert.deepEqual(
      feed?.posts[0].comments.map((comment) => comment.offset_seconds),
      [85, 90],
    );
    assert.equal(feed?.posts[1].author.kind === 'persona' && feed.posts[1].author.handle, '@f');
    assert.deepEqual(
      feed?.posts.map((item) => item.ref),
      ['P1', 'P2'],
    );
  });

  test('returns null when the reply is not a feed', () => {
    assert.equal(normalisePeaceFeed('nope', cast), null);
    assert.equal(normalisePeaceFeed({ leak_terms: [] }, cast), null);
  });
});

describe('dropOffendingPosts', () => {
  test('removes only the posts a per-post check named', () => {
    const feed = validFeed();
    feed.posts[0].content = 'Please recall the breakfast.';
    const dropped = dropOffendingPosts(feed, checkPeaceFeed(feed, cast));
    assert.equal(
      dropped.posts.some((item) => item.ref === 'P1'),
      false,
    );
    assert.equal(dropped.posts.length, feed.posts.length - 1);
    assert.equal(
      dropped.posts.some((item) => /recall/i.test(item.content)),
      false,
    );
  });
});

describe('peace feed re-edit', () => {
  const idle = {
    mapKey: (key: string) => key,
    dropOrgKeys: new Set<string>(),
    handleRenames: [],
  };

  test('a re-key and a primary swap rewrite page authors and leave every other post', () => {
    const persona = post('P3', { kind: 'persona', handle: '@sam' }, 'Saturday market.', 60, [
      { author_handle: '@sam', content: 'See you there', offset_seconds: 70 },
    ]);
    const primary = post('P1', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Breakfast.', 20);
    const bravo = post('P2', { kind: 'page', org_key: 'org_bravo_my', platform: 'facebook' }, 'Bravo hours.', 40);
    const feed = { ...validFeed(), posts: [primary, bravo, persona] };
    const fresh = 'org_acme_sg';
    const rewritten = rewritePeacePeriod(feed, {
      mapKey: (key) => (key === 'primary' ? fresh : key === 'org_bravo_my' ? 'primary' : key),
      dropOrgKeys: new Set(),
      handleRenames: [],
    }) as PeaceFeed;
    assert.notEqual(rewritten.posts[0], primary);
    assert.equal(rewritten.posts[0].content, primary.content);
    assert.equal((rewritten.posts[0].author as { org_key: string }).org_key, fresh);
    assert.equal(rewritten.posts[0].content, primary.content);
    assert.equal((rewritten.posts[1].author as { org_key: string }).org_key, 'primary');
    assert.equal(rewritten.posts[2], persona);
    assert.equal(rewritten.leak_terms, feed.leak_terms);
  });

  test('a removed organisation drops only its posts', () => {
    const kept = post('P1', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Breakfast.', 20);
    const dropped = post('P2', { kind: 'page', org_key: 'org_bravo_my', platform: 'x_twitter' }, 'Bravo hours.', 40);
    const persona = post('P3', { kind: 'persona', handle: '@sam' }, 'Saturday market.', 60);
    const feed = { ...validFeed(), posts: [kept, dropped, persona] };
    const rewritten = rewritePeacePeriod(feed, {
      ...idle,
      dropOrgKeys: new Set(['org_bravo_my']),
    }) as PeaceFeed;
    assert.deepEqual(rewritten.posts, [kept, persona]);
    assert.equal(rewritten.posts[0], kept);
    assert.equal(rewritten.posts[1], persona);
  });

  test('a persona handle rename rewrites post authors and comment authors', () => {
    const comment = { author_handle: '@Sam_K', content: 'Saturday plans', offset_seconds: 70 };
    const persona = post('P1', { kind: 'persona', handle: '@sam_k' }, 'Saturday market.', 20, [comment]);
    const other = post('P2', { kind: 'persona', handle: '@other' }, 'Evening walk.', 40, [
      { author_handle: '@other', content: 'Same', offset_seconds: 50 },
    ]);
    const page = post('P3', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Breakfast.', 60);
    const feed = { ...validFeed(), posts: [persona, other, page] };
    const rewritten = rewritePeacePeriod(feed, {
      ...idle,
      handleRenames: [{ from: '@sam_k', to: '@sam_new' }],
    }) as PeaceFeed;
    assert.equal(rewritten.posts[0].author.kind === 'persona' && rewritten.posts[0].author.handle, '@sam_new');
    assert.equal(rewritten.posts[0].comments[0]?.author_handle, '@sam_new');
    assert.equal(rewritten.posts[0].content, persona.content);
    assert.equal(rewritten.posts[1], other);
    assert.equal(rewritten.posts[2], page);
  });

  test('an untouched feed is the same value', () => {
    const feed = validFeed();
    assert.equal(rewritePeacePeriod(feed, idle), feed);
    assert.equal(rewritePeacePeriod(undefined, idle), undefined);
  });

  test('persona handle changes are read from the persona list', () => {
    const renames = peaceHandleRenames({
      orgPageBefore: { orgs: [] },
      orgPageAfter: { orgs: [] },
      personasBefore: [{ id: 'p1', name: 'Sam', handle: '@sam_k' }],
      personasAfter: [{ id: 'p1', name: 'Sam', handle: '@sam_new' }],
    });
    assert.deepEqual(renames, [{ from: '@sam_k', to: '@sam_new' }]);
  });

  test('added posts are appended and existing posts stay', () => {
    const existing = post('P1', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Breakfast.', 20);
    const feed = { ...validFeed(), posts: [existing], leak_terms: ['recall'] };
    const merged = mergeAddedPeacePosts(
      feed,
      {
        posts: [
          {
            author: { kind: 'page', org_key: 'org_new', platform: 'facebook' },
            content: 'Grand opening Friday.',
            offset_seconds: 30,
            comments: [{ author_handle: '@sam', content: 'I will be there', offset_seconds: 40 }],
          },
          {
            author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
            content: 'This would replace breakfast.',
            offset_seconds: 50,
          },
          {
            author: { kind: 'page', org_key: 'org_new', platform: 'facebook' },
            content: 'Please recall the opening.',
            offset_seconds: 60,
          },
        ],
      },
      new Set(['org_new']),
    );
    assert.equal(merged.posts[0], existing);
    assert.equal(merged.posts.length, 2);
    assert.equal(merged.posts[1]?.author.kind === 'page' && merged.posts[1].author.org_key, 'org_new');
    assert.equal(merged.posts[1]?.content, 'Grand opening Friday.');
    assert.equal(merged.leak_terms, feed.leak_terms);
  });

  test('the leak-term prompt is the leak-term part of the feed prompt', () => {
    const full = buildPeaceFeedPrompt({
      cast,
      crisisBrief: 'A battery fire forces a V15 recall.',
      seconds: 300,
    });
    const leak = buildPeaceLeakTermsPrompt('A battery fire forces a V15 recall.');
    assert.equal(full.system.includes(PEACE_LEAK_TERM_RULE), true);
    assert.equal(leak.system.includes(PEACE_LEAK_TERM_RULE), true);
    assert.equal(leak.user.startsWith(PEACE_LEAK_TERM_SOURCE_HEADER), true);
    assert.equal(full.user.includes(PEACE_LEAK_TERM_SOURCE_HEADER), true);
    assert.equal(leak.user.includes('V15 recall'), true);
    assert.equal(leak.system.includes(`Write ${PEACE_POST_MIN}`), false);
    assert.equal(leak.system.includes('"posts"'), false);
    const feed = validFeed();
    const replaced = replacePeaceLeakTerms(feed, ['ammonia', 'vent']);
    assert.deepEqual(replaced.leak_terms, ['ammonia', 'vent']);
    assert.equal(replaced.posts, feed.posts);
  });
});
