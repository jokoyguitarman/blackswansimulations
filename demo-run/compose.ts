/**
 * Video assembly.
 *
 *   npx tsx demo-run/compose.ts --run demo-run/output/expert-2026-...
 *   npx tsx demo-run/compose.ts --compare <noviceDir> <expertDir>
 *
 * Two stages on purpose. Decoding 25 simultaneous VP8 streams while scaling and
 * stacking them is what makes a naive one-shot mosaic crawl, so each screen is
 * first normalised to a small H.264 tile (NVENC, in parallel), and the mosaic is
 * then stacked from those cheap inputs.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);

/**
 * `ffmpeg -encoders` lists hardware encoders that the installed driver cannot
 * actually open — h264_nvenc is present here but needs NVENC API 13.0 while the
 * driver offers 12.2. So probe by really encoding a frame.
 */
async function encoderWorks(name: string): Promise<boolean> {
  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=black:s=256x256:d=0.1',
      '-c:v', name,
      '-f', 'null',
      '-',
    ]);
    return true;
  } catch {
    return false;
  }
}

const HW = (await encoderWorks('h264_nvenc'))
  ? 'h264_nvenc'
  : (await encoderWorks('h264_qsv'))
    ? 'h264_qsv'
    : null;

console.log(HW ? `Using hardware encoder ${HW}` : 'Using libx264 (no usable hardware encoder)');

const videoCodec = (): string[] => {
  if (HW === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '26', '-pix_fmt', 'yuv420p'];
  }
  if (HW === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-global_quality', '26', '-pix_fmt', 'nv12'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
};

async function ffmpeg(args: string[], label: string): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`ffmpeg failed (${label}): ${(e.stderr || e.message || '').slice(0, 900)}`);
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

interface Manifest {
  profile: string;
  scenario: string;
  sessionId: string;
  durationMinutes: number;
  trainerVideo: string;
  players: { index: number; name: string; team: string; view: string; video: string }[];
  samples: {
    elapsedMinutes: number;
    sentiment: number | null;
    publicTrust: number | null;
    narrativeControl: number | null;
    escalationRisk: number | null;
    playerPosts: number;
    flaggedByPlayers: number;
  }[];
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;

// ---------------------------------------------------------------------------
// Tiles + mosaic
// ---------------------------------------------------------------------------

const TILE_W = 384;
const TILE_H = 240;

/** ffmpeg filter text is written to a file so Windows shell escaping cannot bite. */
async function ffmpegScript(
  inputs: string[],
  filter: string,
  outArgs: string[],
  outFile: string,
  label: string,
): Promise<void> {
  const scriptPath = `${outFile}.filter.txt`;
  fs.writeFileSync(scriptPath, filter);
  const args: string[] = [];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex_script', scriptPath, ...outArgs, outFile);
  try {
    await ffmpeg(args, label);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

const escapeDrawtext = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');

const FONT = 'C\\:/Windows/Fonts/segoeui.ttf';

async function buildTiles(dir: string, m: Manifest): Promise<string[]> {
  const tileDir = path.join(dir, 'tiles');
  fs.mkdirSync(tileDir, { recursive: true });

  const present = m.players.filter((p) => p.video && fs.existsSync(path.join(dir, 'video', p.video)));
  console.log(`  normalising ${present.length} player screens to ${TILE_W}x${TILE_H} tiles`);

  const outputs: string[] = [];
  // Consumer NVENC caps concurrent sessions; libx264 on 20 threads prefers more.
  await mapLimit(present, HW ? 3 : 6, async (p) => {
    const src = path.join(dir, 'video', p.video);
    const out = path.join(tileDir, `${String(p.index).padStart(2, '0')}.mp4`);
    const caption = escapeDrawtext(`${p.name}  ·  ${p.team}`);
    const filter =
      `[0:v]fps=25,scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
      `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `drawbox=x=0:y=${TILE_H - 22}:w=${TILE_W}:h=22:color=black@0.62:t=fill,` +
      `drawtext=fontfile='${FONT}':text='${caption}':fontcolor=white:fontsize=13:` +
      `x=6:y=${TILE_H - 18}[v]`;
    await ffmpegScript([src], filter, ['-map', '[v]', ...videoCodec(), '-an'], out, `tile ${p.name}`);
    outputs.push(out);
  });

  return outputs.sort();
}

async function buildMosaic(dir: string, tiles: string[]): Promise<string> {
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const out = path.join(dir, 'players-mosaic.mp4');

  const layout = tiles
    .map((_, i) => `${(i % cols) * TILE_W}_${Math.floor(i / cols) * TILE_H}`)
    .join('|');
  const chain = tiles.map((_, i) => `[${i}:v]`).join('');
  const filter =
    `${chain}xstack=inputs=${tiles.length}:layout=${layout}:fill=black[grid];` +
    `[grid]scale=${cols * TILE_W}:${rows * TILE_H}[v]`;

  console.log(`  stacking ${tiles.length} tiles into a ${cols}x${rows} grid`);
  await ffmpegScript(tiles, filter, ['-map', '[v]', ...videoCodec(), '-an'], out, 'mosaic');
  return out;
}

async function buildTrainer(dir: string, m: Manifest): Promise<string | null> {
  const src = path.join(dir, 'video', m.trainerVideo);
  if (!m.trainerVideo || !fs.existsSync(src)) return null;
  const out = path.join(dir, 'trainer.mp4');
  const title = escapeDrawtext(
    m.profile === 'novice' ? 'BEFORE TRAINING — baseline run' : 'AFTER TRAINING — post-training run',
  );
  // Banner goes at the foot of the frame: the dashboard's own header (session id
  // and elapsed clock) lives in the top strip and must stay readable.
  const filter =
    `[0:v]fps=25,scale=1920:1080,` +
    `drawbox=x=0:y=1024:w=1920:h=56:color=black@0.78:t=fill,` +
    `drawtext=fontfile='${FONT}':text='${title}':fontcolor=white:fontsize=28:x=28:y=1040[v]`;
  console.log('  rendering trainer dashboard');
  await ffmpegScript([src], filter, ['-map', '[v]', ...videoCodec(), '-an'], out, 'trainer');
  return out;
}

// ---------------------------------------------------------------------------
// Trust chart (rendered as HTML, screenshotted with Playwright)
// ---------------------------------------------------------------------------

function chartHtml(series: { label: string; colour: string; m: Manifest }[]): string {
  const datasets = series.map((s) => ({
    label: s.label,
    colour: s.colour,
    points: s.m.samples
      .filter((x) => x.publicTrust !== null)
      .map((x) => ({ t: x.elapsedMinutes, v: x.publicTrust as number })),
  }));

  const W = 1720;
  const H = 780;
  const padL = 90;
  const padB = 80;
  // Right margin has to clear the end-of-line value label, not just the axis.
  const padR = 110;
  const maxT = Math.max(10, ...datasets.flatMap((d) => d.points.map((p) => p.t)));

  const toX = (t: number): number => padL + (t / maxT) * (W - padL - padR);
  const toY = (v: number): number => H - padB - (v / 100) * (H - padB - 50);

  const paths = datasets
    .map((d) => {
      if (!d.points.length) return '';
      const dAttr = d.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ');
      const last = d.points.at(-1)!;
      return `
        <path d="${dAttr}" fill="none" stroke="${d.colour}" stroke-width="4.5" stroke-linejoin="round"/>
        <circle cx="${toX(last.t).toFixed(1)}" cy="${toY(last.v).toFixed(1)}" r="7" fill="${d.colour}"/>
        <text x="${(toX(last.t) + 14).toFixed(1)}" y="${(toY(last.v) + 6).toFixed(1)}"
              fill="${d.colour}" font-size="30" font-weight="700">${Math.round(last.v)}</text>`;
    })
    .join('');

  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) => `
      <line x1="${padL}" y1="${toY(v)}" x2="${W - padR}" y2="${toY(v)}" stroke="#243044" stroke-width="1"/>
      <text x="${padL - 16}" y="${toY(v) + 7}" fill="#7C8BA1" font-size="20" text-anchor="end">${v}</text>`,
    )
    .join('');

  const ticks = Array.from({ length: Math.floor(maxT / 10) + 1 }, (_, i) => i * 10)
    .map(
      (t) =>
        `<text x="${toX(t)}" y="${H - padB + 34}" fill="#7C8BA1" font-size="20" text-anchor="middle">T+${t}m</text>`,
    )
    .join('');

  const legend = datasets
    .map(
      (d, i) => `
      <rect x="${padL + i * 330}" y="26" width="26" height="26" rx="6" fill="${d.colour}"/>
      <text x="${padL + i * 330 + 38}" y="47" fill="#E6EDF6" font-size="24">${d.label}</text>`,
    )
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#0C1219;font-family:Segoe UI,system-ui,sans-serif">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <text x="${padL}" y="${H - 18}" fill="#7C8BA1" font-size="20">Elapsed simulation time</text>
      <text x="26" y="${H / 2}" fill="#7C8BA1" font-size="20"
            transform="rotate(-90 26 ${H / 2})" text-anchor="middle">Amanah &amp; Public Confidence</text>
      ${grid}${ticks}${legend}${paths}
    </svg></body></html>`;
}

async function renderChart(outPath: string, series: { label: string; colour: string; m: Manifest }[]) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1720, height: 780 } });
  await page.setContent(chartHtml(series), { waitUntil: 'load' });
  await page.screenshot({ path: outPath });
  await browser.close();
  console.log(`  chart -> ${outPath}`);
}

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv[0] === '--trainer') {
  // Re-render just the trainer dashboard, without redoing 26 tiles.
  const dir = argv[1];
  const m = readManifest(dir);
  const out = await buildTrainer(dir, m);
  console.log(out ? `\nDone: ${out}` : '\nNo trainer video found');
} else if (argv[0] === '--run') {
  const dir = argv[1];
  const m = readManifest(dir);
  console.log(`Composing ${m.profile} run (${m.players.length} players)`);
  const tiles = await buildTiles(dir, m);
  if (tiles.length) await buildMosaic(dir, tiles);
  await buildTrainer(dir, m);
  await renderChart(path.join(dir, 'trust-curve.png'), [
    { label: m.profile === 'novice' ? 'Before training' : 'After training', colour: m.profile === 'novice' ? '#F2555A' : '#37D399', m },
  ]);
  console.log(`\nDone: ${dir}`);
} else if (argv[0] === '--compare') {
  const [, noviceDir, expertDir] = argv;
  const nm = readManifest(noviceDir);
  const em = readManifest(expertDir);
  const outDir = path.join(path.dirname(noviceDir), 'comparison');
  fs.mkdirSync(outDir, { recursive: true });

  await renderChart(path.join(outDir, 'trust-comparison.png'), [
    { label: 'Before training', colour: '#F2555A', m: nm },
    { label: 'After training', colour: '#37D399', m: em },
  ]);

  const a = path.join(noviceDir, 'trainer.mp4');
  const b = path.join(expertDir, 'trainer.mp4');
  if (fs.existsSync(a) && fs.existsSync(b)) {
    const out = path.join(outDir, 'trainer-side-by-side.mp4');
    const filter =
      `[0:v]fps=25,scale=960:540[l];[1:v]fps=25,scale=960:540[r];` +
      `[l][r]hstack=inputs=2[v]`;
    console.log('  building side-by-side trainer dashboards');
    await ffmpegScript([a, b], filter, ['-map', '[v]', ...videoCodec(), '-an'], out, 'compare');
  } else {
    console.log('  (run --run on both runs first to get trainer.mp4)');
  }

  const nLast = nm.samples.at(-1);
  const eLast = em.samples.at(-1);
  console.log('\nHeadline numbers');
  console.log(`  before: trust ${nLast?.publicTrust}, narrative ${nLast?.narrativeControl}, flagged ${nLast?.flaggedByPlayers}`);
  console.log(`  after:  trust ${eLast?.publicTrust}, narrative ${eLast?.narrativeControl}, flagged ${eLast?.flaggedByPlayers}`);
  console.log(`\nDone: ${outDir}`);
} else {
  console.log('Usage:\n  compose.ts --run <runDir>\n  compose.ts --compare <noviceDir> <expertDir>');
}
