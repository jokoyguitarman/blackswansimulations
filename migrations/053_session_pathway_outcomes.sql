-- Pathway outcomes on inject publish: store pre-generated outcome injects per published inject
-- Each row = one run after an inject was published; outcomes[] holds inject payloads for low/medium/high robustness bands

CREATE TABLE IF NOT EXISTS session_pathway_outcomes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trigger_inject_id UUID NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  factors_snapshot JSONB DEFAULT NULL,
  pathways_snapshot JSONB DEFAULT NULL,
  outcomes JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_session_pathway_outcomes_session ON session_pathway_outcomes(session_id);
CREATE INDEX IF NOT EXISTS idx_session_pathway_outcomes_evaluated_at ON session_pathway_outcomes(evaluated_at DESC);

COMMENT ON TABLE session_pathway_outcomes IS 'Pre-generated pathway outcome injects per published inject; outcomes array: [{outcome_id, pathway_id, direction, robustness_band, inject_payload}]';
COMMENT ON COLUMN session_pathway_outcomes.trigger_inject_id IS 'scenario_injects.id of the inject that was just published when this run executed';
COMMENT ON COLUMN session_pathway_outcomes.factors_snapshot IS 'Escalation + de-escalation factors used for this run (audit)';
COMMENT ON COLUMN session_pathway_outcomes.pathways_snapshot IS 'Escalation + de-escalation pathways used (audit)';
COMMENT ON COLUMN session_pathway_outcomes.outcomes IS 'Array of {outcome_id, pathway_id, direction, robustness_band, inject_payload} for cycle to match and publish';
