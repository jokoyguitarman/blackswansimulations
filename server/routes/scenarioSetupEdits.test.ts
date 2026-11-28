import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { canonicalJson } from '../../shared/canonicalJson.js';
import { stampOrgIdentity } from '../lib/templateRows.js';
import {
  EMPTY_SETUP_BASELINE,
  emptySetupBaselineHash,
  type AbandonSetupEditResult,
  type OpenSetupEditResult,
  type SetupEditSnapshot,
  type SetupEditSummary,
} from '../services/setupEdits/setupEditCore.js';
import {
  baselineHash,
  draftInputFromSnapshot,
  snapshotFromScenario,
  type ScenarioSnapshotSource,
  type SetupSnapshot,
} from '../services/setupEdits/setupSnapshotCore.js';
import { createScenarioSetupEditsRouter, type SetupEditApi } from './scenarioSetupEdits.js';

const TRAINER = { id: '11111111-1111-4111-8111-111111111111', role: 'trainer' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const OTHER = { id: '33333333-3333-4333-8333-333333333333', role: 'trainer' };
const PLAYER = { id: '44444444-4444-4444-8444-444444444444', role: 'participant' };

const SOCIAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIMITED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FIELD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LIVE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const BROKE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NO_CREDIT = '99999999-9999-4999-8999-999999999999';

interface FakeEdit {
  id: string;
  scenarioId: string;
  openedBy: string;
  openedByAdmin: boolean;
  status: 'open' | 'applying' | 'applied' | 'abandoned' | 'failed';
  counted: boolean;
  baseline: Record<string, unknown>;
  baselineHash: string;
  draftId: string | null;
  createdAt: string;
}

interface FakeDraft {
  id: string;
  scenarioId: string;
  createdBy: string;
  currentStep: number;
  input: Record<string, unknown>;
}

interface FakeScenario {
  ownerId: string;
  category: string;
  used: number;
  live: boolean;
  credits: boolean;
}

describe('scenario setup edit routes', { concurrency: false }, () => {
  let server: Server;
  let base: string;
  let enabled = true;
  let openCalls = 0;
  let seq = 0;
  let identityConflict = false;
  const scenarios = new Map<string, FakeScenario>();
  const edits: FakeEdit[] = [];
  const drafts: FakeDraft[] = [];
  const sources = new Map<string, ScenarioSnapshotSource>();

  function seed(): void {
    enabled = true;
    openCalls = 0;
    seq = 0;
    identityConflict = false;
    edits.length = 0;
    drafts.length = 0;
    scenarios.clear();
    sources.clear();
    scenarios.set(SOCIAL, {
      ownerId: TRAINER.id,
      category: 'social_media_crisis',
      used: 0,
      live: false,
      credits: true,
    });
    scenarios.set(LIMITED, {
      ownerId: TRAINER.id,
      category: 'social_media_crisis',
      used: 3,
      live: false,
      credits: true,
    });
    scenarios.set(FOREIGN, {
      ownerId: OTHER.id,
      category: 'social_media_crisis',
      used: 0,
      live: false,
      credits: true,
    });
    scenarios.set(FIELD, {
      ownerId: TRAINER.id,
      category: 'terrorism',
      used: 0,
      live: false,
      credits: true,
    });
    scenarios.set(LIVE, {
      ownerId: TRAINER.id,
      category: 'social_media_crisis',
      used: 0,
      live: true,
      credits: true,
    });
    scenarios.set(BROKE, {
      ownerId: TRAINER.id,
      category: 'social_media_crisis',
      used: 0,
      live: false,
      credits: true,
    });
    scenarios.set(NO_CREDIT, {
      ownerId: TRAINER.id,
      category: 'social_media_crisis',
      used: 0,
      live: false,
      credits: false,
    });
    for (const id of scenarios.keys()) sources.set(id, defaultSource());
  }

  function defaultSource(): ScenarioSnapshotSource {
    return {
      scenario: {
        description: 'Plant fire',
        briefing: 'The warehouse is burning',
        duration_minutes: 60,
        initial_state: {
          org_name: 'Acme',
          country: 'Singapore',
          setup_source: {
            crisis_type: 'Plant fire',
            context: 'Night shift',
            uploaded_doc_name: null,
            uploaded_doc_text_hash: null,
            country: 'Singapore',
            org_name: 'Acme',
            duration: 60,
            auto_antagonist: true,
          },
          orgs: [
            {
              org_key: 'primary',
              org_uid: 'uid-acme',
              display_name: 'Acme',
              short_name: 'ACME',
              country: 'Singapore',
              side: 'protagonist',
              is_primary: true,
              operation: 'players',
            },
          ],
        },
      },
      teams: [
        {
          id: 't1',
          team_uid: 'uid-comms',
          team_name: 'Communications',
          org_key: 'primary',
          function_key: 'Communications',
          team_description: 'Talk',
        },
        {
          id: 't2',
          team_uid: 'uid-legal',
          team_name: 'Legal',
          org_key: 'primary',
          function_key: 'Legal',
          team_description: 'Advise',
        },
      ],
      injects: [{ id: 'inj1', delivery_config: { inject_key: 'plant_fire' } }],
    };
  }

  function summary(edit: FakeEdit): SetupEditSummary {
    return {
      id: edit.id,
      status: edit.status,
      opened_by: edit.openedBy,
      opened_by_admin: edit.openedByAdmin,
      edit_number: null,
      counted: edit.counted,
      error: null,
      created_at: edit.createdAt,
      applied_at: null,
    };
  }

  function inflight(scenarioId: string): FakeEdit | undefined {
    return edits.find(
      (edit) =>
        edit.scenarioId === scenarioId && (edit.status === 'open' || edit.status === 'applying'),
    );
  }

  const service: SetupEditApi = {
    async get(scenarioId): Promise<SetupEditSnapshot> {
      if (scenarioId === BROKE) return { available: false };
      const scenario = scenarios.get(scenarioId);
      if (!scenario) return { available: true, found: false };
      return {
        available: true,
        found: true,
        used: scenario.used,
        edits: edits
          .filter((edit) => edit.scenarioId === scenarioId)
          .map(summary)
          .reverse(),
      };
    },
    async open(scenarioId, user): Promise<OpenSetupEditResult> {
      openCalls += 1;
      if (scenarioId === BROKE) return { available: false };
      const scenario = scenarios.get(scenarioId);
      if (!scenario) return { available: true, outcome: 'not_found', editId: null };
      const current = inflight(scenarioId);
      if (current) {
        if (current.status === 'open' && current.openedBy === user.id) {
          return { available: true, outcome: 'existing', editId: current.id };
        }
        return { available: true, outcome: 'busy', editId: current.id };
      }
      const admin = user.role === 'admin';
      // Same check as open_scenario_setup_edit with p_limit 3. Opening does not
      // increment used; only the SQL count function does.
      if (!admin && scenario.used >= 3) {
        return { available: true, outcome: 'limit_reached', editId: null };
      }
      const created: FakeEdit = {
        id: `55555555-5555-4555-8555-${String(++seq).padStart(12, '0')}`,
        scenarioId,
        openedBy: user.id,
        openedByAdmin: admin,
        status: 'open',
        counted: false,
        baseline: EMPTY_SETUP_BASELINE,
        baselineHash: emptySetupBaselineHash(),
        draftId: null,
        createdAt: new Date(seq).toISOString(),
      };
      edits.push(created);
      return { available: true, outcome: 'opened', editId: created.id };
    },
    async attachOpenedDraft(scenarioId, editId, ctx) {
      if (identityConflict) return { available: true, ok: false, reason: 'conflict' };
      const source = sources.get(scenarioId);
      const edit = edits.find((row) => row.id === editId && row.scenarioId === scenarioId);
      if (!source || !edit) return { available: true, ok: false, reason: 'not_found' };
      const stamped = stampOrgIdentity(source.scenario.initial_state);
      if (canonicalJson(stamped) !== canonicalJson(source.scenario.initial_state)) {
        source.scenario.initial_state = stamped;
      }
      const snapshot = snapshotFromScenario({
        ...source,
        scenario: { ...source.scenario, initial_state: stamped },
      });
      const hash = baselineHash(snapshot);
      const draft: FakeDraft = {
        id: `77777777-7777-4777-8777-${String(++seq).padStart(12, '0')}`,
        scenarioId,
        createdBy: ctx.userId,
        currentStep: 1,
        input: draftInputFromSnapshot(snapshot, {
          edit_id: editId,
          scenario_id: scenarioId,
          scenario_title: 'Acme crisis',
          remaining: ctx.remaining,
        }),
      };
      drafts.push(draft);
      edit.baseline = snapshot as unknown as Record<string, unknown>;
      edit.baselineHash = hash;
      edit.draftId = draft.id;
      return { available: true, ok: true, draftId: draft.id, baselineHash: hash };
    },
    async abandon(scenarioId, editId): Promise<AbandonSetupEditResult> {
      if (scenarioId === BROKE) return { available: false };
      const edit = edits.find((row) => row.id === editId && row.scenarioId === scenarioId);
      if (!edit) return { available: true, outcome: 'not_found' };
      if (edit.status !== 'open') return { available: true, outcome: 'not_open' };
      edit.status = 'abandoned';
      return { available: true, outcome: 'abandoned' };
    },
  };

  before(async () => {
    seed();
    const app = express();
    app.use(express.json());
    app.use(
      '/api/scenarios/:id/setup-edits',
      createScenarioSetupEditsRouter({
        enabled: () => enabled,
        limit: () => 3,
        authMiddleware: (req, _res, next) => {
          const headerUser = req.headers['x-user'];
          const headerRole = req.headers['x-role'];
          (req as AuthenticatedRequest).user = {
            id: typeof headerUser === 'string' ? headerUser : TRAINER.id,
            role: typeof headerRole === 'string' ? headerRole : 'trainer',
          };
          next();
        },
        assertOwner: async (scenarioId, user) => {
          const scenario = scenarios.get(scenarioId);
          if (!scenario) return { ok: false, status: 404, error: 'Scenario not found' };
          if (user.role === 'admin' || scenario.ownerId === user.id) return { ok: true };
          return {
            ok: false,
            status: 403,
            error: 'Only the scenario creator can modify this scenario',
          };
        },
        loadCategory: async (scenarioId) => scenarios.get(scenarioId)?.category ?? null,
        canEdit: async (scenarioId, user) => {
          const scenario = scenarios.get(scenarioId);
          if (scenario?.live) {
            return {
              editable: false,
              reason: 'live_session',
              session_credits: 1,
              live_session_id: 'live',
            };
          }
          if (scenario && !scenario.credits && user.role !== 'admin') {
            return {
              editable: false,
              reason: 'no_session_credits',
              session_credits: 0,
              live_session_id: null,
            };
          }
          return { editable: true, reason: 'ok', session_credits: 1, live_session_id: null };
        },
        service,
        apply: async () => ({ ok: false, status: 404, code: 'NOT_FOUND', error: 'Setup edit not found' }),
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

  function headers(user: { id: string; role: string } = TRAINER): Record<string, string> {
    return { 'x-user': user.id, 'x-role': user.role };
  }

  async function post(id: string, user?: { id: string; role: string }) {
    const res = await fetch(`${base}/api/scenarios/${id}/setup-edits`, {
      method: 'POST',
      headers: headers(user),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function get(id: string, user?: { id: string; role: string }) {
    const res = await fetch(`${base}/api/scenarios/${id}/setup-edits`, { headers: headers(user) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function abandon(id: string, editId: string, user?: { id: string; role: string }) {
    const res = await fetch(`${base}/api/scenarios/${id}/setup-edits/${editId}/abandon`, {
      method: 'POST',
      headers: headers(user),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test('open returns 201 and does not change the used count', async () => {
    seed();
    const res = await post(SOCIAL);
    assert.equal(res.status, 201);
    assert.equal(res.json.outcome, 'opened');
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
    assert.equal(edits.length, 1);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].currentStep, 1);
    assert.equal(edits[0].baselineHash, res.json.baseline_hash);
    assert.notEqual(edits[0].baselineHash, emptySetupBaselineHash());
    assert.equal((edits[0].baseline as unknown as SetupSnapshot).organisations[0].org_uid, 'uid-acme');
    assert.equal((edits[0].baseline as unknown as SetupSnapshot).inject_keys[0], 'plant_fire');
    assert.deepEqual(drafts[0].input.setup_edit, {
      edit_id: res.json.edit_id,
      scenario_id: SOCIAL,
      scenario_title: 'Acme crisis',
      remaining: 3,
    });
    assert.equal(drafts[0].input.crisis_description, 'Plant fire');
    assert.equal(edits[0].counted, false);
    const listed = await get(SOCIAL);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.enabled, true);
    assert.equal(listed.json.limit, 3);
    assert.equal(listed.json.used, 0);
    assert.equal(listed.json.remaining, 3);
    assert.equal((listed.json.open_edit as { id: string }).id, res.json.edit_id);
    assert.equal((listed.json.history as unknown[]).length, 1);
  });

  test('the same trainer opening again gets the existing edit', async () => {
    seed();
    const first = await post(SOCIAL);
    const second = await post(SOCIAL);
    assert.equal(second.status, 200);
    assert.equal(second.json.outcome, 'existing');
    assert.equal(second.json.edit_id, first.json.edit_id);
    assert.equal(edits.length, 1);
    assert.equal(drafts.length, 1);
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
  });

  test('an admin is busy when the trainer already has an open edit', async () => {
    seed();
    const opened = await post(SOCIAL);
    const busy = await post(SOCIAL, ADMIN);
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, 'SETUP_EDIT_BUSY');
    assert.equal(busy.json.edit_id, opened.json.edit_id);
    assert.equal(edits.length, 1);
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
  });

  test('a non-owner is forbidden before an edit is opened', async () => {
    seed();
    const beforeCalls = openCalls;
    const res = await post(FOREIGN);
    assert.equal(res.status, 403);
    assert.equal(openCalls, beforeCalls);
    assert.equal(edits.length, 0);
  });

  test('a live session is locked', async () => {
    seed();
    const beforeCalls = openCalls;
    const res = await post(LIVE);
    assert.equal(res.status, 423);
    assert.equal(res.json.code, 'SCENARIO_LOCKED');
    assert.equal(openCalls, beforeCalls);
    assert.equal(scenarios.get(LIVE)?.used, 0);
  });

  test('no session credits is locked', async () => {
    seed();
    const res = await post(NO_CREDIT);
    assert.equal(res.status, 423);
    assert.equal(res.json.code, 'SCENARIO_LOCKED');
    assert.equal(edits.length, 0);
  });

  test('the feature flag off is not found', async () => {
    seed();
    enabled = false;
    const beforeCalls = openCalls;
    const opened = await post(SOCIAL);
    const listed = await get(SOCIAL);
    assert.equal(opened.status, 404);
    assert.equal(opened.json.code, 'SETUP_EDITS_UNAVAILABLE');
    assert.equal(listed.status, 404);
    assert.equal(openCalls, beforeCalls);
    assert.equal(edits.length, 0);
  });

  test('a fourth open is forbidden for a trainer and allowed for an admin', async () => {
    seed();
    const trainer = await post(LIMITED);
    assert.equal(trainer.status, 403);
    assert.equal(trainer.json.code, 'SETUP_EDIT_LIMIT');
    assert.equal(edits.length, 0);
    assert.equal(scenarios.get(LIMITED)?.used, 3);
    const admin = await post(LIMITED, ADMIN);
    assert.equal(admin.status, 201);
    assert.equal(admin.json.outcome, 'opened');
    assert.equal(scenarios.get(LIMITED)?.used, 3);
    assert.equal(edits[0].counted, false);
    assert.equal(edits[0].openedByAdmin, true);
    const view = await get(LIMITED, ADMIN);
    assert.equal(view.json.remaining, null);
    assert.equal(view.json.used, 3);
    assert.equal(
      (drafts.at(-1)?.input.setup_edit as { remaining: number | null }).remaining,
      null,
    );
  });

  test('an open edit can still be resumed once the limit is reached', async () => {
    seed();
    const scenario = scenarios.get(LIMITED);
    assert.ok(scenario);
    scenario.used = 3;
    edits.push({
      id: '66666666-6666-4666-8666-666666666666',
      scenarioId: LIMITED,
      openedBy: TRAINER.id,
      openedByAdmin: false,
      status: 'open',
      counted: false,
      baseline: EMPTY_SETUP_BASELINE,
      baselineHash: emptySetupBaselineHash(),
      draftId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await post(LIMITED);
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'existing');
    assert.equal(scenarios.get(LIMITED)?.used, 3);
    assert.equal(edits.length, 1);
  });

  test('a missing migration hides the allowance and does not error', async () => {
    seed();
    const listed = await get(BROKE);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.enabled, false);
    assert.equal(listed.json.open_edit, null);
    assert.deepEqual(listed.json.history, []);
    const opened = await post(BROKE);
    assert.equal(opened.status, 404);
    assert.equal(opened.json.code, 'SETUP_EDITS_UNAVAILABLE');
    assert.equal(scenarios.get(BROKE)?.used, 0);
  });

  test('a participant is forbidden', async () => {
    seed();
    const res = await post(SOCIAL, PLAYER);
    assert.equal(res.status, 403);
    const listed = await get(SOCIAL, PLAYER);
    assert.equal(listed.status, 403);
  });

  test('a field scenario cannot be opened', async () => {
    seed();
    const beforeCalls = openCalls;
    const res = await post(FIELD);
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'SETUP_EDIT_UNAVAILABLE');
    assert.equal(openCalls, beforeCalls);
  });

  test('opening an older scenario stamps org_uid before the baseline is stored', async () => {
    seed();
    const source = sources.get(SOCIAL);
    assert.ok(source);
    const state = source.scenario.initial_state as {
      orgs: Array<{ org_uid?: string }>;
      org_key_history?: unknown;
    };
    delete state.orgs[0].org_uid;
    delete state.org_key_history;
    const res = await post(SOCIAL);
    assert.equal(res.status, 201);
    const stamped = source.scenario.initial_state as {
      orgs: Array<{ org_uid: string }>;
    };
    assert.match(stamped.orgs[0].org_uid, /^[0-9a-f-]{36}$/);
    assert.equal(
      (edits[0].baseline as unknown as SetupSnapshot).organisations[0].org_uid,
      stamped.orgs[0].org_uid,
    );
  });

  test('a lost identity write abandons the edit and asks for a retry', async () => {
    seed();
    identityConflict = true;
    const res = await post(SOCIAL);
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'SETUP_EDIT_CONFLICT');
    assert.equal(edits[0].status, 'abandoned');
    assert.equal(drafts.length, 0);
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
  });

  test('a failed draft leaves the edit abandoned and the used count unchanged', async () => {
    seed();
    sources.delete(SOCIAL);
    const res = await post(SOCIAL);
    assert.equal(res.status, 404);
    assert.equal(edits[0].status, 'abandoned');
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
    assert.equal(drafts.length, 0);
  });

  test('abandoning an open edit does not change the used count', async () => {
    seed();
    const opened = await post(SOCIAL);
    const editId = opened.json.edit_id as string;
    const dropped = await abandon(SOCIAL, editId);
    assert.equal(dropped.status, 200);
    assert.equal(dropped.json.status, 'abandoned');
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
    assert.equal(edits[0].status, 'abandoned');
    const again = await post(SOCIAL);
    assert.equal(again.status, 201);
    assert.equal(scenarios.get(SOCIAL)?.used, 0);
    const closed = await abandon(SOCIAL, editId);
    assert.equal(closed.status, 409);
    assert.equal(closed.json.code, 'SETUP_EDIT_NOT_OPEN');
  });
});
