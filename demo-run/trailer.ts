/**
 * Trailer assembler.
 *
 * Takes the shot timelines recorded during capture (every action with its
 * on-screen rectangle and timestamp), the run manifests, and the music beat
 * grid, and cuts a trailer where every shot change lands on a musical bar and
 * every zoom frames the element that was actually being used.
 *
 *   npx tsx demo-run/trailer.ts --novice <dir> --expert <dir> [--preset trailer|short|vertical]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShotEvent {
  atMs: number;
  durMs?: number;
  kind: string;
  rect?: Rect;
  label?: string;
  text?: string;
  beat?: string;
  /** False when the field was filled instantly rather than typed. */
  typed?: boolean;
}

interface AgentShots {
  agent: string;
  viewport: { width: number; height: number };
  /**
   * deviceScaleFactor the context used. Recorded because it turns out Playwright
   * does NOT record video at the scaled resolution: raising it only enlarges the
   * video canvas and pastes the normal-resolution capture into the top-left
   * corner, leaving the rest grey. So the usable frame is viewport/scale, and
   * rects â€” which the timeline pre-multiplied by scale â€” must be divided back.
   */
  scale?: number;
  events: ShotEvent[];
}

interface Manifest {
  profile: string;
  durationMinutes: number;
  trainerVideo: string;
  players: { index: number; name: string; team: string; view: string; video: string }[];
  samples: {
    elapsedMinutes: number;
    publicTrust: number | null;
    sentiment: number | null;
    flaggedByPlayers?: number;
  }[];
}

interface BeatGrid {
  bpm: number;
  beatSec: number[];
  accentSec: number[];
  segments: { index: number; startSec: number; endSec: number }[];
  chosenSegment: number;
}

/** A deliberately performed shot from a staged shoot. */
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

/** One cut in the finished piece. */
interface Clip {
  kind: 'footage' | 'card';
  /** Bars of music this clip occupies. */
  bars: number;
  // footage
  source?: string;
  startSec?: number;
  crop?: Rect;
  caption?: string;
  pushIn?: boolean;
  // card
  cardHtml?: string;
  /** Storyboard id, for the plan dump. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS = {
  trailer: { w: 1920, h: 1080, targetBars: 31, label: 'trailer-81s' },
  short: { w: 1920, h: 1080, targetBars: 15, label: 'short-40s' },
  vertical: { w: 1080, h: 1920, targetBars: 31, label: 'vertical-81s' },
} as const;

type PresetName = keyof typeof PRESETS;

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

async function ffmpeg(args: string[], label: string): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 1 << 26,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`ffmpeg failed (${label}): ${(e.stderr || e.message || '').slice(0, 700)}`);
  }
}

const CODEC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];

/**
 * ffmpeg wants even dimensions, and crops must sit inside the frame.
 *
 * `maxFrac` matters as much as `minFrac`: a post container can report a
 * rectangle half the screen tall, and padding that produced a "zoom" covering
 * most of the frame â€” which reads as no zoom at all. Clamp it and stay centred
 * on the element instead.
 */
function sanitiseCrop(
  r: Rect,
  vw: number,
  vh: number,
  aspect: number,
  minFrac = 0.28,
  maxFrac = 0.42,
  pad = 1.45,
): Rect {
  let w = Math.min(Math.max(r.w * pad, vw * minFrac), vw * maxFrac);
  let h = Math.min(Math.max(r.h * pad, vh * minFrac), vh * maxFrac);

  // Force the requested aspect ratio around the element.
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;

  // Never ask for more than the source has.
  if (w > vw) {
    w = vw;
    h = w / aspect;
  }
  if (h > vh) {
    h = vh;
    w = h * aspect;
  }

  let x = r.x + r.w / 2 - w / 2;
  let y = r.y + r.h / 2 - h / 2;
  x = Math.max(0, Math.min(vw - w, x));
  y = Math.max(0, Math.min(vh - h, y));

  const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);
  return { x: even(x), y: even(y), w: even(w), h: even(h) };
}

// ---------------------------------------------------------------------------
// Title cards
// ---------------------------------------------------------------------------

const CARD_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:100vw; height:100vh; background:#05070A; color:#E9F0F7;
    font-family:'Segoe UI',system-ui,sans-serif;
    display:flex; align-items:center; justify-content:center; text-align:center;
    position:relative; overflow:hidden;
  }
  .grain { position:absolute; inset:0; opacity:.05;
    background-image:radial-gradient(#fff 1px, transparent 1px); background-size:3px 3px; }
  .wrap { position:relative; padding:0 8%; }
  .kicker { font-size:1.1vw; letter-spacing:.55em; text-transform:uppercase;
    color:#5FA8FF; margin-bottom:2.4vh; font-weight:700; }
  .head { font-size:4.6vw; font-weight:800; letter-spacing:-.02em; line-height:1.06; }
  .head em { font-style:normal; color:#F2555A; }
  .head strong { font-weight:800; color:#37D399; }
  .sub { font-size:1.5vw; color:#8FA3B8; margin-top:2.6vh; line-height:1.5; }
  .stats { display:flex; gap:5vw; justify-content:center; margin-top:5vh; }
  .stat .v { font-size:3.4vw; font-weight:800; }
  .stat .l { font-size:1vw; letter-spacing:.2em; text-transform:uppercase; color:#7C8BA1; margin-top:.8vh; }
  .bad { color:#F2555A; } .good { color:#37D399; }
  .rule { width:9vw; height:3px; background:#5FA8FF; margin:3vh auto 0; }
`;

const card = (inner: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CARD_CSS}</style></head>
   <body><div class="grain"></div><div class="wrap">${inner}</div></body></html>`;

async function renderCards(
  cards: { key: string; html: string }[],
  outDir: string,
  w: number,
  h: number,
): Promise<Map<string, string>> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const map = new Map<string, string>();
  for (const c of cards) {
    const file = path.join(outDir, `card-${c.key}.png`);
    await page.setContent(c.html, { waitUntil: 'load' });
    await page.screenshot({ path: file });
    map.set(c.key, file);
  }
  await browser.close();
  return map;
}

// ---------------------------------------------------------------------------
// Shot selection
// ---------------------------------------------------------------------------

interface Pick {
  agent: AgentShots;
  event: ShotEvent;
  video: string;
}

/**
 * Where T+0 sits inside the trainer's video file.
 *
 * Recording starts when the trainer context opens, which is before the join
 * window â€” so a dashboard shot "at T+22" is 22 minutes after the session began,
 * not 22 minutes into the file. The gap varies with cohort size (25 players take
 * six minutes to join, eight take three), so read it out of the run log rather
 * than assuming.
 */
function trainerLeadSec(dir: string): number {
  const FALLBACK = 9 * 60;
  try {
    const log = fs.readFileSync(path.join(dir, 'run.log'), 'utf8');
    const at = (needle: string): number | null => {
      const m = log.match(new RegExp(`\\[(\\d\\d):(\\d\\d):(\\d\\d)\\][^\\n]*${needle}`));
      if (!m) return null;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    };
    const lobby = at('Trainer is in the lobby');
    const started = at('Session started');
    if (lobby === null || started === null) return FALLBACK;
    let delta = started - lobby;
    if (delta < 0) delta += 24 * 3600; // run crossed midnight
    // The context is created a few seconds before the lobby navigation lands.
    return Math.max(0, delta + 6);
  } catch {
    return FALLBACK;
  }
}

/**
 * Luma standard deviation of one frame, cropped to the shot.
 *
 * A shot can point at the right element at the right moment and still be
 * useless â€” a window mid-load, a page showing nothing but wallpaper. Those
 * frames are almost flat, so measuring spread tells good shots from empty ones
 * without a human watching all twenty.
 */
async function contentScore(video: string, atSec: number, crop?: Rect): Promise<number> {
  const cropExpr = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  // Decode one tiny greyscale frame and measure it here. signalstats publishes
  // YAVG/YMIN/YMAX but no standard deviation, so deriving it from raw pixels is
  // both simpler and not dependent on ffmpeg's metadata key names.
  const tmp = path.join(os.tmpdir(), `vet-${process.pid}-${Math.random().toString(36).slice(2)}.gray`);
  const W = 48;
  const H = 27;
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', atSec.toFixed(2),
        '-i', video,
        '-frames:v', '1',
        '-vf', `${cropExpr}scale=${W}:${H},format=gray`,
        '-f', 'rawvideo',
        tmp,
      ],
      { maxBuffer: 1 << 22 },
    );
    const buf = fs.readFileSync(tmp);
    if (buf.length === 0) return 0;
    let sum = 0;
    for (const v of buf) sum += v;
    const mean = sum / buf.length;
    let variance = 0;
    for (const v of buf) variance += (v - mean) ** 2;
    return Math.sqrt(variance / buf.length);
  } catch {
    return 0;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Keep the first `want` candidates whose frame actually contains something. */
async function vetted(
  picks: Pick[],
  want: number,
  minDev: number,
  atFor: (p: Pick) => { sec: number; crop: Rect },
): Promise<Pick[]> {
  const keep: Pick[] = [];
  for (const p of picks) {
    if (keep.length >= want) break;
    const { sec, crop } = atFor(p);
    const score = await contentScore(p.video, sec, crop);
    if (score >= minDev) keep.push(p);
  }
  return keep;
}

function loadRun(dir: string): {
  manifest: Manifest;
  shots: AgentShots[];
  videoDir: string;
  leadSec: number;
} {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const shotsPath = path.join(dir, 'shots.json');
  const shots = fs.existsSync(shotsPath)
    ? (JSON.parse(fs.readFileSync(shotsPath, 'utf8')).agents as AgentShots[])
    : [];
  return {
    manifest,
    shots,
    videoDir: path.join(dir, 'video'),
    leadSec: trainerLeadSec(dir),
  };
}

/**
 * All events of the given kinds, with their video.
 *
 * Typing shots are filtered to genuine keystrokes. Under load the harness falls
 * back to setting a field's value instantly so the action still lands, and those
 * look like autofill the moment you zoom on them.
 */
function gather(
  shots: AgentShots[],
  manifest: Manifest,
  videoDir: string,
  kinds: string[],
): Pick[] {
  const byLabel = new Map(
    manifest.players.map((p) => [
      `p${String(p.index).padStart(2, '0')}-${p.name.replace(/\W+/g, '')}`,
      p.video,
    ]),
  );
  const out: Pick[] = [];
  for (const agent of shots) {
    const video = byLabel.get(agent.agent);
    if (!video) continue;
    const full = path.join(videoDir, video);
    if (!fs.existsSync(full)) continue;
    for (const event of agent.events) {
      if (!kinds.includes(event.kind)) continue;
      if (!event.rect) continue;
      if (event.kind === 'type' && event.typed === false) continue;
      out.push({ agent, event, video: full });
    }
  }
  return out;
}

/** Prefer long, text-rich typing shots and spread picks across different people. */
function bestOf(picks: Pick[], count: number, opts: { preferLong?: boolean } = {}): Pick[] {
  const scored = picks
    .map((p) => ({
      p,
      score:
        (opts.preferLong ? (p.event.durMs ?? 0) / 1000 : 0) +
        (p.event.text ? Math.min(p.event.text.length, 200) / 40 : 0) +
        (p.event.beat ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const chosen: Pick[] = [];
  const used = new Set<string>();
  // First pass: one per person, so the montage shows a room not a soloist.
  for (const s of scored) {
    if (chosen.length >= count) break;
    if (used.has(s.p.agent.agent)) continue;
    used.add(s.p.agent.agent);
    chosen.push(s.p);
  }
  for (const s of scored) {
    if (chosen.length >= count) break;
    if (chosen.includes(s.p)) continue;
    chosen.push(s.p);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`Missing --${name}`);
  return v ?? fallback!;
};

const noviceDir = arg('novice');
const expertDir = arg('expert');
/**
 * Close-ups come from a dedicated hero capture: small cohort, 2x pixel density,
 * genuine keystrokes. The full runs supply the dashboard and the metrics, which
 * is where the honest claims live. Falls back to the expert run if not given.
 */
const heroDir = arg('hero', expertDir);
/**
 * A staged shoot directory. When supplied, performed shots come from its
 * takes.json in storyboard order rather than being mined out of a live run â€”
 * which is what the first cut did, and why its actions felt arbitrary.
 */
const takesDir = arg('takes', '');
const preset = arg('preset', 'trailer') as PresetName;
const musicFile = arg('music', 'Detective Background Music _ Crime Scene, Spy, Investigation _ Royalty Free [b0bRw1faiws].mp3');

const P = PRESETS[preset];
const ASPECT = P.w / P.h;

const outRoot = path.join('demo-run', 'output', 'trailer');
const workDir = path.join(outRoot, `work-${preset}`);
fs.mkdirSync(workDir, { recursive: true });

const grid = JSON.parse(fs.readFileSync('demo-run/music/beatgrid.json', 'utf8')) as BeatGrid;
const barSec = (60 / grid.bpm) * 4;
const musicStart = grid.beatSec[0] ?? 0;

console.log(`Preset ${preset}: ${P.w}x${P.h}, ${P.targetBars} bars @ ${grid.bpm.toFixed(1)} BPM`);
console.log(`Bar = ${barSec.toFixed(3)}s, music from ${musicStart.toFixed(2)}s`);

const nov = loadRun(noviceDir);
const exp = loadRun(expertDir);
const hero = heroDir === expertDir ? exp : loadRun(heroDir);
console.log(`novice: ${nov.shots.length} screens with shots, T+0 at ${nov.leadSec}s into trainer video`);
console.log(`expert: ${exp.shots.length} screens with shots, T+0 at ${exp.leadSec}s`);
console.log(`hero:   ${hero.shots.length} screens with shots, T+0 at ${hero.leadSec}s`);

const last = (m: Manifest) => m.samples.filter((s) => s.publicTrust !== null).at(-1);
const nLast = last(nov.manifest);
const eLast = last(exp.manifest);

const clips: Clip[] = [];
const push = (c: Clip): void => void clips.push(c);

// --- Staged takes -----------------------------------------------------------

const stagedTakes = new Map<string, Take>();
let stagedViewport = { width: 1280, height: 800 };
if (takesDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(takesDir, 'takes.json'), 'utf8')) as {
    viewport: { width: number; height: number };
    takes: Take[];
  };
  stagedViewport = raw.viewport;
  for (const t of raw.takes) stagedTakes.set(t.id, t);
  console.log(`staged takes: ${stagedTakes.size} from ${path.basename(takesDir)}`);
}

/** Place a performed shot by storyboard id. Silently skips a missing take. */
const shot = (id: string, opts: { bars?: number; caption?: string } = {}): boolean => {
  const t = stagedTakes.get(id);
  if (!t) return false;
  const src = path.join(takesDir, 'video', t.video);
  if (!fs.existsSync(src)) return false;

  const pad = t.framing === 'tight' ? 2.2 : 1.45;
  const min = t.framing === 'tight' ? 0.16 : 0.28;
  const crop = t.rect
    ? sanitiseCrop(t.rect, stagedViewport.width, stagedViewport.height, ASPECT, min, 0.42, pad)
    : undefined;

  clips.push({
    kind: 'footage',
    bars: opts.bars ?? t.bars,
    source: src,
    // Lead with the action; the holds either side of each take give handles.
    startSec: Math.max(0, t.inSec - 0.25),
    crop,
    caption: opts.caption ?? t.caption,
    label: `${id} ${t.title}`,
  });
  return true;
};

// --- Story ------------------------------------------------------------------

/** Where a pick will be sampled from, and with what crop â€” shared with render. */
function shotGeometry(p: Pick): { sec: number; crop: Rect } {
  const s = p.agent.scale ?? 1;
  const r = p.event.rect!;
  const rect: Rect = s === 1 ? r : { x: r.x / s, y: r.y / s, w: r.w / s, h: r.h / s };
  const into =
    p.event.kind === 'type' && p.event.durMs
      ? Math.min((p.event.durMs / 1000) * 0.35, 3)
      : -0.4;
  return {
    sec: Math.max(0, p.event.atMs / 1000 + into),
    crop: sanitiseCrop(rect, p.agent.viewport.width / s, p.agent.viewport.height / s, ASPECT),
  };
}

/** Minimum luma spread for a frame to count as showing something. */
const MIN_CONTENT_DEV = 18;

const heroPick = async (kinds: string[], n: number, preferLong = false): Promise<Pick[]> => {
  const all = bestOf(gather(hero.shots, hero.manifest, hero.videoDir, kinds), n * 4, {
    preferLong,
  });
  const good = await vetted(all, n, MIN_CONTENT_DEV, shotGeometry);
  if (good.length < n) {
    console.log(`  (${kinds.join('/')}: only ${good.length}/${n} candidates had usable frames)`);
  }
  return good;
};

// "Before" close-ups: the novice run predates shot recording, so its story is
// told by the dashboard — which is the honest way round anyway, since its
// failure is an absence of action rather than an action.
const novTrainer = path.join(nov.videoDir, nov.manifest.trainerVideo);
const expTrainer = path.join(exp.videoDir, exp.manifest.trainerVideo);

const trainerShot = (
  src: string,
  leadSec: number,
  atMinute: number,
  bars: number,
  caption?: string,
  label?: string,
): void => {
  push({ kind: 'footage', bars, source: src, startSec: leadSec + atMinute * 60, caption, label });
};

// ---------------------------------------------------------------------------
// The storyboard, in order. See demo-run/STORYBOARD.md.
//
// Shots are placed by id from the staged shoot rather than mined from a live
// run. That is the whole difference between this cut and the first one: every
// shot was performed to do a specific job here.
// ---------------------------------------------------------------------------

// Act 1 — the accusation lands
push({
  kind: 'card',
  bars: 2,
  label: 'card: cold open',
  cardHtml: card(
    `<div class="kicker">Singapore &middot; 09:14</div>
     <div class="head">One allegation.</div>`,
  ),
});
shot('shot-02', { bars: 1 });

// Act 2 — the lie outruns the truth
shot('shot-04a', { bars: 1 });
shot('shot-04b', { bars: 1 });
shot('shot-05', { bars: 2, caption: 'Bulan depan sekolah buka. Saya sudah tunggu tiga minggu.' });

// Act 3 — the room
push({
  kind: 'card',
  bars: 2,
  label: 'card: the room',
  cardHtml: card(
    `<div class="kicker">Amanah Under Fire</div>
     <div class="head">25 people. 5 teams.<br/>60 minutes.</div>`,
  ),
});
shot('shot-08', { bars: 1, caption: 'Nobody has said anything yet' });

// Act 4 — untrained
push({
  kind: 'card',
  bars: 1,
  label: 'card: untrained',
  cardHtml: card(`<div class="head"><em>Untrained.</em></div>`),
});
trainerShot(novTrainer, nov.leadSec, 22, 2, 'Four of five teams scoring zero', 'novice dashboard');
trainerShot(novTrainer, nov.leadSec, 28, 1, 'Nothing flagged. Nothing verified.', 'novice dashboard');
push({
  kind: 'card',
  bars: 2,
  label: 'card: before stats',
  cardHtml: card(
    `<div class="head"><em>Public confidence: ${nLast?.publicTrust ?? 29}</em></div>
     <div class="stats">
       <div class="stat"><div class="v bad">0</div><div class="l">Misinformation flagged</div></div>
       <div class="stat"><div class="v bad">95</div><div class="l">Hate posts</div></div>
       <div class="stat"><div class="v bad">48</div><div class="l">RDAP &mdash; defensive</div></div>
     </div>`,
  ),
});

// Act 5 — the turn. Music drops out under "Same people."
push({
  kind: 'card',
  bars: 1,
  label: 'card: same people (MUSIC OUT)',
  cardHtml: card(`<div class="head">Same people.</div>`),
});
push({
  kind: 'card',
  bars: 1,
  label: 'card: after training',
  cardHtml: card(`<div class="head"><strong>After training.</strong></div>`),
});

// Act 6 — mastery
shot('shot-16', { bars: 1, caption: 'Speaking as the organisation' });
shot('shot-17', { bars: 2 });
shot('shot-18', { bars: 1, caption: 'Published' });
shot('shot-19', { bars: 1, caption: 'Misinformation flagged' });
shot('shot-20', { bars: 1, caption: 'Disputed with facts' });
shot('shot-21', { bars: 1, caption: 'Legal clears Comms to publish' });
shot('shot-22', { bars: 1, caption: 'Every channel answered' });
shot('shot-23', { bars: 2, caption: 'They named the programme. They gave a case reference.' });

// Act 7 — proof
push({
  kind: 'card',
  bars: 2,
  label: 'card: after stats',
  cardHtml: card(
    `<div class="head"><strong>Trained.</strong></div>
     <div class="stats">
       <div class="stat"><div class="v good">${eLast?.flaggedByPlayers ?? 16}</div><div class="l">Misinformation flagged</div></div>
       <div class="stat"><div class="v good">50</div><div class="l">Hate posts &mdash; halved</div></div>
       <div class="stat"><div class="v good">72</div><div class="l">RDAP &mdash; accommodative</div></div>
     </div>`,
  ),
});

// Act 8 — close
push({
  kind: 'card',
  bars: 3,
  label: 'card: end',
  cardHtml: card(
    `<div class="head">Black Swan<br/>Simulations</div>
     <div class="rule"></div>
     <div class="sub">Rehearse the crisis before it arrives.</div>`,
  ),
});

// Sections are budgeted, so this should already match. Absorb any residue in
// the end card rather than deleting shots.
let total = clips.reduce((n, c) => n + c.bars, 0);
if (total !== P.targetBars) {
  const endCard = clips.at(-1);
  if (endCard) {
    endCard.bars = Math.max(1, endCard.bars + (P.targetBars - total));
    total = clips.reduce((n, c) => n + c.bars, 0);
  }
}
console.log(`\n${clips.length} clips, ${total} bars = ${(total * barSec).toFixed(1)}s`);

// Audit the plan before spending render time on it, and note where the music
// has to drop out so the turn lands in silence.
let atSec = 0;
let musicOutFrom: number | null = null;
let musicOutTo: number | null = null;
console.log('\n  at     bars  what');
for (const c of clips) {
  const stamp = `${atSec.toFixed(1)}s`.padStart(6);
  if (c.label?.includes('MUSIC OUT')) {
    musicOutFrom = atSec;
    musicOutTo = atSec + c.bars * barSec;
  }
  if (c.kind === 'card') {
    const head = (c.cardHtml ?? '').match(/class="head">([\s\S]*?)<\/div>/)?.[1] ?? '';
    console.log(
      `${stamp}  ${String(c.bars).padStart(4)}  CARD   ${(c.label ?? '').padEnd(30)} ` +
        `"${head.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 44)}"`,
    );
  } else {
    const crop = c.crop ? `crop ${c.crop.w}x${c.crop.h}` : 'full frame';
    console.log(
      `${stamp}  ${String(c.bars).padStart(4)}  SHOT   ${(c.label ?? path.basename(c.source ?? '')).padEnd(30)} ` +
        `t=${(c.startSec ?? 0).toFixed(1)}s  ${crop}${c.caption ? `  "${c.caption.slice(0, 40)}"` : ''}`,
    );
  }
  atSec += c.bars * barSec;
}
if (musicOutFrom !== null) {
  console.log(`\nmusic drops out ${musicOutFrom.toFixed(1)}s \u2013 ${musicOutTo!.toFixed(1)}s`);
}
if (process.argv.includes('--plan-only')) process.exit(0);

// --- Render -----------------------------------------------------------------

const cardsToRender = clips
  .map((c, i) => ({ c, i }))
  .filter((x) => x.c.kind === 'card')
  .map((x) => ({ key: String(x.i), html: x.c.cardHtml! }));
const cardFiles = await renderCards(cardsToRender, workDir, P.w, P.h);

const segments: string[] = [];
for (let i = 0; i < clips.length; i++) {
  const c = clips[i];
  const dur = c.bars * barSec;
  const out = path.join(workDir, `seg-${String(i).padStart(3, '0')}.mp4`);

  if (c.kind === 'card') {
    await ffmpeg(
      [
        '-loop', '1',
        '-t', dur.toFixed(3),
        '-i', cardFiles.get(String(i))!,
        '-vf', `fps=25,scale=${P.w}:${P.h},format=yuv420p`,
        ...CODEC,
        '-an',
        out,
      ],
      `card ${i}`,
    );
  } else {
    // Static tight crop onto the element. crop evaluates w/h once at filter
    // configuration and only re-evaluates x/y per frame, so it can pan but
    // cannot zoom â€” attempting an animated w/h yields blank frames.
    const cropExpr = c.crop
      ? `crop=${c.crop.w}:${c.crop.h}:${c.crop.x}:${c.crop.y},`
      : '';

    // Motion comes from a slow drift instead: overscan slightly, then move the
    // output window across it using the per-frame x/y expressions.
    const drift = c.pushIn
      ? `,scale=${Math.round(P.w * 1.12)}:${Math.round(P.h * 1.12)},` +
        `crop=${P.w}:${P.h}:` +
        `x='(iw-ow)*(0.15+0.7*min(t/${dur.toFixed(2)}\\,1))':` +
        `y='(ih-oh)*(0.5-0.3*min(t/${dur.toFixed(2)}\\,1))'`
      : '';
    const zoom = drift;
    // Numeric positions, not `ih`: drawtext exposes `h` for input height and
    // has no `ih` at all, and the frame size is already known here anyway.
    const barH = Math.round(P.h * 0.09);
    const caption = c.caption
      ? `,drawbox=x=0:y=${P.h - barH}:w=${P.w}:h=${barH}:color=black@0.72:t=fill,` +
        `drawtext=fontfile='C\\:/Windows/Fonts/segoeui.ttf':` +
        `text='${c.caption.replace(/:/g, '\\:').replace(/'/g, '\u2019')}':` +
        `fontcolor=white:fontsize=${Math.round(P.h * 0.036)}:` +
        `x=${Math.round(P.w * 0.025)}:y=${P.h - Math.round(barH * 0.68)}`
      : '';

    await ffmpeg(
      [
        '-ss', (c.startSec ?? 0).toFixed(3),
        '-t', dur.toFixed(3),
        '-i', c.source!,
        '-vf',
        `${cropExpr}scale=${P.w}:${P.h}:force_original_aspect_ratio=increase,` +
          `crop=${P.w}:${P.h},fps=25${zoom}${caption},format=yuv420p`,
        ...CODEC,
        '-an',
        out,
      ],
      `clip ${i}`,
    );
  }
  segments.push(out);
  process.stdout.write(`\r  rendered ${i + 1}/${clips.length}`);
}
console.log('');

// Concat
const listFile = path.join(workDir, 'concat.txt');
fs.writeFileSync(
  listFile,
  segments.map((s) => `file '${path.resolve(s).replace(/\\/g, '/')}'`).join('\n'),
);
const silent = path.join(workDir, 'silent.mp4');
await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent], 'concat');

// Music: slice the chosen piece, fade out on the tail.
const videoSec = total * barSec;
const finalOut = path.join(outRoot, `${P.label}.mp4`);
await ffmpeg(
  [
    '-i', silent,
    '-ss', musicStart.toFixed(3),
    '-t', videoSec.toFixed(3),
    '-i', musicFile,
    '-filter_complex',
    // Kill the music under "Same people." and slam it back on the next downbeat.
    // Cheap, and the silence does more work than any amount of scoring.
    `[1:a]afade=t=in:st=0:d=0.6` +
      (musicOutFrom !== null
        ? `,volume=enable='between(t\\,${musicOutFrom.toFixed(2)}\\,${musicOutTo!.toFixed(2)})':volume=0`
        : '') +
      `,afade=t=out:st=${(videoSec - 2).toFixed(2)}:d=2,loudnorm=I=-14:TP=-1.5[a]`,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    finalOut,
  ],
  'mux',
);

console.log(`\nWrote ${finalOut}  (${videoSec.toFixed(1)}s)`);
