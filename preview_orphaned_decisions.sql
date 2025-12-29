-- Preview: Decisions that will be cleaned up (orphaned decisions with no steps)
SELECT 
  d.id,
  d.session_id,
  d.title,
  d.proposed_by,
  d.status,
  d.created_at,
  up.full_name as creator_name
FROM decisions d
LEFT JOIN user_profiles up ON d.proposed_by = up.id
WHERE NOT EXISTS (
  SELECT 1 FROM decision_steps ds WHERE ds.decision_id = d.id
)
AND d.status = 'proposed'
ORDER BY d.created_at DESC;

