import type { BuildRow } from './buildTypes.js';

/**
 * One compile charge per durable build. The columns live on `warroom_builds`
 * (migration 267). A crash leaves the charge in place. A caught failure refunds
 * it only while this process still holds the heartbeat it wrote.
 */
export interface CompileChargeStore {
  get(buildId: string): Promise<BuildRow | null>;
  claimCompile(
    buildId: string,
    now: Date,
  ): Promise<{
    credit_ledger_id: string | null;
    credit_invoice_id: string | null;
    compile_heartbeat_at: string;
  } | null>;
  saveCompileCredit(
    buildId: string,
    ledgerId: string,
    invoiceId: string | null,
    heartbeatAt: string,
  ): Promise<boolean>;
  failCompile(buildId: string, heartbeatAt: string): Promise<boolean>;
}

export type BeginCompile =
  | { outcome: 'not_found' }
  | { outcome: 'not_done' }
  | { outcome: 'completed'; scenarioId: string | null }
  | { outcome: 'in_progress' }
  | { outcome: 'no_credit' }
  | { outcome: 'unavailable' }
  | {
      outcome: 'claimed';
      ledgerId: string | null;
      invoiceId: string | null;
      heartbeatAt: string;
    };

async function releaseUnstoredCharge(opts: {
  store: CompileChargeStore;
  buildId: string;
  heartbeatAt: string;
  invoiceId: string | null;
  refund: (invoiceId: string | null) => Promise<void>;
}): Promise<void> {
  try {
    await opts.store.failCompile(opts.buildId, opts.heartbeatAt);
  } catch {
    // The row may already belong to a newer compile. The refund below is only
    // for the credit this call consumed and did not store.
  }
  await opts.refund(opts.invoiceId);
}

export async function beginCompileCharge(opts: {
  store: CompileChargeStore;
  buildId: string;
  userId: string;
  isAdmin: boolean;
  now: Date;
  consume: () => Promise<{ ok: true; ledgerId: string; invoiceId: string | null } | { ok: false }>;
  refund: (invoiceId: string | null) => Promise<void>;
}): Promise<BeginCompile> {
  const row = await opts.store.get(opts.buildId);
  if (!row) return { outcome: 'not_found' };
  const owns = opts.isAdmin || row.created_by === opts.userId;
  if (!owns || row.status !== 'succeeded') return { outcome: 'not_done' };

  const claimed = await opts.store.claimCompile(opts.buildId, opts.now);
  if (!claimed) {
    const fresh = await opts.store.get(opts.buildId);
    if (fresh?.compile_status === 'succeeded') {
      return { outcome: 'completed', scenarioId: fresh.scenario_id };
    }
    return { outcome: 'in_progress' };
  }
  const heartbeatAt = claimed.compile_heartbeat_at;
  if (claimed.credit_ledger_id) {
    return {
      outcome: 'claimed',
      ledgerId: claimed.credit_ledger_id,
      invoiceId: claimed.credit_invoice_id,
      heartbeatAt,
    };
  }
  if (opts.isAdmin) return { outcome: 'claimed', ledgerId: null, invoiceId: null, heartbeatAt };

  const consumed = await opts.consume();
  if (!consumed.ok) {
    await opts.store.failCompile(opts.buildId, heartbeatAt);
    return { outcome: 'no_credit' };
  }
  let saved = false;
  try {
    saved = await opts.store.saveCompileCredit(
      opts.buildId,
      consumed.ledgerId,
      consumed.invoiceId,
      heartbeatAt,
    );
  } catch (err) {
    await releaseUnstoredCharge({
      store: opts.store,
      buildId: opts.buildId,
      heartbeatAt,
      invoiceId: consumed.invoiceId,
      refund: opts.refund,
    });
    throw err;
  }
  if (!saved) {
    await releaseUnstoredCharge({
      store: opts.store,
      buildId: opts.buildId,
      heartbeatAt,
      invoiceId: consumed.invoiceId,
      refund: opts.refund,
    });
    return { outcome: 'unavailable' };
  }
  return {
    outcome: 'claimed',
    ledgerId: consumed.ledgerId,
    invoiceId: consumed.invoiceId,
    heartbeatAt,
  };
}

/**
 * Clear this process's compile, then refund. A takeover that already replaced
 * the heartbeat makes the clear miss, and then nothing is refunded.
 */
export async function failCompileCharge(opts: {
  store: Pick<CompileChargeStore, 'failCompile'>;
  buildId: string;
  heartbeatAt: string;
  ledgerId: string | null;
  invoiceId: string | null;
  refund: (invoiceId: string | null) => Promise<void>;
}): Promise<boolean> {
  const cleared = await opts.store.failCompile(opts.buildId, opts.heartbeatAt);
  if (cleared && opts.ledgerId) await opts.refund(opts.invoiceId);
  return cleared;
}
