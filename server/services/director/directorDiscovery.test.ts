import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import {
  DIRECTOR_PENDING_DISCOVERY_INTERVAL_MS,
  DIRECTOR_PENDING_DISCOVERY_LIMIT,
  hasPendingProposals,
  resetDirectorRuntime,
} from './directorRuntime.js';
import { discoverPendingDirectorProposals, resetDirectorProcessState } from './directorService.js';

mock.module('../../index.js', {
  namedExports: { io: {}, app: {}, server: {} },
});

const { InjectSchedulerService, runSchedulerLoopForTests } =
  await import('../injectSchedulerService.js');

const LIVE = '11111111-1111-4111-8111-111111111111';
const ENDED = '22222222-2222-4222-8222-222222222222';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

interface Recorded {
  table: string;
  select?: string;
  eqs: Array<[string, unknown]>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

function install(rows: unknown[], fail = false): Recorded[] {
  const calls: Recorded[] = [];
  (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
    const call: Recorded = { table, eqs: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const method of [
      'neq',
      'in',
      'is',
      'not',
      'or',
      'gte',
      'lte',
      'gt',
      'lt',
      'filter',
      'match',
    ]) {
      builder[method] = self;
    }
    builder.select = (cols: string) => {
      call.select = cols;
      return builder;
    };
    builder.eq = (column: string, value: unknown) => {
      call.eqs.push([column, value]);
      return builder;
    };
    builder.order = (column: string, opts?: { ascending?: boolean }) => {
      call.order = { column, ascending: opts?.ascending };
      return builder;
    };
    builder.limit = (n: number) => {
      call.limit = n;
      return builder;
    };
    const result =
      table === 'director_proposals' && fail
        ? { data: null, error: { code: 'XX000', message: 'discovery failed' } }
        : { data: table === 'director_proposals' ? rows : [], error: null };
    builder.maybeSingle = async () => result;
    builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  return calls;
}

describe('pending director discovery', () => {
  after(() => {
    supabaseAdmin.from = originalFrom;
    resetDirectorProcessState();
  });

  test('live in-progress sessions are counted and ended ones are not', async () => {
    resetDirectorProcessState();
    resetDirectorRuntime();
    const calls = install([
      { session_id: ENDED, session: { status: 'completed' } },
      { session_id: LIVE, session: { status: 'in_progress' } },
      { session_id: LIVE, session: { status: 'in_progress' } },
    ]);
    assert.equal(await discoverPendingDirectorProposals(), true);
    const query = calls.find((call) => call.table === 'director_proposals');
    assert.equal(query?.select, 'session_id, session:sessions!inner(status)');
    assert.deepEqual(query?.eqs, [
      ['status', 'proposed'],
      ['session.status', 'in_progress'],
    ]);
    assert.deepEqual(query?.order, { column: 'created_at', ascending: false });
    assert.equal(query?.limit, DIRECTOR_PENDING_DISCOVERY_LIMIT);
    assert.equal(hasPendingProposals(LIVE), true);
    assert.equal(hasPendingProposals(ENDED), false);
  });

  test('the scheduler loop rediscovers on the interval and retries a failed read', async () => {
    resetDirectorProcessState();
    resetDirectorRuntime();
    assert.equal(DIRECTOR_PENDING_DISCOVERY_INTERVAL_MS, 5 * 60 * 1000);
    let now = 1_000_000;
    let fail = true;
    const calls: string[] = [];
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit']) {
        builder[method] = self;
      }
      const result =
        table === 'director_proposals' && fail
          ? { data: null, error: { code: 'XX000', message: 'discovery failed' } }
          : {
              data:
                table === 'director_proposals'
                  ? [{ session_id: LIVE, session: { status: 'in_progress' } }]
                  : [],
              error: null,
            };
      builder.maybeSingle = async () => result;
      builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return builder;
    };

    const discoveries = () => calls.filter((table) => table === 'director_proposals').length;
    const scheduler = new InjectSchedulerService(undefined, () => now);
    await runSchedulerLoopForTests(scheduler);
    assert.equal(hasPendingProposals(LIVE), false);
    assert.deepEqual(calls.slice(0, 2), ['director_proposals', 'sessions']);

    await runSchedulerLoopForTests(scheduler);
    assert.equal(discoveries(), 2);

    fail = false;
    await runSchedulerLoopForTests(scheduler);
    assert.equal(hasPendingProposals(LIVE), true);
    const found = discoveries();

    now += DIRECTOR_PENDING_DISCOVERY_INTERVAL_MS - 1;
    await runSchedulerLoopForTests(scheduler);
    assert.equal(discoveries(), found);
    assert.equal(calls.at(-1), 'sessions');

    now += 1;
    await runSchedulerLoopForTests(scheduler);
    assert.equal(discoveries(), found + 1);
  });
});
