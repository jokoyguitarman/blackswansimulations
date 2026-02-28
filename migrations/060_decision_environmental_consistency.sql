-- Add environmental consistency result from Checkpoint 2 (three-checkpoint decision system)
-- Shape: { "consistent": true } or { "consistent": false, "severity": "low"|"medium"|"high", "error_type": "capacity"|"location"|"flow"|"other", "reason": "..." }

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS environmental_consistency JSONB;

COMMENT ON COLUMN decisions.environmental_consistency IS 'Checkpoint 2 result: consistent or inconsistent with scenario environment; used for inject, penalty, and robustness cap';

CREATE INDEX IF NOT EXISTS idx_decisions_environmental_consistency
  ON decisions USING GIN (environmental_consistency);
