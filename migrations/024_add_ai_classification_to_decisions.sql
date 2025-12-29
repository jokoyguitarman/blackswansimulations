-- Add AI classification column to decisions table
-- Make type nullable since AI will populate it on execution

ALTER TABLE decisions 
  ADD COLUMN IF NOT EXISTS ai_classification JSONB;

-- Make type nullable to allow AI to populate it
ALTER TABLE decisions 
  ALTER COLUMN type DROP NOT NULL;

-- Add index for querying decisions by AI classification
CREATE INDEX IF NOT EXISTS idx_decisions_ai_classification 
  ON decisions USING GIN (ai_classification);

