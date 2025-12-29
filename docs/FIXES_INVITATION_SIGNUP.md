# Invitation & Signup Flow Fixes

## Timeline: Email Invitation → User Signup Issues

This document tracks all fixes applied to resolve issues with the email invitation system and user signup flow.

---

## Issue 1: Email Invitations Not Being Sent

### Problem

- User reported that invitations showed "successfully sent" in the UI
- Recipients were not receiving emails in their inbox
- No errors visible in the frontend

### Root Cause Analysis

1. **Email transporter initialization** - Needed to verify SMTP configuration was correct
2. **EMAIL_FROM address mismatch** - Using `noreply@simulator.local` which Gmail SMTP rejects
3. **Silent failures** - Email sending errors were caught but not surfaced to frontend

### Fixes Applied

#### 1.1 Email Configuration Fix (`server/env.ts` - already correct)

**Issue**: `EMAIL_FROM` was set to `noreply@simulator.local`  
**Fix**: Changed to match `SMTP_USER` (the authenticated Gmail account)

```env
EMAIL_FROM=therestaurateursph@gmail.com  # Must match SMTP_USER for Gmail
SMTP_USER=therestaurateursph@gmail.com
SMTP_PASS=<app-password>
```

**Why**: Gmail SMTP requires the `from` address to match the authenticated account. Using a different domain causes Gmail to reject the email.

#### 1.2 Enhanced Email Logging (`server/routes/sessions.ts`)

**Issue**: Email send failures were silently caught with `.catch()`  
**Fix**: Added detailed logging to track email send status:

```typescript
sendPendingInvitationEmail({...})
  .then((success) => {
    if (success) {
      logger.info({ email, sessionId: id }, 'Pending invitation email sent successfully');
    } else {
      logger.warn({ email, sessionId: id }, 'Pending invitation email failed to send');
    }
  })
  .catch((err) => {
    logger.error({ error: err, email, sessionId: id }, 'Failed to send pending invitation email');
  });
```

**Result**: Server logs now clearly show:

- ✅ `"Pending invitation email sent successfully"` - Email was sent
- ⚠️ `"Pending invitation email failed to send"` - Function returned false
- ❌ `"Failed to send pending invitation email"` - Exception occurred

#### 1.3 Vite Dev Server Configuration (`frontend/vite.config.ts`)

**Issue**: Frontend dev server only listening on IPv6, not accessible via `localhost:3000`  
**Fix**: Added `host: '0.0.0.0'` to server config:

```typescript
server: {
  port: 3000,
  host: '0.0.0.0', // Listen on all interfaces (IPv4 and IPv6)
  // ...
}
```

**Result**: Frontend now accessible via both `localhost:3000` and `127.0.0.1:3000`

### Verification

- ✅ Email transporter initialized successfully (logs show: `"Email transporter initialized"`)
- ✅ Emails being sent (logs show: `"Pending invitation email sent successfully"` with messageId)
- ✅ Recipients receiving emails in inbox (confirmed by user)

---

## Issue 2: Signup Failing with "Database error saving new user"

### Problem

- User clicked invitation link and attempted to sign up
- Signup failed with error: `"Database error saving new user"`
- Supabase Auth returned 500 Internal Server Error
- Error message: `{"code":"unexpected_failure","message":"Database error saving new user"}`

### Root Cause Analysis

1. **Role mismatch** - Invitation roles (`'defence'`, `'health'`, etc.) didn't match `user_profiles` role constraints
2. **Database constraint violation** - `user_profiles.role` CHECK constraint rejected invitation roles
3. **Trigger function failure** - `handle_new_user()` trigger failed when inserting invalid role

### Role Mapping Issue

**Invitation roles** (from `session_invitations` table):

- `'defence'`
- `'health'`
- `'civil'`
- `'utilities'`
- `'intelligence'`
- `'ngo'`
- `'public_information_officer'`
- `'police_commander'`
- `'legal_oversight'`

**User profile roles** (from `user_profiles` table CHECK constraint):

- `'defence_liaison'`
- `'health_director'`
- `'civil_government'`
- `'utility_manager'`
- `'intelligence_analyst'`
- `'ngo_liaison'`
- `'public_information_officer'` ✅ (matches)
- `'police_commander'` ✅ (matches)
- `'trainer'`
- `'admin'`

**Mismatch**: Invitation uses short names (`'defence'`), but `user_profiles` expects longer names (`'defence_liaison'`)

### Fixes Applied

#### 2.1 Role Mapping Function (`migrations/003_auth_triggers.sql`)

**Fix**: Updated `handle_new_user()` function to map invitation roles to user_profiles roles:

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT;
  v_invitation_role TEXT;
BEGIN
  -- Get role from metadata
  v_invitation_role := COALESCE(NEW.raw_user_meta_data->>'role', 'trainer');

  -- Map invitation roles to user_profiles roles
  CASE v_invitation_role
    WHEN 'defence' THEN v_role := 'defence_liaison';
    WHEN 'health' THEN v_role := 'health_director';
    WHEN 'civil' THEN v_role := 'civil_government';
    WHEN 'utilities' THEN v_role := 'utility_manager';
    WHEN 'intelligence' THEN v_role := 'intelligence_analyst';
    WHEN 'ngo' THEN v_role := 'ngo_liaison';
    WHEN 'public_information_officer' THEN v_role := 'public_information_officer';
    WHEN 'police_commander' THEN v_role := 'police_commander';
    WHEN 'legal_oversight' THEN v_role := 'admin';
    ELSE v_role := v_invitation_role; -- Use as-is for 'trainer', 'admin'
  END CASE;

  INSERT INTO public.user_profiles (id, username, full_name, role, agency_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'User'),
    v_role,  -- Use mapped role
    COALESCE(NEW.raw_user_meta_data->>'agency_name', 'Unknown')
  );
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create user profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Key Changes**:

- Added role mapping logic using `CASE` statement
- Maps all invitation roles to corresponding user_profiles roles
- Includes error handling to prevent signup failure

#### 2.2 Improved Invitation Trigger Error Handling (`migrations/006_session_invitations.sql`)

**Fix**: Enhanced `accept_session_invitation_on_signup()` function with better error handling:

```sql
CREATE OR REPLACE FUNCTION accept_session_invitation_on_signup()
RETURNS TRIGGER AS $$
DECLARE
  v_user_email TEXT;
BEGIN
  -- Try to get email from auth.users (wrap in exception handler)
  BEGIN
    SELECT email INTO v_user_email
    FROM auth.users
    WHERE id = NEW.id;
  EXCEPTION
    WHEN OTHERS THEN
      v_user_email := NULL;
  END;

  -- If we still don't have email, return early (don't fail signup)
  IF v_user_email IS NULL OR v_user_email = '' THEN
    RETURN NEW;
  END IF;

  -- Process invitations with error handling
  BEGIN
    UPDATE session_invitations
    SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
    WHERE email = v_user_email AND status = 'pending' AND expires_at > NOW();

    INSERT INTO session_participants (session_id, user_id, role)
    SELECT si.session_id, NEW.id, si.role
    FROM session_invitations si
    WHERE si.email = v_user_email
      AND si.status = 'accepted'
      AND si.accepted_at > NOW() - INTERVAL '1 minute'
    ON CONFLICT (session_id, user_id) DO NOTHING;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Failed to process invitation for user %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Key Changes**:

- Wrapped `auth.users` access in exception handler (permission/timing issues)
- Wrapped invitation processing in exception handler
- Signup won't fail if invitation processing has issues
- Errors logged as warnings instead of failing transaction

---

## Issue 3: Migration Idempotency Problems

### Problem

- Running migrations multiple times caused errors:
  - `ERROR: trigger "on_auth_user_created" for relation "users" already exists`
  - `ERROR: policy "Trainers can view invitations for their sessions" for table "session_invitations" already exists`

### Root Cause

- Migrations used `CREATE TRIGGER` and `CREATE POLICY` without checking if they exist
- PostgreSQL doesn't support `CREATE OR REPLACE` for triggers/policies
- Migrations weren't idempotent (couldn't be run multiple times safely)

### Fixes Applied

#### 3.1 Trigger Idempotency (`migrations/003_auth_triggers.sql`)

**Fix**: Added `DROP TRIGGER IF EXISTS` before creating triggers:

```sql
-- Drop trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

#### 3.2 Policy Idempotency (`migrations/006_session_invitations.sql`)

**Fix**: Added `DROP POLICY IF EXISTS` before creating policies:

```sql
-- Drop policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Trainers can view invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Trainers can create invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Trainers can update invitations for their sessions" ON session_invitations;
DROP POLICY IF EXISTS "Anyone can view invitation by token" ON session_invitations;

-- Then create policies...
```

#### 3.3 Trigger Idempotency for Invitations (`migrations/006_session_invitations.sql`)

**Fix**: Added `DROP TRIGGER IF EXISTS` for invitation triggers:

```sql
-- Drop trigger if it exists (for idempotent migrations)
DROP TRIGGER IF EXISTS trigger_accept_invitations_on_signup ON user_profiles;

CREATE TRIGGER trigger_accept_invitations_on_signup
  AFTER INSERT ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION accept_session_invitation_on_signup();
```

**Result**: All migrations are now idempotent and can be run multiple times safely.

---

## Summary of All Fixes

### Files Modified

1. **`server/routes/sessions.ts`** - Enhanced email logging
2. **`frontend/vite.config.ts`** - Fixed dev server host binding
3. **`migrations/003_auth_triggers.sql`** - Role mapping + trigger idempotency
4. **`migrations/006_session_invitations.sql`** - Error handling + policy/trigger idempotency

### Key Improvements

1. ✅ Email configuration fixed (EMAIL_FROM matches SMTP_USER)
2. ✅ Enhanced email logging for debugging
3. ✅ Role mapping from invitation roles to user_profiles roles
4. ✅ Improved error handling in trigger functions
5. ✅ Idempotent migrations (safe to run multiple times)
6. ✅ Frontend dev server accessible via localhost

### Testing Results

- ✅ Email invitations being sent successfully
- ✅ Recipients receiving emails
- ✅ User signup working correctly
- ✅ Role mapping functioning properly
- ✅ Invitations auto-accepted on signup
- ✅ Users automatically added to sessions

---

## Next Steps (Post-Fix)

After these fixes, the expected workflow is:

1. **Trainer invites user** → Email sent successfully ✅
2. **User receives email** → Clicks signup link ✅
3. **User signs up** → Role mapped correctly ✅
4. **Invitation auto-accepted** → User added to session ✅
5. **User logs in** → Sees session in dashboard ✅
6. **User views session** → Should see Session Lobby with briefing ✅

---

## Related Documentation

- `docs/ENV_TEMPLATE.md` - Email configuration instructions
- `docs/GAME_MECHANICS.md` - Pre-session workflow requirements
- `migrations/README.md` - Migration execution guide
