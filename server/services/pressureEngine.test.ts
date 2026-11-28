import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  actWithinCap,
  chooseMove,
  orderLeastRecentlyPosted,
  runPage,
  selectLeastRecentlyPosted,
  type PageProgress,
  type PageTickOutcome,
} from './pressureEngineService.js';
import type { OrgConfig, PagePosture } from './socialCrisisGeneratorService.js';

const p = (over: Partial<PageProgress> = {}): PageProgress => ({
  minutesSinceLastPost: Infinity,
  rung: 0,
  maxRung: 3,
  spokespersonContacted: false,
  latestVerdict: null,
  hqPublished: false,
  contradictionSeen: false,
  stoodDown: false,
  decisionTouched: false,
  escalationRisk: 30,
  ...over,
});

describe('pressure tick cap', () => {
  test('keeps the least-recently posted pages and rotates ties', () => {
    const pages = ['a', 'b', 'c', 'd', 'e', 'f'];
    const posted = new Map<string, number>([
      ['c', 30],
      ['d', 10],
      ['e', 50],
    ]);
    const chosen = selectLeastRecentlyPosted(pages, (key) => posted.get(key) ?? null, 4);
    assert.deepEqual(chosen, ['a', 'b', 'f', 'd']);
    const rotated = [...pages.slice(1), pages[0]];
    const tied = selectLeastRecentlyPosted(rotated, () => null, 4);
    assert.deepEqual(tied, ['b', 'c', 'd', 'e']);
  });

  test('more than four finished pages do not keep active pages from posting', async () => {
    type TickPage = {
      key: string;
      register: PagePosture['register'];
      progress: PageProgress;
      lastPosted: number | null;
    };
    const finished: TickPage[] = [
      ...Array.from({ length: 3 }, (_, i) => ({
        key: `stood-down-${i}`,
        register: 'advocacy' as const,
        progress: p({ stoodDown: true }),
        lastPosted: null,
      })),
      {
        key: 'ladder-done',
        register: 'advocacy',
        progress: p({ rung: 3, maxRung: 3, minutesSinceLastPost: 40 }),
        lastPosted: null,
      },
      {
        key: 'aligned-quiet',
        register: 'aligned',
        progress: p({ rung: 2, maxRung: 2, hqPublished: true, minutesSinceLastPost: 40 }),
        lastPosted: null,
      },
    ];
    const active: TickPage[] = [
      {
        key: 'live-a',
        register: 'advocacy',
        progress: p({ rung: 0, minutesSinceLastPost: 30 }),
        lastPosted: 100,
      },
      {
        key: 'live-b',
        register: 'advocacy',
        progress: p({ rung: 1, minutesSinceLastPost: 30 }),
        lastPosted: 200,
      },
    ];
    for (const page of finished) assert.equal(chooseMove(page.register, page.progress), 'skip');
    assert.notEqual(chooseMove(active[0].register, active[0].progress), 'skip');
    assert.notEqual(chooseMove(active[1].register, active[1].progress), 'skip');

    const ordered = orderLeastRecentlyPosted([...finished, ...active], (page) => page.lastPosted);
    const posts: string[] = [];
    await actWithinCap(ordered, 4, async (page) => {
      const move = chooseMove(page.register, page.progress);
      if (move === 'skip') return { posted: false, called: false };
      posts.push(page.key);
      return { posted: true, called: true };
    });
    assert.deepEqual(posts, ['live-a', 'live-b']);
  });

  test('empty model replies count toward the call cap and finished pages do not', async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    await actWithinCap(['finished', 'empty', 'live-a', 'live-b', 'live-c'], 3, async (page) => {
      if (page === 'finished') return { posted: false, called: false };
      calls.push(page);
      if (page === 'empty') return { posted: false, called: true };
      posts.push(page);
      return { posted: true, called: true };
    });
    assert.deepEqual(calls, ['empty', 'live-a', 'live-b']);
    assert.deepEqual(posts, ['live-a', 'live-b']);
  });
});

const skipped: PageTickOutcome = { posted: false, called: false };
const calledOnly: PageTickOutcome = { posted: false, called: true };

describe('runPage model outcomes', () => {
  const originalFrom = supabaseAdmin.from;

  function install(mode: 'empty' | 'insert-fails' | 'recent'): void {
    supabaseAdmin.from = (() => {
      let inserted = false;
      let selected = '';
      const query: Record<string, unknown> = {};
      const self = () => query;
      query.select = (columns?: string) => {
        selected = String(columns ?? '');
        return query;
      };
      query.eq = self;
      query.in = self;
      query.is = self;
      query.order = self;
      query.limit = self;
      query.insert = () => {
        inserted = true;
        return query;
      };
      query.single = self;
      query.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => {
        const recent =
          mode === 'recent' && selected.includes('content')
            ? [{ id: 'old', created_at: new Date().toISOString(), content: 'earlier' }]
            : [];
        const value =
          inserted && mode === 'insert-fails'
            ? { data: null, error: { message: 'insert failed' } }
            : { data: inserted ? { id: 'post-1' } : recent, error: null };
        return Promise.resolve(value).then(resolve, reject);
      };
      return query;
    }) as typeof supabaseAdmin.from;
  }

  async function tick(
    model: () => Promise<Record<string, unknown> | null>,
  ): Promise<PageTickOutcome> {
    const posture: PagePosture = {
      register: 'advocacy',
      mandate: 'Speak for the union',
      demands: ['A meeting'],
      escalation_ladder: ['statement', 'deadline', 'notice'],
      targets_org_keys: [],
      stand_down_signals: ['A written reply'],
    };
    const cfg = {
      org_key: 'prs_union',
      display_name: 'Union',
      is_primary: false,
      role: 'pressure',
      control_mode: 'ai',
      posture,
      facebook: { page_name: 'Union', page_handle: 'union' },
      x_twitter: { page_name: 'Union', page_handle: 'union' },
    } as OrgConfig;
    return runPage(
      'session-1',
      'scenario-1',
      20,
      cfg,
      [
        {
          org_key: 'prs_union',
          platform: 'facebook',
          page_name: 'Union',
          page_handle: 'union',
          role: 'pressure',
          control_mode: 'ai',
        },
      ],
      {},
      30,
      model,
    );
  }

  test('an empty reply, a thrown call and a failed insert each count as a call and do not post', async () => {
    const previous = logger.level;
    logger.level = 'silent';
    try {
      install('empty');
      assert.deepEqual(await tick(async () => ({ content: '   ' })), calledOnly);
      assert.deepEqual(await tick(async () => null), calledOnly);
      assert.deepEqual(
        await tick(async () => {
          throw new Error('rate limited');
        }),
        calledOnly,
      );
      install('insert-fails');
      assert.deepEqual(
        await tick(async () => ({ content: 'We expect a meeting today.' })),
        calledOnly,
      );
      install('recent');
      let asked = 0;
      assert.deepEqual(
        await tick(async () => {
          asked += 1;
          return { content: 'should not be asked' };
        }),
        skipped,
      );
      assert.equal(asked, 0);
    } finally {
      logger.level = previous;
      supabaseAdmin.from = originalFrom;
    }
  });
});

describe('pressure registers', () => {
  test('ignored → statement, then demand with deadline, then climbs the ladder, then stops', () => {
    assert.equal(chooseMove('advocacy', p()), 'statement');
    assert.equal(chooseMove('advocacy', p({ rung: 1 })), 'demand_with_deadline');
    assert.equal(chooseMove('advocacy', p({ rung: 2 })), 'escalate_rung');
    assert.equal(chooseMove('advocacy', p({ rung: 3 })), 'skip');
  });
  test('cadence: too soon → skip; engaged pages post less often; hot sessions faster', () => {
    assert.equal(chooseMove('advocacy', p({ minutesSinceLastPost: 3 })), 'skip');
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 9, rung: 1 })),
      'demand_with_deadline',
    );
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 9, rung: 1, spokespersonContacted: true })),
      'skip',
      'engaged cadence is 14',
    );
    assert.equal(
      chooseMove('advocacy', p({ minutesSinceLastPost: 7, rung: 1, escalationRisk: 70 })),
      'demand_with_deadline',
      'hot → 0.75x',
    );
  });
  test('engaged + judge softened or withdrew → stand down once, then silence', () => {
    assert.equal(
      chooseMove('advocacy', p({ rung: 2, spokespersonContacted: true, latestVerdict: 'cancel' })),
      'stand_down',
    );
    assert.equal(
      chooseMove('statutory', p({ rung: 1, spokespersonContacted: true, latestVerdict: 'modify' })),
      'stand_down',
    );
    assert.equal(
      chooseMove(
        'advocacy',
        p({ rung: 3, spokespersonContacted: true, latestVerdict: 'cancel', stoodDown: true }),
      ),
      'skip',
    );
  });
  test('engaged but only delayed → acknowledge progress; a decision touching the target escalates', () => {
    assert.equal(
      chooseMove('grassroots', p({ rung: 1, spokespersonContacted: true, latestVerdict: 'delay' })),
      'acknowledge_progress',
    );
    assert.equal(chooseMove('political', p({ rung: 1, decisionTouched: true })), 'escalate_rung');
  });
  test('regulators correct the record but never amplify; contradiction only after a first statement', () => {
    assert.equal(
      chooseMove('statutory', p({ rung: 1, contradictionSeen: true })),
      'correct_record',
    );
    assert.equal(chooseMove('statutory', p({ rung: 0, contradictionSeen: true })), 'statement');
    const moves = new Set<string>();
    for (let rung = 0; rung <= 3; rung++)
      for (const v of [null, 'keep', 'delay'] as const)
        moves.add(chooseMove('statutory', p({ rung, latestVerdict: v })));
    assert.ok(!Array.from(moves).some((m) => /amplify|dunk|insinuate/.test(m)));
  });
});

describe('aligned register (AI-operated office)', () => {
  test('HQ silent → one local holding statement, then wait', () => {
    assert.equal(chooseMove('aligned', p()), 'aligned_holding_statement');
    assert.equal(chooseMove('aligned', p({ rung: 1 })), 'skip');
  });
  test('HQ published → mirror it once or twice, never demand', () => {
    assert.equal(chooseMove('aligned', p({ hqPublished: true })), 'aligned_follow_hq');
    assert.equal(chooseMove('aligned', p({ hqPublished: true, rung: 1 })), 'aligned_follow_hq');
    assert.equal(chooseMove('aligned', p({ hqPublished: true, rung: 2 })), 'skip');
  });
  test('inaccurate claim about the site → clarify', () => {
    assert.equal(chooseMove('aligned', p({ contradictionSeen: true, rung: 2 })), 'aligned_clarify');
  });
});
