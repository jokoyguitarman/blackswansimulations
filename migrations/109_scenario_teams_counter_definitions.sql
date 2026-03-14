-- Add counter_definitions JSONB column to scenario_teams.
-- Stores per-team counter schemas with behavior rules so the game engine
-- can run scenario-specific counters instead of hardcoded per-archetype defaults.
-- NULL means "use legacy hardcoded defaults" for backward compatibility.

ALTER TABLE scenario_teams
  ADD COLUMN IF NOT EXISTS counter_definitions JSONB DEFAULT NULL;

COMMENT ON COLUMN scenario_teams.counter_definitions IS
  'Array of CounterDefinition objects: [{key, label, type, initial_value, behavior, visible_to, config}]. NULL = legacy defaults.';
