import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { env } from '../../env.js';
import { CancelledError } from './buildErrors.js';
import { assembleReview } from './assemble.js';
import { buildRequestSchema } from './buildTypes.js';
import { PEACE_FEED_EMPTY_WARNING } from '../generation/peaceFeedCore.js';
import { validPeaceFeed } from '../generation/peaceFeedFixture.js';
import { attachPeaceToPages, type PeaceFeedClient } from '../generation/peaceFeedService.js';

const orgPage = {
  orgs: [
    {
      org_key: 'primary',
      display_name: 'Acme',
      is_primary: true,
      role: 'protagonist',
      control_mode: 'player',
      facebook: {
        page_name: 'Acme',
        page_handle: '@acme',
        page_bio: 'Breakfast',
        follower_count: 10,
      },
      x_twitter: {
        page_name: 'Acme',
        page_handle: '@acme_x',
        page_bio: 'Breakfast',
        follower_count: 10,
      },
    },
    {
      org_key: 'rival',
      display_name: 'Rival',
      is_primary: false,
      role: 'antagonist',
      control_mode: 'ai',
      facebook: {
        page_name: 'Rival',
        page_handle: '@rival',
        page_bio: 'Lunch',
        follower_count: 10,
      },
      x_twitter: { page_name: 'Rival', page_handle: '@rival_x', page_bio: '', follower_count: 1 },
    },
    {
      org_key: 'watch',
      display_name: 'Watch',
      is_primary: false,
      role: 'pressure',
      control_mode: 'ai',
      facebook: {
        page_name: 'Watch',
        page_handle: '@watch',
        page_bio: 'Union',
        follower_count: 10,
      },
      x_twitter: { page_name: 'Watch', page_handle: '@watch_x', page_bio: '', follower_count: 1 },
    },
  ],
};

const personas = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  handle: `@${id}`,
  type: 'npc_public',
  normal_interests: [id === 'a' ? 'cooking' : id],
}));

function pagesOutput() {
  return {
    org_page: orgPage,
    orgs: [{ org_key: 'primary', display_name: 'Acme' }],
    countries: [{ country: 'Singapore' }],
    pressure_injects: [],
    persona_twins: [],
  };
}

function source() {
  return {
    personas,
    orgPage,
    crisisBrief: 'A V15 battery fire forces a recall.',
  };
}

function request() {
  return buildRequestSchema.parse({
    crisis_type: 'Battery fire',
    context: 'A V15 recall',
    organisations: [
      {
        display_name: 'Acme',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }],
      },
    ],
  });
}

describe('pages runner peace sub-step', { concurrency: false }, () => {
  const previous = env.enablePeaceFeedBuildStage;

  test('with the flag off the pages output is unchanged and the model is not called', async () => {
    env.enablePeaceFeedBuildStage = false;
    try {
      let calls = 0;
      const pages = pagesOutput();
      const client: PeaceFeedClient = {
        async complete() {
          calls += 1;
          return validPeaceFeed();
        },
      };
      const output = await attachPeaceToPages(pages, source(), {
        warn: () => undefined,
        client,
      });
      assert.equal(calls, 0);
      assert.equal(output, pages);
      assert.equal('peace_period' in output, false);
      const review = assembleReview(request(), {
        pages: { org_page: output.org_page as Record<string, unknown> },
      });
      assert.equal(review.peace_period, undefined);
      assert.deepEqual(review.org_page, orgPage);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('with the flag on the feed is stored on the pages output and assembled', async () => {
    env.enablePeaceFeedBuildStage = true;
    try {
      const pages = pagesOutput();
      const output = await attachPeaceToPages(pages, source(), {
        warn: () => undefined,
        client: {
          async complete() {
            return validPeaceFeed();
          },
        },
      });
      assert.equal(output.org_page, orgPage);
      assert.equal(output.orgs.length, 1);
      assert.equal(output.peace_period?.posts.length, 12);
      assert.equal('peace_period' in pages, false);
      const review = assembleReview(request(), {
        pages: {
          org_page: output.org_page as Record<string, unknown>,
          peace_period: output.peace_period,
        },
      });
      assert.equal(review.peace_period?.posts.length, 12);
      assert.deepEqual(review.org_page, orgPage);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('a throwing peace client leaves the pages output intact', async () => {
    env.enablePeaceFeedBuildStage = true;
    try {
      const pages = pagesOutput();
      const warnings: string[] = [];
      const output = await attachPeaceToPages(pages, source(), {
        warn: (message) => warnings.push(message),
        client: {
          async complete() {
            throw new Error('provider down');
          },
        },
      });
      assert.equal(output, pages);
      assert.deepEqual(output.org_page, orgPage);
      assert.equal('peace_period' in output, false);
      assert.deepEqual(warnings, [PEACE_FEED_EMPTY_WARNING]);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });

  test('cancellation is rethrown and does not drop the pages object', async () => {
    env.enablePeaceFeedBuildStage = true;
    try {
      const pages = pagesOutput();
      await assert.rejects(
        () =>
          attachPeaceToPages(pages, source(), {
            warn: () => undefined,
            client: {
              async complete() {
                throw new CancelledError();
              },
            },
          }),
        (err: unknown) => err instanceof CancelledError,
      );
      assert.deepEqual(pages.org_page, orgPage);
      assert.equal('peace_period' in pages, false);
    } finally {
      env.enablePeaceFeedBuildStage = previous;
    }
  });
});
