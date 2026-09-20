/**
 * Decides whether the desktop shell is drivable.
 *
 * Smoke-run desktop players failed every action while phone players succeeded,
 * so this opens the desktop shell against a live session, clicks the Z launcher,
 * and reports whether the shared feed/compose test hooks are reachable there.
 *
 *   npx tsx demo-run/desktop-probe.ts
 */

import { APP_BASE, TRAINER_VIEWPORT } from './config.js';
import { createAgentBrowser, humanDoubleClick, launchPool, tryClick } from './browser.js';
import { createSession, provisionCohort, setSessionStatus, sleep, waitForApi } from './lib.js';

await waitForApi();
const { adminAgent, players } = await provisionCohort(1);
const p = players[0];

const session = await createSession(adminAgent, 'DESKTOP PROBE — discard');
console.log(`session ${session.id}`);

const [browser] = await launchPool(1);
const ctx = await createAgentBrowser({
  browser,
  label: 'desktop-probe',
  viewport: TRAINER_VIEWPORT,
  videoDir: 'demo-run/output/recon/video',
  session: p.session,
});
const page = ctx.page;

await page.goto(`${APP_BASE}/join/${session.join_token}`, { waitUntil: 'domcontentloaded' });
await page.locator('#displayName').waitFor({ state: 'visible', timeout: 30_000 });
await page.fill('#displayName', p.spec.name);
await page.selectOption('#teamName', p.spec.team);
await page.click('button:has-text("Join session")');
await page.waitForURL(/\/sessions\//, { timeout: 45_000 });
await tryClick(page, 'button:has-text("Mark me as ready")', 10_000);

await setSessionStatus(adminAgent, session.id, 'in_progress');
await sleep(9000);

// Clear onboarding on the phone shell first (same profile applies to desktop).
await page.goto(`${APP_BASE}/sim/${session.id}/device`, { waitUntil: 'domcontentloaded' });
await sleep(4000);
for (const label of ['26-35', 'Male', 'Islam', 'Malay']) {
  await tryClick(page, `button:text-is("${label}")`, 3000);
}
await tryClick(page, 'button:text-is("Continue")', 8000);
await sleep(2000);
await tryClick(page, 'button:text-is("Got it")', 6000);
await sleep(1500);

const report = async (stage: string): Promise<void> => {
  const counts = (await page.evaluate(
    `({
      url: location.href,
      feedPosts: document.querySelectorAll('[data-testid^="feed-post-"]').length,
      replyBtns: document.querySelectorAll('[data-testid^="post-reply-"]').length,
      flagBtns: document.querySelectorAll('[data-testid^="post-flag-"]').length,
      composeOpen: document.querySelectorAll('[data-testid="compose-open"]').length,
      composeText: document.querySelectorAll('[data-testid="compose-text"]').length,
      asPage: document.querySelectorAll('[data-testid="compose-as-page"]').length,
      postButtons: Array.prototype.filter.call(
        document.querySelectorAll('button'),
        function (b) { return (b.textContent || '').trim() === 'Post'; }
      ).length,
      buttonLabels: Array.prototype.slice.call(document.querySelectorAll('button'))
        .map(function (b) { return (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26); })
        .filter(function (t) { return t; })
        .slice(0, 28)
    })`,
  )) as Record<string, unknown>;
  console.log(`\n--- ${stage}`);
  console.log(JSON.stringify(counts, null, 2));
  await page.screenshot({ path: `demo-run/output/recon/desktop-${stage}.png` });
};

await page.goto(`${APP_BASE}/sim/${session.id}/desktop`, { waitUntil: 'domcontentloaded' });
await sleep(4000);
await report('01-shell');

// Desktop icons open on double-click (DesktopShell uses onDoubleClick).
await humanDoubleClick(page, 'button:has-text("Z")', 8000);
console.log('\ndouble-clicked Z launcher');
await sleep(6000);
await report('02-after-z-dblclick');

// If a feed rendered, try the compose entry points.
if (await tryClick(page, '[data-testid="compose-open"]', 4000)) {
  console.log('compose-open FAB works on desktop');
} else if (await tryClick(page, 'button:text-is("Post")', 4000)) {
  console.log('nav "Post" button works on desktop');
} else {
  console.log('NO compose entry point found on desktop');
}
await sleep(3000);
await report('03-after-compose');

await setSessionStatus(adminAgent, session.id, 'cancelled');
await ctx.finish();
await browser.close();
console.log('\nprobe done');
