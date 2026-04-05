-- Expand the status CHECK to include all statuses used by the unified pipeline.
-- being_evacuated is retained for backward compatibility with existing rows;
-- new code uses being_moved.
ALTER TABLE scenario_casualties DROP CONSTRAINT IF EXISTS scenario_casualties_status_check;
ALTER TABLE scenario_casualties ADD CONSTRAINT scenario_casualties_status_check
  CHECK (status IN (
    'undiscovered','identified',
    'being_moved','being_evacuated',
    'awaiting_triage','at_assembly','at_exit',
    'endorsed_to_triage','in_treatment','endorsed_to_transport',
    'transported','resolved','deceased'
  ));
