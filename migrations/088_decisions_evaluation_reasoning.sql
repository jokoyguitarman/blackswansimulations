-- Store AI reasoning for gate content and env prerequisite checks (for AAR and trainer visibility).
ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS evaluation_reasoning JSONB;

COMMENT ON COLUMN decisions.evaluation_reasoning IS 'gate_content: reason from gate content (vague vs concrete) check; env_prerequisite: reason from environmental prerequisite (location/route) check.';
