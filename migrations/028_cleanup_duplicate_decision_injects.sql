-- Cleanup Duplicate Decision-Based Injects
-- This script identifies and removes duplicate decision-based injects from the C2E Bombing scenario
-- It keeps the oldest inject (lowest id) and removes newer duplicates

DO $$
DECLARE
  scenario_uuid UUID;
  duplicate_count INTEGER;
  deleted_count INTEGER;
BEGIN
  -- Find the C2E Bombing scenario
  SELECT id INTO scenario_uuid 
  FROM scenarios 
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;
  
  IF scenario_uuid IS NULL THEN
    RAISE NOTICE 'C2E Bombing scenario not found. Skipping cleanup.';
    RETURN;
  END IF;

  -- Count duplicates (injects with same scenario_id, title, and trigger_condition)
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT scenario_id, title, trigger_condition, COUNT(*) as cnt
    FROM scenario_injects
    WHERE scenario_id = scenario_uuid
      AND trigger_condition IS NOT NULL
      AND trigger_time_minutes IS NULL
    GROUP BY scenario_id, title, trigger_condition
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count = 0 THEN
    RAISE NOTICE 'No duplicate decision-based injects found.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found % duplicate groups. Removing duplicates...', duplicate_count;

  -- Delete duplicates, keeping only the oldest one (lowest id) for each unique combination
  WITH duplicates_to_delete AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY scenario_id, title, trigger_condition 
             ORDER BY id ASC
           ) as rn
    FROM scenario_injects
    WHERE scenario_id = scenario_uuid
      AND trigger_condition IS NOT NULL
      AND trigger_time_minutes IS NULL
  )
  DELETE FROM scenario_injects
  WHERE id IN (
    SELECT id 
    FROM duplicates_to_delete 
    WHERE rn > 1
  );

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RAISE NOTICE 'Cleanup complete. Deleted % duplicate inject(s).', deleted_count;
  RAISE NOTICE 'Kept the oldest inject for each unique title + trigger_condition combination.';

END $$;

-- Display summary after cleanup
SELECT 
  'After Cleanup' as status,
  COUNT(*) as inject_count,
  COUNT(*) FILTER (WHERE si.title LIKE '%SUGGESTION%' OR si.title LIKE '%Suggestion%') as suggestion_count,
  COUNT(*) FILTER (WHERE si.title NOT LIKE '%SUGGESTION%' AND si.title NOT LIKE '%Suggestion%') as core_count
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'C2E Bombing at Community Event'
  AND si.trigger_condition IS NOT NULL
  AND si.trigger_time_minutes IS NULL;

