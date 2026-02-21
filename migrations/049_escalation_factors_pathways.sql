-- 7-Stage Escalation System: escalation factors and pathways (Checkpoint 1)
-- session_escalation_factors: AI-identified escalation factors per evaluation cycle
-- session_escalation_pathways: AI-generated escalation pathways per cycle
-- session_impact_matrix: add analysis and escalation_factors_snapshot for reasoning audit

-- Session escalation factors (Stage 2 output)
CREATE TABLE IF NOT EXISTS session_escalation_factors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  factors JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_session_escalation_factors_session ON session_escalation_factors(session_id);
CREATE INDEX IF NOT EXISTS idx_session_escalation_factors_evaluated_at ON session_escalation_factors(evaluated_at DESC);

COMMENT ON TABLE session_escalation_factors IS 'AI-identified escalation factors per evaluation cycle; factors array: [{id, name, description, severity}]';

-- Session escalation pathways (Stage 3 output)
CREATE TABLE IF NOT EXISTS session_escalation_pathways (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pathways JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_session_escalation_pathways_session ON session_escalation_pathways(session_id);
CREATE INDEX IF NOT EXISTS idx_session_escalation_pathways_evaluated_at ON session_escalation_pathways(evaluated_at DESC);

COMMENT ON TABLE session_escalation_pathways IS 'AI-generated escalation pathways per cycle; pathways array: [{pathway_id, trajectory, trigger_behaviours}]';

-- Extend session_impact_matrix with analysis and factors snapshot
ALTER TABLE session_impact_matrix ADD COLUMN IF NOT EXISTS analysis JSONB DEFAULT NULL;
ALTER TABLE session_impact_matrix ADD COLUMN IF NOT EXISTS escalation_factors_snapshot JSONB DEFAULT NULL;

COMMENT ON COLUMN session_impact_matrix.analysis IS 'AI reasoning for matrix and robustness scores: {overall, matrix_reasoning?, robustness_reasoning?}';
COMMENT ON COLUMN session_impact_matrix.escalation_factors_snapshot IS 'Escalation factors used for this evaluation (denormalized for audit)';
