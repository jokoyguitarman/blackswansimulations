import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, mock, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { env } from '../env.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { initializeWebSocketService } from '../services/websocketService.js';

mock.module('../index.js', {
  namedExports: { io: {}, app: {}, server: {} },
});

const { sessionsRouter } = await import('./sessions.js');

const SESSION = '11111111-1111-4111-8111-111111111111';
const TRAINER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalAuth = supabaseAdmin.auth;
const originalPeace = env.enablePeacePeriod;

describe('POST /sessions/:id/end-peace', () => {
  const updates: Array<Record<string, unknown>> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let server: ReturnType<typeof createServer>;
  let base = '';
  let userId = TRAINER;
  let role = 'trainer';
  const sessionRow: Record<string, unknown> = {
    id: SESSION,
    trainer_id: TRAINER,
    start_time: new Date(Date.now() + 5 * 60_000).toISOString(),
    status: 'in_progress',
    current_state: { peace_period: { leak_terms: ['recall'], posts: [{ ref: 'P1' }] } },
  };

  function install() {
    (supabaseAdmin as { auth: { getUser: (token: string) => Promise<unknown> } }).auth = {
      getUser: async () => ({
        data: {
          user: {
            id: userId,
            email: 'trainer@example.com',
            app_metadata: { role },
            user_metadata: {},
          },
        },
        error: null,
      }),
    };
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      calls.push(table);
      let op = 'select';
      let payload: Record<string, unknown> | null = null;
      let greaterThan: string | null = null;
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of ['select', 'eq', 'is', 'order', 'limit']) builder[method] = self;
      builder.gt = (_column: string, value: string) => {
        greaterThan = value;
        return builder;
      };
      builder.update = (body: Record<string, unknown>) => {
        op = 'update';
        payload = body;
        return builder;
      };
      const finish = () => {
        if (table === 'user_profiles') {
          return { data: { role, full_name: 'Ada', agency_name: null }, error: null };
        }
        if (table === 'sessions' && op === 'update' && payload) {
          const start = typeof sessionRow.start_time === 'string' ? sessionRow.start_time : '';
          if (greaterThan && start <= greaterThan) return { data: null, error: null };
          updates.push(payload);
          Object.assign(sessionRow, payload);
          return { data: { ...sessionRow }, error: null };
        }
        if (table === 'sessions') return { data: { ...sessionRow }, error: null };
        return { data: [], error: null };
      };
      builder.single = async () => finish();
      builder.maybeSingle = async () => finish();
      builder.then = (resolve: (value: unknown) => unknown, reject?: (err: unknown) => unknown) =>
        Promise.resolve(finish()).then(resolve, reject);
      return builder;
    };
  }

  before(async () => {
    install();
    initializeWebSocketService({
      to: () => ({
        emit: (_name: string, event: { type?: string; data?: Record<string, unknown> }) => {
          if (event?.type === 'session.crisis_started' && event.data) broadcasts.push(event.data);
        },
      }),
    } as never);
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    (supabaseAdmin as { auth: typeof originalAuth }).auth = originalAuth;
    env.enablePeacePeriod = originalPeace;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function endPeace() {
    const response = await fetch(`${base}/api/sessions/${SESSION}/end-peace`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    const json = (await response.json()) as { data?: Record<string, unknown>; error?: string };
    return { status: response.status, json };
  }

  test('flag off is 404 and does not touch the session', async () => {
    env.enablePeacePeriod = false;
    calls.length = 0;
    updates.length = 0;
    const { status, json } = await endPeace();
    assert.equal(status, 404);
    assert.equal(json.error, 'Not found');
    assert.deepEqual(calls, []);
    assert.deepEqual(updates, []);
  });

  test('the owner ends peace, players would not see leak terms, and a second call is 409', async () => {
    env.enablePeacePeriod = true;
    userId = TRAINER;
    role = 'trainer';
    sessionRow.start_time = new Date(Date.now() + 5 * 60_000).toISOString();
    updates.length = 0;
    broadcasts.length = 0;
    const first = await endPeace();
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(typeof updates[0]?.start_time, 'string');
    const started = Date.parse(String(updates[0]?.start_time));
    assert.ok(Math.abs(started - Date.now()) < 5_000);
    const peace = (first.json.data?.current_state as { peace_period?: { leak_terms?: unknown } }).peace_period;
    assert.equal(peace?.leak_terms, undefined);
    assert.equal(first.json.data?.crisis_starts_at, updates[0]?.start_time);
    assert.equal(broadcasts[0]?.session_id, SESSION);
    assert.equal(broadcasts[0]?.crisis_starts_at, updates[0]?.start_time);

    const second = await endPeace();
    assert.equal(second.status, 409);
    assert.equal(updates.length, 1);
  });

  test('a participant is rejected and a session already in crisis is 409', async () => {
    env.enablePeacePeriod = true;
    userId = OTHER;
    role = 'participant';
    sessionRow.start_time = new Date(Date.now() + 5 * 60_000).toISOString();
    updates.length = 0;
    const denied = await endPeace();
    assert.equal(denied.status, 403);
    assert.equal(updates.length, 0);

    userId = TRAINER;
    role = 'trainer';
    sessionRow.start_time = new Date(Date.now() - 60_000).toISOString();
    const crisis = await endPeace();
    assert.equal(crisis.status, 409);
    assert.equal(updates.length, 0);

    sessionRow.status = 'completed';
    sessionRow.start_time = new Date(Date.now() + 5 * 60_000).toISOString();
    const done = await endPeace();
    assert.equal(done.status, 409);
    assert.equal(updates.length, 0);
    sessionRow.status = 'in_progress';
  });
});
