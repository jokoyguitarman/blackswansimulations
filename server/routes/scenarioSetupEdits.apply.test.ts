import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  applySetupEdit,
  type ApplyDeps,
  type ApplySetupEditRequest,
  type PreparedApply,
} from '../services/setupEdits/applySetupEdit.js';
import { applyInput, emptyPlan } from '../services/setupEdits/fixtures/applyWorld.js';
import { createScenarioSetupEditsRouter } from './scenarioSetupEdits.js';
import type { ApplyBundle } from '../services/setupEdits/setupMergeCore.js';

const SCENARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRAINER = { id: '11111111-1111-4111-8111-111111111111', role: 'trainer' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', role: 'admin' };

type Mode = 'live' | 'stale' | 'limit' | 'applied' | 'orphans';

describe('setup edit apply route', { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let mode: Mode = 'applied';
  let prepares = 0;
  let rpcCalls: Array<{ isAdmin: boolean; bundle: ApplyBundle }> = [];
  let consumed = 0;
  let refunded = 0;
  let released = 0;
  let reseeded: string[] = [];
  let used = 0;
  let charge = false;

  function prepared(): PreparedApply {
    const input = applyInput();
    if (mode === 'orphans') {
      input.plan = emptyPlan({
        applicable: false,
        orphans: [
          {
            id: 'role:cs_head',
            kind: 'player_role',
            message: 'Needs a decision',
            choices: ['keep'],
            role_id: 'cs_head',
          },
        ],
      });
    }
    return { ok: true, input, sessions: [{ id: 'sess-1', reseed: true, unassigned_players: [] }], title: 'Warehouse fire' };
  }

  const deps: ApplyDeps = {
    async prepare() {
      prepares += 1;
      return prepared();
    },
    async claim() {
      return 'claimed';
    },
    async heartbeat() {},
    async release() {
      released += 1;
    },
    async md5() {
      return `md5-${prepares}`;
    },
    async rpc(args) {
      rpcCalls.push({ isAdmin: args.isAdmin, bundle: args.bundle });
      if (mode === 'live') return { result: 'live_session', error: null };
      if (mode === 'stale') return { result: 'stale', error: null };
      if (mode === 'limit') return { result: 'limit_reached', error: null };
      used = args.isAdmin ? 0 : 1;
      return { result: 'applied', error: null };
    },
    async reseed(sessionId) {
      reseeded.push(sessionId);
    },
    async used() {
      return used;
    },
    limit: () => 3,
    chargesCredit: () => charge,
    async consume() {
      consumed += 1;
      return { ok: true, ledgerId: 'ledger-1', fundingInvoiceId: 'invoice-1' };
    },
    async refund() {
      refunded += 1;
    },
    now: () => new Date('2026-06-01T00:00:00.000Z'),
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/scenarios/:id/setup-edits',
      createScenarioSetupEditsRouter({
        enabled: () => true,
        limit: () => 3,
        authMiddleware: (req, _res, next) => {
          (req as AuthenticatedRequest).user = {
            id: String(req.headers['x-user'] || TRAINER.id),
            role: String(req.headers['x-role'] || 'trainer'),
          };
          next();
        },
        assertOwner: async () => ({ ok: true }),
        loadCategory: async () => 'social_media_crisis',
        canEdit: async (_id, user) =>
          user.role === 'blocked'
            ? { editable: false, reason: 'live_session', session_credits: 1, live_session_id: 'live' }
            : { editable: true, reason: 'ok', session_credits: 1, live_session_id: null },
        service: {
          async get() {
            return { available: true, found: false };
          },
          async open() {
            return { available: true, outcome: 'not_found', editId: null };
          },
          async abandon() {
            return { available: true, outcome: 'not_found' };
          },
          async attachOpenedDraft() {
            return { available: true, ok: false, reason: 'not_found' };
          },
        },
        apply: (request: ApplySetupEditRequest) => applySetupEdit(request, deps),
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function reset(next: Mode): void {
    mode = next;
    prepares = 0;
    rpcCalls = [];
    consumed = 0;
    refunded = 0;
    released = 0;
    reseeded = [];
    used = 0;
    charge = false;
  }

  async function apply(user = TRAINER) {
    const res = await fetch(`${base}/api/scenarios/${SCENARIO}/setup-edits/${EDIT}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user.id, 'x-role': user.role },
      body: JSON.stringify({ build_id: BUILD, orphan_decisions: {} }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test('a live session is locked and does not reseed', async () => {
    reset('live');
    const res = await apply();
    assert.equal(res.status, 423);
    assert.equal(res.json.code, 'SCENARIO_LOCKED');
    assert.equal(reseeded.length, 0);
    assert.equal(released, 1);
  });

  test('stale is recomputed once and then refused', async () => {
    reset('stale');
    const res = await apply();
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'SETUP_EDIT_STALE');
    assert.equal(prepares, 2);
    assert.equal(rpcCalls.length, 2);
    assert.equal(reseeded.length, 0);
  });

  test('the allowance rejects a trainer at the limit', async () => {
    reset('limit');
    const res = await apply();
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'SETUP_EDIT_LIMIT');
    assert.equal(rpcCalls[0]?.isAdmin, false);
  });

  test('an admin apply is uncounted', async () => {
    reset('applied');
    const res = await apply(ADMIN);
    assert.equal(res.status, 200);
    assert.equal(res.json.remaining, null);
    assert.equal(rpcCalls[0]?.isAdmin, true);
    assert.equal(used, 0);
    assert.deepEqual(reseeded, ['sess-1']);
    assert.equal(consumed, 0);
  });

  test('unresolved orphans write nothing', async () => {
    reset('orphans');
    const res = await apply();
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'ORPHANS_UNRESOLVED');
    assert.equal(rpcCalls.length, 0);
    assert.equal(reseeded.length, 0);
  });

  test('a failed apply refunds a charged credit', async () => {
    reset('limit');
    charge = true;
    const res = await apply();
    assert.equal(res.status, 403);
    assert.equal(consumed, 1);
    assert.equal(refunded, 1);
  });
});
