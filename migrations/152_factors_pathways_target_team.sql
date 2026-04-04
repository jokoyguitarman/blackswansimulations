-- Add target_team to escalation factors and pathways tables
-- so the trainer view can show which team each computation is for.

ALTER TABLE session_escalation_factors
  ADD COLUMN IF NOT EXISTS target_team TEXT DEFAULT NULL;

ALTER TABLE session_escalation_pathways
  ADD COLUMN IF NOT EXISTS target_team TEXT DEFAULT NULL;

COMMENT ON COLUMN session_escalation_factors.target_team IS 'Team name this factors row was generated for (NULL for universal/legacy)';
COMMENT ON COLUMN session_escalation_pathways.target_team IS 'Team name this pathways row was generated for (NULL for universal/legacy)';
