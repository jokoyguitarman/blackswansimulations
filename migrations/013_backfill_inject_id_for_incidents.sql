-- Backfill inject_id for incidents that were created from injects but don't have inject_id set
-- This migration matches incidents to their source injects using session_events metadata

-- Step 1: Update incidents using session_events that have inject_id in metadata
-- When an incident is created from an inject, a session_event is created with metadata containing:
--   - incident_id: the incident UUID
--   - inject_id: the inject UUID that created it
--   - created_from_inject: true
UPDATE incidents
SET inject_id = (
  SELECT (se.metadata->>'inject_id')::uuid
  FROM session_events se
  WHERE se.session_id = incidents.session_id
    AND se.event_type = 'incident'
    AND se.metadata->>'created_from_inject' = 'true'
    AND se.metadata->>'inject_id' IS NOT NULL
    AND se.metadata->>'incident_id' IS NOT NULL
    AND (se.metadata->>'incident_id')::uuid = incidents.id
  ORDER BY se.created_at DESC
  LIMIT 1
)
WHERE inject_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM session_events se
    WHERE se.session_id = incidents.session_id
      AND se.event_type = 'incident'
      AND se.metadata->>'created_from_inject' = 'true'
      AND se.metadata->>'inject_id' IS NOT NULL
      AND se.metadata->>'incident_id' IS NOT NULL
      AND (se.metadata->>'incident_id')::uuid = incidents.id
  );

-- Step 2: For incidents that still don't have inject_id, try matching by title/content and timing
-- This is a fallback for cases where session_events might not have the metadata
-- Match incidents to injects that:
--   - Are in the same scenario
--   - Have matching title and content
--   - Have requires_response = true
--   - Were created around the same time (within 1 hour)
UPDATE incidents
SET inject_id = (
  SELECT si.id
  FROM scenario_injects si
  INNER JOIN sessions s ON s.scenario_id = si.scenario_id
  WHERE s.id = incidents.session_id
    AND si.title = incidents.title
    AND si.content = incidents.description
    AND si.requires_response = true
    AND incidents.inject_id IS NULL
    -- Match incidents created around the same time as inject was published
    -- Check if there's an inject event around the incident creation time
    AND EXISTS (
      SELECT 1
      FROM session_events se
      WHERE se.session_id = incidents.session_id
        AND se.event_type = 'inject'
        AND (se.metadata->>'inject_id')::uuid = si.id
        AND se.created_at >= incidents.reported_at - INTERVAL '1 hour'
        AND se.created_at <= incidents.reported_at + INTERVAL '1 hour'
    )
  ORDER BY si.created_at DESC
  LIMIT 1
)
WHERE inject_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM scenario_injects si
    INNER JOIN sessions s ON s.scenario_id = si.scenario_id
    WHERE s.id = incidents.session_id
      AND si.title = incidents.title
      AND si.content = incidents.description
      AND si.requires_response = true
      AND EXISTS (
        SELECT 1
        FROM session_events se
        WHERE se.session_id = incidents.session_id
          AND se.event_type = 'inject'
          AND (se.metadata->>'inject_id')::uuid = si.id
          AND se.created_at >= incidents.reported_at - INTERVAL '1 hour'
          AND se.created_at <= incidents.reported_at + INTERVAL '1 hour'
      )
  );

-- Step 3: Log the results
DO $$
DECLARE
  updated_count INTEGER;
  total_incidents INTEGER;
  incidents_with_inject_id INTEGER;
  incidents_without_inject_id INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_incidents FROM incidents;
  SELECT COUNT(*) INTO incidents_with_inject_id FROM incidents WHERE inject_id IS NOT NULL;
  SELECT COUNT(*) INTO incidents_without_inject_id FROM incidents WHERE inject_id IS NULL;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Backfill Results:';
  RAISE NOTICE '  Total incidents: %', total_incidents;
  RAISE NOTICE '  Incidents with inject_id: %', incidents_with_inject_id;
  RAISE NOTICE '  Incidents without inject_id: %', incidents_without_inject_id;
  RAISE NOTICE '========================================';
END $$;

