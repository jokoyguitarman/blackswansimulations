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
const SCENARIO = '22222222-2222-4222-8222-222222222222';
const TRAINER = '33333333-3333-4333-8333-333333333333';

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalAuth = supabaseAdmin.auth;
const originalPeace = env.enablePeacePeriod;

describe('session start route', () => {
  const updates: Array<Record<string, unknown>> = [];
  const startedPayloads: Array<Record<string, unknown>> = [];
  let server: ReturnType<typeof createServer>;
  let base = '';
  let failPeaceColumns = false;

  const sessionRow: Record<string, unknown> = {
    id: SESSION,
    trainer_id: TRAINER,
    start_time: null,
    status: 'scheduled',
    scenario_id: SCENARIO,
    sim_mode: null as string | null,
    join_token: 'join-token',
    current_state: {},
  };
  let scenarioRow: Record<string, unknown> = {
    category: 'field_ops',
    initial_state: {},
  };

  function install() {
    (supabaseAdmin as { auth: { getUser: (token: string) => Promise<unknown> } }).auth = {
      getUser: async () => ({
        data: {
          user: {
            id: TRAINER,
            email: 'trainer@example.com',
            app_metadata: { role: 'trainer' },
            user_metadata: {},
          },
        },
        error: null,
      }),
    };
    (supabaseAdmin as { from: (table: string) => unknown }).from = (table: string) => {
      let op = 'select';
      let payload: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      for (const method of [
        'select',
        'eq',
        'neq',
        'in',
        'is',
        'not',
        'or',
        'order',
        'limit',
        'gte',
        'lte',
        'gt',
        'lt',
        'filter',
        'match',
        'contains',
        'insert',
        'upsert',
        'delete',
      ]) {
        builder[method] = self;
      }
      builder.update = (body: Record<string, unknown>) => {
        op = 'update';
        payload = body;
        return builder;
      };
      const finish = () => {
        if (table === 'sessions' && op === 'update' && payload) {
          updates.push(payload);
          if (failPeaceColumns && payload.opened_at) {
            failPeaceColumns = false;
            return { data: null, error: { code: 'PGRST204', message: 'opened_at' } };
          }
          Object.assign(sessionRow, payload);
          return { data: { ...sessionRow }, error: null };
        }
        if (table === 'sessions') return { data: { ...sessionRow }, error: null };
        if (table === 'scenarios') return { data: scenarioRow, error: null };
        if (table === 'user_profiles') {
          return { data: { role: 'trainer', full_name: 'Ada', agency_name: null }, error: null };
        }
        if (table === 'session_call_lines') {
          return { data: null, error: { code: '42P01', message: 'missing' } };
        }
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
          if (event?.type === 'session.started' && event.data) startedPayloads.push(event.data);
        },
      }),
    } as never);
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    (supabaseAdmin as { auth: typeof originalAuth }).auth = originalAuth;
    env.enablePeacePeriod = originalPeace;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function start(body: Record<string, unknown> = { status: 'in_progress' }) {
    updates.length = 0;
    startedPayloads.length = 0;
    sessionRow.start_time = null;
    sessionRow.status = 'scheduled';
    delete sessionRow.opened_at;
    delete sessionRow.peace_seconds;
    const response = await fetch(`${base}/api/sessions/${SESSION}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { data?: Record<string, unknown>; error?: string };
    return { status: response.status, json };
  }

  test('flag off writes start_time and no peace columns', async () => {
    env.enablePeacePeriod = false;
    scenarioRow = {
      category: 'social_media_crisis',
      initial_state: { peace_period: { posts: [{ ref: 'P1' }] } },
    };
    sessionRow.sim_mode = 'social_media';
    const { status, json } = await start({ status: 'in_progress', peace_seconds: 120 });
    assert.equal(status, 200, JSON.stringify(json));
    const claim = updates[0];
    assert.equal(typeof claim.start_time, 'string');
    assert.equal('opened_at' in claim, false);
    assert.equal('peace_seconds' in claim, false);
    const started = Date.parse(String(claim.start_time));
    assert.ok(Math.abs(started - Date.now()) < 5_000);
    assert.equal(json.data?.crisis_starts_at, undefined);
    assert.equal(startedPayloads.length, 1);
    assert.deepEqual(startedPayloads[0], {
      session_id: SESSION,
      status: 'in_progress',
      start_time: claim.start_time,
    });
  });

  test('flag on with a peace feed shifts start_time by the default 300s', async () => {
    env.enablePeacePeriod = true;
    scenarioRow = {
      category: 'social_media_crisis',
      initial_state: { peace_period: { posts: [{ ref: 'P1' }] } },
    };
    sessionRow.sim_mode = 'social_media';
    const { status, json } = await start();
    assert.equal(status, 200, JSON.stringify(json));
    const claim = updates[0];
    const opened = Date.parse(String(claim.opened_at));
    const crisis = Date.parse(String(claim.start_time));
    assert.equal(claim.peace_seconds, 300);
    assert.equal(crisis - opened, 300_000);
    assert.equal(json.data?.crisis_starts_at, claim.start_time);
  });

  test('field-ops and a social scenario with no feed keep start_time = now', async () => {
    env.enablePeacePeriod = true;
    scenarioRow = {
      category: 'field_ops',
      initial_state: { peace_period: { posts: [{ ref: 'P1' }] } },
    };
    sessionRow.sim_mode = null;
    const field = await start();
    assert.equal(field.status, 200, JSON.stringify(field.json));
    assert.equal('opened_at' in updates[0], false);

    scenarioRow = { category: 'social_media_crisis', initial_state: {} };
    sessionRow.sim_mode = 'social_media';
    const bare = await start();
    assert.equal(bare.status, 200, JSON.stringify(bare.json));
    assert.equal('opened_at' in updates[0], false);
  });

  test('a missing peace column retries with start_time = now and no new columns', async () => {
    env.enablePeacePeriod = true;
    failPeaceColumns = true;
    scenarioRow = {
      category: 'social_media_crisis',
      initial_state: { peace_period: { posts: [{ ref: 'P1' }], seconds: 300 } },
    };
    sessionRow.sim_mode = 'social_media';
    const { status, json } = await start();
    assert.equal(status, 200, JSON.stringify(json));
    const claims = updates.filter((row) => 'start_time' in row);
    assert.equal(claims.length, 2);
    assert.equal(typeof claims[0].opened_at, 'string');
    assert.equal('opened_at' in claims[1], false);
    assert.equal('peace_seconds' in claims[1], false);
    assert.equal(claims[1].start_time, claims[0].opened_at);
  });
});
