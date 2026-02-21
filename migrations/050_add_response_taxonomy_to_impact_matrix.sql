-- Checkpoint 6/7: response_taxonomy on session_impact_matrix
-- Per-team status: "textual" (had executed decision in window) or "absent"
ALTER TABLE session_impact_matrix ADD COLUMN IF NOT EXISTS response_taxonomy JSONB DEFAULT NULL;

COMMENT ON COLUMN session_impact_matrix.response_taxonomy IS 'Per-team response status in this window: { "<team_name>": "textual" | "absent" }';
