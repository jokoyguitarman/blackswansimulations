-- Environmental seed variants per scenario (Step 2).
-- Pre-authored routes/areas; at session start the env service loads one variant (e.g. random) into session.current_state.environmental_state.
-- See docs/roadmap/step-02-environmental-state-service.md and docs/SESSION_STATE_SHAPE.md.

CREATE TABLE IF NOT EXISTS scenario_environmental_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  variant_label TEXT NOT NULL,
  seed_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE scenario_environmental_seeds IS 'Pre-authored environmental state variants per scenario. seed_data shape: { routes: [...], areas?: [...] } with route_id/area_id, label, travel_time_minutes?, problem?, active, managed. At session start the env service picks one variant (e.g. random) and writes to session.current_state.environmental_state.';
COMMENT ON COLUMN scenario_environmental_seeds.variant_label IS 'e.g. nicoll_congested, marina_congested, both_clear';
COMMENT ON COLUMN scenario_environmental_seeds.seed_data IS 'JSONB: { routes: [{ route_id, label, travel_time_minutes?, problem?, active, managed }], areas?: [{ area_id, label, problem?, active, managed }] }';

CREATE INDEX IF NOT EXISTS idx_scenario_environmental_seeds_scenario_id ON scenario_environmental_seeds(scenario_id);

CREATE TRIGGER update_scenario_environmental_seeds_updated_at
  BEFORE UPDATE ON scenario_environmental_seeds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (same pattern as scenario_locations)
ALTER TABLE scenario_environmental_seeds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trainers can view environmental seeds for their scenarios"
  ON scenario_environmental_seeds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can create environmental seeds for their scenarios"
  ON scenario_environmental_seeds FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can update environmental seeds for their scenarios"
  ON scenario_environmental_seeds FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can delete environmental seeds for their scenarios"
  ON scenario_environmental_seeds FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );
