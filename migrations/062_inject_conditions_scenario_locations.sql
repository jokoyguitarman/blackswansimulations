-- Step 1: Condition-based injects and scenario locations (map pins)
-- Adds: scenario_injects condition/eligibility columns, scenario_locations table, session state shape doc.
-- See docs/roadmap/step-01-database.md and docs/GAME_SPECIFICS_AND_LOCATIONS.md.

-- ============================================
-- PART 1: scenario_injects — condition-based firing and eligibility
-- ============================================

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS conditions_to_appear JSONB,
  ADD COLUMN IF NOT EXISTS conditions_to_cancel JSONB,
  ADD COLUMN IF NOT EXISTS eligible_after_minutes INTEGER;

COMMENT ON COLUMN scenario_injects.conditions_to_appear IS 'Condition manifest for "perfect storm": inject is considered only when these conditions are met. Format scenario-defined (e.g. list of condition keys or N-of-M).';
COMMENT ON COLUMN scenario_injects.conditions_to_cancel IS 'When these conditions are met, the inject is cancelled (not fired or withdrawn).';
COMMENT ON COLUMN scenario_injects.eligible_after_minutes IS 'Earliest session minute when this inject can be evaluated. NULL = no eligibility delay (e.g. Type B direct consequence).';

-- ============================================
-- PART 2: scenario_locations (map pins per scenario)
-- ============================================

CREATE TABLE IF NOT EXISTS scenario_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  location_type TEXT NOT NULL,
  label TEXT NOT NULL,
  coordinates JSONB NOT NULL DEFAULT '{}'::jsonb,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE scenario_locations IS 'Map pins per scenario: blast_site, exit, triage_site, cordon, pathway, parking. Same structure for all scenarios; data varies per scenario.';
COMMENT ON COLUMN scenario_locations.location_type IS 'e.g. blast_site, exit, triage_site, cordon, pathway, parking';
COMMENT ON COLUMN scenario_locations.coordinates IS 'e.g. { "lat": number, "lng": number } or GeoJSON';
COMMENT ON COLUMN scenario_locations.conditions IS 'Per-location conditions: suitability, construction_nearby, terrain, crowd_density, capacity, etc.';

CREATE INDEX IF NOT EXISTS idx_scenario_locations_scenario_id ON scenario_locations(scenario_id);
CREATE INDEX IF NOT EXISTS idx_scenario_locations_location_type ON scenario_locations(scenario_id, location_type);

-- updated_at trigger
CREATE TRIGGER update_scenario_locations_updated_at
  BEFORE UPDATE ON scenario_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- PART 3: RLS for scenario_locations
-- ============================================

ALTER TABLE scenario_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trainers can view locations for their scenarios"
  ON scenario_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_locations.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can create locations for their scenarios"
  ON scenario_locations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_locations.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can update locations for their scenarios"
  ON scenario_locations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_locations.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can delete locations for their scenarios"
  ON scenario_locations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_locations.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

-- ============================================
-- PART 4: Session state shape (documentation)
-- ============================================
-- environmental_state lives under sessions.current_state. Suggested shape:
--   current_state.environmental_state: {
--     routes: [ { route_id, label, travel_time_minutes, problem?, active, managed } ],
--     areas?: [ { area_id, label, problem?, active, managed } ]
--   }
--   current_state.location_state?: { [location_id]: { managed, active } }  -- optional per-pin state
-- See docs/INJECT_ENGINE_DEVELOPMENT_PLAN.md and docs/GAME_SPECIFICS_AND_LOCATIONS.md.

COMMENT ON COLUMN sessions.current_state IS 'JSONB. May include environmental_state (routes/areas with problem, active, managed), location_state (per scenario_location managed/active), plus existing evacuation_zones, resource_allocations, public_sentiment, etc.';
