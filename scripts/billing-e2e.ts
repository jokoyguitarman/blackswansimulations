import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

/**
 * Payment portal end-to-end verification (Stripe test mode).
 *
 * Requires: dev server on :3001, `stripe listen` forwarding to
 * /api/billing/webhook with the matching STRIPE_WEBHOOK_SECRET in .env.
 *
 * Walks the full loop: trainer signup -> paywall 402 -> enroll org ->
 * generate invoice -> pay with test card -> webhook grants credits (1/2) ->
 * two sessions consume credits (third blocked) -> AAR flips payout to
 * pending_release -> admin sees it, release blocked until Stripe onboarding.
 * Cleans up all test data at the end.
 *
 * Run: npx tsx scripts/billing-e2e.ts
 */

const API = 'http://localhost:3001';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY!;
const PASSWORD = 'BillingE2E#Test!2026';
const RUN_ID = Date.now().toString(36);
const TRAINER_EMAIL = `billing-e2e-trainer-${RUN_ID}@loadtest.example.com`;
const ADMIN_EMAIL = `billing-e2e-admin-${RUN_ID}@loadtest.example.com`;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const stripe = new Stripe(STRIPE_KEY);

let passCount = 0;
let failCount = 0;
const pass = (msg: string) => {
  passCount++;
  console.log(`  PASS  ${msg}`);
};
const fail = (msg: string) => {
  failCount++;
  console.log(`  FAIL  ${msg}`);
};
const expect = (cond: boolean, msg: string) => (cond ? pass(msg) : fail(msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createUser(email: string): Promise<{ userId: string; token: string }> {
  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: `Billing E2E ${RUN_ID}`, agency_name: 'E2E Test' },
  });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  const client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error: signInError } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError || !data.session) throw new Error(signInError?.message ?? 'sign-in failed');
  return { userId: data.user!.id, token: data.session.access_token };
}

async function apiCall(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function main() {
  console.log(`\n=== Payment portal E2E (run ${RUN_ID}) ===\n`);

  // ── 1. Trainer signup ────────────────────────────────────────────────
  console.log('1. Trainer self-signup');
  const trainer = await createUser(TRAINER_EMAIL);
  const become = await apiCall('POST', '/api/profile/become-trainer', trainer.token);
  expect(become.status === 200, `become-trainer returns 200 (got ${become.status})`);
  const { data: profile } = await admin
    .from('user_profiles')
    .select('role')
    .eq('id', trainer.userId)
    .single();
  expect(profile?.role === 'trainer', `profile role is trainer (got ${profile?.role})`);
  // Repeat call is idempotent; non-participant accounts are rejected elsewhere.
  const again = await apiCall('POST', '/api/profile/become-trainer', trainer.token);
  expect(
    again.status === 200 && again.json.alreadyTrainer === true,
    'repeat become-trainer is a no-op',
  );

  // ── 2. Paywall before payment ────────────────────────────────────────
  console.log('\n2. Credit gates before payment');
  const credits0 = await apiCall('GET', '/api/billing/credits', trainer.token);
  const c0 = credits0.json.data as { scenario: number; session: number };
  expect(
    c0.scenario === 0 && c0.session === 0,
    `credits start at 0/0 (got ${c0.scenario}/${c0.session})`,
  );
  const draftBlocked = await apiCall('POST', '/api/warroom/wizard/drafts', trainer.token, {
    input: {},
  });
  expect(
    draftBlocked.status === 402 && draftBlocked.json.code === 'NO_SCENARIO_CREDITS',
    `wizard draft blocked with 402 NO_SCENARIO_CREDITS (got ${draftBlocked.status})`,
  );
  const scBlocked = await apiCall('POST', '/api/warroom/social-crisis/research', trainer.token, {});
  expect(
    scBlocked.status === 402,
    `social-crisis research blocked with 402 (got ${scBlocked.status})`,
  );

  // ── 3. Enroll org + invoice ──────────────────────────────────────────
  console.log('\n3. Enroll client and generate invoice');
  const org = await apiCall('POST', '/api/billing/organisations', trainer.token, {
    name: `E2E Test Client ${RUN_ID}`,
    contact_name: 'E2E Contact',
    contact_email: `billing-e2e-client-${RUN_ID}@loadtest.example.com`,
    notes: 'Automated end-to-end test engagement',
  });
  expect(org.status === 201, `organisation enrolled (got ${org.status})`);
  const orgId = (org.json.data as { id: string }).id;

  const inv = await apiCall('POST', `/api/billing/organisations/${orgId}/invoice`, trainer.token);
  expect(
    inv.status === 201,
    `invoice created and sent (got ${inv.status}: ${JSON.stringify(inv.json)})`,
  );
  const invoice = inv.json.data as {
    id: string;
    stripe_invoice_id: string;
    amount_cents: number;
    hosted_invoice_url: string | null;
  };
  expect(
    invoice.amount_cents === 1_000_000,
    `amount is S$10,000 (got ${invoice.amount_cents} cents)`,
  );
  expect(Boolean(invoice.hosted_invoice_url), 'hosted invoice URL present');

  const dup = await apiCall('POST', `/api/billing/organisations/${orgId}/invoice`, trainer.token);
  expect(dup.status === 409, `second invoice for same org blocked with 409 (got ${dup.status})`);

  // ── 4. Pay the invoice with the test card ────────────────────────────
  console.log('\n4. Client pays (test card 4242)');
  const stripeInvoice = await stripe.invoices.retrieve(invoice.stripe_invoice_id);
  const customerId = stripeInvoice.customer as string;
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customerId });
  await stripe.invoices.pay(invoice.stripe_invoice_id, { payment_method: pm.id });
  pass('Stripe invoice paid in test mode');

  // ── 5. Webhook grants credits ────────────────────────────────────────
  console.log('\n5. Webhook -> credits granted');
  let credits = { scenario: 0, session: 0 };
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const res = await apiCall('GET', '/api/billing/credits', trainer.token);
    credits = res.json.data as typeof credits;
    if (credits.scenario > 0) break;
  }
  expect(
    credits.scenario === 1 && credits.session === 2,
    `credits are 1 scenario / 2 session (got ${credits.scenario}/${credits.session})`,
  );
  const { data: payoutRow } = await admin
    .from('payouts')
    .select('*')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  expect(
    payoutRow?.status === 'awaiting_completion' && payoutRow?.amount_cents === 300_000,
    `payout row created: S$3,000 awaiting_completion (got ${payoutRow?.status}, ${payoutRow?.amount_cents})`,
  );

  // Webhook idempotency: resend the same invoice.paid event.
  const events = await stripe.events.list({ type: 'invoice.paid', limit: 5 });
  const ourEvent = events.data.find(
    (e) => (e.data.object as { id?: string }).id === invoice.stripe_invoice_id,
  );
  if (ourEvent) {
    // Re-POST the exact event to the local webhook is impossible without a
    // fresh signature, so verify the dedupe row exists instead.
    const { data: seen } = await admin
      .from('stripe_webhook_events')
      .select('event_id')
      .eq('event_id', ourEvent.id)
      .maybeSingle();
    expect(Boolean(seen), 'webhook event recorded in idempotency table');
  }

  // Wizard entry now allowed (does not consume the credit).
  const draftOk = await apiCall('POST', '/api/warroom/wizard/drafts', trainer.token, { input: {} });
  expect(
    draftOk.status === 200,
    `wizard draft creation allowed after payment (got ${draftOk.status})`,
  );

  // ── 6. Session credits: 2 sessions allowed, 3rd blocked ──────────────
  console.log('\n6. Session creation consumes credits');
  const { data: scenario } = await admin
    .from('scenarios')
    .select('id, title')
    .limit(1)
    .maybeSingle();
  if (!scenario) {
    fail('no scenario available in DB to create sessions with');
    return finish([]);
  }

  const sessionIds: string[] = [];
  const s1 = await apiCall('POST', '/api/sessions', trainer.token, { scenario_id: scenario.id });
  expect(s1.status === 201, `session 1 created (got ${s1.status})`);
  const s1data = s1.json.data as { id: string; funding_invoice_id: string | null };
  sessionIds.push(s1data.id);
  expect(
    s1data.funding_invoice_id === invoice.id,
    `session 1 stamped with funding_invoice_id (got ${s1data.funding_invoice_id})`,
  );

  const s2 = await apiCall('POST', '/api/sessions', trainer.token, { scenario_id: scenario.id });
  expect(s2.status === 201, `session 2 created (got ${s2.status})`);
  if (s2.status === 201) sessionIds.push((s2.json.data as { id: string }).id);

  const s3 = await apiCall('POST', '/api/sessions', trainer.token, { scenario_id: scenario.id });
  expect(
    s3.status === 402 && s3.json.code === 'NO_SESSION_CREDITS',
    `session 3 blocked with 402 NO_SESSION_CREDITS (got ${s3.status})`,
  );

  const creditsAfter = (await apiCall('GET', '/api/billing/credits', trainer.token)).json.data as {
    scenario: number;
    session: number;
  };
  expect(
    creditsAfter.session === 0,
    `session credits exhausted after 2 games (got ${creditsAfter.session})`,
  );

  // ── 7. AAR flips the payout ──────────────────────────────────────────
  console.log('\n7. Produce AAR -> payout pending_release');
  await admin.from('sessions').update({ status: 'completed' }).eq('id', s1data.id);
  // Fire AAR generation; don't wait for the AI portions - poll the payout.
  const aarPromise = apiCall('POST', `/api/aar/session/${s1data.id}/generate`, trainer.token);
  let flipped: { status?: string; aar_generated_at?: string } | null = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const { data } = await admin
      .from('payouts')
      .select('status, aar_generated_at, session_id')
      .eq('invoice_id', invoice.id)
      .maybeSingle();
    if (data?.status === 'pending_release') {
      flipped = data;
      break;
    }
  }
  expect(flipped?.status === 'pending_release', `payout flipped to pending_release`);
  await aarPromise.catch(() => {});

  // Regenerating must not change anything (one-time flip).
  await apiCall('POST', `/api/aar/session/${s1data.id}/generate`, trainer.token).catch(() => {});
  const { data: still } = await admin
    .from('payouts')
    .select('status')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  expect(still?.status === 'pending_release', 'AAR regeneration does not re-trigger the payout');

  // ── 8. Admin review ──────────────────────────────────────────────────
  console.log('\n8. Admin payout review');
  const adminUser = await createUser(ADMIN_EMAIL);
  await admin.from('user_profiles').update({ role: 'admin' }).eq('id', adminUser.userId);

  const trainerList = await apiCall('GET', '/api/billing/payouts', trainer.token);
  expect(trainerList.status === 403, `trainer cannot list all payouts (got ${trainerList.status})`);

  const list = await apiCall('GET', '/api/billing/payouts?status=pending_release', adminUser.token);
  const rows = (list.json.data ?? []) as Array<Record<string, unknown>>;
  const ourPayout = rows.find((r) => r.invoice_id === invoice.id);
  expect(Boolean(ourPayout), 'admin sees the pending payout');
  if (ourPayout) {
    expect(
      ourPayout.trainer_onboarding_status === 'none',
      `onboarding status surfaced (got ${ourPayout.trainer_onboarding_status})`,
    );
    expect(
      Array.isArray(ourPayout.funded_sessions) &&
        (ourPayout.funded_sessions as unknown[]).length === 2,
      'both funded sessions attached for review',
    );

    const release = await apiCall(
      'POST',
      `/api/billing/payouts/${ourPayout.id}/release`,
      adminUser.token,
    );
    expect(
      release.status === 409,
      `release blocked while trainer onboarding incomplete (got ${release.status})`,
    );

    const hold = await apiCall(
      'POST',
      `/api/billing/payouts/${ourPayout.id}/hold`,
      adminUser.token,
      {
        reason: 'E2E hold test',
      },
    );
    expect(hold.status === 200, `payout can be held (got ${hold.status})`);
    const unhold = await apiCall(
      'POST',
      `/api/billing/payouts/${ourPayout.id}/unhold`,
      adminUser.token,
    );
    expect(unhold.status === 200, `payout can be unheld (got ${unhold.status})`);

    // Non-admin cannot release.
    const trainerRelease = await apiCall(
      'POST',
      `/api/billing/payouts/${ourPayout.id}/release`,
      trainer.token,
    );
    expect(
      trainerRelease.status === 403,
      `trainer cannot release payouts (got ${trainerRelease.status})`,
    );
  }

  await finish(sessionIds, orgId, trainer.userId, adminUser.userId);
}

async function finish(sessionIds: string[], orgId?: string, ...userIds: string[]) {
  console.log('\n9. Cleanup');
  try {
    for (const id of sessionIds) {
      await admin.from('sessions').delete().eq('id', id);
    }
    for (const userId of userIds) {
      if (!userId) continue;
      await admin.from('credit_ledger').delete().eq('trainer_id', userId);
      await admin.from('warroom_wizard_drafts').delete().eq('created_by', userId);
    }
    if (orgId) {
      // Cascades invoices -> payouts.
      await admin.from('client_organisations').delete().eq('id', orgId);
    }
    for (const userId of userIds) {
      if (!userId) continue;
      await admin.from('trainer_billing').delete().eq('trainer_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }
    console.log('  cleanup done');
  } catch (err) {
    console.log(`  cleanup issue (non-fatal): ${(err as Error).message}`);
  }

  console.log(`\n=== Result: ${passCount} passed, ${failCount} failed ===\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exit(1);
});
