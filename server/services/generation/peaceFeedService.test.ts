import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { env } from '../../env.js';
import { PEACE_ORDINARY_LIFE_RULE } from './peaceFeedCore.js';
import { leakingPeaceFeed, peaceCast, validPeaceFeed } from './peaceFeedFixture.js';
import {
  PEACE_FEED_EMPTY_WARNING,
  generatePeaceFeed,
  runPeaceStage,
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

const orgPage = {
  orgs: [
    {
      org_key: 'primary',
      display_name: 'Acme',
      is_primary: true,
      role: 'protagonist',
      control_mode: 'player',
      facebook: { page_name: 'Acme', page_handle: '@acme', page_bio: 'Breakfast', follower_count: 10 },
      x_twitter: { page_name: 'Acme', page_handle: '@acme_x', page_bio: 'Breakfast', follower_count: 10 },
    },
  ],
};

describe('generatePeaceFeed', { concurrency: false }, () => {
  const previous = env.enablePeaceFeedBuildStage;
  afterEach(() => {
    env.enablePeaceFeedBuildStage = previous;
  });

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

  test('a thrown client does not escape the stage runner', async () => {
    env.enablePeaceFeedBuildStage = true;
    const client = scripted([new Error('provider down')]);
    const lines: string[] = [];
    const output = await runPeaceStage(
      {
        personas: peaceCast.personas,
        orgPage,
        crisisBrief: 'A battery fire forces a V15 recall.',
      },
      { log: (_kind, message) => lines.push(message) },
      client,
    );
    assert.equal(output.peace_period, null);
    assert.equal(output.warning, PEACE_FEED_EMPTY_WARNING);
    assert.ok(lines.includes(PEACE_FEED_EMPTY_WARNING));
  });
});
