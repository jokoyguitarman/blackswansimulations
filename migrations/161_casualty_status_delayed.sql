-- Add 'delayed' to scenario_casualties status constraint so spawn pins
-- (which appear only when a parent hazard is unresolved) can be inserted.
-- Mirrors the same addition made for scenario_hazards in migration 139.
ALTER TABLE scenario_casualties DROP CONSTRAINT IF EXISTS scenario_casualties_status_check;
ALTER TABLE scenario_casualties ADD CONSTRAINT scenario_casualties_status_check
  CHECK (status IN (
    'undiscovered','identified','delayed',
    'being_moved','being_evacuated',
    'awaiting_triage','at_assembly','at_exit',
    'endorsed_to_triage','in_treatment','endorsed_to_transport',
    'transported','resolved','deceased'
  ));
