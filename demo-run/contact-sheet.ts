/**
 * Contact sheet for a shoot.
 *
 * Extracts every take at its composed crop and tiles them into one image, so a
 * whole storyboard can be reviewed in a glance instead of scrubbing videos.
 *
 *   npx tsx demo-run/contact-sheet.ts demo-run/output/shoot-<stamp>
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Take {
  id: string;
  title: string;
  video: string;
  inSec: number;
  outSec: number;
  rect: Rect | null;
  caption?: string;
  bars: number;
  framing?: 'tight' | 'normal';
}

const dir = process.argv[2];
if (!dir) throw new Error('Usage: contact-sheet.ts <shootDir>');

const { takes, viewport } = JSON.parse(
  fs.readFileSync(path.join(dir, 'takes.json'), 'utf8'),
) as { takes: Take[]; viewport: { width: number; height: number } };

const TILE_W = 640;
const TILE_H = 360;
const ASPECT = 16 / 9;
const FONT = 'C\\:/Windows/Fonts/segoeui.ttf';

/** Same framing rules the trailer uses, so the sheet previews the real shot. */
function compose(r: Rect, vw: number, vh: number, framing: 'tight' | 'normal' = 'normal'): Rect {
  const pad = framing === 'tight' ? 2.2 : 1.45;
  const min = framing === 'tight' ? 0.16 : 0.28;
  let w = Math.min(Math.max(r.w * pad, vw * min), vw * 0.42);
  let h = Math.min(Math.max(r.h * pad, vh * min), vh * 0.42);
  if (w / h < ASPECT) w = h * ASPECT;
  else h = w / ASPECT;
  if (w > vw) {
    w = vw;
    h = w / ASPECT;
  }
  if (h > vh) {
    h = vh;
    w = h * ASPECT;
  }
  let x = r.x + r.w / 2 - w / 2;
  let y = r.y + r.h / 2 - h / 2;
  x = Math.max(0, Math.min(vw - w, x));
  y = Math.max(0, Math.min(vh - h, y));
  const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);
  return { x: even(x), y: even(y), w: even(w), h: even(h) };
}

const work = path.join(dir, 'sheet');
fs.mkdirSync(work, { recursive: true });

const tiles: string[] = [];
for (const t of takes) {
  const src = path.join(dir, 'video', t.video);
  if (!fs.existsSync(src)) {
    console.log(`  missing video for ${t.id}: ${t.video}`);
    continue;
  }
  // Sample near the start of the take. Sampling mid-way misrepresents click
  // shots: by then the modal being dismissed has already gone, so the preview
  // shows whatever was behind it rather than the action the clip leads with.
  const at = t.inSec + 0.35;
  const out = path.join(work, `${t.id}.png`);
  const crop = t.rect ? compose(t.rect, viewport.width, viewport.height, t.framing) : null;
  const label = `${t.id}  ${t.title}`.replace(/:/g, '\\:').replace(/'/g, '\u2019');

  const vf = [
    crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null,
    `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase`,
    `crop=${TILE_W}:${TILE_H}`,
    `drawbox=x=0:y=${TILE_H - 34}:w=${TILE_W}:h=34:color=black@0.75:t=fill`,
    `drawtext=fontfile='${FONT}':text='${label}':fontcolor=white:fontsize=17:x=8:y=${TILE_H - 26}`,
    `drawbox=x=0:y=0:w=${TILE_W}:h=${TILE_H}:color=white@0.25:t=2`,
  ]
    .filter(Boolean)
    .join(',');

  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', at.toFixed(2),
      '-i', src,
      '-frames:v', '1',
      '-vf', vf,
      out,
    ]);
    tiles.push(out);
    console.log(`  ${t.id.padEnd(10)} ${t.title}`);
  } catch (err) {
    console.log(`  ${t.id} FAILED: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
}

if (tiles.length === 0) throw new Error('No tiles produced');

const cols = 4;
const rows = Math.ceil(tiles.length / cols);
const layout = tiles.map((_, i) => `${(i % cols) * TILE_W}_${Math.floor(i / cols) * TILE_H}`).join('|');
const chain = tiles.map((_, i) => `[${i}:v]`).join('');
const sheet = path.join(dir, 'contact-sheet.png');

const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];
for (const t of tiles) args.push('-i', t);
args.push(
  '-filter_complex',
  `${chain}xstack=inputs=${tiles.length}:layout=${layout}:fill=black`,
  '-frames:v', '1',
  sheet,
);
await run('ffmpeg', args, { maxBuffer: 1 << 26 });

console.log(`\n${tiles.length} takes -> ${sheet} (${cols}x${rows})`);
