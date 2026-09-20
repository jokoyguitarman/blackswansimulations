/**
 * Playwright harness: one isolated, video-recorded browser context per agent.
 *
 * Each context has its own storage, its own Supabase session and its own socket,
 * so the server sees 26 independent clients. Contexts are spread across a small
 * pool of Chromium processes so a single crash cannot take down the whole cohort.
 *
 * Two cosmetic details matter because the output is footage, not a test report:
 * Playwright renders no mouse pointer, and instant text insertion looks robotic.
 * `installCursor` draws a pointer that tracks real input events, and `humanType`
 * types character by character.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '@supabase/supabase-js';
import { APP_BASE, BROWSER_POOL_SIZE } from './config.js';
import { sleep } from './lib.js';

export interface AgentBrowser {
  context: BrowserContext;
  page: Page;
  /** Wall clock when recording began; timeline offsets are relative to this. */
  videoStartMs: number;
  /** Final video path, resolved after `finish()`. */
  videoPath: () => string | null;
  finish: () => Promise<void>;
}

export async function launchPool(size = BROWSER_POOL_SIZE): Promise<Browser[]> {
  return Promise.all(
    Array.from({ length: size }, () =>
      chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          // 25 contexts on one box: keep each renderer lean.
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--mute-audio',
          '--force-device-scale-factor=1',
        ],
      }),
    ),
  );
}

/**
 * A pointer that follows the synthetic input Playwright dispatches.
 *
 * Shaped like the ordinary system arrow rather than a dot: a dot reads as a
 * touch indicator or a laser pointer, and the trailer needs the audience to
 * recognise instantly that they are watching somebody use a computer. The tip
 * sits exactly on the event coordinate, so it points at what it is clicking.
 */
const CURSOR_SCRIPT = `
(() => {
  if (window.__cursorInstalled) return;
  window.__cursorInstalled = true;
  const install = () => {
    if (!document.body) return void requestAnimationFrame(install);
    const dot = document.createElement('div');
    dot.setAttribute('data-demo-cursor', '');
    dot.style.cssText = [
      'position:fixed','left:0','top:0','width:22px','height:26px',
      'pointer-events:none','z-index:2147483647','transition:transform .06s linear',
      'opacity:0','transform-origin:0 0',
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))'
    ].join(';');
    // Classic arrowhead, hotspot at 0,0 so the tip lands on the real position.
    dot.innerHTML =
      '<svg width="22" height="26" viewBox="0 0 22 26" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1 1 L1 19.2 L5.7 14.6 L8.9 21.8 L12.1 20.4 L9 13.4 L15.4 13.1 Z" ' +
      'fill="#FFFFFF" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(dot);

    let x = window.innerWidth / 2, y = window.innerHeight / 2;
    let scale = 1;
    const draw = () => {
      dot.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    };
    draw();

    document.addEventListener('mousemove', (e) => {
      x = e.clientX; y = e.clientY; dot.style.opacity = '1'; draw();
    }, true);

    // Two registers. 'normal' is the pointer you watch someone click with.
    // 'subtle' is the one that guides the eye down a page of text without
    // becoming the subject of the shot.
    // Two registers. 'normal' is the pointer you watch someone click with.
    // 'subtle' is the one that guides the eye down a page of text without
    // becoming the subject of the shot — same arrow, quieter and slower.
    window.__cursorMode = (mode) => {
      if (mode === 'subtle') {
        scale = 0.78;
        dot.style.opacity = '.72';
        dot.style.transition = 'transform .2s cubic-bezier(.33,.7,.4,1)';
      } else {
        scale = 1;
        dot.style.opacity = '1';
        dot.style.transition = 'transform .06s linear';
      }
      draw();
    };

    document.addEventListener('mousedown', () => {
      dot.style.opacity = '1';
      // Brief press-down on the arrow itself, the way a real click feels.
      const held = scale;
      scale = held * 0.86;
      draw();
      setTimeout(() => { scale = held; draw(); }, 110);

      const ring = document.createElement('div');
      ring.style.cssText = [
        'position:fixed','left:' + x + 'px','top:' + y + 'px','width:14px','height:14px',
        'margin:-7px 0 0 -7px','border-radius:50%','border:2px solid rgba(56,189,248,.95)',
        'pointer-events:none','z-index:2147483646'
      ].join(';');
      document.body.appendChild(ring);
      ring.animate(
        [{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }],
        { duration: 420, easing: 'ease-out' }
      ).onfinish = () => ring.remove();
    }, true);
  };
  install();
})();
`;

export interface CreateAgentOptions {
  browser: Browser;
  /** Filesystem-safe label, used for the video filename. */
  label: string;
  viewport: { width: number; height: number };
  videoDir: string;
  session: Session;
  /**
   * Device pixel ratio.
   *
   * WARNING: this does NOT increase video resolution. Playwright captures at the
   * CSS viewport size regardless; raising deviceScaleFactor and the recordVideo
   * size just yields a larger canvas with the normal-resolution capture in the
   * top-left corner and grey padding elsewhere. Measured on a hero capture that
   * recorded 3840x2160 files containing 1920x1080 of actual content.
   *
   * Leave at 1. To get more content pixels, enlarge the CSS viewport instead —
   * though that does not help the phone shell, which is a fixed-size frame.
   *
   * Screenshots are the exception: page.screenshot() does honour this, so a
   * context that only needs stills can raise it and get sharper output.
   */
  scale?: number;
  /**
   * Record video for this context. Default true.
   *
   * Turn it off for a context that only contributes screenshots. Recording is a
   * continuous encode, and at scale 2 it is four times the pixels for a file
   * nothing reads — enough to slow the whole pool and time out a join.
   */
  record?: boolean;
}

export async function createAgentBrowser(opts: CreateAgentOptions): Promise<AgentBrowser> {
  const { browser, label, viewport, videoDir, session, scale = 1, record = true } = opts;
  fs.mkdirSync(videoDir, { recursive: true });

  // Recording starts with the context, so this is the zero point for shot times.
  const videoStartMs = Date.now();
  const context = await browser.newContext({
    viewport,
    ...(record
      ? {
          recordVideo: {
            dir: videoDir,
            size: { width: viewport.width * scale, height: viewport.height * scale },
          },
        }
      : {}),
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    deviceScaleFactor: scale,
    // The sim asks for mic/camera on voice-call injects; pre-grant so no
    // permission prompt lands in the middle of a recording.
    permissions: ['microphone'],
  });

  // Playwright's 30s default means one stuck action holds an agent (and the
  // whole run's teardown) far too long when 26 contexts are competing for CPU.
  context.setDefaultTimeout(15_000);
  // Navigation is a different budget entirely: these pages fan out to Supabase
  // on load, so a brief connectivity wobble blows a 15s limit that is perfectly
  // sensible for clicking a button.
  context.setDefaultNavigationTimeout(60_000);

  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  // Boot the app once so its Supabase client exists, then hand it a session
  // that was minted server-side. Driving 26 password logins through the UI
  // would trip Supabase's sign-in throttle.
  await page.goto(`${APP_BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('Boolean(window.__supabase)', undefined, { timeout: 30_000 });

  // Evaluated as a string: esbuild's keepNames transform injects a `__name`
  // helper into named function expressions, which does not exist in the page.
  const result = (await page.evaluate(
    `window.__supabase.auth.setSession(${JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    })}).then(r => (r.error ? r.error.message : null))`,
  )) as string | null;
  if (result) throw new Error(`setSession failed for ${label}: ${result}`);

  let resolvedVideo: string | null = null;

  return {
    context,
    page,
    videoStartMs,
    videoPath: () => resolvedVideo,
    finish: async () => {
      const video = page.video();
      // Playwright only flushes the file on context close.
      await context.close();
      if (!video) return;
      try {
        const raw = await video.path();
        const target = path.join(videoDir, `${label}.webm`);
        if (raw !== target) {
          fs.renameSync(raw, target);
        }
        resolvedVideo = target;
      } catch {
        resolvedVideo = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Human-looking interaction
// ---------------------------------------------------------------------------

const jitter = (base: number, spread: number): number =>
  Math.max(0, Math.round(base + (Math.random() - 0.5) * 2 * spread));

/** On-screen box of an element, in CSS pixels, for the trailer's zoom targets. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Glides the pointer to the target before clicking, so the cursor reads as human.
 * Returns the element's on-screen box so callers can record it for the trailer's
 * zoom targets.
 */
export async function humanClick(
  page: Page,
  selector: string,
  timeoutMs = 15_000,
): Promise<Rect | null> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);

  const box = await locator.boundingBox();
  if (box) {
    const tx = box.x + box.width / 2 + (Math.random() - 0.5) * Math.min(box.width * 0.3, 12);
    const ty = box.y + box.height / 2 + (Math.random() - 0.5) * Math.min(box.height * 0.3, 8);
    await page.mouse.move(tx, ty, { steps: jitter(14, 6) });
    await sleep(jitter(140, 70));
    await page.mouse.click(tx, ty, { delay: jitter(55, 25) });
  } else {
    await locator.click({ timeout: timeoutMs });
  }
  await sleep(jitter(220, 120));
  return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
}

/** Switch the on-screen pointer between its normal and unobtrusive styles. */
export async function cursorMode(page: Page, mode: 'normal' | 'subtle'): Promise<void> {
  await page
    .evaluate(
      (m) => (window as unknown as { __cursorMode?: (s: string) => void }).__cursorMode?.(m),
      mode,
    )
    .catch(() => undefined);
}

/**
 * Walk the pointer down a block of text the way a person reads it.
 *
 * A static frame on an email is a screenshot; the audience has no idea which
 * part of it matters or how long they are meant to look. Tracking a pointer
 * down the copy gives the shot a subject and a tempo, and tells the eye where
 * to be when the cut comes.
 *
 * Deliberately not a literal left-to-right sweep per line — that reads as a
 * machine scanning. This drifts down the text with a slight horizontal wander
 * and pauses where a reader would pause, which is what "subtle" has to mean
 * for it to survive being on screen for three seconds.
 */
export async function readAlong(
  page: Page,
  selector: string,
  opts: {
    /** How many resting points down the block. */
    stops?: number;
    /** Milliseconds per stop, including the glide into it. */
    msPerStop?: number;
    /** Fraction of the block width the pointer wanders across. */
    wander?: number;
    /** Start the pointer at the top of the block before moving. */
    settle?: boolean;
  } = {},
): Promise<void> {
  const { stops = 5, msPerStop = 620, wander = 0.42, settle = true } = opts;

  const box = await page
    .locator(selector)
    .first()
    .boundingBox()
    .catch(() => null);
  if (!box) return;

  await cursorMode(page, 'subtle');

  // Sit just inside the left margin, where a finger would rest on a page.
  const x0 = box.x + box.width * 0.08;
  const span = box.width * wander;
  const top = box.y + box.height * 0.12;
  const bottom = box.y + box.height * 0.88;

  if (settle) {
    await page.mouse.move(x0, top, { steps: 12 });
    await sleep(260);
  }

  for (let i = 0; i < stops; i++) {
    const t = stops === 1 ? 0 : i / (stops - 1);
    const y = top + (bottom - top) * t;
    // Ease the horizontal wander so the path curves rather than zig-zags.
    const x = x0 + span * Math.sin(t * Math.PI * 0.9);
    await page.mouse.move(x, y, { steps: 22 });
    await sleep(Math.max(0, msPerStop - 180));
  }

  await cursorMode(page, 'normal');
}

/** Box of an element without touching it — for "zoom on the comment" shots. */
export async function rectOf(
  page: Page,
  selector: string,
  timeoutMs = 8000,
): Promise<Rect | null> {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
    const box = await locator.boundingBox();
    return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
  } catch {
    return null;
  }
}

/** Desktop launcher icons open on double-click, the way a real desktop behaves. */
export async function humanDoubleClick(
  page: Page,
  selector: string,
  timeoutMs = 15_000,
): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  const box = await locator.boundingBox();
  if (box) {
    const tx = box.x + box.width / 2;
    const ty = box.y + box.height / 2;
    await page.mouse.move(tx, ty, { steps: jitter(12, 5) });
    await sleep(jitter(160, 80));
    await page.mouse.dblclick(tx, ty, { delay: jitter(60, 25) });
  } else {
    await locator.dblclick({ timeout: timeoutMs });
  }
  await sleep(jitter(300, 140));
}

/**
 * Types text a key at a time.
 *
 * Slow typing is what broke the first full run: a 400-character statement at
 * 40ms/char takes 20 seconds, and the feed re-renders on a poll every few
 * seconds, so React kept replacing the textarea mid-word. Fast typing fixes that
 * and looks better — an operator hammering it out under pressure — because the
 * whole statement lands in about four seconds, well inside one render window.
 *
 * `instant` is the old escape hatch: set most of the text at once and only type
 * a tail. Kept for reliability-critical runs, but it looks like autofill on
 * camera, so it is off by default.
 */
export interface TypeResult {
  rect: Rect | null;
  /**
   * False when keystrokes kept getting interrupted and the value had to be set
   * directly. The trailer must not zoom on those — they look like autofill.
   */
  typed: boolean;
}

export async function humanType(
  page: Page,
  selector: string,
  text: string,
  {
    attempts = 4,
    msPerChar = 11,
    instant = false,
    tailChars = 16,
  }: { attempts?: number; msPerChar?: number; instant?: boolean; tailChars?: number } = {},
): Promise<TypeResult> {
  const locator = page.locator(selector).first();
  let rect: Rect | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 15_000 });
      rect = await humanClick(page, selector);

      if (instant) {
        const splitAt = Math.max(0, text.length - tailChars);
        if (splitAt > 0) await locator.fill(text.slice(0, splitAt), { timeout: 15_000 });
        await sleep(jitter(200, 90));
        await locator.pressSequentially(text.slice(splitAt), {
          delay: jitter(42, 20),
          timeout: 15_000,
        });
        return { rect, typed: false };
      }

      // Budget scales with length. A flat floor was the bug behind the chat
      // timeouts: a 20-second allowance for an 80-character line meant three
      // failed attempts burned a full minute before giving up.
      const budget = Math.max(6_000, text.length * msPerChar * 5);
      await locator.pressSequentially(text, {
        delay: jitter(msPerChar, Math.round(msPerChar * 0.45)),
        timeout: budget,
      });
      return { rect, typed: true };
    } catch (err) {
      // Clear a partial value so the retry does not double up the text.
      await locator.fill('').catch(() => undefined);

      if (attempt === attempts) {
        // Chat re-renders on every inbound realtime message, so with a room
        // full of people typing at once the input can be destroyed on every
        // attempt. Landing the text matters more than landing the keystrokes.
        try {
          await locator.fill(text, { timeout: 10_000 });
          return { rect, typed: false };
        } catch {
          throw err;
        }
      }
      await sleep(700);
    }
  }
  return { rect, typed: false };
}

/** Idle scrolling, so a player who has nothing to do still looks like they are reading. */
export async function humanScroll(page: Page, amount = 400): Promise<void> {
  const steps = jitter(4, 2) + 1;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, amount / steps);
    await sleep(jitter(260, 140));
  }
}

/** Best-effort click that never throws; used for optional modals and stray dialogs. */
export async function tryClick(page: Page, selector: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    await humanClick(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
