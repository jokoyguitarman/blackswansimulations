-- Migration 193: Payment portal (client orgs, invoices, credits, payouts)
--
-- Business model:
--   * Trainers enroll client organisations and send them a fixed-fee Stripe
--     invoice (10,000 SGD by default).
--   * When the invoice is paid (Stripe webhook), the trainer is granted
--     1 scenario credit + 2 session credits (env-configurable).
--   * Warroom scenario compilation consumes a scenario credit; session
--     creation consumes a session credit and records which invoice funded it.
--   * Producing the AAR for a funded session flips the payout row to
--     'pending_release'; an admin releases it (Stripe transfer of the
--     trainer's share, 30% by default).
--
-- SECURITY: these tables are accessed exclusively through the server's
-- service-role client. RLS is enabled with NO anon/authenticated policies,
-- and consume_credit() is revoked from public roles so it cannot be invoked
-- via Supabase's public RPC surface.

-- ---------------------------------------------------------------------------
-- 1. Client organisations (the trainer's clients; they never log in)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_organisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT NOT NULL,
  notes TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_organisations_trainer ON client_organisations(trainer_id);

-- ---------------------------------------------------------------------------
-- 2. Invoices (one row per Stripe invoice we issue)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES client_organisations(id) ON DELETE CASCADE,
  trainer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  stripe_invoice_id TEXT UNIQUE,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'sgd',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'paid', 'void')),
  hosted_invoice_url TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invoices_trainer ON invoices(trainer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_organisation ON invoices(organisation_id);

-- ---------------------------------------------------------------------------
-- 3. Credit ledger (append-only; balance = SUM(delta))
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('scenario', 'session')),
  delta INT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'invoice_paid',
    'scenario_generated',
    'session_created',
    'refund',
    'admin_adjustment'
  )),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  scenario_id UUID,
  session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_trainer_type ON credit_ledger(trainer_id, credit_type);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_invoice ON credit_ledger(invoice_id);

-- ---------------------------------------------------------------------------
-- 4. Payouts (exactly one per paid invoice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID UNIQUE NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  trainer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  session_id UUID,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'sgd',
  status TEXT NOT NULL DEFAULT 'awaiting_completion' CHECK (status IN (
    'awaiting_completion',
    'pending_release',
    'released',
    'held',
    'failed'
  )),
  hold_reason TEXT,
  stripe_transfer_id TEXT,
  aar_generated_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  released_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payouts_trainer ON payouts(trainer_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

-- ---------------------------------------------------------------------------
-- 5. Trainer billing profile (Stripe Connect onboarding state)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trainer_billing (
  trainer_id UUID PRIMARY KEY REFERENCES user_profiles(id) ON DELETE CASCADE,
  stripe_connect_account_id TEXT UNIQUE,
  onboarding_status TEXT NOT NULL DEFAULT 'none' CHECK (onboarding_status IN ('none', 'pending', 'complete')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 6. Webhook idempotency guard (Stripe retries deliveries)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 7. Link sessions to the invoice that funded them
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS funding_invoice_id UUID REFERENCES invoices(id);

-- ---------------------------------------------------------------------------
-- 8. Race-safe credit consumption.
--    Takes a per-(trainer, credit_type) advisory lock, verifies the balance,
--    inserts the -1 spend row and returns which invoice funded the spend
--    (oldest paid invoice with unspent credits of this type).
--    Returns no rows when the balance is insufficient.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_credit(
  p_trainer_id UUID,
  p_credit_type TEXT,
  p_reason TEXT,
  p_scenario_id UUID DEFAULT NULL,
  p_session_id UUID DEFAULT NULL
) RETURNS TABLE (ledger_id UUID, funding_invoice_id UUID) AS $$
DECLARE
  v_balance INT;
  v_invoice_id UUID;
  v_ledger_id UUID;
BEGIN
  -- Serialize spends per trainer + credit type for the rest of this transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_trainer_id::text || ':' || p_credit_type));

  SELECT COALESCE(SUM(delta), 0) INTO v_balance
  FROM credit_ledger
  WHERE trainer_id = p_trainer_id AND credit_type = p_credit_type;

  IF v_balance < 1 THEN
    RETURN; -- no rows => insufficient credits
  END IF;

  -- Oldest paid invoice that still has unspent credits of this type.
  SELECT i.id INTO v_invoice_id
  FROM invoices i
  WHERE i.trainer_id = p_trainer_id
    AND i.status = 'paid'
    AND (
      SELECT COALESCE(SUM(cl.delta), 0)
      FROM credit_ledger cl
      WHERE cl.invoice_id = i.id
        AND cl.trainer_id = p_trainer_id
        AND cl.credit_type = p_credit_type
    ) > 0
  ORDER BY i.paid_at ASC NULLS LAST
  LIMIT 1;

  INSERT INTO credit_ledger (trainer_id, credit_type, delta, reason, invoice_id, scenario_id, session_id)
  VALUES (p_trainer_id, p_credit_type, -1, p_reason, v_invoice_id, p_scenario_id, p_session_id)
  RETURNING id INTO v_ledger_id;

  ledger_id := v_ledger_id;
  funding_invoice_id := v_invoice_id;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Server-only: not callable through Supabase's public RPC surface.
REVOKE EXECUTE ON FUNCTION public.consume_credit(UUID, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consume_credit(UUID, TEXT, TEXT, UUID, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.consume_credit(UUID, TEXT, TEXT, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_credit(UUID, TEXT, TEXT, UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. RLS: service-role only (no policies => anon/authenticated get nothing)
-- ---------------------------------------------------------------------------
ALTER TABLE client_organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
