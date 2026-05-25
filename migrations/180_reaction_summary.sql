-- Migration 180: Add reaction_summary to social_posts for pre-generated reaction type distribution
BEGIN;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS reaction_summary JSONB DEFAULT '[]';
COMMIT;
