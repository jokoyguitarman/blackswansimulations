import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { env } from '../env.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

// sessions.ts and the scheduler both reach server/index.ts, which constructs the
// HTTP server. Stub it before those modules load so the tests stay in-process.
mock.module('../index.js', {
  namedExports: { io: {}, app: {}, server: {} },
});

const { silenceActivityMinute } = await import('../lib/sessionPhase.js');
const { sessionMinuteAt } = await import('./ledger/injectLedgerCore.js');
const { parseConditionKey } = await import('./conditions/conditionCatalog.js');
const { evaluateCommsKey } = await import('./conditions/commsConditionsCore.js');
const { latestActivity } = await import('./conditions/teamSignalsCore.js');
const { tickGeneratorEngines } = await import('./engineTicker.js');
const { setPeaceLaneHookForTests } = await import('./peace/peaceLane.js');
const { processSessionForTests } = await import('./injectSchedulerService.js');

import type { CommsState } from './ledger/injectLedgerCore.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const TRAINER = '33333333-3333-4333-8333-333333333333';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalPeace = env.enablePeacePeriod;

function chain(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const method of [
    'select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'gte', 'lte', 'gt', 'lt',
    'filter', 'match', 'contains', 'insert', 'upsert', 'delete',
  ]) {
    builder[method] = self;
  }
  builder.update = self;
  builder.single = async () => result;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function silenceMet(last: number | null, elapsed: number): boolean {
  const state = {
    by_key: {},
    generated_at_minute: elapsed,
    truncated: false,
    team_activity_known: true,
    team_activity: last == null ? {} : { legal: { last_minute: last } },
    team_labels: { legal: 'Legal' },
  } as CommsState;
  const parsed = parseConditionKey('team_silent:10|team=legal');
  assert.equal('error' in parsed, false);
  if ('error' in parsed) return false;
  return evaluateCommsKey(parsed, state, elapsed) === true;
}

describe('peace activity and silence', () => {
  test('a post during peace does not reset team_silent, a crisis post does', () => {
    const opened = '2026-06-01T12:00:00.000Z';
    const start = '2026-06-01T12:05:00.000Z';
    const peaceAt = '2026-06-01T12:04:00.000Z';
    const minute = silenceActivityMinute(start, peaceAt);
    assert.equal(minute, null);
    const activity = latestActivity(minute == null ? [] : [{ team_slug: 'legal', minute }]);
    assert.equal(activity.legal, undefined);
    assert.equal(silenceMet(null, 10), true);
    const countedFromOpen = sessionMinuteAt(opened, peaceAt);
    assert.equal(countedFromOpen, 4);
    assert.equal(silenceMet(countedFromOpen, 10), false);
    assert.equal(silenceActivityMinute(start, '2026-06-01T12:13:00.000Z'), 8);
    assert.equal(silenceMet(8, 10), false);
  });
});

describe('processSession peace gate', () => {
  const calls: string[] = [];

  before(() => {
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      return chain({ data: [], error: null });
    };
  });

  after(() => {
    supabaseAdmin.from = originalFrom;
    env.enablePeacePeriod = originalPeace;
    setPeaceLaneHookForTests(null);
  });

  test('flag on and start_time in the future runs the peace hook and no crisis query', async () => {
    calls.length = 0;
    const seen: string[] = [];
    env.enablePeacePeriod = true;
    setPeaceLaneHookForTests(async (session) => {
      seen.push(session.id);
    });
    await processSessionForTests({
      id: SESSION,
      scenario_id: SCENARIO,
      start_time: new Date(Date.now() + 5 * 60_000).toISOString(),
      trainer_id: TRAINER,
      status: 'in_progress',
      sim_mode: 'social_media',
    });
    assert.deepEqual(seen, [SESSION]);
    assert.deepEqual(calls, []);
  });

  test('flag off does not enter the peace hook, even if start_time is ahead', async () => {
    calls.length = 0;
    const seen: string[] = [];
    env.enablePeacePeriod = false;
    setPeaceLaneHookForTests(async (session) => {
      seen.push(session.id);
    });
    await processSessionForTests({
      id: SESSION,
      scenario_id: SCENARIO,
      start_time: new Date(Date.now() + 5 * 60_000).toISOString(),
      trainer_id: TRAINER,
      status: 'in_progress',
      sim_mode: 'social_media',
    });
    assert.deepEqual(seen, []);
    assert.ok(calls.length > 0);
  });
});

describe('engineTicker peace gate', () => {
  const calls: string[] = [];

  after(() => {
    supabaseAdmin.from = originalFrom;
    env.enablePeacePeriod = originalPeace;
  });

  test('flag on skips a peace session before any engine query', async () => {
    calls.length = 0;
    env.enablePeacePeriod = true;
    const rows = [
      { id: 'peace-session', start_time: new Date(Date.now() + 5 * 60_000).toISOString() },
    ];
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      return chain({ data: table === 'sessions' ? rows : [], error: null });
    };
    await tickGeneratorEngines();
    assert.deepEqual(calls, ['sessions']);
  });

  test('flag off still ticks a session whose start_time is in the past', async () => {
    calls.length = 0;
    env.enablePeacePeriod = false;
    const rows = [
      { id: 'live-session', start_time: new Date(Date.now() - 60_000).toISOString() },
    ];
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      return chain({ data: table === 'sessions' ? rows : [], error: null });
    };
    await tickGeneratorEngines();
    assert.ok(calls.filter((table) => table === 'sessions').length > 1);
  });
});
