import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { initialStageStates } from './buildCore.js';
import type {
  BuildRequest,
  BuildRow,
  BuildStage,
  BuildStatus,
  CancelReason,
  LogKind,
  LogLine,
  StageOutputs,
  StageStates,
} from './buildTypes.js';

export type StartOutcome = 'created' | 'replayed' | 'attached' | 'conflict' | 'limit';
export type RenewResult = 'ok' | 'cancel_requested' | 'lost';

export interface StartArgs {
  draftId: string;
  userId: string;
  pool: string;
  request: BuildRequest;
  requestHash: string;
  idempotencyKey: string;
  replaceActive: boolean;
  /** Queued + running for this user. Enforced before insert. */
  maxActivePerUser: number;
}

export interface StartResult {
  buildId: string | null;
  outcome: StartOutcome;
}

export interface CompleteStageArgs {
  buildId: string;
  leaseToken: string;
  stage: BuildStage;
  attempt: number;
  output: unknown;
  stageStates: StageStates;
  nextStage: BuildStage | null;
  finalStatus: 'succeeded' | null;
}

export interface LogDraft {
  stage: string | null;
  kind: LogKind;
  message: string;
}

export const LOG_CAP = 500;
export const LOG_TRUNCATED = 'Log truncated — the build continues.';

/** Keep at most LOG_CAP lines. The last slot says the log was truncated. */
export function capLogBatch(existing: number, lines: LogDraft[]): LogDraft[] {
  if (existing >= LOG_CAP || lines.length === 0) return [];
  const room = LOG_CAP - existing;
  if (lines.length <= room) return lines;
  const head = lines.slice(0, Math.max(0, room - 1));
  head.push({ stage: null, kind: 'system', message: LOG_TRUNCATED });
  return head;
}

export interface BuildStore {
  start(args: StartArgs): Promise<StartResult>;
  claim(pool: string, instanceId: string, leaseSeconds: number): Promise<BuildRow | null>;
  /**
   * Claim one queued build by id. Does not look at any other row, so a process
   * that is not the pool worker can run the build it just accepted without
   * taking the oldest build in the pool.
   */
  claimQueued(
    buildId: string,
    pool: string,
    instanceId: string,
    leaseSeconds: number,
  ): Promise<BuildRow | null>;
  /** Throws the driver error when `warroom_builds` is missing. Empty is success. */
  probeSchema(): Promise<void>;
  renewLease(buildId: string, leaseToken: string, leaseSeconds: number): Promise<RenewResult>;
  completeStage(args: CompleteStageArgs): Promise<boolean>;
  /** Guarded by lease token and status = running. */
  updateRunning(
    buildId: string,
    leaseToken: string,
    patch: Partial<Pick<BuildRow, 'stage_states' | 'current_stage'>>,
  ): Promise<boolean>;
  releaseForRestart(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
  ): Promise<boolean>;
  failRunning(
    buildId: string,
    leaseToken: string,
    patch: { stageStates: StageStates; error: string; errorCode: string },
  ): Promise<boolean>;
  pauseUnwatched(buildId: string, leaseToken: string): Promise<boolean>;
  settleCancel(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
    reason: CancelReason,
  ): Promise<boolean>;
  requestCancel(buildId: string, reason: CancelReason): Promise<BuildRow | null>;
  cancelQueued(buildId: string, reason: CancelReason): Promise<BuildRow | null>;
  resume(
    buildId: string,
    stageStates: StageStates,
  ): Promise<'ok' | 'active_conflict' | 'missing' | 'not_resumable'>;
  /** Newest build for a draft, or null when the draft has none. */
  latestForDraft(draftId: string): Promise<BuildRow | null>;
  get(buildId: string): Promise<BuildRow | null>;
  getOutputs(buildId: string): Promise<StageOutputs>;
  /**
   * When `leaseToken` is set, write only while that lease is still held.
   * A stale owner then cannot append lines after the lease moved on.
   *
   * The Supabase path cannot do the lease check, the insert, and the
   * `log_count` update as one statement: PostgREST has no nested write, and
   * migration 267 is not extended with a helper function. The check and the
   * count update are both filtered by the token. A stale owner can still win
   * the gap between them; that only affects the trainer-visible log.
   */
  appendLog(buildId: string, lines: LogDraft[], leaseToken?: string): Promise<LogLine[]>;
  listLog(buildId: string, after: number, limit: number): Promise<LogLine[]>;
  touchSeen(buildId: string): Promise<void>;
  countActive(userId: string): Promise<number>;
  sweep(retentionDays: number): Promise<number>;
  /**
   * Claim a succeeded build for compile. Null when another compile holds a
   * fresh lease (running and heartbeat within 90s) or the build is not succeeded.
   * A failed compile, or a running one whose heartbeat is older than 90s, is claimable.
   */
  claimCompile(
    buildId: string,
    now: Date,
  ): Promise<{
    credit_ledger_id: string | null;
    credit_invoice_id: string | null;
    compile_heartbeat_at: string;
  } | null>;
  /** False when this process no longer holds the heartbeat it claimed. */
  saveCompileCredit(
    buildId: string,
    ledgerId: string,
    invoiceId: string | null,
    heartbeatAt: string,
  ): Promise<boolean>;
  /**
   * Advance the heartbeat only if it is still the value this process wrote.
   * Returns the stored timestamp when the row matched, otherwise null.
   */
  touchCompileHeartbeat(buildId: string, heartbeatAt: string, now: Date): Promise<string | null>;
  /** False when a newer compile already owns the build. Does not overwrite that owner. */
  succeedCompile(buildId: string, scenarioId: string, heartbeatAt: string): Promise<boolean>;
  /** False when a newer compile already owns the build. Clears the charge only for this heartbeat. */
  failCompile(buildId: string, heartbeatAt: string): Promise<boolean>;
}

/** A compile can start, or take over a run whose heartbeat is older than 90s. */
export function compileClaimable(
  row: { compile_status: BuildRow['compile_status']; compile_heartbeat_at: string | null },
  now: Date,
): boolean {
  if (row.compile_status == null || row.compile_status === 'failed') return true;
  if (row.compile_status !== 'running' || row.compile_heartbeat_at == null) return false;
  return Date.parse(row.compile_heartbeat_at) < now.getTime() - 90_000;
}

const ACTIVE: BuildStatus[] = ['queued', 'running'];
const TERMINAL: BuildStatus[] = ['succeeded', 'failed', 'cancelled'];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isActive(row: BuildRow): boolean {
  return ACTIVE.includes(row.status) && row.cancel_requested_at == null;
}

/**
 * In-memory stand-in for the migration 267 functions. Tests and local dev use it.
 * Mutators run under one lock so concurrent starts see the same rules as the
 * advisory lock in start_warroom_build.
 */
export class MemoryBuildStore implements BuildStore {
  private readonly rows = new Map<string, BuildRow>();
  private readonly outputs = new Map<string, StageOutputs>();
  private readonly logs = new Map<string, LogLine[]>();
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private iso(): string {
    return this.now().toISOString();
  }

  private lock<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private copy(row: BuildRow): BuildRow {
    return clone(row);
  }

  start(args: StartArgs): Promise<StartResult> {
    return this.lock(() => {
      // Same idempotency key returns the original build as `replayed`, even when
      // the request body differs. The key is the client's identity for one press of Build.
      const byKey = [...this.rows.values()].find(
        (row) => row.draft_id === args.draftId && row.idempotency_key === args.idempotencyKey,
      );
      if (byKey) return { buildId: byKey.id, outcome: 'replayed' as const };

      const active = [...this.rows.values()].find(
        (row) => row.draft_id === args.draftId && isActive(row),
      );
      if (active) {
        if (active.request_hash === args.requestHash) {
          return { buildId: active.id, outcome: 'attached' as const };
        }
        if (!args.replaceActive) return { buildId: active.id, outcome: 'conflict' as const };
      }

      const mine = [...this.rows.values()].filter(
        (row) => row.created_by === args.userId && ACTIVE.includes(row.status),
      ).length;
      // Replacing a queued build frees its slot. A running build stays running until its owner stops.
      const freesSlot = Boolean(
        active &&
        args.replaceActive &&
        active.created_by === args.userId &&
        active.status === 'queued',
      );
      if (mine - (freesSlot ? 1 : 0) >= args.maxActivePerUser) {
        return { buildId: active?.id ?? null, outcome: 'limit' as const };
      }

      const now = this.iso();
      if (active && args.replaceActive) {
        active.cancel_requested_at = now;
        active.cancel_reason = 'replaced';
        if (active.status === 'queued') {
          active.status = 'cancelled';
          active.finished_at = now;
        }
        active.updated_at = now;
      }

      const row: BuildRow = {
        id: randomUUID(),
        draft_id: args.draftId,
        created_by: args.userId,
        pool: args.pool,
        status: 'queued',
        current_stage: 'characters',
        stage_states: initialStageStates(),
        request: clone(args.request),
        request_hash: args.requestHash,
        idempotency_key: args.idempotencyKey,
        error: null,
        error_code: null,
        cancel_requested_at: null,
        cancel_reason: null,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        interruptions: 0,
        last_seen_at: now,
        log_count: 0,
        compile_status: null,
        compile_heartbeat_at: null,
        credit_ledger_id: null,
        credit_invoice_id: null,
        scenario_id: null,
        started_at: null,
        finished_at: null,
        created_at: now,
        updated_at: now,
      };
      this.rows.set(row.id, row);
      this.outputs.set(row.id, {});
      this.logs.set(row.id, []);
      return { buildId: row.id, outcome: 'created' as const };
    });
  }

  claim(pool: string, instanceId: string, leaseSeconds: number): Promise<BuildRow | null> {
    return this.lock(() => {
      const nowMs = this.now().getTime();
      const now = new Date(nowMs).toISOString();
      for (const row of this.rows.values()) {
        if (row.pool !== pool || row.cancel_requested_at == null) continue;
        const expired =
          row.status === 'running' &&
          row.lease_expires_at != null &&
          Date.parse(row.lease_expires_at) < nowMs;
        if (row.status === 'queued' || expired) {
          row.status = 'cancelled';
          row.finished_at = now;
          row.lease_owner = null;
          row.lease_token = null;
          row.lease_expires_at = null;
          row.updated_at = now;
        }
      }
      const candidates = [...this.rows.values()]
        .filter((row) => {
          if (row.pool !== pool || row.cancel_requested_at != null) return false;
          if (row.status === 'queued') return true;
          return (
            row.status === 'running' &&
            row.lease_expires_at != null &&
            Date.parse(row.lease_expires_at) < nowMs
          );
        })
        .sort(
          (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
        );
      const row = candidates[0];
      if (!row) return null;
      if (row.status === 'running') row.interruptions += 1;
      row.status = 'running';
      row.lease_owner = instanceId;
      row.lease_token = randomUUID();
      row.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString();
      row.started_at = row.started_at ?? now;
      row.updated_at = now;
      return this.copy(row);
    });
  }

  claimQueued(
    buildId: string,
    pool: string,
    instanceId: string,
    leaseSeconds: number,
  ): Promise<BuildRow | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.pool !== pool || row.status !== 'queued' || row.cancel_requested_at != null) {
        return null;
      }
      const nowMs = this.now().getTime();
      const now = new Date(nowMs).toISOString();
      row.status = 'running';
      row.lease_owner = instanceId;
      row.lease_token = randomUUID();
      row.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString();
      row.started_at = row.started_at ?? now;
      row.updated_at = now;
      return this.copy(row);
    });
  }

  probeSchema(): Promise<void> {
    return Promise.resolve();
  }

  renewLease(buildId: string, leaseToken: string, leaseSeconds: number): Promise<RenewResult> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return 'lost';
      const nowMs = this.now().getTime();
      row.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString();
      row.updated_at = new Date(nowMs).toISOString();
      return row.cancel_requested_at != null ? 'cancel_requested' : 'ok';
    });
  }

  completeStage(args: CompleteStageArgs): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(args.buildId);
      if (!row || row.lease_token !== args.leaseToken || row.status !== 'running') return false;
      const outputs = this.outputs.get(args.buildId) ?? {};
      (outputs as Record<string, unknown>)[args.stage] = clone(args.output);
      this.outputs.set(args.buildId, outputs);
      const now = this.iso();
      row.stage_states = clone(args.stageStates);
      row.current_stage = args.nextStage;
      if (args.finalStatus) {
        row.status = args.finalStatus;
        row.finished_at = now;
        row.lease_owner = null;
        row.lease_token = null;
        row.lease_expires_at = null;
      }
      row.updated_at = now;
      return true;
    });
  }

  updateRunning(
    buildId: string,
    leaseToken: string,
    patch: Partial<Pick<BuildRow, 'stage_states' | 'current_stage'>>,
  ): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return false;
      if (patch.stage_states) row.stage_states = clone(patch.stage_states);
      if (patch.current_stage !== undefined) row.current_stage = patch.current_stage;
      row.updated_at = this.iso();
      return true;
    });
  }

  releaseForRestart(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
  ): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return false;
      row.status = 'queued';
      row.interruptions += 1;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.stage_states = clone(stageStates);
      row.updated_at = this.iso();
      return true;
    });
  }

  failRunning(
    buildId: string,
    leaseToken: string,
    patch: { stageStates: StageStates; error: string; errorCode: string },
  ): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return false;
      const now = this.iso();
      row.status = 'failed';
      row.error = patch.error;
      row.error_code = patch.errorCode;
      row.stage_states = clone(patch.stageStates);
      row.finished_at = now;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.updated_at = now;
      return true;
    });
  }

  pauseUnwatched(buildId: string, leaseToken: string): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return false;
      const now = this.iso();
      row.status = 'paused';
      row.cancel_reason = 'unwatched';
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.updated_at = now;
      return true;
    });
  }

  settleCancel(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
    reason: CancelReason,
  ): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.lease_token !== leaseToken || row.status !== 'running') return false;
      const now = this.iso();
      row.status = 'cancelled';
      row.cancel_reason = reason;
      row.cancel_requested_at = row.cancel_requested_at ?? now;
      row.stage_states = clone(stageStates);
      row.finished_at = now;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.updated_at = now;
      return true;
    });
  }

  requestCancel(buildId: string, reason: CancelReason): Promise<BuildRow | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row) return null;
      if (row.status !== 'running' && row.status !== 'queued') return this.copy(row);
      const now = this.iso();
      row.cancel_requested_at = now;
      row.cancel_reason = reason;
      row.updated_at = now;
      return this.copy(row);
    });
  }

  cancelQueued(buildId: string, reason: CancelReason): Promise<BuildRow | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row) return null;
      if (row.status !== 'queued') return this.copy(row);
      const now = this.iso();
      row.status = 'cancelled';
      row.cancel_reason = reason;
      row.cancel_requested_at = now;
      row.finished_at = now;
      row.updated_at = now;
      return this.copy(row);
    });
  }

  resume(
    buildId: string,
    stageStates: StageStates,
  ): Promise<'ok' | 'active_conflict' | 'missing' | 'not_resumable'> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row) return 'missing';
      const resumable =
        (row.status === 'paused' || row.status === 'failed' || row.status === 'cancelled') &&
        row.cancel_reason !== 'replaced';
      if (!resumable) return 'not_resumable';
      const other = [...this.rows.values()].find(
        (candidate) =>
          candidate.id !== row.id && candidate.draft_id === row.draft_id && isActive(candidate),
      );
      if (other) return 'active_conflict';
      const now = this.iso();
      row.stage_states = clone(stageStates);
      row.status = 'queued';
      row.error = null;
      row.error_code = null;
      row.cancel_requested_at = null;
      row.cancel_reason = null;
      row.interruptions = 0;
      row.last_seen_at = now;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.finished_at = null;
      row.updated_at = now;
      return 'ok';
    });
  }

  get(buildId: string): Promise<BuildRow | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      return row ? this.copy(row) : null;
    });
  }

  latestForDraft(draftId: string): Promise<BuildRow | null> {
    return this.lock(() => {
      const rows = [...this.rows.values()]
        .filter((row) => row.draft_id === draftId)
        .sort(
          (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id),
        );
      return rows[0] ? this.copy(rows[0]) : null;
    });
  }

  getOutputs(buildId: string): Promise<StageOutputs> {
    return this.lock(() => clone(this.outputs.get(buildId) ?? {}));
  }

  appendLog(buildId: string, lines: LogDraft[], leaseToken?: string): Promise<LogLine[]> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      const bucket = this.logs.get(buildId);
      if (!row || !bucket) return [];
      if (
        leaseToken !== undefined &&
        (row.lease_token !== leaseToken || row.status !== 'running')
      ) {
        return [];
      }
      const accepted = capLogBatch(bucket.length, lines);
      const written: LogLine[] = [];
      for (const line of accepted) {
        this.seq += 1;
        const stored: LogLine = {
          seq: this.seq,
          stage: line.stage,
          kind: line.kind,
          message: line.message,
          at: this.iso(),
        };
        bucket.push(stored);
        written.push(stored);
      }
      row.log_count = bucket.length;
      row.updated_at = this.iso();
      return clone(written);
    });
  }

  listLog(buildId: string, after: number, limit: number): Promise<LogLine[]> {
    return this.lock(() => {
      const bucket = this.logs.get(buildId) ?? [];
      return clone(bucket.filter((line) => line.seq > after).slice(0, limit));
    });
  }

  touchSeen(buildId: string): Promise<void> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row) return;
      const now = this.iso();
      row.last_seen_at = now;
      row.updated_at = now;
    });
  }

  countActive(userId: string): Promise<number> {
    return this.lock(
      () =>
        [...this.rows.values()].filter(
          (row) => row.created_by === userId && ACTIVE.includes(row.status),
        ).length,
    );
  }

  sweep(retentionDays: number): Promise<number> {
    return this.lock(() => {
      const cutoff = this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const row of [...this.rows.values()]) {
        if (!TERMINAL.includes(row.status) || row.finished_at == null) continue;
        if (Date.parse(row.finished_at) >= cutoff) continue;
        this.rows.delete(row.id);
        this.outputs.delete(row.id);
        this.logs.delete(row.id);
        removed += 1;
      }
      return removed;
    });
  }

  claimCompile(
    buildId: string,
    now: Date,
  ): Promise<{
    credit_ledger_id: string | null;
    credit_invoice_id: string | null;
    compile_heartbeat_at: string;
  } | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.status !== 'succeeded' || !compileClaimable(row, now)) return null;
      const iso = now.toISOString();
      row.compile_status = 'running';
      row.compile_heartbeat_at = iso;
      row.updated_at = iso;
      return {
        credit_ledger_id: row.credit_ledger_id,
        credit_invoice_id: row.credit_invoice_id,
        compile_heartbeat_at: iso,
      };
    });
  }

  saveCompileCredit(
    buildId: string,
    ledgerId: string,
    invoiceId: string | null,
    heartbeatAt: string,
  ): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt) {
        return false;
      }
      row.credit_ledger_id = ledgerId;
      row.credit_invoice_id = invoiceId;
      row.updated_at = this.iso();
      return true;
    });
  }

  touchCompileHeartbeat(buildId: string, heartbeatAt: string, now: Date): Promise<string | null> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt) {
        return null;
      }
      const iso = now.toISOString();
      row.compile_heartbeat_at = iso;
      row.updated_at = iso;
      return iso;
    });
  }

  succeedCompile(buildId: string, scenarioId: string, heartbeatAt: string): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt) {
        return false;
      }
      row.compile_status = 'succeeded';
      row.scenario_id = scenarioId;
      row.updated_at = this.iso();
      return true;
    });
  }

  failCompile(buildId: string, heartbeatAt: string): Promise<boolean> {
    return this.lock(() => {
      const row = this.rows.get(buildId);
      if (!row || row.compile_status !== 'running' || row.compile_heartbeat_at !== heartbeatAt) {
        return false;
      }
      row.compile_status = 'failed';
      row.credit_ledger_id = null;
      row.credit_invoice_id = null;
      row.updated_at = this.iso();
      return true;
    });
  }
}

function asRows<T>(data: T[] | T | null): T[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/**
 * Service-role client. RPCs are the migration 267 functions; other writes are
 * the single-row updates the worker performs while it holds the lease.
 */
export class SupabaseBuildStore implements BuildStore {
  constructor(private readonly now: () => Date = () => new Date()) {}

  private iso(): string {
    return this.now().toISOString();
  }

  async start(args: StartArgs): Promise<StartResult> {
    const { data: keyed, error: keyError } = await supabaseAdmin
      .from('warroom_builds')
      .select('id')
      .eq('draft_id', args.draftId)
      .eq('idempotency_key', args.idempotencyKey)
      .maybeSingle();
    if (keyError) throw keyError;
    if (keyed?.id) return { buildId: String(keyed.id), outcome: 'replayed' };

    const { data: active, error: activeError } = await supabaseAdmin
      .from('warroom_builds')
      .select('id, request_hash, created_by, status')
      .eq('draft_id', args.draftId)
      .in('status', ACTIVE)
      .is('cancel_requested_at', null)
      .maybeSingle();
    if (activeError) throw activeError;
    if (active) {
      if (active.request_hash === args.requestHash) {
        return { buildId: String(active.id), outcome: 'attached' };
      }
      if (!args.replaceActive) return { buildId: String(active.id), outcome: 'conflict' };
    }

    const activeCount = await this.countActive(args.userId);
    const freesSlot = Boolean(
      active && active.created_by === args.userId && active.status === 'queued',
    );
    if (activeCount - (freesSlot ? 1 : 0) >= args.maxActivePerUser) {
      return { buildId: active ? String(active.id) : null, outcome: 'limit' };
    }

    const { data, error } = await supabaseAdmin.rpc('start_warroom_build', {
      p_draft_id: args.draftId,
      p_user_id: args.userId,
      p_pool: args.pool,
      p_request: args.request,
      p_request_hash: args.requestHash,
      p_idempotency_key: args.idempotencyKey,
      p_replace_active: args.replaceActive,
    });
    if (error) throw error;
    const row = asRows(data as { out_build_id: string; out_outcome: StartOutcome }[] | null)[0];
    if (!row) throw new Error('start_warroom_build returned no row');
    return { buildId: row.out_build_id, outcome: row.out_outcome };
  }

  async claim(pool: string, instanceId: string, leaseSeconds: number): Promise<BuildRow | null> {
    const { data, error } = await supabaseAdmin.rpc('claim_warroom_build', {
      p_pool: pool,
      p_instance: instanceId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw error;
    const row = asRows(data as BuildRow[] | null)[0];
    return row ?? null;
  }

  async claimQueued(
    buildId: string,
    pool: string,
    instanceId: string,
    leaseSeconds: number,
  ): Promise<BuildRow | null> {
    const now = this.iso();
    const { data: queued, error: readError } = await supabaseAdmin
      .from('warroom_builds')
      .select('id, pool, status, cancel_requested_at, started_at')
      .eq('id', buildId)
      .eq('pool', pool)
      .eq('status', 'queued')
      .is('cancel_requested_at', null)
      .maybeSingle();
    if (readError) throw readError;
    if (!queued) return null;
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'running',
        lease_owner: instanceId,
        lease_token: randomUUID(),
        lease_expires_at: new Date(this.now().getTime() + leaseSeconds * 1000).toISOString(),
        started_at: queued.started_at ?? now,
      })
      .eq('id', buildId)
      .eq('pool', pool)
      .eq('status', 'queued')
      .is('cancel_requested_at', null)
      // select('*') keeps every filtered column in RETURNING. PostgREST 12/13
      // otherwise answers 42703 for an omitted filter column.
      .select('*');
    if (error) throw error;
    return (data?.[0] as BuildRow | undefined) ?? null;
  }

  async probeSchema(): Promise<void> {
    const { error } = await supabaseAdmin.from('warroom_builds').select('id').limit(0);
    if (error) throw error;
  }

  async renewLease(
    buildId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<RenewResult> {
    const { data, error } = await supabaseAdmin.rpc('renew_warroom_build_lease', {
      p_build_id: buildId,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw error;
    const value = Array.isArray(data) ? data[0] : data;
    if (value === 'ok' || value === 'cancel_requested' || value === 'lost') return value;
    logger.warn({ buildId, value }, 'renew_warroom_build_lease returned an unknown result');
    return 'lost';
  }

  async completeStage(args: CompleteStageArgs): Promise<boolean> {
    const { data, error } = await supabaseAdmin.rpc('complete_warroom_build_stage', {
      p_build_id: args.buildId,
      p_lease_token: args.leaseToken,
      p_stage: args.stage,
      p_attempt: args.attempt,
      p_output: args.output,
      p_stage_states: args.stageStates,
      p_next_stage: args.nextStage,
      p_final_status: args.finalStatus,
    });
    if (error) throw error;
    return data === true;
  }

  async updateRunning(
    buildId: string,
    leaseToken: string,
    patch: Partial<Pick<BuildRow, 'stage_states' | 'current_stage'>>,
  ): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update(patch)
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      // PostgREST 12/13 rejects an UPDATE whose filters mention a column the
      // RETURNING list omits (42703). Keep every filtered column in the select.
      .select('id, lease_token, status');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async releaseForRestart(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
  ): Promise<boolean> {
    const { data: current, error: readError } = await supabaseAdmin
      .from('warroom_builds')
      .select('interruptions')
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .maybeSingle();
    if (readError) throw readError;
    if (!current) return false;
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'queued',
        interruptions: Number(current.interruptions) + 1,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        stage_states: stageStates,
      })
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .select('id, lease_token, status');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async failRunning(
    buildId: string,
    leaseToken: string,
    patch: { stageStates: StageStates; error: string; errorCode: string },
  ): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'failed',
        error: patch.error,
        error_code: patch.errorCode,
        stage_states: patch.stageStates,
        finished_at: this.iso(),
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .select('id, lease_token, status');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async pauseUnwatched(buildId: string, leaseToken: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'paused',
        cancel_reason: 'unwatched',
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .select('id, lease_token, status');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async settleCancel(
    buildId: string,
    leaseToken: string,
    stageStates: StageStates,
    reason: CancelReason,
  ): Promise<boolean> {
    const { data: current, error: readError } = await supabaseAdmin
      .from('warroom_builds')
      .select('cancel_requested_at')
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .maybeSingle();
    if (readError) throw readError;
    if (!current) return false;
    const now = this.iso();
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'cancelled',
        cancel_reason: reason,
        cancel_requested_at: current.cancel_requested_at ?? now,
        stage_states: stageStates,
        finished_at: now,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .eq('id', buildId)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .select('id, lease_token, status');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async requestCancel(buildId: string, reason: CancelReason): Promise<BuildRow | null> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({ cancel_requested_at: this.iso(), cancel_reason: reason })
      .eq('id', buildId)
      .in('status', ['queued', 'running'])
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return (data as BuildRow | null) ?? this.get(buildId);
  }

  async cancelQueued(buildId: string, reason: CancelReason): Promise<BuildRow | null> {
    const now = this.iso();
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        status: 'cancelled',
        cancel_reason: reason,
        cancel_requested_at: now,
        finished_at: now,
      })
      .eq('id', buildId)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return (data as BuildRow | null) ?? this.get(buildId);
  }

  async resume(
    buildId: string,
    stageStates: StageStates,
  ): Promise<'ok' | 'active_conflict' | 'missing' | 'not_resumable'> {
    const now = this.iso();
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        stage_states: stageStates,
        status: 'queued',
        error: null,
        error_code: null,
        cancel_requested_at: null,
        cancel_reason: null,
        interruptions: 0,
        last_seen_at: now,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        finished_at: null,
      })
      .eq('id', buildId)
      .in('status', ['paused', 'failed', 'cancelled'])
      // Keep NULL cancel_reason (a plain neq drops those rows). The select must
      // name cancel_reason: PostgREST 12.2.3 and 13.0.8 otherwise answer 42703.
      .or('cancel_reason.is.null,cancel_reason.neq.replaced')
      .select('id, status, cancel_reason');
    if (error?.code === '23505') return 'active_conflict';
    if (error) throw error;
    if ((data?.length ?? 0) > 0) return 'ok';
    const { data: existing, error: readError } = await supabaseAdmin
      .from('warroom_builds')
      .select('id')
      .eq('id', buildId)
      .maybeSingle();
    if (readError) throw readError;
    return existing ? 'not_resumable' : 'missing';
  }

  async latestForDraft(draftId: string): Promise<BuildRow | null> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .select('*')
      .eq('draft_id', draftId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as BuildRow | null) ?? null;
  }

  async get(buildId: string): Promise<BuildRow | null> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .select('*')
      .eq('id', buildId)
      .maybeSingle();
    if (error) throw error;
    return (data as BuildRow | null) ?? null;
  }

  async getOutputs(buildId: string): Promise<StageOutputs> {
    const { data, error } = await supabaseAdmin
      .from('warroom_build_outputs')
      .select('stage, output')
      .eq('build_id', buildId);
    if (error) throw error;
    const outputs: StageOutputs = {};
    for (const row of data ?? []) {
      const stage = row.stage as BuildStage;
      (outputs as Record<string, unknown>)[stage] = row.output;
    }
    return outputs;
  }

  async appendLog(buildId: string, lines: LogDraft[], leaseToken?: string): Promise<LogLine[]> {
    if (lines.length === 0) return [];
    if (leaseToken !== undefined) {
      const { data: held, error: heldError } = await supabaseAdmin
        .from('warroom_builds')
        .select('id')
        .eq('id', buildId)
        .eq('lease_token', leaseToken)
        .eq('status', 'running')
        .maybeSingle();
      if (heldError) throw heldError;
      if (!held) return [];
    }
    const { count, error: countError } = await supabaseAdmin
      .from('warroom_build_log')
      .select('seq', { count: 'exact', head: true })
      .eq('build_id', buildId);
    if (countError) throw countError;
    const accepted = capLogBatch(count ?? 0, lines);
    if (accepted.length === 0) return [];
    const { data, error } = await supabaseAdmin
      .from('warroom_build_log')
      .insert(accepted.map((line) => ({ build_id: buildId, ...line })))
      .select('seq, stage, kind, message, created_at');
    if (error) throw error;
    const logCount = supabaseAdmin
      .from('warroom_builds')
      .update({ log_count: (count ?? 0) + accepted.length })
      .eq('id', buildId);
    const fenced =
      leaseToken === undefined
        ? logCount
        : logCount.eq('lease_token', leaseToken).eq('status', 'running');
    const { error: countWriteError } = await fenced;
    if (countWriteError) throw countWriteError;
    return (data ?? []).map((row) => ({
      seq: Number(row.seq),
      stage: row.stage,
      kind: row.kind as LogKind,
      message: row.message,
      at: row.created_at,
    }));
  }

  async listLog(buildId: string, after: number, limit: number): Promise<LogLine[]> {
    const { data, error } = await supabaseAdmin
      .from('warroom_build_log')
      .select('seq, stage, kind, message, created_at')
      .eq('build_id', buildId)
      .gt('seq', after)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => ({
      seq: Number(row.seq),
      stage: row.stage,
      kind: row.kind as LogKind,
      message: row.message,
      at: row.created_at,
    }));
  }

  async touchSeen(buildId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('warroom_builds')
      .update({ last_seen_at: this.iso() })
      .eq('id', buildId);
    if (error) throw error;
  }

  async countActive(userId: string): Promise<number> {
    const { count, error } = await supabaseAdmin
      .from('warroom_builds')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId)
      .in('status', ACTIVE);
    if (error) throw error;
    return count ?? 0;
  }

  async sweep(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .delete()
      .in('status', TERMINAL)
      .lt('finished_at', cutoff)
      .select('id, status, finished_at');
    if (error) throw error;
    return data?.length ?? 0;
  }

  async claimCompile(
    buildId: string,
    now: Date,
  ): Promise<{
    credit_ledger_id: string | null;
    credit_invoice_id: string | null;
    compile_heartbeat_at: string;
  } | null> {
    const writtenHeartbeat = now.toISOString();
    const cutoff = new Date(now.getTime() - 90_000).toISOString();
    // The affected-row count is the claim. Two calls in the same millisecond
    // write the same heartbeat, so a re-read that matches that instant lets
    // both of them through. PostgREST also returns an empty body for this
    // `or` filter on 12 and 13. `count: 'exact'` is 1 for the winner and 0
    // for a racer on 12, 13 and 14, with no `.select()`.
    const { count, error } = await supabaseAdmin
      .from('warroom_builds')
      .update(
        {
          compile_status: 'running',
          compile_heartbeat_at: writtenHeartbeat,
        },
        { count: 'exact' },
      )
      .eq('id', buildId)
      .eq('status', 'succeeded')
      .or(
        `compile_status.is.null,compile_status.eq.failed,and(compile_status.eq.running,compile_heartbeat_at.lt.${cutoff})`,
      );
    if (error) throw error;
    if (count !== 1) return null;
    const { data, error: readError } = await supabaseAdmin
      .from('warroom_builds')
      .select('compile_heartbeat_at, credit_ledger_id, credit_invoice_id')
      .eq('id', buildId)
      .maybeSingle();
    if (readError) throw readError;
    if (!data?.compile_heartbeat_at) {
      throw new Error('compile claim re-read missed the heartbeat');
    }
    return {
      credit_ledger_id: data.credit_ledger_id ?? null,
      credit_invoice_id: data.credit_invoice_id ?? null,
      compile_heartbeat_at: data.compile_heartbeat_at,
    };
  }

  async saveCompileCredit(
    buildId: string,
    ledgerId: string,
    invoiceId: string | null,
    heartbeatAt: string,
  ): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({ credit_ledger_id: ledgerId, credit_invoice_id: invoiceId })
      .eq('id', buildId)
      .eq('compile_status', 'running')
      .eq('compile_heartbeat_at', heartbeatAt)
      .select('id, compile_status, compile_heartbeat_at');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async touchCompileHeartbeat(
    buildId: string,
    heartbeatAt: string,
    now: Date,
  ): Promise<string | null> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({ compile_heartbeat_at: now.toISOString() })
      .eq('id', buildId)
      .eq('compile_status', 'running')
      .eq('compile_heartbeat_at', heartbeatAt)
      .select('id, compile_status, compile_heartbeat_at');
    if (error) throw error;
    return data?.[0]?.compile_heartbeat_at ?? null;
  }

  async succeedCompile(buildId: string, scenarioId: string, heartbeatAt: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({ compile_status: 'succeeded', scenario_id: scenarioId })
      .eq('id', buildId)
      .eq('compile_status', 'running')
      .eq('compile_heartbeat_at', heartbeatAt)
      .select('id, compile_status, compile_heartbeat_at');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }

  async failCompile(buildId: string, heartbeatAt: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin
      .from('warroom_builds')
      .update({
        compile_status: 'failed',
        credit_ledger_id: null,
        credit_invoice_id: null,
      })
      .eq('id', buildId)
      .eq('compile_status', 'running')
      .eq('compile_heartbeat_at', heartbeatAt)
      .select('id, compile_status, compile_heartbeat_at');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }
}
