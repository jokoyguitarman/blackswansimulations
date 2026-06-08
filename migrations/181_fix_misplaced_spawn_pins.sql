-- Migration 181: Fix misplaced hazard and casualty spawn pins.
--
-- Problem: spawn pins from the old deterioration system were placed at
-- random hot-zone coordinates or AI-guessed offsets, often landing far
-- from the building. Some pins have near-zero coordinates (0,0 region)
-- because the parent hazard had no valid coordinates.
--
-- Fix:
--   1. Delete unsalvageable pins with coordinates near (0,0)
--   2. Relocate orphaned spawn pins (spawned_from but no parent_pin_id)
--      to their source hazard's coordinates
--   3. Relocate delayed child pins (parent_pin_id set) that are far from
--      their parent back to the parent's coordinates

-- Step 1: Delete spawn hazard pins with near-zero coordinates (Gulf of Guinea)
-- These were created when parent hazard coordinates were missing (defaulted to 0,0)
DELETE FROM scenario_hazards
WHERE (properties->>'spawned_from' IS NOT NULL OR parent_pin_id IS NOT NULL)
  AND ABS(location_lat) < 1.0
  AND ABS(location_lng) < 1.0;

-- Step 2: Delete spawn casualty pins with near-zero coordinates
DELETE FROM scenario_casualties
WHERE parent_pin_id IS NOT NULL
  AND ABS(location_lat) < 1.0
  AND ABS(location_lng) < 1.0;

-- Step 3: Relocate orphaned runtime-spawned hazard pins to their source hazard
-- These have properties.spawned_from but no parent_pin_id
UPDATE scenario_hazards child
SET location_lat = parent.location_lat,
    location_lng = parent.location_lng,
    floor_level = COALESCE(parent.floor_level, child.floor_level)
FROM scenario_hazards parent
WHERE child.properties->>'spawned_from' IS NOT NULL
  AND child.parent_pin_id IS NULL
  AND parent.id = (child.properties->>'spawned_from')::uuid
  AND (
    ABS(child.location_lat - parent.location_lat) > 0.002
    OR ABS(child.location_lng - parent.location_lng) > 0.002
  );

-- Step 4: Relocate delayed child hazard pins that are far from their parent
-- These have parent_pin_id set but AI offsets placed them too far away
UPDATE scenario_hazards child
SET location_lat = parent.location_lat,
    location_lng = parent.location_lng
FROM scenario_hazards parent
WHERE child.parent_pin_id IS NOT NULL
  AND child.parent_pin_id = parent.id
  AND child.status = 'delayed'
  AND (
    ABS(child.location_lat - parent.location_lat) > 0.002
    OR ABS(child.location_lng - parent.location_lng) > 0.002
  );

-- Step 5: Relocate delayed child casualty pins that are far from their parent
UPDATE scenario_casualties child
SET location_lat = parent.location_lat,
    location_lng = parent.location_lng
FROM scenario_hazards parent
WHERE child.parent_pin_id IS NOT NULL
  AND child.parent_pin_id = parent.id
  AND child.status = 'delayed'
  AND (
    ABS(child.location_lat - parent.location_lat) > 0.002
    OR ABS(child.location_lng - parent.location_lng) > 0.002
  );
