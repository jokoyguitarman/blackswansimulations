/**
 * Beat grid extraction, so the edit can be cut to the music rather than having
 * music laid over a finished cut.
 *
 * Decodes the track to mono PCM, builds an onset-novelty curve from short-time
 * energy, estimates tempo by autocorrelating that curve, then locks a beat phase
 * by testing pulse trains. Also scores the track in windows so the builder can
 * drop into the strongest build instead of always starting at 0:00.
 *
 *   npx tsx demo-run/beatgrid.ts "<audio file>" [--window 90]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SR = 22050;
const HOP = 512; // ~23ms
const MIN_BPM = 60;
const MAX_BPM = 180;

export interface Segment {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  meanEnergy: number;
  peakEnergy: number;
  /** Positive when the piece builds towards its end. */
  buildSlope: number;
  bpm: number;
  accents: number;
  /** Fitness for a trailer of the requested length. */
  score: number;
}

export interface BeatGrid {
  file: string;
  durationSec: number;
  /** Tempo of the chosen segment, not of the whole file. */
  bpm: number;
  beatSec: number[];
  /** Per-second RMS, for picking a section. */
  energyPerSec: number[];
  /** Start of the chosen segment. */
  bestWindowStartSec: number;
  /** Onsets that are much louder than their neighbours — the "hits". */
  accentSec: number[];
  /**
   * The supplied file is a compilation of separate pieces, so a global tempo is
   * meaningless and a naive "loudest window" can straddle a track change.
   * Segments are detected from the silences between pieces.
   */
  segments: Segment[];
  chosenSegment: number;
}

async function decodeMono(file: string): Promise<Float32Array> {
  const tmp = path.join(os.tmpdir(), `bg-${Date.now()}.raw`);
  await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 's16le', tmp],
    { maxBuffer: 1 << 28 },
  );
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Short-time energy, then a half-wave-rectified first difference = novelty. */
function novelty(pcm: Float32Array): { curve: Float32Array; hopSec: number } {
  const frames = Math.floor(pcm.length / HOP);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const base = f * HOP;
    for (let i = 0; i < HOP; i++) {
      const v = pcm[base + i];
      s += v * v;
    }
    energy[f] = Math.sqrt(s / HOP);
  }

  // Log compression keeps quiet passages from vanishing.
  for (let f = 0; f < frames; f++) energy[f] = Math.log1p(energy[f] * 40);

  const curve = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const d = energy[f] - energy[f - 1];
    curve[f] = d > 0 ? d : 0;
  }
  return { curve, hopSec: HOP / SR };
}

/** Mean novelty landing on a pulse train of this period — how "beaty" it is. */
function pulseScore(curve: Float32Array, hopSec: number, bpm: number): number {
  const period = 60 / bpm / hopSec;
  if (period < 2) return 0;
  let best = 0;
  for (let off = 0; off < Math.round(period); off += Math.max(1, Math.round(period / 8))) {
    let sum = 0;
    let hits = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(off + k * period);
      if (idx >= curve.length) break;
      sum += curve[idx];
      hits++;
    }
    if (hits > 0) best = Math.max(best, sum / hits);
  }
  return best;
}

/**
 * Autocorrelation cannot tell a beat from its double or half, so a detective
 * cue reads as 184 BPM when it is really 92. Resolve the octave by scoring each
 * candidate's pulse train and preferring the one nearest a perceptual tempo.
 */
function estimateTempo(curve: Float32Array, hopSec: number): number {
  const minLag = Math.round(60 / MAX_BPM / hopSec);
  const maxLag = Math.round(60 / MIN_BPM / hopSec);
  let best = { lag: minLag, score: -Infinity };

  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < curve.length; i++) s += curve[i] * curve[i - lag];
    // Normalise so slow tempi are not favoured purely by having more overlap.
    const score = s / (curve.length - lag);
    if (score > best.score) best = { lag, score };
  }

  const raw = 60 / (best.lag * hopSec);
  const PREFERRED = 110; // centre of the range people actually tap along to

  let chosen = raw;
  let chosenScore = -Infinity;
  for (const factor of [0.25, 1 / 3, 0.5, 1, 2, 3, 4]) {
    const cand = raw * factor;
    if (cand < 55 || cand > 200) continue;
    // Octaves share pulse energy, so break the tie on perceptual plausibility.
    const proximity = 1 / (1 + Math.abs(Math.log2(cand / PREFERRED)));
    const score = pulseScore(curve, hopSec, cand) * proximity;
    if (score > chosenScore) {
      chosenScore = score;
      chosen = cand;
    }
  }
  return chosen;
}

function lockPhase(curve: Float32Array, hopSec: number, bpm: number): number {
  const period = 60 / bpm / hopSec;
  let best = { offset: 0, score: -Infinity };
  for (let off = 0; off < Math.round(period); off++) {
    let s = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(off + k * period);
      if (idx >= curve.length) break;
      s += curve[idx];
    }
    if (s > best.score) best = { offset: off, score: s };
  }
  return best.offset * hopSec;
}

/** Split a compilation into pieces on the near-silent gaps between them. */
function segmentByGaps(energyPerSec: number[]): { startSec: number; endSec: number }[] {
  const peak = Math.max(...energyPerSec);
  const quiet = peak * 0.06;
  const segments: { startSec: number; endSec: number }[] = [];
  let start: number | null = null;
  let quietRun = 0;

  for (let s = 0; s < energyPerSec.length; s++) {
    const loud = energyPerSec[s] > quiet;
    if (loud) {
      if (start === null) start = s;
      quietRun = 0;
    } else if (start !== null) {
      quietRun++;
      // Two seconds of silence marks a real boundary, not a musical rest.
      if (quietRun >= 2) {
        const end = s - quietRun;
        if (end - start >= 20) segments.push({ startSec: start, endSec: end });
        start = null;
        quietRun = 0;
      }
    }
  }
  if (start !== null && energyPerSec.length - start >= 20) {
    segments.push({ startSec: start, endSec: energyPerSec.length });
  }
  return segments;
}

export async function analyse(
  file: string,
  windowSec = 90,
  forceSegment?: number,
): Promise<BeatGrid> {
  const pcm = await decodeMono(file);
  const durationSec = pcm.length / SR;
  const { curve, hopSec } = novelty(pcm);

  // Per-second RMS drives both segmentation and section scoring.
  const energyPerSec: number[] = [];
  for (let s = 0; s < Math.floor(durationSec); s++) {
    let acc = 0;
    const from = s * SR;
    const to = Math.min(pcm.length, from + SR);
    for (let i = from; i < to; i++) acc += pcm[i] * pcm[i];
    energyPerSec.push(Number(Math.sqrt(acc / Math.max(1, to - from)).toFixed(5)));
  }

  const allAccents = (from: number, to: number): number[] => {
    const out: number[] = [];
    const win = Math.round(2 / hopSec);
    const f0 = Math.max(1, Math.floor(from / hopSec));
    const f1 = Math.min(curve.length - 1, Math.ceil(to / hopSec));
    for (let f = f0; f < f1; f++) {
      if (curve[f] <= curve[f - 1] || curve[f] < curve[f + 1]) continue;
      const a = Math.max(0, f - win);
      const b = Math.min(curve.length, f + win);
      let sum = 0;
      for (let i = a; i < b; i++) sum += curve[i];
      if (curve[f] > (sum / (b - a)) * 6) out.push(Number((f * hopSec).toFixed(3)));
    }
    return out;
  };

  const raw = segmentByGaps(energyPerSec);
  const peak = Math.max(...energyPerSec);

  const segments: Segment[] = raw.map((r, index) => {
    const slice = energyPerSec.slice(r.startSec, r.endSec);
    const mean = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
    const half = Math.floor(slice.length / 2);
    const firstHalf = slice.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
    const secondHalf = slice.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, slice.length - half);

    const segCurve = curve.slice(
      Math.floor(r.startSec / hopSec),
      Math.floor(r.endSec / hopSec),
    ) as Float32Array;
    const bpm = segCurve.length > 100 ? estimateTempo(segCurve, hopSec) : 0;
    const accents = allAccents(r.startSec, r.endSec).length;

    const duration = r.endSec - r.startSec;
    const longEnough = duration >= windowSec ? 1 : duration / windowSec;
    const buildSlope = secondHalf - firstHalf;

    return {
      index,
      startSec: r.startSec,
      endSec: r.endSec,
      durationSec: duration,
      meanEnergy: Number(mean.toFixed(5)),
      peakEnergy: Number(Math.max(...slice).toFixed(5)),
      buildSlope: Number(buildSlope.toFixed(5)),
      bpm: Number(bpm.toFixed(2)),
      accents,
      // Loud, long enough, and preferably still rising at the end.
      score: Number(
        (
          (mean / peak) * 0.55 +
          longEnough * 0.3 +
          Math.max(0, buildSlope / peak) * 0.15
        ).toFixed(4),
      ),
    };
  });

  const chosen =
    forceSegment !== undefined && segments[forceSegment]
      ? segments[forceSegment]
      : segments.slice().sort((a, b) => b.score - a.score)[0];

  const segCurve = curve.slice(
    Math.floor(chosen.startSec / hopSec),
    Math.floor(chosen.endSec / hopSec),
  ) as Float32Array;
  const bpm = estimateTempo(segCurve, hopSec);
  const phaseInSeg = lockPhase(segCurve, hopSec, bpm);
  const period = 60 / bpm;

  const beatSec: number[] = [];
  for (let t = chosen.startSec + phaseInSeg; t < chosen.endSec; t += period) {
    beatSec.push(Number(t.toFixed(3)));
  }

  return {
    file,
    durationSec: Number(durationSec.toFixed(2)),
    bpm: Number(bpm.toFixed(2)),
    beatSec,
    energyPerSec,
    bestWindowStartSec: beatSec[0] ?? chosen.startSec,
    accentSec: allAccents(chosen.startSec, chosen.endSec),
    segments,
    chosenSegment: chosen.index,
  };
}

// CLI
if (process.argv[1]?.includes('beatgrid')) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: beatgrid.ts <audio file> [--window 90]');
  const wIdx = process.argv.indexOf('--window');
  const windowSec = wIdx > 0 ? Number(process.argv[wIdx + 1]) : 90;

  const segIdx = process.argv.indexOf('--segment');
  const forceSegment = segIdx > 0 ? Number(process.argv[segIdx + 1]) : undefined;

  const g = await analyse(file, windowSec, forceSegment);
  const mmss = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  console.log(`file      ${path.basename(g.file)}`);
  console.log(`duration  ${g.durationSec}s (${mmss(g.durationSec)}) — a compilation, not one piece`);
  console.log(`\ndetected ${g.segments.length} separate pieces:\n`);
  const peak = Math.max(...g.energyPerSec);
  for (const s of g.segments) {
    const bar = '#'.repeat(Math.round((s.meanEnergy / peak) * 24));
    const build = s.buildSlope > 0 ? `builds +${(s.buildSlope / peak * 100).toFixed(0)}%` : 'decays';
    const mark = s.index === g.chosenSegment ? ' <== CHOSEN' : '';
    console.log(
      `  [${String(s.index).padStart(2)}] ${mmss(s.startSec)}–${mmss(s.endSec)}  ${String(s.durationSec).padStart(4)}s  ` +
        `${String(s.bpm).padStart(6)} BPM  ${bar.padEnd(24)} ${build.padEnd(12)} score ${s.score}${mark}`,
    );
  }

  const c = g.segments[g.chosenSegment];
  console.log(`\nchosen piece  #${c.index}  ${mmss(c.startSec)}–${mmss(c.endSec)} (${c.durationSec}s)`);
  console.log(`tempo         ${g.bpm} BPM — beat every ${(60 / g.bpm).toFixed(3)}s, bar every ${((4 * 60) / g.bpm).toFixed(2)}s`);
  console.log(`beats in it   ${g.beatSec.length}`);
  console.log(`accents       ${g.accentSec.length}`);
  console.log(`drop in at    ${g.bestWindowStartSec}s (${mmss(g.bestWindowStartSec)})`);

  fs.mkdirSync('demo-run/music', { recursive: true });
  fs.writeFileSync('demo-run/music/beatgrid.json', JSON.stringify(g, null, 2));
  console.log('\nwrote demo-run/music/beatgrid.json');
}
