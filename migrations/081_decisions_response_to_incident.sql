-- Add response_to_incident_id to decisions so each decision can be linked to the incident it responds to.
-- Used for incident-linked decision flow and AI grading (incident + Insider context).

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS response_to_incident_id UUID REFERENCES incidents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_decisions_response_to_incident_id
  ON decisions(response_to_incident_id)
  WHERE response_to_incident_id IS NOT NULL;

COMMENT ON COLUMN decisions.response_to_incident_id IS 'Incident this decision was created in response to (when created via Decision button on incident card). Used for gate scope and quality grading.';
