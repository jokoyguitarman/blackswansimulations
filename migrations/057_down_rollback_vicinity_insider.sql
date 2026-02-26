-- Rollback 057: Vicinity map, scenario geography, and Insider knowledge
-- Drops session_insider_qa and scenario columns added in 057.

DROP TABLE IF EXISTS session_insider_qa;

ALTER TABLE scenarios
  DROP COLUMN IF EXISTS center_lat,
  DROP COLUMN IF EXISTS center_lng,
  DROP COLUMN IF EXISTS vicinity_radius_meters,
  DROP COLUMN IF EXISTS vicinity_map_url,
  DROP COLUMN IF EXISTS layout_image_url,
  DROP COLUMN IF EXISTS insider_knowledge;
