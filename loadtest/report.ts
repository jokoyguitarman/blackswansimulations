import fs from 'node:fs';

/** Aggregation and reporting for load-test results. */

export interface SessionStageStat {
  sessionId: string;
  sessionIndex: number;
  players: number;
  probesSent: number;
  expectedDeliveries: number;
  receivedDeliveries: number;
  deliveryRate: number;
  latP50Ms: number | null;
  latP95Ms: number | null;
  latP99Ms: number | null;
  disconnects: number;
}

export interface StageResult {
  gametype: string;
  players: number; // total connected spectators in this stage (all sessions)
  sessionCount?: number; // multi-session runs only
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
  sessions?: SessionStageStat[]; // per-session breakdown (multi-session runs)
}

export interface GametypeRun {
  gametype: string;
  scenarioTitle: string;
  sessionId: string; // first session (kept for single-session compatibility)
  sessionIds?: string[]; // all sessions (multi-session runs)
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
  // A capacity knee is a degradation that persists as load grows: find the
  // trailing run of consecutive breaching stages ending at the highest stage.
  // An isolated breach in an early stage (warm-up, cold caches) is not a knee.
  const breaches = stages.map(
    (s) => (s.latP95Ms !== null && s.latP95Ms > KNEE_P95_MS) || s.deliveryRate < KNEE_DELIVERY,
  );
  if (stages.length === 0 || !breaches[breaches.length - 1]) return null;
  let i = stages.length - 1;
  while (i > 0 && breaches[i - 1]) i--;
  return stages[i].players;
}

const fmtMs = (v: number | null): string => (v === null ? '-' : `${Math.round(v)} ms`);
const fmtPct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export function printStageTable(run: GametypeRun): void {
  const multi = run.stages.some((s) => (s.sessions?.length ?? 0) > 0);
  const cols = [
    ...(multi ? ([['Sess', 5]] as const) : []),
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
  const sessionLabel = run.sessionIds
    ? `${run.sessionIds.length} sessions`
    : `session ${run.sessionId}`;
  console.log(`=== ${run.gametype.toUpperCase()} — "${run.scenarioTitle}" (${sessionLabel}) ===`);
  console.log(cols.map(([name, w]) => pad(name, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const s of run.stages) {
    // Flag only stages that themselves breach a threshold; an isolated breach
    // in an early stage (e.g. instance warm-up) shouldn't taint later stages.
    const isKnee =
      (s.latP95Ms !== null && s.latP95Ms > KNEE_P95_MS) || s.deliveryRate < KNEE_DELIVERY;
    const row = [
      ...(multi ? [pad(String(s.sessionCount ?? 1), 5)] : []),
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

    // Per-session spread: expose the sickest and healthiest session so a
    // single degraded session isn't averaged away.
    if (s.sessions && s.sessions.length > 1) {
      const byP95 = [...s.sessions].sort((a, b) => (a.latP95Ms ?? 0) - (b.latP95Ms ?? 0));
      const best = byP95[0];
      const worst = byP95[byP95.length - 1];
      const worstDelivery = [...s.sessions].sort((a, b) => a.deliveryRate - b.deliveryRate)[0];
      console.log(
        `${' '.repeat(6)}session spread: best p95 ${fmtMs(best.latP95Ms)} (#${best.sessionIndex + 1}), ` +
          `worst p95 ${fmtMs(worst.latP95Ms)} (#${worst.sessionIndex + 1}), ` +
          `lowest delivery ${fmtPct(worstDelivery.deliveryRate)} (#${worstDelivery.sessionIndex + 1})`,
      );
    }
  }

  const unit = multi ? 'players total' : 'players';
  if (run.kneeStage !== null) {
    const lastHealthy = run.stages.filter((s) => s.players < run.kneeStage!).at(-1);
    console.log(
      `Verdict: degradation first observed at ${run.kneeStage} ${unit}` +
        (lastHealthy
          ? `; last healthy stage: ${lastHealthy.players} ${unit}` +
            (multi ? ` (${lastHealthy.sessionCount} sessions).` : '.')
          : '.'),
    );
  } else {
    const top = run.stages.at(-1);
    console.log(
      `Verdict: no degradation observed up to ${top?.players ?? 0} ${unit}` +
        (multi && top ? ` across ${top.sessionCount} sessions` : '') +
        ` (p95 threshold ${KNEE_P95_MS} ms, delivery threshold ${KNEE_DELIVERY * 100}%).`,
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
