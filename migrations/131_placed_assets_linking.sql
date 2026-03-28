-- Link placed assets (personnel, equipment) to specific hazard or casualty pins
ALTER TABLE placed_assets
  ADD COLUMN IF NOT EXISTS linked_hazard_id UUID REFERENCES scenario_hazards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_casualty_id UUID REFERENCES scenario_casualties(id) ON DELETE SET NULL;
