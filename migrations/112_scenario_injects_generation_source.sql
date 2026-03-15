-- Add generation_source column to scenario_injects so every inject is traceable
-- to the mechanism that created it. DEFAULT 'migration' auto-tags all existing
-- (hand-crafted SQL) injects without a backfill step.

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS generation_source TEXT
    DEFAULT 'migration'
    CHECK (generation_source IN (
      'migration',
      'war_room',
      'trainer',
      'pathway_outcome',
      'inaction_penalty',
      'decision_response'
    ));
