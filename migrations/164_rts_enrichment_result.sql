-- Migration 164: Add enrichment_result column to rts_scene_configs
-- Stores the AI enrichment output so it persists across sessions

ALTER TABLE rts_scene_configs
ADD COLUMN IF NOT EXISTS enrichment_result JSONB DEFAULT NULL;
