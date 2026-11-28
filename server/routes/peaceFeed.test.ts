import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { validPeaceFeed } from '../services/generation/peaceFeedFixture.js';
import type { GeneratePeaceFeedResult } from '../services/generation/peaceFeedService.js';
import { createPeaceFeedRouter, type PeaceScenarioRow } from './peaceFeed.js';

const TRAINER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SOCIAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIELD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('peace feed route', { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let enabled = true;
  let generateCalls = 0;
  let loadCalls = 0;
  const rows = new Map<string, PeaceScenarioRow & { ownerId: string; locked: boolean }>();

  function seed(): void {
    generateCalls = 0;
    loadCalls = 0;
    enabled = true;
    rows.clear();
    rows.set(SOCIAL, {
      ownerId: TRAINER,
      category: 'social_media_crisis',
      initial_state: { npc_personas: [], org_page: null, description: 'A recall' },
      locked: false,
    });
    rows.set(FIELD, {
      ownerId: TRAINER,
      category: 'field_ops',
      initial_state: {},
      locked: false,
    });
  }

  async function call(
    method: string,
    id: string,
    user = TRAINER,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/scenarios/${id}/peace-feed`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-user': user,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  before(async () => {
    seed();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/scenarios/:id/peace-feed',
      createPeaceFeedRouter({
        periodEnabled: () => enabled,
        authMiddleware: (req, _res, next) => {
          const headerUser = req.headers['x-user'];
          (req as AuthenticatedRequest).user = {
            id: typeof headerUser === 'string' ? headerUser : TRAINER,
            role: 'trainer',
          };
          next();
        },
        assertOwner: async (scenarioId, user) => {
          const row = rows.get(scenarioId);
          if (!row) return { ok: false, status: 404, error: 'Scenario not found' };
          if (user.role === 'admin' || row.ownerId === user.id) return { ok: true };
          return { ok: false, status: 403, error: 'Only the scenario creator can modify this scenario' };
        },
        canEdit: async (scenarioId) => {
          const row = rows.get(scenarioId);
          if (row?.locked) {
            return {
              editable: false,
              reason: 'live_session',
              session_credits: 1,
              live_session_id: 'live',
            };
          }
          return { editable: true, reason: 'ok', session_credits: 1, live_session_id: null };
        },
        loadScenario: async (scenarioId) => {
          loadCalls += 1;
          const row = rows.get(scenarioId);
          return row ? { category: row.category, initial_state: row.initial_state } : null;
        },
        savePeacePeriod: async (scenarioId, peace) => {
          const row = rows.get(scenarioId);
          if (!row) throw new Error('missing');
          row.initial_state = { ...(row.initial_state ?? {}), peace_period: peace };
        },
        generate: async (): Promise<GeneratePeaceFeedResult> => {
          generateCalls += 1;
          return { ok: true, feed: validPeaceFeed(), attempts: 1, dropped: 0 };
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

  test('the flag off answers 404 and does not generate', async () => {
    seed();
    enabled = false;
    const listed = await call('GET', SOCIAL);
    const generated = await call('POST', SOCIAL);
    const patched = await call('PATCH', SOCIAL, TRAINER, { enabled: false });
    assert.equal(listed.status, 404);
    assert.equal(listed.json.code, 'PEACE_PERIOD_UNAVAILABLE');
    assert.equal(generated.status, 404);
    assert.equal(patched.status, 404);
    assert.equal(generateCalls, 0);
    assert.equal(loadCalls, 0);
  });

  test('a trainer generates a feed and can turn it off', async () => {
    seed();
    const generated = await call('POST', SOCIAL);
    assert.equal(generated.status, 200);
    assert.equal(generateCalls, 1);
    const body = generated.json.data as { generated: boolean; peace_period: { posts: unknown[] } };
    assert.equal(body.generated, true);
    assert.equal(body.peace_period.posts.length, 12);
    const patched = await call('PATCH', SOCIAL, TRAINER, { seconds: 600, enabled: false });
    assert.equal(patched.status, 200);
    const saved = patched.json.data as { peace_period: { seconds: number; enabled: boolean } };
    assert.equal(saved.peace_period.seconds, 600);
    assert.equal(saved.peace_period.enabled, false);
    const listed = await call('GET', SOCIAL);
    assert.equal(listed.status, 200);
    assert.equal((listed.json.data as { peace_period: { enabled: boolean } }).peace_period.enabled, false);
  });

  test('someone else cannot generate, and a field scenario has no route', async () => {
    seed();
    const foreign = await call('POST', SOCIAL, OTHER);
    assert.equal(foreign.status, 403);
    assert.equal(generateCalls, 0);
    const field = await call('GET', FIELD);
    assert.equal(field.status, 404);
    assert.equal(field.json.code, 'PEACE_PERIOD_UNAVAILABLE');
  });
});
