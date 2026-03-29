-- Add convergent_crowd to allowed casualty_type values
ALTER TABLE scenario_casualties DROP CONSTRAINT IF EXISTS scenario_casualties_casualty_type_check;
ALTER TABLE scenario_casualties ADD CONSTRAINT scenario_casualties_casualty_type_check
  CHECK (casualty_type IN ('patient', 'crowd', 'evacuee_group', 'convergent_crowd'));
