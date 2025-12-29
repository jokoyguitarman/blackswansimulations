# Fix: Invited Participants Not Visible in Trainer View / Participants Can't See Sessions

## Problem Summary

After implementing the email invitation system, two critical issues were discovered:

1. **Trainer View**: Invited participants who had signed up and authenticated were not appearing in the session's participant list, even though they had accepted invitations.
2. **Participant View**: Invited participants could not see any sessions in their dashboard, even after successfully signing up and logging in.

## Root Cause Analysis

The issue had multiple contributing factors:

### 1. Trigger Function Timing Constraint (Fixed Earlier)

The `accept_session_invitation_on_signup()` trigger in `migrations/006_session_invitations.sql` initially had a timing constraint that only processed invitations accepted within 1 minute of signup. This was removed in a previous fix.

### 2. REST Endpoint Only Processed 'Accepted' Invitations

The `POST /api/sessions/process-invitations` endpoint only looked for invitations with `status = 'accepted'`. However, if the database trigger didn't run (due to timing, errors, or the trigger not being updated), invitations remained in `'pending'` status, causing the endpoint to find no invitations to process.

### 3. Missing Participant Records

Even when invitations were marked as 'accepted', the participant records weren't being created in the `session_participants` table. This could happen if:

- The trigger failed silently (wrapped in exception handler)
- The REST endpoint wasn't being called
- The invitation status wasn't updated to 'accepted'

## Solution Implemented

### 1. Updated `/process-invitations` Endpoint (`server/routes/sessions.ts`)

**Changes Made:**

- **Expanded invitation query**: Changed from only looking for `status = 'accepted'` to looking for both `'pending'` and `'accepted'` invitations
- **Auto-accept pending invitations**: Added logic to automatically accept any 'pending' invitations before processing them
- **Enhanced logging**: Added detailed logging to track:
  - How many pending invitations were accepted
  - Which participants were added
  - Any errors during the process

**Key Code Changes:**

```typescript
// Before: Only looked for 'accepted' invitations
.eq('status', 'accepted')

// After: Looks for both 'pending' and 'accepted'
.in('status', ['pending', 'accepted'])

// New: Auto-accept pending invitations
const pendingInvitations = invitations.filter(inv => inv.status === 'pending');
if (pendingInvitations.length > 0) {
  await supabaseAdmin
    .from('session_invitations')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('email', userEmail)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString());
}
```

### 2. Frontend Auto-Processing (`frontend/src/pages/Sessions.tsx`)

**Changes Made:**

- Added automatic call to `processInvitations()` when participants (non-trainers) load the Sessions page
- Ensures invitations are processed before loading the session list
- Fails silently if processing fails (doesn't block session loading)

**Key Code Changes:**

```typescript
useEffect(() => {
  const initialize = async () => {
    // Process any pending invitations first (for participants who signed up before trigger fix)
    if (!isTrainer) {
      try {
        await api.sessions.processInvitations();
      } catch (err) {
        // Silently fail - this is just a convenience feature
        console.debug('Failed to process invitations:', err);
      }
    }
    await loadSessions();
    if (isTrainer) {
      loadScenarios();
    }
  };
  initialize();
}, [isTrainer]);
```

### 3. Added API Method (`frontend/src/lib/api.ts`)

**Changes Made:**

- Added `processInvitations()` method to the sessions API object
- Provides a clean interface for calling the backend endpoint

**Key Code:**

```typescript
processInvitations: async () => {
  const headers = await getAuthHeaders();
  return handleResponse<{ data: { processed: number; totalInvitations: number; participants: unknown[] } }>(
    await fetch('/api/sessions/process-invitations', {
      method: 'POST',
      headers,
    })
  );
},
```

## How It Works Now

### Flow for New Invitations (Post-Fix)

1. **Trainer invites participant** via email
   - Creates `session_invitations` record with `status = 'pending'`
   - Email sent to participant

2. **Participant signs up** via invitation link
   - Database trigger `accept_session_invitation_on_signup()` runs:
     - Updates invitation `status` to `'accepted'`
     - Inserts record into `session_participants` table
   - If trigger fails silently, invitation remains `'pending'`

3. **Participant logs in and visits Sessions page**
   - Frontend automatically calls `POST /api/sessions/process-invitations`
   - Backend:
     - Finds all 'pending' or 'accepted' invitations for user's email
     - Accepts any 'pending' invitations
     - Adds participant to `session_participants` for all invitations
   - Sessions list loads, showing sessions the participant is assigned to

4. **Trainer views session**
   - Session query includes `session_participants` with user details
   - Participant appears in participant list

### Flow for Existing Invitations (Pre-Fix)

For participants who signed up before the fix:

- Their invitations may still be `'pending'` or `'accepted'` but missing from `session_participants`
- When they visit the Sessions page, the auto-processing handles it:
  - Finds their invitations
  - Accepts pending ones
  - Adds them to `session_participants`
- They can now see their sessions, and trainers can see them

## Files Modified

1. **`server/routes/sessions.ts`**
   - Updated `POST /api/sessions/process-invitations` endpoint
   - Now handles both 'pending' and 'accepted' invitations
   - Auto-accepts pending invitations before processing

2. **`frontend/src/pages/Sessions.tsx`**
   - Added automatic invitation processing on page load for participants
   - Ensures invitations are processed before loading sessions

3. **`frontend/src/lib/api.ts`**
   - Added `processInvitations()` method to sessions API

## Testing & Verification

### How to Verify the Fix Works

1. **As Trainer:**
   - Invite a new participant via email
   - After they sign up, check the session's participant list
   - Participant should appear with their role

2. **As Participant:**
   - Sign up via invitation link
   - Log in and navigate to Sessions page
   - Should see the session you were invited to
   - Session should appear in your dashboard

3. **Check Database:**

   ```sql
   -- Check invitation status
   SELECT * FROM session_invitations WHERE email = 'participant@email.com';

   -- Check participant record
   SELECT * FROM session_participants WHERE user_id = 'user-uuid-here';
   ```

### Server Logs to Monitor

When a participant visits the Sessions page, you should see:

```
[INFO] Accepted pending invitations: { userId: '...', count: 1 }
[INFO] Added participant to session: { userId: '...', sessionId: '...', role: '...' }
[INFO] Processed invitations: { userId: '...', processed: 1, totalInvitations: 1, pendingAccepted: 1 }
```

## Related Fixes

This fix builds on previous fixes:

- **Email invitation not being sent**: Fixed `EMAIL_FROM` configuration
- **Signup "Database error saving new user"**: Fixed role mapping in `handle_new_user()` trigger
- **Trigger timing constraint**: Removed 1-minute window from `accept_session_invitation_on_signup()`

## Prevention

To prevent similar issues in the future:

1. **Monitor server logs** for invitation processing errors
2. **Check database** periodically for invitations stuck in 'pending' status
3. **Test invitation flow** end-to-end after any database trigger changes
4. **Consider adding** a background job to periodically process stuck invitations

## Date Fixed

Fixed on: [Current Date]
Status: ✅ Working - Participants visible in trainer view, participants can see their sessions
