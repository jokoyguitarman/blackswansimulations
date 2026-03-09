-- Add requires_response to incidents so status-update injects can be shown without a decision button.
-- When true (default), the incident shows [DECISION]; when false, it is read-only (status update).
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS requires_response BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN incidents.requires_response IS 'If false, incident is informational only (no decision button). Set from scenario_injects.requires_response when created from inject.';
