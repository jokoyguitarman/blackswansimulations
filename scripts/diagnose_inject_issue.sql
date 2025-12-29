-- Diagnostic SQL to check why injects aren't publishing
-- Run this in your Supabase SQL Editor

-- Replace with your actual session ID
\set session_id 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'

-- 1. Check session state
SELECT 
  id,
  status,
  start_time,
  EXTRACT(EPOCH FROM (NOW() - start_time)) / 60 as elapsed_minutes,
  scenario_id,
  trainer_id
FROM sessions
WHERE id = :'session_id';

-- 2. Check time-based injects for this scenario
SELECT 
  si.id,
  si.title,
  si.trigger_time_minutes,
  CASE 
    WHEN si.trigger_time_minutes <= EXTRACT(EPOCH FROM (NOW() - s.start_time)) / 60 
    THEN 'SHOULD_TRIGGER'
    ELSE 'NOT_YET'
  END as trigger_status
FROM scenario_injects si
JOIN sessions s ON s.scenario_id = si.scenario_id
WHERE s.id = :'session_id'
  AND si.trigger_time_minutes IS NOT NULL
ORDER BY si.trigger_time_minutes;

-- 3. Check if injects are already published (checking metadata.inject_id)
SELECT 
  se.id as event_id,
  se.created_at,
  se.metadata->>'inject_id' as inject_id,
  se.metadata->>'title' as inject_title,
  se.description
FROM session_events se
WHERE se.session_id = :'session_id'
  AND se.event_type = 'inject'
ORDER BY se.created_at;

-- 4. Compare: Which injects should trigger but aren't published?
WITH session_info AS (
  SELECT 
    id,
    scenario_id,
    start_time,
    EXTRACT(EPOCH FROM (NOW() - start_time)) / 60 as elapsed_minutes
  FROM sessions
  WHERE id = :'session_id'
),
should_trigger AS (
  SELECT 
    si.id as inject_id,
    si.title,
    si.trigger_time_minutes
  FROM scenario_injects si
  JOIN session_info s ON s.scenario_id = si.scenario_id
  WHERE si.trigger_time_minutes IS NOT NULL
    AND si.trigger_time_minutes <= s.elapsed_minutes
),
published AS (
  SELECT DISTINCT
    (se.metadata->>'inject_id')::uuid as inject_id
  FROM session_events se
  WHERE se.session_id = :'session_id'
    AND se.event_type = 'inject'
    AND se.metadata->>'inject_id' IS NOT NULL
)
SELECT 
  st.inject_id,
  st.title,
  st.trigger_time_minutes,
  CASE 
    WHEN p.inject_id IS NOT NULL THEN 'ALREADY_PUBLISHED'
    ELSE 'NEEDS_PUBLISHING'
  END as status
FROM should_trigger st
LEFT JOIN published p ON p.inject_id = st.inject_id
ORDER BY st.trigger_time_minutes;

