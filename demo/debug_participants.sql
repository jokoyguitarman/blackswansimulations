-- Debug script to check invitations and participants for a session
-- Replace 'YOUR_SESSION_ID' with your actual session ID

-- 1. Check all invitations for the session
SELECT 
  si.id,
  si.email,
  si.role,
  si.status,
  si.created_at,
  si.accepted_at,
  si.expires_at,
  CASE 
    WHEN si.expires_at < NOW() THEN 'EXPIRED'
    WHEN si.status = 'pending' THEN 'PENDING'
    WHEN si.status = 'accepted' THEN 'ACCEPTED'
    ELSE si.status
  END as invitation_status
FROM session_invitations si
WHERE si.session_id = 'YOUR_SESSION_ID'  -- Replace with your session ID
ORDER BY si.created_at;

-- 2. Check all participants for the session
SELECT 
  sp.user_id,
  sp.role,
  sp.joined_at,
  up.full_name,
  up.email,
  up.username
FROM session_participants sp
LEFT JOIN user_profiles up ON up.id = sp.user_id
WHERE sp.session_id = 'YOUR_SESSION_ID'  -- Replace with your session ID
ORDER BY sp.joined_at;

-- 3. Check if invited emails match user emails (case-insensitive)
SELECT 
  si.email as invitation_email,
  si.status as invitation_status,
  up.email as user_email,
  up.id as user_id,
  up.full_name,
  CASE 
    WHEN LOWER(TRIM(si.email)) = LOWER(TRIM(up.email)) THEN 'MATCH'
    ELSE 'NO MATCH'
  END as email_match,
  sp.user_id as is_participant
FROM session_invitations si
LEFT JOIN user_profiles up ON LOWER(TRIM(si.email)) = LOWER(TRIM(up.email))
LEFT JOIN session_participants sp ON sp.session_id = si.session_id AND sp.user_id = up.id
WHERE si.session_id = 'YOUR_SESSION_ID'  -- Replace with your session ID
ORDER BY si.created_at;

-- 4. Get session details
SELECT 
  s.id,
  s.status,
  s.trainer_id,
  s.created_at,
  COUNT(DISTINCT si.id) as total_invitations,
  COUNT(DISTINCT CASE WHEN si.status = 'accepted' THEN si.id END) as accepted_invitations,
  COUNT(DISTINCT sp.user_id) as total_participants
FROM sessions s
LEFT JOIN session_invitations si ON si.session_id = s.id
LEFT JOIN session_participants sp ON sp.session_id = s.id
WHERE s.id = 'YOUR_SESSION_ID'  -- Replace with your session ID
GROUP BY s.id, s.status, s.trainer_id, s.created_at;

