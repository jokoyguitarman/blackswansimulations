import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireStaff, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../lib/validation.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import {
  BillingDisabledError,
  createAccountLink,
  createAndSendInvoice,
  createConnectAccount,
  createCustomer,
  createExpressLoginLink,
  createTransfer,
  isAccountOnboarded,
  isBillingEnabled,
  voidInvoice,
} from '../services/stripeService.js';
import { getBalances } from '../services/creditService.js';
import { createNotification } from '../services/notificationService.js';
import { sendTrainerEnrollmentEmail } from '../services/emailService.js';
import { nanoid } from 'nanoid';

const router = Router();

/**
 * Payment portal routes.
 *
 * SECURITY: every endpoint runs behind requireAuth. Trainer endpoints are
 * additionally staff-gated; org/invoice/payout ownership is verified in code
 * (service-role client bypasses RLS). Admin money endpoints re-verify
 * role === 'admin' from the authenticated token on every call.
 */

const billingGuard = (_req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!isBillingEnabled()) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }
  next();
};

const handleBillingError = (err: unknown, res: Response, where: string): void => {
  if (err instanceof BillingDisabledError) {
    res.status(503).json({ error: 'Billing is not configured on this server' });
    return;
  }
  const error = err as Error;
  logger.error({ error: error.message, stack: error.stack }, `Error in ${where}`);
  res.status(500).json({ error: 'Internal server error' });
};

const requireAdmin = (user: { role?: string }): boolean => user.role === 'admin';

// ---------------------------------------------------------------------------
// Client organisations
// ---------------------------------------------------------------------------

router.get('/organisations', requireAuth, requireStaff, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    const { data: orgs, error } = await supabaseAdmin
      .from('client_organisations')
      .select(
        '*, invoices(id, status, amount_cents, currency, hosted_invoice_url, sent_at, paid_at)',
      )
      .eq('trainer_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to list organisations');
      return res.status(500).json({ error: 'Failed to list organisations' });
    }

    res.json({ data: orgs ?? [] });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/organisations');
  }
});

const createOrgSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    contact_name: z.string().max(200).optional(),
    contact_email: z.string().email(),
    notes: z.string().max(2000).optional(),
  }),
});

router.post(
  '/organisations',
  requireAuth,
  requireStaff,
  validate(createOrgSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { name, contact_name, contact_email, notes } = req.body;

      const { data, error } = await supabaseAdmin
        .from('client_organisations')
        .insert({
          trainer_id: user.id,
          name,
          contact_name: contact_name ?? null,
          contact_email,
          notes: notes ?? null,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, userId: user.id }, 'Failed to create organisation');
        return res.status(500).json({ error: 'Failed to create organisation' });
      }

      logger.info({ orgId: data.id, userId: user.id }, 'Client organisation enrolled');
      res.status(201).json({ data });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/organisations');
    }
  },
);

const updateOrgSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    contact_name: z.string().max(200).optional(),
    contact_email: z.string().email().optional(),
    notes: z.string().max(2000).optional(),
  }),
});

router.patch(
  '/organisations/:id',
  requireAuth,
  requireStaff,
  validate(updateOrgSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;

      const { data: org } = await supabaseAdmin
        .from('client_organisations')
        .select('id, trainer_id')
        .eq('id', id)
        .maybeSingle();

      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      if (org.trainer_id !== user.id && !requireAdmin(user)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const updates: Record<string, unknown> = {};
      for (const key of ['name', 'contact_name', 'contact_email', 'notes'] as const) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No updatable fields provided' });
      }

      const { data, error } = await supabaseAdmin
        .from('client_organisations')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error({ error, orgId: id }, 'Failed to update organisation');
        return res.status(500).json({ error: 'Failed to update organisation' });
      }

      res.json({ data });
    } catch (err) {
      handleBillingError(err, res, 'PATCH /billing/organisations/:id');
    }
  },
);

router.delete(
  '/organisations/:id',
  requireAuth,
  requireStaff,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;

      const { data: org } = await supabaseAdmin
        .from('client_organisations')
        .select('id, trainer_id')
        .eq('id', id)
        .maybeSingle();

      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      if (org.trainer_id !== user.id && !requireAdmin(user)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Never delete billing history: block once an invoice exists.
      const { count } = await supabaseAdmin
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('organisation_id', id);

      if ((count ?? 0) > 0) {
        return res
          .status(409)
          .json({ error: 'This organisation has invoices and cannot be deleted' });
      }

      const { error } = await supabaseAdmin.from('client_organisations').delete().eq('id', id);
      if (error) {
        logger.error({ error, orgId: id }, 'Failed to delete organisation');
        return res.status(500).json({ error: 'Failed to delete organisation' });
      }

      res.json({ success: true });
    } catch (err) {
      handleBillingError(err, res, 'DELETE /billing/organisations/:id');
    }
  },
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

router.post(
  '/organisations/:id/invoice',
  requireAuth,
  requireStaff,
  billingGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;

      const { data: org } = await supabaseAdmin
        .from('client_organisations')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      if (org.trainer_id !== user.id && !requireAdmin(user)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // One outstanding invoice per organisation at a time.
      const { data: existing } = await supabaseAdmin
        .from('invoices')
        .select('id, status')
        .eq('organisation_id', id)
        .in('status', ['sent', 'paid'])
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing?.status === 'sent') {
        return res
          .status(409)
          .json({ error: 'This organisation already has an outstanding invoice' });
      }
      if (existing?.status === 'paid') {
        return res.status(409).json({
          error: 'This engagement is already paid. Enroll a new engagement to invoice again.',
        });
      }

      // Ensure a Stripe customer exists for the org.
      let customerId = org.stripe_customer_id as string | null;
      if (!customerId) {
        customerId = await createCustomer({
          id: org.id,
          name: org.name,
          contact_name: org.contact_name,
          contact_email: org.contact_email,
        });
        await supabaseAdmin
          .from('client_organisations')
          .update({ stripe_customer_id: customerId })
          .eq('id', org.id);
      }

      const amountCents = Math.round(env.invoiceAmountSgd * 100);
      const { stripeInvoiceId, hostedInvoiceUrl } = await createAndSendInvoice({
        customerId,
        amountCents,
        currency: 'sgd',
        description:
          'Black Swan crisis simulation training engagement - 1 bespoke scenario, 2 live training sessions, after-action report',
        organisationId: org.id,
        trainerId: user.id,
      });

      const { data: invoice, error } = await supabaseAdmin
        .from('invoices')
        .insert({
          organisation_id: org.id,
          trainer_id: user.id,
          stripe_invoice_id: stripeInvoiceId,
          amount_cents: amountCents,
          currency: 'sgd',
          status: 'sent',
          hosted_invoice_url: hostedInvoiceUrl,
        })
        .select()
        .single();

      if (error) {
        logger.error({ error, orgId: org.id }, 'Stripe invoice created but DB insert failed');
        return res.status(500).json({ error: 'Failed to record invoice' });
      }

      logger.info(
        { invoiceId: invoice.id, stripeInvoiceId, orgId: org.id, userId: user.id },
        'Invoice created and sent',
      );
      res.status(201).json({ data: invoice });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/organisations/:id/invoice');
    }
  },
);

router.post(
  '/invoices/:id/void',
  requireAuth,
  requireStaff,
  billingGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      const { id } = req.params;

      const { data: invoice } = await supabaseAdmin
        .from('invoices')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      if (invoice.trainer_id !== user.id && !requireAdmin(user)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (invoice.status !== 'sent') {
        return res
          .status(409)
          .json({ error: `Cannot void an invoice with status '${invoice.status}'` });
      }

      if (invoice.stripe_invoice_id) {
        await voidInvoice(invoice.stripe_invoice_id);
      }
      await supabaseAdmin.from('invoices').update({ status: 'void' }).eq('id', id);

      logger.info({ invoiceId: id, userId: user.id }, 'Invoice voided');
      res.json({ success: true });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/invoices/:id/void');
    }
  },
);

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

router.get('/credits', requireAuth, requireStaff, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    const balances = await getBalances(user.id);
    res.json({ data: balances });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/credits');
  }
});

// ---------------------------------------------------------------------------
// Stripe Connect onboarding (trainer payout destination)
// ---------------------------------------------------------------------------

router.post(
  '/connect/onboard',
  requireAuth,
  requireStaff,
  billingGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;

      const { data: billing } = await supabaseAdmin
        .from('trainer_billing')
        .select('*')
        .eq('trainer_id', user.id)
        .maybeSingle();

      let accountId = billing?.stripe_connect_account_id as string | null | undefined;
      if (!accountId) {
        accountId = await createConnectAccount(user.email ?? '', user.id);
        await supabaseAdmin.from('trainer_billing').upsert(
          {
            trainer_id: user.id,
            stripe_connect_account_id: accountId,
            onboarding_status: 'pending',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'trainer_id' },
        );
      }

      const url = await createAccountLink(
        accountId,
        `${env.clientUrl}/clients?connect=refresh`,
        `${env.clientUrl}/clients?connect=return`,
      );

      res.json({ data: { url } });
    } catch (err) {
      // Surface Stripe's own message (e.g. "sign up for Connect") instead of a
      // bare 500 - this is a platform-configuration problem, not a server bug.
      const stripeErr = err as { type?: string; message?: string };
      if (typeof stripeErr.type === 'string' && stripeErr.type.startsWith('Stripe')) {
        logger.error({ error: stripeErr.message }, 'Stripe Connect onboarding failed');
        return res.status(502).json({
          error: `Payout setup unavailable: ${stripeErr.message ?? 'Stripe rejected the request'}. (Is Connect enabled on the platform Stripe account?)`,
        });
      }
      handleBillingError(err, res, 'POST /billing/connect/onboard');
    }
  },
);

// One-time link to the trainer's Stripe Express dashboard (bank details,
// payout history). Only available once onboarding is complete.
router.post(
  '/connect/manage',
  requireAuth,
  requireStaff,
  billingGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;

      const { data: billing } = await supabaseAdmin
        .from('trainer_billing')
        .select('stripe_connect_account_id, onboarding_status')
        .eq('trainer_id', user.id)
        .maybeSingle();

      if (!billing?.stripe_connect_account_id || billing.onboarding_status !== 'complete') {
        return res
          .status(409)
          .json({ error: 'Complete payout setup first, then you can manage your bank details.' });
      }

      const url = await createExpressLoginLink(billing.stripe_connect_account_id);
      res.json({ data: { url } });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/connect/manage');
    }
  },
);

router.get('/connect/status', requireAuth, requireStaff, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    const { data: billing } = await supabaseAdmin
      .from('trainer_billing')
      .select('*')
      .eq('trainer_id', user.id)
      .maybeSingle();

    if (!billing?.stripe_connect_account_id) {
      return res.json({ data: { status: 'none' } });
    }

    let status = billing.onboarding_status as string;
    // Live-check while pending (webhook account.updated also flips this,
    // but the return-from-Stripe redirect can beat the webhook).
    if (status === 'pending' && isBillingEnabled()) {
      try {
        if (await isAccountOnboarded(billing.stripe_connect_account_id)) {
          status = 'complete';
          await supabaseAdmin
            .from('trainer_billing')
            .update({ onboarding_status: 'complete', updated_at: new Date().toISOString() })
            .eq('trainer_id', user.id);
        }
      } catch (checkErr) {
        logger.warn({ error: checkErr, userId: user.id }, 'Connect status live-check failed');
      }
    }

    res.json({ data: { status } });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/connect/status');
  }
});

// ---------------------------------------------------------------------------
// Payouts - trainer view
// ---------------------------------------------------------------------------

router.get('/payouts/mine', requireAuth, requireStaff, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;

    const { data, error } = await supabaseAdmin
      .from('payouts')
      .select(
        '*, invoice:invoices(id, amount_cents, currency, paid_at, organisation:client_organisations(id, name))',
      )
      .eq('trainer_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to list trainer payouts');
      return res.status(500).json({ error: 'Failed to list payouts' });
    }

    res.json({ data: data ?? [] });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/payouts/mine');
  }
});

// ---------------------------------------------------------------------------
// Payouts - admin review & release
// ---------------------------------------------------------------------------

router.get('/payouts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (!requireAdmin(user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    let query = supabaseAdmin
      .from('payouts')
      .select(
        `*,
         trainer:user_profiles!payouts_trainer_id_fkey(id, full_name, username),
         invoice:invoices(id, amount_cents, currency, paid_at, organisation:client_organisations(id, name))`,
      )
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to list payouts');
      return res.status(500).json({ error: 'Failed to list payouts' });
    }

    // payouts has no FK to trainer_billing (both reference user_profiles),
    // so enrich the onboarding status manually.
    const rows = data ?? [];
    const trainerIds = Array.from(new Set(rows.map((p) => p.trainer_id)));
    const billingMap = new Map<string, string>();
    if (trainerIds.length > 0) {
      const { data: billingRows } = await supabaseAdmin
        .from('trainer_billing')
        .select('trainer_id, onboarding_status')
        .in('trainer_id', trainerIds);
      for (const b of billingRows ?? []) {
        billingMap.set(b.trainer_id as string, b.onboarding_status as string);
      }
    }
    // Session context for review: which sessions each invoice funded.
    const invoiceIds = rows.map((p) => p.invoice_id).filter(Boolean);
    const sessionsByInvoice = new Map<string, Array<Record<string, unknown>>>();
    if (invoiceIds.length > 0) {
      const { data: fundedSessions } = await supabaseAdmin
        .from('sessions')
        .select('id, status, start_time, end_time, funding_invoice_id')
        .in('funding_invoice_id', invoiceIds);
      for (const s of fundedSessions ?? []) {
        const key = s.funding_invoice_id as string;
        if (!sessionsByInvoice.has(key)) sessionsByInvoice.set(key, []);
        sessionsByInvoice.get(key)!.push(s);
      }
    }

    const enriched = rows.map((p) => ({
      ...p,
      trainer_onboarding_status: billingMap.get(p.trainer_id) ?? 'none',
      funded_sessions: sessionsByInvoice.get(p.invoice_id) ?? [],
    }));

    res.json({ data: enriched });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/payouts');
  }
});

router.post(
  '/payouts/:id/release',
  requireAuth,
  billingGuard,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (!requireAdmin(user)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const { id } = req.params;

      const { data: payout } = await supabaseAdmin
        .from('payouts')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!payout) return res.status(404).json({ error: 'Payout not found' });
      if (payout.status !== 'pending_release') {
        return res
          .status(409)
          .json({ error: `Payout is '${payout.status}', only pending_release can be released` });
      }

      const { data: billing } = await supabaseAdmin
        .from('trainer_billing')
        .select('stripe_connect_account_id, onboarding_status')
        .eq('trainer_id', payout.trainer_id)
        .maybeSingle();

      if (!billing?.stripe_connect_account_id || billing.onboarding_status !== 'complete') {
        return res.status(409).json({
          error: 'Trainer has not completed payout setup (Stripe onboarding incomplete)',
        });
      }

      let transferId: string;
      try {
        transferId = await createTransfer({
          accountId: billing.stripe_connect_account_id,
          amountCents: payout.amount_cents,
          currency: payout.currency ?? 'sgd',
          payoutId: payout.id,
          invoiceId: payout.invoice_id,
        });
      } catch (transferErr) {
        const message = (transferErr as Error).message;
        logger.error({ error: message, payoutId: id }, 'Stripe transfer failed');
        await supabaseAdmin
          .from('payouts')
          .update({ status: 'failed', hold_reason: `Transfer failed: ${message}` })
          .eq('id', id);
        return res.status(502).json({ error: `Stripe transfer failed: ${message}` });
      }

      const { data: updated, error } = await supabaseAdmin
        .from('payouts')
        .update({
          status: 'released',
          stripe_transfer_id: transferId,
          released_at: new Date().toISOString(),
          released_by: user.id,
          hold_reason: null,
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error(
          { error, payoutId: id, transferId },
          'Transfer succeeded but DB update failed',
        );
        return res
          .status(500)
          .json({ error: 'Transfer sent but failed to record - contact support' });
      }

      // Notify the trainer (session-scoped notification when we know the session).
      if (payout.session_id) {
        await createNotification({
          sessionId: payout.session_id,
          userId: payout.trainer_id,
          type: 'system_alert',
          title: 'Payout released',
          message: `Your payout of ${((payout.amount_cents ?? 0) / 100).toLocaleString('en-SG', { style: 'currency', currency: 'SGD' })} has been released to your bank account.`,
          priority: 'high',
        });
      }

      logger.info({ payoutId: id, transferId, adminId: user.id }, 'Payout released');
      res.json({ data: updated });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/payouts/:id/release');
    }
  },
);

const holdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(1000).optional() }),
});

router.post(
  '/payouts/:id/hold',
  requireAuth,
  validate(holdSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (!requireAdmin(user)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const { id } = req.params;
      const { reason } = req.body;

      const { data: payout } = await supabaseAdmin
        .from('payouts')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();

      if (!payout) return res.status(404).json({ error: 'Payout not found' });
      if (payout.status !== 'pending_release' && payout.status !== 'failed') {
        return res
          .status(409)
          .json({ error: `Cannot hold a payout with status '${payout.status}'` });
      }

      const { data, error } = await supabaseAdmin
        .from('payouts')
        .update({ status: 'held', hold_reason: reason ?? null })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error({ error, payoutId: id }, 'Failed to hold payout');
        return res.status(500).json({ error: 'Failed to hold payout' });
      }

      logger.info({ payoutId: id, adminId: user.id, reason }, 'Payout held');
      res.json({ data });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/payouts/:id/hold');
    }
  },
);

router.post('/payouts/:id/unhold', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (!requireAdmin(user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { id } = req.params;

    const { data: payout } = await supabaseAdmin
      .from('payouts')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();

    if (!payout) return res.status(404).json({ error: 'Payout not found' });
    if (payout.status !== 'held') {
      return res.status(409).json({ error: `Payout is '${payout.status}', not held` });
    }

    const { data, error } = await supabaseAdmin
      .from('payouts')
      .update({ status: 'pending_release', hold_reason: null })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error({ error, payoutId: id }, 'Failed to unhold payout');
      return res.status(500).json({ error: 'Failed to unhold payout' });
    }

    logger.info({ payoutId: id, adminId: user.id }, 'Payout unheld');
    res.json({ data });
  } catch (err) {
    handleBillingError(err, res, 'POST /billing/payouts/:id/unhold');
  }
});

// ---------------------------------------------------------------------------
// Admin business console: every trainer with clients, engagements, credits,
// sessions and payout totals in one payload.
// ---------------------------------------------------------------------------

router.get('/admin/trainers', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user!;
    if (!requireAdmin(user)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { data: trainers, error: trainersError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, full_name, username, agency_name, created_at')
      .eq('role', 'trainer')
      .order('created_at', { ascending: false });

    if (trainersError) {
      logger.error({ error: trainersError }, 'Failed to list trainers');
      return res.status(500).json({ error: 'Failed to list trainers' });
    }

    const trainerIds = (trainers ?? []).map((t) => t.id as string);
    if (trainerIds.length === 0) {
      return res.json({ data: [] });
    }

    const [orgsRes, invoicesRes, ledgerRes, payoutsRes, sessionsRes, billingRes] =
      await Promise.all([
        supabaseAdmin
          .from('client_organisations')
          .select('id, trainer_id, name')
          .in('trainer_id', trainerIds),
        supabaseAdmin
          .from('invoices')
          .select('trainer_id, status, amount_cents')
          .in('trainer_id', trainerIds),
        supabaseAdmin
          .from('credit_ledger')
          .select('trainer_id, credit_type, delta')
          .in('trainer_id', trainerIds),
        supabaseAdmin
          .from('payouts')
          .select('trainer_id, status, amount_cents')
          .in('trainer_id', trainerIds),
        supabaseAdmin.from('sessions').select('trainer_id, status').in('trainer_id', trainerIds),
        supabaseAdmin
          .from('trainer_billing')
          .select('trainer_id, onboarding_status')
          .in('trainer_id', trainerIds),
      ]);

    interface TrainerSummary {
      id: string;
      full_name: string;
      username: string;
      agency_name: string | null;
      created_at: string;
      onboarding_status: string;
      client_count: number;
      client_names: string[];
      invoices: { sent: number; paid: number; void: number; paid_amount_cents: number };
      credits: { scenario: number; session: number };
      sessions: { total: number; upcoming: number; active: number; completed: number };
      payouts: {
        awaiting_completion_cents: number;
        pending_release_cents: number;
        released_cents: number;
        held_cents: number;
      };
    }

    const byTrainer = new Map<string, TrainerSummary>();
    for (const t of trainers ?? []) {
      byTrainer.set(t.id as string, {
        id: t.id as string,
        full_name: (t.full_name as string) ?? '',
        username: (t.username as string) ?? '',
        agency_name: (t.agency_name as string) ?? null,
        created_at: t.created_at as string,
        onboarding_status: 'none',
        client_count: 0,
        client_names: [],
        invoices: { sent: 0, paid: 0, void: 0, paid_amount_cents: 0 },
        credits: { scenario: 0, session: 0 },
        sessions: { total: 0, upcoming: 0, active: 0, completed: 0 },
        payouts: {
          awaiting_completion_cents: 0,
          pending_release_cents: 0,
          released_cents: 0,
          held_cents: 0,
        },
      });
    }

    for (const b of billingRes.data ?? []) {
      const t = byTrainer.get(b.trainer_id as string);
      if (t) t.onboarding_status = b.onboarding_status as string;
    }
    for (const o of orgsRes.data ?? []) {
      const t = byTrainer.get(o.trainer_id as string);
      if (t) {
        t.client_count++;
        t.client_names.push(o.name as string);
      }
    }
    for (const inv of invoicesRes.data ?? []) {
      const t = byTrainer.get(inv.trainer_id as string);
      if (!t) continue;
      const status = inv.status as 'sent' | 'paid' | 'void';
      if (status in t.invoices) t.invoices[status]++;
      if (status === 'paid') t.invoices.paid_amount_cents += (inv.amount_cents as number) ?? 0;
    }
    for (const row of ledgerRes.data ?? []) {
      const t = byTrainer.get(row.trainer_id as string);
      if (!t) continue;
      const type = row.credit_type as 'scenario' | 'session';
      if (type === 'scenario' || type === 'session') t.credits[type] += row.delta as number;
    }
    for (const p of payoutsRes.data ?? []) {
      const t = byTrainer.get(p.trainer_id as string);
      if (!t) continue;
      const cents = (p.amount_cents as number) ?? 0;
      switch (p.status as string) {
        case 'awaiting_completion':
          t.payouts.awaiting_completion_cents += cents;
          break;
        case 'pending_release':
        case 'failed':
          t.payouts.pending_release_cents += cents;
          break;
        case 'released':
          t.payouts.released_cents += cents;
          break;
        case 'held':
          t.payouts.held_cents += cents;
          break;
      }
    }
    for (const s of sessionsRes.data ?? []) {
      const t = byTrainer.get(s.trainer_id as string);
      if (!t) continue;
      t.sessions.total++;
      const status = s.status as string;
      if (status === 'scheduled') t.sessions.upcoming++;
      else if (status === 'in_progress' || status === 'paused') t.sessions.active++;
      else if (status === 'completed') t.sessions.completed++;
    }

    res.json({ data: Array.from(byTrainer.values()) });
  } catch (err) {
    handleBillingError(err, res, 'GET /billing/admin/trainers');
  }
});

// ---------------------------------------------------------------------------
// Admin: enroll a trainer directly (pre-provisioning for known trainers).
// Creates the account with the trainer role and emails the credentials; the
// temporary password is also returned so the admin can hand it over manually
// if email delivery is unavailable.
// ---------------------------------------------------------------------------

const enrollTrainerSchema = z.object({
  body: z.object({
    email: z.string().email(),
    full_name: z.string().min(1).max(200),
    agency_name: z.string().max(200).optional(),
  }),
});

router.post(
  '/admin/trainers',
  requireAuth,
  validate(enrollTrainerSchema),
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.user!;
      if (!requireAdmin(user)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const { email, full_name, agency_name } = req.body;

      // Readable one-time password, e.g. "Swan-x4Tz9mQbLw".
      const temporaryPassword = `Swan-${nanoid(10)}`;

      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: {
          full_name,
          agency_name: agency_name ?? 'Independent Trainer',
        },
      });

      if (createError || !created?.user) {
        if (/already/i.test(createError?.message ?? '')) {
          return res.status(409).json({
            error: 'A user with this email already exists. They can sign in and use their account.',
          });
        }
        logger.error({ error: createError, email }, 'Failed to create trainer account');
        return res.status(500).json({ error: 'Failed to create trainer account' });
      }

      const newUserId = created.user.id;

      // handle_new_user created the profile as 'participant'; upgrade to
      // trainer (service-role write, trusted by the anti-escalation trigger).
      // The profile row is created by a trigger, so tolerate a brief delay.
      let upgraded = false;
      for (let attempt = 0; attempt < 5 && !upgraded; attempt++) {
        const { data: updatedRows } = await supabaseAdmin
          .from('user_profiles')
          .update({ role: 'trainer', full_name, agency_name: agency_name ?? 'Independent Trainer' })
          .eq('id', newUserId)
          .select('id');
        if (updatedRows && updatedRows.length > 0) {
          upgraded = true;
        } else {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (!upgraded) {
        // Profile trigger never materialized the row; create it directly.
        const { error: insertError } = await supabaseAdmin.from('user_profiles').insert({
          id: newUserId,
          username: email,
          full_name,
          role: 'trainer',
          agency_name: agency_name ?? 'Independent Trainer',
        });
        if (insertError) {
          logger.error({ error: insertError, email }, 'Failed to provision trainer profile');
          return res.status(500).json({ error: 'Account created but profile setup failed' });
        }
      }

      await supabaseAdmin
        .from('trainer_billing')
        .upsert({ trainer_id: newUserId, onboarding_status: 'none' }, { onConflict: 'trainer_id' });

      const enrolledByName =
        (user.metadata?.full_name as string | undefined) || user.email || 'the Black Swan team';
      const emailSent = await sendTrainerEnrollmentEmail({
        to: email,
        toName: full_name,
        temporaryPassword,
        enrolledByName,
      });

      logger.info(
        { adminId: user.id, trainerId: newUserId, email, emailSent },
        'Trainer enrolled by admin',
      );
      res.status(201).json({
        data: {
          id: newUserId,
          email,
          full_name,
          temporary_password: temporaryPassword,
          email_sent: emailSent,
        },
      });
    } catch (err) {
      handleBillingError(err, res, 'POST /billing/admin/trainers');
    }
  },
);

export { router as billingRouter };
