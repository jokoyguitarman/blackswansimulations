import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { resetStaffViewAuditForTests } from '../lib/staffViewAudit.js';
import { staffViewRouter } from './staffView.js';

logger.level = 'silent';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TRAINER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const PLAYER_ID = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;

function install(options?: { auditCode?: string }): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFrom = supabaseAdmin.from;
  const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
  const originalGetUserById = supabaseAdmin.auth.admin.getUserById.bind(supabaseAdmin.auth.admin);

  const tables: Record<string, Row[]> = {
    sessions: [{ id: SESSION, trainer_id: TRAINER_ID, status: 'completed' }],
    session_participants: [{ session_id: SESSION, user_id: PLAYER_ID }],
    user_profiles: [
      { id: ADMIN_ID, role: 'admin', full_name: 'Admin User', agency_name: null },
      { id: TRAINER_ID, role: 'trainer', full_name: 'Trainer One', agency_name: null },
      { id: OTHER_ID, role: 'trainer', full_name: 'Other Trainer', agency_name: null },
      { id: PLAYER_ID, role: 'player', full_name: '   ', agency_name: null },
    ],
    staff_view_audit: [
      {
        staff_user_id: TRAINER_ID,
        last_at: '2026-01-01T00:00:00Z',
        session_id: SESSION,
      },
      {
        staff_user_id: ADMIN_ID,
        last_at: '2026-01-02T00:00:00Z',
        session_id: SESSION,
      },
    ],
  };
  const users = new Map<string, Row>([
    [
      'admin-token',
      {
        id: ADMIN_ID,
        email: 'admin@example.com',
        app_metadata: { role: 'admin' },
        user_metadata: {},
      },
    ],
    [
      'trainer-token',
      {
        id: TRAINER_ID,
        email: 'trainer@example.com',
        app_metadata: { role: 'trainer' },
        user_metadata: {},
      },
    ],
    [
      'other-token',
      {
        id: OTHER_ID,
        email: 'other@example.com',
        app_metadata: { role: 'trainer' },
        user_metadata: {},
      },
    ],
    [
      PLAYER_ID,
      {
        id: PLAYER_ID,
        email: 'ken.yeo@example.com',
        app_metadata: { role: 'participant' },
        user_metadata: {},
      },
    ],
  ]);

  const from = (table: string) => {
    calls.push(table);
    const filters: Array<(row: Row) => boolean> = [];
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'order']) chain[name] = () => chain;
    chain.eq = (col: string, val: unknown) => {
      filters.push((row) => row[col] === val);
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      filters.push((row) => vals.includes(row[col]));
      return chain;
    };
    const pack = () => {
      if (table === 'staff_view_audit' && options?.auditCode) {
        return { data: null, error: { code: options.auditCode, message: 'missing' } };
      }
      const data = (tables[table] ?? []).filter((row) => filters.every((fn) => fn(row)));
      return { data, error: null };
    };
    chain.maybeSingle = async () => {
      const result = pack();
      return {
        data: Array.isArray(result.data) ? (result.data[0] ?? null) : null,
        error: result.error,
      };
    };
    chain.then = (resolve: (value: unknown) => void, reject?: (err: unknown) => void) =>
      Promise.resolve(pack()).then(resolve, reject);
    return chain;
  };

  (supabaseAdmin as unknown as { from: typeof from }).from = from;
  (supabaseAdmin.auth as unknown as { getUser: (token: string) => Promise<unknown> }).getUser =
    async (token: string) => {
      const user = users.get(token);
      if (!user) return { data: { user: null }, error: { message: 'bad token' } };
      return { data: { user }, error: null };
    };
  (
    supabaseAdmin.auth.admin as unknown as { getUserById: (id: string) => Promise<unknown> }
  ).getUserById = async (id: string) => {
    const user = users.get(id);
    if (!user) return { data: { user: null }, error: { message: 'missing' } };
    return { data: { user }, error: null };
  };

  return {
    calls,
    restore() {
      supabaseAdmin.from = originalFrom;
      supabaseAdmin.auth.getUser = originalGetUser;
      supabaseAdmin.auth.admin.getUserById = originalGetUserById;
    },
  };
}

function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, reject) => {
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

async function get(
  base: string,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/sessions/${SESSION}/staff-view`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe('staff view-as roster', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    resetStaffViewAuditForTests();
    delete process.env.ENABLE_STAFF_VIEW_AS;
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    delete process.env.ENABLE_STAFF_VIEW_AS;
    resetStaffViewAuditForTests();
  });

  test('the flag off answers 404 and does not read the session or the audit', async () => {
    const db = install();
    restore = db.restore;
    const app = express();
    app.use('/api/sessions', staffViewRouter);
    const server = await listen(app);
    try {
      const res = await get(server.base, 'admin-token');
      assert.equal(res.status, 404);
      assert.equal(db.calls.includes('sessions'), false);
      assert.equal(db.calls.includes('staff_view_audit'), false);
      assert.equal(db.calls.includes('session_participants'), false);
    } finally {
      await server.close();
    }
  });

  test('an empty profile name is the email the player would see, and admins see who viewed', async () => {
    process.env.ENABLE_STAFF_VIEW_AS = 'true';
    const db = install();
    restore = db.restore;
    const app = express();
    app.use('/api/sessions', staffViewRouter);
    const server = await listen(app);
    try {
      const admin = await get(server.base, 'admin-token');
      assert.equal(admin.status, 200);
      const data = admin.json.data as {
        players: Array<{ user_id: string; name: string }>;
        viewed_by: string[];
      };
      assert.equal(data.players.find((player) => player.user_id === PLAYER_ID)?.name, 'ken.yeo');
      assert.deepEqual(data.viewed_by, ['Admin User', 'Trainer One']);

      const trainer = await get(server.base, 'trainer-token');
      assert.equal(trainer.status, 200);
      const trainerData = trainer.json.data as { viewed_by: string[] };
      assert.deepEqual(trainerData.viewed_by, []);

      const other = await get(server.base, 'other-token');
      assert.equal(other.status, 403);
    } finally {
      await server.close();
    }
  });

  test('an unapplied audit table still returns the roster', async () => {
    process.env.ENABLE_STAFF_VIEW_AS = 'true';
    const db = install({ auditCode: '42P01' });
    restore = db.restore;
    const app = express();
    app.use('/api/sessions', staffViewRouter);
    const server = await listen(app);
    try {
      const admin = await get(server.base, 'admin-token');
      assert.equal(admin.status, 200);
      const data = admin.json.data as { viewed_by: string[]; players: unknown[] };
      assert.deepEqual(data.viewed_by, []);
      assert.equal(data.players.length, 1);
      const again = await get(server.base, 'admin-token');
      assert.equal(again.status, 200);
    } finally {
      await server.close();
    }
  });
});
