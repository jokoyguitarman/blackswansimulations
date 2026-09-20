/**
 * Encodes the Corporate Crisis marketing assets from a capture run.
 *
 *   npx tsx demo-run/marketing-assets.ts [captureDir]
 *
 * Defaults to the newest demo-run/output/marketing-* folder. Produce one with
 * demo-run/marketing-capture.ts, which needs a fictional-org scenario from
 * demo-run/clone-scenario.ts first.
 *
 * The marketing page is sold on the claim that every screen is the product
 * running, which only holds if the imagery comes from a recorded session rather
 * than a mockup. This file is the record of what each shipped asset is a crop of.
 *
 * Two kinds of source:
 *
 *   stills  PNG screenshots straight from the capture. Lossless and at device
 *           pixel ratio, so small UI text survives — extracting the same frame
 *           from the VP8 recording visibly softens it.
 *   clips   Trimmed out of the context recording using the in/out marks the
 *           capture wrote, because Playwright only flushes video on close.
 *
 * Clips ship as MP4 and WebM so the page can offer both and let the browser
 * choose, each with a WebP poster so something is on screen before any video is
 * fetched.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const OUTPUT = path.resolve('demo-run/output');
const DEST = path.resolve('frontend/public/marketing/corporate-crisis');

function newestCapture(): string {
  const dirs = fs
    .readdirSync(OUTPUT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('marketing-2'))
    .map((d) => d.name)
    .sort();
  const last = dirs.at(-1);
  if (!last) throw new Error('No capture found. Run: npx tsx demo-run/marketing-capture.ts');
  return path.join(OUTPUT, last);
}

const captureDir = process.argv[2] ? path.resolve(process.argv[2]) : newestCapture();
const shotDir = path.join(captureDir, 'shots');
const videoDir = path.join(captureDir, 'video');

interface Still {
  /** Shipped basename, without extension. */
  name: string;
  /** Screenshot in the capture's shots/ folder, without extension. */
  from: string;
  /** ffmpeg crop within that screenshot, as w:h:x:y. Omit to ship it whole. */
  crop?: string;
  /** Shipped width. Never larger than the source: upscaling only adds bytes. */
  width: number;
  note: string;
}

/**
 * Phone screenshots are already cropped to the handset at capture time, so they
 * ship at their native 560x800. The desktop shell is captured at 1920x1080 and
 * comes down slightly. The dashboard is captured at 2x, which is why its two
 * crops are expressed in doubled coordinates.
 */
const STILLS: Still[] = [
  {
    name: 'desk-idle',
    from: 'desk-idle',
    width: 1600,
    note: 'Act I — the workstation before anything has gone wrong.',
  },
  {
    name: 'desk-teamchat',
    from: 'desk-teamchat',
    width: 1600,
    note: 'Act VI — the crisis cell arguing, with the feed still moving behind it.',
  },
  {
    name: 'desk-compose',
    from: 'desk-compose',
    width: 1600,
    note: 'Act VI — composing as the organisation. "Posting as: Meridian Community Trust".',
  },
  {
    name: 'news-breaking',
    from: 'news-breaking',
    width: 560,
    note: 'Act I — the masthead that makes it real, correction route already under it.',
  },
  {
    name: 'email-deadline',
    from: 'email-deadline',
    width: 560,
    note: 'Act III — a reporter, three specific questions, 6pm.',
  },
  {
    name: 'report-misinfo',
    from: 'report-misinfo',
    width: 560,
    note: 'Act IV — reporting the claim, with the fact that disproves it typed in.',
  },
  {
    name: 'feed-turn',
    from: 'feed-turn',
    width: 560,
    note: 'Act VII — the feed turns once the programme is named and referenced.',
  },
  {
    // Header plus the four gauges, and stopping short of the latency rows below
    // them: those only populate once the scoring engine has graded a player
    // action, and a marketing page should not ship three dashes.
    name: 'trainer-gauges',
    from: 'trainer-dashboard',
    crop: '1290:1060:0:0',
    width: 1050,
    note: 'The scoring surface: gauges named for this organisation rather than generic.',
  },
  {
    // The classified-posts panel, which sits beside the gauges rather than below,
    // so both assets come out of one screenshot.
    name: 'trainer-feed',
    from: 'trainer-dashboard',
    crop: '1250:860:1300:150',
    width: 1250,
    note: 'Every incoming post classified as it lands: harmful, misinfo, pressure.',
  },
];

/** Shipped width per clip. Heights follow the recorded crop. */
const CLIP_WIDTH: Record<string, number> = {
  'clip-desk': 1280,
  'clip-statement': 1280,
  'clip-pileon': 560,
  'clip-report': 560,
};

interface Mark {
  name: string;
  video: string;
  inSec: number;
  outSec: number;
  crop?: string;
}

const ffmpeg = (args: string[]): Promise<unknown> =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 26 });

/** Even dimensions, which H.264 and VP9 both require. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

async function dimensions(file: string): Promise<[number, number]> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    file,
  ]);
  const [w, h] = stdout.trim().split(',').map(Number);
  return [w, h];
}

// ---------------------------------------------------------------------------

const marksPath = path.join(captureDir, 'marks.json');
if (!fs.existsSync(marksPath)) throw new Error(`No marks.json in ${captureDir}`);
const { marks } = JSON.parse(fs.readFileSync(marksPath, 'utf8')) as { marks: Mark[] };

fs.mkdirSync(DEST, { recursive: true });

console.log(`Corporate Crisis marketing assets`);
console.log(`  from ${captureDir}`);
console.log(`  to   ${DEST}\n`);

let shipped = 0;

for (const s of STILLS) {
  const src = path.join(shotDir, `${s.from}.png`);
  if (!fs.existsSync(src)) {
    console.log(`  ${s.name.padEnd(18)} SKIPPED — no ${s.from}.png in the capture`);
    continue;
  }

  const [srcW] = await dimensions(src);
  const cropW = s.crop ? Number(s.crop.split(':')[0]) : srcW;
  const width = even(Math.min(s.width, cropW));

  const out = path.join(DEST, `${s.name}.webp`);
  await ffmpeg([
    '-i', src,
    '-vf', [s.crop ? `crop=${s.crop}` : null, `scale=${width}:-2:flags=lanczos`]
      .filter(Boolean)
      .join(','),
    '-quality', '82',
    out,
  ]);

  const [w, h] = await dimensions(out);
  const kb = Math.round(fs.statSync(out).size / 1024);
  shipped++;
  console.log(`  ${s.name.padEnd(18)} ${`${w}x${h}`.padEnd(10)} ${String(kb).padStart(4)} KB  ${s.note}`);
}

console.log('');

for (const m of marks) {
  const src = path.join(videoDir, m.video);
  if (!fs.existsSync(src)) {
    console.log(`  ${m.name.padEnd(18)} SKIPPED — no ${m.video}`);
    continue;
  }

  const width = even(CLIP_WIDTH[m.name] ?? 1280);
  const vf = [m.crop ? `crop=${m.crop}` : null, `scale=${width}:-2:flags=lanczos`]
    .filter(Boolean)
    .join(',');
  const duration = (m.outSec - m.inSec).toFixed(2);
  const base = path.join(DEST, m.name);

  // H.264 first, for Safari and anything old. faststart puts the moov atom at
  // the front so playback can begin before the whole file has arrived.
  await ffmpeg([
    '-ss', m.inSec.toFixed(2), '-t', duration,
    '-i', src,
    '-vf', vf,
    '-an',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '27', '-preset', 'slow',
    '-movflags', '+faststart',
    `${base}.mp4`,
  ]);

  await ffmpeg([
    '-ss', m.inSec.toFixed(2), '-t', duration,
    '-i', src,
    '-vf', vf,
    '-an',
    '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
    `${base}.webm`,
  ]);

  // The clip's own first frame, so there is no jump when it starts playing.
  await ffmpeg([
    '-ss', m.inSec.toFixed(2),
    '-i', src,
    '-frames:v', '1',
    '-vf', vf,
    '-quality', '80',
    `${base}-poster.webp`,
  ]);

  const [w, h] = await dimensions(`${base}.mp4`);
  const kb = (ext: string): string =>
    String(Math.round(fs.statSync(`${base}.${ext}`).size / 1024)).padStart(4);
  shipped++;
  console.log(
    `  ${m.name.padEnd(18)} ${`${w}x${h}`.padEnd(10)} ${kb('mp4')} KB mp4 / ${kb('webm')} KB webm  ${duration}s`,
  );
}

const total = fs
  .readdirSync(DEST)
  .reduce((sum, f) => sum + fs.statSync(path.join(DEST, f)).size, 0);

console.log(
  `\n${shipped} assets, ${fs.readdirSync(DEST).length} files, ${(total / 1024 / 1024).toFixed(2)} MB total.`,
);
