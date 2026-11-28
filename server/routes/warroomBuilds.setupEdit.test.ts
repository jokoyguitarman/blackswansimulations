import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildRequestSchema, type BuildRequest } from '../services/warroomBuild/buildTypes.js';
import { createWarroomBuildsRouter, type WarroomBuildApi } from './warroomBuilds.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { draftInputFromSnapshot, snapshotFromDraftInput } from '../services/setupEdits/setupSnapshotCore.js';
import { computeDelta } from '../services/setupEdits/setupDeltaCore.js';
import { planRemap } from '../services/setupEdits/remapPlanner.js';
import { hashPlan, type SetupEditBuildSource } from '../services/setupEdits/prepareSetupEditBuild.js';
import { snapshot, snapshotOrg, snapshotTeam } from '../services/setupEdits/fixtures/remapFixtures.js';
import type { SetupSnapshot } from '../services/setupEdits/setupSnapshotCore.js';

const TRAINER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EDIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRAFT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCENARIO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function orgWith(teams: ReturnType<typeof snapshotTeam>[]) {
  return snapshotOrg({
    org_uid: 'uid-acme',
    org_key: 'primary',
    display_name: 'Acme',
    short_name: 'ACME',
    is_primary: true,
    teams,
  });
}

function baseline(): SetupSnapshot {
  return snapshot([
    orgWith([
      snapshotTeam({ team_uid: 'team-comms', team_name: 'Communications', function_key: 'communications', is_public_voice: true }),
      snapshotTeam({ team_uid: 'team-legal', team_name: 'Legal', function_key: 'legal' }),
    ]),
  ]);
}

function withAudit(): SetupSnapshot {
  const base = baseline();
  const org = base.organisations[0];
  return {
    ...base,
    organisations: [
      {
        ...org,
        teams: [
          ...org.teams,
          snapshotTeam({ team_uid: 'team-audit', team_name: 'Audit', function_key: 'audit', is_custom: true }),
        ],
      },
    ],
  };
}

function source(setup: SetupSnapshot, status = 'open'): SetupEditBuildSource {
  return {
    edit: {
      id: EDIT,
      scenario_id: SCENARIO,
      status,
      draft_id: DRAFT,
      baseline: baseline(),
      edit_number: 1,
    },
    draft_input: draftInputFromSnapshot(setup, {
      edit_id: EDIT,
      scenario_id: SCENARIO,
      scenario_title: 'Plant fire',
      remaining: 2,
    }),
    remap: { initial_state: {}, teams: [], injects: [], sessions: [] },
  };
}

function requestBody(setupEdit = true): Record<string, unknown> {
  const request = buildRequestSchema.parse({
    crisis_type: 'Client brief the server must ignore',
    organisations: [
      {
        display_name: 'Client org',
        country: 'Singapore',
        is_primary: true,
        team_roster: [{ team_name: 'Communications' }, { team_name: 'Legal' }],
      },
    ],
    ...(setupEdit ? { mode: 'setup_edit', setup_edit_id: EDIT } : {}),
  });
  return {
    draft_id: DRAFT,
    idempotency_key: KEY,
    request,
  };
}

describe('setup edit build start', () => {
  let server: Server;
  let base: string;
  let current: SetupEditBuildSource = source(withAudit());
  let ownerOk = true;
  const started: BuildRequest[] = [];

  const service: WarroomBuildApi = {
    async start(input) {
      started.push(input.request);
      return { buildId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', outcome: 'created' };
    },
    async get() {
      return {
        build: {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          draft_id: DRAFT,
          status: 'queued',
          current_stage: null,
          stages: {
            characters: { status: 'pending', attempts: 0 },
            storyline: { status: 'pending', attempts: 0 },
            convergence: { status: 'pending', attempts: 0 },
            pages: { status: 'pending', attempts: 0 },
          },
          error: null,
          error_code: null,
          cancel_reason: null,
          interruptions: 0,
          request_hash: 'hash',
          resumable: false,
          resume_from: null,
          compile: { status: null, scenario_id: null },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          finished_at: null,
        },
        log: [],
        next_after: 0,
      };
    },
    async getRow() {
      return null;
    },
    async latestForDraft() {
      return null;
    },
    async review() {
      throw new Error('unused');
    },
    async resume() {
      throw new Error('unused');
    },
    async cancel() {
      return null;
    },
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/warroom/social-crisis/builds',
      createWarroomBuildsRouter({
        enabled: () => true,
        authMiddleware: (req, _res, next) => {
          const header = req.headers['x-user'];
          (req as AuthenticatedRequest).user = {
            id: typeof header === 'string' ? header : TRAINER,
            role: 'trainer',
          };
          next();
        },
        credit: async () => true,
        service,
        loadDraft: async () => ({ id: DRAFT, created_by: TRAINER }),
        loadSetupEdit: async () => ({ available: true, source: current }),
        assertOwner: async () =>
          ownerOk
            ? { ok: true }
            : { ok: false, status: 403, error: 'Only the scenario creator can modify this scenario' },
        canEdit: async () => ({
          editable: true,
          reason: 'ok',
          session_credits: 1,
          live_session_id: null,
        }),
        organisationsOk: () => ({ ok: true }),
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function post(body: unknown, user = TRAINER) {
    const res = await fetch(`${base}/api/warroom/social-crisis/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { code?: string; error?: string } };
  }

  test('an untouched draft round-trips to an empty delta', () => {
    const frozen = baseline();
    const draft = draftInputFromSnapshot(frozen, {
      edit_id: EDIT,
      scenario_id: SCENARIO,
      scenario_title: 'Plant fire',
      remaining: 2,
    });
    assert.equal(computeDelta(frozen, snapshotFromDraftInput(draft, frozen)).empty, true);
  });

  test('a closed edit is rejected', async () => {
    current = source(withAudit(), 'applied');
    ownerOk = true;
    const before = started.length;
    const res = await post(requestBody());
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'SETUP_EDIT_NOT_OPEN');
    assert.equal(started.length, before);
  });

  test('a non-owner is rejected', async () => {
    current = source(withAudit());
    ownerOk = false;
    const before = started.length;
    const res = await post(requestBody(), OTHER);
    assert.equal(res.status, 403);
    assert.equal(started.length, before);
    ownerOk = true;
  });

  test('an empty delta is rejected', async () => {
    current = source(baseline());
    const before = started.length;
    const res = await post(requestBody());
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'SETUP_EDIT_EMPTY');
    assert.equal(started.length, before);
  });

  test('the stored delta and plan hash are recomputed from the draft', async () => {
    const edited = withAudit();
    current = source(edited);
    const before = started.length;
    const res = await post(requestBody());
    assert.equal(res.status, 202);
    const stored = started[before];
    assert.ok(stored);
    const expectedEdited = snapshotFromDraftInput(current.draft_input, baseline());
    const expectedDelta = computeDelta(baseline(), expectedEdited);
    assert.equal(expectedDelta.empty, false);
    assert.deepEqual(stored.delta, expectedDelta);
    assert.equal(expectedDelta.added_teams.some((team) => team.team_name === 'Audit'), true);
    const expectedPlan = planRemap({
      delta: expectedDelta,
      edited: expectedEdited,
      initial_state: {},
      teams: [],
      injects: [],
      sessions: [],
    });
    assert.equal(stored.plan_hash, hashPlan(expectedPlan));
    assert.equal(stored.crisis_type, 'Plant fire');
    assert.equal(stored.mode, 'setup_edit');
    assert.equal(stored.setup_edit_id, EDIT);
    assert.equal(stored.organisations.some((org) => org.team_roster.some((team) => team.team_name === 'Audit')), true);
  });
});
