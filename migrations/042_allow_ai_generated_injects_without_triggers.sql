-- Allow AI-generated injects to have both triggers null
-- These injects are created and published immediately, so they don't need triggers

-- Drop the old constraint
ALTER TABLE scenario_injects
  DROP CONSTRAINT IF EXISTS check_trigger_specified;

-- Add new constraint that allows ai_generated injects to have both triggers null
ALTER TABLE scenario_injects
  ADD CONSTRAINT check_trigger_specified 
  CHECK (
    trigger_time_minutes IS NOT NULL OR 
    trigger_condition IS NOT NULL OR
    ai_generated = true
  );

