import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PEACE_OFFSET_TAIL_SECONDS } from '../../../shared/peaceFeed.js';
import type { PeaceFeedPost } from '../../../shared/peaceFeed.js';
import { peaceCommentRef, peaceOffsetLimit, peaceWindowSeconds, planPeacePublications } from './peaceLaneCore.js';

const OPENED = Date.parse('2026-06-01T12:00:00.000Z');
const SECONDS = 300;

function post(overrides: Partial<PeaceFeedPost> & Pick<PeaceFeedPost, 'ref' | 'offset_seconds'>): PeaceFeedPost {
  return {
    author: { kind: 'persona', handle: '@sam' },
    platform: 'facebook',
    post_format: 'text',
    content: overrides.ref,
    media_description: '',
    comments: [],
    ...overrides,
  };
}

function plan(
  posts: PeaceFeedPost[],
  now: number,
  already: string[] = [],
  resolved: (handle: string) => boolean = () => true,
) {
  return planPeacePublications({
    posts,
    seconds: SECONDS,
    openedAtMs: OPENED,
    now,
    already: new Set(already),
    postAuthor: (author) =>
      (author.kind === 'page' ? author.org_key === 'primary' : resolved(author.handle)) ? 'ok' : null,
    commentAuthor: (handle) => (resolved(handle) ? 'ok' : null),
  });
}

test('the window is the live peace, and a feed without seconds does not collapse to zero', () => {
  assert.equal(
    peaceWindowSeconds({
      openedAtMs: OPENED,
      startTime: new Date(OPENED + 600_000).toISOString(),
      feedSeconds: 40,
      fallbackSeconds: 300,
    }),
    600,
  );
  assert.equal(
    peaceWindowSeconds({
      openedAtMs: OPENED,
      startTime: null,
      feedSeconds: null,
      fallbackSeconds: 300,
    }),
    300,
  );
  assert.equal(
    peaceWindowSeconds({
      openedAtMs: OPENED,
      startTime: null,
      feedSeconds: 120,
      fallbackSeconds: 300,
    }),
    120,
  );
});

test('the tail limit is seconds minus the shared tail, and late offsets are skipped', () => {
  assert.equal(peaceOffsetLimit(SECONDS), SECONDS - PEACE_OFFSET_TAIL_SECONDS);
  const now = OPENED + 400_000;
  const result = plan([
    post({ ref: 'P1', offset_seconds: 20 }),
    post({ ref: 'P2', offset_seconds: SECONDS - PEACE_OFFSET_TAIL_SECONDS + 1 }),
  ], now);
  assert.deepEqual(result.publish.map((item) => item.peaceRef), ['P1']);
  assert.deepEqual(result.skippedPastTail, ['P2']);
});

test('only rows whose offset has arrived are published, and a second pass skips them', () => {
  const posts = [
    post({ ref: 'P1', offset_seconds: 20 }),
    post({ ref: 'P2', offset_seconds: 90 }),
  ];
  const first = plan(posts, OPENED + 40_000);
  assert.deepEqual(first.publish.map((item) => item.peaceRef), ['P1']);
  const second = plan(posts, OPENED + 40_000, ['P1']);
  assert.deepEqual(second.publish, []);
  const later = plan(posts, OPENED + 100_000, ['P1']);
  assert.deepEqual(later.publish.map((item) => item.peaceRef), ['P2']);
});

test('an unresolved author is skipped and a comment waits for its parent', () => {
  const posts = [
    post({
      ref: 'P1',
      offset_seconds: 10,
      author: { kind: 'page', org_key: 'primary', platform: 'facebook' },
      comments: [
        { author_handle: '@sam', content: 'nice', offset_seconds: 30 },
        { author_handle: '@gone', content: 'who', offset_seconds: 40 },
      ],
    }),
    post({
      ref: 'P2',
      offset_seconds: 15,
      author: { kind: 'page', org_key: 'missing', platform: 'facebook' },
    }),
  ];
  const result = plan(posts, OPENED + 50_000, [], (handle) => handle === '@sam');
  assert.deepEqual(
    result.publish.map((item) => item.peaceRef),
    ['P1', peaceCommentRef('P1', 0)],
  );
  assert.equal(result.publish[1]?.kind, 'comment');
  if (result.publish[1]?.kind === 'comment') assert.equal(result.publish[1].parentRef, 'P1');
  assert.deepEqual(result.skippedUnresolved.sort(), ['P1#1', 'P2']);
});

test('a comment whose parent was published on an earlier tick can publish alone', () => {
  const posts = [
    post({
      ref: 'P1',
      offset_seconds: 10,
      comments: [{ author_handle: '@sam', content: 'later', offset_seconds: 80 }],
    }),
  ];
  const result = plan(posts, OPENED + 90_000, ['P1']);
  assert.deepEqual(result.publish.map((item) => item.peaceRef), [peaceCommentRef('P1', 0)]);
});
