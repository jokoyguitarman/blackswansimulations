-- Phase 5: Multi-Floor Maps — scenario_floor_plans table
-- Stores per-floor layout data for multi-storey buildings.

CREATE TABLE IF NOT EXISTS scenario_floor_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  floor_level TEXT NOT NULL,
  floor_label TEXT NOT NULL,
  -- SVG plan (inline or template reference)
  plan_svg TEXT,
  -- External image URL for the floor plan
  plan_image_url TEXT,
  -- GeoJSON bounding box to overlay on Leaflet
  bounds JSONB,
  -- Semantic features: [{id, type, label, geometry, properties}]
  features JSONB NOT NULL DEFAULT '[]',
  -- Per-floor environmental factors
  environmental_factors JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenario_floor_plans_scenario ON scenario_floor_plans(scenario_id);
