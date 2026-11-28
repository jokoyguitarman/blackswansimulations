import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  applySetupEdit,
  mergeEditForApply,
  type ApplyDeps,
  type ApplySetupEditRequest,
  type PreparedApply,
} from '../services/setupEdits/applySetupEdit.js';
import { staleApplyIds } from '../services/setupEdits/setupEditCore.js';
import { applyInput, baseState, emptyOutputs, emptyPlan } from '../services/setupEdits/fixtures/applyWorld.js';
import { snapshotFromScenario } from '../services/setupEdits/setupSnapshotCore.js';
import { createScenarioSetupEditsRouter } from './scenarioSetupEdits.js';
import { mergeSetupEdit, type ApplyBundle } from '../services/setupEdits/setupMergeCore.js';

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
  let rpcCalls: Array<{ isAdmin: boolean; md5: string; bundle: ApplyBundle }> = [];
  let consumed = 0;
  let refunded = 0;
  let released = 0;
  let reseeded: string[] = [];
  let used = 0;
  let charge = false;
  let lastApply: ApplySetupEditRequest | null = null;

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
    return {
      ok: true,
      input,
      stateMd5: 'state-md5-from-the-loaded-row',
      sessions: [{
        id: 'sess-1',
        title: null,
        scheduled_start_time: '2026-07-01T09:00:00+00',
        reseed: true,
        unassigned_players: [],
      }],
    };
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
    async rpc(args) {
      rpcCalls.push({ isAdmin: args.isAdmin, md5: args.md5, bundle: args.bundle });
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
          async listAllowances() {
            return { available: true, byId: {} };
          },
          async attachOpenedDraft() {
            return { available: true, ok: false, reason: 'not_found' };
          },
        },
        apply: (request: ApplySetupEditRequest) => {
          lastApply = request;
          return applySetupEdit(request, deps);
        },
        plan: async () => ({ ok: false, status: 404, code: 'SETUP_EDIT_NOT_FOUND', error: 'Setup edit not found' }),
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
    lastApply = null;
  }

  async function apply(user = TRAINER) {
    const res = await fetch(`${base}/api/scenarios/${SCENARIO}/setup-edits/${EDIT}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user.id, 'x-role': user.role },
      body: JSON.stringify({ build_id: BUILD, orphan_decisions: {} }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  test('keep-original rows are forwarded as rejected revisions', async () => {
    reset('applied');
    const res = await fetch(`${base}/api/scenarios/${SCENARIO}/setup-edits/${EDIT}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': TRAINER.id, 'x-role': 'trainer' },
      body: JSON.stringify({
        build_id: BUILD,
        orphan_decisions: { 'role:cs_head': { choice: 'keep' } },
        rejected_revisions: ['inj-plant'],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(lastApply?.rejectedRevisionIds, ['inj-plant']);
    assert.equal(lastApply?.orphanDecisions['role:cs_head']?.choice, 'keep');
  });

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
    assert.equal(rpcCalls[0]?.md5, 'state-md5-from-the-loaded-row');
    assert.equal(used, 0);
    const sessions = res.json.scheduled_sessions as Array<{ title: string | null; scheduled_start_time: string | null }>;
    assert.equal(sessions[0]?.title, null);
    assert.equal(sessions[0]?.scheduled_start_time, '2026-07-01T09:00:00+00');
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

describe('apply three-way texts from the frozen snapshot', () => {
  test('a diverged title, grievance and objective stay when the model proposes replacements', () => {
    const baseline = snapshotFromScenario({
      scenario: {
        title: 'Warehouse fire',
        description: 'Smoke in the loading bay',
        briefing: 'The warehouse is burning',
        initial_state: baseState({ stakeholders: cast('No water', ['dusk']) }),
      },
      teams: [],
      injects: [],
      objectives: [{ objective_id: 'hold_the_line', objective_name: 'Hold', description: 'Old line' }],
    });
    const outputs = emptyOutputs();
    outputs[1].narrative_update = {
      title: 'Model title',
      description: 'Model description',
      briefing: 'Model briefing',
      briefing_kept: false,
    };
    outputs[1].stakeholder_updates = [{
      id: 'mina_cho',
      grievance: 'Plenty of water',
      knowledge: ['dawn'],
    }];
    outputs[1].objective_updates = [{
      objective_id: 'hold_the_line',
      write: 'in_place',
      fields: { objective_name: 'Model name', description: 'Model line', weight: 40 },
    }];
    const spec = applyInput({
      edit: mergeEditForApply(EDIT, baseline, baseline),
      outputs,
    });
    spec.current.scenario.title = 'Trainer title';
    spec.current.scenario.description = 'Trainer description';
    spec.current.scenario.briefing = 'Trainer briefing';
    spec.current.scenario.initial_state = baseState({
      stakeholders: cast('Trainer grievance', ['noon']),
    });
    spec.current.scenario.objectives = [{
      id: 'obj-row',
      objective_id: 'hold_the_line',
      objective_name: 'Trainer hold',
      description: 'Trainer line',
      weight: 25,
      success_criteria: {},
    }];
    const bundle = mergeSetupEdit(spec);
    assert.equal(bundle.scenario.set_title, false);
    assert.equal(bundle.scenario.title, 'Trainer title');
    assert.equal(bundle.scenario.set_description, false);
    assert.equal(bundle.scenario.description, 'Trainer description');
    assert.equal(bundle.scenario.set_briefing, false);
    assert.equal(bundle.scenario.briefing, 'Trainer briefing');
    const stakeholders = (bundle.scenario.initial_state as {
      stakeholders: Array<{ grievance: string; knowledge: string[] }>;
    }).stakeholders;
    assert.equal(stakeholders[0].grievance, 'Trainer grievance');
    assert.deepEqual(stakeholders[0].knowledge, ['noon']);
    assert.equal(bundle.objectives.update[0]?.objective_name, 'Trainer hold');
    assert.equal(bundle.objectives.update[0]?.description, 'Trainer line');
    assert.equal(bundle.summary.text_kept.includes('title'), true);
    assert.equal(bundle.summary.text_kept.includes('stakeholder:mina_cho:grievance'), true);
    assert.equal(bundle.summary.text_kept.includes('objective:obj-row:name'), true);
  });
});

function cast(grievance: string, knowledge: string[]) {
  const contact = (
    id: string,
    relationship: 'internal' | 'media' | 'regulator',
    owning_team: string,
    title: string,
    ownGrievance: string,
    ownKnowledge: string[],
  ) => ({
    id,
    name: title,
    title,
    organisation: 'Acme',
    relationship,
    owning_team,
    org_key: 'primary',
    email: `${id}@acme.test`,
    handle: `@${id}`,
    grievance: ownGrievance,
    knowledge: ownKnowledge,
    resolution_criteria: ownGrievance ? ['A public correction'] : [],
  });
  return [
    contact('mina_cho', 'media', 'Communications', 'Reporter', grievance, knowledge),
    contact('plant_lead', 'internal', 'Communications', 'Plant Manager', '', []),
    contact('hr_lead', 'internal', 'Legal', 'HR Manager', '', []),
    contact('mom_officer', 'regulator', 'Legal', 'Inspector', '', []),
  ];
}

describe('stale apply reclaim', () => {
  test('a heartbeat older than ten minutes is reopened and a fresh one is not', () => {
    const now = new Date('2026-06-01T00:10:00.000Z');
    const ids = staleApplyIds(
      [
        { id: 'old', status: 'applying', apply_heartbeat_at: '2026-06-01T00:00:00.000Z' },
        { id: 'fresh', status: 'applying', apply_heartbeat_at: '2026-06-01T00:05:00.000Z' },
        { id: 'open', status: 'open', apply_heartbeat_at: '2026-06-01T00:00:00.000Z' },
        { id: 'missing', status: 'applying', apply_heartbeat_at: null },
      ],
      now,
    );
    assert.deepEqual(ids, ['old', 'missing']);
  });
});
