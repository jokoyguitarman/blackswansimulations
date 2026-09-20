/**
 * Payload probe for a room full of real players.
 *
 * Each client polls the feed on a timer. If that response carries every post in
 * the session, the payload grows all run and every device re-downloads it every
 * few seconds — which on one shared office network is the difference between a
 * smooth exercise and a room that grinds to a halt at minute twenty.
 *
 *   npx tsx demo-run/loadprobe.ts <sessionId>
 */

import { admin, apiFetch, provisionCohort, type Authed } from './lib.js';
import { API_BASE } from './config.js';

const sessionId = process.argv[2];
if (!sessionId) throw new Error('Usage: loadprobe.ts <sessionId>');

const { count: postCount } = await admin
  .from('social_posts')
  .select('*', { count: 'exact', head: true })
  .eq('session_id', sessionId);

console.log(`session ${sessionId}`);
console.log(`posts in session: ${postCount}\n`);

const { adminAgent } = await provisionCohort(1);

async function measure(agent: Authed, route: string): Promise<void> {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}${route}`, {
    headers: { Authorization: `Bearer ${agent.session.access_token}` },
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(text);
  let items = 0;
  try {
    const body = JSON.parse(text);
    const data = body?.data ?? body;
    items = Array.isArray(data) ? data.length : 0;
  } catch {
    /* not an array payload */
  }
  console.log(
    `${route.padEnd(52)} ${String(res.status).padEnd(4)} ` +
      `${(bytes / 1024).toFixed(0).padStart(7)} KB  ${String(items).padStart(5)} items  ${ms}ms`,
  );
}

console.log('endpoint                                             code    size      items   time');
console.log('-'.repeat(92));
await measure(adminAgent, `/api/social/posts/session/${sessionId}`);
await measure(adminAgent, `/api/social/state/session/${sessionId}`);
await measure(adminAgent, `/api/social/posts/session/${sessionId}?graded=true`);
await measure(adminAgent, `/api/sessions/${sessionId}`);

// The feed poll is the one every player repeats, so model the room on it.
const t0 = Date.now();
const res = await fetch(`${API_BASE}/api/social/posts/session/${sessionId}`, {
  headers: { Authorization: `Bearer ${adminAgent.session.access_token}` },
});
const feedBytes = Buffer.byteLength(await res.text());
void t0;

const PLAYERS = 25;
const POLL_SEC = 15;
const perMinutePerClient = (60 / POLL_SEC) * feedBytes;
const roomPerMinute = perMinutePerClient * PLAYERS;
const mbps = (roomPerMinute * 8) / 60 / 1_000_000;

console.log('\nroom model — 25 players, feed poll every 15s');
console.log(`  per client   ${(perMinutePerClient / 1024 / 1024).toFixed(2)} MB/min`);
console.log(`  whole room   ${(roomPerMinute / 1024 / 1024).toFixed(1)} MB/min`);
console.log(`  sustained    ${mbps.toFixed(1)} Mbps just for feed polling`);
console.log(
  mbps > 50
    ? '  VERDICT: would saturate typical office wifi'
    : mbps > 20
      ? '  VERDICT: heavy but survivable on good wifi'
      : '  VERDICT: comfortable',
);
