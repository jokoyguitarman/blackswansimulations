-- Adversary pursuit system: add pin_category and visible_to_teams to scenario_locations,
-- and extend generation_source for pursuit-related injects.

-- 1. Promote pin_category from conditions JSONB to a proper column
ALTER TABLE scenario_locations
  ADD COLUMN IF NOT EXISTS pin_category TEXT;

UPDATE scenario_locations
  SET pin_category = conditions->>'pin_category'
  WHERE conditions->>'pin_category' IS NOT NULL
    AND pin_category IS NULL;

-- 2. Team-scoped pin visibility (NULL = visible to all)
ALTER TABLE scenario_locations
  ADD COLUMN IF NOT EXISTS visible_to_teams TEXT[];

-- 3. Extend generation_source CHECK to include pursuit-related sources
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
      'witness_relay'
    ));
