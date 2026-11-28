import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import express, { type Express } from 'express';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { socialMediaRouter } from './socialMedia.js';
import { socialMessengerRouter } from './socialMessenger.js';

logger.level = 'silent';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TRAINER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const OTHER_TRAINER = '44444444-4444-4444-8444-444444444444';
const CONTROLLER = '55555555-5555-4555-8555-555555555555';
const OTHER_PLAYER = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, unknown>;

const explorerFlag = env.enableStaffPageExplorer;

function tokenUser(id: string, role: string) {
  return {
    id,
    email: `${role}@example.com`,
    app_metadata: { role },
    user_metadata: {},
  };
}

function install(tables: Record<string, Row[]>, users: Map<string, Record<string, unknown>>) {
  const calls: Array<{ table: string; op: string }> = [];
  const originalFrom = supabaseAdmin.from;
  const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const matching = () => (tables[table] ?? []).filter((row) => filters.every((fn) => fn(row)));
    const chain: Record<string, unknown> = {};
    for (const name of ['select', 'order', 'limit']) chain[name] = () => chain;
    chain.eq = (col: string, val: unknown) => {
      filters.push((row) => row[col] === val);
      return chain;
    };
    chain.or = (expr: string) => {
      const parts = expr.split(',').map((part) => {
        const match = part.match(/^([a-zA-Z0-9_]+)\.eq\."([\s\S]*)"$/);
        if (!match) return () => false;
        const column = match[1] as string;
        const value = match[2] as string;
        return (row: Row) => row[column] === value;
      });
      filters.push((row) => parts.some((fn) => fn(row)));
      return chain;
    };
    const pack = () => {
      calls.push({ table, op: 'read' });
      const data = matching();
      return { data, error: null, count: data.length };
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

  return {
    calls,
    restore() {
      supabaseAdmin.from = originalFrom;
      supabaseAdmin.auth.getUser = originalGetUser;
      env.enableStaffPageExplorer = explorerFlag;
    },
  };
}

function world(status = 'in_progress') {
  return {
    sessions: [{ id: SESSION, trainer_id: TRAINER, status }],
    user_profiles: [
      { id: CONTROLLER, role: 'player', full_name: 'Page Controller', agency_name: null },
      { id: OTHER_PLAYER, role: 'player', full_name: 'Other Player', agency_name: null },
      { id: TRAINER, role: 'trainer', full_name: 'Session Trainer', agency_name: null },
      { id: ADMIN, role: 'admin', full_name: 'Admin', agency_name: null },
      { id: OTHER_TRAINER, role: 'trainer', full_name: 'Other Trainer', agency_name: null },
    ],
    session_participants: [
      { session_id: SESSION, user_id: CONTROLLER },
      { session_id: SESSION, user_id: OTHER_PLAYER },
    ],
    session_page_controllers: [{ session_id: SESSION, user_id: CONTROLLER, org_key: 'acme' }],
    sim_org_pages: [
      {
        id: 'page-acme',
        session_id: SESSION,
        org_key: 'acme',
        is_primary: true,
        platform: 'facebook',
        page_name: 'Acme',
        page_handle: '@acme',
        page_bio: 'The company',
        role: 'protagonist',
        control_mode: 'player',
        kind: null,
        register: null,
        operation: null,
      },
      {
        id: 'page-rival',
        session_id: SESSION,
        org_key: 'rival',
        is_primary: false,
        platform: 'facebook',
        page_name: 'Rival',
        page_handle: '@rival',
        page_bio: 'The rival',
        role: 'antagonist',
        control_mode: 'ai',
        kind: 'pressure',
        register: 'hostile',
        operation: 'ai',
        spokesperson_stakeholder_id: 'reg-1',
      },
    ],
    sim_direct_messages: [
      {
        id: 'm-acme',
        thread_id: 't-acme',
        session_id: SESSION,
        sender_handle: '@fan',
        recipient_handle: '@acme',
        sender_display_name: 'Fan',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:00:00Z',
        content: 'hello acme',
      },
      {
        id: 'm-rival',
        thread_id: 't-rival',
        session_id: SESSION,
        sender_handle: '@fan',
        recipient_handle: '@rival',
        sender_display_name: 'Fan',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:01:00Z',
        content: 'hello rival',
      },
      {
        id: 'm-personal',
        thread_id: 't-personal',
        session_id: SESSION,
        sender_handle: '@page_controller',
        recipient_handle: '@friend',
        sender_display_name: 'Page Controller',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:02:00Z',
        content: 'personal',
      },
    ],
  };
}

const users = new Map<string, Record<string, unknown>>([
  ['controller', tokenUser(CONTROLLER, 'player')],
  ['other-player', tokenUser(OTHER_PLAYER, 'player')],
  ['trainer', tokenUser(TRAINER, 'trainer')],
  ['other-trainer', tokenUser(OTHER_TRAINER, 'trainer')],
  ['admin', tokenUser(ADMIN, 'admin')],
]);

function app(): Express {
  const application = express();
  application.use(express.json());
  application.use('/api/social/messenger', socialMessengerRouter);
  application.use('/api/social', socialMediaRouter);
  return application;
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function get(
  base: string,
  path: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: { data?: unknown; error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      base + path,
      { agent: false, headers: { authorization: `Bearer ${token}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            json: text ? (JSON.parse(text) as { data?: unknown }) : {},
          });
        });
      },
    );
    req.on('error', reject);
  });
}

function threadIds(body: { data?: unknown }): string[] {
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((row) => String((row as { thread_id?: string }).thread_id));
}

describe('page inboxes', () => {
  afterEach(() => {
    env.enableStaffPageExplorer = explorerFlag;
  });

  test('flags off: the new routes are 404 and the page list is unchanged', async () => {
    env.enableStaffPageExplorer = false;
    const db = install(world(), users);
    try {
      await withServer(async (base) => {
        const inbox = await get(
          base,
          `/api/social/messenger/page-inbox/${SESSION}?org_key=acme&platform=facebook`,
          'trainer',
        );
        const thread = await get(
          base,
          `/api/social/messenger/page-thread/t-acme?org_key=acme`,
          'trainer',
        );
        const pages = await get(base, `/api/social/pages/session/${SESSION}`, 'other-player');
        assert.equal(inbox.status, 404);
        assert.equal(thread.status, 404);
        assert.equal(pages.status, 200);
        const rival = (pages.json.data as Array<Record<string, unknown>>).find(
          (page) => page.org_key === 'rival',
        );
        assert.equal(rival?.role, 'antagonist');
        assert.equal(rival?.control_mode, 'ai');
        assert.equal(rival?.kind, 'pressure');
        assert.ok(Array.isArray(rival?.controllers));
        const facebook = rival?.facebook as Record<string, unknown>;
        assert.equal(facebook.operation, 'ai');
      });
      assert.equal(
        db.calls.some((call) => call.table === 'sim_direct_messages'),
        false,
      );
    } finally {
      db.restore();
    }
  });

  test('controller yes, other participant no, session trainer yes, other trainer no, admin yes', async () => {
    env.enableStaffPageExplorer = true;
    const db = install(world(), users);
    try {
      await withServer(async (base) => {
        const path = `/api/social/messenger/page-inbox/${SESSION}?org_key=acme&platform=facebook`;
        const controller = await get(base, path, 'controller');
        const other = await get(base, path, 'other-player');
        const trainer = await get(base, path, 'trainer');
        const outsider = await get(base, path, 'other-trainer');
        const admin = await get(base, path, 'admin');
        assert.equal(controller.status, 200);
        assert.deepEqual(threadIds(controller.json), ['t-acme']);
        assert.equal(other.status, 403);
        assert.equal(trainer.status, 200);
        assert.deepEqual(threadIds(trainer.json), ['t-acme']);
        assert.equal(outsider.status, 403);
        assert.equal(admin.status, 200);
        assert.deepEqual(threadIds(admin.json), ['t-acme']);

        const rival = await get(
          base,
          `/api/social/messenger/page-inbox/${SESSION}?org_key=rival&platform=facebook`,
          'controller',
        );
        assert.equal(rival.status, 403);
        const staffRival = await get(
          base,
          `/api/social/messenger/page-inbox/${SESSION}?org_key=rival&platform=facebook`,
          'trainer',
        );
        assert.deepEqual(threadIds(staffRival.json), ['t-rival']);

        const pageThread = await get(
          base,
          `/api/social/messenger/page-thread/t-acme?org_key=acme`,
          'controller',
        );
        assert.equal(pageThread.status, 200);
        assert.equal((pageThread.json.data as unknown[]).length, 1);
        const deniedThread = await get(
          base,
          `/api/social/messenger/page-thread/t-acme?org_key=acme`,
          'other-player',
        );
        assert.equal(deniedThread.status, 403);
        const wrongPage = await get(
          base,
          `/api/social/messenger/page-thread/t-rival?org_key=acme`,
          'trainer',
        );
        assert.equal(wrongPage.status, 403);
        const staffThread = await get(
          base,
          `/api/social/messenger/page-thread/t-rival?org_key=rival`,
          'admin',
        );
        assert.equal(staffThread.status, 200);
        const otherTrainerThread = await get(
          base,
          `/api/social/messenger/page-thread/t-acme?org_key=acme`,
          'other-trainer',
        );
        assert.equal(otherTrainerThread.status, 403);
      });
    } finally {
      db.restore();
    }
  });

  test('a concluded session stays readable, and a missing query is 400', async () => {
    env.enableStaffPageExplorer = true;
    const db = install(world('completed'), users);
    try {
      await withServer(async (base) => {
        const inbox = await get(
          base,
          `/api/social/messenger/page-inbox/${SESSION}?org_key=acme&platform=facebook`,
          'trainer',
          { 'x-sim-session': SESSION, 'x-sim-spectator': '1' },
        );
        assert.equal(inbox.status, 200);
        assert.deepEqual(threadIds(inbox.json), ['t-acme']);
        const missing = await get(base, `/api/social/messenger/page-inbox/${SESSION}`, 'trainer');
        assert.equal(missing.status, 400);
      });
    } finally {
      db.restore();
    }
  });

  test('the explorer flag does not change who the threads route returns', async () => {
    const db = install(world(), users);
    try {
      await withServer(async (base) => {
        const path = `/api/social/messenger/threads/${SESSION}?platform=facebook`;
        env.enableStaffPageExplorer = false;
        const off = await get(base, path, 'controller');
        env.enableStaffPageExplorer = true;
        const on = await get(base, path, 'controller');
        assert.equal(off.status, 200);
        assert.deepEqual(threadIds(on.json).sort(), threadIds(off.json).sort());
      });
    } finally {
      db.restore();
    }
  });

  test('with the flag on, a player loses internal fields only on pages they do not control', async () => {
    env.enableStaffPageExplorer = true;
    const db = install(world(), users);
    try {
      await withServer(async (base) => {
        const player = await get(base, `/api/social/pages/session/${SESSION}`, 'controller');
        const rows = player.json.data as Array<Record<string, unknown>>;
        const acme = rows.find((page) => page.org_key === 'acme');
        const rival = rows.find((page) => page.org_key === 'rival');
        assert.equal(acme?.role, 'protagonist');
        assert.deepEqual(acme?.controllers, [CONTROLLER]);
        assert.equal(rival?.role, undefined);
        assert.equal(rival?.control_mode, undefined);
        assert.equal(rival?.kind, undefined);
        assert.equal(rival?.controllers, undefined);
        const facebook = rival?.facebook as Record<string, unknown>;
        assert.equal(facebook.page_handle, '@rival');
        assert.equal(facebook.page_bio, 'The rival');
        assert.equal(facebook.operation, undefined);

        const trainer = await get(base, `/api/social/pages/session/${SESSION}`, 'trainer');
        const staffRival = (trainer.json.data as Array<Record<string, unknown>>).find(
          (page) => page.org_key === 'rival',
        );
        assert.equal(staffRival?.role, 'antagonist');
        assert.equal(staffRival?.control_mode, 'ai');
        assert.equal((staffRival?.facebook as Record<string, unknown>).operation, 'ai');
      });
    } finally {
      db.restore();
    }
  });
});
