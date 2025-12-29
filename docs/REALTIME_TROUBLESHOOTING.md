# Realtime Troubleshooting Guide

## Problem: Messages not appearing instantly for recipients

If Realtime is connected but not receiving INSERT events, check the following:

## Step 1: Verify Realtime is Enabled

Run this SQL in Supabase SQL Editor:

```sql
-- Check if chat_messages is in Realtime publication
SELECT
  schemaname,
  tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename = 'chat_messages';
```

**Expected Result:** Should return 1 row

**If no rows returned:** Run migration `018_enable_realtime.sql`:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
```

## Step 2: Verify RLS Policies Don't Have Recursion

Run this SQL to check for the problematic policy:

```sql
SELECT
  policyname,
  qual
FROM pg_policies
WHERE tablename = 'session_participants'
  AND policyname = 'Participants can view participants in their sessions';
```

**If the `qual` column contains:** `id IN (SELECT session_id FROM session_participants WHERE user_id = auth.uid())`

**This causes infinite recursion!** Run migration `019_fix_session_participants_rls_recursion.sql`:

```sql
DROP POLICY IF EXISTS "Participants can view participants in their sessions" ON session_participants;

CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    user_id = auth.uid()
    OR
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND trainer_id = auth.uid()
    )
  );
```

## Step 3: Test Realtime Manually

After running migrations, test if Realtime works:

1. Open browser console on recipient's side
2. Look for: `[ChatInterface] ✅ Realtime is connected`
3. Send a message from sender
4. Check console for: `[useRealtime] ✅ INSERT event received`

**If you see the INSERT event:** Realtime is working! The message should appear instantly.

**If you don't see the INSERT event:**

- Check that migrations 018 and 019 were run
- Verify RLS allows SELECT on `chat_messages` for the recipient user
- Check browser console for any Realtime errors

## Step 4: Verify RLS Allows SELECT

Test if the recipient can SELECT messages:

```sql
-- Run this as the recipient user (in Supabase SQL Editor with their auth context)
SELECT id, content
FROM chat_messages
WHERE session_id = 'YOUR_SESSION_ID'
LIMIT 1;
```

**If this fails:** RLS is blocking. Check the `chat_messages` SELECT policy allows access for session participants.

## Quick Fix Checklist

- [ ] Migration 018 (`018_enable_realtime.sql`) - Enable Realtime on `chat_messages`
- [ ] Migration 019 (`019_fix_session_participants_rls_recursion.sql`) - Fix RLS recursion
- [ ] Refresh browser after running migrations
- [ ] Check console for `[useRealtime] ✅ INSERT event received` when message is sent
- [ ] Verify both users are participants in the session
