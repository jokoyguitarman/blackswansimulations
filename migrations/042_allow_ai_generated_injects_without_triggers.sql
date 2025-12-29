-- Allow AI-generated injects to have both triggers null
-- These injects are created and published immediately, so they don't need triggers

-- Drop the old constraint
ALTER TABLE scenario_injects
  DROP CONSTRAINT IF EXISTS check_trigger_specified;

-- Add new constraint that allows ai_generated injects to have both triggers null
-- Using IS TRUE for better NULL handling
ALTER TABLE scenario_injects
  ADD CONSTRAINT check_trigger_specified 
  CHECK (
    trigger_time_minutes IS NOT NULL OR 
    trigger_condition IS NOT NULL OR
    (ai_generated IS TRUE)
  );

-- Verify the constraint was created
SELECT 
  conname as constraint_name,
  pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'scenario_injects'::regclass
  AND conname = 'check_trigger_specified';

