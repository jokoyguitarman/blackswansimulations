-- Phase 3: Drag-and-Drop Placement — placed_assets table
-- Stores assets that players drag onto the map during a session.

CREATE TABLE IF NOT EXISTS placed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  placed_by UUID NOT NULL REFERENCES user_profiles(id),
  asset_type TEXT NOT NULL,
  label TEXT,
  -- GeoJSON geometry: Point for markers, Polygon for area assets, LineString for barriers
  geometry JSONB NOT NULL DEFAULT '{}',
  -- Flexible properties: capacity, resource_count, setup_time_minutes, floor_level, etc.
  properties JSONB NOT NULL DEFAULT '{}',
  -- Spatial scoring result set by the server after validation
  placement_score JSONB,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'relocated', 'removed')),
  -- Optional link back to the auto-created text decision
  linked_decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_placed_assets_session ON placed_assets(session_id);
CREATE INDEX IF NOT EXISTS idx_placed_assets_session_team ON placed_assets(session_id, team_name);
CREATE INDEX IF NOT EXISTS idx_placed_assets_session_status ON placed_assets(session_id, status);
