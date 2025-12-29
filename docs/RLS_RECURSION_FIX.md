# RLS Recursion Fix - Alternative Strategy

## Problem

The `infinite recursion detected in policy for relation "session_participants"` error persists even after multiple migration attempts. This is caused by:

1. **Circular Dependency**: The `chat_messages` SELECT policy queries `session_participants`, which triggers its own RLS policy, creating a recursion loop
2. **Connection Pool Caching**: Supabase's PgBouncer connection pooler may cache execution plans, preventing policy updates from taking effect immediately

## Solution: SECURITY DEFINER Function

We've implemented an alternative RLS strategy that breaks the recursion chain by using a `SECURITY DEFINER` function.

### How It Works

1. **Function Creation**: Created `is_user_session_participant()` function with `SECURITY DEFINER`
   - This function runs with elevated privileges (postgres user)
   - It bypasses RLS when querying `session_participants`
   - No recursion is possible because the function doesn't trigger RLS policies

2. **Policy Update**: Updated `chat_messages` SELECT policy to use the function instead of directly querying `session_participants`
   - Old: `EXISTS (SELECT 1 FROM session_participants WHERE ...)`
   - New: `is_user_session_participant(session_id, auth.uid())`

3. **Recursion Broken**: The circular dependency is eliminated because:
   - `chat_messages` policy → calls function → function queries `session_participants` (no RLS) → no recursion

## Migration Files

1. **`032_verify_policies_simple.sql`**: Diagnostic queries to verify current policies
2. **`033_alternative_rls_strategy.sql`**: Implements the SECURITY DEFINER function approach

## Steps to Apply

1. **Run Diagnostic** (optional):

   ```sql
   -- Run migrations/032_verify_policies_simple.sql
   -- This will show what policies currently exist
   ```

2. **Apply Fix**:

   ```sql
   -- Run migrations/033_alternative_rls_strategy.sql
   -- This will:
   --   - Create the SECURITY DEFINER function
   --   - Fix session_participants policies (ensure non-recursive)
   --   - Update chat_messages policy to use the function
   ```

3. **Verify**:
   - Refresh your browser
   - Check console - should see: `[ChatInterface] RLS allows SELECT - can read X messages`
   - Test sending a message - should appear instantly for recipient

## Security Considerations

The `SECURITY DEFINER` function runs with elevated privileges, but:

- It only checks participation status (read-only operation)
- It uses `SET search_path = public` to prevent search path attacks
- It's marked as `STABLE` for query optimization
- The function logic is simple and doesn't modify data

## If Error Persists

If the recursion error still appears after running migration 033:

1. **Wait 5-10 minutes**: Connection pools may need time to expire
2. **Close all browser tabs**: Force new connections
3. **Check Supabase Dashboard**: Verify the migration ran successfully
4. **Run verification query**:

   ```sql
   SELECT policyname, cmd
   FROM pg_policies
   WHERE tablename = 'chat_messages';
   ```

   Should show policy using `is_user_session_participant` function

5. **Test function directly**:
   ```sql
   SELECT is_user_session_participant('YOUR_SESSION_ID', auth.uid());
   ```
   Should return true/false without recursion error

## Frontend Changes

**No frontend changes required!** The RLS policy change is transparent to the client. The Supabase client will automatically respect the new policy.
