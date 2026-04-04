-- Add trigger_inject_id to escalation factors and pathways tables
-- so the trainer view can display which inject triggered each computation.

ALTER TABLE session_escalation_factors
  ADD COLUMN IF NOT EXISTS trigger_inject_id UUID DEFAULT NULL;

ALTER TABLE session_escalation_pathways
  ADD COLUMN IF NOT EXISTS trigger_inject_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_sef_trigger_inject ON session_escalation_factors(trigger_inject_id);
CREATE INDEX IF NOT EXISTS idx_sep_trigger_inject ON session_escalation_pathways(trigger_inject_id);

COMMENT ON COLUMN session_escalation_factors.trigger_inject_id IS 'scenario_injects.id that triggered this factors computation (NULL for legacy or manual runs)';
COMMENT ON COLUMN session_escalation_pathways.trigger_inject_id IS 'scenario_injects.id that triggered this pathways computation (NULL for legacy or manual runs)';
