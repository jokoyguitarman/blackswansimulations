-- Enquiries from the public marketing pages.
--
-- The scoping-call form previously posted to an endpoint that did not exist, so
-- every submission was lost. This table is the record of truth: the notification
-- email is a convenience, and a failure to send it must never lose the enquiry.

CREATE TABLE IF NOT EXISTS enquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation TEXT NOT NULL,
  sector TEXT,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  team_size TEXT,
  message TEXT,
  -- Which page the form was submitted from, so we can tell the corporate and
  -- consultant funnels apart.
  source TEXT,
  -- Kept for abuse triage only.
  ip_hash TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'closed', 'spam')),
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enquiries_created_at ON enquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries (status);

-- Enquiries are written by the server with the service-role key and read only by
-- staff tooling, so no anon or authenticated policy is granted.
ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE enquiries IS 'Scoping-call enquiries submitted from the public marketing pages.';
COMMENT ON COLUMN enquiries.source IS 'Path the form was submitted from, e.g. /simulations or /simulations/consultants.';
COMMENT ON COLUMN enquiries.ip_hash IS 'Salted hash of the submitter IP, retained for abuse triage rather than identification.';
