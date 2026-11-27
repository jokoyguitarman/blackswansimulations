import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { ALMOST_GIVEN_UP } from '../services/calls/callCore.js';
import { createMemoryCallStore } from '../services/calls/memoryCallStore.js';
import { createCallService, type CallApi } from '../services/calls/callService.js';
import type { SimCall } from '../services/calls/callTypes.js';
import { createSimCallsRouter } from './simCalls.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { RealtimeClient } from '../services/calls/realtimeClient.js';

const SESSION = '22222222-2222-4222-8222-222222222222';
const CALL = '11111111-1111-4111-8111-111111111111';
const MISSED = '33333333-3333-4333-8333-333333333333';
const SECRET = 'ephemeral-test-secret';

function script(opening = 'Hello, is this the response team?'): SimCall['script'] {
  return {
    opening,
    beats: [{ id: 'b1', say: 'Is the plant closing?', must_ask: true }],
    closing: 'Please call me back before 6pm.',
    language: 'en',
    redial: { attempts: 1, interval_minutes: 2, voicemail_each: false, stop_on_contact: true },
    inject_title: 'Welfare',
    inject_content: opening,
    requires_response: true,
    ring_seconds: 30,
    voicemail_posted_attempts: [],
    call_waiting: [],
    response_window_minutes: null,
  };
}

function call(patch: Partial<SimCall> = {}): SimCall {
  const now = '2026-11-27T12:00:00.000Z';
  return {
    id: CALL,
    sessionId: SESSION,
    injectId: '44444444-4444-4444-8444-444444444444',
    parentCallId: null,
    direction: 'inbound',
    stakeholderId: null,
    callerName: 'Pastor Daniel',
    callerNumber: '+60 9300 6062',
    voice: 'marin',
    script: script(),
    recipientUserIds: ['aisha', 'ben'],
    recipientTeams: ['Customer Service'],
    status: 'ringing',
    mode: null,
    callGroupId: CALL,
    attemptNo: 1,
    maxAttempts: 1,
    scheduledFor: null,
    declinedUserIds: [],
    ringStartedAt: now,
    ringDeadlineAt: '2026-11-27T12:00:30.000Z',
    answeredBy: null,
    answeredAt: null,
    declinedBy: null,
    endedAt: null,
    endReason: null,
    maxSeconds: 300,
    openaiCallId: null,
    transcriptSource: null,
    beatsDone: [],
    durationSeconds: null,
    createdAt: now,
    lineTeam: 'Customer Service',
    targetMode: 'ring_all',
    targetRoleId: null,
    rungUserIds: ['aisha', 'ben'],
    missedReason: null,
    ...patch,
  };
}

function testService(store: ReturnType<typeof createMemoryCallStore>): { service: CallApi; opened: string[] } {
  const opened: string[] = [];
  const realtime: RealtimeClient = {
    hasKey: () => true,
    async mintClientSecret() {
      return { ok: true, value: SECRET, expires_at: '2026-11-27T12:02:00.000Z' };
    },
    async openSideband(openaiCallId) {
      opened.push(openaiCallId);
      return { send() {}, close() {} };
    },
    async hangup() {},
  };
  const service = createCallService({
    store,
    realtime,
    now: () => new Date('2026-11-27T12:00:00.000Z'),
    scheduleTimers: false,
    aiEnabled: true,
    hasOpenAiKey: () => true,
    ledger: false,
    names: async () => ({}),
    remember: async () => {},
    notifyMissed: async () => {},
    postVoicemail: async () => {},
    recordAction: async () => {},
  });
  return { service, opened };
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

describe('sim call routes', { concurrency: 1 }, () => {
  let server: Server;
  let base: string;
  const store = createMemoryCallStore();
  const { service, opened } = testService(store);

  before(async () => {
    await store.insert(call());
    store.sessions.set(SESSION, {
      status: 'in_progress',
      trainerId: 'trainer',
      startTime: '2026-11-27T10:00:00.000Z',
      scenarioId: null,
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/calls',
      createSimCallsRouter({
        auth: auth(),
        service,
        access: async () => ({ ok: true }),
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  async function post(path: string, body: unknown, userId: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  test('answer returns a voice secret from the fake client, and the second answer is taken', async () => {
    const first = await post(`/api/calls/${CALL}/answer`, { capabilities: { webrtc: true, mic: true } }, 'aisha');
    assert.equal(first.status, 200);
    assert.equal(first.json?.mode, 'voice');
    assert.equal(first.json?.client_secret, SECRET);
    assert.equal(typeof first.json?.opening_instruction, 'string');
    const second = await post(`/api/calls/${CALL}/answer`, { capabilities: { webrtc: true, mic: true } }, 'ben');
    assert.equal(second.status, 409);
    assert.equal(second.json?.error, 'call_taken');
  });

  test('attach by a non-answerer is rejected, and a client transcript is rejected once the sideband is up', async () => {
    const stranger = await post(`/api/calls/${CALL}/attach`, { openai_call_id: 'oai_call_1' }, 'ben');
    assert.equal(stranger.status, 409);
    const attached = await post(`/api/calls/${CALL}/attach`, { openai_call_id: 'oai_call_1' }, 'aisha');
    assert.equal(attached.status, 204);
    assert.deepEqual(opened, ['oai_call_1']);
    const relay = await post(
      `/api/calls/${CALL}/transcript`,
      { turns: [{ speaker: 'player', text: 'We have not decided.' }] },
      'aisha',
    );
    assert.equal(relay.status, 409);
    assert.equal(relay.json?.error, 'sideband_attached');
  });

  test('a call-back after the window is accepted and carries the almost-given-up line', async () => {
    await store.insert(
      call({
        id: MISSED,
        callGroupId: MISSED,
        injectId: '55555555-5555-4555-8555-555555555555',
        status: 'missed',
        missedReason: 'no_answer',
        endReason: 'no_answer',
        endedAt: '2026-11-27T10:00:30.000Z',
        ringStartedAt: '2026-11-27T10:00:00.000Z',
        ringDeadlineAt: '2026-11-27T10:00:30.000Z',
        recipientUserIds: ['ben'],
        rungUserIds: ['ben'],
      }),
    );
    const res = await post(`/api/calls/${MISSED}/callback`, { capabilities: { webrtc: true, mic: true } }, 'ben');
    assert.equal(res.status, 200);
    assert.equal(res.json?.mode, 'voice');
    assert.equal(String(res.json?.opening_instruction ?? '').includes(ALMOST_GIVEN_UP), true);
  });
});
