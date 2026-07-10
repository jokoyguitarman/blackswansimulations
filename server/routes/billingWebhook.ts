import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { verifyWebhook } from '../services/stripeService.js';
import { grantInvoiceCredits } from '../services/creditService.js';

const router = Router();

/**
 * Stripe webhook - the single point where "client paid" enters the system.
 *
 * Three properties:
 *  - VERIFIED: signature checked over the raw body (this router MUST be
 *    mounted with express.raw() BEFORE the global express.json()).
 *  - IDEMPOTENT: every event id is recorded in stripe_webhook_events first;
 *    Stripe retries deliveries and a retry must not grant credits twice.
 *  - DEFENSIVE: events for objects we don't recognize (e.g. another app
 *    sharing this Stripe account) are acknowledged and ignored.
 */

router.post('/', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event: Stripe.Event;
  try {
    event = verifyWebhook(req.body as Buffer, signature);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Stripe webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency: first delivery wins.
  const { error: dedupeError } = await supabaseAdmin
    .from('stripe_webhook_events')
    .insert({ event_id: event.id, type: event.type });

  if (dedupeError) {
    if (dedupeError.code === '23505') {
      // Duplicate delivery - already processed.
      return res.json({ received: true, duplicate: true });
    }
    logger.error({ error: dedupeError, eventId: event.id }, 'Webhook dedupe insert failed');
    // Fail the delivery so Stripe retries; better than risking a double grant.
    return res.status(500).json({ error: 'Internal error' });
  }

  try {
    switch (event.type) {
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        await handleInvoiceVoided(event.data.object as Stripe.Invoice);
        break;
      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;
      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe event type');
    }
    res.json({ received: true });
  } catch (err) {
    const error = err as Error;
    logger.error(
      { error: error.message, stack: error.stack, eventId: event.id, type: event.type },
      'Stripe webhook handler failed',
    );
    // Remove the dedupe row so Stripe's retry can re-process the event.
    await supabaseAdmin.from('stripe_webhook_events').delete().eq('event_id', event.id);
    res.status(500).json({ error: 'Handler failed' });
  }
});

async function handleInvoicePaid(stripeInvoice: Stripe.Invoice): Promise<void> {
  const { data: invoice } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('stripe_invoice_id', stripeInvoice.id)
    .maybeSingle();

  if (!invoice) {
    // Not ours (possibly another app on the same Stripe account).
    logger.info(
      { stripeInvoiceId: stripeInvoice.id },
      'invoice.paid for unknown invoice, ignoring',
    );
    return;
  }
  if (invoice.status === 'paid') {
    logger.info({ invoiceId: invoice.id }, 'Invoice already marked paid, skipping');
    return;
  }

  const paidAt = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from('invoices')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('id', invoice.id);

  if (updateError) {
    throw new Error(`Failed to mark invoice paid: ${updateError.message}`);
  }

  const granted = await grantInvoiceCredits(invoice.trainer_id, invoice.id);
  if (!granted) {
    throw new Error('Failed to grant invoice credits');
  }

  // One payout per invoice, created up-front in awaiting_completion.
  const trainerShareCents = Math.round((invoice.amount_cents * env.trainerSharePercent) / 100);
  const { error: payoutError } = await supabaseAdmin.from('payouts').insert({
    invoice_id: invoice.id,
    trainer_id: invoice.trainer_id,
    amount_cents: trainerShareCents,
    currency: invoice.currency ?? 'sgd',
    status: 'awaiting_completion',
  });

  if (payoutError && payoutError.code !== '23505') {
    // 23505 = payout already exists (unique invoice_id) - fine.
    throw new Error(`Failed to create payout row: ${payoutError.message}`);
  }

  logger.info(
    {
      invoiceId: invoice.id,
      trainerId: invoice.trainer_id,
      trainerShareCents,
    },
    'Invoice paid: credits granted, payout created',
  );
}

async function handleInvoiceVoided(stripeInvoice: Stripe.Invoice): Promise<void> {
  const { data: invoice } = await supabaseAdmin
    .from('invoices')
    .select('id, status')
    .eq('stripe_invoice_id', stripeInvoice.id)
    .maybeSingle();

  if (!invoice) return;
  if (invoice.status === 'paid') {
    // Don't silently unwind a paid engagement; needs human review.
    logger.warn({ invoiceId: invoice.id }, 'Void event for an already-paid invoice, ignoring');
    return;
  }

  await supabaseAdmin.from('invoices').update({ status: 'void' }).eq('id', invoice.id);
  logger.info({ invoiceId: invoice.id }, 'Invoice voided via webhook');
}

async function handleAccountUpdated(account: Stripe.Account): Promise<void> {
  const onboarded = Boolean(account.details_submitted && account.payouts_enabled);
  if (!onboarded) return;

  const { data, error } = await supabaseAdmin
    .from('trainer_billing')
    .update({ onboarding_status: 'complete', updated_at: new Date().toISOString() })
    .eq('stripe_connect_account_id', account.id)
    .neq('onboarding_status', 'complete')
    .select('trainer_id');

  if (error) {
    logger.error({ error, accountId: account.id }, 'Failed to update onboarding status');
    return;
  }
  if (data && data.length > 0) {
    logger.info(
      { accountId: account.id, trainerId: data[0].trainer_id },
      'Trainer onboarding complete',
    );
  }
}

export { router as billingWebhookRouter };
