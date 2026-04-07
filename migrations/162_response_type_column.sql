-- Add response_type column to scenario_injects and incidents.
-- Drives the Media Editorial Review system: injects tagged 'media_statement'
-- route player responses through the Senior Editor AI evaluator and show
-- a structured script editor on the frontend.

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS response_type TEXT DEFAULT 'standard';

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS response_type TEXT DEFAULT 'standard';

-- Extend generation_source CHECK to include 'protocol_violation' and 'editorial_feedback'
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
      'sentiment_positive',
      'protocol_violation',
      'editorial_feedback'
    ));
