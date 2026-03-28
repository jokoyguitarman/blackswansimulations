-- Enrich scenario_hazards with deep-research columns
ALTER TABLE scenario_hazards
  ADD COLUMN IF NOT EXISTS resolution_requirements JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS personnel_requirements JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS equipment_requirements JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS deterioration_timeline JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS enriched_description TEXT,
  ADD COLUMN IF NOT EXISTS fire_class TEXT,
  ADD COLUMN IF NOT EXISTS debris_type TEXT;
