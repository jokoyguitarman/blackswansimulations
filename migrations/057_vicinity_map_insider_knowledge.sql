-- Migration 057: Vicinity map, scenario geography, and Insider knowledge (unified)
-- Adds scenario geography for OSM/vicinity map, map URLs, and single insider_knowledge JSONB.
-- Optional: session_insider_qa for AAR. Revert with 057_down.

-- Scenario geography (for vicinity map bounds and OSM Overpass queries)
ALTER TABLE scenarios
  ADD COLUMN IF NOT EXISTS center_lat DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS center_lng DECIMAL(11, 8),
  ADD COLUMN IF NOT EXISTS vicinity_radius_meters INT;

-- Map/layout image URLs
ALTER TABLE scenarios
  ADD COLUMN IF NOT EXISTS vicinity_map_url TEXT,
  ADD COLUMN IF NOT EXISTS layout_image_url TEXT;

-- Single blob: layout_ground_truth, osm_vicinity, custom_facts (see docs/SCENARIO_VICINITY_MAP_AND_LAYOUT.md §11)
ALTER TABLE scenarios
  ADD COLUMN IF NOT EXISTS insider_knowledge JSONB;

COMMENT ON COLUMN scenarios.center_lat IS 'Scenario center latitude for vicinity map and OSM queries';
COMMENT ON COLUMN scenarios.center_lng IS 'Scenario center longitude for vicinity map and OSM queries';
COMMENT ON COLUMN scenarios.vicinity_radius_meters IS 'Radius in meters around center for vicinity/OSM';
COMMENT ON COLUMN scenarios.vicinity_map_url IS 'URL of vicinity/site map image';
COMMENT ON COLUMN scenarios.layout_image_url IS 'URL of building layout/blueprint image';
COMMENT ON COLUMN scenarios.insider_knowledge IS 'Structured blob: layout_ground_truth, osm_vicinity (hospitals, police, routes, cctv), custom_facts';

-- Session-level audit: what was asked of the Insider and what category/answer (for AAR)
CREATE TABLE IF NOT EXISTS session_insider_qa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asked_by UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES chat_channels(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  category TEXT CHECK (category IN ('map', 'hospitals', 'police', 'cctv', 'routes', 'layout', 'other')),
  answer_snippet TEXT,
  sources_used TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_insider_qa_session ON session_insider_qa(session_id);
CREATE INDEX IF NOT EXISTS idx_session_insider_qa_asked_by ON session_insider_qa(asked_by);

COMMENT ON TABLE session_insider_qa IS 'Audit log of Insider Q&A per session for AAR awareness/cleverness';
