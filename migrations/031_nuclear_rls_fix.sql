-- Nuclear option: Complete RLS rebuild with connection reset
-- This is the most aggressive fix possible - use if migration 029 didn't work

-- ============================================================================
-- PART 1: Completely remove ALL policies and rebuild from scratch
-- ============================================================================

-- Step 1: Drop ALL policies on session_participants using multiple methods
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Method 1: Drop by name (known policies)
    DROP POLICY IF EXISTS "Participants can view participants in their sessions" ON session_participants;
    DROP POLICY IF EXISTS "Trainers can manage participants" ON session_participants;
    
    -- Method 2: Drop all policies found in pg_policies
    FOR r IN (
        SELECT policyname 
        FROM pg_policies 
        WHERE tablename = 'session_participants'
    ) LOOP
        BEGIN
            EXECUTE format('DROP POLICY IF EXISTS %I ON session_participants', r.policyname);
            RAISE NOTICE 'Dropped policy: %', r.policyname;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Failed to drop policy %: %', r.policyname, SQLERRM;
        END;
    END LOOP;
    
    -- Method 3: Try dropping via pg_policies directly (if above didn't catch everything)
    FOR r IN (
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE tablename = 'session_participants'
    ) LOOP
        BEGIN
            EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', 
                r.policyname, r.schemaname, r.tablename);
        EXCEPTION WHEN OTHERS THEN
            -- Ignore errors, continue
            NULL;
        END;
    END LOOP;
END $$;

-- Step 2: Disable RLS completely
ALTER TABLE session_participants DISABLE ROW LEVEL SECURITY;

-- Step 3: Wait a moment (PostgreSQL doesn't have SLEEP, but we can use a dummy query)
-- This gives time for any cached plans to expire
DO $$
BEGIN
    PERFORM pg_sleep(0.1);
END $$;

-- Step 4: Re-enable RLS
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;

-- Step 5: Create the SELECT policy WITHOUT ANY recursion
-- This is the critical part - must NOT query session_participants within itself
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    -- Option 1: Direct user_id check (no subquery, no recursion)
    user_id = auth.uid()
    OR
    -- Option 2: Check sessions table ONLY (never query session_participants)
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Step 6: Create the management policy
CREATE POLICY "Trainers can manage participants"
  ON session_participants FOR ALL
  USING (
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 
      FROM sessions s
      WHERE s.id = session_participants.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- ============================================================================
-- PART 2: Fix chat_messages policies
-- ============================================================================

-- Step 7: Drop chat_messages SELECT policy
DROP POLICY IF EXISTS "Session participants can view messages" ON chat_messages;

-- Step 8: Disable RLS on chat_messages
ALTER TABLE chat_messages DISABLE ROW LEVEL SECURITY;

-- Step 9: Wait briefly
DO $$
BEGIN
    PERFORM pg_sleep(0.1);
END $$;

-- Step 10: Re-enable RLS
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Step 11: Recreate chat_messages SELECT policy
-- This will use the fixed session_participants policy (no recursion)
CREATE POLICY "Session participants can view messages"
  ON chat_messages FOR SELECT
  USING (
    -- Check session_participants (now has non-recursive policy)
    EXISTS (
      SELECT 1 FROM session_participants sp
      WHERE sp.session_id = chat_messages.session_id
      AND sp.user_id = auth.uid()
    )
    OR
    -- Check sessions (trainer access)
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = chat_messages.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- ============================================================================
-- PART 3: Force PostgreSQL to rebuild all cached plans
-- ============================================================================

-- Step 12: Analyze the tables to rebuild statistics
ANALYZE session_participants;
ANALYZE chat_messages;
ANALYZE sessions;

-- Step 13: Verify policies
DO $$
DECLARE
    policy_count INTEGER;
    recursive_count INTEGER;
BEGIN
    -- Count policies
    SELECT COUNT(*) INTO policy_count
    FROM pg_policies
    WHERE tablename = 'session_participants';
    
    RAISE NOTICE 'Total session_participants policies: %', policy_count;
    
    -- Check for recursion patterns in policy definitions
    SELECT COUNT(*) INTO recursive_count
    FROM pg_policies
    WHERE tablename = 'session_participants'
      AND (
        qual::text LIKE '%session_participants%session_participants%'
        OR qual::text LIKE '%SELECT session_id FROM session_participants%'
      );
    
    IF recursive_count > 0 THEN
        RAISE WARNING 'Found % potentially recursive policies!', recursive_count;
    ELSE
        RAISE NOTICE 'No recursive patterns detected in policies';
    END IF;
END $$;

-- ============================================================================
-- VERIFICATION QUERIES (run these after the migration)
-- ============================================================================

-- Verify session_participants policies:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'session_participants';

-- Verify chat_messages policies:
-- SELECT policyname, qual FROM pg_policies WHERE tablename = 'chat_messages';

-- Test SELECT (should work without recursion):
-- SELECT id, content FROM chat_messages WHERE session_id = 'YOUR_SESSION_ID' LIMIT 1;

