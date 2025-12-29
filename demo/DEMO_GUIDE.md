# C2E Bombing Scenario - Demo Guide

## Quick Start

1. **Run the seed script** in Supabase SQL Editor: `seed_c2e_scenario.sql`
2. **Create a session** from the scenario
3. **Assign teams** to participants
4. **Start the session** and watch it unfold

## Demo Script

### Pre-Demo Setup (5 minutes)

1. **Show the scenario overview**
   - Open Scenarios page
   - Show "C2E Bombing at Community Event"
   - Highlight: 15 injects, 3 teams, advanced difficulty

2. **Create a session**
   - Click "Create Session"
   - Invite 3-6 demo participants
   - Show session dashboard

3. **Assign teams**
   - Go to Participants tab
   - Click "Manage Teams"
   - Assign:
     - 2-3 people to **Evacuation Team**
     - 2-3 people to **Triage Team**
     - 1-2 people to **Media/Communications Team**

### Live Demo (15-20 minutes)

#### T+0: Initial Explosion

**What to show:**

- Universal inject appears to everyone
- Panic and confusion
- "Extent of casualties unknown"

**Key point:** Everyone sees the same initial event

#### T+5: Fragmented Reports

**What to show:**

- Universal inject with conflicting reports
- "No two accounts match"
- Sets up information uncertainty

**Key point:** Information gaps begin

#### T+6: Team-Specific Issues

**What to show:**

- **Switch to Evacuation Team view**: They see "Exit Congestion"
- **Switch to Triage Team view**: They see "Unclear Casualty Count"
- **Switch to Media Team view**: They don't see these yet

**Key point:** Teams now have different information

#### T+9: Media Misinformation

**What to show:**

- **Media Team only**: "Fake Voice Note" about second bomb
- Other teams don't see this
- Media team must decide how to respond

**Key point:** Team-specific information creates coordination needs

#### T+10: Escalation

**What to show:**

- **Everyone**: Emergency services delayed
- **Everyone**: Viral video with racial accusations
- Show how misinformation spreads

**Key point:** Universal crisis + team-specific challenges

#### T+11: Coordination Required

**What to show:**

- **Evacuation Team**: "Request to Segregate Malays" (requires coordination)
- **Media Team**: "Amplified Online Claims" (requires counter-narrative)
- Show how teams need to communicate

**Key point:** Teams must coordinate despite information gaps

#### T+12: Media Pressure

**What to show:**

- **Everyone**: Journalist arrives
- **Triage Team**: Filming at triage area
- **Media Team**: Press demands confirmation
- Show conflicting priorities

**Key point:** Multiple simultaneous challenges

#### T+14: Security Threat

**What to show:**

- **Evacuation Team only**: Suspicious individual (suicide attacker)
- Other teams don't know about this threat
- Evacuation team must decide: coordinate or act alone?

**Key point:** Critical information only to one team

#### T+15: Crisis Peak

**What to show:**

- **Everyone**: Crowd tension escalation
- **Triage Team**: Patient accusations
- Show how all teams are affected differently

**Key point:** Multi-team coordination essential

### Post-Demo Discussion (5 minutes)

1. **Show information gaps**
   - Display what each team saw
   - Highlight missing information
   - Discuss coordination challenges

2. **Highlight features**
   - Automatic time-based triggers
   - Team-specific information delivery
   - Information gaps and fog of war
   - Coordination requirements

3. **Future enhancements**
   - Phase 2: Conflicting reports, incomplete information
   - Phase 2: Volunteer cards, zone-specific info
   - Phase 2: Decision-dependent triggers

## Demo Tips

### For Best Effect:

1. **Use multiple screens/devices**
   - Show different team views simultaneously
   - Highlight information gaps visually

2. **Have participants role-play**
   - Let them react to their team-specific injects
   - Show how they need to coordinate

3. **Pause at key moments**
   - T+6: Show team-specific divergence
   - T+11: Show coordination needs
   - T+14: Show critical information gap

4. **Use the timeline**
   - Show when injects trigger
   - Demonstrate automatic progression
   - Highlight coordination points

### Common Questions:

**Q: Can teams communicate?**
A: Yes, via chat/channels (existing feature)

**Q: Can trainers see everything?**
A: Yes, trainers see all injects regardless of team

**Q: What if a team misses an inject?**
A: Injects remain visible in their feed

**Q: Can injects be triggered manually?**
A: Yes, trainers can publish injects manually

**Q: How do teams coordinate?**
A: Through chat, decisions, and resource marketplace (existing features)

## Troubleshooting

### Scenario not appearing?

- Check if seed script ran successfully
- Verify user has trainer/admin role
- Check `is_active` flag

### Injects not triggering?

- Verify session is `in_progress`
- Check `start_time` is set
- Verify inject scheduler is running

### Teams not filtering?

- Verify team assignments in session
- Check `inject_scope` is set correctly
- Verify `target_teams` array matches team names

### Participants can't see injects?

- Check team assignments
- Verify inject scope (universal vs team-specific)
- Check user's role matches `affected_roles` (if role-specific)
