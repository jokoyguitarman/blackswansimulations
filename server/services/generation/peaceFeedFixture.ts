import type { PeaceCast, PeaceFeed, PeaceFeedPost } from './peaceFeedCore.js';

export const peaceCast: PeaceCast = {
  personas: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    handle: `@${id}`,
    type: 'npc_public',
    normal_interests: [id === 'a' ? 'cooking' : id],
  })),
  pages: [
    { org_key: 'primary', role: 'protagonist', playable: true, platform: 'facebook', handle: '@acme', name: 'Acme' },
    { org_key: 'primary', role: 'protagonist', playable: true, platform: 'x_twitter', handle: '@acme_x', name: 'Acme' },
    { org_key: 'rival', role: 'antagonist', playable: false, platform: 'facebook', handle: '@rival', name: 'Rival' },
    { org_key: 'watch', role: 'pressure', playable: false, platform: 'facebook', handle: '@watch', name: 'Watch' },
  ],
};

function post(
  ref: string,
  author: PeaceFeedPost['author'],
  content: string,
  offset: number,
): PeaceFeedPost {
  return {
    ref,
    author,
    platform: author.kind === 'page' ? author.platform : 'facebook',
    post_format: 'text',
    content,
    media_description: '',
    offset_seconds: offset,
    comments: [],
  };
}

/** A feed checkPeaceFeed accepts for {@link peaceCast}. */
export function validPeaceFeed(): PeaceFeed {
  return {
    version: 1,
    seconds: 300,
    enabled: true,
    leak_terms: ['recall', 'battery fire'],
    posts: [
      post('P1', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Two breakfasts this Saturday.', 20),
      post('P2', { kind: 'page', org_key: 'primary', platform: 'facebook' }, 'Kitchen closes at nine tonight.', 40),
      post('P3', { kind: 'page', org_key: 'primary', platform: 'x_twitter' }, 'New opening hours posted.', 60),
      post('P4', { kind: 'page', org_key: 'primary', platform: 'x_twitter' }, 'Thank you for a busy week.', 80),
      post('P5', { kind: 'page', org_key: 'rival', platform: 'facebook' }, 'Our lunch deal runs all month.', 100),
      post('P6', { kind: 'page', org_key: 'watch', platform: 'facebook' }, 'Member meeting on Thursday.', 120),
      post('P7', { kind: 'persona', handle: '@a' }, 'Saturday cooking plans sorted.', 140),
      post('P8', { kind: 'persona', handle: '@b' }, 'b was the theme of the match.', 160),
      post('P9', { kind: 'persona', handle: '@c' }, 'A quiet afternoon of c.', 180),
      post('P10', { kind: 'persona', handle: '@d' }, 'Brought d into the office.', 200),
      post('P11', { kind: 'persona', handle: '@e' }, 'e before dinner.', 220),
      post('P12', { kind: 'persona', handle: '@f' }, 'f and an early night.', 240),
    ],
  };
}

export function leakingPeaceFeed(): PeaceFeed {
  const feed = validPeaceFeed();
  feed.posts.push(
    post('P13', { kind: 'persona', handle: '@a' }, 'Please recall the breakfast.', 250),
    post('P14', { kind: 'persona', handle: '@a' }, 'Talk of a battery fire.', 260),
  );
  return feed;
}
