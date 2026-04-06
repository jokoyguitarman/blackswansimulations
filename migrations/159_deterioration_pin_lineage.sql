-- Migration 159: Add parent_pin_id and spawn_condition columns for
-- pre-generated deterioration child pins.

ALTER TABLE scenario_hazards
  ADD COLUMN IF NOT EXISTS parent_pin_id UUID REFERENCES scenario_hazards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spawn_condition JSONB DEFAULT NULL;

ALTER TABLE scenario_casualties
  ADD COLUMN IF NOT EXISTS parent_pin_id UUID REFERENCES scenario_hazards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spawn_condition JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_hazards_parent_pin
  ON scenario_hazards(parent_pin_id) WHERE parent_pin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_casualties_parent_pin
  ON scenario_casualties(parent_pin_id) WHERE parent_pin_id IS NOT NULL;
