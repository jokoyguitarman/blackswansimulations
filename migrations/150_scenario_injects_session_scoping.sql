-- Add session_id to scenario_injects so runtime-generated injects are session-scoped.
-- Template injects (war_room, migration, trainer) have session_id = NULL.
-- Runtime injects (deterioration_cycle, sentiment_positive, adversary_adaptation) carry
-- a session_id so they don't pollute the scenario template.

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_scenario_injects_session_id
  ON scenario_injects(session_id)
  WHERE session_id IS NOT NULL;

-- Extend generation_source CHECK to include runtime sources
ALTER TABLE scenario_injects
  DROP CONSTRAINT IF EXISTS scenario_injects_generation_source_check;

ALTER TABLE scenario_injects
  ADD CONSTRAINT scenario_injects_generation_source_check
    CHECK (generation_source IN (
      'migration',
      'war_room',
      'trainer',
      'pathway_outcome',
      'inaction_penalty',
      'decision_response',
      'matrix_friction',
      'specificity_feedback',
      'adversary_adaptation',
      'pursuit_branch',
      'witness_relay',
      'deterioration_cycle',
      'sentiment_positive'
    ));

-- Clean up existing runtime-generated injects that polluted scenarios.
-- These have no session_id (column just added) but can be identified by generation_source.
-- Safest approach: delete them since they are session-ephemeral data.
DELETE FROM scenario_injects
  WHERE generation_source IN ('deterioration_cycle', 'sentiment_positive');
