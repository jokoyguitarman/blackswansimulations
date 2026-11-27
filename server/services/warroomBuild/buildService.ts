import { runWithAbortSignal } from '../ai/abortContext.js';
import { assembleReview, stageInput } from './assemble.js';
import {
  PAGES_SKIP_WARNING,
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
  stageStartedLine,
  toView,
} from './buildCore.js';
import { BuildServiceError, CancelledError, LeaseLostError, ShutdownError } from './buildErrors.js';
import type { BuildStore, LogDraft, StartResult } from './buildStore.js';
import type { StageContext, StageRunner } from './stageRunners.js';
import {
  STAGE_LABEL,
  type BuildRequest,
  type BuildRow,
  type BuildStage,
  type BuildView,
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
  runners: Record<BuildStage, StageRunner>;
  pool: string;
  instanceId: string;
  clock?: Clock;
  maxConcurrent?: number;
  maxActivePerUser?: number;
  leaseSeconds?: number;
  unwatchedPauseMin?: number;
  maxInterruptions?: number;
  retentionDays?: number;
}

interface RunningJob {
  controller: AbortController;
  token: string;
  stage: BuildStage | null;
  nextRenew: number;
  done: Promise<void>;
}

const UNWATCHED_LOG = (minutes: number, stage: BuildStage | null) =>
  stage
    ? `Paused after the ${STAGE_LABEL[stage]} stage because this build wasn't open for ${minutes} minutes.`
    : `Paused because this build wasn't open for ${minutes} minutes.`;

/**
 * Claims builds, runs stages, and releases them on cancel or shutdown.
 * Not started from server/index.ts until the routes slice wires it in.
 */
export class BuildService {
  private readonly store: BuildStore;
  private readonly runners: Record<BuildStage, StageRunner>;
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
  private readonly running = new Map<string, RunningJob>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly seenAt = new Map<string, number>();
  private shuttingDown = false;

  constructor(options: BuildServiceOptions) {
    this.store = options.store;
    this.runners = options.runners;
    this.pool = options.pool;
    this.instanceId = options.instanceId;
    this.clock = options.clock ?? systemClock;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxActivePerUser = options.maxActivePerUser ?? 2;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.renewMs = (this.leaseSeconds * 1000) / 4;
    this.unwatchedPauseMin = options.unwatchedPauseMin ?? 45;
    this.maxInterruptions = options.maxInterruptions ?? 3;
    this.retentionDays = options.retentionDays ?? 7;
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
      await this.tick();
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
    return { build: toView(row), log, next_after };
  }

  async review(buildId: string): Promise<ReviewPayload> {
    const row = await this.store.get(buildId);
    if (!row) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    if (row.status !== 'succeeded') {
      throw new BuildServiceError('Build is not finished', 'BUILD_NOT_DONE');
    }
    return assembleReview(row.request, await this.store.getOutputs(buildId));
  }

  async resume(buildId: string): Promise<BuildRow> {
    const row = await this.store.get(buildId);
    if (!row) throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    if (!toView(row).resumable) {
      throw new BuildServiceError('Build cannot be resumed', 'BUILD_NOT_RESUMABLE');
    }
    const outcome = await this.store.resume(buildId, resetForResume(row.stage_states));
    if (outcome === 'active_conflict') {
      throw new BuildServiceError('A build is already running for this draft.', 'BUILD_ACTIVE');
    }
    if (outcome === 'missing') throw new BuildServiceError('Build not found', 'BUILD_NOT_FOUND');
    await this.tick();
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

  /** Renew leases this instance holds, then claim until the concurrency cap. */
  async tick(): Promise<void> {
    if (this.shuttingDown) return;
    await this.renewDue();
    while (this.running.size < this.maxConcurrent) {
      const row = await this.store.claim(this.pool, this.instanceId, this.leaseSeconds);
      if (!row || !row.lease_token) return;
      if (row.interruptions > this.maxInterruptions) {
        const stage = nextStage(row.stage_states) ?? row.current_stage ?? 'characters';
        const error = `The server restarted ${row.interruptions} times while building. Retry continues from the ${STAGE_LABEL[stage]} stage.`;
        const stageStates = markFailed(row.stage_states, stage, error, this.iso());
        await this.store.failRunning(row.id, row.lease_token, {
          stageStates,
          error,
          errorCode: 'interrupted_too_often',
        });
        continue;
      }
      this.track(this.runClaimed(row));
    }
  }

  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const jobs = [...this.running.entries()];
    for (const [, job] of jobs) job.controller.abort(new ShutdownError());
    await Promise.all(jobs.map(([, job]) => job.done));
    for (const [buildId, job] of jobs) {
      const row = await this.store.get(buildId);
      if (!row || row.lease_token !== job.token || !job.stage) continue;
      const stageStates = markInterrupted(row.stage_states, job.stage, this.iso());
      const released = await this.store.releaseForRestart(buildId, job.token, stageStates);
      if (!released) continue;
      await this.store.appendLog(buildId, [
        { kind: 'system', stage: job.stage, message: restartLine(job.stage) },
      ]);
    }
  }

  async sweep(): Promise<number> {
    return this.store.sweep(this.retentionDays);
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
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
    const buffer: LogDraft[] = [];
    const log = (kind: LogDraft['kind'], message: string, stage: string | null) => {
      buffer.push({ kind, stage, message });
    };
    try {
      let states: StageStates = row.stage_states;
      while (!this.shuttingDown && !controller.signal.aborted) {
        const fresh = await this.store.get(row.id);
        if (!fresh || fresh.lease_token !== token || fresh.status !== 'running') return;
        const paused = await this.pauseIfUnwatched(fresh, token, job.stage);
        if (paused) return;
        const stage = nextStage(states);
        if (!stage) {
          // Every stage is already done. This only happens if the last complete raced.
          await this.finishSucceeded(row.id, token, states);
          return;
        }
        const now = this.iso();
        states = markRunning(states, stage, now);
        job.stage = stage;
        const marked = await this.store.updateRunning(row.id, token, {
          stage_states: states,
          current_stage: stage,
        });
        if (!marked) return;
        log('stage', stageStartedLine(stage, states[stage].attempts), stage);
        await this.flush(row.id, buffer);
        let output: unknown;
        try {
          const input = stageInput(stage, fresh.request, await this.store.getOutputs(row.id));
          output = await runWithAbortSignal(controller.signal, () =>
            this.runners[stage](input, {
              signal: controller.signal,
              log: (kind, message) => log(kind, message, stage),
            } satisfies StageContext),
          );
        } catch (err) {
          await this.flush(row.id, buffer);
          await this.onRunnerError(row.id, token, stage, states, controller.signal, err);
          return;
        }
        if (controller.signal.aborted) {
          await this.flush(row.id, buffer);
          await this.onRunnerError(
            row.id,
            token,
            stage,
            states,
            controller.signal,
            controller.signal.reason,
          );
          return;
        }
        await this.flush(row.id, buffer);
        states = markDone(states, stage, this.iso());
        const next = nextStage(states);
        const attempts = states[stage].attempts;
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
        if (!next) return;
      }
    } finally {
      await this.flush(row.id, buffer);
      this.running.delete(row.id);
      resolveDone();
    }
  }

  private async pauseIfUnwatched(
    row: BuildRow,
    token: string,
    previous: BuildStage | null,
  ): Promise<boolean> {
    const seen = Date.parse(row.last_seen_at);
    const ageMs = this.clock.now().getTime() - seen;
    if (ageMs < this.unwatchedPauseMin * 60_000) return false;
    const paused = await this.store.pauseUnwatched(row.id, token);
    if (!paused) return true;
    await this.store.appendLog(row.id, [
      { kind: 'system', stage: previous, message: UNWATCHED_LOG(this.unwatchedPauseMin, previous) },
    ]);
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

  private async onRunnerError(
    buildId: string,
    token: string,
    stage: BuildStage,
    states: StageStates,
    signal: AbortSignal,
    err: unknown,
  ): Promise<void> {
    const reason = signal.aborted ? signal.reason : err;
    if (this.shuttingDown || reason instanceof ShutdownError) return;
    if (reason instanceof LeaseLostError) return;
    if (reason instanceof CancelledError) {
      const interrupted = markInterrupted(states, stage, this.iso());
      const settled = await this.store.settleCancel(buildId, token, interrupted, 'user');
      if (settled) {
        await this.store.appendLog(buildId, [
          { kind: 'system', stage, message: 'Build cancelled.' },
        ]);
      }
      return;
    }
    if (stage === 'pages') {
      const skipped = markSkipped(states, stage, PAGES_SKIP_WARNING, this.iso());
      await this.store.appendLog(buildId, [
        { kind: 'warning', stage, message: PAGES_SKIP_WARNING },
      ]);
      const next = nextStage(skipped);
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
      return;
    }
    const message = describeGenerationFailure(reason, STAGE_LABEL[stage]);
    const failed = markFailed(states, stage, message, this.iso());
    const wrote = await this.store.failRunning(buildId, token, {
      stageStates: failed,
      error: message,
      errorCode: 'stage_failed',
    });
    if (wrote) {
      await this.store.appendLog(buildId, [{ kind: 'error', stage, message }]);
    }
  }

  private async flush(buildId: string, buffer: LogDraft[]): Promise<void> {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, buffer.length);
    await this.store.appendLog(buildId, lines);
  }
}
