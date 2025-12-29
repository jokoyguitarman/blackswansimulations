-- Check the decisions themselves
SELECT 
  id,
  session_id,
  title,
  proposed_by,
  status,
  created_at
FROM decisions
WHERE session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
ORDER BY created_at DESC;

