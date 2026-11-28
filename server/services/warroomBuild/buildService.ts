import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { runWithAbortSignal } from '../ai/abortContext.js';
import { PEACE_FEED_EMPTY_WARNING } from '../generation/peaceFeedCore.js';
import { assembleReview, peaceStageInput, stageInput } from './assemble.js';
import {
  PAGES_SKIP_WARNING,
  activeStages,
  canonicalHash,
  describeGenerationFailure,
  markDone,
  markFailed,
  markInterrupted,
  markRunning,
  markSkipped,
  nextStage,
  resetForResume,
  restartLine,
  stageLabel,
  stageStartedLine,
  toView,
} from './buildCore.js';
import { BuildServiceError, CancelledError, LeaseLostError, ShutdownError } from './buildErrors.js';
import { isDurableSchemaMissing, noteDurableBuildsUnavailable } from './schemaError.js';
import type { BuildStore, LogDraft, StartResult } from './buildStore.js';
import type { PeaceStageRunner, StageContext, StageRunner } from './stageRunners.js';
import {
  type BuildRequest,
  type BuildRow,
  type BuildStage,
  type BuildView,
  type ExtendedStage,
  type LogLine,
  type ReviewPayload,
  type StageStates,
} from './buildTypes.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  constructor(private ms = Date.parse('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface BuildServiceOptions {
  store: BuildStore;
  runners: Record<BuildStage, StageRunner> & { peace?: PeaceStageRunner };
  pool: string;
  instanceId: string;
  clock?: Clock;
  maxConcurrent?: number;
  maxActivePerUser?: number;
  leaseSeconds?: number;
  /** Wall-clock renew interval. Defaults to a quarter of the lease. */
  renewEveryMs?: number;
  unwatchedPauseMin?: number;
  maxInterruptions?: number;
  retentionDays?: number;
  /**
   * When false, start and resume claim only the build they just accepted.
   * They do not take the oldest queued build in the pool. The claim loop is
   * what drains the pool, and only the worker process starts it.
   */
  worker?: boolean;
}

interface RunningJob {
  controller: AbortController;
  token: string;
  stage: ExtendedStage | null;
  nextRenew: number;
  done: Promise<void>;
}

const UNWATCHED_LOG = (minutes: number, stage: ExtendedStage | null) =>
  stage
    ? `Paused after the ${stageLabel(stage)} stage because this build wasn't open for ${minutes} minutes.`
    : `Paused because this build wasn't open for ${minutes} minutes.`;

/**
 * Claims builds, runs stages, and releases them on cancel or shutdown.
 * Background loops are started from server/index.ts only when the flag is on.
 */
export class BuildService {
  private readonly store: BuildStore;
  private readonly runners: Record<BuildStage, StageRunner> & { peace?: PeaceStageRunner };
  private readonly pool: string;
  private readonly instanceId: string;
  private readonly clock: Clock;
  private readonly maxConcurrent: number;
  private readonly maxActivePerUser: number;
  private readonly leaseSeconds: number;
  private readonly renewMs: number;
  private readonly unwatchedPauseMin: number;
  private readonly maxInterruptions: number;
  private readonly retentionDays: number;
  private readonly worker: boolean;
  private readonly running = new Map<string, RunningJob>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly seenAt = new Map<string, number>();
  private shuttingDown = false;
  /** Claim work. A hung claim stays on this queue and does not block renewals. */
  private tickQueue: Promise<void> = Promise.resolve();
  /** Lease renewal. Independent of tickQueue so a stuck claim cannot expire leases. */
  private renewQueue: Promise<void> = Promise.resolve();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private claimTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private schemaRetry: ReturnType<typeof setTimeout> | null = null;
  /** Set when the process asks for renewal even if it is not the claim worker. */
  private leaseRenewalRequested = false;
  private claimRequested = false;
  private sweepRequested = false;
  private schemaMissing = false;
  private claimPollMs = 5000;
  private sweepEveryMs = 60 * 60 * 1000;
  private readonly loopLoggedAt = new Map<string, number>();

  constructor(options: BuildServiceOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.pool = options.pool;
    this.instanceId = options.instanceId;
    this.clock = options.clock ?? systemClock;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxActivePerUser = options.maxActivePerUser ?? 2;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.renewMs = options.renewEveryMs ?? (this.leaseSeconds * 1000) / 4;
    this.unwatchedPauseMin = options.unwatchedPauseMin ?? 45;
    this.maxInterruptions = options.maxInterruptions ?? 3;
    this.retentionDays = options.retentionDays ?? 7;
    this.worker = options.worker ?? true;
  }

  private iso(): string {
    return this.clock.now().toISOString();
  }

  async start(input: {
    draftId: string;
    userId: string;
    request: BuildRequest;
    idempotencyKey: string;
    replaceActive?: boolean;
  }): Promise<StartResult> {
    const result = await this.store.start({
      draftId: input.draftId,
      userId: input.userId,
      pool: this.pool,
      request: input.request,
      requestHash: canonicalHash(input.request),
      idempotencyKey: input.idempotencyKey,
      replaceActive: input.replaceActive ?? false,
      maxActivePerUser: this.maxActivePerUser,
    });
    if (
      result.outcome === 'created' ||
      result.outcome === 'replayed' ||
      result.outcome === 'attached'
    ) {
      await this.kick(result.buildId);
    }
    return result;
  }

  async get(
    buildId: string,
    after = 0,
  ): Promise<{ build: BuildView; log: LogLine[]; next_after: number } | null> {
    await this.touchSeen(buildId);
    const row = await this.store.get(buildId);
    if (!row) return null;
    const log = await this.store.listLog(buildId, after, 200);
    const next_after = log.length > 0 ? log[log.length - 1].seq : after;
    return { build: toView(row, env.enablePeaceFeedBuildStage), log, next_after };
  }

  async review(buildId: string): Promise<ReviewPayload> {
    const row = await this.store.get(buildId);
    if (!row) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    if (row.status !== 'succeeded') {
      throw new BuildServiceError('Build is not finished', 'BUILD_NOT_DONE');
    }
    return assembleReview(row.request, await this.store.getOutputs(buildId));
  }

  getRow(buildId: string): Promise<BuildRow | null> {
    return this.store.get(buildId);
  }

  latestForDraft(draftId: string): Promise<BuildRow | null> {
    return this.store.latestForDraft(draftId);
  }

  async resume(buildId: string): Promise<BuildRow> {
    const row = await this.store.get(buildId);
    if (!row) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    const outcome = await this.store.resume(
      buildId,
      resetForResume(row.stage_states, env.enablePeaceFeedBuildStage),
    );
    if (outcome === 'missing') throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    if (outcome === 'active_conflict') {
      throw new BuildServiceError('A build is already running for this draft.', 'BUILD_ACTIVE');
    }
    if (outcome === 'not_resumable') {
      const current = await this.store.get(buildId);
      if (!current) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
      // The other resume already queued or claimed this build. That call is a no-op.
      if (current.status === 'queued' || current.status === 'running') return current;
      throw new BuildServiceError('Build cannot be resumed', 'BUILD_NOT_RESUMABLE');
    }
    await this.kick(buildId);
    const next = await this.store.get(buildId);
    if (!next) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    return next;
  }

  async cancel(buildId: string): Promise<BuildRow | null> {
    const row = await this.store.get(buildId);
    if (!row) return null;
    if (row.status === 'queued') return this.store.cancelQueued(buildId, 'user');
    if (row.status !== 'running') return row;
    const job = this.running.get(buildId);
    await this.store.requestCancel(buildId, 'user');
    if (job) {
      job.controller.abort(new CancelledError());
      await job.done;
    }
    return this.store.get(buildId);
  }

  async touchSeen(buildId: string): Promise<void> {
    const now = this.clock.now().getTime();
    const previous = this.seenAt.get(buildId) ?? 0;
    if (now - previous < 10_000) return;
    this.seenAt.set(buildId, now);
    await this.store.touchSeen(buildId);
  }

  /**
   * Renew leases this instance holds, then claim until the concurrency cap.
   * Claims are serialised on their own queue. Renewals use a second queue, so a
   * hung claim cannot hold the lease past its expiry.
   */
  async tick(): Promise<void> {
    await this.chain('renew', () => this.renewDue());
    await this.chain('tick', () => this.claimUntilCap());
  }

  /**
   * After listen. A missing migration logs once and skips the loops, then looks
   * again once a minute. A transient probe error still starts the loops; their
   * bodies catch their own failures.
   */
  async startBackground(pollMs: number): Promise<void> {
    this.claimPollMs = pollMs;
    if (this.shuttingDown) return;
    try {
      try {
        await this.store.probeSchema();
      } catch (err) {
        if (isDurableSchemaMissing(err)) {
          this.schemaMissing = true;
          noteDurableBuildsUnavailable();
          this.leaseRenewalRequested = true;
          this.claimRequested = this.worker;
          this.sweepRequested = this.worker;
          this.armSchemaRecheck();
          return;
        }
        this.noteLoopError('probe', err);
      }
      this.startLeaseRenewal();
      if (!this.worker) return;
      this.startClaimLoop(pollMs);
      this.startSweepLoop();
    } catch (err) {
      this.noteLoopError('probe', err);
    }
  }

  /** Keep leases alive for builds this process is running, even when it does not claim. */
  startLeaseRenewal(): void {
    this.leaseRenewalRequested = true;
    this.ensureRenewLoop();
  }

  /** Background claim loop. Only the worker process should start this. */
  startClaimLoop(pollMs: number): void {
    this.claimPollMs = pollMs;
    this.claimRequested = true;
    if (this.claimTimer || this.shuttingDown || this.schemaMissing) return;
    const timer = setInterval(() => {
      void this.tick().catch((err) => this.noteLoopError('claim', err));
    }, pollMs);
    timer.unref?.();
    this.claimTimer = timer;
  }

  /** Hourly deletion of old terminal builds. Only the worker process should start this. */
  startSweepLoop(intervalMs = 60 * 60 * 1000): void {
    this.sweepEveryMs = intervalMs;
    this.sweepRequested = true;
    if (this.sweepTimer || this.shuttingDown || this.schemaMissing) return;
    const timer = setInterval(() => {
      void this.sweep().catch((err) => this.noteLoopError('sweep', err));
    }, intervalMs);
    timer.unref?.();
    this.sweepTimer = timer;
  }

  private chain(queue: 'tick' | 'renew', fn: () => Promise<void>): Promise<void> {
    const current = queue === 'tick' ? this.tickQueue : this.renewQueue;
    const run = current.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    if (queue === 'tick') this.tickQueue = settled;
    else this.renewQueue = settled;
    return run;
  }

  /** Worker: drain the pool. Anyone else: claim only the build just accepted. */
  private async kick(buildId: string | null): Promise<void> {
    if (this.worker) {
      await this.tick();
      return;
    }
    if (!buildId || this.shuttingDown || this.schemaMissing) return;
    if (this.running.size >= this.maxConcurrent) return;
    const row = await this.store.claimQueued(
      buildId,
      this.pool,
      this.instanceId,
      this.leaseSeconds,
    );
    if (!row) return;
    await this.beginClaimed(row);
  }

  private ensureRenewLoop(): void {
    if (this.renewTimer || this.shuttingDown) return;
    const timer = setInterval(() => {
      void this.chain('renew', () => this.renewDue()).catch((err) =>
        this.noteLoopError('renew', err),
      );
    }, this.renewMs);
    timer.unref?.();
    this.renewTimer = timer;
  }

  private async claimUntilCap(): Promise<void> {
    if (this.shuttingDown || this.schemaMissing) return;
    while (this.running.size < this.maxConcurrent) {
      const row = await this.store.claim(this.pool, this.instanceId, this.leaseSeconds);
      if (!row) return;
      const started = await this.beginClaimed(row);
      if (!started) return;
    }
  }

  /** @returns false when the row had no lease and the caller should stop claiming. */
  private async beginClaimed(row: BuildRow): Promise<boolean> {
    if (!row.lease_token) return false;
    if (row.interruptions > this.maxInterruptions) {
      const stage = nextStage(row.stage_states, this.peaceOn()) ?? row.current_stage ?? 'characters';
      const error = `The server restarted ${row.interruptions} times while building. Retry continues from the ${stageLabel(stage)} stage.`;
      const stageStates = markFailed(row.stage_states, stage, error, this.iso(), this.peaceOn());
      await this.store.failRunning(row.id, row.lease_token, {
        stageStates,
        error,
        errorCode: 'interrupted_too_often',
      });
      return true;
    }
    this.track(this.runClaimed(row));
    return true;
  }

  private noteLoopError(kind: string, err: unknown): void {
    if (isDurableSchemaMissing(err)) {
      this.schemaMissing = true;
      noteDurableBuildsUnavailable();
      this.stopClaimLoop();
      this.stopSweepLoop();
      this.armSchemaRecheck();
      return;
    }
    const now = Date.now();
    const previous = this.loopLoggedAt.get(kind) ?? 0;
    if (now - previous < 30_000) return;
    this.loopLoggedAt.set(kind, now);
    logger.error({ err, kind }, 'warroom_build_loop_failed');
  }

  private armSchemaRecheck(): void {
    if (this.schemaRetry || this.shuttingDown) return;
    const timer = setTimeout(() => {
      this.schemaRetry = null;
      void this.recheckSchema();
    }, 60_000);
    timer.unref?.();
    this.schemaRetry = timer;
  }

  private async recheckSchema(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      await this.store.probeSchema();
    } catch (err) {
      this.noteLoopError('probe', err);
      this.armSchemaRecheck();
      return;
    }
    this.schemaMissing = false;
    if (this.leaseRenewalRequested || this.running.size > 0) this.startLeaseRenewal();
    if (this.claimRequested) this.startClaimLoop(this.claimPollMs);
    if (this.sweepRequested) this.startSweepLoop(this.sweepEveryMs);
  }

  private stopClaimLoop(): void {
    if (this.claimTimer) clearInterval(this.claimTimer);
    this.claimTimer = null;
  }

  private stopSweepLoop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.claimTimer) clearInterval(this.claimTimer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.schemaRetry) clearTimeout(this.schemaRetry);
    this.claimTimer = null;
    this.renewTimer = null;
    this.sweepTimer = null;
    this.schemaRetry = null;
    const jobs = [...this.running.entries()];
    for (const [, job] of jobs) job.controller.abort(new ShutdownError());
    // A runner that ignores the abort must not hold the release past the 5 s
    // process grace. Release anyway after 3 s; the token fence stops a late write.
    await waitForSettled(
      jobs.map(([, job]) => job.done),
      3_000,
    );
    for (const [buildId, job] of jobs) {
      const row = await this.store.get(buildId);
      if (!row || row.lease_token !== job.token || !job.stage) continue;
      const stageStates = markInterrupted(row.stage_states, job.stage, this.iso());
      await this.store.appendLog(
        buildId,
        [{ kind: 'system', stage: job.stage, message: restartLine(job.stage) }],
        job.token,
      );
      await this.store.releaseForRestart(buildId, job.token, stageStates);
    }
  }

  async sweep(): Promise<number> {
    return this.store.sweep(this.retentionDays);
  }

  private track(work: Promise<void>): void {
    const guarded = work.catch((err) => this.noteLoopError('build', err));
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  private async renewDue(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const [buildId, job] of this.running) {
      if (now < job.nextRenew) continue;
      job.nextRenew = now + this.renewMs;
      const result = await this.store.renewLease(buildId, job.token, this.leaseSeconds);
      if (result === 'ok') continue;
      job.controller.abort(
        result === 'cancel_requested' ? new CancelledError() : new LeaseLostError(),
      );
    }
  }

  private async runClaimed(row: BuildRow): Promise<void> {
    const token = row.lease_token;
    if (!token) return;
    const controller = new AbortController();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const job: RunningJob = {
      controller,
      token,
      stage: row.current_stage,
      nextRenew: this.clock.now().getTime() + this.renewMs,
      done,
    };
    this.running.set(row.id, job);
    this.ensureRenewLoop();
    const buffer: LogDraft[] = [];
    const log = (kind: LogDraft['kind'], message: string, stage: string | null) => {
      buffer.push({ kind, stage, message });
    };
    try {
      let states: StageStates = row.stage_states;
      while (!this.shuttingDown && !controller.signal.aborted) {
        const fresh = await this.store.get(row.id);
        if (!fresh || fresh.lease_token !== token || fresh.status !== 'running') return;
        if (this.shuttingDown || controller.signal.reason instanceof ShutdownError) return;
        if (fresh.cancel_requested_at || controller.signal.aborted) {
          await this.settleRequestedCancel(row.id, token, states, job.stage);
          return;
        }
        const paused = await this.pauseIfUnwatched(fresh, token);
        if (paused) return;
        const stage = nextStage(states, this.peaceOn());
        if (!stage) {
          // Every stage is already done. This only happens if the last complete raced.
          await this.finishSucceeded(row.id, token, states);
          return;
        }
        const now = this.iso();
        states = markRunning(states, stage, now, this.peaceOn());
        job.stage = stage;
        const marked = await this.store.updateRunning(row.id, token, {
          stage_states: states,
          current_stage: stage,
        });
        if (!marked) return;
        const running = states[stage];
        log('stage', stageStartedLine(stage, running?.attempts ?? 1), stage);
        await this.flush(row.id, buffer, token);
        let output: unknown;
        try {
          const outputs = await this.store.getOutputs(row.id);
          const ctx: StageContext = {
            signal: controller.signal,
            log: (kind, message) => log(kind, message, stage),
          };
          output = await runWithAbortSignal(controller.signal, () => {
            if (stage === 'peace') {
              const peaceRunner = this.runners.peace;
              if (!peaceRunner) {
                ctx.log('warning', PEACE_FEED_EMPTY_WARNING);
                return Promise.resolve({ peace_period: null, warning: PEACE_FEED_EMPTY_WARNING });
              }
              return peaceRunner(peaceStageInput(fresh.request, outputs), ctx);
            }
            return this.runners[stage](stageInput(stage, fresh.request, outputs), ctx);
          });
        } catch (err) {
          await this.flush(row.id, buffer, token);
          const recovered = await this.onRunnerError(
            row.id,
            token,
            stage,
            states,
            controller.signal,
            err,
          );
          if (!recovered) return;
          states = recovered;
          continue;
        }
        if (controller.signal.aborted) {
          await this.flush(row.id, buffer, token);
          const recovered = await this.onRunnerError(
            row.id,
            token,
            stage,
            states,
            controller.signal,
            controller.signal.reason,
          );
          if (!recovered) return;
          states = recovered;
          continue;
        }
        await this.flush(row.id, buffer, token);
        states = markDone(states, stage, this.iso(), this.peaceOn());
        const next = nextStage(states, this.peaceOn());
        const attempts = states[stage]?.attempts ?? 1;
        const wrote = await this.store.completeStage({
          buildId: row.id,
          leaseToken: token,
          stage,
          attempt: attempts,
          output,
          stageStates: states,
          nextStage: next,
          finalStatus: next ? null : 'succeeded',
        });
        if (!wrote) return;
        if (this.shuttingDown || controller.signal.reason instanceof ShutdownError) return;
        if (controller.signal.aborted || (await this.cancelWasRequested(row.id, token))) {
          await this.settleRequestedCancel(row.id, token, states, job.stage);
          return;
        }
        if (!next) return;
      }
    } finally {
      await this.flush(row.id, buffer, token);
      this.running.delete(row.id);
      if (this.running.size === 0 && !this.leaseRenewalRequested && this.renewTimer) {
        clearInterval(this.renewTimer);
        this.renewTimer = null;
      }
      resolveDone();
    }
  }

  private async cancelWasRequested(buildId: string, token: string): Promise<boolean> {
    const fresh = await this.store.get(buildId);
    return Boolean(
      fresh &&
      fresh.lease_token === token &&
      fresh.status === 'running' &&
      fresh.cancel_requested_at,
    );
  }

  /** Cancel that landed after a stage finished, before the next one started. */
  private async settleRequestedCancel(
    buildId: string,
    token: string,
    states: StageStates,
    stage: ExtendedStage | null,
  ): Promise<void> {
    const runningStage =
      activeStages(this.peaceOn()).find((name) => states[name]?.status === 'running') ?? null;
    const stageStates = runningStage
      ? markInterrupted(states, runningStage, this.iso(), this.peaceOn())
      : states;
    await this.store.appendLog(
      buildId,
      [{ kind: 'system', stage: runningStage ?? stage, message: 'Build cancelled.' }],
      token,
    );
    await this.store.settleCancel(buildId, token, stageStates, 'user');
  }

  /** The last stage that actually finished. Not the stage a claim is about to run. */
  private peaceOn(): boolean {
    return env.enablePeaceFeedBuildStage;
  }

  private lastFinishedStage(states: StageStates): ExtendedStage | null {
    let previous: ExtendedStage | null = null;
    for (const stage of activeStages(this.peaceOn())) {
      const status = states[stage]?.status;
      if (status === 'done' || status === 'skipped') previous = stage;
      else break;
    }
    return previous;
  }

  private async pauseIfUnwatched(row: BuildRow, token: string): Promise<boolean> {
    const seen = Date.parse(row.last_seen_at);
    const ageMs = this.clock.now().getTime() - seen;
    if (ageMs < this.unwatchedPauseMin * 60_000) return false;
    const previous = this.lastFinishedStage(row.stage_states);
    const written = await this.store.appendLog(
      row.id,
      [
        {
          kind: 'system',
          stage: previous,
          message: UNWATCHED_LOG(this.unwatchedPauseMin, previous),
        },
      ],
      token,
    );
    if (written.length === 0) return true;
    await this.store.pauseUnwatched(row.id, token);
    return true;
  }

  private async finishSucceeded(
    buildId: string,
    token: string,
    states: StageStates,
  ): Promise<void> {
    const stage = (['characters', 'storyline', 'convergence', 'pages'] as const).find(
      (name) => states[name]?.status === 'done' || states[name]?.status === 'skipped',
    );
    if (!stage) return;
    await this.store.completeStage({
      buildId,
      leaseToken: token,
      stage,
      attempt: states[stage].attempts,
      output: (await this.store.getOutputs(buildId))[stage] ?? {},
      stageStates: states,
      nextStage: null,
      finalStatus: 'succeeded',
    });
  }

  /**
   * `null` stops the claim loop. A returned state means a soft skip (pages, or
   * peace) and the loop should run whatever stage is next. Peace never fails
   * the build.
   */
  private async onRunnerError(
    buildId: string,
    token: string,
    stage: ExtendedStage,
    states: StageStates,
    signal: AbortSignal,
    err: unknown,
  ): Promise<StageStates | null> {
    const reason = signal.aborted ? signal.reason : err;
    if (this.shuttingDown || reason instanceof ShutdownError) return null;
    if (reason instanceof LeaseLostError) return null;
    if (reason instanceof CancelledError) {
      const interrupted = markInterrupted(states, stage, this.iso(), this.peaceOn());
      await this.store.appendLog(
        buildId,
        [{ kind: 'system', stage, message: 'Build cancelled.' }],
        token,
      );
      await this.store.settleCancel(buildId, token, interrupted, 'user');
      return null;
    }
    if (stage === 'peace') {
      const skipped = markSkipped(states, stage, PEACE_FEED_EMPTY_WARNING, this.iso(), true);
      await this.store.appendLog(
        buildId,
        [{ kind: 'warning', stage, message: PEACE_FEED_EMPTY_WARNING }],
        token,
      );
      const next = nextStage(skipped, true);
      await this.store.completeStage({
        buildId,
        leaseToken: token,
        stage,
        attempt: skipped.peace?.attempts ?? 0,
        output: { peace_period: null, warning: PEACE_FEED_EMPTY_WARNING },
        stageStates: skipped,
        nextStage: next,
        finalStatus: next ? null : 'succeeded',
      });
      return next ? skipped : null;
    }
    if (stage === 'pages') {
      const skipped = markSkipped(states, stage, PAGES_SKIP_WARNING, this.iso(), this.peaceOn());
      await this.store.appendLog(
        buildId,
        [{ kind: 'warning', stage, message: PAGES_SKIP_WARNING }],
        token,
      );
      const next = nextStage(skipped, this.peaceOn());
      await this.store.completeStage({
        buildId,
        leaseToken: token,
        stage,
        attempt: skipped[stage].attempts,
        output: { skipped: true },
        stageStates: skipped,
        nextStage: next,
        finalStatus: next ? null : 'succeeded',
      });
      return next ? skipped : null;
    }
    const message = describeGenerationFailure(reason, stageLabel(stage));
    const failed = markFailed(states, stage, message, this.iso(), this.peaceOn());
    await this.store.appendLog(buildId, [{ kind: 'error', stage, message }], token);
    await this.store.failRunning(buildId, token, {
      stageStates: failed,
      error: message,
      errorCode: 'stage_failed',
    });
    return null;
  }

  private async flush(buildId: string, buffer: LogDraft[], token: string): Promise<void> {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, buffer.length);
    await this.store.appendLog(buildId, lines, token);
  }
}

/** Resolves when every job finishes, or when `ms` elapses, whichever is first. */
function waitForSettled(jobs: Promise<void>[], ms: number): Promise<void> {
  if (jobs.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void Promise.all(jobs).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
