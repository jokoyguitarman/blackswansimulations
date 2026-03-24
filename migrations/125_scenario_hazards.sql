-- Phase 4: Interactive Hazard Assessment — scenario_hazards table
-- Hazard icons on the map that players click to assess and respond to.

CREATE TABLE IF NOT EXISTS scenario_hazards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  -- nullable: scenario-level hazards appear in all sessions; session-level hazards are injected mid-game
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  hazard_type TEXT NOT NULL,
  location_lat DECIMAL(10,8) NOT NULL,
  location_lng DECIMAL(11,8) NOT NULL,
  floor_level TEXT DEFAULT 'G',
  -- Flexible properties: fire_class, size, fuel_source, adjacent_risks, wind_exposure, etc.
  properties JSONB NOT NULL DEFAULT '{}',
  -- Criteria the AI uses to evaluate player responses to this hazard
  assessment_criteria JSONB NOT NULL DEFAULT '[]',
  -- Static image URL for the hazard visual
  image_url TEXT,
  -- Time-evolving image sequence: [{at_minutes, image_url, description}]
  image_sequence JSONB,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'escalating', 'contained', 'resolved')),
  -- Minutes after session start when this hazard becomes visible
  appears_at_minutes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenario_hazards_scenario ON scenario_hazards(scenario_id);
CREATE INDEX IF NOT EXISTS idx_scenario_hazards_session ON scenario_hazards(session_id);
