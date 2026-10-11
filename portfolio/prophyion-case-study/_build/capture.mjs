// Captures documentation screenshots from the UNMODIFIED Prophyion frontend (Vite dev server)
// running against the local synthetic stub API. Usage: node capture.mjs <shot> [<shot> ...]
import { open, BASE, OUT, SESSION_ID } from './shoot.mjs';

const SIM = `${BASE}/sim/${SESSION_ID}`;
const shots = {};

async function openZ(page, { thread } = {}) {
  await page.goto(`${SIM}/desktop`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.dblclick('[data-testid="desktop-icon-social"], [data-testid="desktop-icon-z"]');
  await page.waitForTimeout(1200);
  await page.click('[title="Maximize"]');
  await page.waitForTimeout(1500);
  if (thread) {
    await page.getByText(thread, { exact: false }).first().click();
    await page.waitForTimeout(1800);
  }
}

shots['01'] = async () => {
  const { browser, page } = await open({ width: 1600, height: 1000, scale: 2 });
  await openZ(page);
  await page.screenshot({ path: `${OUT}01_simulated_social_environment.png` });
  await browser.close();
};

shots['04'] = async () => {
  const { browser, page } = await open({ width: 1600, height: 1250, scale: 2 });
  await openZ(page, { thread: 'Update 14:05. We have withdrawn' });
  await page.screenshot({ path: `${OUT}04_multiple_npcs_respond_to_one_event.png` });
  await browser.close();
};

shots['03'] = async () => {
  const { browser, page } = await open({ width: 1600, height: 1000, scale: 2 });
  await openZ(page, { thread: 'both my kids were sick' });
  await page.screenshot({ path: `${OUT}03_conversation_context_thread.png` });
  await browser.close();
};

async function openEditor(page) {
  await page.goto(`${BASE}/scenarios`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Open/ }).first().click();
  await page.waitForTimeout(1800);
}

shots['02'] = async () => {
  const { browser, page } = await open({ width: 1500, height: 1500, scale: 2 });
  await openEditor(page);
  await page.locator('button[title="Edit"]').first().click();
  await page.waitForTimeout(1200);
  const handle = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll('div')];
    const withBoth = all.filter((d) => d.textContent.includes('Hidden character (drives replies)') && d.textContent.includes('Save contact') && d.textContent.includes('Contacts-sheet note'));
    return withBoth.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  });
  await handle.asElement().scrollIntoViewIfNeeded();
  await handle.asElement().screenshot({ path: `${OUT}02_npc_persona_configuration.png` });
  await browser.close();
};

shots['02b'] = async () => {
  const { browser, page } = await open({ width: 1500, height: 1500, scale: 2 });
  await openEditor(page);
  await page.getByText('Crowd personas').first().click();
  await page.waitForTimeout(1000);
  const head = page.locator('h2', { hasText: 'Crowd personas' });
  await head.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 0));
  const h = await head.boundingBox();
  const add = await page.getByText('+ Add persona').boundingBox();
  const clip = { x: h.x - 58, y: h.y - 34, width: 1000, height: add.y + add.height - h.y + 70 };
  await page.screenshot({ path: `${OUT}02b_crowd_personas.png`, clip });
  await browser.close();
};

const card = (page, re) =>
  page
    .locator('div.rounded-xl.border.overflow-hidden')
    .filter({ has: page.locator(':scope > div').filter({ hasText: re }) })
    .last();

async function openDashboard(page, { waitPolls = 5 } = {}) {
  await page.request.get('http://127.0.0.1:3001/__reset');
  await page.goto(`${SIM}/trainer`, { waitUntil: 'networkidle' });
  // Each 12 s poll receives the next seeded state, so the live sparklines draw a real client-side history.
  await page.waitForTimeout(waitPolls * 12_500);
}

shots['05'] = async () => {
  const { browser, page } = await open({ width: 1500, height: 1500, scale: 2 });
  await openDashboard(page);
  await page.screenshot({ path: '/tmp/dash-full.png', fullPage: true });
  await card(page, /^Sentiment Gauges/).screenshot({ path: `${OUT}05a_sentiment_gauges.png` });
  await card(page, /^Player Responses/).screenshot({ path: `${OUT}05b_graded_player_responses.png` });
  await card(page, /^Consequence Log/).screenshot({ path: `${OUT}05c_consequence_log.png` });
  await card(page, /^Stakeholder Outcomes/).screenshot({ path: `${OUT}05d_stakeholder_outcomes.png` });
  await browser.close();
};

shots['06'] = async () => {
  const { browser, page } = await open({ width: 1500, height: 1500, scale: 2 });
  await openDashboard(page, { waitPolls: 1 });
  for (const t of ['Influencer pushes raw-milk alternative']) {
    await page.getByText(t).first().click();
  }
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await card(page, /^Strategy Window Orchestration/).screenshot({ path: `${OUT}06a_state_driven_orchestration.png` });
  await card(page, /^Teammate Console/).screenshot({ path: `${OUT}06b_ai_teammate_console.png` });
  await browser.close();
};

for (const k of process.argv.slice(2)) {
  console.log('capturing', k);
  await shots[k]();
}
