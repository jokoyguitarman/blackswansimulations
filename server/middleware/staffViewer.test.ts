import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express, { type Express, type RequestHandler, type Response, type Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import {
  canSpectate,
  playerWriteBlock,
  sandboxExemptFromConcludedFreeze,
  SESSION_CONCLUDED_CODE,
} from '../lib/socialAccess.js';
import { resetStaffViewAuditForTests } from '../lib/staffViewAudit.js';
import {
  GET_LAZY_SEEDS,
  GETS_WITHOUT_SESSION_CHECK,
  SURFACE_ROUTER_FILES,
  SURFACE_ROUTES,
  lookupSurfaceRoute,
  registrySummary,
  type RouterId,
  type SurfaceRoute,
} from '../lib/surfaceRoutes.js';
import {
  VIEW_AS_DENIED,
  VIEW_AS_SESSION_MISMATCH,
  SPECTATOR_READ_ONLY,
  STAFF_PLAYER_ACTION_BLOCKED,
  getSideEffectAllowed,
  parseViewHeaders,
  spectatorWriteBlock,
  staffPlayerActionBlock,
} from '../lib/viewerDecision.js';
import { applyMountedViewer, staffViewAsEnabled, staffViewer } from './viewer.js';
import { requireAuth, type AuthenticatedRequest } from './auth.js';
import { allowVoiceInitiate, allowVoiceSignal } from '../websocket/voiceSpectator.js';
import { registerVoiceSignaling } from '../websocket/voiceSignaling.js';

logger.level = 'silent';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TRAINER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '55555555-5555-4555-8555-555555555555';
const ROW = '66666666-6666-4666-8666-666666666666';
const TRAINER_CHANNEL = '77777777-7777-4777-8777-777777777777';
const PLAYER_ID = '88888888-8888-4888-8888-888888888888';
const POST_A = '99999999-9999-4999-8999-999999999999';
const POST_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POST_C = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POST_D = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ROUTERS = Object.keys(SURFACE_ROUTER_FILES) as RouterId[];
const admin = { id: ADMIN_ID, role: 'admin' };
const trainer = { id: TRAINER_ID, role: 'trainer' };
const otherTrainer = { id: OTHER_ID, role: 'trainer' };
const outsider = { id: PLAYER_ID, role: 'player' };

type Row = Record<string, unknown>;

interface DbHandle {
  calls: Array<{ table: string; op: string }>;
  restore: () => void;
}

function baseTables(): Record<string, Row[]> {
  const generic = {
    id: ROW,
    thread_id: ROW,
    session_id: SESSION,
    type: 'team',
    user_id: SUBJECT_ID,
  };
  const tables: Record<string, Row[]> = {
    sessions: [{ id: SESSION, trainer_id: TRAINER_ID, status: 'in_progress' }],
    session_participants: [{ session_id: SESSION, user_id: SUBJECT_ID, demographics: null }],
    user_profiles: [
      { id: SUBJECT_ID, role: 'player', full_name: 'Ada Lovelace', agency_name: null },
      { id: ADMIN_ID, role: 'admin', full_name: 'Admin User', agency_name: null },
      { id: TRAINER_ID, role: 'trainer', full_name: 'Trainer One', agency_name: null },
    ],
    staff_view_audit: [],
    chat_channels: [generic, { id: TRAINER_CHANNEL, session_id: SESSION, type: 'trainer' }],
  };
  for (const table of [
    'social_posts',
    'sim_emails',
    'sim_news_articles',
    'sim_direct_messages',
    'sim_groups',
    'sim_group_posts',
    'sim_events',
    'sim_calls',
    'player_drafts',
    'notifications',
  ]) {
    tables[table] = [{ ...generic }];
  }
  return tables;
}

function install(
  tables: Record<string, Row[]>,
  options?: { auditError?: string; users?: Map<string, Record<string, unknown>> },
): DbHandle {
  const calls: Array<{ table: string; op: string }> = [];
  const originalFrom = supabaseAdmin.from;
  const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
  const users = options?.users ?? new Map<string, Record<string, unknown>>();

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let limited = Number.POSITIVE_INFINITY;
    const matching = () =>
      (tables[table] ?? []).filter((row) => filters.every((fn) => fn(row))).slice(0, limited);
    const auditError = options?.auditError;
    const failed = () => table === 'staff_view_audit' && auditError;
    const chain: Record<string, unknown> = {};
    const passthrough = [
      'select',
      'order',
      'range',
      'filter',
      'match',
      'contains',
      'overlaps',
      'like',
      'ilike',
      'gte',
      'lte',
      'gt',
      'lt',
    ];
    for (const name of passthrough) chain[name] = () => chain;
    chain.limit = (n: number) => {
      limited = n;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push((row) => row[col] === val);
      return chain;
    };
    chain.neq = (col: string, val: unknown) => {
      filters.push((row) => row[col] !== val);
      return chain;
    };
    chain.is = (col: string, val: unknown) => {
      filters.push((row) => (val === null ? row[col] == null : row[col] === val));
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      filters.push((row) => vals.includes(row[col]));
      return chain;
    };
    chain.not = (col: string, op: string, val: unknown) => {
      if (op === 'is' && val === null) filters.push((row) => row[col] != null);
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
      if (failed())
        return { data: null, error: { code: auditError, message: 'missing' }, count: 0 };
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
    chain.single = async () => {
      const result = pack();
      const row = Array.isArray(result.data) ? result.data[0] : null;
      if (result.error) return { data: null, error: result.error };
      if (!row) return { data: null, error: { code: 'PGRST116', message: '0 rows' } };
      return { data: row, error: null };
    };
    chain.insert = async (payload: Row) => {
      calls.push({ table, op: 'insert' });
      if (failed()) return { data: null, error: { code: auditError, message: 'missing' } };
      (tables[table] ??= []).push(payload);
      return { data: payload, error: null };
    };
    chain.update = (payload: Row) => {
      calls.push({ table, op: 'update' });
      const updated = {
        eq() {
          return updated;
        },
        select() {
          return updated;
        },
        then(resolve: (value: { data: Row; error: null }) => void) {
          resolve({ data: payload, error: null });
        },
      };
      return updated;
    };
    chain.upsert = async (payload: Row) => {
      calls.push({ table, op: 'upsert' });
      return { data: payload, error: null };
    };
    chain.delete = () => {
      calls.push({ table, op: 'delete' });
      const deleted = {
        eq() {
          return deleted;
        },
        then(resolve: (value: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return deleted;
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
    },
  };
}

function setFlags(viewAs: boolean, guard: boolean): void {
  if (viewAs) process.env.ENABLE_STAFF_VIEW_AS = 'true';
  else delete process.env.ENABLE_STAFF_VIEW_AS;
  if (guard) process.env.STAFF_PLAYER_ACTION_GUARD = 'true';
  else delete process.env.STAFF_PLAYER_ACTION_GUARD;
}

function concrete(path: string): string {
  return path.replace(/:sessionId/g, SESSION).replace(/:[A-Za-z0-9_]+/g, ROW);
}

function requestBody(route: SurfaceRoute): unknown {
  if (route.bind.kind === 'body') return { [route.bind.name]: SESSION };
  return undefined;
}

function requestPath(route: SurfaceRoute): string {
  const path = concrete(route.path);
  if (route.bind.kind === 'query')
    return `${path}?${route.bind.name}=${encodeURIComponent(SESSION)}`;
  return path;
}

async function withApp(app: Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function hit(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{
  status: number;
  json: { code?: string; error?: string; data?: unknown; userId?: string; ok?: boolean };
}> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as { code?: string }) : {} };
}

function appFor(routerId: RouterId, user: { id: string; role: string }): Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(staffViewer(routerId));
  const mount = router as unknown as Record<
    string,
    (path: string, handler: RequestHandler) => void
  >;
  for (const entry of SURFACE_ROUTES.filter((item) => item.router === routerId)) {
    // Same point as requireAuth: after Express has matched the route.
    mount[entry.method.toLowerCase()]?.(entry.path, async (req, res) => {
      (req as AuthenticatedRequest).user = { ...user };
      const gate = applyMountedViewer(req as AuthenticatedRequest, res);
      if (gate !== false && (await gate)) return;
      res.status(200).json({ ok: true, userId: (req as AuthenticatedRequest).user?.id ?? null });
    });
  }
  app.use(router);
  return app;
}

const viewHeaders = {
  'x-sim-session': SESSION,
  'x-sim-view-as': SUBJECT_ID,
};

describe('staff viewer', { concurrency: false }, () => {
  beforeEach(() => {
    setFlags(false, false);
    resetStaffViewAuditForTests();
  });

  afterEach(() => {
    setFlags(false, false);
    resetStaffViewAuditForTests();
  });

  test('registry matches the router files, and every write is classified', () => {
    const marker =
      /requireSocialRead\(|requireSocialStaff\(|assertSessionAccess\(|assertChannelAccess\(|authorizeDraftRead\(|deps\.access\(|isSessionStaff\(|session_participants/;
    const writeCall = /\.(insert|update|upsert|delete)\(/;
    const parsed: Array<{ router: RouterId; method: string; path: string; body: string }> = [];
    for (const routerId of ROUTERS) {
      const file = SURFACE_ROUTER_FILES[routerId];
      const text = readFileSync(file, 'utf8');
      const mounted = text.indexOf(`router.use(staffViewer('${routerId}'))`);
      const firstRoute = text.search(/router\.(get|post|put|patch|delete)\(/);
      assert.ok(
        mounted >= 0 && mounted < firstRoute,
        `${file} must mount staffViewer before its routes`,
      );
      const matches = [
        ...text.matchAll(/router\.(get|post|put|patch|delete)\(\s*(?:\n\s*)?['"]([^'"]+)['"]/g),
      ];
      matches.forEach((match, index) => {
        const start = match.index ?? 0;
        const end = matches[index + 1]?.index ?? text.length;
        parsed.push({
          router: routerId,
          method: (match[1] as string).toUpperCase(),
          path: match[2] as string,
          body: text.slice(start, end),
        });
      });
    }

    assert.equal(parsed.length, SURFACE_ROUTES.length);
    for (const found of parsed) {
      const registered = SURFACE_ROUTES.find(
        (entry) =>
          entry.router === found.router &&
          entry.method === found.method &&
          entry.path === found.path,
      );
      assert.ok(registered, `unregistered ${found.method} ${found.router} ${found.path}`);
      if (found.method === 'GET') {
        const checked = marker.test(found.body);
        const allowed = GETS_WITHOUT_SESSION_CHECK.some(
          (entry) => entry.router === found.router && entry.path === found.path,
        );
        assert.ok(checked || allowed, `GET ${found.router} ${found.path} has no session check`);
        if (writeCall.test(found.body)) {
          assert.match(found.body, /getSideEffectAllowed\(/);
        }
      } else {
        assert.ok(registered?.class === 'player' || registered?.class === 'staff');
      }
    }
    for (const entry of SURFACE_ROUTES) {
      assert.ok(
        parsed.some(
          (found) =>
            found.router === entry.router &&
            found.method === entry.method &&
            found.path === entry.path,
        ),
      );
    }

    const unchecked = parsed
      .filter((found) => found.method === 'GET' && !marker.test(found.body))
      .map((found) => `${found.router} ${found.path}`)
      .sort();
    const allowed = GETS_WITHOUT_SESSION_CHECK.map(
      (entry) => `${entry.router} ${entry.path}`,
    ).sort();
    assert.deepEqual(unchecked, allowed);
    assert.ok(allowed.includes('socialMedia /media/preview/:previewId'));

    const seeds = parsed
      .filter((found) => found.method === 'GET')
      .flatMap((found) => {
        const calls = ['createDefaultChannels', 'ensureTeamChannels'].filter((name) =>
          found.body.includes(name),
        );
        return calls.length ? [{ router: found.router, path: found.path, calls }] : [];
      });
    assert.deepEqual(seeds, GET_LAZY_SEEDS);

    for (const [router, method, path] of [
      ['socialMedia', 'POST', '/emails/:emailId/read'],
      ['socialMedia', 'POST', '/news/:articleId/read'],
      ['socialMessenger', 'POST', '/:messageId/read'],
      ['channels', 'POST', '/:channelId/read'],
    ] as const) {
      const entry = SURFACE_ROUTES.find(
        (route) => route.router === router && route.method === method && route.path === path,
      );
      assert.equal(entry?.class, 'player', `${method} ${path} is a player mark-read`);
    }

    const summary = registrySummary();
    assert.equal(summary.player + summary.staff, summary.nonGet);
  });

  test('lookup prefers the static session segment over :postId', () => {
    const match = lookupSurfaceRoute('socialMedia', 'GET', `/posts/session/${SESSION}`);
    assert.equal(match?.path, '/posts/session/:sessionId');
  });

  test('header, write and voice decisions', () => {
    assert.deepEqual(parseViewHeaders({}), { type: 'self' });
    assert.equal(parseViewHeaders({ viewAs: SUBJECT_ID }).type, 'error');
    const viewAs = parseViewHeaders({ viewAs: SUBJECT_ID, session: ' other ' });
    assert.equal(viewAs.type, 'view_as');
    if (viewAs.type === 'view_as') assert.equal(viewAs.sessionId, 'other');
    assert.equal(parseViewHeaders({ spectator: '1', session: SESSION }).type, 'spectator');
    assert.equal(spectatorWriteBlock('view_as', 'POST')?.code, SPECTATOR_READ_ONLY);
    assert.equal(spectatorWriteBlock('spectator', 'DELETE')?.code, SPECTATOR_READ_ONLY);
    assert.equal(spectatorWriteBlock('view_as', 'GET'), null);
    assert.equal(spectatorWriteBlock('sandbox', 'POST'), null);
    assert.equal(spectatorWriteBlock('self', 'POST'), null);
    assert.equal(
      staffPlayerActionBlock({
        method: 'POST',
        routeClass: 'player',
        staffRole: true,
        live: true,
        participant: false,
      })?.code,
      STAFF_PLAYER_ACTION_BLOCKED,
    );
    assert.equal(
      staffPlayerActionBlock({
        method: 'POST',
        routeClass: 'staff',
        staffRole: true,
        live: true,
        participant: false,
      }),
      null,
    );
    assert.equal(
      staffPlayerActionBlock({
        method: 'POST',
        routeClass: 'player',
        staffRole: true,
        live: false,
        participant: false,
      }),
      null,
    );
    assert.equal(getSideEffectAllowed(undefined), true);
    assert.equal(getSideEffectAllowed('self'), true);
    assert.equal(getSideEffectAllowed('view_as'), false);
    assert.equal(getSideEffectAllowed('spectator'), false);
    assert.equal(allowVoiceInitiate(false, false), true);
    assert.equal(allowVoiceInitiate(true, false), false);
    assert.equal(allowVoiceInitiate(true, true), true);
    assert.equal(allowVoiceSignal(false, 'outsider', null), true);
    assert.equal(allowVoiceSignal(true, 'outsider', true), false);
    assert.equal(allowVoiceSignal(true, 'member', null), true);
    assert.equal(allowVoiceSignal(true, 'unknown', false), false);
    assert.equal(allowVoiceSignal(true, 'unknown', true), true);

    const owned = { trainer_id: TRAINER_ID, status: 'in_progress' };
    assert.equal(canSpectate(admin, owned), true);
    assert.equal(canSpectate(trainer, owned), true);
    assert.equal(canSpectate(otherTrainer, owned), false);
    assert.equal(canSpectate(outsider, owned), false);
    assert.equal(sandboxExemptFromConcludedFreeze({ status: 'sandbox' }), true);
    assert.equal(sandboxExemptFromConcludedFreeze({ status: 'completed' }), false);
    assert.equal(
      playerWriteBlock(outsider, { trainer_id: TRAINER_ID, status: 'completed' })?.code,
      SESSION_CONCLUDED_CODE,
    );
    assert.equal(playerWriteBlock(outsider, { status: 'sandbox' }), null);
  });

  test('flags off: middleware does not read headers or query, on every route', async () => {
    assert.equal(staffViewAsEnabled(), false);
    const touched = { req: false };
    const proxy = new Proxy(
      {},
      {
        get() {
          touched.req = true;
          return undefined;
        },
        set() {
          touched.req = true;
          return true;
        },
      },
    );
    let nextCalled = false;
    staffViewer('socialMedia')(proxy as AuthenticatedRequest, {} as Response, () => {
      nextCalled = true;
    });
    const gate = applyMountedViewer(proxy as AuthenticatedRequest, {} as Response);
    assert.equal(gate, false);
    assert.equal(touched.req, false);
    assert.equal(nextCalled, true);

    const db = install(baseTables());
    try {
      for (const routerId of ROUTERS) {
        await withApp(appFor(routerId, admin), async (base) => {
          for (const route of SURFACE_ROUTES.filter((entry) => entry.router === routerId)) {
            const res = await hit(
              base,
              route.method,
              requestPath(route),
              viewHeaders,
              requestBody(route),
            );
            assert.equal(res.status, 200, `${route.method} ${routerId} ${route.path}`);
            assert.equal(res.json.userId, ADMIN_ID);
          }
        });
      }
      assert.equal(db.calls.length, 0);
    } finally {
      db.restore();
    }
  });

  test('flags off: requireAuth does not read X-Sim headers or audit', async () => {
    const db = install(baseTables(), {
      users: new Map([
        [
          'admin-token',
          {
            id: ADMIN_ID,
            email: 'admin@example.com',
            app_metadata: { role: 'admin' },
            user_metadata: {},
          },
        ],
      ]),
    });
    try {
      let nextCalled = false;
      const req = {
        headers: new Proxy(
          { authorization: 'Bearer admin-token' },
          {
            get(target, prop, receiver) {
              if (typeof prop === 'string' && prop.toLowerCase().includes('x-sim')) {
                throw new Error(`read ${prop}`);
              }
              return Reflect.get(target, prop, receiver);
            },
          },
        ),
        get(name: string) {
          if (name.toLowerCase().includes('sim')) throw new Error(`get ${name}`);
          return undefined;
        },
      } as unknown as AuthenticatedRequest;
      await requireAuth(req, { headersSent: false } as Response, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.user?.id, ADMIN_ID);
      assert.equal(req.viewer, undefined);
      assert.deepEqual(
        db.calls.map((call) => call.table),
        ['user_profiles'],
      );
    } finally {
      db.restore();
    }
  });

  test('view-as and spectator: admin, owning trainer, denied callers, mismatch, and every write', async () => {
    const db = install(baseTables());
    try {
      setFlags(true, false);
      await withApp(appFor('socialMedia', admin), async (base) => {
        const read = await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        assert.equal(read.status, 200);
        assert.equal(read.json.userId, SUBJECT_ID);

        const write = await hit(base, 'POST', '/posts', viewHeaders, { session_id: SESSION });
        assert.equal(write.status, 403);
        assert.equal(write.json.code, SPECTATOR_READ_ONLY);

        const staffWrite = await hit(
          base,
          'POST',
          `/pages/session/${SESSION}/post-as`,
          viewHeaders,
          {},
        );
        assert.equal(staffWrite.status, 403);
        assert.equal(staffWrite.json.code, SPECTATOR_READ_ONLY);

        const mismatch = await hit(base, 'GET', `/posts/session/${OTHER_ID}`, viewHeaders);
        assert.equal(mismatch.status, 400);
        assert.equal(mismatch.json.code, VIEW_AS_SESSION_MISMATCH);

        const missing = await hit(base, 'GET', `/posts/session/${SESSION}`, {
          'x-sim-view-as': SUBJECT_ID,
        });
        assert.equal(missing.status, 400);
        assert.equal(missing.json.code, VIEW_AS_SESSION_MISMATCH);

        const spectator = await hit(base, 'GET', `/posts/session/${SESSION}`, {
          'x-sim-session': SESSION,
          'x-sim-spectator': '1',
        });
        assert.equal(spectator.status, 200);
        assert.equal(spectator.json.userId, ADMIN_ID);
        const spectatorWrite = await hit(
          base,
          'POST',
          '/posts',
          {
            'x-sim-session': SESSION,
            'x-sim-spectator': '1',
          },
          { session_id: SESSION },
        );
        assert.equal(spectatorWrite.status, 403);
        assert.equal(spectatorWrite.json.code, SPECTATOR_READ_ONLY);
      });

      await withApp(appFor('socialMedia', trainer), async (base) => {
        const own = await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        assert.equal(own.status, 200);
        assert.equal(own.json.userId, SUBJECT_ID);
      });
      await withApp(appFor('socialMedia', otherTrainer), async (base) => {
        const denied = await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        assert.equal(denied.status, 403);
        assert.equal(denied.json.code, VIEW_AS_DENIED);
      });
      await withApp(appFor('socialMedia', outsider), async (base) => {
        const denied = await hit(base, 'POST', '/posts', viewHeaders, { session_id: SESSION });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.code, VIEW_AS_DENIED);
      });
      await withApp(appFor('socialMedia', admin), async (base) => {
        const denied = await hit(base, 'GET', `/posts/session/${SESSION}`, {
          'x-sim-session': SESSION,
          'x-sim-view-as': OTHER_ID,
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.code, VIEW_AS_DENIED);
      });

      for (const routerId of ROUTERS) {
        await withApp(appFor(routerId, admin), async (base) => {
          for (const route of SURFACE_ROUTES.filter(
            (entry) => entry.router === routerId && entry.method !== 'GET',
          )) {
            const res = await hit(
              base,
              route.method,
              requestPath(route),
              viewHeaders,
              requestBody(route),
            );
            assert.equal(res.status, 403, `${route.method} ${routerId} ${route.path}`);
            assert.equal(res.json.code, SPECTATOR_READ_ONLY);
          }
        });
      }
      assert.ok(db.calls.some((call) => call.table === 'staff_view_audit' && call.op === 'insert'));
    } finally {
      db.restore();
    }
  });

  test('staff player guard blocks player routes and leaves staff routes open', async () => {
    const tables = baseTables();
    const db = install(tables);
    try {
      setFlags(false, true);
      await withApp(appFor('socialMedia', trainer), async (base) => {
        const playerRoute = await hit(base, 'POST', '/posts', {}, { session_id: SESSION });
        assert.equal(playerRoute.status, 403);
        assert.equal(playerRoute.json.code, STAFF_PLAYER_ACTION_BLOCKED);
        const staffRoute = await hit(base, 'POST', `/pages/session/${SESSION}/seize`, {}, {});
        assert.equal(staffRoute.status, 200);
      });
      await withApp(appFor('channels', trainer), async (base) => {
        const teamChannel = await hit(base, 'POST', `/${ROW}/messages`, {}, { content: 'hi' });
        assert.equal(teamChannel.status, 403);
        assert.equal(teamChannel.json.code, STAFF_PLAYER_ACTION_BLOCKED);
        const trainerChannel = await hit(
          base,
          'POST',
          `/${TRAINER_CHANNEL}/messages`,
          {},
          { content: 'hi' },
        );
        assert.equal(trainerChannel.status, 200);
      });
      tables.session_participants.push({ session_id: SESSION, user_id: TRAINER_ID });
      await withApp(appFor('socialMedia', trainer), async (base) => {
        const playing = await hit(base, 'POST', '/posts', {}, { session_id: SESSION });
        assert.equal(playing.status, 200);
      });
      const session = tables.sessions[0] as Row;
      session.status = 'completed';
      tables.session_participants.splice(0, tables.session_participants.length, {
        session_id: SESSION,
        user_id: SUBJECT_ID,
      });
      await withApp(appFor('socialMedia', trainer), async (base) => {
        const concluded = await hit(base, 'POST', '/posts', {}, { session_id: SESSION });
        assert.equal(concluded.status, 200);
      });
    } finally {
      db.restore();
    }
  });

  test('unapplied migration 283 logs one warning and viewing still works', async () => {
    const warnings: string[] = [];
    const original = logger.warn.bind(logger);
    logger.warn = ((obj: unknown, msg?: string) => {
      warnings.push(typeof msg === 'string' ? msg : JSON.stringify(obj));
    }) as typeof logger.warn;
    const db = install(baseTables(), { auditError: '42P01' });
    try {
      setFlags(true, false);
      await withApp(appFor('socialMedia', admin), async (base) => {
        const first = await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        const second = await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(first.json.userId, SUBJECT_ID);
      });
      const auditReads = db.calls.filter((call) => call.table === 'staff_view_audit');
      assert.equal(auditReads.length, 1);
      assert.equal(warnings.filter((line) => line.includes('migration 283')).length, 1);
    } finally {
      logger.warn = original;
      db.restore();
    }
  });

  test('audit bumps at most once a minute', async () => {
    const db = install(baseTables());
    try {
      setFlags(true, false);
      await withApp(appFor('socialMedia', admin), async (base) => {
        await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
        await hit(base, 'GET', `/posts/session/${SESSION}`, viewHeaders);
      });
      const inserts = db.calls.filter(
        (call) => call.table === 'staff_view_audit' && call.op === 'insert',
      );
      assert.equal(inserts.length, 1);
    } finally {
      db.restore();
    }
  });
});

describe('player-surface route wiring', { concurrency: false }, () => {
  const originalSetInterval = global.setInterval.bind(global);
  let social: Router | undefined;
  let messenger: Router | undefined;

  beforeEach(() => {
    setFlags(false, false);
    resetStaffViewAuditForTests();
  });

  afterEach(() => {
    setFlags(false, false);
    resetStaffViewAuditForTests();
  });

  async function loadRouters(): Promise<{ social: Router; messenger: Router }> {
    if (social && messenger) return { social, messenger };
    global.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = originalSetInterval(...args);
      handle.unref();
      return handle;
    }) as typeof setInterval;
    social = (await import('../routes/socialMedia.js')).socialMediaRouter;
    messenger = (await import('../routes/socialMessenger.js')).socialMessengerRouter;
    global.setInterval = originalSetInterval as typeof setInterval;
    return { social, messenger };
  }

  function tokenUser(id: string, role: string) {
    return {
      id,
      email: `${role}@example.com`,
      app_metadata: { role },
      user_metadata: {},
    };
  }

  test('GETs that the session-access fix guards reject a non-member', async () => {
    const routers = await loadRouters();
    const users = new Map<string, Record<string, unknown>>([
      ['player-token', tokenUser(PLAYER_ID, 'player')],
    ]);
    const tables = baseTables();
    tables.sim_direct_messages = [
      {
        id: 'message-1',
        thread_id: 'thread-denied',
        session_id: SESSION,
        sender_handle: '@someone',
        recipient_handle: '@else',
        platform: 'facebook',
        is_read: false,
      },
    ];
    const db = install(tables, { users });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/social/messenger', routers.messenger);
      app.use('/api/social', routers.social);
      await withApp(app, async (base) => {
        const headers = { authorization: 'Bearer player-token' };
        for (const path of [
          `/api/social/posts/session/${SESSION}`,
          `/api/social/emails/session/${SESSION}`,
          `/api/social/org-page/session/${SESSION}`,
          `/api/social/pages/session/${SESSION}`,
          `/api/social/messenger/threads/${SESSION}`,
          '/api/social/messenger/thread/thread-denied',
        ]) {
          const res = await hit(base, 'GET', path, headers);
          assert.equal(res.status, 403, path);
        }
      });
    } finally {
      db.restore();
    }
  });

  test('view-as posts and messenger use the subject, and flags off keep the staff user', async () => {
    const routers = await loadRouters();
    const users = new Map<string, Record<string, unknown>>([
      ['admin-token', tokenUser(ADMIN_ID, 'admin')],
    ]);
    const tables = baseTables();
    const post = (id: string, extra: Row): Row => ({
      id,
      session_id: SESSION,
      platform_removed: false,
      content: id,
      is_surfaced_to_session: false,
      target_demographics: null,
      virality_score: 1,
      ...extra,
    });
    tables.social_posts = [
      post(POST_A, { target_player_ids: null }),
      post(POST_B, { target_player_ids: null }),
      post(POST_C, { target_player_ids: [ADMIN_ID] }),
      post(POST_D, { target_player_ids: [SUBJECT_ID] }),
    ];
    tables.social_post_likes = [
      { post_id: POST_A, player_id: SUBJECT_ID, reaction_type: 'like', reacted_as: 'personal' },
      { post_id: POST_B, player_id: ADMIN_ID, reaction_type: 'like', reacted_as: 'personal' },
    ];
    tables.social_post_flags = [];
    tables.sim_direct_messages = [
      {
        id: 'm1',
        thread_id: 't1',
        session_id: SESSION,
        sender_handle: '@ada_lovelace',
        recipient_handle: '@friend',
        sender_display_name: 'Friend',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'm2',
        thread_id: 't2',
        session_id: SESSION,
        sender_handle: '@grace_hopper',
        recipient_handle: '@other',
        sender_display_name: 'Other',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:00:01Z',
      },
      {
        id: 'm3',
        thread_id: 't3',
        session_id: SESSION,
        sender_handle: '@fan',
        recipient_handle: '@comms',
        sender_display_name: 'Fan',
        platform: 'facebook',
        is_read: false,
        created_at: '2026-01-01T00:00:02Z',
      },
    ];
    tables.session_page_controllers = [
      { session_id: SESSION, user_id: SUBJECT_ID, org_key: 'comms' },
    ];
    tables.sim_org_pages = [
      {
        session_id: SESSION,
        org_key: 'comms',
        platform: 'facebook',
        page_handle: '@comms',
        page_name: 'Comms',
      },
    ];
    const db = install(tables, { users });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/social/messenger', routers.messenger);
      app.use('/api/social', routers.social);
      const headers = {
        authorization: 'Bearer admin-token',
        'x-sim-session': SESSION,
        'x-sim-view-as': SUBJECT_ID,
      };
      await withApp(app, async (base) => {
        setFlags(false, false);
        const asStaff = await hit(base, 'GET', `/api/social/posts/session/${SESSION}`, headers);
        assert.equal(asStaff.status, 200);
        const staffPosts = (asStaff.json as { data: Array<{ id: string; liked_by_me: boolean }> })
          .data;
        assert.equal(staffPosts.find((post) => post.id === POST_B)?.liked_by_me, true);
        assert.equal(staffPosts.find((post) => post.id === POST_A)?.liked_by_me, false);
        assert.ok(staffPosts.some((post) => post.id === POST_C));

        const staffThreads = await hit(
          base,
          'GET',
          `/api/social/messenger/threads/${SESSION}`,
          headers,
        );
        const staffIds = (
          (staffThreads.json as { data: Array<{ thread_id: string }> }).data ?? []
        ).map((thread) => thread.thread_id);
        assert.equal(staffIds.includes('t1'), false);

        setFlags(true, false);
        const asSubject = await hit(base, 'GET', `/api/social/posts/session/${SESSION}`, headers);
        assert.equal(asSubject.status, 200);
        const subjectPosts = (
          asSubject.json as { data: Array<{ id: string; liked_by_me: boolean }> }
        ).data;
        assert.equal(subjectPosts.find((post) => post.id === POST_A)?.liked_by_me, true);
        assert.equal(subjectPosts.find((post) => post.id === POST_B)?.liked_by_me, false);
        assert.equal(
          subjectPosts.some((post) => post.id === POST_C),
          false,
        );
        assert.ok(subjectPosts.some((post) => post.id === POST_D));

        const subjectThreads = await hit(
          base,
          'GET',
          `/api/social/messenger/threads/${SESSION}`,
          headers,
        );
        const subjectIds = (
          (subjectThreads.json as { data: Array<{ thread_id: string }> }).data ?? []
        ).map((thread) => thread.thread_id);
        assert.ok(subjectIds.includes('t1'));
        assert.equal(subjectIds.includes('t2'), false);
        assert.ok(subjectIds.includes('t3'));
      });
      assert.equal(
        db.calls.some((call) => call.table === 'staff_view_audit'),
        true,
      );
    } finally {
      db.restore();
    }
  });

  test('concluded-session freeze still returns 409 with the viewer mounted', async () => {
    const routers = await loadRouters();
    const users = new Map<string, Record<string, unknown>>([
      ['player-token', tokenUser(SUBJECT_ID, 'player')],
    ]);
    const tables = baseTables();
    (tables.sessions[0] as Row).status = 'completed';
    const db = install(tables, { users });
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/social', routers.social);
      await withApp(app, async (base) => {
        for (const flags of [
          [false, false],
          [true, true],
        ] as const) {
          setFlags(flags[0], flags[1]);
          const res = await hit(
            base,
            'POST',
            '/api/social/posts',
            { authorization: 'Bearer player-token' },
            { session_id: SESSION, content: 'after the end' },
          );
          assert.equal(res.status, 409);
          assert.equal(res.json.code, SESSION_CONCLUDED_CODE);
        }
      });
      assert.equal(
        db.calls.some((call) => call.table === 'social_posts' && call.op === 'insert'),
        false,
      );
    } finally {
      db.restore();
    }
  });
});

describe('voice spectator gate', { concurrency: false }, () => {
  beforeEach(() => {
    setFlags(false, false);
  });

  afterEach(() => {
    setFlags(false, false);
  });

  function fakeSocket(userId: string) {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const handlers = new Map<string, (payload: unknown) => void>();
    const socket = {
      userId,
      userRole: 'player',
      on(event: string, cb: (payload: unknown) => void) {
        handlers.set(event, cb);
      },
      emit() {},
    };
    const io = {
      on(_event: string, fn: (value: typeof socket) => void) {
        fn(socket);
      },
      to() {
        return {
          emit(event: string, payload: unknown) {
            emitted.push({ event, payload });
          },
        };
      },
    };
    registerVoiceSignaling(io as unknown as Parameters<typeof registerVoiceSignaling>[0]);
    return { handlers, emitted };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('flags off still delivers voice events from a non-participant', async () => {
    const db = install(baseTables());
    try {
      const { handlers, emitted } = fakeSocket('user-1');
      handlers.get('voice:initiate')?.({
        sessionId: SESSION,
        callId: 'call-off',
        targetUserIds: ['user-2'],
      });
      await settle();
      assert.ok(db.calls.some((call) => call.table === 'voice_calls' && call.op === 'insert'));
      assert.equal(
        db.calls.some((call) => call.table === 'session_participants'),
        false,
      );
      handlers.get('voice:offer')?.({
        callId: 'call-never',
        to: 'user-2',
        sdp: { type: 'offer', sdp: 'x' },
      });
      await settle();
      assert.ok(emitted.some((event) => event.event === 'voice:offer'));
    } finally {
      db.restore();
    }
  });

  test('flags on ignores voice from someone who is not in the session or the call', async () => {
    const db = install(baseTables());
    try {
      setFlags(true, false);
      const outsiderSocket = fakeSocket('user-outsider');
      outsiderSocket.handlers.get('voice:initiate')?.({
        sessionId: SESSION,
        callId: 'call-blocked',
        targetUserIds: ['user-2'],
      });
      await settle();
      assert.equal(
        db.calls.some((call) => call.table === 'voice_calls' && call.op === 'insert'),
        false,
      );

      const playerSocket = fakeSocket(SUBJECT_ID);
      playerSocket.handlers.get('voice:initiate')?.({
        sessionId: SESSION,
        callId: 'call-live',
        targetUserIds: [SUBJECT_ID],
      });
      await settle();
      assert.ok(db.calls.some((call) => call.table === 'voice_calls' && call.op === 'insert'));

      outsiderSocket.handlers.get('voice:offer')?.({
        callId: 'call-live',
        to: SUBJECT_ID,
        sdp: { type: 'offer', sdp: 'x' },
      });
      await settle();
      assert.equal(
        outsiderSocket.emitted.some((event) => event.event === 'voice:offer'),
        false,
      );

      playerSocket.handlers.get('voice:offer')?.({
        callId: 'call-live',
        to: SUBJECT_ID,
        sdp: { type: 'offer', sdp: 'x' },
      });
      await settle();
      assert.ok(playerSocket.emitted.some((event) => event.event === 'voice:offer'));
    } finally {
      db.restore();
    }
  });
});
