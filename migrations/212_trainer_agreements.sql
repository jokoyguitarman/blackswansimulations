-- Migration 212: Consultant Agreements and trainer applications
--
-- Trainer access is no longer self-service. A participant applies by signing the Prophyion
-- Consultant Agreement: the platform issues it pre-filled with their details and a reference
-- number, they upload the signed PDF, and an admin's approval grants the trainer role. Trainers
-- who already have access file their signed agreement the same way, without a role change.
--
-- SECURITY: accessed only through the server's service-role client. RLS is enabled with no
-- anon/authenticated policies, and the storage bucket is private with no storage.objects
-- policies, so signed agreements are reachable only through short-lived signed URLs the server
-- issues.

CREATE TABLE IF NOT EXISTS trainer_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  -- 'application': a participant asking to become a trainer (approval promotes them).
  -- 'existing_trainer': a trainer filing their signed agreement.
  purpose TEXT NOT NULL CHECK (purpose IN ('application', 'existing_trainer')),
  status TEXT NOT NULL DEFAULT 'awaiting_signature' CHECK (status IN (
    'awaiting_signature',
    'submitted',
    'changes_requested',
    'approved',
    'rejected'
  )),
  agreement_version TEXT NOT NULL,
  -- Printed on every page of the issued agreement, e.g. 'PCA-7F3K2Q9M'.
  reference TEXT NOT NULL UNIQUE,

  -- What was printed on the agreement when it was issued.
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact_number TEXT,
  address TEXT,
  organisation TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_pdf_sha256 TEXT,

  -- The signed copy.
  signed_file_path TEXT,
  signed_file_sha256 TEXT,
  signed_file_pages INT,
  -- NULL when the upload has no text layer (a scan) or was attached by an admin.
  signed_file_has_reference BOOLEAN,
  submitted_at TIMESTAMPTZ,
  -- Set when an admin attached a copy signed outside the platform.
  attached_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,

  reviewed_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  -- Shown to the applicant with a decision.
  review_note TEXT,
  decision_emailed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one agreement in progress per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trainer_agreements_one_open
  ON trainer_agreements (user_id)
  WHERE status IN ('awaiting_signature', 'submitted', 'changes_requested');

CREATE INDEX IF NOT EXISTS idx_trainer_agreements_status
  ON trainer_agreements (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_trainer_agreements_user
  ON trainer_agreements (user_id, created_at DESC);

ALTER TABLE trainer_agreements ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE trainer_agreements IS
  'Signed Prophyion Consultant Agreements: trainer applications and agreements filed by existing trainers.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('trainer-agreements', 'trainer-agreements', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;
