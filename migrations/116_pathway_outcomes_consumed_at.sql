-- Add consumed_at column to session_pathway_outcomes so per-decision pathway
-- outcome selection can mark a row as used, preventing duplicate publishes.
ALTER TABLE session_pathway_outcomes
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ DEFAULT NULL;
