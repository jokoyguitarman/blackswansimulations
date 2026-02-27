-- Allow gate-only injects (no time or decision trigger)
-- Gate punishment/success/vague injects are published by the gate engine, not the scheduler.
-- They have trigger_time_minutes = NULL and no trigger_condition; check_trigger_specified blocked them.

ALTER TABLE scenario_injects
  DROP CONSTRAINT IF EXISTS check_trigger_specified;
