import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { initialStageStates, toView } from '../services/warroomBuild/buildCore.js';
import { BuildServiceError } from '../services/warroomBuild/buildErrors.js';
import { buildRequestSchema, type BuildRow } from '../services/warroomBuild/buildTypes.js';
import {
  createWarroomBuildsRouter,
  type DraftRecord,
  type WarroomBuildApi,
} from './warroomBuilds.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

const TRAINER = { id: 'trainer-1', role: 'trainer' };
const OTHER = { id: 'trainer-2', role: 'trainer' };
const ADMIN = { id: 'admin-1', role: 'admin' };
const PLAYER = { id: 'player-1', role: 'participant' };

function row(patch: Partial<BuildRow> = {}): BuildRow {
  const request = buildRequestSchema.parse({
    crisis_type: 'Plant fire',
    organisations: [
      {
        display_name: 'Meridian',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }, { team_name: 'Legal' }],
      },
    ],
  });
  return {
    id: '11111111-1111-4111-8111-111111111111',
    draft_id: '22222222-2222-4222-8222-222222222222',
    created_by: TRAINER.id,
    pool: 'test',
    status: 'failed',
    current_stage: 'storyline',
    stage_states: initialStageStates(),
    request,
    request_hash: 'hash',
    idempotency_key: '33333333-3333-4333-8333-333333333333',
    error: 'The Storyline stage failed',
    error_code: 'stage_failed',
    cancel_requested_at: null,
    cancel_reason: null,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    interruptions: 0,
    last_seen_at: '2026-01-01T00:00:00.000Z',
    log_count: 2,
    compile_status: null,
    compile_heartbeat_at: null,
    credit_ledger_id: null,
    credit_invoice_id: null,
    scenario_id: null,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:10:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:10:00.000Z',
    ...patch,
  };
}

describe('warroom build routes', () => {
  let server: Server;
  let base: string;
  let sawBadStart = false;
  const builds = new Map<string, BuildRow>();
  const draft: DraftRecord = { id: '22222222-2222-4222-8222-222222222222', created_by: TRAINER.id };

  const service: WarroomBuildApi = {
    async start(input) {
      if (input.request.crisis_type === 'Bad orgs') sawBadStart = true;
      if (input.idempotencyKey === '33333333-3333-4333-8333-333333333333') {
        return { buildId: row().id, outcome: 'replayed' };
      }
      if (input.request.crisis_type === 'Conflict') {
        return { buildId: row().id, outcome: 'conflict' };
      }
      if (input.request.crisis_type === 'Limited') {
        return { buildId: null, outcome: 'limit' };
      }
      const created = row({
        status: 'queued',
        idempotency_key: input.idempotencyKey,
        request: input.request,
      });
      builds.set(created.id, created);
      return { buildId: created.id, outcome: 'created' };
    },
    async get(id, after = 0) {
      const found = builds.get(id);
      if (!found) return null;
      const log = [
        {
          seq: 1,
          stage: 'characters',
          kind: 'stage',
          message: 'Characters started',
          at: found.created_at,
        },
        {
          seq: 4,
          stage: 'storyline',
          kind: 'progress',
          message: 'Legal storyline ready (15 injects)',
          at: found.created_at,
        },
      ].filter((line) => line.seq > after);
      return { build: toView(found), log, next_after: log.at(-1)?.seq ?? after };
    },
    async getRow(id) {
      return builds.get(id) ?? null;
    },
    async latestForDraft() {
      return builds.get(row().id) ?? null;
    },
    async review() {
      throw new BuildServiceError('Build is not finished', 'BUILD_NOT_DONE');
    },
    async resume(id) {
      return builds.get(id) ?? row();
    },
    async cancel(id) {
      return builds.get(id) ?? null;
    },
  };

  before(async () => {
    builds.set(row().id, row());
    const app = express();
    app.use(express.json());
    app.use(
      '/api/warroom/social-crisis/builds',
      createWarroomBuildsRouter({
        enabled: (req) => req?.headers['x-durable'] !== 'off',
        authMiddleware: (req, _res, next) => {
          const headerUser = req.headers['x-user'];
          const headerRole = req.headers['x-role'];
          (req as AuthenticatedRequest).user = {
            id: typeof headerUser === 'string' ? headerUser : TRAINER.id,
            role: typeof headerRole === 'string' ? headerRole : 'trainer',
          };
          next();
        },
        credit: async (req, res) => {
          const user = req.user!;
          if (user.role !== 'trainer' && user.role !== 'admin') {
            res.status(403).json({ error: 'Only trainers can use the War Room' });
            return false;
          }
          if (req.headers['x-credit'] === 'no' && user.role !== 'admin') {
            res.status(402).json({
              error:
                'No scenario credits. Invoice a client from Clients & billing to unlock the War Room.',
              code: 'NO_SCENARIO_CREDITS',
            });
            return false;
          }
          return true;
        },
        service,
        loadDraft: async () => draft,
        organisationsOk: (request) =>
          request.crisis_type === 'Bad orgs'
            ? {
                ok: false,
                message: 'Unknown country',
                code: 'MO-COUNTRY',
                details: [{ org: 'Meridian' }],
              }
            : { ok: true },
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, json: await res.json() };
  }

  const validBody = () => ({
    draft_id: draft.id,
    idempotency_key: '44444444-4444-4444-8444-444444444444',
    request: row().request,
    replace_active: false,
  });

  test('501 when durable builds are off', async () => {
    const res = await get(`/api/warroom/social-crisis/builds/${row().id}`, { 'x-durable': 'off' });
    assert.equal(res.status, 501);
    assert.equal(res.json.code, 'DURABLE_BUILDS_UNAVAILABLE');
  });

  test('403 for a non-trainer and 402 with no credit', async () => {
    const denied = await post('/api/warroom/social-crisis/builds', validBody(), {
      'x-role': PLAYER.role,
      'x-user': PLAYER.id,
    });
    assert.equal(denied.status, 403);
    const unpaid = await post('/api/warroom/social-crisis/builds', validBody(), {
      'x-credit': 'no',
    });
    assert.equal(unpaid.status, 402);
    assert.equal(unpaid.json.code, 'NO_SCENARIO_CREDITS');
  });

  test('400 for invalid organisations writes nothing', async () => {
    const res = await post('/api/warroom/social-crisis/builds', {
      ...validBody(),
      request: { ...row().request, crisis_type: 'Bad orgs' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'MO-COUNTRY');
    assert.equal(sawBadStart, false);
  });

  test('409 when a build is active and 429 at the limit', async () => {
    const conflict = await post('/api/warroom/social-crisis/builds', {
      ...validBody(),
      idempotency_key: '55555555-5555-4555-8555-555555555555',
      request: { ...row().request, crisis_type: 'Conflict' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'BUILD_ACTIVE');
    assert.equal(conflict.json.build_id, row().id);
    const limited = await post('/api/warroom/social-crisis/builds', {
      ...validBody(),
      idempotency_key: '66666666-6666-4666-8666-666666666666',
      request: { ...row().request, crisis_type: 'Limited' },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'BUILD_LIMIT');
  });

  test('404 for a missing build and 403 for someone else', async () => {
    const missing = await get(
      '/api/warroom/social-crisis/builds/99999999-9999-4999-8999-999999999999',
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'BUILD_NOT_FOUND');
    const denied = await get(`/api/warroom/social-crisis/builds/${row().id}?after=0`, {
      'x-role': OTHER.role,
      'x-user': OTHER.id,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'Access denied');
    const allowed = await get(`/api/warroom/social-crisis/builds/${row().id}?after=0`, {
      'x-role': ADMIN.role,
      'x-user': ADMIN.id,
    });
    assert.equal(allowed.status, 200);
  });

  test('polling does not require a scenario credit', async () => {
    const unpaid = await get(`/api/warroom/social-crisis/builds/${row().id}?after=0`, {
      'x-credit': 'no',
    });
    assert.equal(unpaid.status, 200);
    const participant = await get(`/api/warroom/social-crisis/builds/${row().id}?after=0`, {
      'x-role': PLAYER.role,
      'x-user': PLAYER.id,
    });
    assert.equal(participant.status, 403);
    assert.equal(participant.json.error, 'Only trainers can use the War Room');
  });

  test('GET after returns only later log lines', async () => {
    const res = await get(`/api/warroom/social-crisis/builds/${row().id}?after=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.data.log.map((line: { seq: number }) => line.seq),
      [4],
    );
    assert.equal(res.json.data.next_after, 4);
  });

  test('review is 409 before the build is done', async () => {
    const res = await get(`/api/warroom/social-crisis/builds/${row().id}/review`);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'BUILD_NOT_DONE');
  });

  test('the same idempotency key is replayed with 200', async () => {
    const res = await post('/api/warroom/social-crisis/builds', {
      ...validBody(),
      idempotency_key: '33333333-3333-4333-8333-333333333333',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.outcome, 'replayed');
  });
});
