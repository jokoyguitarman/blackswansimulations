-- C2E: Crowd density / population around blast site for Insider and second-device planning.
-- Run after 061, 070. Idempotent.
-- When users ask "crowd density of the surrounds of the blast site", "population around the area",
-- or "are there people around the blast site", the Insider returns this intel (category crowd_density).

-- ============================================
-- PART 1: Allow 'crowd_density' in session_insider_qa
-- ============================================
DO $$
DECLARE
  conname text;
BEGIN
  FOR conname IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'session_insider_qa' AND c.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE session_insider_qa DROP CONSTRAINT %I', conname);
  END LOOP;
  ALTER TABLE session_insider_qa
    ADD CONSTRAINT session_insider_qa_category_check
    CHECK (category IN ('map', 'hospitals', 'police', 'fire_stations', 'cctv', 'routes', 'crowd_density', 'layout', 'other'));
END $$;

-- ============================================
-- PART 2: Add crowd_density_blast_surrounds to C2E insider_knowledge.custom_facts
-- ============================================
DO $$
DECLARE
  scenario_uuid UUID;
  current_facts jsonb;
  new_fact jsonb;
  has_crowd_fact boolean;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '074: C2E scenario not found; skipping crowd_density custom_fact.';
    RETURN;
  END IF;

  SELECT COALESCE(insider_knowledge->'custom_facts', '[]'::jsonb) INTO current_facts
  FROM scenarios WHERE id = scenario_uuid;

  has_crowd_fact := EXISTS (
    SELECT 1 FROM jsonb_array_elements(current_facts) AS el
    WHERE (el->>'topic') ILIKE '%crowd_density%' OR (el->>'topic') ILIKE '%crowd%'
  );

  IF NOT has_crowd_fact THEN
    new_fact := jsonb_build_object(
      'topic', 'crowd_density_blast_surrounds',
      'summary', 'Crowd density is highest near exits and cordon edge; ground zero is cordoned with no one inside. Relevant for second-device planning.',
      'detail', 'Current crowd distribution around the blast site (as reported by volunteers): (1) Ground zero and inner cordon: cleared; no one inside the 20 m cordon. (2) Cordon edge and casualty pickup: moderate concentration; responders and a few casualties at the cordon edge. (3) North side / North exit: high density; many evacuees moving toward North exit and carpark; bottleneck building. (4) South side / South exit: high density; large group moving to South exit and playground. (5) West exit / Community club side: very high density; West exit is congested and the Community club route is packed; people are still close to the blast site along this corridor. (6) East strip: medium density; some movement toward East exit and club. (7) Adjacent field (NW): low density; some evacuees have reached the open field. For second-device or secondary threat planning: the areas with the highest remaining concentration of people are the West exit corridor, Community club approach, and the cordon-edge assembly. Clearing or redirecting flow from these zones reduces risk if a second device is present.'
    );

    UPDATE scenarios
    SET insider_knowledge = jsonb_set(
      COALESCE(insider_knowledge, '{}'::jsonb),
      '{custom_facts}',
      current_facts || new_fact
    )
    WHERE id = scenario_uuid;

    RAISE NOTICE '074: C2E custom_fact crowd_density_blast_surrounds added.';
  ELSE
    RAISE NOTICE '074: C2E already has crowd_density custom_fact; skipping.';
  END IF;
END $$;

-- ============================================
-- PART 3: Add crowd_density to C2E scenario_locations (blast vicinity, exits)
-- ============================================
DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '074: C2E scenario not found; skipping scenario_locations crowd_density.';
    RETURN;
  END IF;

  -- Blast site / ground zero: cordoned, density 0
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0, "crowd_notes": "Cordoned; no one inside."}'::jsonb
  WHERE scenario_id = scenario_uuid AND location_type = 'blast_site';

  -- West exit: high density (congested)
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0.85, "crowd_notes": "Very high; congested; people still close to blast corridor."}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'West exit';

  -- Community club exit: high density
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0.75, "crowd_notes": "High; packed route toward club."}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'Community club';

  -- North exit: high density (main flow)
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0.7, "crowd_notes": "High; bottleneck building toward carpark."}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'North exit';

  -- South exit: high density
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0.65, "crowd_notes": "High; large group moving to playground."}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'South exit';

  -- East exit: medium
  UPDATE scenario_locations
  SET conditions = COALESCE(conditions, '{}'::jsonb) || '{"crowd_density": 0.5, "crowd_notes": "Medium; some movement toward East exit."}'::jsonb
  WHERE scenario_id = scenario_uuid AND label = 'East exit';

  RAISE NOTICE '074: C2E scenario_locations updated with crowd_density in conditions.';
END $$;
