import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { RemapPlan } from '../services/setupEdits/remapPlanner.js';
import { createScenarioSetupEditsRouter } from './scenarioSetupEdits.js';

const SCENARIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EDIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRAINER = { id: '11111111-1111-4111-8111-111111111111', role: 'trainer' };

const plan = {
  teams: { retire: [], successors: [] },
  injects: { rewrite_in_place: [], cow: [], retire: [] },
  initial_state: { patch: [], move_to_retired: [] },
  scheduled_sessions: [],
  orphans: [],
  warnings: [],
  applicable: true,
  phases: [],
  primary_swap: null,
  vacated_countries: [],
} as RemapPlan;

describe('setup edit plan route', { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let enabled = true;
  let category: string | null = 'social_media_crisis';
  let editable = true;
  let calls: Array<{ resolutions?: unknown; draftInput?: unknown }> = [];
  let outcome: 'plan' | 'empty' | 'no_draft' = 'plan';

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/scenarios/:id/setup-edits',
      createScenarioSetupEditsRouter({
        enabled: () => enabled,
        limit: () => 3,
        authMiddleware: (req, _res, next) => {
          const role = String(req.headers['x-role'] || 'trainer');
          if (role === 'anon') {
            next();
            return;
          }
          (req as AuthenticatedRequest).user = {
            id: TRAINER.id,
            role,
          };
          next();
        },
        assertOwner: async () =>
          String(category) === 'foreign'
            ? { ok: false, status: 403, error: 'Only the scenario creator can modify this scenario' }
            : { ok: true },
        loadCategory: async () => category,
        canEdit: async () =>
          editable
            ? { editable: true, reason: 'ok', session_credits: 1, live_session_id: null }
            : { editable: false, reason: 'live_session', session_credits: 1, live_session_id: 'live' },
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
        apply: async () => ({ ok: false, status: 404, code: 'NOT_FOUND', error: 'Setup edit not found' }),
        plan: async (request) => {
          calls.push({ resolutions: request.resolutions, draftInput: request.draftInput });
          if (outcome === 'empty') {
            return {
              ok: false,
              status: 400,
              code: 'SETUP_EDIT_EMPTY',
              error: 'This edit does not change the setup.',
            };
          }
          if (outcome === 'no_draft') {
            return {
              ok: false,
              status: 409,
              code: 'SETUP_EDIT_NO_DRAFT',
              error: 'This edit has no draft. Abandon it and start again.',
            };
          }
          return {
            ok: true,
            plan,
            targets: { teams: ['Legal'], inject_keys: ['plant_update'], org_keys: ['primary'] },
          };
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

  function reset(): void {
    enabled = true;
    category = 'social_media_crisis';
    editable = true;
    calls = [];
    outcome = 'plan';
  }

  async function post(body: unknown, role = 'trainer') {
    const res = await fetch(`${base}/api/scenarios/${SCENARIO}/setup-edits/${EDIT}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-role': role },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test('returns the dry-run plan and the resolutions it was given', async () => {
    reset();
    const res = await post({
      resolutions: { 'role:cs_head': { choice: 'reassign', team_name: 'Legal' } },
      draft_input: { context: 'Dawn shift' },
    });
    assert.equal(res.status, 200);
    assert.equal((res.json.plan as { applicable: boolean }).applicable, true);
    assert.equal(
      (calls[0]?.resolutions as { 'role:cs_head': { team_name: string } })['role:cs_head'].team_name,
      'Legal',
    );
    assert.deepEqual(calls[0]?.draftInput, { context: 'Dawn shift' });
  });

  test('an unchanged draft is an empty edit', async () => {
    reset();
    outcome = 'empty';
    const res = await post({});
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'SETUP_EDIT_EMPTY');
  });

  test('an open edit with no draft tells the trainer to start again', async () => {
    reset();
    outcome = 'no_draft';
    const res = await post({});
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'SETUP_EDIT_NO_DRAFT');
  });

  test('the flag off, a player, a live session and another category do not plan', async () => {
    reset();
    enabled = false;
    assert.equal((await post({})).status, 404);
    reset();
    assert.equal((await post({}, 'participant')).status, 403);
    reset();
    editable = false;
    assert.equal((await post({})).json.code, 'SCENARIO_LOCKED');
    reset();
    category = 'terrorism';
    assert.equal((await post({})).json.code, 'SETUP_EDIT_UNAVAILABLE');
    assert.equal(calls.length, 0);
  });
});
