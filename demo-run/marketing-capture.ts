/**
 * Captures the imagery for the Corporate Crisis marketing page.
 *
 *   npx tsx demo-run/clone-scenario.ts      # once, to make the fictional scenario
 *   npx tsx demo-run/marketing-capture.ts   # then this
 *   npx tsx demo-run/marketing-assets.ts    # then encode what this produced
 *
 * Needs the API on 3001 and frontend/dist served on 3002, and that build MUST be
 * made with VITE_ENABLE_TEST_HOOKS=true. Without it the app never exposes
 * window.__supabase, so the harness cannot hand a context a pre-minted session
 * and every page load stalls on the login screen. Rebuild without the flag
 * afterwards: the hook must not ship.
 *
 * Why this exists rather than reusing shoot.ts: that pipeline films a 29-sequence
 * trailer over about twenty minutes and writes take timings for an editor. The
 * marketing page needs twelve specific screens and four short clips, so this
 * drives exactly those and captures each one at the moment it is on screen. It
 * runs in a few minutes and the same command reproduces the same assets, which
 * matters because these end up on a public page and will need updating whenever
 * the product's UI moves.
 *
 * Stills are PNG screenshots rather than extracted video frames. Playwright
 * captures video at the CSS viewport size and VP8 softens small text, so a
 * screenshot is both sharper and honest about what the UI actually looks like.
 * Clips still come out of the recording, so they carry marks for ffmpeg to trim.
 *
 * Nothing here needs the inject scheduler. Every screen is loaded after its
 * dressing is in place, and the one beat that has to move on camera — the
 * engagement counters — is driven by the product's own polling.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { APP_BASE, OUTPUT_ROOT } from './config.js';
import {
  createAgentBrowser,
  humanClick,
  humanDoubleClick,
  humanScroll,
  humanType,
  launchPool,
  readAlong,
  tryClick,
  type AgentBrowser,
} from './browser.js';
import {
  assignOrgPage,
  createSession,
  listOrgPages,
  provisionCohort,
  setSessionStatus,
  sleep,
  waitForApi,
} from './lib.js';
import {
  CAST,
  CHAT,
  ORG,
  POSTS,
  dressFeed,
  dressInbox,
  dressNews,
  pruneFeed,
  rampEngagement,
  seedComments,
  QUESTION_ECHOES,
} from './marketing-set.js';

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(OUTPUT_ROOT, `marketing-${stamp}`);
const shotDir = path.join(outDir, 'shots');
const videoDir = path.join(outDir, 'video');
fs.mkdirSync(shotDir, { recursive: true });

const logFile = path.join(outDir, 'capture.log');
const log = (m: string): void => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(logFile, `${line}\n`);
};

/** Desktop shots want the pixels; the phone shell is a fixed frame either way. */
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const PHONE_VIEWPORT = { width: 1280, height: 800 };
const TRAINER_VIEWPORT = { width: 1920, height: 1080 };

/**
 * The handset inside the phone viewport. Cropping at capture time means the
 * shipped asset is the device and not a device on a field of empty navy.
 */
const HANDSET = { x: 360, y: 0, width: 560, height: 800 };

interface Mark {
  name: string;
  video: string;
  inSec: number;
  outSec: number;
  /** ffmpeg crop for the encoder, when the clip is a phone shell. */
  crop?: string;
}

const marks: Mark[] = [];
const captured: string[] = [];
const missed: string[] = [];

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

class Cam {
  constructor(
    private readonly agent: AgentBrowser,
    readonly label: string,
    private readonly crop?: { x: number; y: number; width: number; height: number },
  ) {}

  get page(): Page {
    return this.agent.page;
  }

  private get elapsedSec(): number {
    return (Date.now() - this.agent.videoStartMs) / 1000;
  }

  /** A still. Cropped to this camera's frame unless told otherwise. */
  async shot(name: string, opts: { full?: boolean } = {}): Promise<void> {
    try {
      await this.page.screenshot({
        path: path.join(shotDir, `${name}.png`),
        clip: opts.full ? undefined : this.crop,
      });
      captured.push(name);
      log(`    shot ${name}`);
    } catch (err) {
      missed.push(name);
      log(`    MISSED shot ${name}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }

  /**
   * A clip. Records the in/out offsets against this context's recording so the
   * encoder can trim it later; Playwright only flushes the file on close.
   */
  async roll(name: string, body: () => Promise<void>): Promise<void> {
    // A beat of stillness at each end, so the cut does not land mid-motion.
    await sleep(400);
    const inSec = this.elapsedSec;
    try {
      await body();
      await sleep(500);
      marks.push({
        name,
        video: `${this.label}.webm`,
        inSec,
        outSec: this.elapsedSec,
        crop: this.crop
          ? `${this.crop.width}:${this.crop.height}:${this.crop.x}:${this.crop.y}`
          : undefined,
      });
      captured.push(`${name} (clip)`);
      log(`    clip ${name}  ${(this.elapsedSec - inSec).toFixed(1)}s`);
    } catch (err) {
      missed.push(`${name} (clip)`);
      log(`    MISSED clip ${name}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }

  finish(): Promise<void> {
    return this.agent.finish();
  }
}

/** Runs a capture step without letting one bad selector end the run. */
async function step(name: string, body: () => Promise<void>): Promise<void> {
  log(`  ${name}`);
  try {
    await body();
  } catch (err) {
    missed.push(name);
    log(`    STEP FAILED ${name}: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
  }
}

// ---------------------------------------------------------------------------
// UI map. Same testids the trailer shoot drives.
// ---------------------------------------------------------------------------

const DESK = {
  icon: (app: string) => `[data-testid="desktop-icon-${app}"]`,
  taskbar: (app: string) => `[data-testid="taskbar-${app}"]`,
  window: (app: string) => `[data-testid="window-${app}"]`,
};
const FB = {
  post: (id: string) => `[data-testid="fb-post-${id}"]`,
  composeOpen: '[data-testid="fb-compose-open"]',
  composeText: '[data-testid="fb-compose-text"]',
  composeSubmit: '[data-testid="fb-compose-submit"]',
  asPage: '[data-testid="fb-compose-as-page"]',
  reportOpen: 'button[title="Report post"]',
};
const REPORT = {
  option: (v: string) => `[data-testid="report-option-${v}"]`,
  reason: '[data-testid="report-reason"]',
  submit: '[data-testid="report-submit"]',
};
const CHAT_INPUT =
  'input[placeholder="Type a message"], input[placeholder="Type or speak a message..."]';

async function launch(page: Page, app: string): Promise<void> {
  await humanDoubleClick(page, DESK.icon(app), 15_000);
  await page.locator(DESK.window(app)).first().waitFor({ state: 'visible', timeout: 18_000 });
  await sleep(1400);
}

/**
 * Clear the device onboarding.
 *
 * The demographic questions are generated from the scenario, so the clone's
 * options differ from the trailer's. Rather than name them, take the first
 * option offered in each group.
 */
async function onboardPhone(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${APP_BASE}/sim/${sessionId}/device`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  for (let group = 0; group < 5; group++) {
    const options = page.locator('button:not([type="submit"])');
    const count = await options.count().catch(() => 0);
    if (count === 0) break;
    if (await tryClick(page, 'button:text-is("Continue")', 900)) {
      await sleep(900);
      continue;
    }
    // First selectable answer in whatever group is showing.
    await tryClick(page, 'button:not(:has-text("Continue")):not(:has-text("Got it"))', 1500);
    await sleep(400);
  }
  await tryClick(page, 'button:text-is("Continue")', 6000);
  await sleep(1400);
  await tryClick(page, 'button:text-is("Got it")', 5000);
  await sleep(1000);
}

const phoneApp = (page: Page, sessionId: string, app: string): Promise<unknown> =>
  page
    .goto(`${APP_BASE}/sim/${sessionId}/device/${app}`, { waitUntil: 'domcontentloaded' })
    .then(() => sleep(2600));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const handoffPath = path.join('demo-run', '.marketing-scenario.json');
if (!fs.existsSync(handoffPath)) {
  throw new Error('No fictional scenario yet. Run: npx tsx demo-run/clone-scenario.ts');
}
const { scenarioId } = JSON.parse(fs.readFileSync(handoffPath, 'utf8')) as { scenarioId: string };

log(`Marketing capture -> ${outDir}`);
log(`Scenario ${scenarioId} (${ORG.name})`);

log('Waiting for the API...');
await waitForApi();

const { adminAgent, players } = await provisionCohort(
  CAST.length,
  log,
  CAST.map((c) => c.index),
);

const session = await createSession(
  adminAgent,
  'MARKETING CAPTURE — staged, discard after',
  scenarioId,
);
log(`Session ${session.id}  join ${session.join_token}`);

const browsers = await launchPool(3);

// One recorded context per shell. The desktop gets the big viewport because its
// shots are full-window; the phone shell is a fixed frame, so a larger viewport
// would only add empty space around the handset.
const deskCam = new Cam(
  await createAgentBrowser({
    browser: browsers[0],
    label: 'desktop',
    viewport: DESKTOP_VIEWPORT,
    videoDir,
    session: players[0].session,
  }),
  'desktop',
);
const phoneCam = new Cam(
  await createAgentBrowser({
    browser: browsers[1],
    label: 'phone',
    viewport: PHONE_VIEWPORT,
    videoDir,
    session: players[2].session,
  }),
  'phone',
  HANDSET,
);
const legalCam = new Cam(
  await createAgentBrowser({
    browser: browsers[2],
    label: 'legal',
    viewport: DESKTOP_VIEWPORT,
    videoDir,
    session: players[1].session,
  }),
  'legal',
);
// scale 2 only helps the screenshots, which do honour device pixel ratio — the
// caveat in browser.ts is about video. The dashboard is the densest thing on the
// marketing page, so its two crops are the ones worth the extra pixels. No
// recording: nothing uses a trainer clip, and a 4K encode running alongside three
// other contexts is what timed out a join.
const trainerCam = new Cam(
  await createAgentBrowser({
    browser: browsers[0],
    label: 'trainer',
    viewport: TRAINER_VIEWPORT,
    videoDir,
    session: adminAgent.session,
    scale: 2,
    record: false,
  }),
  'trainer',
);
trainerCam.page.on('dialog', (d) => void d.accept());

// Join through the real form: /api/join is rate limited to 10 requests a minute.
const cams = [deskCam, legalCam, phoneCam];
for (let i = 0; i < players.length; i++) {
  const role = CAST[i];
  const page = cams[i].page;
  await page.goto(`${APP_BASE}/join/${session.join_token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#displayName').waitFor({ state: 'visible', timeout: 30_000 });
  await page.fill('#displayName', role.name);
  await page.selectOption('#teamName', role.team);
  await humanClick(page, 'button:has-text("Join session")');
  await page.waitForURL(/\/sessions\//, { timeout: 45_000 });
  await tryClick(page, 'button:has-text("Mark me as ready")', 12_000);
  log(`  cast: ${role.name} (${role.team})`);
  await sleep(6000);
}

// Without a page controller the composer never offers the "Posting as" toggle,
// which is the whole point of two of the shots.
const orgPages = await listOrgPages(adminAgent, session.id);
const primary = orgPages.find((p) => p.role === 'protagonist' && p.is_primary) ?? orgPages[0];
if (primary) {
  await assignOrgPage(adminAgent, session.id, players[0].userId, primary.org_key);
  log(`  page control -> ${CAST[0].name} (${primary.org_key})`);
}

await setSessionStatus(adminAgent, session.id, 'in_progress');
await sleep(8000);
log('Session live');

// ---------------------------------------------------------------------------
// Dressing
// ---------------------------------------------------------------------------

// The turn is held back and inserted later, so that until then the loudest thing
// in the feed is the misinformation rather than the post that resolves it.
const OPENING_KEYS = POSTS.map((p) => p.key).filter((k) => k !== 'reassured');

// Twice, once per surface: Fakebook for the desktop windows and the report sheet,
// the short-post app for the phone feed shots.
const fbIds = await dressFeed(session.id, OPENING_KEYS, log, 'facebook');
const zIds = await dressFeed(session.id, OPENING_KEYS, log, 'x_twitter');
await dressNews(session.id, undefined, log);
await dressInbox(session.id, undefined, log);

/** Everything this run put in the feed. Anything else gets pruned before a shot. */
const staged = new Set<string>([...fbIds.values(), ...zIds.values()]);

const questionId = fbIds.get('question');
if (questionId) {
  const echoes = await seedComments(session.id, questionId, QUESTION_ECHOES, log);
  echoes.forEach((id) => staged.add(id));
}

const prune = (): Promise<number> => pruneFeed(session.id, staged, log);

for (const cam of cams) await onboardPhone(cam.page, session.id);
log('Cast onboarded');

// ---------------------------------------------------------------------------
// DESKTOP
// ---------------------------------------------------------------------------

log('\nDesktop');

await step('desk-idle', async () => {
  await deskCam.page.goto(`${APP_BASE}/sim/${session.id}/desktop`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(4000);
  await deskCam.shot('desk-idle');
});

await step('clip-desk + desk-teamchat', async () => {
  await deskCam.roll('clip-desk', async () => {
    await humanDoubleClick(deskCam.page, DESK.icon('facebook'), 15_000);
    await deskCam.page
      .locator(DESK.window('facebook'))
      .first()
      .waitFor({ state: 'visible', timeout: 18_000 });
    await sleep(1600);
    await launch(deskCam.page, 'chat');
    await sleep(1200);
  });
  await deskCam.shot('desk-teamchat');
});

// Legal's half of the crisis-cell argument, typed live so the window in the
// desktop shot has a real conversation in it rather than one lonely line.
await step('crisis cell chat', async () => {
  await legalCam.page.goto(`${APP_BASE}/sim/${session.id}/desktop`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(3000);
  await launch(legalCam.page, 'chat');

  for (const line of CHAT) {
    const page = line.from === CAST[1].name ? legalCam.page : deskCam.page;
    await humanType(page, CHAT_INPUT, line.text, { msPerChar: 12 });
    await sleep(200);
    // Enter only. Typing and then also clicking submit sent some lines twice,
    // which is visible in the window as a duplicated message.
    await page.keyboard.press('Enter');
    await sleep(1600);
  }
  await sleep(1200);
  await deskCam.shot('desk-teamchat');
});

await step('desk-report', async () => {
  const luxury = fbIds.get('lie-luxury');
  await prune();
  await legalCam.page.goto(`${APP_BASE}/sim/${session.id}/desktop`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(3000);
  await launch(legalCam.page, 'facebook');
  if (luxury) {
    await legalCam.page
      .locator(FB.post(luxury))
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await sleep(700);
    const scoped = `${FB.post(luxury)} ${FB.reportOpen}`;
    if (!(await tryClick(legalCam.page, scoped, 6000))) {
      await tryClick(legalCam.page, FB.reportOpen, 6000);
    }
  } else {
    await tryClick(legalCam.page, FB.reportOpen, 6000);
  }
  await sleep(1600);
  await legalCam.shot('desk-report');
});

await step('clip-statement + desk-compose', async () => {
  const statement = `The review concerns one programme: the ${ORG.programme}. Case reference ${ORG.caseRef}. No assistance has been frozen. Grant and tuition disbursements are running on schedule.`;

  await deskCam.page.goto(`${APP_BASE}/sim/${session.id}/desktop`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(3200);
  await launch(deskCam.page, 'facebook');
  await tryClick(deskCam.page, FB.composeOpen, 8000);
  await sleep(1000);
  // Speak as the organisation, not as the person. This is the toggle the shot is of.
  await tryClick(deskCam.page, FB.asPage, 6000);
  await sleep(900);

  await deskCam.roll('clip-statement', async () => {
    await humanType(deskCam.page, FB.composeText, statement, { msPerChar: 14 });
    await sleep(800);
  });
  await deskCam.shot('desk-compose');

  // Publish it. Not for a shot — this is what gives the trainer dashboard a real
  // time-to-official-statement instead of a dash, and the dashboard is an asset.
  if (await tryClick(deskCam.page, FB.composeSubmit, 6000)) {
    log('    statement published');
    await sleep(2500);
  }
});

// ---------------------------------------------------------------------------
// PHONE
// ---------------------------------------------------------------------------

log('\nPhone');

await step('news-breaking', async () => {
  await phoneApp(phoneCam.page, session.id, 'news');
  await tryClick(phoneCam.page, `text=/confirms financial mismanagement/i`, 8000);
  await sleep(2000);
  await readAlong(phoneCam.page, 'body', { stops: 3, msPerStop: 420 });
  await phoneCam.shot('news-breaking');
});

await step('email-deadline', async () => {
  await phoneApp(phoneCam.page, session.id, 'email');
  await tryClick(phoneCam.page, 'text=/Request for comment/i', 8000);
  await sleep(2200);
  await phoneCam.shot('email-deadline');
});

// "For You" ranks by virality, and the staged misinformation carries the highest
// scores in the set, so it puts the three false claims at the top of the feed —
// which is what the pile-on shots are of. "Latest" would lead with whatever the
// generators posted most recently.
await step('feed shots', async () => {
  await prune();
  await phoneApp(phoneCam.page, session.id, 'social');
  await sleep(2400);
  await phoneCam.shot('feed-pileon');

  await humanScroll(phoneCam.page, 420);
  await sleep(1400);
  await phoneCam.shot('feed-engagement');
});

await step('clip-pileon', async () => {
  const million = zIds.get('lie-million');
  if (!million) throw new Error('no lie-million post id');
  await prune();
  await phoneApp(phoneCam.page, session.id, 'social');
  await sleep(2200);
  await humanScroll(phoneCam.page, 260);
  await sleep(900);

  await phoneCam.roll('clip-pileon', async () => {
    // The feed polls rather than streaming counter updates, so stepping the
    // numbers repeatedly across the take reads as a climb rather than one jump.
    await rampEngagement(million, { steps: 5, everyMs: 1700, startViews: 251_000 }, log);
  });
});

// Reporting is captured on Fakebook rather than the short-post app: it is the
// surface with the full category sheet, which is the part worth showing.
await step('report-misinfo + clip-report', async () => {
  const luxury = fbIds.get('lie-luxury');
  await prune();
  await phoneApp(phoneCam.page, session.id, 'facebook');
  await sleep(2600);

  if (luxury) {
    await phoneCam.page
      .locator(FB.post(luxury))
      .first()
      .scrollIntoViewIfNeeded({ timeout: 8000 })
      .catch(() => undefined);
    await sleep(800);
  }

  await phoneCam.roll('clip-report', async () => {
    const scoped = luxury ? `${FB.post(luxury)} ${FB.reportOpen}` : FB.reportOpen;
    if (!(await tryClick(phoneCam.page, scoped, 6000))) {
      await tryClick(phoneCam.page, FB.reportOpen, 6000);
    }
    await sleep(1400);
    await tryClick(phoneCam.page, REPORT.option('misinformation'), 5000);
    await sleep(900);

    // Only type if the field actually arrived. humanType retries four times with
    // its own budget, which turned one missing selector into three lost minutes.
    const reason = phoneCam.page.locator(REPORT.reason).first();
    if (await reason.isVisible({ timeout: 6000 }).catch(() => false)) {
      await humanType(
        phoneCam.page,
        REPORT.reason,
        `No account freeze notice exists. Grant disbursement is running on schedule under case reference ${ORG.caseRef}.`,
        { msPerChar: 15, attempts: 1 },
      );
      await sleep(900);
    } else {
      throw new Error('report reason field never appeared');
    }
  });
  await phoneCam.shot('report-misinfo');

  // Submit it, so the dashboard's report-precision figure is a real score.
  if (await tryClick(phoneCam.page, REPORT.submit, 6000)) {
    log('    report submitted');
    await sleep(2000);
  }
});

// The turn goes in last and fresh, so it is the newest thing in the feed and the
// shot does not depend on scrolling past the crisis to find it.
await step('feed-turn', async () => {
  await prune();
  const turnIds = await dressFeed(session.id, ['reassured'], log, 'x_twitter');
  turnIds.forEach((id) => staged.add(id));
  const reassured = turnIds.get('reassured');
  await phoneApp(phoneCam.page, session.id, 'social');
  await sleep(2200);
  await tryClick(phoneCam.page, 'button:text-is("Latest")', 4000);
  await sleep(2400);
  if (reassured) {
    await phoneCam.page
      .locator(FB.post(reassured))
      .first()
      .scrollIntoViewIfNeeded({ timeout: 8000 })
      .catch(() => undefined);
    await sleep(1200);
  }
  await phoneCam.shot('feed-turn');
});

// ---------------------------------------------------------------------------
// TRAINER
// ---------------------------------------------------------------------------

log('\nTrainer');

// One screenshot, two assets. The gauge panel and the classified-posts panel sit
// side by side at the top of the dashboard, so both crops come out of the same
// frame — which also avoids guessing a scroll distance that changes with how much
// the session has accumulated.
await step('trainer-dashboard', async () => {
  // Down to one platform. The dashboard lists rows, not stories, so the same
  // claim staged on both surfaces appears twice in the harmful-posts panel and
  // reads as the product double-counting.
  const single = new Set<string>(fbIds.values());
  await pruneFeed(session.id, single, log);

  await trainerCam.page.goto(`${APP_BASE}/sim/${session.id}/trainer`, {
    waitUntil: 'domcontentloaded',
  });
  // The scoring engine ticks about every 30s, and the gauges read NaN until it
  // has run at least once. This also lets the statement and report land as scores
  // rather than as dashes.
  await sleep(45_000);
  await trainerCam.shot('trainer-dashboard', { full: true });
});

// ---------------------------------------------------------------------------
// Down
// ---------------------------------------------------------------------------

log('\nWrapping up');
await setSessionStatus(adminAgent, session.id, 'completed').catch(() => undefined);

for (const cam of [deskCam, legalCam, phoneCam, trainerCam]) {
  await cam.finish().catch(() => undefined);
}
for (const b of browsers) await b.close().catch(() => undefined);

fs.writeFileSync(
  path.join(outDir, 'marks.json'),
  `${JSON.stringify({ sessionId: session.id, scenarioId, org: ORG.name, marks }, null, 2)}\n`,
);

log(`\nCaptured ${captured.length}: ${captured.join(', ')}`);
if (missed.length > 0) log(`Missed ${missed.length}: ${missed.join(', ')}`);
log(`\nOutput: ${outDir}`);
log('Next: npx tsx demo-run/marketing-assets.ts');
