-- Diagnostic SQL Queries for Decision Steps Issue
-- Session ID: fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57
-- User ID: 265c1499-ebd0-458d-b7ea-c95191e88283

-- 1. Check all decisions for this session
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

-- 2. Check all decision_steps for decisions in this session
SELECT 
  ds.id,
  ds.decision_id,
  ds.user_id,
  ds.role,
  ds.approver_role,
  ds.step_order,
  ds.status,
  ds.required,
  d.title as decision_title,
  d.proposed_by as decision_creator_id
FROM decision_steps ds
JOIN decisions d ON ds.decision_id = d.id
WHERE d.session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
ORDER BY ds.decision_id, ds.step_order;

-- 3. Check specifically for steps assigned to this user
SELECT 
  ds.id,
  ds.decision_id,
  ds.user_id,
  ds.role,
  ds.status,
  ds.step_order,
  d.title as decision_title,
  d.session_id
FROM decision_steps ds
JOIN decisions d ON ds.decision_id = d.id
WHERE ds.user_id = '265c1499-ebd0-458d-b7ea-c95191e88283'
  AND d.session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
ORDER BY ds.decision_id, ds.step_order;

-- 4. Check if user_id is NULL in any decision_steps for this session
SELECT 
  ds.id,
  ds.decision_id,
  ds.user_id,
  ds.role,
  ds.status,
  d.title as decision_title
FROM decision_steps ds
JOIN decisions d ON ds.decision_id = d.id
WHERE d.session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
  AND ds.user_id IS NULL
ORDER BY ds.decision_id, ds.step_order;

-- 5. Get all decision IDs in this session (to verify the query is using correct IDs)
SELECT 
  id as decision_id,
  title,
  proposed_by
FROM decisions
WHERE session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57';

-- 6. Count decision_steps by user_id for this session (to see distribution)
SELECT 
  ds.user_id,
  COUNT(*) as step_count,
  COUNT(DISTINCT ds.decision_id) as decision_count
FROM decision_steps ds
JOIN decisions d ON ds.decision_id = d.id
WHERE d.session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
GROUP BY ds.user_id
ORDER BY step_count DESC;

-- 7. Check the user profile to verify the user ID exists
SELECT 
  id,
  username,
  full_name,
  role
FROM user_profiles
WHERE id = '265c1499-ebd0-458d-b7ea-c95191e88283';

-- 8. Check session participants to see who's in the session
SELECT 
  sp.user_id,
  sp.role,
  up.full_name,
  up.role as profile_role
FROM session_participants sp
LEFT JOIN user_profiles up ON sp.user_id = up.id
WHERE sp.session_id = 'fae8ba20-49e2-4e4a-9b4e-dbdd9f358e57'
ORDER BY sp.role;

