import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: 'frontend/.env.local' });
import { io } from 'socket.io-client';
import { createAdminClient, provisionUsers, registerParticipants } from './setup.js';
import { apiFetch, createSession, pickScenario, teardownSession } from './session.js';

/**
 * One-shot verification of the Round 1 fixes against a local server:
 *  1. Session-room 'message' broadcast arrives (Safety B: broadcast no longer
 *     dies when session_events logging fails).
 *  2. notification.created arrives over the socket with id/user_id/session_id
 *     (bulk path used by the chat route now emits complete payloads).
 *  3. Notification rows exist in the DB for all participants.
 */

const URL = 'http://localhost:3001';
const supabaseUrl = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const log = (m: string) => console.log(`[verify] ${m}`);
const results: Array<[string, boolean, string]> = [];

async function main() {
  const admin = createAdminClient(supabaseUrl, key);
  const users = await provisionUsers(admin, supabaseUrl, key, 3, log);
  const api = { baseUrl: URL, token: users.trainer.token };
  const scenario = await pickScenario(admin, 'field');
  const handle = await createSession(api, admin, 'field', 'off', scenario, log);
  await registerParticipants(admin, handle.sessionId, users.players);

  let gotSessionRoomMessage = false;
  let notificationPayload: Record<string, unknown> | null = null;

  const socket = io(URL, { auth: { token: users.players[0].token }, transports: ['websocket'] });
  socket.on('connect', () => {
    socket.emit('join_session', handle.sessionId);
  });
  socket.on('event', (event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'message') gotSessionRoomMessage = true;
    if (event.type === 'notification.created') {
      notificationPayload = event.data?.notification as Record<string, unknown>;
    }
  });

  await new Promise((r) => setTimeout(r, 2500));
  log('posting chat message as trainer...');
  const t0 = Date.now();
  await apiFetch(api, 'POST', `/api/channels/${handle.probeChannelId}/messages`, {
    content: 'Round-1 verification message',
    message_type: 'text',
  });
  const httpMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 3000));

  results.push([
    'Session-room message broadcast (Safety B)',
    gotSessionRoomMessage,
    gotSessionRoomMessage ? 'received' : 'NOT received',
  ]);

  const n = notificationPayload as Record<string, unknown> | null;
  const idsOk = !!n && !!n.id && !!n.user_id && !!n.session_id;
  results.push([
    'notification.created with id/user_id/session_id',
    idsOk,
    n
      ? `id=${String(n.id).slice(0, 8)}… user_id=${String(n.user_id).slice(0, 8)}…`
      : 'no payload received',
  ]);
  results.push([
    'Socket notification belongs to this player',
    !!n && n.user_id === users.players[0].userId,
    n ? String(n.user_id === users.players[0].userId) : 'n/a',
  ]);

  const { data: rows } = await admin
    .from('notifications')
    .select('id, user_id')
    .eq('session_id', handle.sessionId)
    .eq('type', 'chat_message');
  const expectedRecipients = new Set(users.players.map((p) => p.userId));
  const gotRecipients = new Set((rows ?? []).map((r) => r.user_id));
  const dbOk = [...expectedRecipients].every((id) => gotRecipients.has(id));
  results.push([
    'DB rows for all 3 participants (bulk insert)',
    dbOk,
    `${gotRecipients.size} recipients found`,
  ]);
  results.push(['Chat POST duration', httpMs < 5000, `${httpMs} ms`]);

  socket.disconnect();
  await teardownSession(api, handle, log);

  console.log('\n=== Round 1 verification ===');
  let pass = true;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} (${detail})`);
    if (!ok) pass = false;
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
