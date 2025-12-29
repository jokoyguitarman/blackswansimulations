-- Cleanup Orphaned Decisions (Decisions without decision_steps)
-- These are decisions created before the fix that properly sets user_id in decision_steps
-- Since we cannot recover the original approvers, we clean up decisions that cannot function

-- First, let's see what we're cleaning up (for reference)
DO $$
DECLARE
  orphaned_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphaned_count
  FROM decisions d
  WHERE NOT EXISTS (
    SELECT 1 FROM decision_steps ds WHERE ds.decision_id = d.id
  )
  AND d.status = 'proposed';

  RAISE NOTICE 'Found % orphaned decisions (decisions with no steps in proposed status)', orphaned_count;
END $$;

-- Delete orphaned decisions that have no steps and are still in proposed status
-- These decisions cannot function without approval steps, so they are cleaned up
DELETE FROM decisions
WHERE id IN (
  SELECT d.id
  FROM decisions d
  WHERE NOT EXISTS (
    SELECT 1 FROM decision_steps ds WHERE ds.decision_id = d.id
  )
  AND d.status = 'proposed'
);

-- Log the cleanup (optional - you can check the count before/after)
-- Note: Decisions in other statuses (approved, rejected, executed) are kept
-- even if they have no steps, as they may have historical value

