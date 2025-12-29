-- Migration 037: Add auto_complete_on_objectives flag to sessions table
-- Allows sessions to automatically complete when all objectives are resolved (completed or failed)

-- Add column with default false (opt-in feature)
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS auto_complete_on_objectives BOOLEAN NOT NULL DEFAULT false;

-- Add comment explaining the feature
COMMENT ON COLUMN sessions.auto_complete_on_objectives IS 'If true, session will automatically complete when all objectives are resolved (completed or failed). Default is false to maintain trainer control.';

