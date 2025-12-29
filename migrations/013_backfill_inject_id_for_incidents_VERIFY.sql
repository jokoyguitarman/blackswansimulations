-- Verification script to check which incidents have inject_id and which don't
-- Run this AFTER running the backfill migration to see the results

-- Show incidents with inject_id (should be filtered by scope)
SELECT 
  i.id,
  i.title,
  i.reported_at,
  i.inject_id,
  si.inject_scope,
  si.target_teams,
  si.affected_roles,
  CASE 
    WHEN si.inject_scope = 'universal' THEN 'Visible to all'
    WHEN si.inject_scope = 'role_specific' THEN 'Visible to specific roles'
    WHEN si.inject_scope = 'team_specific' THEN 'Visible to specific teams'
    ELSE 'Unknown scope'
  END as visibility
FROM incidents i
LEFT JOIN scenario_injects si ON si.id = i.inject_id
WHERE i.inject_id IS NOT NULL
ORDER BY i.reported_at DESC;

-- Show incidents without inject_id (manually created, visible to all)
SELECT 
  i.id,
  i.title,
  i.reported_at,
  'Manually created (no inject_id)' as source
FROM incidents i
WHERE i.inject_id IS NULL
ORDER BY i.reported_at DESC;

-- Summary statistics
SELECT 
  COUNT(*) as total_incidents,
  COUNT(inject_id) as incidents_with_inject_id,
  COUNT(*) - COUNT(inject_id) as incidents_without_inject_id,
  ROUND(100.0 * COUNT(inject_id) / COUNT(*), 2) as percent_with_inject_id
FROM incidents;

