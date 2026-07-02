import fs from 'node:fs';

/** Aggregation and reporting for load-test results. */

export interface StageResult {
  gametype: string;
  players: number;
  durationSec: number;
  probesSent: number;
  httpErrors: number;
  httpP95Ms: number | null;
  expectedDeliveries: number;
  receivedDeliveries: number;
  deliveryRate: number; // 0..1
  latP50Ms: number | null;
  latP95Ms: number | null;
  latP99Ms: number | null;
  latMaxMs: number | null;
  connectFailures: number;
  disconnects: number;
  passiveEvents: number;
}

export interface GametypeRun {
  gametype: string;
  scenarioTitle: string;
  sessionId: string;
  stages: StageResult[];
  kneeStage: number | null; // players count of first degraded stage, or null
}

const KNEE_P95_MS = 2000;
const KNEE_DELIVERY = 0.98;

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function detectKnee(stages: StageResult[]): number | null {
  for (const s of stages) {
    if ((s.latP95Ms !== null && s.latP95Ms > KNEE_P95_MS) || s.deliveryRate < KNEE_DELIVERY) {
      return s.players;
    }
  }
  return null;
}

const fmtMs = (v: number | null): string => (v === null ? '-' : `${Math.round(v)} ms`);
const fmtPct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export function printStageTable(run: GametypeRun): void {
  const cols = [
    ['Players', 8],
    ['p50', 10],
    ['p95', 10],
    ['p99', 10],
    ['Delivery', 9],
    ['Drops', 6],
    ['ConnFail', 9],
    ['HTTPerr', 8],
    ['HTTP p95', 10],
    ['Passive', 8],
  ] as const;

  console.log('');
  console.log(
    `=== ${run.gametype.toUpperCase()} — "${run.scenarioTitle}" (session ${run.sessionId}) ===`,
  );
  console.log(cols.map(([name, w]) => pad(name, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const s of run.stages) {
    const isKnee = run.kneeStage !== null && s.players >= run.kneeStage;
    const row = [
      pad(String(s.players), 8),
      pad(fmtMs(s.latP50Ms), 10),
      pad(fmtMs(s.latP95Ms), 10),
      pad(fmtMs(s.latP99Ms), 10),
      pad(fmtPct(s.deliveryRate), 9),
      pad(String(s.disconnects), 6),
      pad(String(s.connectFailures), 9),
      pad(String(s.httpErrors), 8),
      pad(fmtMs(s.httpP95Ms), 10),
      pad(String(s.passiveEvents), 8),
    ].join(' ');
    console.log(isKnee ? `${row}  << DEGRADED` : row);
  }

  if (run.kneeStage !== null) {
    const lastHealthy = run.stages.filter((s) => s.players < run.kneeStage!).at(-1);
    console.log(
      `Verdict: degradation first observed at ${run.kneeStage} players` +
        (lastHealthy ? `; last healthy stage: ${lastHealthy.players} players.` : '.'),
    );
  } else {
    const top = run.stages.at(-1);
    console.log(
      `Verdict: no degradation observed up to ${top?.players ?? 0} players ` +
        `(p95 threshold ${KNEE_P95_MS} ms, delivery threshold ${KNEE_DELIVERY * 100}%).`,
    );
  }
}

export function writeJsonReport(
  path: string,
  meta: Record<string, unknown>,
  runs: GametypeRun[],
): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    thresholds: { p95Ms: KNEE_P95_MS, deliveryRate: KNEE_DELIVERY },
    ...meta,
    runs,
  };
  fs.writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`\nFull report written to ${path}`);
}
