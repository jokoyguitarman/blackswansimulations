import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PEACE_ORDINARY_LIFE_RULE } from './peaceFeedCore.js';
import { leakingPeaceFeed, peaceCast, validPeaceFeed } from './peaceFeedFixture.js';
import {
  PEACE_FEED_EMPTY_WARNING,
  generatePeaceFeed,
  type PeaceFeedClient,
} from './peaceFeedService.js';

function scripted(replies: unknown[]): PeaceFeedClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async complete(request) {
      prompts.push(`${request.system}\n${request.user}`);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe('generatePeaceFeed', () => {

  test('retries once with the check errors and stores the clean draft', async () => {
    const leaked = validPeaceFeed();
    leaked.posts[0].content = 'Please recall the breakfast.';
    const client = scripted([leaked, validPeaceFeed()]);
    const result = await generatePeaceFeed(
      { cast: peaceCast, crisisBrief: 'A battery fire forces a V15 recall.', seconds: 300 },
      { client },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 2);
    assert.equal(result.dropped, 0);
    assert.equal(result.feed.posts.some((post) => /recall/i.test(post.content)), false);
    assert.match(client.prompts[0], new RegExp(PEACE_ORDINARY_LIFE_RULE));
    assert.match(client.prompts[0], /LEAK TERM SOURCE/);
    const briefAt = client.prompts[0].indexOf('LEAK TERM SOURCE');
    const crisisAt = client.prompts[0].indexOf('V15 recall');
    assert.ok(crisisAt > briefAt);
    assert.match(client.prompts[1], /leak term/);
  });

  test('drops offending posts and keeps the feed when 10 or more remain', async () => {
    const client = scripted([leakingPeaceFeed(), leakingPeaceFeed()]);
    const result = await generatePeaceFeed(
      { cast: peaceCast, crisisBrief: 'A battery fire forces a V15 recall.' },
      { client },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dropped, 2);
    assert.ok(result.feed.posts.length >= 10);
    assert.equal(result.feed.posts.some((post) => /recall|battery fire/i.test(post.content)), false);
  });

  test('stores nothing when fewer than 10 posts survive', async () => {
    const thin = validPeaceFeed();
    thin.posts = thin.posts.slice(0, 4).map((post) => ({ ...post, content: 'Please recall this.' }));
    const client = scripted([thin, thin]);
    const result = await generatePeaceFeed(
      { cast: peaceCast, crisisBrief: 'A battery fire forces a V15 recall.' },
      { client },
    );
    assert.deepEqual(result, { ok: false, reason: 'empty', warning: PEACE_FEED_EMPTY_WARNING });
  });
});
