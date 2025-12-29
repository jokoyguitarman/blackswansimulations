-- Remove old decision-based injects that were pre-defined
-- These are being replaced by dynamic AI-generated injects
-- Only remove injects with trigger_condition set (decision-based), not time-based ones

-- First, show what will be deleted (for verification)
SELECT 
  'Injects to be deleted' as action,
  COUNT(*) as count,
  s.title as scenario_title
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE si.trigger_condition IS NOT NULL
  AND si.trigger_time_minutes IS NULL
GROUP BY s.title
ORDER BY s.title;

-- Delete decision-based injects (those with trigger_condition but no trigger_time_minutes)
-- These are the old pre-defined decision triggers being replaced by dynamic generation
DELETE FROM scenario_injects
WHERE trigger_condition IS NOT NULL
  AND trigger_time_minutes IS NULL;

-- Show summary after cleanup
SELECT 
  'Cleanup complete' as status,
  COUNT(*) FILTER (WHERE trigger_condition IS NOT NULL AND trigger_time_minutes IS NULL) as remaining_decision_based,
  COUNT(*) FILTER (WHERE trigger_time_minutes IS NOT NULL) as time_based_injects,
  COUNT(*) FILTER (WHERE trigger_condition IS NULL AND trigger_time_minutes IS NULL AND ai_generated = true) as dynamic_ai_generated
FROM scenario_injects;

