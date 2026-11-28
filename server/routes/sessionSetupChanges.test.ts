import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AppliedSetupChange } from '../services/setupEdits/setupEditService.js';
import { createSessionSetupChangesRouter } from './sessionSetupChanges.js';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('session setup changes route', { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let enabled = true;
  let access: 'ok' | 'missing' = 'ok';
  let owner: 'ok' | 'forbidden' = 'ok';
  let available = true;
  const createdAt = '2026-06-01T00:00:00.000Z';
  let asked: { scenarioId: string; createdAt: string } | null = null;
  const changes: AppliedSetupChange[] = [
    {
      id: 'edit-1',
      applied_at: '2026-06-02T00:00:00.000Z',
      edit_number: 1,
      opened_by_admin: false,
      opened_by_name: 'Amina',
      summary: { teams_added: 1, teams_retired: 2, teams_succeeded: 1, unassigned_players: 3 },
    },
  ];

  before(async () => {
    const app = express();
    app.use(
      '/api/sessions',
      createSessionSetupChangesRouter({
        enabled: () => enabled,
        authMiddleware: (req, _res, next) => {
          if (req.headers['x-role'] === 'anon') {
            next();
            return;
          }
          (req as AuthenticatedRequest).user = { id: 'trainer-1', role: 'trainer' };
          next();
        },
        loadSession: async () => {
          if (access === 'missing') return null;
          return { scenario_id: 'scenario-1', created_at: createdAt };
        },
        assertOwner: async () =>
          owner === 'forbidden'
            ? { ok: false, status: 403, error: 'Only the scenario creator can modify this scenario' }
            : { ok: true },
        listChanges: async (scenarioId, at) => {
          asked = { scenarioId, createdAt: at };
          return { available, changes: available ? changes : [] };
        },
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function get() {
    const res = await fetch(`${base}/api/sessions/${SESSION}/setup-changes`, {
      headers: { 'x-role': 'trainer' },
    });
    return { status: res.status, json: (await res.json()) as { changes?: AppliedSetupChange[]; error?: string } };
  }

  test('returns applied edits newer than the session', async () => {
    enabled = true;
    access = 'ok';
    available = true;
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.json.changes?.length, 1);
    assert.equal(res.json.changes?.[0].edit_number, 1);
    assert.equal(asked?.scenarioId, 'scenario-1');
    assert.equal(asked?.createdAt, createdAt);
  });

  test('a missing migration answers an empty list', async () => {
    available = false;
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.changes, []);
    available = true;
  });

  test('the flag off answers an empty list without reading edits', async () => {
    enabled = false;
    asked = null;
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.changes, []);
    assert.equal(asked, null);
    enabled = true;
  });

  test('a missing session, a non-owner and a signed-out caller are refused', async () => {
    access = 'missing';
    assert.equal((await get()).status, 404);
    access = 'ok';
    owner = 'forbidden';
    assert.equal((await get()).status, 403);
    owner = 'ok';
    const anon = await fetch(`${base}/api/sessions/${SESSION}/setup-changes`, { headers: { 'x-role': 'anon' } });
    assert.equal(anon.status, 401);
  });
});
