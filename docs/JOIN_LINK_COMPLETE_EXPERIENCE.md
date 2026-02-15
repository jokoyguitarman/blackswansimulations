# Join Link Flow -- Complete Experience with Security Hardening

This document describes the **complete, end-to-end experience** of the session join link feature as it will work once implemented with all security fixes applied. It walks through every screen, every API call, every guard, and every edge case -- from the trainer creating a session to a participant landing in the lobby and playing the simulation.

---

## Table of Contents

1. [Architecture at a Glance](#1-architecture-at-a-glance)
2. [Trainer Experience](#2-trainer-experience)
3. [Participant Experience (New, Anonymous)](#3-participant-experience-new-anonymous)
4. [Participant Experience (Existing Account)](#4-participant-experience-existing-account)
5. [Participant Experience (Already Invited by Email)](#5-participant-experience-already-invited-by-email)
6. [What Happens Under the Hood](#6-what-happens-under-the-hood)
7. [Error and Edge Case Experiences](#7-error-and-edge-case-experiences)
8. [Trainer Management After Participants Join](#8-trainer-management-after-participants-join)
9. [Security Measures the User Never Sees](#9-security-measures-the-user-never-sees)
10. [Data Lifecycle and Cleanup](#10-data-lifecycle-and-cleanup)

---

## 1. Architecture at a Glance

```
Trainer creates session
       |
       v
  join_token generated (20-char nanoid)
  join_enabled = true
  join_expires_at = session start + 2 hours
       |
       v
  Trainer copies link:  https://app.example.com/join/Xk9mB2vT4nRpL7wQ3jYs
       |
       v
  Shares via Slack, WhatsApp, email, printed handout, etc.
       |
       v
  Participant opens link in any browser
       |
       v
  GET /api/join/:joinToken  (no auth, rate-limited)
       |
       +--- Token invalid/expired/disabled --> "Link not valid" error page
       |
       v
  Join form loads: display name + team selector
       |
       v
  Participant fills form, clicks "Join Session"
       |
       +--- Not logged in --> signInAnonymously() creates account silently
       +--- Already logged in --> uses existing account
       |
       v
  POST /api/join/register  (auth required, rate-limited)
       |
       +--- Validates token, session status, team name, participant cap
       +--- Creates session_participants + session_teams rows
       +--- Updates user_profiles.full_name
       |
       v
  Redirect to /sessions/:sessionId  -->  Session Lobby
       |
       v
  Participant sees briefing, team info, READY button
  Trainer sees them appear in real-time via WebSocket
```

---

## 2. Trainer Experience

### 2.1 Creating a Session

The trainer experience starts exactly as it does today. Nothing changes about session creation except that a join link is now automatically generated behind the scenes.

1. **Trainer logs in** at the login page with their credentials.
2. **Trainer navigates to Scenarios**, selects a scenario (e.g., "Christmas Festival Terror Attack").
3. **Trainer clicks "Create Session"**, optionally sets a scheduled start time and trainer instructions.
4. **System creates the session** in the database. As part of this insert, the backend now also generates:
   - `join_token`: a 20-character cryptographically random string (nanoid).
   - `join_enabled`: set to `true`.
   - `join_expires_at`: set to the scheduled start time plus 2 hours, or 24 hours from now if no start time is set.
5. **Trainer is redirected to the Session View** (the lobby). Everything looks the same as before.

### 2.2 Viewing and Sharing the Join Link

On the Session View page, a new **"Join Link"** section appears in the session controls area (visible only to the trainer and admins, and only when the session is in a joinable state: `scheduled` or `in_progress`).

**What the trainer sees:**

```
+---------------------------------------------------------------+
|  JOIN LINK                                                     |
|                                                                |
|  https://app.example.com/join/Xk9mB2vT4nRpL7wQ3jYs           |
|                                                                |
|  [Copy Link]   [Regenerate]   [Disable Link]                  |
|                                                                |
|  Status: Active                                                |
|  Expires: 15 Feb 2026 at 14:00 SGT                            |
+---------------------------------------------------------------+
```

- **Copy Link** copies the URL to the clipboard. A brief "Copied!" toast confirms the action.
- **Regenerate** creates a brand-new `join_token`, invalidates the old one (sets `join_enabled = false` on the old record conceptually -- in practice, the token column is simply overwritten), and updates the expiry. This is the kill switch if a link is leaked to unintended recipients.
- **Disable Link** sets `join_enabled = false` on the session. The link stops working immediately. The button changes to "Enable Link" so the trainer can re-enable it.
- **Expiry** is shown in local time. The trainer can adjust it if needed (future enhancement).

The join link section is **not visible** when the session is `completed` or `cancelled`.

### 2.3 Session List View

On the Sessions list page, each session card in a joinable state shows a small link icon. Clicking it copies the join link to the clipboard directly from the list -- a convenience shortcut so the trainer does not need to open the session detail page to share a link.

### 2.4 Existing Flows Unchanged

- **Invite by Email**: Still works exactly as before. The trainer can enter an email address, assign a role, and the system sends an invitation email. If the user has not signed up yet, they get a signup link. This flow and the join link flow operate independently.
- **Add Participant**: The trainer can still manually add registered users from the user list. This is useful for assigning specific people to specific roles.
- **Team Assignment Modal**: Still available. The trainer can reassign teams for any participant regardless of how they joined.

---

## 3. Participant Experience (New, Anonymous)

This is the primary use case: a person who has never used the platform receives a join link from their trainer (e.g., via WhatsApp, a group chat, or a printed handout in a classroom).

### 3.1 Opening the Link

The participant clicks the link or pastes it into their browser:

```
https://app.example.com/join/Xk9mB2vT4nRpL7wQ3jYs
```

The browser navigates to the `/join/:joinToken` route. This page is **public** -- no login is required to view it.

### 3.2 Loading State

While the page loads, the participant sees a brief loading indicator in the app's military/terminal styling (consistent with the rest of the UI). Behind the scenes, the frontend makes a `GET /api/join/Xk9mB2vT4nRpL7wQ3jYs` request.

If everything is valid, the API returns minimal information:

- Session title (e.g., "Christmas Festival Response")
- List of available team names (e.g., "Alpha Command", "Bravo Response", "Charlie Medical")

Note: the scenario title and detailed descriptions are **not** exposed on this public endpoint. This prevents information leakage about the exercise setup to anyone who stumbles on or guesses a link.

### 3.3 The Join Form

The participant sees a single, clean page:

```
+---------------------------------------------------------------+
|                                                                |
|              CLASSIFIED // SIMULATION EXERCISE                 |
|                                                                |
|  +---------------------------------------------------------+  |
|  |                                                         |  |
|  |  SESSION: Christmas Festival Response                   |  |
|  |                                                         |  |
|  |  You have been invited to join this simulation.         |  |
|  |  Enter your details below to proceed.                   |  |
|  |                                                         |  |
|  |  Display Name *                                         |  |
|  |  +---------------------------------------------------+  |  |
|  |  | CPT James Lee                                     |  |  |
|  |  +---------------------------------------------------+  |  |
|  |  2-50 characters. Letters, numbers, spaces,             |  |
|  |  periods, hyphens, and apostrophes only.                |  |
|  |                                                         |  |
|  |  Team *                                                 |  |
|  |  +---------------------------------------------------+  |  |
|  |  | v  Select your team...                            |  |  |
|  |  |    Alpha Command                                  |  |  |
|  |  |    Bravo Response                                 |  |  |
|  |  |    Charlie Medical                                |  |  |
|  |  +---------------------------------------------------+  |  |
|  |                                                         |  |
|  |  +---------------------------------------------------+  |  |
|  |  |            [ JOIN SESSION ]                        |  |  |
|  |  +---------------------------------------------------+  |  |
|  |                                                         |  |
|  |  -------------------------------------------------      |  |
|  |  Optional: Link your email for account recovery         |  |
|  |  +---------------------------------------------------+  |  |
|  |  | your.email@example.com                            |  |  |
|  |  +---------------------------------------------------+  |  |
|  |  This is optional. If you don't link an email,          |  |
|  |  clearing your browser data will lose your account.     |  |
|  |                                                         |  |
|  +---------------------------------------------------------+  |
|                                                                |
|  Already have an account? [Log in instead]                     |
|                                                                |
+---------------------------------------------------------------+
```

**Key UI elements:**

- **Session title** is shown so the participant confirms they are joining the correct exercise.
- **Display Name** is a required text input. Validation enforces 2-50 characters, letters/numbers/spaces/periods/hyphens/apostrophes only. This prevents XSS payloads and excessively long names from reaching other participants' screens.
- **Team** is a required dropdown populated from the scenario's team definitions. The participant cannot type a free-form team name; they must select from the predefined list.
- **"Link your email"** is an optional field at the bottom. If the participant provides an email, the system calls `supabase.auth.updateUser({ email })` after account creation, which sends a confirmation email. This allows the participant to recover their account later if they clear browser data. A small note explains why this is useful.
- **"Log in instead"** link navigates to the standard login page, for participants who already have accounts and prefer to log in before joining.

### 3.4 Submitting the Form

When the participant clicks **"Join Session"**:

1. **Client-side validation** runs first. If the name is empty, too long, or contains invalid characters, or if no team is selected, the form shows inline error messages. The submit button is disabled during validation.

2. **Anonymous sign-in** happens silently. The frontend calls `supabase.auth.signInAnonymously()`. This creates a new user in `auth.users` with no email or password. The user receives a JWT token stored in the browser's local storage. The participant does not see a loading screen for this step -- it takes under a second.

   Behind the scenes, the Supabase `on_auth_user_created` trigger fires and creates a `user_profiles` row. Because the trigger detects that this is an anonymous provider (`raw_app_meta_data->>'provider' = 'anonymous'`), it assigns the role `participant` (not `trainer` -- this was a critical security fix). The `full_name` defaults to `'User'` temporarily.

3. **Registration API call**. The frontend calls `POST /api/join/register` with the anonymous user's JWT in the `Authorization` header and the body:

   ```json
   {
     "join_token": "Xk9mB2vT4nRpL7wQ3jYs",
     "display_name": "CPT James Lee",
     "team_name": "Alpha Command"
   }
   ```

4. **Server-side processing** (the participant sees a brief loading spinner during this):
   - Validates the JWT (anonymous or normal user).
   - Looks up the session by `join_token`.
   - Checks `join_enabled = true` and `join_expires_at` has not passed.
   - Checks the session status is `scheduled` or `in_progress`.
   - Checks the participant cap: counts current `session_participants` rows and compares against the sum of `max_participants` across all `scenario_teams`. If the session is full, returns a "Session is full" error.
   - Validates `team_name` exists in `scenario_teams` for this session's scenario.
   - Validates `display_name` against the server-side schema (same rules as client-side: 2-50 chars, safe characters only).
   - Updates `user_profiles.full_name` to the submitted display name.
   - Inserts into `session_participants` with `role = 'participant'` (uses `ON CONFLICT DO NOTHING` to handle race conditions).
   - Upserts into `session_teams` with the chosen team.
   - Returns `{ sessionId: "uuid-of-the-session" }`.

5. **Email linking** (if provided). If the participant entered an email, the frontend calls `supabase.auth.updateUser({ email })` after the register call succeeds. Supabase sends a confirmation email. The participant can click that link later to fully claim the account. This step is non-blocking -- the redirect proceeds immediately.

6. **Redirect**. The browser navigates to `/sessions/:sessionId`.

### 3.5 Arriving in the Session Lobby

The participant is now on the standard **Session View** page, which loads the **Session Lobby** component (because the session status is `scheduled`). This is the exact same lobby that email-invited participants see.

**What the participant sees:**

- **Mission Briefing**: The general briefing text for the scenario, plus any role-specific brief for the `participant` role if one exists.
- **Trainer Instructions**: If the trainer added custom instructions, they appear here.
- **Team Assignment**: The participant's team name ("Alpha Command") is shown. They cannot change it themselves -- only the trainer can reassign teams.
- **Participant List**: A list of all participants currently in the lobby, with their display names, teams, and ready status (green checkmark or grey circle).
- **READY Button**: A large button the participant clicks when they have read the briefing and are prepared to begin. This sets `is_ready = true` on their `session_participants` row and broadcasts the change to all other participants via WebSocket in real-time.
- **Scheduled Start Time**: If set by the trainer, shown as a countdown.

The lobby updates in real-time. As other participants join (via link, email invite, or manual add), they appear in the participant list without a page refresh.

### 3.6 Session Begins

When the trainer starts the session (changes status to `in_progress`), all participants are automatically transitioned from the lobby to the active simulation view. This works identically to the existing flow:

- The Common Operating Picture (COP) timeline appears.
- Chat channels become active.
- Inject events begin publishing according to the scenario schedule.
- Decision workflows become available.
- The resource marketplace activates.

The anonymous participant has full access to all participant features scoped to their session. They can:

- Send and receive chat messages.
- View and respond to injects.
- Propose and approve decisions.
- View incidents on the map.
- Manage resources allocated to their team.

They **cannot**:

- Create new sessions.
- Access other sessions.
- View the trainer's admin controls.
- See backend/AI activity logs.
- Manage other participants.

---

## 4. Participant Experience (Existing Account)

A participant who already has an account (e.g., from a previous exercise) receives the same join link and clicks it.

### 4.1 Opening the Link While Logged In

If the participant is already logged in to the app in their browser, the join page detects this via `AuthContext`. The form still appears, but:

- The **Display Name** field is pre-filled with their existing `full_name` from `user_profiles`. They can change it if they want.
- The **"Link your email"** section is hidden (they already have a full account).
- The **"Log in instead"** link is hidden (they are already logged in).

### 4.2 Submitting the Form

When they click "Join Session":

1. **No anonymous sign-in needed.** The frontend skips `signInAnonymously()` because the user already has a valid session.
2. The `POST /api/join/register` call uses their existing JWT.
3. The backend processes the request identically -- adds them to `session_participants` and `session_teams`.
4. Their existing `user_profiles.full_name` is updated only if they changed it in the form.
5. Redirect to the lobby.

### 4.3 Opening the Link While Logged Out

If the participant is not logged in but has an existing account, they see the full join form with the "Log in instead" link at the bottom. They have two choices:

- **Join anonymously**: Fill the form and submit. This creates a _new_ anonymous account separate from their existing one. They will appear as a different user in the session. (This is by design -- if they don't log in, the system has no way to know they have an existing account.)
- **Log in first**: Click "Log in instead", authenticate with their credentials, then return to the join link. Now the flow follows Section 4.1 above.

---

## 5. Participant Experience (Already Invited by Email)

A participant who was previously invited by email (and is now a `session_participants` row) opens the join link.

### 5.1 What They See

The join form loads normally. If they are logged in, their name is pre-filled.

### 5.2 What Happens on Submit

The `POST /api/join/register` endpoint detects that a `session_participants` row already exists for this `(session_id, user_id)` pair. In this case:

- **Their role is NOT overwritten.** The trainer assigned them a specific role via the invite (e.g., `defence`). The join link does not change it.
- **Their team assignment is NOT overwritten** if one already exists. If the trainer already assigned them to a team via the Team Assignment Modal, that assignment is preserved.
- **Their display name IS updated** if they changed it on the form.
- The endpoint returns `{ sessionId }` and the participant is redirected to the lobby as normal.

This means the join link is safe to share broadly -- even people who were already invited will not have their trainer-assigned roles disrupted.

---

## 6. What Happens Under the Hood

### 6.1 Database Changes (Migration)

The `sessions` table gains three new columns:

| Column            | Type                          | Default                  | Description                                   |
| ----------------- | ----------------------------- | ------------------------ | --------------------------------------------- |
| `join_token`      | `VARCHAR(20) UNIQUE NOT NULL` | Generated on insert      | 20-character nanoid, cryptographically random |
| `join_enabled`    | `BOOLEAN NOT NULL`            | `true`                   | Trainer can disable the link                  |
| `join_expires_at` | `TIMESTAMPTZ`                 | Computed from start time | After this timestamp, the link stops working  |

Existing sessions are backfilled with tokens in a separate migration step before the `NOT NULL` constraint is applied.

### 6.2 Auth Trigger Update

The `handle_new_user()` function in the database is updated to detect anonymous sign-ups:

```sql
-- If this is an anonymous user, assign 'participant' role
IF NEW.raw_app_meta_data->>'provider' = 'anonymous' THEN
  v_role := 'participant';
ELSE
  -- Existing role-mapping logic for normal sign-ups
  v_role := COALESCE(NEW.raw_user_meta_data->>'role', 'trainer');
  -- ... CASE statement for role mapping ...
END IF;
```

This prevents anonymous users from receiving the `trainer` role, which would grant them access to all sessions and administrative functions.

### 6.3 RLS Policy Impact

All database operations in the join flow use `supabaseAdmin` (the service role client), which bypasses Row Level Security. This is intentional because:

- The anonymous user's JWT has a `participant` role, which has limited RLS permissions.
- The server validates all access rules in application code before performing writes.
- After joining, when the participant uses the frontend (which uses the anon-key Supabase client respecting RLS), the existing RLS policies correctly scope their access to the session they joined.

The `session_invitations` table's overly permissive `USING (true)` SELECT policy is tightened to restrict anonymous users from querying all invitations.

### 6.4 API Flow Diagram

```
Browser                       Server                         Database
  |                              |                              |
  |  GET /api/join/:token        |                              |
  |  (no auth)                   |                              |
  |----------------------------->|                              |
  |                              |  Check rate limit (IP)       |
  |                              |  SELECT session by token     |
  |                              |------------------------------>|
  |                              |  Check join_enabled,         |
  |                              |  join_expires_at, status     |
  |                              |  SELECT scenario_teams       |
  |                              |------------------------------>|
  |  { sessionTitle, teams[] }   |                              |
  |<-----------------------------|                              |
  |                              |                              |
  |  signInAnonymously()         |                              |
  |  (Supabase client-side)      |                              |
  |----------------------------->|  Supabase Auth               |
  |  JWT token                   |                              |
  |<-----------------------------|                              |
  |                              |                              |
  |  POST /api/join/register     |                              |
  |  Authorization: Bearer JWT   |                              |
  |  { token, name, team }       |                              |
  |----------------------------->|                              |
  |                              |  Validate JWT (requireAuth)  |
  |                              |  Check rate limit (user ID)  |
  |                              |  Validate body (Zod)         |
  |                              |  SELECT session by token     |
  |                              |------------------------------>|
  |                              |  Check enabled, expiry,      |
  |                              |  status, participant cap     |
  |                              |  Validate team_name in       |
  |                              |  scenario_teams              |
  |                              |------------------------------>|
  |                              |  UPDATE user_profiles        |
  |                              |  (full_name)                 |
  |                              |------------------------------>|
  |                              |  INSERT session_participants |
  |                              |  ON CONFLICT DO NOTHING      |
  |                              |------------------------------>|
  |                              |  UPSERT session_teams        |
  |                              |------------------------------>|
  |                              |  WebSocket: broadcast        |
  |                              |  participant_joined event    |
  |  { sessionId }               |                              |
  |<-----------------------------|                              |
  |                              |                              |
  |  navigate(/sessions/:id)     |                              |
  |                              |                              |
```

---

## 7. Error and Edge Case Experiences

### 7.1 Invalid or Expired Link

**What the participant sees:**

```
+---------------------------------------------------------------+
|                                                                |
|              LINK NOT VALID                                    |
|                                                                |
|  This join link is invalid, has expired, or has been           |
|  disabled by the trainer.                                      |
|                                                                |
|  Please contact your trainer for a new link.                   |
|                                                                |
|  [Go to Login]                                                 |
|                                                                |
+---------------------------------------------------------------+
```

This page appears when:

- The `join_token` does not match any session.
- `join_enabled` is `false` (trainer disabled the link).
- `join_expires_at` has passed.
- The session status is `completed` or `cancelled`.

The error message is intentionally vague -- it does not reveal whether the token was real but expired vs. never existed. This prevents enumeration.

### 7.2 Session Is Full

If the number of participants has reached the capacity derived from `scenario_teams.max_participants`, the register endpoint returns a 409 Conflict.

**What the participant sees:**

```
+---------------------------------------------------------------+
|                                                                |
|  SESSION FULL                                                  |
|                                                                |
|  This session has reached its maximum number of                |
|  participants. Please contact your trainer.                    |
|                                                                |
|  [Go to Login]                                                 |
|                                                                |
+---------------------------------------------------------------+
```

### 7.3 Invalid Display Name

If the participant enters a name with special characters (e.g., `<script>alert(1)</script>`), client-side validation catches it immediately:

> "Display name can only contain letters, numbers, spaces, periods, hyphens, and apostrophes."

If somehow the client-side validation is bypassed (e.g., API call from curl), the server-side Zod schema rejects the request with a 400 error.

### 7.4 Rejoining (Same Browser, Same Link)

If a participant opens the join link again in the same browser after already joining:

1. They are still authenticated (anonymous JWT in local storage).
2. The join form loads and shows their existing display name pre-filled.
3. If they submit again, the register endpoint detects the existing `session_participants` row and responds idempotently -- no duplicate is created, the response is `{ sessionId }`, and they are redirected to the lobby.
4. If they are already in the lobby in another tab, this has no side effects.

### 7.5 Lost Browser Session (Anonymous User)

If a participant clears their browser data or switches devices:

1. Their anonymous JWT is gone. They have no way to re-authenticate as that anonymous user.
2. If they open the join link again, they will create a **new** anonymous account and appear as a second participant.
3. The trainer will see two entries in the participant list: the old one (offline/not ready) and the new one.
4. The trainer can remove the orphaned entry using the existing "Remove participant" function.
5. **Mitigation**: If the participant linked their email during the original join (Section 3.3), they can log in with that email, and the system will use their original account.

### 7.6 Link Shared Publicly by Mistake

If a join link is posted on social media or otherwise leaked:

1. The trainer notices unexpected participants in the lobby.
2. The trainer clicks **"Regenerate"** on the join link section. This instantly creates a new token. The old link stops working.
3. The trainer clicks **"Disable Link"** if they want to stop all link-based joining entirely.
4. The trainer can remove any unauthorized participants from the session.
5. Legitimate participants who have not yet joined will need the new link.

The **participant cap** also limits the damage: even if hundreds of people click the leaked link, only the configured maximum can actually join.

### 7.7 Network Error During Join

If the `POST /api/join/register` call fails due to a network error:

1. The form shows an error message: "Failed to join session. Please check your connection and try again."
2. The participant's anonymous account has already been created (from step 2 of the submit flow), but they are not yet registered as a participant.
3. They can click "Join Session" again. The anonymous JWT is still valid in their browser. The register call will retry and succeed.
4. There is no risk of duplicate accounts from retrying because the anonymous sign-in is skipped on subsequent attempts (the user is already authenticated).

---

## 8. Trainer Management After Participants Join

### 8.1 Real-Time Participant List

As participants join via the link, the trainer's lobby updates in real-time via WebSocket. Each new participant appears in the participant list with:

- Their display name (e.g., "CPT James Lee")
- Their team (e.g., "Alpha Command")
- Their role (`participant` for link-joined users)
- Their ready status (initially not ready)

The trainer can distinguish link-joined participants from email-invited ones by their role: link-joined users have the generic `participant` role, while email-invited users have specific roles like `defence_liaison` or `health_director`.

### 8.2 Reassigning Teams and Roles

The trainer can use the **Team Assignment Modal** to:

- Move a participant to a different team.
- Assign a specific team role.
- These changes are saved to `session_teams` and reflected in the participant's view in real-time.

The trainer can also use the **Participant Management** panel to:

- Change a participant's session role (from generic `participant` to a specific role like `defence`).
- Remove a participant entirely (useful for removing unauthorized joiners or orphaned anonymous accounts).

### 8.3 Starting the Session

The trainer can start the session when ready. The start flow is unchanged:

1. Trainer reviews participant list and ready statuses.
2. Optionally waits for all participants to mark READY.
3. Clicks "Start Session" to change status to `in_progress`.
4. All participants are transitioned to the active simulation view.
5. The join link continues to work during `in_progress` (late joiners can still enter) unless the trainer disables it.

---

## 9. Security Measures the User Never Sees

These protections run silently in the background. Neither the trainer nor the participant interacts with them directly.

### 9.1 Token Strength

The `join_token` is a 20-character string generated using `nanoid` with a URL-safe alphabet (A-Z, a-z, 0-9, hyphen, underscore -- 64 characters). This provides approximately 120 bits of entropy, making brute-force guessing computationally infeasible.

For comparison:

- 12-character token = ~72 bits (original plan) -- crackable with sustained effort.
- 20-character token = ~120 bits (hardened) -- equivalent strength to a UUID.

### 9.2 Rate Limiting

Two layers of rate limiting protect the join endpoints:

| Endpoint                   | Limit                    | Key                | Purpose                            |
| -------------------------- | ------------------------ | ------------------ | ---------------------------------- |
| `GET /api/join/:joinToken` | 10 requests per minute   | IP address         | Prevents token enumeration         |
| `POST /api/join/register`  | 5 requests per minute    | User ID (from JWT) | Prevents mass account registration |
| Global `/api/*`            | 10,000 per 15 min (prod) | User ID or IP      | Existing protection                |

The join-specific rate limiters are layered on top of the global limiter. An attacker hitting the GET endpoint from a single IP would be blocked after 10 attempts in a minute. Distributed attacks across many IPs are mitigated by the token entropy (120 bits).

### 9.3 Anonymous User Role Isolation

When an anonymous user is created via `signInAnonymously()`, the database trigger assigns them the `participant` role. This role has the following RLS permissions:

- **Can view**: Only sessions they are a participant of, and related data (chat messages, decisions, injects, etc.) scoped to those sessions.
- **Can create**: Chat messages and decisions in their sessions, incidents in their sessions.
- **Cannot view**: Other sessions, other users' profiles (except co-participants), trainer-only data.
- **Cannot modify**: Session status, other participants, scenarios, team definitions.

### 9.4 Input Sanitization

All user-provided input is validated at two levels:

1. **Client-side** (Zod schema in the React component): Immediate feedback, prevents form submission.
2. **Server-side** (Zod schema in Express middleware): Rejects malformed requests with 400 status.

The `display_name` schema:

```
- Trimmed of leading/trailing whitespace
- Minimum 2 characters
- Maximum 50 characters
- Matches pattern: /^[a-zA-Z0-9 .'\-]+$/
- No HTML, no script tags, no Unicode control characters
```

The `team_name` is validated against the actual `scenario_teams` rows in the database. Free-form team names are rejected.

### 9.5 Constant-Time Error Responses

The `GET /api/join/:joinToken` endpoint returns the same 404 response structure and HTTP status for all failure cases:

- Token does not exist.
- Token exists but `join_enabled` is `false`.
- Token exists but `join_expires_at` has passed.
- Token exists but session is `completed`/`cancelled`.

This prevents timing attacks that could distinguish between "token exists but expired" vs. "token never existed."

### 9.6 Service Role for Writes

All database writes in the register endpoint use `supabaseAdmin` (the Supabase service role client), which bypasses RLS. This is intentional:

- Anonymous users have very limited RLS permissions by design.
- The server validates all business rules (token validity, session status, team membership, participant cap) in application code before performing any write.
- This pattern is consistent with the existing invitation and participant-add flows.

### 9.7 Request Body Size

The join endpoints enforce a 1KB body size limit (vs. the global 10MB limit). A join request body is approximately 100-200 bytes. The 1KB limit prevents abuse where an attacker sends large payloads to consume server memory.

---

## 10. Data Lifecycle and Cleanup

### 10.1 Anonymous User Profiles

Over time, anonymous users who joined via links will accumulate `user_profiles` rows. These are managed as follows:

- **Active participants**: Their profiles are indistinguishable from normal users during a session. They have a `full_name`, a `role` of `participant`, and `agency_name` of `Unknown`.
- **After session ends**: Their profiles remain in the database. If they linked an email, they become normal users who can log in for future sessions.
- **Orphaned profiles**: Anonymous users who never completed the join flow (created an account but never registered as a participant) are cleaned up by a scheduled database job that runs weekly:

  ```
  Delete from user_profiles WHERE:
    - role = 'participant'
    - id is in auth.users with provider = 'anonymous'
    - id is NOT in any session_participants row
    - created_at is older than 7 days
  ```

  Corresponding `auth.users` rows are also deleted via the Supabase admin API.

### 10.2 Expired Join Tokens

Join tokens remain in the `sessions` table permanently (they are a column on the session row, not a separate table). There is no need to clean them up because:

- Expired tokens are rejected at query time by checking `join_expires_at`.
- Disabled tokens are rejected by checking `join_enabled`.
- The token is overwritten when a trainer clicks "Regenerate."

### 10.3 Session Participants After Session Ends

When a session is `completed` or `cancelled`:

- All `session_participants` rows remain for the After-Action Review (AAR).
- The join link stops working (session status check).
- Anonymous users can still access the AAR if they have not cleared their browser data.

---

## Summary: What Changed vs. What Stayed the Same

| Aspect                              | Before                          | After                                                                        |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| **How participants join**           | Email invite or manual add only | Email invite, manual add, **or join link**                                   |
| **Authentication required to join** | Yes (must have account)         | No (anonymous sign-in via link)                                              |
| **Team selection**                  | Trainer assigns teams           | Trainer assigns teams **or** participant self-selects via link               |
| **Session lobby**                   | Unchanged                       | Unchanged (same component, same WebSocket, same READY flow)                  |
| **In-session experience**           | Unchanged                       | Unchanged                                                                    |
| **Trainer controls**                | Invite, add, manage teams       | Invite, add, manage teams, **copy/disable/regenerate join link**             |
| **Session creation**                | Creates session only            | Creates session **+ generates join token**                                   |
| **Security model**                  | JWT + RLS + rate limiting       | Same **+ anonymous role isolation + token rate limiting + participant caps** |
| **Email invitation flow**           | Unchanged                       | Unchanged                                                                    |
| **Add participant flow**            | Unchanged                       | Unchanged                                                                    |
| **Team Assignment Modal**           | Unchanged                       | Unchanged                                                                    |
| **After-Action Review**             | Unchanged                       | Unchanged                                                                    |
