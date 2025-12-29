-- Allow trigger_time_minutes to be NULL for decision-based injects
-- Decision-based injects don't have a time trigger, only condition-based triggers

ALTER TABLE scenario_injects 
  ALTER COLUMN trigger_time_minutes DROP NOT NULL;

-- Add check constraint to ensure at least one trigger is specified
ALTER TABLE scenario_injects
  ADD CONSTRAINT check_trigger_specified 
  CHECK (
    trigger_time_minutes IS NOT NULL OR 
    trigger_condition IS NOT NULL
  );

