-- Migration 215: Record which admin brought each trainer in
--
-- Admin is one global role, so every admin sees every trainer. Nothing recorded which admin
-- enrolled a trainer, or approved their consultant application, so the Business console could
-- not say. The server now writes these columns when an admin enrolls a trainer or approves an
-- application, and the console shows them.
--
-- They live on trainer_billing, not user_profiles, on purpose: an account owner can update their
-- own user_profiles row through the anon key (migration 189 only guards role and agency), so a
-- field there could be rewritten by the trainer it describes. trainer_billing is service-role
-- only (RLS on, no policies).
--
-- Trainers who became trainers before this migration have no record (NULL) and show as "not
-- recorded". ON DELETE SET NULL keeps the row if the admin's account is later removed.

ALTER TABLE trainer_billing
  ADD COLUMN IF NOT EXISTS enrolled_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enrolled_via TEXT CHECK (enrolled_via IN ('admin_enrollment', 'application')),
  ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;

COMMENT ON COLUMN trainer_billing.enrolled_by IS 'Admin who enrolled the trainer or approved their application. NULL: not recorded, or that admin no longer exists.';
COMMENT ON COLUMN trainer_billing.enrolled_via IS 'admin_enrollment: created from the Business console. application: a consultant application was approved. NULL: not recorded.';

-- Approved consultant applications already carry their approver; copy it across (idempotent).
UPDATE trainer_billing tb
SET enrolled_by = ta.reviewed_by,
    enrolled_via = 'application',
    enrolled_at = ta.reviewed_at
FROM (
  SELECT DISTINCT ON (user_id) user_id, reviewed_by, reviewed_at
  FROM trainer_agreements
  WHERE purpose = 'application' AND status = 'approved'
  ORDER BY user_id, reviewed_at DESC
) ta
WHERE ta.user_id = tb.trainer_id
  AND tb.enrolled_via IS NULL;
