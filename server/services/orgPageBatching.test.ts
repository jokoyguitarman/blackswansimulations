import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../env.js';
import { batchOrgPages, INVENT_RIVAL_LINE } from './orgPageBatching.js';
import { generateSecondaryOrgPages, type OrgRosterEntry } from './socialCrisisGeneratorService.js';

const savedBatch = env.warroomOrgPageBatch;

function pagesFromPrompt(system: string): Record<string, unknown> {
  const orgs: Array<Record<string, unknown>> = [];
  for (const match of system.matchAll(/\[ref (A\d+|C\d+)\]: (.+)/g)) {
    const ref = match[1];
    const name = match[2].trim();
    orgs.push({
      ref,
      org_role: ref.startsWith('C') ? 'antagonist' : 'protagonist',
      display_name: name,
      facebook: { page_name: name, page_handle: '@fb', page_bio: 'bio', follower_count: 10 },
      x_twitter: { page_name: name, page_handle: '@x', page_bio: 'bio', follower_count: 10 },
      stance: ref.startsWith('C') ? 'pressures the primary' : undefined,
      branded_history: [],
    });
  }
  return { orgs };
}

describe('org page batching', () => {
  test('9 orgs at batch size 4 give 3 batches and refs restart', () => {
    const allies = Array.from({ length: 9 }, (_, i) => ({ name: `Ally ${i + 1}` }));
    const batches = batchOrgPages(allies, [], 4, true);
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((batch) => batch.allies.length),
      [4, 4, 1],
    );
    assert.deepEqual(
      batches.map((batch) => batch.inventRival),
      [true, false, false],
    );
    for (const batch of batches) {
      const refs = batch.allies.map((_, index) => `A${index + 1}`);
      assert.equal(refs[0], 'A1');
    }
  });

  test('the invent instruction appears exactly once, and only with no named rivals', async () => {
    env.warroomOrgPageBatch = 4;
    try {
      const prompts: string[] = [];
      const capture = async (system: string) => {
        prompts.push(system);
        return { orgs: [] };
      };
      const allies = Array.from({ length: 9 }, (_, i) => ({ name: `Ally ${i + 1}` }));
      await generateSecondaryOrgPages(
        'A product recall.',
        'Singapore',
        'Primary',
        {
          allies,
          competitors: [],
          auto_antagonist: true,
        },
        undefined,
        capture,
      );
      assert.equal(prompts.length, 3);
      assert.equal(prompts.filter((prompt) => prompt.includes(INVENT_RIVAL_LINE)).length, 1);
      for (const prompt of prompts) {
        assert.match(prompt, /\[ref A1\]/);
        assert.doesNotMatch(prompt, /\[ref A5\]/);
      }

      const named: string[] = [];
      await generateSecondaryOrgPages(
        'A product recall.',
        'Singapore',
        'Primary',
        {
          allies: allies.slice(0, 3),
          competitors: Array.from({ length: 6 }, (_, i) => ({ name: `Rival ${i + 1}` })),
          auto_antagonist: true,
        },
        undefined,
        async (system) => {
          named.push(system);
          return { orgs: [] };
        },
      );
      assert.equal(named.filter((prompt) => prompt.includes(INVENT_RIVAL_LINE)).length, 0);
      for (const prompt of named) {
        if (prompt.includes('[ref C')) assert.match(prompt, /\[ref C1\]/);
      }
    } finally {
      env.warroomOrgPageBatch = savedBatch;
    }
  });

  test('a stubbed 25-rival page stage returns 25 pages', async () => {
    env.warroomOrgPageBatch = 4;
    try {
      const rivals: OrgRosterEntry[] = Array.from({ length: 25 }, (_, i) => ({
        name: `Rival ${String(i + 1).padStart(2, '0')}`,
        org_key: `org_antagonist_${i + 1}`,
        country: 'Singapore',
      }));
      const pages = await generateSecondaryOrgPages(
        'A product recall.',
        'Singapore',
        'Primary',
        { allies: [], competitors: rivals, auto_antagonist: true },
        undefined,
        async (system) => pagesFromPrompt(system),
      );
      assert.equal(pages.length, 25);
      assert.equal(new Set(pages.map((page) => page.org_key)).size, 25);
    } finally {
      env.warroomOrgPageBatch = savedBatch;
    }
  });

  test("a trainer description becomes the rival page's stance", async () => {
    const description = 'Undercuts on price.\nClaims a cleaner safety record.';
    const pages = await generateSecondaryOrgPages(
      'A product recall.',
      'Singapore',
      'Primary',
      {
        allies: [],
        competitors: [
          {
            name: 'Apex Systems',
            country: 'Singapore',
            org_key: 'org_antagonist_apex',
            description: `  ${description}  `,
          },
        ],
        auto_antagonist: false,
      },
      undefined,
      async () => ({
        orgs: [
          {
            ref: 'C1',
            org_role: 'antagonist',
            display_name: 'Apex Systems',
            stance: 'AI wrote a different stance',
            facebook: { page_name: 'Apex', page_handle: '@apex', page_bio: '', follower_count: 1 },
            x_twitter: { page_name: 'Apex', page_handle: '@apex', page_bio: '', follower_count: 1 },
            branded_history: [],
          },
        ],
      }),
    );
    assert.equal(pages.length, 1);
    assert.equal(pages[0].org_key, 'org_antagonist_apex');
    assert.equal(pages[0].role, 'antagonist');
    assert.equal(pages[0].stance, description);
  });
});
