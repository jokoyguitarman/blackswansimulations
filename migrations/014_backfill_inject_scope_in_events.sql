-- Backfill inject_scope and target_teams in session_events metadata for old inject events
-- This migration updates old events that don't have scope information in their metadata

-- Step 1: Update inject events that have inject_id but missing inject_scope
UPDATE session_events
SET metadata = jsonb_set(
  jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{inject_scope}',
    to_jsonb(COALESCE(si.inject_scope, 'universal'))
  ),
  '{target_teams}',
  CASE 
    WHEN si.target_teams IS NOT NULL THEN to_jsonb(si.target_teams)
    ELSE 'null'::jsonb
  END
)
FROM scenario_injects si
WHERE session_events.event_type = 'inject'
  AND session_events.metadata->>'inject_id' IS NOT NULL
  AND (session_events.metadata->>'inject_id')::uuid = si.id
  AND (
    session_events.metadata->>'inject_scope' IS NULL
    OR session_events.metadata->>'inject_scope' = ''
  );

-- Step 2: Log the results
DO $$
DECLARE
  updated_count INTEGER;
  total_inject_events INTEGER;
  events_with_scope INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_inject_events 
  FROM session_events 
  WHERE event_type = 'inject';
  
  SELECT COUNT(*) INTO events_with_scope 
  FROM session_events 
  WHERE event_type = 'inject'
    AND metadata->>'inject_scope' IS NOT NULL
    AND metadata->>'inject_scope' != '';
  
  updated_count := events_with_scope;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Backfill Results for Inject Events:';
  RAISE NOTICE '  Total inject events: %', total_inject_events;
  RAISE NOTICE '  Events with inject_scope: %', events_with_scope;
  RAISE NOTICE '  Events without inject_scope: %', total_inject_events - events_with_scope;
  RAISE NOTICE '========================================';
END $$;

