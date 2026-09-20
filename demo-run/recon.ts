/**
 * Selector recon. Stands up a throwaway live session, walks two players into
 * gameplay, and dumps every interactive element it can see on each screen plus
 * screenshots. The app ships no data-testid attributes, so this is how the
 * agent's selectors get grounded in reality instead of guessed from JSX.
 *
 *   npx tsx demo-run/recon.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { APP_BASE, PLAYER_VIEWPORT, TRAINER_VIEWPORT } from './config.js';
import { createAgentBrowser, humanClick, launchPool, tryClick } from './browser.js';
import {
  createSession,
  provisionCohort,
  setSessionStatus,
  sleep,
  waitForApi,
} from './lib.js';

const OUT = 'demo-run/output/recon';
fs.mkdirSync(OUT, { recursive: true });

interface ReconElement {
  tag: string;
  type: string | null;
  id: string | null;
  testid: string | null;
  aria: string | null;
  title: string | null;
  placeholder: string | null;
  alt: string | null;
  role: string | null;
  text: string | null;
  disabled: boolean | null;
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * Passed to evaluate as a string on purpose: esbuild's keepNames rewrites named
 * function expressions with a `__name` helper that does not exist in the page.
 */
const PROBE = `(() => {
  function vis(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function desc(el) {
    var r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id: el.id || null,
      testid: el.getAttribute('data-testid'),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      placeholder: el.getAttribute('placeholder'),
      alt: el.getAttribute('alt'),
      role: el.getAttribute('role'),
      text: ((el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90)) || null,
      disabled: typeof el.disabled === 'boolean' ? el.disabled : null,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  }
  var nodes = Array.prototype.slice.call(
    document.querySelectorAll('button, a, input, textarea, select, [role="button"], img[alt]')
  ).filter(vis);
  return { url: location.href, title: document.title, elements: nodes.map(desc) };
})()`;

/** Everything a Playwright selector could plausibly latch onto. */
async function dumpInteractive(page: Page, label: string): Promise<void> {
  const data = (await page.evaluate(PROBE)) as {
    url: string;
    title: string;
    elements: ReconElement[];
  };

  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: false });

  const summary = data.elements
    .map((e) => {
      const bits = [
        e.tag + (e.type ? `[${e.type}]` : ''),
        e.id && `#${e.id}`,
        e.placeholder && `ph="${e.placeholder}"`,
        e.aria && `aria="${e.aria}"`,
        e.title && `title="${e.title}"`,
        e.alt && `alt="${e.alt}"`,
        e.text && `"${e.text}"`,
        e.disabled ? 'DISABLED' : null,
      ].filter(Boolean);
      return '   ' + bits.join(' ');
    })
    .join('\n');
  console.log(`\n=== ${label} (${data.url}) — ${data.elements.length} elements\n${summary}`);
}

await waitForApi();

const { adminAgent, players } = await provisionCohort(2);
const [pA, pB] = players;

console.log('\nCreating recon session...');
const session = await createSession(adminAgent, 'RECON — selector discovery, discard');
console.log(`  session ${session.id}  join_token ${session.join_token}`);

const [browser] = await launchPool(1);

const trainer = await createAgentBrowser({
  browser,
  label: 'trainer',
  viewport: TRAINER_VIEWPORT,
  videoDir: path.join(OUT, 'video'),
  session: adminAgent.session,
});

const agentA = await createAgentBrowser({
  browser,
  label: 'playerA',
  viewport: PLAYER_VIEWPORT,
  videoDir: path.join(OUT, 'video'),
  session: pA.session,
});
const agentB = await createAgentBrowser({
  browser,
  label: 'playerB',
  viewport: PLAYER_VIEWPORT,
  videoDir: path.join(OUT, 'video'),
  session: pB.session,
});

// --- Join flow -------------------------------------------------------------
async function join(page: Page, name: string, team: string): Promise<void> {
  await page.goto(`${APP_BASE}/join/${session.join_token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#displayName').waitFor({ state: 'visible', timeout: 30_000 });
  await dumpInteractive(page, `01-join-${name.replace(/\W+/g, '')}`);

  await page.fill('#displayName', '');
  await page.locator('#displayName').pressSequentially(name, { delay: 30 });
  // The option's value is the bare team name; its label appends the description.
  await page.selectOption('#teamName', team);
  await humanClick(page, 'button:has-text("Join session")');
  await page.waitForURL(/\/sessions\//, { timeout: 45_000 });
  console.log(`  ${name} joined -> ${page.url()}`);
}

await join(agentA.page, pA.spec.name, pA.spec.team);
// The /api/join limiter allows 10 requests per minute per IP and each join costs
// two, so real runs must stagger. Two players is safe without waiting.
await join(agentB.page, pB.spec.name, pB.spec.team);

await dumpInteractive(agentA.page, '02-lobby-player');

// --- Trainer view ----------------------------------------------------------
await trainer.page.goto(`${APP_BASE}/sessions/${session.id}`, { waitUntil: 'domcontentloaded' });
await sleep(4000);
await dumpInteractive(trainer.page, '03-lobby-trainer');

// --- Start -----------------------------------------------------------------
console.log('\nStarting session...');
await setSessionStatus(adminAgent, session.id, 'in_progress');
await sleep(8000);

console.log(`  player A now at ${agentA.page.url()}`);
console.log(`  trainer now at ${trainer.page.url()}`);

// Players auto-redirect to the phone shell; push B to the desktop shell.
await agentB.page.goto(`${APP_BASE}/sim/${session.id}/desktop`, { waitUntil: 'domcontentloaded' });
await sleep(5000);

await dumpInteractive(agentA.page, '04-device-onboarding');

// Demographics modal, then the briefing.
for (const label of ['25-34', 'Male', 'Islam', 'Malay']) {
  await tryClick(agentA.page, `button:has-text("${label}")`, 4000);
}
await tryClick(agentA.page, 'button:has-text("Continue")', 6000);
await sleep(2500);
await dumpInteractive(agentA.page, '05-device-home');

await tryClick(agentA.page, 'button:has-text("Got it")', 4000);
await sleep(1500);

// --- Z feed ----------------------------------------------------------------
await agentA.page.goto(`${APP_BASE}/sim/${session.id}/device/social`, {
  waitUntil: 'domcontentloaded',
});
await sleep(7000);
await dumpInteractive(agentA.page, '06-z-feed');

// Compose modal: find the floating action button by position (bottom-right).
const composeCandidates = [
  'button[aria-label*="ompose" i]',
  'button[title*="ost" i]',
  'button:has(svg):below(:text("For You"))',
];
for (const sel of composeCandidates) {
  if (await tryClick(agentA.page, sel, 2500)) {
    console.log(`  compose opened via ${sel}`);
    break;
  }
}
await sleep(2500);
await dumpInteractive(agentA.page, '07-z-compose');

// --- Other apps ------------------------------------------------------------
for (const app of ['chat', 'email', 'news', 'facebook', 'drafts']) {
  await agentA.page.goto(`${APP_BASE}/sim/${session.id}/device/${app}`, {
    waitUntil: 'domcontentloaded',
  });
  await sleep(5000);
  await dumpInteractive(agentA.page, `08-app-${app}`);
}

// --- Desktop shell + trainer dashboard -------------------------------------
await dumpInteractive(agentB.page, '09-desktop-shell');

await trainer.page.goto(`${APP_BASE}/sim/${session.id}/trainer`, {
  waitUntil: 'domcontentloaded',
});
await sleep(9000);
await dumpInteractive(trainer.page, '10-trainer-dashboard');

// --- Teardown --------------------------------------------------------------
console.log('\nConcluding recon session...');
await setSessionStatus(adminAgent, session.id, 'cancelled');

await Promise.all([agentA.finish(), agentB.finish(), trainer.finish()]);
await browser.close();

console.log(`\nRecon artifacts written to ${OUT}`);
console.log(`Recon session ${session.id} left as cancelled.`);
