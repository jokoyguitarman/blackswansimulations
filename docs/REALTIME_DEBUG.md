# Realtime Debugging Guide

## Current Issue: Realtime subscribed but not receiving INSERT events

### Symptoms:

- ✅ Realtime subscription shows `SUBSCRIBED`
- ✅ Message is sent successfully (API returns 201)
- ❌ No `[useRealtime] ✅ INSERT event received` log appears
- ❌ Recipient doesn't see message until refresh

### Possible Causes:

1. **RLS is blocking SELECT access**
   - Realtime respects RLS - if user can't SELECT, they won't receive events
   - Test: Run this in recipient's browser console:

   ```javascript
   const { data, error } = await supabase
     .from('chat_messages')
     .select('id, content')
     .eq('session_id', 'YOUR_SESSION_ID')
     .limit(1);
   console.log('Can SELECT?', { data, error });
   ```

2. **Realtime filter might be needed**
   - Try adding filter back: `filter: sessionId ? `session_id=eq.${sessionId}` : undefined`

3. **Realtime auth token not set**
   - Check if `supabase.realtime.setAuth()` is being called
   - Look for: `[useRealtime] Set Realtime auth token for chat_messages`

4. **Message inserted via admin client**
   - If messages are inserted using `supabaseAdmin`, Realtime might not trigger
   - Check server/routes/channels.ts - messages should be inserted via regular client or trigger Realtime

### Debug Steps:

1. **Check if recipient can SELECT messages:**

   ```sql
   -- Run as recipient user in Supabase SQL Editor
   SELECT id, content, session_id, channel_id
   FROM chat_messages
   WHERE session_id = 'YOUR_SESSION_ID'
   LIMIT 1;
   ```

2. **Check Realtime publication:**

   ```sql
   SELECT tablename
   FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime'
     AND tablename = 'chat_messages';
   ```

3. **Check RLS policies:**

   ```sql
   SELECT policyname, qual
   FROM pg_policies
   WHERE tablename = 'chat_messages'
     AND cmd = 'SELECT';
   ```

4. **Test Realtime manually:**
   - Open recipient's browser console
   - Send a message from sender
   - Look for ANY Realtime logs (even errors)

### Expected Flow:

1. Sender sends message → API returns 201
2. Database INSERT happens
3. Realtime broadcasts INSERT event
4. Recipient's subscription receives event
5. `[useRealtime] ✅ INSERT event received` log appears
6. `handleRealtimeMessage` is called
7. Message appears in UI

If step 4-5 don't happen, Realtime isn't receiving events (RLS or config issue).
