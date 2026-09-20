/**
 * Frame renderer.
 *
 *   npx tsx demo-run/anim/render.ts [clipId ...]
 *
 * Serves the scene page, then for each clip walks time in fixed steps, calls
 * __seek(t), screenshots, and hands the PNG sequence to ffmpeg. Because the
 * page derives its entire state from t, the output is identical on every run —
 * which is the whole reason for rendering rather than recording.
 *
 * Output is 3840x2160: a 1920x1080 viewport captured at deviceScaleFactor 2.
 * Text is rasterised at final resolution rather than upscaled, which is what
 * the screen-recorded version could never do — Playwright's video capture is
 * locked to the CSS viewport size no matter what scale factor you ask for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';

import { CLIPS, type Clip } from './clips.js';
import { CSS } from './styles.js';
import { H, W } from './scenes.js';

const FPS = 30;
const SCALE = 2; // 1920x1080 * 2 = 3840x2160
const OUT_ROOT = path.resolve('demo-run', 'output', 'render');
const FRAME_ROOT = path.join(OUT_ROOT, '_frames');
const PORT = 3021;

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const RUNTIME = fs.readFileSync(path.resolve('demo-run', 'anim', 'runtime.js'), 'utf8');

function pageHtml(clip: Clip): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${CSS}</style></head>
<body><div class="stage" id="stage">${clip.html}</div>
<script>${RUNTIME}</script>
<script>window.__load(${JSON.stringify(clip.tracks)});window.__seek(0);</script>
</body></html>`;
}

/**
 * Wait for fonts and images before the first frame.
 *
 * A frame captured while a webfont is still swapping bakes the fallback metrics
 * into the render, and unlike a live recording there is no later frame to cut
 * to instead — every frame has to be right the first time.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready;
    const imgs = Array.from(document.images).filter((i) => !i.complete);
    await Promise.all(
      imgs.map(
        (i) =>
          new Promise<void>((res) => {
            i.addEventListener('load', () => res(), { once: true });
            i.addEventListener('error', () => res(), { once: true });
          }),
      ),
    );
  });
  await page.waitForTimeout(180);
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`)),
    );
  });
}

async function encoderWorks(name: string): Promise<boolean> {
  try {
    await run('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1',
      '-c:v', name, '-f', 'null', '-',
    ]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function renderClip(browser: Browser, clip: Clip, encoder: string): Promise<string> {
  const frameDir = path.join(FRAME_ROOT, clip.id);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`  page error: ${e.message}`));

  await page.goto(`http://localhost:${PORT}/clip/${clip.id}`, { waitUntil: 'domcontentloaded' });
  await settle(page);

  const total = Math.round((clip.durationMs / 1000) * FPS);
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    const t = (f / FPS) * 1000;
    await page.evaluate((ms) => (window as unknown as { __seek: (n: number) => void }).__seek(ms), t);
    // JPEG rather than PNG for the intermediate frames: encoding a 3840x2160
    // PNG dominates the per-frame cost, and at quality 96 the difference is
    // invisible once the sequence is compressed to h264 anyway.
    await page.screenshot({
      path: path.join(frameDir, `f${String(f).padStart(5, '0')}.jpg`),
      type: 'jpeg',
      quality: 96,
      animations: 'disabled',
    });
    if (f > 0 && f % 60 === 0) {
      const rate = (f / ((Date.now() - started) / 1000)).toFixed(1);
      log(`  ${clip.id}: ${f}/${total} frames (${rate} fps)`);
    }
  }
  await ctx.close();

  const out = path.join(OUT_ROOT, `${clip.id}.mp4`);
  const q = encoder === 'libx264' ? ['-crf', '16', '-preset', 'slow'] : ['-cq', '19', '-preset', 'p5'];
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-framerate', String(FPS),
    '-i', path.join(frameDir, 'f%05d.jpg'),
    '-c:v', encoder, ...q,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ]);
  fs.rmSync(frameDir, { recursive: true, force: true });
  log(`  ${clip.id} -> ${path.basename(out)} (${total} frames, ${(clip.durationMs / 1000).toFixed(1)}s)`);
  return out;
}

// ---------------------------------------------------------------------------

const wanted = process.argv.slice(2);
const clips = wanted.length ? CLIPS.filter((c) => wanted.includes(c.id)) : CLIPS;
if (!clips.length) {
  console.error(`No clips matched. Available: ${CLIPS.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.mkdirSync(FRAME_ROOT, { recursive: true });

const app = express();
app.use('/a', express.static(path.resolve('demo-run', 'assets')));
app.get('/clip/:id', (req, res) => {
  const clip = CLIPS.find((c) => c.id === req.params.id);
  if (!clip) return res.status(404).send('no such clip');
  res.type('html').send(pageHtml(clip));
});
const server = app.listen(PORT);
log(`Scene server on ${PORT}`);

const encoder = (await encoderWorks('h264_nvenc')) ? 'h264_nvenc' : 'libx264';
log(`Encoder: ${encoder}`);
log(`Rendering ${clips.length} clip(s) at ${W * SCALE}x${H * SCALE} @ ${FPS}fps`);

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const made: string[] = [];
try {
  for (const clip of clips) {
    log(`${clip.id}  ${clip.title}`);
    made.push(await renderClip(browser, clip, encoder));
  }
} finally {
  await browser.close();
  server.close();
}

// Concatenate into a single reel. Uses the canonical clip order rather than
// whatever this invocation happened to render, so a partial re-render followed
// by a rebuild still produces the film in story order.
if (!wanted.length && made.length > 1) {
  const listFile = path.join(OUT_ROOT, '_concat.txt');
  const ordered = CLIPS.map((c) => path.join(OUT_ROOT, `${c.id}.mp4`)).filter((f) =>
    fs.existsSync(f),
  );
  fs.writeFileSync(listFile, ordered.map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`).join('\n'));
  const reel = path.join(OUT_ROOT, 'trailer-4k.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', reel]);
  fs.rmSync(listFile, { force: true });
  log(`Reel: ${reel}`);
}

const totalSec = clips.reduce((t, c) => t + c.durationMs, 0) / 1000;
log(`Done. ${made.length} clip(s), ${totalSec.toFixed(1)}s total.`);
