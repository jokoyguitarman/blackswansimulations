-- Debug script to check auth users vs user_profiles
-- This helps identify if users exist in user_profiles but not in auth.users

-- 1. Check all users in user_profiles
SELECT 
  up.id,
  up.email,
  up.full_name,
  up.role,
  up.username,
  CASE 
    WHEN au.id IS NOT NULL THEN 'EXISTS_IN_AUTH'
    ELSE 'MISSING_IN_AUTH'
  END as auth_status
FROM user_profiles up
LEFT JOIN auth.users au ON au.id = up.id
ORDER BY up.created_at;

-- 2. Check specific emails (replace with your invited emails)
SELECT 
  up.id,
  up.email as profile_email,
  up.full_name,
  up.role,
  au.email as auth_email,
  au.id as auth_id,
  CASE 
    WHEN au.id IS NOT NULL THEN 'EXISTS_IN_AUTH'
    ELSE 'MISSING_IN_AUTH - NEEDS_SIGNUP'
  END as status
FROM user_profiles up
LEFT JOIN auth.users au ON au.id = up.id
WHERE up.email IN (
  'katigayunanfoodcorp@gmail.com',
  'jdqtabbada@addu.edu.ph',
  'therestaurateursph@gmail.com',
  'cucinailocana@yahoo.com'
)
ORDER BY up.email;

-- 3. Check invitations vs user_profiles vs auth.users
SELECT 
  si.email as invitation_email,
  si.status as invitation_status,
  up.email as profile_email,
  up.id as profile_id,
  up.full_name,
  au.email as auth_email,
  au.id as auth_id,
  CASE 
    WHEN up.id IS NULL THEN 'NO_PROFILE'
    WHEN au.id IS NULL THEN 'PROFILE_EXISTS_BUT_NO_AUTH - NEEDS_SIGNUP'
    WHEN sp.user_id IS NOT NULL THEN 'ALREADY_PARTICIPANT'
    ELSE 'READY_TO_ADD'
  END as status
FROM session_invitations si
LEFT JOIN user_profiles up ON LOWER(TRIM(up.email)) = LOWER(TRIM(si.email))
LEFT JOIN auth.users au ON au.id = up.id
LEFT JOIN session_participants sp ON sp.session_id = si.session_id AND sp.user_id = up.id
WHERE si.session_id = 'YOUR_SESSION_ID'  -- Replace with your session ID
ORDER BY si.created_at;


