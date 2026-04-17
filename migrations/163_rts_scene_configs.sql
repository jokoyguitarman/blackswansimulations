-- Migration 163: RTS scene configurations for crisis simulation prototype
-- Stores building geometry, exits, hazards, casualties, planted threats, and
-- cached image URLs for the RTS simulation. One scene config per scenario,
-- reusable across sessions.

-- Scene config table
CREATE TABLE IF NOT EXISTS rts_scene_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID REFERENCES scenarios(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled Scene',

  -- Building geometry
  building_polygon JSONB NOT NULL,
  building_name TEXT,
  center_lat DECIMAL(10, 8),
  center_lng DECIMAL(11, 8),

  -- Scene elements
  exits JSONB DEFAULT '[]'::jsonb,
  interior_walls JSONB DEFAULT '[]'::jsonb,
  hazard_zones JSONB DEFAULT '[]'::jsonb,
  stairwells JSONB DEFAULT '[]'::jsonb,
  blast_site JSONB DEFAULT NULL,
  casualty_clusters JSONB DEFAULT '[]'::jsonb,
  planted_items JSONB DEFAULT '[]'::jsonb,
  wall_inspection_points JSONB DEFAULT '[]'::jsonb,

  -- Cached image URLs (wallPointId/casualtyId -> storage URL)
  wall_photo_urls JSONB DEFAULT '{}'::jsonb,
  casualty_image_urls JSONB DEFAULT '{}'::jsonb,

  -- Config
  pedestrian_count INT DEFAULT 120,

  -- Metadata
  created_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rts_scene_configs_scenario
  ON rts_scene_configs(scenario_id);

CREATE INDEX IF NOT EXISTS idx_rts_scene_configs_created_by
  ON rts_scene_configs(created_by);

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION set_rts_scene_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rts_scene_configs_updated_at ON rts_scene_configs;
CREATE TRIGGER trg_rts_scene_configs_updated_at
BEFORE UPDATE ON rts_scene_configs
FOR EACH ROW EXECUTE PROCEDURE set_rts_scene_configs_updated_at();

-- Link wizard drafts to scene configs
ALTER TABLE warroom_wizard_drafts
  ADD COLUMN IF NOT EXISTS rts_scene_id UUID REFERENCES rts_scene_configs(id) ON DELETE SET NULL;

-- Storage bucket for RTS scene images (Street View cache, trainer photos, DALL-E images)
INSERT INTO storage.buckets (id, name, public)
VALUES ('rts-scene-images', 'rts-scene-images', true)
ON CONFLICT (id) DO NOTHING;

-- RLS: trainers and admins can manage scene configs; participants can read
ALTER TABLE rts_scene_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY rts_scene_configs_select ON rts_scene_configs
  FOR SELECT USING (true);

CREATE POLICY rts_scene_configs_insert ON rts_scene_configs
  FOR INSERT WITH CHECK (
    created_by = auth.uid()
  );

CREATE POLICY rts_scene_configs_update ON rts_scene_configs
  FOR UPDATE USING (
    created_by = auth.uid()
  );

CREATE POLICY rts_scene_configs_delete ON rts_scene_configs
  FOR DELETE USING (
    created_by = auth.uid()
  );
