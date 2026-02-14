-- Inter-team impact matrix: AI-scored impact of each team's decisions on other teams (e.g. every 5 min)
-- matrix: { "<acting_team>": { "<affected_team>": number, ... }, ... }
-- robustness_by_decision: optional { "<decision_id>": 1-10, ... }
CREATE TABLE IF NOT EXISTS session_impact_matrix (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matrix JSONB NOT NULL DEFAULT '{}'::jsonb,
  robustness_by_decision JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_session_impact_matrix_session ON session_impact_matrix(session_id);
CREATE INDEX IF NOT EXISTS idx_session_impact_matrix_evaluated_at ON session_impact_matrix(evaluated_at DESC);

COMMENT ON TABLE session_impact_matrix IS 'AI-computed inter-team impact and optional per-decision robustness; one row per evaluation window (e.g. every 5 min)';
