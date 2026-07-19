import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

/**
 * Credit Service - the bridge between "client paid" and "trainer may use
 * expensive features".
 *
 * Credits live in the append-only credit_ledger table; a balance is the SUM
 * of deltas. Spending goes through the consume_credit() SQL function, which
 * takes a per-(trainer, credit_type) advisory lock so concurrent spends can
 * never double-spend the last credit.
 *
 * Only admins bypass credit checks (they retain full unlimited access and
 * never consume credits). Trainers get no bypass.
 */

export type CreditType = 'scenario' | 'session';

export interface CreditBalances {
  scenario: number;
  session: number;
}

export interface ConsumeResult {
  ok: boolean;
  ledgerId?: string;
  fundingInvoiceId?: string | null;
}

export const isAdmin = (user: { role?: string }): boolean => user.role === 'admin';

export async function getBalances(trainerId: string): Promise<CreditBalances> {
  const { data, error } = await supabaseAdmin
    .from('credit_ledger')
    .select('credit_type, delta')
    .eq('trainer_id', trainerId);

  if (error) {
    logger.error({ error, trainerId }, 'Failed to load credit balances');
    return { scenario: 0, session: 0 };
  }

  const balances: CreditBalances = { scenario: 0, session: 0 };
  for (const row of data ?? []) {
    const type = row.credit_type as CreditType;
    if (type === 'scenario' || type === 'session') {
      balances[type] += row.delta as number;
    }
  }
  return balances;
}

/** True when the trainer has at least one credit of the given type. */
export async function hasCredit(trainerId: string, type: CreditType): Promise<boolean> {
  const balances = await getBalances(trainerId);
  return balances[type] >= 1;
}

/**
 * Atomically consume one credit. Returns ok=false when the balance is
 * insufficient (race-safe: the SQL function holds an advisory lock).
 */
export async function consumeCredit(
  trainerId: string,
  type: CreditType,
  reason: 'scenario_generated' | 'session_created',
  refs: { scenarioId?: string; sessionId?: string } = {},
): Promise<ConsumeResult> {
  const { data, error } = await supabaseAdmin.rpc('consume_credit', {
    p_trainer_id: trainerId,
    p_credit_type: type,
    p_reason: reason,
    p_scenario_id: refs.scenarioId ?? null,
    p_session_id: refs.sessionId ?? null,
  });

  if (error) {
    logger.error({ error, trainerId, type }, 'consume_credit RPC failed');
    return { ok: false };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { ok: false }; // insufficient balance
  }

  logger.info(
    { trainerId, type, ledgerId: row.ledger_id, fundingInvoiceId: row.funding_invoice_id },
    'Credit consumed',
  );
  return {
    ok: true,
    ledgerId: row.ledger_id as string,
    fundingInvoiceId: (row.funding_invoice_id as string | null) ?? null,
  };
}

/**
 * Refund a previously consumed credit (compile failed, session insert failed).
 * The +1 row references the same invoice so per-invoice accounting stays exact.
 */
export async function refundCredit(
  trainerId: string,
  type: CreditType,
  fundingInvoiceId: string | null,
  refs: { scenarioId?: string; sessionId?: string } = {},
): Promise<void> {
  const { error } = await supabaseAdmin.from('credit_ledger').insert({
    trainer_id: trainerId,
    credit_type: type,
    delta: 1,
    reason: 'refund',
    invoice_id: fundingInvoiceId,
    scenario_id: refs.scenarioId ?? null,
    session_id: refs.sessionId ?? null,
  });
  if (error) {
    // Loud: a failed refund means a trainer lost a paid credit.
    logger.error({ error, trainerId, type, fundingInvoiceId }, 'FAILED TO REFUND CREDIT');
  } else {
    logger.info({ trainerId, type, fundingInvoiceId }, 'Credit refunded');
  }
}

/** Grant the per-invoice credit bundle. Called by the invoice.paid webhook. */
export async function grantInvoiceCredits(trainerId: string, invoiceId: string): Promise<boolean> {
  const rows: Array<{
    trainer_id: string;
    credit_type: CreditType;
    delta: number;
    reason: string;
    invoice_id: string;
  }> = [];

  for (let i = 0; i < env.scenarioCreditsPerInvoice; i++) {
    rows.push({
      trainer_id: trainerId,
      credit_type: 'scenario',
      delta: 1,
      reason: 'invoice_paid',
      invoice_id: invoiceId,
    });
  }
  for (let i = 0; i < env.sessionCreditsPerInvoice; i++) {
    rows.push({
      trainer_id: trainerId,
      credit_type: 'session',
      delta: 1,
      reason: 'invoice_paid',
      invoice_id: invoiceId,
    });
  }

  const { error } = await supabaseAdmin.from('credit_ledger').insert(rows);
  if (error) {
    logger.error({ error, trainerId, invoiceId }, 'Failed to grant invoice credits');
    return false;
  }
  logger.info(
    {
      trainerId,
      invoiceId,
      scenario: env.scenarioCreditsPerInvoice,
      session: env.sessionCreditsPerInvoice,
    },
    'Invoice credits granted',
  );
  return true;
}
