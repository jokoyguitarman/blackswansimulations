import Stripe from 'stripe';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/**
 * Stripe Service - the only module that talks to the Stripe SDK.
 *
 * Products used:
 *  - Stripe Invoicing: fixed-fee engagement invoices emailed to the trainer's
 *    client (hosted payment page; the client never needs an account with us).
 *  - Stripe Connect (Express): trainer onboarding (KYC + bank details).
 *  - Separate charges & transfers: the payment lands 100% in the platform
 *    balance; the trainer's share is transferred only when an admin releases
 *    the payout after the AAR.
 *
 * Everything we create is tagged with metadata.app = 'blackswan-sim' so this
 * account can be shared with other products without webhook cross-talk.
 */

export const APP_METADATA_TAG = 'blackswan-sim';

let stripeClient: Stripe | null = null;

export const isBillingEnabled = (): boolean => Boolean(env.stripeSecretKey);

export function getStripe(): Stripe {
  if (!env.stripeSecretKey) {
    throw new BillingDisabledError();
  }
  if (!stripeClient) {
    stripeClient = new Stripe(env.stripeSecretKey);
  }
  return stripeClient;
}

export class BillingDisabledError extends Error {
  constructor() {
    super('Billing is not configured (STRIPE_SECRET_KEY missing)');
    this.name = 'BillingDisabledError';
  }
}

/** Create a Stripe Customer for a client organisation. */
export async function createCustomer(org: {
  id: string;
  name: string;
  contact_name?: string | null;
  contact_email: string;
}): Promise<string> {
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: org.name,
    email: org.contact_email,
    metadata: {
      app: APP_METADATA_TAG,
      organisation_id: org.id,
      contact_name: org.contact_name ?? '',
    },
  });
  return customer.id;
}

/**
 * Create, finalize and send a fixed-fee invoice. Stripe emails the client a
 * hosted payment page (requires "Email finalized invoices to customers" to be
 * enabled in the dashboard).
 */
export async function createAndSendInvoice(params: {
  customerId: string;
  amountCents: number;
  currency: string;
  description: string;
  organisationId: string;
  trainerId: string;
}): Promise<{ stripeInvoiceId: string; hostedInvoiceUrl: string | null }> {
  const stripe = getStripe();

  const invoice = await stripe.invoices.create({
    customer: params.customerId,
    collection_method: 'send_invoice',
    days_until_due: 30,
    currency: params.currency,
    metadata: {
      app: APP_METADATA_TAG,
      organisation_id: params.organisationId,
      trainer_id: params.trainerId,
    },
  });

  await stripe.invoiceItems.create({
    customer: params.customerId,
    invoice: invoice.id,
    amount: params.amountCents,
    currency: params.currency,
    description: params.description,
  });

  const finalized = await stripe.invoices.finalizeInvoice(invoice.id!);
  // sendInvoice triggers Stripe's email delivery to the customer.
  const sent = await stripe.invoices.sendInvoice(finalized.id!);

  return {
    stripeInvoiceId: sent.id!,
    hostedInvoiceUrl: sent.hosted_invoice_url ?? null,
  };
}

/** Void an open (unpaid) invoice. */
export async function voidInvoice(stripeInvoiceId: string): Promise<void> {
  const stripe = getStripe();
  await stripe.invoices.voidInvoice(stripeInvoiceId);
}

/** Create an Express connected account for a trainer (payout destination). */
export async function createConnectAccount(email: string, trainerId: string): Promise<string> {
  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    capabilities: {
      transfers: { requested: true },
    },
    metadata: {
      app: APP_METADATA_TAG,
      trainer_id: trainerId,
    },
  });
  return account.id;
}

/** Fresh onboarding link for an Express account (links are single-use). */
export async function createAccountLink(
  accountId: string,
  refreshUrl: string,
  returnUrl: string,
): Promise<string> {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

/** Whether the connected account has completed onboarding for payouts. */
export async function isAccountOnboarded(accountId: string): Promise<boolean> {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(accountId);
  return Boolean(account.details_submitted && account.payouts_enabled);
}

/** Transfer the trainer's share from the platform balance (payout release). */
export async function createTransfer(params: {
  accountId: string;
  amountCents: number;
  currency: string;
  payoutId: string;
  invoiceId: string;
}): Promise<string> {
  const stripe = getStripe();
  const transfer = await stripe.transfers.create({
    destination: params.accountId,
    amount: params.amountCents,
    currency: params.currency,
    metadata: {
      app: APP_METADATA_TAG,
      payout_id: params.payoutId,
      invoice_id: params.invoiceId,
    },
  });
  return transfer.id;
}

/** Verify a webhook payload's signature. Throws on invalid/missing signature. */
export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!env.stripeWebhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  return getStripe().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
}

/** Log-friendly guard used by routes to fail fast when billing is off. */
export function assertBillingEnabled(): void {
  if (!isBillingEnabled()) {
    logger.warn('Billing endpoint called but STRIPE_SECRET_KEY is not configured');
    throw new BillingDisabledError();
  }
}
