-- Force refresh RLS policies to clear any cached recursion
-- Sometimes PostgreSQL caches policy execution plans

-- First, verify current policies are correct (should already be done)
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';

-- Force PostgreSQL to rebuild the policy cache by:
-- 1. Temporarily disabling RLS
ALTER TABLE session_participants DISABLE ROW LEVEL SECURITY;

-- 2. Re-enabling RLS (this forces policy re-evaluation)
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

-- 3. Do the same for chat_messages to ensure it picks up the fixed session_participants policy
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- This should clear any cached execution plans that might have the old recursive policy

-- After running this, test the SELECT query again:
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;
-- Should work without recursion error

