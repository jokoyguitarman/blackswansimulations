-- Force PostgreSQL to refresh RLS policy cache
-- Sometimes PostgreSQL caches old policy execution plans even after policies are updated
-- This forces a complete refresh

-- Step 1: Temporarily disable RLS on session_participants
ALTER TABLE session_participants DISABLE ROW LEVEL SECURITY;

-- Step 2: Re-enable RLS (this forces PostgreSQL to rebuild policy execution plans)
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

-- Step 3: Do the same for chat_messages to ensure it picks up the refreshed session_participants policy
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Step 4: Verify policies are still correct (they should be)
-- Run this after the migration to verify:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';
-- Should show the non-recursive policy

-- Step 5: Test that SELECT works (run this as the user experiencing the issue)
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;
-- Should work without recursion error

