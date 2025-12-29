# Pre-Session Workflow Implementation

## Overview

Complete implementation of the pre-session participant workflow as specified in GAME_MECHANICS.md, including email invitations, briefing materials, session lobby, ready status, and trainer instructions.

## Features Implemented

### ✅ 1. Email Invitations (Gmail SMTP)

**Backend:**

- `server/services/emailService.ts` - Nodemailer-based email service
- Sends plain text invitation emails when participants are added
- Configurable via `.env` (can disable for development)
- Non-blocking email sending (doesn't fail if email service is down)

**Configuration:**

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password
EMAIL_FROM=noreply@simulator.local
EMAIL_FROM_NAME=Simulation Environment
```

**Email Content:**

- Session title
- Scenario title
- Assigned role
- Scheduled start time (if set)
- Trainer name
- Direct link to join session

### ✅ 2. Mission Briefs Viewing

**Database:**

- `scenarios.briefing` - General briefing for all participants
- `scenarios.role_specific_briefs` - JSONB object with role-specific briefs

**Backend:**

- `GET /api/briefing/session/:id` - Returns general + role-specific briefing
- Automatically filters role-specific briefs based on participant's assigned role

**Frontend:**

- `BriefingView` component displays briefing materials
- Shows general briefing to all participants
- Shows role-specific briefing if available for participant's role
- Integrated into SessionLobby component

### ✅ 3. Session Lobby (Pre-Session)

**Features:**

- **Briefing + Instructions Only** - No chat to prevent pre-game planning
- **Trainer Instructions** - Prominently displayed
- **Scheduled Start Time** - Countdown timer (if set)
- **Ready Status** - Participants mark themselves ready
- **Participant List** - Shows who's in lobby (trainer view)
- **Start Button** - Trainer can start when all ready (or early if needed)

**UI Components:**

- `SessionLobby` - Main lobby component
- `BriefingView` - Displays briefing materials
- Auto-shown when session status = `scheduled`
- Replaces normal SessionView until session starts

### ✅ 4. Ready Status (Required Before Start)

**Backend:**

- `POST /api/sessions/:id/ready` - Mark participant as ready/unready
- `GET /api/sessions/:id/ready-status` - Get ready status (trainer only)
- Tracks `is_ready` and `joined_lobby_at` in `session_participants`

**Frontend:**

- Participants click `[MARK_AS_READY]` button
- Trainer sees ready count: "X / Y Ready"
- Trainer's `[START_SESSION]` button disabled until all ready
- Real-time updates via polling (every 3 seconds)

### ✅ 5. Trainer Instructions

**Database:**

- `sessions.trainer_instructions` - Text field for final instructions

**Backend:**

- Can be set when creating session
- Can be updated via `PATCH /api/sessions/:id`

**Frontend:**

- Displayed prominently in lobby
- Trainer can edit instructions in session view (if needed)

### ✅ 6. Scheduled Start Time & Early Start

**Database:**

- `sessions.scheduled_start_time` - Planned start time

**Features:**

- Displayed in invitation email
- Shown in lobby with countdown
- Trainer can start early (no enforcement)
- Early start allowed - trainer has full control

### ✅ 7. Chat During Game (Already Implemented)

- Chat functionality exists in SessionView
- Only available when session status = `in_progress`
- Not available in lobby (as requested)

## Database Migration

**File:** `migrations/005_pre_session_workflow.sql`

**Changes:**

- Added `briefing` and `role_specific_briefs` to `scenarios`
- Added `trainer_instructions` and `scheduled_start_time` to `sessions`
- Added `is_ready` and `joined_lobby_at` to `session_participants`
- Created index for ready status queries

## API Endpoints

### Sessions

- `POST /api/sessions/:id/participants` - Add participant (sends email)
- `POST /api/sessions/:id/ready` - Mark ready/unready
- `GET /api/sessions/:id/ready-status` - Get ready status (trainer)
- `PATCH /api/sessions/:id` - Update instructions/start time

### Briefing

- `GET /api/briefing/session/:id` - Get briefing materials

### Scenarios

- `POST /api/scenarios` - Now includes `briefing` and `role_specific_briefs`

## Frontend Components

### New Components

- `frontend/src/components/Session/SessionLobby.tsx` - Pre-session lobby
- `frontend/src/components/Session/BriefingView.tsx` - Briefing display
- `frontend/src/components/Forms/CreateSessionModal.tsx` - Enhanced session creation

### Updated Components

- `CreateScenarioForm.tsx` - Added briefing fields (general + role-specific)
- `SessionView.tsx` - Shows lobby when status = `scheduled`
- `Sessions.tsx` - Uses new CreateSessionModal

## User Flow

1. **Trainer Creates Session**
   - Selects scenario
   - Optionally sets scheduled start time
   - Optionally adds trainer instructions
   - Creates session

2. **Trainer Adds Participants**
   - Adds participants via `[PARTICIPANTS]` tab
   - System automatically sends invitation emails
   - Participants receive email with session link

3. **Participant Receives Invitation**
   - Clicks link in email
   - Logs in (if not already)
   - Sees Session Lobby

4. **Participant in Lobby**
   - Reviews general briefing
   - Reviews role-specific briefing (if available)
   - Reads trainer instructions
   - Clicks `[MARK_AS_READY]` when ready

5. **Trainer Monitors Lobby**
   - Sees participant list
   - Sees ready status for each participant
   - `[START_SESSION]` button enabled when all ready
   - Can start early if needed

6. **Session Starts**
   - Trainer clicks `[START_SESSION]`
   - Status changes to `in_progress`
   - All participants see normal SessionView
   - Chat and all game features become available

## Gmail Setup Instructions

1. Enable 2-Factor Authentication on your Gmail account
2. Go to [Google Account Settings > App Passwords](https://myaccount.google.com/apppasswords)
3. Generate an "App Password" for "Mail"
4. Add to `.env`:
   ```env
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-16-character-app-password
   ```

## Testing Checklist

- [ ] Run migration `005_pre_session_workflow.sql` in Supabase
- [ ] Configure Gmail SMTP in `.env`
- [ ] Create scenario with briefing materials
- [ ] Create session with scheduled time and instructions
- [ ] Add participant → verify email sent
- [ ] Participant joins lobby → verify briefing visible
- [ ] Participant marks ready → verify status updates
- [ ] Trainer sees ready status → verify all ready check
- [ ] Trainer starts session → verify lobby disappears
- [ ] Chat available during game → verify chat tab works

## Notes

- Email sending is non-blocking - session creation succeeds even if email fails
- If `EMAIL_ENABLED=false`, emails are logged to console instead
- Ready status polls every 3 seconds (can be optimized with WebSocket later)
- Lobby has no chat to prevent pre-game planning
- Trainer can start session early regardless of scheduled time
- All participants must be ready before trainer can start (enforced in UI)
