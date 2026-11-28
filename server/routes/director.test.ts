import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { resolveDirectorMode } from '../../shared/directorModes.js';
import { causeDepth } from '../services/conditions/crossTeamCore.js';
import type { TriggerRecordInput } from '../services/conditions/injectTriggerService.js';
import {
  fairnessState,
  type FairnessState,
  type GuardContext,
  type GuardrailResult,
  type ParsedProposal,
} from '../services/director/directorCore.js';
import {
  createDirectorCommands,
  type ConsoleProposal,
  type DirectorCommandDeps,
  type DirectorSettings,
  type ProposalPatch,
  type PublishFacts,
} from '../services/director/directorConsole.js';
import { createDirectorRouter } from './director.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { publishedCapEvents } from '../services/director/directorPublish.js';
import {
  hasPendingProposals,
  noteProposalPending,
  resetDirectorRuntime,
  setDirectorPaused,
} from '../services/director/directorRuntime.js';
import type { Signal } from '../services/director/directorSignals.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TRAINER = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';

const settings: DirectorSettings = {
  enabled: true,
  modeMax: 'auto',
  defaultMode: 'auto',
  autoMaxSeverity: 'medium',
  graceSeconds: 60,
  ttlMinutes: 5,
  tolerance: 2,
  budgetLimit: 20,
  crossTeam: {
    maxPerTeamWindow: 2,
    windowMinutes: 15,
    pressureMaxDeliveries10Min: 6,
    loopWindowMinutes: 20,
    maxCascadeDepth: 3,
  },
};

let now = new Date('2026-11-28T12:00:00.000Z');
let sessionMode: string | null = null;
let scenarioMode: string | null = null;
let rows: ConsoleProposal[] = [];
let injects: Array<Record<string, unknown>> = [];
let triggers: TriggerRecordInput[] = [];
let published: string[] = [];
let overCap = false;
let server: Server;
let base = '';

function signal(): Signal {
  return {
    id: 'team_silent:legal',
    kind: 'team_silent',
    team: 'Legal',
    minute: 27,
    detail: 'Legal silent 12 min',
    depth: 1,
    keys: ['unresponded:dir_1:5|team=legal'],
    notable: true,
  };
}

function proposal(overrides: Partial<ParsedProposal> = {}): ParsedProposal {
  return {
    kind: 'consequence',
    cause: { signal_ids: ['team_silent:legal'], source_teams: ['Communications'] },
    target_teams: ['Legal'],
    target_role_id: null,
    app: 'email',
    sender: { stakeholder_id: 'stk_maria' },
    title: 'Holding update',
    content: 'Please send the holding statement today.',
    severity: 'medium',
    requires_response: true,
    response_rubric: null,
    follow_up: { if_unanswered_minutes: 5, content: 'Still waiting on the statement.' },
    ...overrides,
  };
}

function fairness(over: boolean): FairnessState {
  const state = fairnessState(
    [{ name: 'Legal', staffed: true, playable: true, active: true, size: 4 }],
    [],
    { tolerance: 2, minute: 27, duration: 60 },
  );
  state.teams[0]!.over_cap = over;
  return state;
}

function guard(): GuardContext {
  return {
    minute: 27,
    duration: 60,
    mode: 'auto',
    intensity: 'medium',
    per15: 2,
    perTeam30: 1,
    maxSeverity: 'high',
    pressureMax: 6,
    teams: [{ name: 'Legal', staffed: true, playable: true, active: true, size: 4 }],
    protectedTeams: [],
    allowedApps: [
      'email',
      'group_chat',
      'phone_call',
      'npc_dm',
      'messenger_dm',
      'social_feed',
      'news',
    ],
    roleIds: [],
    stakeholders: [{ id: 'stk_maria', name: 'Maria Tan' }],
    npcs: [],
    orgs: ['Harbour Authority'],
    brief: 'A spill closed Bay 3.',
    facts: ['Bay 3 is closed'],
    recentTexts: [],
    upcoming: [],
    capEvents: [],
    deliveries: [],
    unansweredByTeam: {},
    priorLowMediumTeams: ['Legal'],
    authoredKeysByTeam: {},
    signals: [signal()],
    fairness: fairness(overCap),
    consistencyEnabled: true,
    consistency: { status: 'consistent', reason: 'ok' },
  };
}

function facts(): PublishFacts {
  return {
    scenarioId: '44444444-4444-4444-8444-444444444444',
    guard: guard(),
    recent: [],
    deliveries: [],
    triggersByKey: {
      dir_1: {
        cause_depth: 1,
        origin: 'director',
        source_teams: ['Communications'],
        target_teams: ['Legal'],
        is_cross_team: true,
      },
    },
    people: [{ id: 'stk_maria', name: 'Maria Tan', email: 'maria@straits.example' }],
    npcs: [],
    stakeholderNames: { stk_maria: 'Maria Tan' },
  };
}

function row(overrides: Partial<ConsoleProposal> = {}): ConsoleProposal {
  return {
    id: PROPOSAL,
    sessionId: SESSION,
    seq: 3,
    minute: 27,
    status: 'proposed',
    mode: 'auto',
    reason: 'Legal has been silent',
    proposal: proposal(),
    signals: [signal()],
    guardrails: [],
    consistencyStatus: 'consistent',
    fairness: fairness(false),
    autoPublishAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(),
    fairnessOverride: false,
    injectId: null,
    ...overrides,
  };
}

function reset() {
  resetDirectorRuntime();
  now = new Date('2026-11-28T12:00:00.000Z');
  sessionMode = null;
  scenarioMode = null;
  settings.enabled = true;
  settings.modeMax = 'auto';
  settings.defaultMode = 'auto';
  settings.autoMaxSeverity = 'medium';
  settings.ttlMinutes = 5;
  rows = [];
  injects = [];
  triggers = [];
  published = [];
  overCap = false;
}

function applyPatch(target: ConsoleProposal, patch: ProposalPatch): void {
  if (patch.status != null) target.status = patch.status;
  if (patch.proposal !== undefined) target.proposal = patch.proposal;
  if (patch.guardrails != null) target.guardrails = patch.guardrails as GuardrailResult[];
  if (patch.reason !== undefined) target.reason = patch.reason;
  if (patch.fairnessOverride != null) target.fairnessOverride = patch.fairnessOverride;
  if (patch.injectId !== undefined) target.injectId = patch.injectId;
  if (patch.autoPublishAt !== undefined) target.autoPublishAt = patch.autoPublishAt;
}

function deps(): DirectorCommandDeps {
  return {
    now: () => now,
    settings: () => ({ ...settings, crossTeam: { ...settings.crossTeam } }),
    budgetUsed: () => 6,
    async loadSession() {
      return {
        id: SESSION,
        scenarioId: '44444444-4444-4444-8444-444444444444',
        trainerId: TRAINER,
        directorMode: sessionMode,
        elapsedMinutes: 27,
      };
    },
    async scenarioMode() {
      return scenarioMode;
    },
    async listProposals() {
      return rows.map((item) => ({
        ...item,
        proposal: item.proposal ? { ...item.proposal } : null,
      }));
    },
    async dueProposals(_sessionId, nowIso, createdBeforeIso) {
      const dueAt = Date.parse(nowIso);
      const createdBefore = Date.parse(createdBeforeIso);
      return rows.filter((item) => {
        if (item.status !== 'proposed') return false;
        if (item.autoPublishAt) return Date.parse(item.autoPublishAt) <= dueAt;
        return Date.parse(item.createdAt) <= createdBefore;
      });
    },
    async updateProposal(id, expectStatus, patch) {
      const target = rows.find((item) => item.id === id && item.status === expectStatus);
      if (!target) return 'lost';
      applyPatch(target, patch);
      return 'updated';
    },
    async setSessionMode(_sessionId, mode) {
      sessionMode = mode;
      return 'ok';
    },
    async expirePending() {
      const ids = rows.filter((item) => item.status === 'proposed').map((item) => item.id);
      for (const item of rows) {
        if (item.status === 'proposed') {
          item.status = 'expired';
          item.autoPublishAt = null;
        }
      }
      return ids;
    },
    async convertCountdowns() {
      const ids = rows
        .filter((item) => item.status === 'proposed' && item.autoPublishAt)
        .map((item) => item.id);
      for (const item of rows) {
        if (item.status === 'proposed') item.autoPublishAt = null;
      }
      return ids;
    },
    async publishFacts() {
      const base = facts();
      return { ...base, guard: { ...base.guard, capEvents: publishedCapEvents(rows) } };
    },
    async resolvedMode() {
      if (!settings.enabled) return 'off';
      return resolveDirectorMode(settings, { mode: sessionMode }, { mode: scenarioMode });
    },
    async stakeholderNames() {
      return { stk_maria: 'Maria Tan' };
    },
    async insertInject(body) {
      injects.push(body);
      return { id: `inject-${injects.length}` };
    },
    async publishInject(injectId) {
      published.push(injectId);
    },
    async recordTrigger(input) {
      triggers.push(input);
    },
    emit() {},
    async requestWake() {
      return { ok: true, status: 200, body: { data: { requested: true } } };
    },
  };
}

function auth(): RequestHandler {
  return (req, res, next) => {
    const id = req.header('x-user-id');
    if (!id) {
      res.status(401).json({ error: 'Missing authorization header' });
      return;
    }
    (req as AuthenticatedRequest).user = { id, role: req.header('x-role') ?? 'participant' };
    next();
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  role = 'trainer',
): Promise<{ status: number; json: { data?: Record<string, unknown>; error?: string } }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-user-id': role === 'stranger' ? '99999999-9999-4999-8999-999999999999' : TRAINER,
      'x-role': role === 'stranger' ? 'trainer' : role,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { data?: Record<string, unknown>; error?: string };
  return { status: response.status, json };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions',
    createDirectorRouter({
      auth: auth(),
      async access(sessionId, user) {
        if (sessionId !== SESSION) return { ok: false, status: 404, error: 'Session not found' };
        if (user.role === 'admin' || user.id === TRAINER) return { ok: true };
        return {
          ok: false,
          status: 403,
          error: 'Only the session trainer can perform this action',
        };
      },
      commands: createDirectorCommands(deps()),
      async replay() {
        return { ok: true, mismatches: [] };
      },
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}/api/sessions`;
});

after(() => {
  server.close();
});

test('a player cannot open the director', async () => {
  reset();
  const response = await call('GET', `/${SESSION}/director`, undefined, 'participant');
  assert.equal(response.status, 403);
});

test('with no settings the mode is auto', async () => {
  reset();
  const response = await call('GET', `/${SESSION}/director`);
  assert.equal(response.status, 200);
  assert.equal(response.json.data?.mode, 'auto');
});

test('DIRECTOR_MODE_MAX=suggest turns a scenario auto into suggest and refuses auto', async () => {
  reset();
  scenarioMode = 'auto';
  settings.modeMax = 'suggest';
  const view = await call('GET', `/${SESSION}/director`);
  assert.equal(view.json.data?.mode, 'suggest');
  const refused = await call('PATCH', `/${SESSION}/director`, { mode: 'auto' });
  assert.equal(refused.status, 422);
  assert.equal(sessionMode, null);
});

test('approve refuses a suggestion older than the TTL before the sweep expires it', async () => {
  reset();
  rows = [
    row({
      autoPublishAt: null,
      mode: 'suggest',
      createdAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    }),
  ];
  const expired = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(expired.status, 409);
  assert.match(expired.json.error ?? '', /expired/i);
  assert.equal(rows[0]?.status, 'proposed');
  assert.equal(published.length, 0);

  reset();
  rows = [
    row({
      autoPublishAt: null,
      mode: 'suggest',
      createdAt: new Date(now.getTime() - 5 * 60_000 + 1).toISOString(),
    }),
  ];
  const fresh = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(fresh.status, 200);
  assert.equal(published.length, 1);
});

test('approve twice publishes once, and a meta-word edit is rejected', async () => {
  reset();
  rows = [row({ autoPublishAt: null, mode: 'suggest' })];
  const first = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(first.status, 200);
  const second = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(second.status, 409);
  assert.equal(published.length, 1);
  assert.equal(injects[0]?.generation_source, 'ai_director');
  const escalation = (
    injects[0]?.delivery_config as {
      escalation?: { max_steps: number; steps: Array<{ content_mode: string }> };
    }
  ).escalation;
  assert.equal(escalation?.max_steps, 1);
  assert.equal(escalation?.steps[0]?.content_mode, 'template');
  assert.equal(
    triggers[0]?.causeDepth,
    causeDepth(['unresponded:dir_1:5|team=legal'], facts().triggersByKey),
  );
  assert.equal(triggers[0]?.origin, 'director');

  reset();
  rows = [row({ autoPublishAt: null, mode: 'suggest' })];
  const edited = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {
    content: 'This simulation is going well.',
  });
  assert.equal(edited.status, 422);
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'proposed');
});

test('auto publishes after the grace and not after a veto', async () => {
  reset();
  rows = [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  noteProposalPending(SESSION);
  assert.equal(publishedCapEvents(rows).length, 0);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 1);
  assert.equal(rows[0]?.status, 'auto_published');

  reset();
  rows = [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  noteProposalPending(SESSION);
  const veto = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/veto`, {
    reason: 'Too soon',
  });
  assert.equal(veto.status, 200);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'vetoed');
});

test('a target that crossed its fair share during the countdown is rejected at publish', async () => {
  reset();
  overCap = true;
  rows = [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  noteProposalPending(SESSION);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'rejected_guardrail');
});

test('high inside auto expires unapproved', async () => {
  reset();
  rows = [
    row({
      autoPublishAt: null,
      proposal: proposal({ severity: 'high' }),
      createdAt: new Date(now.getTime() - 6 * 60_000).toISOString(),
    }),
  ];
  noteProposalPending(SESSION);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'expired');
});

test('an edit cancels the countdown and a paused countdown expires', async () => {
  reset();
  rows = [row({ autoPublishAt: new Date(now.getTime() + 30_000).toISOString() })];
  const edited = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {
    content: 'This simulation is going well.',
  });
  assert.equal(edited.status, 422);
  assert.equal(rows[0]?.status, 'proposed');
  assert.equal(rows[0]?.autoPublishAt, null);

  reset();
  rows = [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  noteProposalPending(SESSION);
  setDirectorPaused(SESSION, true);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'expired');
  setDirectorPaused(SESSION, false);
});

test('the live mode and the ops ceiling gate publish', async () => {
  const sweep = () =>
    createDirectorCommands(deps()).sweep({
      sessionId: SESSION,
      elapsedMinutes: 27,
      trainerId: TRAINER,
      remainingCap: 3,
    });
  const due = () => {
    noteProposalPending(SESSION);
    return [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  };

  reset();
  sessionMode = 'off';
  rows = due();
  await sweep();
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'expired');

  reset();
  settings.modeMax = 'suggest';
  scenarioMode = 'auto';
  rows = due();
  await sweep();
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.autoPublishAt, null);
  assert.equal(rows[0]?.status, 'proposed');

  reset();
  settings.modeMax = 'off';
  rows = due();
  const capped = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(capped.status, 409);
  assert.equal(published.length, 0);

  reset();
  settings.enabled = false;
  rows = due();
  const disabled = await call('POST', `/${SESSION}/director/proposals/${PROPOSAL}/approve`, {});
  assert.equal(disabled.status, 409);
  assert.equal(published.length, 0);
});

test('mode switches convert countdowns or expire pending proposals', async () => {
  reset();
  scenarioMode = 'auto';
  rows = [row({ autoPublishAt: new Date(now.getTime() + 30_000).toISOString() })];
  const suggest = await call('PATCH', `/${SESSION}/director`, { mode: 'suggest' });
  assert.equal(suggest.status, 200);
  assert.equal(rows[0]?.status, 'proposed');
  assert.equal(rows[0]?.autoPublishAt, null);
  const off = await call('PATCH', `/${SESSION}/director`, { mode: 'off' });
  assert.equal(off.status, 200);
  assert.equal(rows[0]?.status, 'expired');
});

test('a tick with nothing pending does not query, and a failed publish leaves that set', async () => {
  reset();
  let queries = 0;
  const quiet = createDirectorCommands({
    ...deps(),
    async resolvedMode() {
      queries += 1;
      return 'auto';
    },
    async dueProposals() {
      queries += 1;
      return [];
    },
  });
  await quiet.sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(queries, 0);

  rows = [row({ autoPublishAt: new Date(now.getTime() - 1000).toISOString() })];
  noteProposalPending(SESSION);
  const failing = deps();
  failing.publishInject = async () => {
    throw new Error('delivery failed');
  };
  await createDirectorCommands(failing).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(rows[0]?.status, 'failed');
  assert.equal(hasPendingProposals(SESSION), false);
});

test('a countdown that came due long ago expires instead of publishing', async () => {
  reset();
  rows = [row({ autoPublishAt: new Date(now.getTime() - 10 * 60_000).toISOString() })];
  noteProposalPending(SESSION);
  await createDirectorCommands(deps()).sweep({
    sessionId: SESSION,
    elapsedMinutes: 27,
    trainerId: TRAINER,
    remainingCap: 3,
  });
  assert.equal(published.length, 0);
  assert.equal(rows[0]?.status, 'expired');
});

test('a database error saving the mode is returned to the trainer', async () => {
  reset();
  const broken = deps();
  broken.setSessionMode = async () => 'error';
  const result = await createDirectorCommands(broken).patch(SESSION, TRAINER, { mode: 'suggest' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 503);
});
