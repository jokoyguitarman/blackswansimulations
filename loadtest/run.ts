import dotenv from 'dotenv';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

// Load env from the root .env if present, falling back to frontend/.env.local
// (where this repo keeps SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in dev).
dotenv.config();
dotenv.config({ path: 'frontend/.env.local' });
import {
  createAdminClient,
  provisionUsers,
  registerParticipants,
  type HarnessUsers,
} from './setup.js';
import {
  apiFetch,
  createSession,
  pickScenario,
  teardownSession,
  type ApiClient,
  type DemoMode,
  type Gametype,
  type SessionHandle,
} from './session.js';
import { Spectator, PROBE_PREFIX } from './spectator.js';
import {
  detectKnee,
  percentile,
  printStageTable,
  writeJsonReport,
  type GametypeRun,
  type SessionStageStat,
  type StageResult,
} from './report.js';

/**
 * Load-test harness entry point.
 *
 *   npm run loadtest -- --users 200 --url http://localhost:3001 --gametype both
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the root .env
 * (the same values the server uses) and a running server at --url.
 */

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '100' },
    url: { type: 'string', default: 'http://localhost:3001' },
    gametype: { type: 'string', default: 'both' },
    stages: { type: 'string', default: '25,50,100,200' },
    // Multi-session mode: ramp by session count instead of player count.
    // e.g. --sessions "2,5,10" --players-per-session 100
    sessions: { type: 'string' },
    'players-per-session': { type: 'string', default: '100' },
    'stage-duration': { type: 'string', default: '60' },
    'probe-interval': { type: 'string', default: '5' },
    demo: { type: 'string', default: 'off' },
    scenario: { type: 'string' },
    report: { type: 'string', default: 'loadtest-report.json' },
  },
});

const log = (msg: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseConfig() {
  const maxUsers = Math.max(1, Number(args.users));
  const stageDurationSec = Math.max(10, Number(args['stage-duration']));
  const probeIntervalSec = Math.max(1, Number(args['probe-interval']));
  const demo = args.demo as DemoMode;
  if (!['off', 'scripted', 'ai'].includes(demo)) throw new Error(`Invalid --demo: ${args.demo}`);
  if (!['field', 'social', 'both'].includes(args.gametype!)) {
    throw new Error(`Invalid --gametype: ${args.gametype}`);
  }
  const gametypes: Gametype[] =
    args.gametype === 'both' ? ['field', 'social'] : [args.gametype as Gametype];

  // Split on commas or whitespace (PowerShell turns `--stages 3,6` into "3 6").
  const stages = [
    ...new Set(
      args
        .stages!.split(/[\s,]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= maxUsers),
    ),
  ].sort((a, b) => a - b);
  if (stages.length === 0 || stages[stages.length - 1] < maxUsers) stages.push(maxUsers);

  // Multi-session mode: --sessions "2,5,10" ramps session count with a fixed
  // player count per session; the player-count ramp (--stages) is ignored.
  let sessionStages: number[] | null = null;
  const playersPerSession = Math.max(1, Number(args['players-per-session']));
  if (args.sessions) {
    sessionStages = [
      ...new Set(
        args.sessions
          .split(/[\s,]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ].sort((a, b) => a - b);
    if (sessionStages.length === 0) throw new Error(`Invalid --sessions: ${args.sessions}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }

  return {
    maxUsers,
    stages,
    sessionStages,
    playersPerSession,
    stageDurationSec,
    probeIntervalSec,
    demo,
    gametypes,
    url: (args.url as string).replace(/\/$/, ''),
    scenarioId: args.scenario,
    reportPath: args.report as string,
    supabaseUrl,
    serviceRoleKey,
  };
}

interface ProbeRecord {
  sentAt: number;
  expected: number;
  latencies: number[];
  receivedBy: Set<number>;
}

async function runGametype(
  cfg: ReturnType<typeof parseConfig>,
  api: ApiClient,
  users: HarnessUsers,
  gametype: Gametype,
  onSession: (handle: SessionHandle | null) => void,
): Promise<GametypeRun> {
  const admin = createAdminClient(cfg.supabaseUrl, cfg.serviceRoleKey);
  const scenario = await pickScenario(admin, gametype, cfg.scenarioId);
  const demoMode = gametype === 'field' ? cfg.demo : 'off';
  const handle = await createSession(api, admin, gametype, demoMode, scenario, log);
  onSession(handle);
  await registerParticipants(admin, handle.sessionId, users.players);
  log(`Registered ${users.players.length} participants.`);

  const probes = new Map<string, ProbeRecord>();
  let stagePassiveEvents = 0;
  let stageDisconnects = 0;

  const spectators: Spectator[] = [];
  const callbacks = {
    onProbe: (probeId: string, spectatorIndex: number, receivedAt: number) => {
      const probe = probes.get(probeId);
      if (!probe || probe.receivedBy.has(spectatorIndex)) return;
      probe.receivedBy.add(spectatorIndex);
      probe.latencies.push(receivedAt - probe.sentAt);
    },
    onPassiveEvent: () => {
      stagePassiveEvents++;
    },
    onDisconnect: () => {
      stageDisconnects++;
    },
  };

  const stageResults: StageResult[] = [];

  try {
    for (const target of cfg.stages) {
      // Ramp: connect the additional spectators for this stage.
      let connectFailures = 0;
      const toAdd: Spectator[] = [];
      for (let i = spectators.length; i < target; i++) {
        toAdd.push(
          new Spectator(
            i,
            cfg.url,
            users.players[i].token,
            handle.sessionId,
            handle.probeChannelId,
            callbacks,
          ),
        );
      }
      log(`Stage ${target}: connecting ${toAdd.length} more players...`);
      for (let i = 0; i < toAdd.length; i += 20) {
        const batch = toAdd.slice(i, i + 20);
        const outcomes = await Promise.allSettled(batch.map((s) => s.connect()));
        outcomes.forEach((o) => {
          if (o.status === 'rejected') {
            connectFailures++;
            log(`  connect failure: ${(o.reason as Error).message}`);
          }
        });
      }
      spectators.push(...toAdd);
      await sleep(2000); // let join_session settle server-side

      // Measure: send probes for the stage duration.
      stagePassiveEvents = 0;
      stageDisconnects = 0;
      const stageProbes: string[] = [];
      const httpDurations: number[] = [];
      let httpErrors = 0;
      const liveCount = spectators.filter((s) => !s.connectFailed).length;
      const probeCount = Math.floor(cfg.stageDurationSec / cfg.probeIntervalSec);
      log(
        `Stage ${target}: measuring for ${cfg.stageDurationSec}s ` +
          `(${probeCount} probes, ${liveCount} live sockets)...`,
      );

      for (let p = 0; p < probeCount; p++) {
        const probeId = randomUUID();
        const record: ProbeRecord = {
          sentAt: Date.now(),
          expected: liveCount,
          latencies: [],
          receivedBy: new Set(),
        };
        probes.set(probeId, record);
        stageProbes.push(probeId);
        try {
          const t0 = Date.now();
          await apiFetch(api, 'POST', `/api/channels/${handle.probeChannelId}/messages`, {
            content: `${PROBE_PREFIX}${probeId}::stage-${target}`,
            message_type: 'text',
          });
          httpDurations.push(Date.now() - t0);
        } catch (err) {
          httpErrors++;
          probes.delete(probeId);
          stageProbes.pop();
          log(`  probe HTTP error: ${(err as Error).message}`);
        }
        const elapsed = Date.now() - record.sentAt;
        await sleep(Math.max(0, cfg.probeIntervalSec * 1000 - elapsed));
      }
      await sleep(3000); // grace period for stragglers

      // Aggregate this stage.
      const allLatencies: number[] = [];
      let expected = 0;
      for (const id of stageProbes) {
        const probe = probes.get(id)!;
        expected += probe.expected;
        allLatencies.push(...probe.latencies);
      }
      allLatencies.sort((a, b) => a - b);
      httpDurations.sort((a, b) => a - b);

      const result: StageResult = {
        gametype,
        players: target,
        durationSec: cfg.stageDurationSec,
        probesSent: stageProbes.length,
        httpErrors,
        httpP95Ms: percentile(httpDurations, 95),
        expectedDeliveries: expected,
        receivedDeliveries: allLatencies.length,
        deliveryRate: expected === 0 ? 0 : allLatencies.length / expected,
        latP50Ms: percentile(allLatencies, 50),
        latP95Ms: percentile(allLatencies, 95),
        latP99Ms: percentile(allLatencies, 99),
        latMaxMs: allLatencies.at(-1) ?? null,
        connectFailures,
        disconnects: stageDisconnects,
        passiveEvents: stagePassiveEvents,
      };
      stageResults.push(result);
      log(
        `Stage ${target} done: p95 ${result.latP95Ms ?? '-'} ms, ` +
          `delivery ${(result.deliveryRate * 100).toFixed(1)}%, ` +
          `disconnects ${result.disconnects}, HTTP errors ${result.httpErrors}`,
      );
    }
  } finally {
    spectators.forEach((s) => s.close());
    await teardownSession(api, handle, log);
    onSession(null);
  }

  return {
    gametype,
    scenarioTitle: handle.scenarioTitle,
    sessionId: handle.sessionId,
    stages: stageResults,
    kneeStage: detectKnee(stageResults),
  };
}

interface LiveSession {
  index: number;
  handle: SessionHandle;
  spectators: Spectator[];
  stageProbeIds: string[];
  stageDisconnects: number;
  stageConnectFailures: number;
}

async function runGametypeMultiSession(
  cfg: ReturnType<typeof parseConfig>,
  api: ApiClient,
  users: HarnessUsers,
  gametype: Gametype,
  onSessionCreated: (handle: SessionHandle) => void,
  onSessionClosed: (handle: SessionHandle) => void,
): Promise<GametypeRun> {
  const admin = createAdminClient(cfg.supabaseUrl, cfg.serviceRoleKey);
  const scenario = await pickScenario(admin, gametype, cfg.scenarioId);
  const demoMode: DemoMode = 'off'; // demo bots are out of scope for multi-session runs

  const sessions: LiveSession[] = [];
  const probes = new Map<string, ProbeRecord & { sessionIndex: number }>();
  let stagePassiveEvents = 0;
  let nextGlobalSpectator = 0;

  const stageResults: StageResult[] = [];

  try {
    for (const targetSessions of cfg.sessionStages!) {
      // --- Ramp: create the additional sessions for this stage ---
      while (sessions.length < targetSessions) {
        const index = sessions.length;
        log(`Creating session ${index + 1}/${targetSessions}...`);
        const handle = await createSession(api, admin, gametype, demoMode, scenario, log);
        onSessionCreated(handle);
        await registerParticipants(admin, handle.sessionId, users.players);
        sessions.push({
          index,
          handle,
          spectators: [],
          stageProbeIds: [],
          stageDisconnects: 0,
          stageConnectFailures: 0,
        });
      }

      // --- Ramp: connect spectators for sessions that don't have them yet ---
      for (const session of sessions) {
        if (session.spectators.length >= cfg.playersPerSession) continue;
        const toAdd: Spectator[] = [];
        while (session.spectators.length + toAdd.length < cfg.playersPerSession) {
          const globalIndex = nextGlobalSpectator++;
          const identity = users.players[globalIndex % users.players.length];
          toAdd.push(
            new Spectator(
              globalIndex,
              cfg.url,
              identity.token,
              session.handle.sessionId,
              session.handle.probeChannelId,
              {
                onProbe: (probeId, spectatorIndex, receivedAt) => {
                  const probe = probes.get(probeId);
                  if (!probe || probe.receivedBy.has(spectatorIndex)) return;
                  probe.receivedBy.add(spectatorIndex);
                  probe.latencies.push(receivedAt - probe.sentAt);
                },
                onPassiveEvent: () => {
                  stagePassiveEvents++;
                },
                onDisconnect: () => {
                  session.stageDisconnects++;
                },
              },
            ),
          );
        }
        log(`Session #${session.index + 1}: connecting ${toAdd.length} players...`);
        for (let i = 0; i < toAdd.length; i += 20) {
          const batch = toAdd.slice(i, i + 20);
          const outcomes = await Promise.allSettled(batch.map((s) => s.connect()));
          outcomes.forEach((o) => {
            if (o.status === 'rejected') {
              session.stageConnectFailures++;
              log(`  connect failure: ${(o.reason as Error).message}`);
            }
          });
        }
        session.spectators.push(...toAdd);
      }
      await sleep(2000); // let join_session settle server-side

      // --- Measure ---
      stagePassiveEvents = 0;
      const stageConnectFailures = sessions.reduce((sum, s) => sum + s.stageConnectFailures, 0);
      for (const s of sessions) {
        s.stageProbeIds = [];
        s.stageDisconnects = 0;
        s.stageConnectFailures = 0;
      }
      const httpDurations: number[] = [];
      let httpErrors = 0;
      const totalLive = sessions.reduce(
        (sum, s) => sum + s.spectators.filter((sp) => !sp.connectFailed).length,
        0,
      );
      const probeCount = Math.floor(cfg.stageDurationSec / cfg.probeIntervalSec);
      log(
        `Stage ${targetSessions} sessions: measuring for ${cfg.stageDurationSec}s ` +
          `(${probeCount} probe cycles x ${sessions.length} sessions, ${totalLive} live sockets)...`,
      );

      // Each cycle sends one probe per session, staggered across the interval
      // so the trainer's REST calls don't burst all at once.
      const intervalMs = cfg.probeIntervalSec * 1000;
      const sliceMs = intervalMs / sessions.length;
      for (let p = 0; p < probeCount; p++) {
        const cycleStart = Date.now();
        const sendTasks = sessions.map((session, i) =>
          (async () => {
            await sleep(Math.round(i * sliceMs));
            const probeId = randomUUID();
            const liveHere = session.spectators.filter((sp) => !sp.connectFailed).length;
            probes.set(probeId, {
              sentAt: Date.now(),
              expected: liveHere,
              latencies: [],
              receivedBy: new Set(),
              sessionIndex: session.index,
            });
            session.stageProbeIds.push(probeId);
            try {
              const t0 = Date.now();
              await apiFetch(
                api,
                'POST',
                `/api/channels/${session.handle.probeChannelId}/messages`,
                {
                  content: `${PROBE_PREFIX}${probeId}::sessions-${targetSessions}`,
                  message_type: 'text',
                },
              );
              httpDurations.push(Date.now() - t0);
            } catch (err) {
              httpErrors++;
              probes.delete(probeId);
              session.stageProbeIds.pop();
              log(`  probe HTTP error (session #${session.index + 1}): ${(err as Error).message}`);
            }
          })(),
        );
        await Promise.allSettled(sendTasks);
        const elapsed = Date.now() - cycleStart;
        await sleep(Math.max(0, intervalMs - elapsed));
      }
      await sleep(3000); // grace period for stragglers

      // --- Aggregate: per session, then overall ---
      const sessionStats: SessionStageStat[] = sessions.map((session) => {
        const lats: number[] = [];
        let expected = 0;
        for (const id of session.stageProbeIds) {
          const probe = probes.get(id)!;
          expected += probe.expected;
          lats.push(...probe.latencies);
        }
        lats.sort((a, b) => a - b);
        return {
          sessionId: session.handle.sessionId,
          sessionIndex: session.index,
          players: session.spectators.filter((sp) => !sp.connectFailed).length,
          probesSent: session.stageProbeIds.length,
          expectedDeliveries: expected,
          receivedDeliveries: lats.length,
          deliveryRate: expected === 0 ? 0 : lats.length / expected,
          latP50Ms: percentile(lats, 50),
          latP95Ms: percentile(lats, 95),
          latP99Ms: percentile(lats, 99),
          disconnects: session.stageDisconnects,
        };
      });

      const allLatencies = sessions
        .flatMap((s) => s.stageProbeIds)
        .flatMap((id) => probes.get(id)!.latencies)
        .sort((a, b) => a - b);
      const expectedTotal = sessionStats.reduce((sum, s) => sum + s.expectedDeliveries, 0);
      httpDurations.sort((a, b) => a - b);

      const result: StageResult = {
        gametype,
        players: totalLive,
        sessionCount: targetSessions,
        durationSec: cfg.stageDurationSec,
        probesSent: sessionStats.reduce((sum, s) => sum + s.probesSent, 0),
        httpErrors,
        httpP95Ms: percentile(httpDurations, 95),
        expectedDeliveries: expectedTotal,
        receivedDeliveries: allLatencies.length,
        deliveryRate: expectedTotal === 0 ? 0 : allLatencies.length / expectedTotal,
        latP50Ms: percentile(allLatencies, 50),
        latP95Ms: percentile(allLatencies, 95),
        latP99Ms: percentile(allLatencies, 99),
        latMaxMs: allLatencies.at(-1) ?? null,
        connectFailures: stageConnectFailures,
        disconnects: sessionStats.reduce((sum, s) => sum + s.disconnects, 0),
        passiveEvents: stagePassiveEvents,
        sessions: sessionStats,
      };
      stageResults.push(result);
      const worstP95 = Math.max(...sessionStats.map((s) => s.latP95Ms ?? 0));
      log(
        `Stage ${targetSessions} sessions done: aggregate p95 ${result.latP95Ms ?? '-'} ms ` +
          `(worst session ${worstP95} ms), delivery ${(result.deliveryRate * 100).toFixed(1)}%, ` +
          `disconnects ${result.disconnects}, HTTP errors ${result.httpErrors}`,
      );
    }
  } finally {
    for (const session of sessions) {
      session.spectators.forEach((s) => s.close());
    }
    for (const session of sessions) {
      await teardownSession(api, session.handle, log);
      onSessionClosed(session.handle);
    }
  }

  return {
    gametype,
    scenarioTitle: scenario.title,
    sessionId: sessions[0]?.handle.sessionId ?? '',
    sessionIds: sessions.map((s) => s.handle.sessionId),
    stages: stageResults,
    kneeStage: detectKnee(stageResults),
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig();
  const multi = cfg.sessionStages !== null;
  const maxSessions = multi ? cfg.sessionStages![cfg.sessionStages!.length - 1] : 1;
  const totalSpectators = multi ? maxSessions * cfg.playersPerSession : cfg.maxUsers;
  // Multi-session runs can need 1,000+ spectators; cap the identity pool so we
  // don't create hundreds of auth users — sockets borrow identities round-robin.
  const identityPool = multi ? Math.min(totalSpectators, 120) : cfg.maxUsers;

  log(
    multi
      ? `Load test: ${cfg.sessionStages!.join(' -> ')} sessions x ${cfg.playersPerSession} players ` +
          `(${totalSpectators} sockets max) against ${cfg.url} (gametypes: ${cfg.gametypes.join(', ')})`
      : `Load test: up to ${cfg.maxUsers} players against ${cfg.url} ` +
          `(gametypes: ${cfg.gametypes.join(', ')}; stages: ${cfg.stages.join(' -> ')})`,
  );

  // Fail fast if the server isn't reachable.
  const health = await fetch(`${cfg.url}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`Server not reachable at ${cfg.url} (GET /api/health failed)`);
  }

  const admin = createAdminClient(cfg.supabaseUrl, cfg.serviceRoleKey);
  const users = await provisionUsers(admin, cfg.supabaseUrl, cfg.serviceRoleKey, identityPool, log);
  const api: ApiClient = { baseUrl: cfg.url, token: users.trainer.token };

  // Best-effort teardown of in-flight sessions on Ctrl+C.
  const activeSessions = new Set<SessionHandle>();
  process.on('SIGINT', () => {
    log(`Interrupted — closing ${activeSessions.size} session(s)...`);
    void Promise.allSettled([...activeSessions].map((h) => teardownSession(api, h, log))).finally(
      () => process.exit(130),
    );
  });

  const runs: GametypeRun[] = [];
  for (const gametype of cfg.gametypes) {
    const run = multi
      ? await runGametypeMultiSession(
          cfg,
          api,
          users,
          gametype,
          (h) => activeSessions.add(h),
          (h) => activeSessions.delete(h),
        )
      : await runGametype(cfg, api, users, gametype, (h) => {
          if (h) activeSessions.add(h);
          else activeSessions.clear();
        });
    runs.push(run);
  }

  for (const run of runs) printStageTable(run);
  writeJsonReport(
    cfg.reportPath,
    {
      serverUrl: cfg.url,
      maxUsers: multi ? totalSpectators : cfg.maxUsers,
      stages: multi ? cfg.sessionStages! : cfg.stages,
      mode: multi ? 'multi-session' : 'single-session',
      playersPerSession: multi ? cfg.playersPerSession : undefined,
      stageDurationSec: cfg.stageDurationSec,
      probeIntervalSec: cfg.probeIntervalSec,
      demoMode: cfg.demo,
    },
    runs,
  );
}

main().catch((err) => {
  console.error(`\nLoad test failed: ${(err as Error).message}`);
  process.exit(1);
});
