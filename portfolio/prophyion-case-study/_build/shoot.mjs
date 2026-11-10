import { chromium } from 'playwright';
import { SESSION_ID, SCENARIO_ID, USER_ID, authUser } from './fixtures.mjs';

const BASE = 'http://127.0.0.1:3002';
const OUT = new URL('../screenshots/', import.meta.url).pathname;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: USER_ID, exp: 4102444800, role: 'authenticated' })}.stub`;
const session = {
  access_token: fakeJwt,
  refresh_token: 'stub-refresh',
  token_type: 'bearer',
  expires_in: 3600 * 24 * 365,
  expires_at: 4102444800,
  user: authUser,
};

export async function open({ width = 1600, height = 1000, scale = 2 } = {}) {
  const browser = await chromium.launch({
    executablePath: '/usr/local/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  await ctx.addInitScript((s) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(s));
  }, session);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200));
  });
  return { browser, ctx, page };
}

export { BASE, OUT, SESSION_ID, SCENARIO_ID };

if (process.argv[1].endsWith('shoot.mjs')) {
  const [, , path, name] = process.argv;
  const { browser, page } = await open();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/${name || 'probe'}.png` });
  await browser.close();
}
