import type { BuildRow } from './buildTypes.js';

/**
 * One compile charge per durable build. The columns live on `warroom_builds`
 * (migration 267). A crash leaves the charge in place; a caught failure refunds it.
 */
export interface CompileChargeStore {
  get(buildId: string): Promise<BuildRow | null>;
  claimCompile(
    buildId: string,
    now: Date,
  ): Promise<{ credit_ledger_id: string | null; credit_invoice_id: string | null } | null>;
  saveCompileCredit(buildId: string, ledgerId: string, invoiceId: string | null): Promise<void>;
  failCompile(buildId: string): Promise<void>;
}

export type BeginCompile =
  | { outcome: 'not_found' }
  | { outcome: 'not_done' }
  | { outcome: 'completed'; scenarioId: string | null }
  | { outcome: 'in_progress' }
  | { outcome: 'no_credit' }
  | { outcome: 'claimed'; ledgerId: string | null; invoiceId: string | null };

export async function beginCompileCharge(opts: {
  store: CompileChargeStore;
  buildId: string;
  userId: string;
  isAdmin: boolean;
  now: Date;
  consume: () => Promise<{ ok: true; ledgerId: string; invoiceId: string | null } | { ok: false }>;
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
  if (claimed.credit_ledger_id) {
    return {
      outcome: 'claimed',
      ledgerId: claimed.credit_ledger_id,
      invoiceId: claimed.credit_invoice_id,
    };
  }
  if (opts.isAdmin) return { outcome: 'claimed', ledgerId: null, invoiceId: null };

  const consumed = await opts.consume();
  if (!consumed.ok) {
    await opts.store.failCompile(opts.buildId);
    return { outcome: 'no_credit' };
  }
  await opts.store.saveCompileCredit(opts.buildId, consumed.ledgerId, consumed.invoiceId);
  return {
    outcome: 'claimed',
    ledgerId: consumed.ledgerId,
    invoiceId: consumed.invoiceId,
  };
}

/** A caught compile failure returns the credit. A crash does not call this. */
export async function failCompileCharge(opts: {
  store: Pick<CompileChargeStore, 'failCompile'>;
  buildId: string;
  ledgerId: string | null;
  invoiceId: string | null;
  refund: (invoiceId: string | null) => Promise<void>;
}): Promise<void> {
  if (opts.ledgerId) await opts.refund(opts.invoiceId);
  await opts.store.failCompile(opts.buildId);
}
