-- Migration 180: Add stud_id column to scenario_hazards for explicit
-- stud tracking on fire-spread spawn pins.

ALTER TABLE scenario_hazards
  ADD COLUMN IF NOT EXISTS stud_id TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_hazards_stud_id
  ON scenario_hazards(stud_id) WHERE stud_id IS NOT NULL;
