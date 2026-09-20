/**
 * Screenshots the marketing pages at a few widths, for reviewing layout changes.
 *
 *   npx tsx demo-run/shot-marketing.ts [baseUrl]
 *
 * Needs a server in front of frontend/dist — demo-run/serve.ts will do. Pages are
 * requested with their .html extension because that server has no rewrite rules;
 * the clean URLs are Vercel's job.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.argv[2] ?? 'http://localhost:3002').replace(/\/$/, '');
const OUT = path.resolve('demo-run/output/marketing-shots');

const PAGES = [
  { name: 'landing', url: '/simulations/index.html' },
  { name: 'corporate-crisis', url: '/simulations/corporate-crisis.html' },
];

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

for (const page of PAGES) {
  for (const w of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: w.width, height: w.height },
      deviceScaleFactor: 1,
    });
    const tab = await context.newPage();
    await tab.goto(`${BASE}${page.url}`, { waitUntil: 'load' });

    // Scroll the whole page once. Everything below the fold is behind either a
    // scroll-reveal or a lazy-loaded image, so a screenshot taken without this
    // is a screenshot of empty boxes.
    //
    // behavior:'instant' is load-bearing: the stylesheet sets scroll-behavior
    // smooth, so a plain scrollTo animates and a fast loop just restarts the
    // animation from wherever it got to, leaving the lower half never scrolled to.
    await tab.evaluate(async () => {
      const step = window.innerHeight * 0.6;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 150));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });

    // Then wait for the reveals to actually finish, rather than guessing at a
    // delay: a screenshot of half-faded sections is not worth reviewing.
    await tab
      .waitForFunction(
        () =>
          [...document.querySelectorAll('.reveal')].every((el) =>
            el.classList.contains('is-visible'),
          ),
        undefined,
        { timeout: 15000 },
      )
      .catch(() => console.log(`    (some reveals never fired on ${page.name}/${w.name})`));
    await tab.waitForTimeout(900);

    const file = path.join(OUT, `${page.name}-${w.name}.png`);
    await tab.screenshot({ path: file, fullPage: true });
    const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
    console.log(`  ${page.name}-${w.name}  ${mb} MB  ${file}`);
    await context.close();
  }
}

await browser.close();
