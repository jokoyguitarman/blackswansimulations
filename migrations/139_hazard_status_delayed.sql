-- Add delayed to allowed hazard status values (for hazards that appear later)
ALTER TABLE scenario_hazards DROP CONSTRAINT IF EXISTS scenario_hazards_status_check;
ALTER TABLE scenario_hazards ADD CONSTRAINT scenario_hazards_status_check
  CHECK (status IN ('active', 'escalating', 'contained', 'resolved', 'delayed'));
