/**
 * Shot runner — the film production pass.
 *
 * Executes the 29 sequences in demo-run/storyboard.ts as continuous takes of
 * the real product being used. Three rules it exists to enforce:
 *
 *   1. Everything happens inside the shipped desktop shell. Apps open from
 *      icons, minimise to the taskbar, and every switch goes back through the
 *      desk — the windowed environment is a large part of what is being sold.
 *
 *   2. Anything that ARRIVES on camera arrives over the socket. The device apps
 *      have no polling and no Supabase realtime, so a direct row insert is
 *      invisible to an open page. Posts and emails are published as injects,
 *      DMs go through the messenger endpoint, comments are authenticated
 *      replies, counters move via the like route.
 *
 *   3. Typing is typing. Real keystrokes at speed, never a fill.
 *
 * A sequence emits one take with internal beats, so the edit can cut on the
 * exact instant a message landed or a pointer reached a deadline.
 *
 *   npx tsx demo-run/shoot.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import {
  APP_BASE,
  OUTPUT_ROOT,
  PLAYER_VIEWPORT,
  SCENARIO_ID,
  SCENARIO_TITLE,
  TRAINER_VIEWPORT,
} from './config.js';
import {
  createAgentBrowser,
  humanClick,
  humanDoubleClick,
  humanScroll,
  humanType,
  launchPool,
  readAlong,
  rectOf,
  tryClick,
  type AgentBrowser,
} from './browser.js';
import {
  assignOrgPage,
  createSession,
  likePost,
  listOrgPages,
  postComment,
  provisionCohort,
  provisionVoices,
  publishInject,
  sendDM,
  setSessionStatus,
  sleep,
  waitForApi,
  type Agent,
} from './lib.js';
import {
  PHOTOS,
  PRELOAD_KEYS,
  armLiveInjects,
  attachPhoto,
  dressInbox,
  dressNews,
  dressSet,
  newestPost,
} from './stage.js';
import { SEQUENCES, seqSec } from './storyboard.js';

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const shootDir = path.join(OUTPUT_ROOT, `shoot-${stamp}`);
const videoDir = path.join(shootDir, 'video');
fs.mkdirSync(videoDir, { recursive: true });

const log = (m: string): void => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(shootDir, 'shoot.log'), line + '\n');
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Take {
  /** Storyboard sequence number. */
  seq: number;
  title: string;
  video: string;
  inSec: number;
  outSec: number;
  rect: Rect | null;
  /**
   * Instants inside the take worth cutting on, in seconds from `inSec`: a
   * message landing, a post arriving, a pointer reaching the deadline line.
   */
  beats: { at: number; label: string }[];
  /** The sequence threw partway; the beats listed did land. */
  partial?: boolean;
}

const takes: Take[] = [];
const failures: { seq: number; title: string; reason: string }[] = [];

const plan = (n: number) => {
  const s = SEQUENCES.find((x) => x.n === n);
  if (!s) throw new Error(`No storyboard sequence ${n}`);
  return s;
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const HOLD_MS = 1000;

/** Centre the element before measuring, so crops are composed not accidental. */
async function frame(page: Page, selector: string, timeoutMs = 12_000): Promise<Rect | null> {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    await loc.evaluate((el) =>
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior }),
    );
    await sleep(420);
    const box = await loc.boundingBox();
    return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
  } catch {
    return null;
  }
}

class Camera {
  constructor(
    readonly ctx: AgentBrowser,
    readonly label: string,
  ) {}

  get page(): Page {
    return this.ctx.page;
  }

  private nowSec(): number {
    return (Date.now() - this.ctx.videoStartMs) / 1000;
  }

  /**
   * Roll one continuous sequence. `mark` flags beats inside it.
   *
   * A sequence that throws is recorded as far as it got and the shoot carries
   * on. Learned the hard way: one missing selector in sequence 15 aborted the
   * process and discarded fourteen good sequences that were already on disk,
   * because the video contexts never got flushed. A partial reel you can cut
   * from beats a perfect one that does not exist.
   */
  async roll(
    seq: number,
    opts: { rect?: Rect | null; hold?: boolean },
    body: (mark: (label: string) => void) => Promise<void>,
  ): Promise<void> {
    const s = plan(seq);
    if (opts.hold !== false) await sleep(HOLD_MS);
    const inSec = this.nowSec();
    const beats: { at: number; label: string }[] = [];
    log(`SEQ ${String(seq).padStart(2, '0')}  ${s.title}  (${seqSec(s)}s planned)`);

    let failed: string | null = null;
    try {
      await body((label) => {
        beats.push({ at: +(this.nowSec() - inSec).toFixed(2), label });
        log(`    · ${label}`);
      });
    } catch (err) {
      failed = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log(`    !! SEQ ${seq} failed after ${beats.length} beats: ${failed}`);
      failures.push({ seq, title: s.title, reason: failed });
    }

    const outSec = this.nowSec();
    if (opts.hold !== false) await sleep(HOLD_MS);

    // Keep even a partial take: the beats that did land are still usable.
    if (beats.length || !failed) {
      takes.push({
        seq,
        title: s.title,
        video: `${this.label}.webm`,
        inSec,
        outSec,
        rect: opts.rect ?? null,
        beats,
        partial: failed ? true : undefined,
      });
    }
    log(`    ${(outSec - inSec).toFixed(1)}s captured, ${beats.length} beats${failed ? ' (PARTIAL)' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// UI map
// ---------------------------------------------------------------------------

const DESK = {
  icon: (app: string) => `[data-testid="desktop-icon-${app}"]`,
  taskbar: (app: string) => `[data-testid="taskbar-${app}"]`,
  window: (app: string) => `[data-testid="window-${app}"]`,
  minimise: (app: string) => `[data-testid="window-minimize-${app}"]`,
};

const FB = {
  post: (id: string) => `[data-testid="fb-post-${id}"]`,
  commentBtn: (id: string) => `[data-testid="fb-comment-${id}"]`,
  commentInput: (id: string) => `[data-testid="fb-comment-input-${id}"]`,
  commentSend: (id: string) => `[data-testid="fb-comment-send-${id}"]`,
  composeOpen: '[data-testid="fb-compose-open"]',
  composeText: '[data-testid="fb-compose-text"]',
  composeSubmit: '[data-testid="fb-compose-submit"]',
  asPage: '[data-testid="fb-compose-as-page"]',
  format: (v: string) => `[data-testid="fb-format-${v}"]`,
  reportOpen: 'button[title="Report post"]',
  messengerOpen: '[data-testid="fb-messenger-open"]',
  messengerView: '[data-testid="fb-messenger-view"]',
};

const REPORT = {
  option: (v: string) => `[data-testid="report-option-${v}"]`,
  reason: '[data-testid="report-reason"]',
  submit: '[data-testid="report-submit"]',
};

const NEWS = {
  disputeOpen: '[data-testid="news-dispute-open"]',
  retracted: '[data-testid="news-retracted-banner"]',
};

const DISPUTE = {
  note: '[data-testid="dispute-note"]',
  submit: '[data-testid="dispute-submit"]',
};

const MAIL = {
  reply: '[data-testid="mail-reply"]',
  send: '[data-testid="mail-send"]',
  body: 'textarea[placeholder="Write your reply..."]',
  list: '[data-testid="mail-list"]',
  thread: '[data-testid="mail-thread"]',
};

const CHAT_INPUT =
  'input[placeholder="Type a message"], input[placeholder="Type or speak a message..."]';
const CHAT_LIST = '[data-testid="chat-messages"]';

const DEMOGRAPHICS = [['26-35', '36-50'], ['Male', 'Female'], ['Islam'], ['Malay']];

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

async function onboardPhone(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${APP_BASE}/sim/${sessionId}/device`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  for (const group of DEMOGRAPHICS) {
    for (const option of group) {
      if (await tryClick(page, `button:text-is("${option}")`, 2200)) break;
    }
  }
  await tryClick(page, 'button:text-is("Continue")', 7000);
  await sleep(1500);
  await tryClick(page, 'button:text-is("Got it")', 5000);
  await sleep(900);
}

/** Land on the bare desktop, no windows. */
async function toDesktop(page: Page, sessionId: string): Promise<void> {
  await page.goto(`${APP_BASE}/sim/${sessionId}/desktop`, { waitUntil: 'domcontentloaded' });
  await sleep(3200);
}

/**
 * Open an app the way a person would: cross the desk, double-click the icon.
 *
 * Not a URL navigation. The window-open transition, the taskbar entry appearing
 * and the icon being physically hit are the shots.
 */
async function launch(page: Page, app: string): Promise<void> {
  await humanDoubleClick(page, DESK.icon(app), 12_000);
  await page.locator(DESK.window(app)).first().waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(1400);
}

/** Collapse a window to the taskbar and let the wallpaper breathe. */
async function minimise(page: Page, app: string): Promise<void> {
  await humanClick(page, DESK.minimise(app), 10_000);
  await sleep(1100);
}

/**
 * Make an app's window the one you are looking at.
 *
 * Must not blindly click the taskbar: the shell's taskbar button is a toggle,
 * so clicking it on an already-focused window MINIMISES it. That cost two
 * sequences on the first full run — the reply composer was never visible
 * because the window had just been hidden.
 */
async function focus(page: Page, app: string): Promise<void> {
  const win = page.locator(DESK.window(app)).first();
  if (await win.isVisible().catch(() => false)) {
    await sleep(250);
    return;
  }
  await humanClick(page, DESK.taskbar(app), 10_000);
  await win.waitFor({ state: 'visible', timeout: 15_000 });
  await sleep(1200);
}

/**
 * Expand a post's comment thread and wait for its input to exist.
 *
 * The comment box is only mounted once the thread is expanded, so typing into
 * it without opening it first just waits for an element that will never appear.
 */
async function openComments(page: Page, postId: string): Promise<boolean> {
  const input = page.locator(FB.commentInput(postId)).first();
  if (await input.isVisible().catch(() => false)) return true;
  await frame(page, FB.post(postId));
  await tryClick(page, FB.commentBtn(postId), 6000);
  try {
    await input.waitFor({ state: 'visible', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Phone shell app navigation, for the two phone sequences. */
const phoneApp = async (page: Page, sessionId: string, app: string): Promise<void> => {
  await page.goto(`${APP_BASE}/sim/${sessionId}/device/${app}`, { waitUntil: 'domcontentloaded' });
  await sleep(2400);
};

/** Send one line into the open chat channel, with a gap so it lands as an event. */
async function say(
  page: Page,
  text: string,
  opts: { msPerChar?: number; after?: number } = {},
): Promise<void> {
  const { msPerChar = 13, after = 1500 } = opts;
  await humanType(page, CHAT_INPUT, text, { msPerChar });
  await sleep(240);
  if (!(await tryClick(page, 'button[type="submit"]', 3000))) {
    await page.keyboard.press('Enter');
  }
  await sleep(after);
}

/** A line from the other side, with a think-pause so it reads as a person. */
async function reply(
  from: Page,
  text: string,
  opts: { think?: number; msPerChar?: number; after?: number } = {},
): Promise<void> {
  const { think = 900, ...rest } = opts;
  await sleep(think);
  await say(from, text, rest);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

log(`Shoot: ${SCENARIO_TITLE}`);
log(`Output: ${shootDir}`);
log(`Plan: ${SEQUENCES.length} sequences, 1-28 performed (29 is graphics)`);
await waitForApi();

/** Team players who appear on camera. */
const CAST = [1, 2, 3, 4, 6, 7, 16, 18];

/** Crowd voices. Accounts only — they never join and never get a browser. */
const VOICES = [
  { key: 'friend', name: 'Aisyah Kamal' },
  { key: 'siti', name: 'Puan Siti Rahimah' },
  { key: 'rohana', name: 'Rohana Bte Salleh' },
  { key: 'zul', name: 'Zulkarnain' },
  { key: 'kalthom', name: 'Mdm Kalthom' },
  { key: 'hakim', name: 'Hakim' },
  { key: 'nurain', name: 'Nur Ain' },
  { key: 'rosli', name: 'Rosli B.' },
  { key: 'watch', name: 'Accountability Watch SG' },
  { key: 'jenn', name: 'Jenn Low' },
  { key: 'hafizah', name: 'Hafizah' },
];

const { adminAgent, players } = await provisionCohort(CAST.length, log, CAST);
const voices = await provisionVoices(VOICES, log);
const voice = (key: string): Agent => {
  const v = voices.get(key);
  if (!v) throw new Error(`No voice account "${key}"`);
  return v;
};

const session = await createSession(adminAgent, 'TRAILER SHOOT — staged, discard after');
log(`Session ${session.id}  join ${session.join_token}`);

const browsers = await launchPool(3);

const trainerCam = new Camera(
  await createAgentBrowser({
    browser: browsers[0],
    label: 'trainer',
    viewport: TRAINER_VIEWPORT,
    videoDir,
    session: adminAgent.session,
  }),
  'trainer',
);
trainerCam.page.on('dialog', (d) => void d.accept());

const cams = new Map<number, Camera>();
for (let i = 0; i < players.length; i++) {
  const p = players[i];
  const label = `c${String(p.spec.index).padStart(2, '0')}-${p.spec.name.replace(/\W+/g, '')}`;
  const ctx = await createAgentBrowser({
    browser: browsers[1 + (i % 2)],
    label,
    viewport: PLAYER_VIEWPORT,
    videoDir,
    session: p.session,
  });
  cams.set(p.spec.index, new Camera(ctx, label));

  // Join through the real form; /api/join is limited to 10 req/min per IP.
  await ctx.page.goto(`${APP_BASE}/join/${session.join_token}`, { waitUntil: 'domcontentloaded' });
  await ctx.page.locator('#displayName').waitFor({ state: 'visible', timeout: 30_000 });
  await ctx.page.fill('#displayName', p.spec.name);
  await ctx.page.selectOption('#teamName', p.spec.team);
  await humanClick(ctx.page, 'button:has-text("Join session")');
  await ctx.page.waitForURL(/\/sessions\//, { timeout: 45_000 });
  await tryClick(ctx.page, 'button:has-text("Mark me as ready")', 12_000);
  log(`  cast: ${p.spec.name} (${p.spec.team})`);
  await sleep(14_000);
}

// Only the Communications lead speaks as AMP.
const orgPages = await listOrgPages(adminAgent, session.id);
const amp = orgPages.find((pg) => pg.role === 'protagonist' && pg.is_primary) ?? orgPages[0];
{
  const p = players.find((x) => x.spec.index === 1);
  if (p && amp) await assignOrgPage(adminAgent, session.id, p.userId, amp.org_key);
}
log('AMP page control assigned to the Communications lead');

await setSessionStatus(adminAgent, session.id, 'in_progress');
await sleep(8000);
log('Session live');

// The two phone characters need the device onboarding cleared before rolling.
const farah = cams.get(3)!;
const amirah = cams.get(18)!;
const daniel = cams.get(2)!;
const priya = cams.get(4)!;
const shahrizal = cams.get(6)!;
const grace = cams.get(7)!;
const faizal = cams.get(16)!;
const nurul = cams.get(1)!;

for (const cam of cams.values()) await onboardPhone(cam.page, session.id);
log('Cast onboarded');

// Pre-crisis dressing: inserted directly, because every page loads after it.
const staged = await dressSet(session.id, [...PRELOAD_KEYS], log);
await dressNews(session.id, undefined, log);
await dressInbox(session.id, ['email-funder', 'email-mosque'], log);

// Live content: armed now, fired on cue.
const injects = await armLiveInjects(session.id, SCENARIO_ID, undefined, log);
const fire = async (key: string): Promise<void> => {
  const id = injects.get(key);
  if (!id) throw new Error(`No armed inject for "${key}"`);
  await publishInject(adminAgent, id, session.id);
};

const need = (key: string): string => {
  const id = staged.get(key);
  if (!id) throw new Error(`Set dressing missing "${key}"`);
  return id;
};
const QUESTION = need('question');
const MEDIA_SHARE = need('media-share');

/** Resolve a live-published post's id by its author handle. */
const liveId = async (handle: string): Promise<string> => {
  const { admin } = await import('./lib.js');
  for (let i = 0; i < 12; i++) {
    const { data } = await admin
      .from('social_posts')
      .select('id')
      .eq('session_id', session.id)
      .eq('author_handle', handle)
      .is('reply_to_post_id', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (data?.[0]?.id) return data[0].id as string;
    await sleep(700);
  }
  throw new Error(`Published post from ${handle} never appeared`);
};

// ===========================================================================
// ACT I — AN ORDINARY AFTERNOON
// ===========================================================================
log('');
log('ACT I — an ordinary afternoon');

await toDesktop(farah.page, session.id);

await farah.roll(1, { rect: null }, async (mark) => {
  await sleep(2600); // the bare desk
  mark('desktop');
  await frame(farah.page, DESK.icon('facebook'));
  mark('reach');
  await launch(farah.page, 'facebook');
  mark('window-open');
});

await farah.roll(2, { rect: await frame(farah.page, DESK.window('facebook')) }, async (mark) => {
  await humanScroll(farah.page, 320);
  await sleep(1400);
  mark('ordinary-feed');
  await humanScroll(farah.page, 300);
  await sleep(1600);
  mark('unhurried');
  await sleep(1800);
  mark('badge');
});

// The DM. Sent live from the friend's account so it lands on camera.
await farah.roll(3, { rect: null }, async (mark) => {
  // Send first, so there is a thread for the messenger pane to show, then open
  // it and let the second message land while it is on screen.
  await sendDM(
    voice('friend'),
    session.id,
    '@farah_iskandar',
    'eh… is this about your company or not? 😬',
    MEDIA_SHARE,
  );
  await sleep(1200);
  await humanClick(farah.page, FB.messengerOpen, 9000);
  await sleep(1400);
  await tryClick(farah.page, FB.messengerView, 6000);
  await sleep(2200);
  mark('open-messenger');
  await sendDM(
    voice('friend'),
    session.id,
    '@farah_iskandar',
    'the whole feed is talking about it 😳',
  );
  await sleep(3000);
  mark('dm-lands');
  await sleep(1800);
  mark('opens-card');
});

await farah.roll(4, { rect: null }, async (mark) => {
  await minimise(farah.page, 'facebook');
  await sleep(1300);
  mark('minimised');
  await launch(farah.page, 'news');
  mark('news-open');
});

await farah.roll(5, { rect: await frame(farah.page, 'text=/AMP confirms financial mismanagement/i') }, async (mark) => {
  await sleep(2000);
  mark('headline');
  await tryClick(farah.page, 'text=/AMP confirms financial mismanagement/i', 6000);
  await sleep(1800);
  await readAlong(farah.page, DESK.window('news'), { stops: 5, msPerStop: 560 });
  await humanScroll(farah.page, 220);
  mark('read-down');
});

// The return. Injects fire while the camera is on the feed.
await farah.roll(6, { rect: null }, async (mark) => {
  await minimise(farah.page, 'news');
  await focus(farah.page, 'facebook');
  mark('restored');
  await fire('accusation');
  await sleep(3000);
  mark('accusation');
  await fire('lie-frozen');
  await sleep(2600);
  mark('lie-1-lands');
  await fire('lie-million');
  await sleep(2600);
  mark('lie-2-lands');
  await humanScroll(farah.page, 300);
  await fire('lie-luxury');
  await sleep(2600);
  mark('lie-3-lands');
  await fire('crowd');
  await sleep(2600);
  mark('crowd-lands');
});

const LIE_FROZEN = await liveId('@whistle_sg');
const LIE_MILLION = await liveId('@frontline_wire');
const LIE_LUXURY = await liveId('@clips_that_land');
const CROWD = await liveId('@sgvoices_now');
const ACCUSATION = await liveId('@auditAMPnow');
log(`Live posts resolved: frozen=${LIE_FROZEN} million=${LIE_MILLION} luxury=${LIE_LUXURY}`);

// ===========================================================================
// ACT II — THE QUESTION
// ===========================================================================
log('');
log('ACT II — the question');

await phoneApp(amirah.page, session.id, 'facebook');
await amirah.roll(7, { rect: await frame(amirah.page, FB.post(QUESTION)) }, async (mark) => {
  await sleep(2400);
  mark('scroll-onto-it');
  await sleep(2600);
  mark('the-line');
  await tryClick(amirah.page, FB.commentBtn(QUESTION), 5000);
  for (const [key, text] of [
    ['rohana', 'Sama. Saya apply bulan lepas, sampai sekarang tak dengar apa-apa. Anak saya Sec 3.'],
    ['zul', 'Just tell us yes or no lah. We can plan. It is the not knowing that kills.'],
    ['kalthom', 'Saya call office tiga kali. Tiada orang angkat.'],
    ['hakim', 'My sister works there. Even she doesn’t know what to tell people.'],
    ['nurain', 'Sekolah buka minggu depan. Tolonglah jawab satu soalan sahaja.'],
  ] as const) {
    await postComment(voice(key), session.id, QUESTION, text);
    await sleep(1400);
    mark(`comment-${key}`);
  }
});

// ===========================================================================
// ACT III — THE LIE OUTRUNS THE TRUTH
// ===========================================================================
log('');
log('ACT III — the lie outruns the truth');

await phoneApp(daniel.page, session.id, 'facebook');
await daniel.roll(8, { rect: null }, async (mark) => {
  for (let i = 0; i < 7; i++) {
    await daniel.page.mouse.wheel(0, 400);
    await sleep(85);
  }
  await sleep(800);
  mark('whip-down');
  await frame(daniel.page, FB.post(LIE_FROZEN));
  // Drive the counters through the like route so the UI patches them live and
  // the new count-up animation rolls each figure upward.
  for (const key of ['rosli', 'watch', 'jenn', 'hafizah', 'hakim', 'zul']) {
    await likePost(voice(key), LIE_FROZEN).catch(() => undefined);
    await sleep(900);
  }
  mark('counters-climbing');
  await fire('rival');
  await sleep(2800);
  mark('rival-lands');
});

await farah.roll(9, { rect: await frame(farah.page, FB.post(LIE_LUXURY)) }, async (mark) => {
  await sleep(2200);
  mark('the-image');
  await sleep(1800);
  mark('the-caption');
  await tryClick(farah.page, FB.commentBtn(LIE_LUXURY), 5000);
  for (const [key, text] of [
    ['rosli', 'And they still ask for donations every Ramadan. Shameless.'],
    ['watch', 'Still no statement. Silence is an answer too.'],
    ['jenn', 'Cancelled my monthly giro this morning. Enough.'],
    ['hafizah', 'My mother queued four hours last week. FOUR HOURS.'],
  ] as const) {
    await postComment(voice(key), session.id, LIE_LUXURY, text);
    await sleep(1300);
    mark(`pressure-${key}`);
  }
});

await toDesktop(priya.page, session.id);
await priya.roll(10, { rect: null }, async (mark) => {
  await launch(priya.page, 'email');
  mark('mail-open');
  // The press deadline arrives while the inbox is on screen.
  const pressInject = injects.get('email-press');
  if (pressInject) await publishInject(adminAgent, pressInject, session.id);
  await sleep(3200);
  mark('mail-arrives');
  await tryClick(priya.page, 'text=/Request for comment/i', 6000);
  await sleep(2000);
  await readAlong(priya.page, MAIL.thread, { stops: 5, msPerStop: 560 });
  mark('read-to-deadline');
});

await toDesktop(faizal.page, session.id);
await launch(faizal.page, 'facebook');
await faizal.roll(11, { rect: await frame(faizal.page, FB.post(CROWD)) }, async (mark) => {
  await sleep(2200);
  mark('it-lands');
  await sleep(1800);
  mark('the-line');
});

await trainerCam.page.goto(`${APP_BASE}/sim/${session.id}/trainer`, {
  waitUntil: 'domcontentloaded',
});
await sleep(4500);
await trainerCam.roll(12, { rect: await frame(trainerCam.page, 'text=/Public Trust/i') }, async (mark) => {
  // Reload once so the gauges animate from their previous values and the
  // sparkline draws, rather than mounting already-settled.
  await trainerCam.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(5000);
  mark('gauges-move');
});

// ===========================================================================
// ACT IV — FIGHTING BACK
// ===========================================================================
log('');
log('ACT IV — fighting back');

await toDesktop(grace.page, session.id);
await launch(grace.page, 'facebook');

await grace.roll(13, { rect: null }, async (mark) => {
  await readAlong(grace.page, FB.post(LIE_MILLION), { stops: 4, msPerStop: 620 });
  await humanScroll(grace.page, 240);
  await readAlong(grace.page, FB.post(LIE_FROZEN), { stops: 4, msPerStop: 620 });
  mark('working-the-feed');
  await frame(grace.page, FB.post(LIE_FROZEN));
  await sleep(1800);
  mark('that-one-is-false');
});

await grace.roll(14, { rect: null }, async (mark) => {
  await humanClick(grace.page, `${FB.post(LIE_FROZEN)} ${FB.reportOpen}`, 10_000);
  await sleep(1600);
  mark('report-open');
  await humanClick(grace.page, REPORT.option('misinformation'), 8000);
  await sleep(1200);
  mark('category-picked');
  await humanType(
    grace.page,
    REPORT.reason,
    'No account freeze notice has been issued or received. Bursary and tuition disbursements are running on schedule. Review scope published under case reference AMP-IR-2026-014.',
    { msPerChar: 11 },
  );
  mark('reason-typed');
  await humanClick(grace.page, REPORT.submit, 8000);
  await sleep(2400);
  mark('submitted');
});

await grace.roll(15, { rect: null }, async (mark) => {
  await minimise(grace.page, 'facebook');
  await launch(grace.page, 'news');
  mark('news-open');
  await tryClick(grace.page, 'text=/Where did the money go/i', 8000);
  await sleep(2200);
  mark('false-article');
  await humanClick(grace.page, NEWS.disputeOpen, 10_000);
  await sleep(1600);
  mark('takedown-sheet');
  await humanType(
    grace.page,
    DISPUTE.note,
    'The article states all assistance has been frozen. This is false. No freeze notice has been issued or received, and bursary disbursement is running on its normal schedule. Independent review scope is published under AMP-IR-2026-014.',
    { msPerChar: 11 },
  );
  mark('claim-filed');
  await humanClick(grace.page, DISPUTE.submit, 8000);
  await sleep(2600);
  mark('submitted');
});

/**
 * The adjudicator deliberately waits 60-180s to simulate editorial review, so
 * the retraction shot cannot be taken immediately. Fill the gap with the Act V
 * sequences that do not depend on it, then come back.
 */
const retractionDeadline = Date.now() + 210_000;

// ===========================================================================
// ACT V — THE MISTAKE
// ===========================================================================
log('');
log('ACT V — the mistake');

await toDesktop(shahrizal.page, session.id);
await launch(shahrizal.page, 'chat');
await toDesktop(nurul.page, session.id);

await nurul.roll(17, { rect: null }, async (mark) => {
  await launch(nurul.page, 'chat');
  mark('chat-open');
  await say(nurul.page, 'We are 40 minutes into silence. Something has to go out.');
  mark('she-pushes');
  await reply(
    shahrizal.page,
    'Not until I have the case reference. We cannot confirm a figure we do not have.',
  );
  mark('legal-pushes-back');
  await say(nurul.page, 'Then a holding line. Just put something out now.');
  await reply(shahrizal.page, 'A holding line that says nothing will be read as a dodge.', {
    think: 1200,
  });
  mark('she-overrides');
});

const WEAK =
  'We are aware of the concerns being raised online and we take them seriously. AMP is committed to accountability and we will share more information in due course.';

await nurul.roll(18, { rect: null }, async (mark) => {
  await minimise(nurul.page, 'chat');
  await launch(nurul.page, 'facebook');
  mark('switch-windows');
  await tryClick(nurul.page, FB.composeOpen, 9000);
  await sleep(800);
  await tryClick(nurul.page, FB.format('official_statement'), 4000);
  await sleep(400);
  await humanClick(nurul.page, FB.asPage, 6000);
  await sleep(900);
  mark('become-the-org');
  const submitRect = await rectOf(nurul.page, FB.composeSubmit, 6000);
  await frame(nurul.page, FB.composeText);
  await humanType(nurul.page, FB.composeText, WEAK, { msPerChar: 12 });
  mark('real-keystrokes');
  void submitRect;
  await humanClick(nurul.page, FB.composeSubmit, 12_000);
  await sleep(2000);
  mark('post');
});

const weakPostId = await newestPost(session.id, 'official_account');
if (!weakPostId) throw new Error('The holding statement did not persist');
log(`Holding statement: ${weakPostId}`);

await phoneApp(daniel.page, session.id, 'facebook');
await daniel.roll(19, { rect: null }, async (mark) => {
  await frame(daniel.page, FB.post(weakPostId));
  await sleep(2000);
  mark('it-appears');
  await tryClick(daniel.page, FB.commentBtn(weakPostId), 5000);
  for (const [key, text] of [
    ['watch', 'This is not an answer. Which programme? How much? You had all day.'],
    ['rosli', '“In due course” = we are still deciding what to admit.'],
    ['jenn', 'Zero numbers. Zero names. Zero dates. Try again.'],
    ['siti', 'Saya baca tiga kali. Masih tak tahu anak saya dapat bantuan atau tidak.'],
    ['hakim', 'A mother asked you one question. Answer the mother.'],
  ] as const) {
    await postComment(voice(key), session.id, weakPostId, text);
    await sleep(1400);
    mark(`callout-${key}`);
  }
});

await trainerCam.roll(20, { rect: await frame(trainerCam.page, 'text=/Public Trust/i') }, async (mark) => {
  await trainerCam.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(5000);
  mark('trust-falls-again');
});

// --- back to Act IV's payoff, now that review has had time to land ---------
const waitLeft = retractionDeadline - Date.now();
if (waitLeft > 0) {
  log(`Waiting ${Math.round(waitLeft / 1000)}s for the dispute adjudication...`);
  await sleep(waitLeft);
}

await grace.roll(16, { rect: null }, async (mark) => {
  await grace.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await tryClick(grace.page, 'text=/Where did the money go/i', 8000);
  await sleep(2400);
  const gone = await grace.page.locator(NEWS.retracted).first().isVisible().catch(() => false);
  log(gone ? '  retraction banner is up' : '  WARNING: no retraction banner — dispute not upheld');
  mark('retracted');
  await minimise(grace.page, 'news');
  await focus(grace.page, 'facebook');
  await grace.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
  mark('propagates');
});

// ===========================================================================
// ACT VI — THE TURN
// ===========================================================================
log('');
log('ACT VI — the turn');

await nurul.roll(21, { rect: null }, async (mark) => {
  await minimise(nurul.page, 'facebook');
  await focus(nurul.page, 'chat');
  await reply(shahrizal.page, 'Case ref AMP-IR-2026-014 cleared for release.', {
    think: 500,
    after: 1200,
  });
  mark('case-ref');
  await reply(
    shahrizal.page,
    'Scope is the Community Uplift Initiative only. No account freeze notice exists.',
    { think: 400, after: 1200 },
  );
  mark('scope');
  await reply(shahrizal.page, 'Bursary disbursement schedule unaffected — confirmed with Finance.', {
    think: 400,
    after: 1200,
  });
  mark('bursary');
  await say(nurul.page, 'Good. Rewriting now. Naming the programme and the reference.');
  mark('she-decides');
});

const STATEMENT =
  'The review concerns one programme: the Community Uplift Initiative. Case reference AMP-IR-2026-014. No assistance has been frozen. Bursary and tuition disbursements are running on schedule — the counter was open this morning. Claims of a $1m shortfall are false and we have asked for them to be corrected.';

await nurul.roll(22, { rect: null }, async (mark) => {
  await minimise(nurul.page, 'chat');
  await focus(nurul.page, 'facebook');
  await tryClick(nurul.page, FB.composeOpen, 9000);
  await sleep(800);
  await tryClick(nurul.page, FB.format('official_statement'), 4000);
  await sleep(400);
  await tryClick(nurul.page, FB.asPage, 5000);
  await sleep(700);
  await frame(nurul.page, FB.composeText);
  await humanType(nurul.page, FB.composeText, STATEMENT, { msPerChar: 11 });
  mark('specific-version');
  await humanClick(nurul.page, FB.composeSubmit, 12_000);
  await sleep(2600);

  const goodPostId = await newestPost(session.id, 'official_account');
  if (goodPostId) {
    await attachPhoto(goodPostId, PHOTOS.communityHall);
    await sleep(1800);
    await nurul.page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(3000);
    await frame(nurul.page, FB.post(goodPostId));
    mark('proof-attached');
    await sleep(2000);
    mark('it-lands');
  }
});

await farah.roll(23, { rect: null }, async (mark) => {
  await focus(farah.page, 'facebook').catch(() => undefined);
  await frame(farah.page, FB.post(LIE_LUXURY));
  await tryClick(farah.page, FB.commentBtn(LIE_LUXURY), 8000);
  await sleep(1200);
  mark('under-the-lie');
  await humanType(
    farah.page,
    FB.commentInput(LIE_LUXURY),
    'This image is not from any AMP programme account. No hospitality has been charged to programme funds. Review scope and case reference AMP-IR-2026-014 are published on our page.',
    { msPerChar: 12 },
  );
  await sleep(400);
  if (!(await tryClick(farah.page, FB.commentSend(LIE_LUXURY), 4000))) {
    await farah.page.keyboard.press('Enter');
  }
  await sleep(1600);
  mark('typed-in-place');
});

await priya.roll(24, { rect: null }, async (mark) => {
  await focus(priya.page, 'email').catch(() => undefined);
  await tryClick(priya.page, 'text=/Request for comment/i', 6000);
  await sleep(1800);
  await humanClick(priya.page, MAIL.reply, 8000);
  await sleep(1200);
  mark('reply-open');
  await humanType(
    priya.page,
    MAIL.body,
    '1. The Community Uplift Initiative, covering FY2025. Case reference AMP-IR-2026-014.\n' +
      '2. No. Bursary and tuition assistance are disbursing on the normal schedule.\n' +
      '3. No figure has been established. The $1m figure circulating online is not ours.',
    { msPerChar: 10 },
  );
  mark('three-answers');
  await humanClick(priya.page, MAIL.send, 6000);
  await sleep(1800);
  mark('send');
});

await trainerCam.roll(25, { rect: await frame(trainerCam.page, 'text=/Public Trust/i') }, async (mark) => {
  await trainerCam.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(5000);
  mark('rising');
});

// ===========================================================================
// ACT VII — THE ANSWER
// ===========================================================================
log('');
log('ACT VII — the answer');

// The comms lead answers her by name, off camera; it is filmed arriving.
// Wrapped: this sits between rolls, so an exception here would escape the
// per-sequence recovery and kill the process before any video is flushed.
try {
  await focus(nurul.page, 'facebook');
  if (await openComments(nurul.page, QUESTION)) {
    await humanType(
      nurul.page,
      FB.commentInput(QUESTION),
      'Puan Siti — your application is not affected. Bursary disbursement for the new school term is on schedule and the counter is open daily until 5pm. Please quote AMP-IR-2026-014 at the counter and we will trace it the same day.',
      { msPerChar: 11 },
    );
    await sleep(400);
    if (!(await tryClick(nurul.page, FB.commentSend(QUESTION), 4000))) {
      await nurul.page.keyboard.press('Enter');
    }
    log('AMP reply posted under her question');
  } else {
    // Fall back to the API so Act VII still has something to answer.
    const ampAgent = players.find((p) => p.spec.index === 1);
    if (ampAgent) {
      await postComment(
        ampAgent,
        session.id,
        QUESTION,
        'Puan Siti — your application is not affected. Bursary disbursement for the new school term is on schedule and the counter is open daily until 5pm. Please quote AMP-IR-2026-014 at the counter and we will trace it the same day.',
      );
      log('AMP reply posted via API (composer never opened)');
    }
  }
} catch (err) {
  log(`  !! AMP reply failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
}

await phoneApp(amirah.page, session.id, 'facebook');
await openComments(amirah.page, QUESTION);
await sleep(1500);

await amirah.roll(26, { rect: await frame(amirah.page, FB.post(QUESTION)) }, async (mark) => {
  await sleep(2000);
  mark('her-post-again');
  await sleep(3000);
  mark('reply-arrives');
});

await amirah.roll(27, { rect: await frame(amirah.page, FB.post(QUESTION)) }, async (mark) => {
  await postComment(
    voice('siti'),
    session.id,
    QUESTION,
    'Alhamdulillah. Terima kasih sebab jawab. Itu saja yang kami minta.',
  );
  await sleep(3400);
  mark('she-answers');
  await sleep(2600);
  mark('hold');
});

// ---------------------------------------------------------------------------
// Wrap
// ---------------------------------------------------------------------------

log('');
const covered = new Set(takes.map((t) => t.seq));
const missing = SEQUENCES.filter((s) => s.n <= 28 && !covered.has(s.n)).map((s) => s.n);
const partials = takes.filter((t) => t.partial).map((t) => t.seq);
log(`${takes.length} takes, covering ${covered.size}/28 performed sequences`);
if (partials.length) log(`PARTIAL: sequences ${partials.join(', ')}`);
if (missing.length) log(`MISSING: sequences ${missing.join(', ')} — sequence 28 is the mosaic`);
for (const f of failures) log(`  seq ${f.seq} (${f.title}): ${f.reason}`);

await setSessionStatus(adminAgent, session.id, 'completed');

log('Flushing video...');
const finishers: { label: string; ctx: AgentBrowser }[] = [
  { label: trainerCam.label, ctx: trainerCam.ctx },
  ...[...cams.values()].map((c) => ({ label: c.label, ctx: c.ctx })),
];
for (let i = 0; i < finishers.length; i += 3) {
  await Promise.all(finishers.slice(i, i + 3).map((f) => f.ctx.finish().catch(() => undefined)));
  log(`  ${Math.min(i + 3, finishers.length)}/${finishers.length} written`);
}
await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));

fs.writeFileSync(
  path.join(shootDir, 'takes.json'),
  JSON.stringify({ sessionId: session.id, viewport: PLAYER_VIEWPORT, takes, failures }, null, 2),
);
log(`Wrote ${path.join(shootDir, 'takes.json')}`);
log(`Shoot complete: ${shootDir}`);
