# C2E Bombing Scenario Demo

This folder contains a pre-configured demo scenario based on the "C2E Bombing at Community Event" document.

## What's Included

- **Complete scenario** with all objectives and briefing
- **3 pre-configured teams**: Evacuation, Triage, Media/Communications
- **15 pre-configured injects** (6 universal + 9 team-specific)
- **Realistic timeline** matching the document (T+0 to T+15)

## Setup Instructions

### 1. Run the Seed Script

Open your Supabase SQL Editor and run:

```
demo/seed_c2e_scenario.sql
```

This will create:

- The C2E scenario
- Team definitions
- All 15 injects with proper scoping
- Ready to use immediately

### 2. Create a Session

1. Log in as a trainer/admin
2. Go to Scenarios
3. Find "C2E Bombing at Community Event"
4. Click "Create Session"
5. Invite participants

### 3. Assign Teams

1. Go to the session
2. Click "Participants" tab
3. Click "Manage Teams"
4. Assign users to:
   - **Evacuation Team**
   - **Triage Team**
   - **Media/Communications Team**

### 4. Start the Demo

1. Start the session
2. Watch injects trigger automatically at T+0, T+5, T+6, etc.
3. Switch between team views to see information gaps

## Demo Flow

### T+0: Initial Explosion

- **Universal**: Everyone sees the explosion
- Creates panic and confusion

### T+5: Fragmented Reports

- **Universal**: Conflicting volunteer reports
- Sets up fog of war

### T+6: Team-Specific Issues

- **Evacuation**: Exit congestion
- **Triage**: Unclear casualty count

### T+9: Media Misinformation

- **Media Team**: Fake voice note circulating

### T+10: Escalation

- **Universal**: Emergency services delayed
- **Universal**: Viral video with racial accusations

### T+11: Team Coordination Needed

- **Evacuation**: Request to segregate (requires coordination)
- **Media**: Amplified online claims

### T+12: Media Pressure

- **Universal**: Journalist arrives
- **Triage**: Filming at triage area
- **Media**: Press demands confirmation

### T+14: Security Threat

- **Evacuation**: Suspicious individual (suicide attacker)

### T+15: Crisis Peak

- **Universal**: Crowd tension escalation
- **Triage**: Patient accusations
- Requires multi-team coordination

## Information Gaps by Team

### Evacuation Team Sees:

- ✅ Exit congestion issues
- ✅ Segregation requests
- ✅ Suspicious individual
- ❌ Casualty details
- ❌ Media misinformation details
- ❌ Triage status

### Triage Team Sees:

- ✅ Casualty count issues
- ✅ Filming problems
- ✅ Patient accusations
- ❌ Evacuation bottlenecks
- ❌ Media misinformation
- ❌ Security threats

### Media Team Sees:

- ✅ Fake voice notes
- ✅ Amplified claims
- ✅ Press demands
- ❌ Evacuation details
- ❌ Casualty specifics
- ❌ Security threats

## Reset Session (Create Fresh Session)

If you want to start fresh with a new session (useful for testing with friends):

```sql
-- Run this in Supabase SQL Editor
demo/reset_c2e_session.sql
```

This script will:

- Create a new session with the C2E scenario
- Set up default channels (Command, Public, Trainer)
- Reset to initial scenario state
- Optionally cancel old sessions (commented out by default)

After running, go to the Sessions page and you'll see your new session ready to use!

## Cleanup

To remove the demo scenario (if needed):

```sql
-- Delete the scenario (this will cascade delete injects and teams)
DELETE FROM scenarios WHERE title = 'C2E Bombing at Community Event';
```

To remove old sessions (they will cascade delete related data):

```sql
-- Delete all C2E sessions (be careful!)
DELETE FROM sessions
WHERE scenario_id IN (
  SELECT id FROM scenarios WHERE title = 'C2E Bombing at Community Event'
);
```

## Notes

- The scenario is **reusable** - you can create multiple sessions from it
- All injects are **time-based** and will trigger automatically
- Team assignments are **per-session** - assign teams for each new session
- The scenario is **inactive by default** - activate it if needed

## Demo Presentation Tips

1. **Show the scenario overview** first
2. **Assign teams** to demo users
3. **Start session** and let it run
4. **Switch between team views** to show information gaps
5. **Highlight coordination needs** when injects require it
6. **Show timeline** to demonstrate automatic triggering
