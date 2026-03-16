-- Add 'specificity_feedback' to the generation_source check constraint
-- so injects from the decision specificity check can be persisted.

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
      'specificity_feedback'
    ));
