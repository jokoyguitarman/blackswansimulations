-- Add ON DELETE CASCADE to sessions.scenario_id so deleting a scenario
-- also removes all related sessions (and their cascaded children).

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_scenario_id_fkey,
  ADD CONSTRAINT sessions_scenario_id_fkey
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE;
