/**
 * Orchestrates one full capture: the admin agent creates and runs a session
 * while N player agents each play from their own recorded browser context.
 *
 *   npx tsx demo-run/run.ts --profile novice --players 25 --minutes 60
 *   npx tsx demo-run/run.ts --profile expert --players 5  --minutes 10   (smoke)
 *
 * Writes videos plus a manifest.json under demo-run/output/<profile>-<stamp>/.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
import {
  APP_BASE,
  HERO_ROSTER_INDICES,
  OUTPUT_ROOT,
  PLAYER_VIEWPORT,
  ROSTER,
  SCENARIO_TITLE,
  TRAINER_VIEWPORT,
  type RunProfile,
} from './config.js';
import { createAgentBrowser, humanClick, humanScroll, launchPool, tryClick } from './browser.js';
import {
  assignOrgPage,
  createSession,
  listOrgPages,
  provisionCohort,
  setSessionStatus,
  sleep,
  waitForApi,
  type Agent,
} from './lib.js';
import { brainStats, loadFactSheet } from './brain.js';
import { PlayerAgent } from './agent.js';
import { Timeline, writeTimelines } from './timeline.js';
import { Watchdog } from './watchdog.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`Missing --${name}`);
  return v ?? fallback!;
};

const profile = arg('profile') as RunProfile;
if (profile !== 'novice' && profile !== 'expert') throw new Error('--profile must be novice|expert');
const durationMinutes = Number(arg('minutes', '60'));
/** Seconds between player joins. /api/join allows 10 req/min per IP, 2 per join. */
const joinStaggerSec = Number(arg('stagger', '15'));
/**
 * Hero mode: a small, hand-picked cohort recorded at 2x pixel density, purely to
 * harvest close-ups for the trailer. Not for metrics — the full runs do that.
 */
const heroMode = process.argv.includes('--hero');
// Always 1: deviceScaleFactor does not raise Playwright's video resolution, it
// only pads the canvas. See the note on CreateAgentOptions.scale.
const captureScale = 1;
const playerCount = heroMode
  ? HERO_ROSTER_INDICES.length
  : Number(arg('players', String(ROSTER.length)));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(OUTPUT_ROOT, `${heroMode ? 'hero' : profile}-${stamp}`);
const videoDir = path.join(runDir, 'video');
fs.mkdirSync(videoDir, { recursive: true });

const logPath = path.join(runDir, 'run.log');
const log = (m: string): void => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

log(
  `Run: ${profile}${heroMode ? ' (HERO capture — hand-picked cohort for close-ups)' : ''}  ` +
    `players=${playerCount}  minutes=${durationMinutes}`,
);
log(`Scenario: ${SCENARIO_TITLE}`);
log(`Output: ${runDir}`);

await waitForApi();
const { adminAgent, players } = await provisionCohort(
  playerCount,
  log,
  heroMode ? HERO_ROSTER_INDICES : undefined,
);
const facts = await loadFactSheet();
log(`Fact sheet: ${facts.confirmed.length} confirmed, ${facts.falseClaims.length} unsupported claims`);

const browsers: Browser[] = await launchPool();
log(`Launched ${browsers.length} browser processes`);

const session = await createSession(
  adminAgent,
  `${profile === 'novice' ? 'Baseline (pre-training)' : 'Post-training'} capture — automated demo`,
);
log(`Session ${session.id}  join ${session.join_token}`);

// --- Trainer screen ---------------------------------------------------------
const trainerBrowser = browsers[0];
const trainerCtx = await createAgentBrowser({
  browser: trainerBrowser,
  label: 'trainer-dashboard',
  viewport: TRAINER_VIEWPORT,
  videoDir,
  session: adminAgent.session,
});
// handleStartSession can raise a confirm(); Playwright dismisses dialogs by
// default, which would silently cancel the start.
trainerCtx.page.on('dialog', (d) => void d.accept());

await trainerCtx.page.goto(`${APP_BASE}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' });
await sleep(4000);
log('Trainer is in the lobby');

// --- Players join, staggered ------------------------------------------------
interface Seat {
  auth: Agent & { spec: (typeof ROSTER)[number] };
  ctx: Awaited<ReturnType<typeof createAgentBrowser>>;
  agent?: PlayerAgent;
  timeline?: Timeline;
}

const seats: Seat[] = [];

for (let i = 0; i < players.length; i++) {
  const p = players[i];
  const label = `p${String(p.spec.index).padStart(2, '0')}-${p.spec.name.replace(/\W+/g, '')}`;
  const ctx = await createAgentBrowser({
    browser: browsers[1 + (i % Math.max(1, browsers.length - 1))],
    label,
    viewport: p.spec.view === 'phone' ? PLAYER_VIEWPORT : TRAINER_VIEWPORT,
    videoDir,
    session: p.session,
    scale: captureScale,
  });
  seats.push({ auth: p, ctx });

  // Join through the real form, with backoff for the join rate limiter.
  let joined = false;
  for (let attempt = 0; attempt < 6 && !joined; attempt++) {
    try {
      await ctx.page.goto(`${APP_BASE}/join/${session.join_token}`, {
        waitUntil: 'domcontentloaded',
      });
      await ctx.page.locator('#displayName').waitFor({ state: 'visible', timeout: 30_000 });
      await ctx.page.fill('#displayName', '');
      await ctx.page.locator('#displayName').pressSequentially(p.spec.name, { delay: 28 });
      await ctx.page.selectOption('#teamName', p.spec.team);
      await humanClick(ctx.page, 'button:has-text("Join session")');
      await ctx.page.waitForURL(/\/sessions\//, { timeout: 45_000 });
      joined = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log(`  ${p.spec.name}: join attempt ${attempt + 1} failed (${msg}); backing off`);
      await sleep(20_000);
    }
  }
  if (!joined) {
    log(`  !! ${p.spec.name} could not join; continuing without them`);
    continue;
  }

  await tryClick(ctx.page, 'button:has-text("Mark me as ready")', 15_000);
  log(`  ${p.spec.name} joined ${p.spec.team} (${i + 1}/${players.length})`);
  if (i < players.length - 1) await sleep(joinStaggerSec * 1000);
}

const active = seats.filter((s) => s.ctx.page.url().includes('/sessions/'));
log(`${active.length}/${players.length} players in the lobby`);

// --- Give Communications the official AMP voice ------------------------------
// Nobody can post as the organisation without a page controller assignment, so
// the official-statement objective would be unreachable and the compose modal
// would not even show the "Posting as" toggle.
try {
  const pages = await listOrgPages(adminAgent, session.id);
  const amp =
    pages.find((p) => p.role === 'protagonist' && p.is_primary) ??
    pages.find((p) => p.role === 'protagonist');

  if (!amp) {
    log('!! no protagonist org page found — official statements will not be possible');
  } else {
    const comms = active
      .filter((s) => s.auth.spec.team === 'Communications')
      .sort((a, b) => a.auth.spec.index - b.auth.spec.index)
      .slice(0, 2);
    for (const s of comms) {
      await assignOrgPage(adminAgent, session.id, s.auth.userId, amp.org_key);
      log(`  ${s.auth.spec.name} now controls "${amp.display_name}"`);
    }
  }
} catch (err) {
  log(`!! page assignment failed: ${err instanceof Error ? err.message : String(err)}`);
}

// --- Start ------------------------------------------------------------------
await trainerCtx.page.reload({ waitUntil: 'domcontentloaded' });
await sleep(5000);

let started = await tryClick(trainerCtx.page, 'button:has-text("Start session")', 30_000);
if (!started) {
  log('Start button not clickable; starting via API instead');
  await setSessionStatus(adminAgent, session.id, 'in_progress');
  started = true;
}
log('Session started');
await sleep(9000);

const watchdog = new Watchdog({ sessionId: session.id, trainer: adminAgent, log });
await watchdog.syncStartTime();
watchdog.start();

// Trainer settles on the live dashboard for the rest of the run. A single slow
// navigation must not end the capture — everyone else is already playing.
let dashboardUp = false;
for (let attempt = 1; attempt <= 4 && !dashboardUp; attempt++) {
  try {
    await trainerCtx.page.goto(`${APP_BASE}/sim/${session.id}/trainer`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    dashboardUp = true;
  } catch (err) {
    log(
      `  trainer dashboard load attempt ${attempt} failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    );
    await sleep(5000);
  }
}
await sleep(4000);
log(dashboardUp ? 'Trainer dashboard is live' : '!! trainer dashboard never loaded — continuing without it');

// --- Onboard and play -------------------------------------------------------
let stopping = false;
const shouldStop = (): boolean => stopping;

for (const seat of active) {
  const label = `p${String(seat.auth.spec.index).padStart(2, '0')}-${seat.auth.spec.name.replace(/\W+/g, '')}`;
  seat.timeline = new Timeline(
    seat.ctx.videoStartMs,
    label,
    seat.auth.spec.view === 'phone' ? PLAYER_VIEWPORT : TRAINER_VIEWPORT,
    captureScale,
  );
  seat.agent = new PlayerAgent({
    auth: seat.auth,
    spec: seat.auth.spec,
    page: seat.ctx.page,
    sessionId: session.id,
    profile,
    facts,
    runMinutes: durationMinutes,
    timeline: seat.timeline,
    log,
  });
}

// Onboarding modals, a few at a time so 25 renderers do not stampede.
for (let i = 0; i < active.length; i += 5) {
  await Promise.all(active.slice(i, i + 5).map((s) => s.agent!.onboard().catch(() => undefined)));
}
log('All players onboarded');

// Keep the trainer view alive so the recording is not a frozen frame.
const trainerIdle = (async () => {
  while (!stopping) {
    await humanScroll(trainerCtx.page, 220).catch(() => undefined);
    await sleep(20_000);
    await trainerCtx.page.mouse.move(960, 540, { steps: 8 }).catch(() => undefined);
    await sleep(20_000);
  }
})();

const playing = active.map((s) =>
  s.agent!.run(watchdog.elapsedMinutes, shouldStop, watchdog.paused).catch((err) => {
    log(`${s.auth.spec.name}: loop died — ${err instanceof Error ? err.message : String(err)}`);
  }),
);

// Run until the scenario clock reaches the target, ignoring paused time.
// The wall-clock cap is a backstop: the scenario clock is derived from
// start_time, and if that ever fails to resolve the loop would spin forever.
const wallDeadline = Date.now() + (durationMinutes + 15) * 60_000;
let cappedByWallClock = false;
while (watchdog.elapsedMinutes() < durationMinutes) {
  if (Date.now() > wallDeadline) {
    cappedByWallClock = true;
    break;
  }
  await sleep(10_000);
}
stopping = true;
log(
  cappedByWallClock
    ? `!! wall-clock cap hit at T+${watchdog.elapsedMinutes()}m (session clock stalled) — winding down`
    : `Reached T+${watchdog.elapsedMinutes()}m — winding down`,
);

await Promise.all(playing);
await trainerIdle;

// --- Conclude ---------------------------------------------------------------
if (!(await tryClick(trainerCtx.page, 'button:has-text("Conclude Session")', 20_000))) {
  log('Conclude button not clickable; concluding via API');
  await setSessionStatus(adminAgent, session.id, 'completed');
}
await sleep(8000);
await watchdog.stop();
log('Session concluded');

// --- Teardown and manifest --------------------------------------------------
// Closing a recording context flushes its video, and closing all 26 at once
// starved the disk badly enough that most files sat at zero bytes for twenty
// minutes. Flush in small batches instead.
const finishers = [trainerCtx, ...active.map((s) => s.ctx)];
log(`Flushing ${finishers.length} videos...`);
const FLUSH_BATCH = 4;
for (let i = 0; i < finishers.length; i += FLUSH_BATCH) {
  const batch = finishers.slice(i, i + FLUSH_BATCH);
  await Promise.all(batch.map((f) => f.finish().catch(() => undefined)));
  log(`  ${Math.min(i + FLUSH_BATCH, finishers.length)}/${finishers.length} written`);
}
await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));

const manifest = {
  profile,
  scenario: SCENARIO_TITLE,
  sessionId: session.id,
  startedAt: new Date(Date.now() - durationMinutes * 60_000).toISOString(),
  durationMinutes,
  outageMs: watchdog.outageMs,
  trainerVideo: path.basename(trainerCtx.videoPath() ?? ''),
  players: active.map((s) => ({
    index: s.auth.spec.index,
    name: s.auth.spec.name,
    team: s.auth.spec.team,
    view: s.auth.spec.view,
    video: path.basename(s.ctx.videoPath() ?? ''),
    stats: s.agent?.stats ?? null,
  })),
  samples: watchdog.samples,
};
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Shot timeline: where on screen each action happened, and when in each video.
// The trailer builder crops to these rectangles instead of guessing.
const timelines = active.map((s) => s.timeline).filter((t): t is Timeline => Boolean(t));
if (timelines.length) {
  const shotsPath = writeTimelines(runDir, timelines);
  const shotCount = timelines.reduce((n, t) => n + t.events.length, 0);
  log(`Recorded ${shotCount} shots across ${timelines.length} screens -> ${path.basename(shotsPath)}`);
}

const totalActions = manifest.players.reduce((n, p) => n + (p.stats?.actions ?? 0), 0);
const totalFailures = manifest.players.reduce((n, p) => n + (p.stats?.failures ?? 0), 0);
const last = watchdog.samples.at(-1);

log('');
log(`Done. ${totalActions} actions, ${totalFailures} failures.`);
log(
  `Brain: ${brainStats.calls} LLM calls, ${brainStats.fallbacks} fell back to heuristics` +
    (brainStats.lastError ? ` (last: ${brainStats.lastError})` : ''),
);
if (last) {
  log(
    `Final gauges — sentiment ${last.sentiment}, trust ${last.publicTrust}, ` +
      `narrative ${last.narrativeControl}, escalation ${last.escalationRisk}`,
  );
  log(`Posts ${last.posts} (players ${last.playerPosts}), injects ${last.injectsPublished}`);
}
log(`Artifacts: ${runDir}`);
