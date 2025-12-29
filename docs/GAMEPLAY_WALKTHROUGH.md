# Gameplay Walkthrough: Christmas Festival Terror Attack

## Scenario Overview

**Title:** Christmas Festival Terror Attack  
**Category:** Custom  
**Difficulty:** Intermediate  
**Duration:** 60 minutes  
**Status:** Active

**Description:**
As the vibrant Christmas Festival at Suntec City in Singapore is in full swing, attracting thousands of families and tourists, intelligence reports indicate a credible threat of a terrorist attack. A car bomb has been identified as the weapon of choice, with potential mass casualties and structural damage in a highly populated area.

**Objectives:**

1. Establish a multi-agency command center for coordinated response
2. Evacuate civilians and secure the perimeter around the incident site
3. Provide medical assistance to the injured and manage public communication

---

## Phase 1: Trainer Setup (15 minutes before session)

### Step 1: Trainer Logs In

**Action:** Trainer opens browser → Navigates to `http://localhost:3000` → Clicks **"Login"** button

**UI Flow:**

- Login page appears
- Trainer enters email: `trainer@simulator.local`
- Clicks **"Send Magic Link"**
- Checks email, clicks magic link
- Redirected to dashboard

**Result:** Trainer sees dashboard with:

- **Scenarios** tab (left sidebar)
- **Sessions** tab
- **Analytics** tab
- **Profile** icon (top right)

---

### Step 2: Trainer Creates/Selects Scenario

**Action:** Trainer clicks **"Scenarios"** tab → Clicks **"Create New Scenario"** button

**UI Flow:**

- Modal opens: "Create New Scenario"
- Trainer fills in:
  - **Title:** `Christmas Festival Terror Attack`
  - **Category:** Selects `Custom` from dropdown
  - **Difficulty:** Selects `Intermediate` from dropdown
  - **Duration:** Enters `60` minutes
  - **Description:** Pastes scenario description
  - **Objectives:**
    - Clicks **"Add Objective"** → Enters "Establish multi-agency command center"
    - Clicks **"Add Objective"** → Enters "Evacuate civilians and secure perimeter"
    - Clicks **"Add Objective"** → Enters "Provide medical assistance and manage public communication"

**AI Scenario Generator (Optional):**

- Trainer clicks **"Generate with AI"** button
- Enters prompt: "Terror attack at Christmas festival in Singapore, car bomb threat, thousands of civilians"
- AI generates detailed scenario with:
  - Expanded description
  - Suggested objectives
  - Role-specific briefings
  - Suggested injects
- Trainer reviews, edits, and clicks **"Use This Scenario"**

**Briefing Materials:**

- Trainer scrolls to **"Briefing"** section
- Enters general briefing:
  ```
  GENERAL BRIEFING:
  Suntec City Christmas Festival is currently in full swing with approximately
  15,000 attendees. Intelligence has identified a credible threat of a car bomb
  attack. The threat level has been elevated to HIGH. All agencies are requested
  to coordinate through the command center.
  ```
- Clicks **"Add Role-Specific Briefing"**
- Selects **"Police Commander"** → Enters:
  ```
  POLICE COMMANDER BRIEFING:
  You have 50 officers on site. Perimeter security is your responsibility.
  Coordinate with Defence Liaison for military support if needed. Intelligence
  reports suggest the threat vehicle is a white van near the main entrance.
  ```
- Selects **"Health Director"** → Enters:
  ```
  HEALTH DIRECTOR BRIEFING:
  Three hospitals are on standby: Singapore General Hospital (SGH), National
  University Hospital (NUH), and Changi General Hospital (CGH). Total bed
  capacity: 200. Ambulance fleet: 30 units available. Casualty estimates:
  Unknown, prepare for mass casualty incident.
  ```
- Selects **"Defence Liaison"** → Enters:
  ```
  DEFENCE LIAISON BRIEFING:
  SAF units are on standby. You can authorize deployment of bomb disposal units,
  military medical teams, and perimeter security. Coordinate with Police Commander
  for joint operations.
  ```
- (Repeats for other roles: Civil Government, Utilities Manager, Public Information Officer, etc.)

**Adding Injects:**

- Trainer scrolls to **"Timeline Injects"** section
- Clicks **"Add Inject"** → Enters:
  - **Time:** `00:05` (5 minutes into session)
  - **Title:** `Intelligence Update: Vehicle Identified`
  - **Content:** `White van with license plate SGP-1234 has been identified near main entrance. Bomb disposal unit requested.`
  - **Affected Roles:** Selects `Police Commander`, `Defence Liaison`, `Intelligence Analyst`
  - Clicks **"Save Inject"**

- Clicks **"Add Inject"** → Enters:
  - **Time:** `00:10`
  - **Title:** `Media Report: Breaking News`
  - **Content:** `Channel NewsAsia reports: "Unconfirmed reports of security threat at Suntec City. Police presence increased."`
  - **Affected Roles:** Selects `Public Information Officer`, `Civil Government`
  - Clicks **"Save Inject"**

- Clicks **"Add Inject"** → Enters:
  - **Time:** `00:15`
  - **Title:** `Explosion Reported`
  - **Content:** `Loud explosion heard near main entrance. Smoke visible. Casualties reported.`
  - **Affected Roles:** Selects `All Roles`
  - Clicks **"Save Inject"**

- (Adds more injects at 00:20, 00:30, 00:45, etc.)

**AI Inject Suggestions:**

- Trainer clicks **"Generate AI Injects"** button
- AI analyzes scenario and suggests 5-10 injects
- Trainer reviews each, clicks **"Approve"**, **"Edit"**, or **"Reject"**
- Approved injects are added to timeline

**Finalizing Scenario:**

- Trainer clicks **"Save Scenario"** button
- Scenario appears in scenarios list with status `DRAFT`
- Trainer clicks **"Publish"** button → Status changes to `ACTIVE`

---

### Step 3: Trainer Creates Session

**Action:** Trainer clicks **"Sessions"** tab → Clicks **"Create New Session"** button

**UI Flow:**

- Modal opens: "Create New Session"
- Trainer selects:
  - **Scenario:** `Christmas Festival Terror Attack` (from dropdown)
  - **Scheduled Start Time:** `2024-12-20 14:00` (2 PM today)
  - **Trainer Instructions:**
    ```
    This is a 60-minute exercise. Focus on coordination and communication.
    Monitor decision-making processes. Pause if needed for discussion.
    ```
- Clicks **"Create Session"**

**Result:** Session created with status `SCHEDULED`

---

### Step 4: Trainer Invites Participants

**Action:** Trainer clicks on the session → Sees **"Participant Management"** section

**UI Flow:**

- Trainer clicks **"Add Participant"** button
- Modal opens with two tabs: **"Add Existing User"** and **"Invite by Email"**

**Inviting Existing Users:**

- Trainer clicks **"Add Existing User"** tab
- Sees list of registered users
- Selects:
  - `john.doe@police.gov.sg` → Assigns role: **"Police Commander"**
  - `jane.smith@moh.gov.sg` → Assigns role: **"Health Director"**
  - `mike.wong@mindef.gov.sg` → Assigns role: **"Defence Liaison"**
- Clicks **"Add Selected Users"**

**Inviting New Users via Email:**

- Trainer clicks **"Invite by Email"** tab
- Enters:
  - **Email:** `sarah.lee@mci.gov.sg`
  - **Role:** Selects `Public Information Officer` from dropdown
- Clicks **"Send Invitation"**
- Sees success message: "Invitation sent successfully"
- (Repeats for other roles: Civil Government, Utilities Manager, Intelligence Analyst, etc.)

**Result:**

- 8 participants invited (mix of existing users and email invitations)
- Session shows: **"Participants: 8"** count

---

## Phase 2: Pre-Session (10 minutes before start)

### Step 5: Participants Receive Invitations

**Action:** Invited participants check their email

**Email Content:**

```
Subject: Invitation to Join Simulation Session

You have been invited to participate in a crisis simulation exercise:

Session: Christmas Festival Terror Attack
Scheduled Start: December 20, 2024 at 2:00 PM
Your Role: [Role Name]

Click here to join: http://localhost:3000/invite/[TOKEN]

[If you don't have an account, you'll be prompted to create one]
```

---

### Step 6: Participants Sign Up / Log In

**Action:** Participant clicks invitation link → Redirected to signup/login page

**For New Users:**

- Email and role are pre-filled
- Participant enters:
  - **Full Name:** `Sarah Lee`
  - **Password:** `[creates password]`
- Clicks **"Sign Up"**
- Account created, automatically logged in
- Redirected to Sessions page

**For Existing Users:**

- Participant logs in with email/password
- Redirected to Sessions page

**Result:** Participant sees session: **"Christmas Festival Terror Attack"** with status `SCHEDULED`

---

### Step 7: Participants Join Session Lobby

**Action:** Participant clicks on session → Sees **"Session Lobby"** screen

**UI Flow:**

- **Left Panel:** Session details
  - Scenario title and description
  - Scheduled start time
  - Duration: 60 minutes
  - Objectives listed

- **Center Panel:** Briefing Materials
  - **"General Briefing"** tab (default)
  - Shows general briefing text
  - **"Role-Specific Briefing"** tab
  - Participant clicks tab → Sees their role-specific briefing
  - Example (Health Director):
    ```
    HEALTH DIRECTOR BRIEFING:
    Three hospitals are on standby: Singapore General Hospital (SGH),
    National University Hospital (NUH), and Changi General Hospital (CGH).
    Total bed capacity: 200. Ambulance fleet: 30 units available.
    Casualty estimates: Unknown, prepare for mass casualty incident.
    ```

- **Right Panel:** Participant Status
  - Shows list of all participants
  - Each participant has **"Ready"** checkbox
  - Participant reads briefing, checks **"Ready"** checkbox
  - Status updates: **"Ready"** (green indicator)

**Trainer View:**

- Trainer sees lobby with:
  - **Participant List:** Shows all 8 participants
  - **Ready Status:** Shows count: "5/8 Ready"
  - **"Start Session"** button (disabled until all ready, or trainer can enable early start)

**Result:** All participants mark themselves ready → Trainer clicks **"Start Session"**

---

## Phase 3: Active Session (60 minutes)

### Step 8: Session Starts - Initial COP View

**Action:** Session status changes to `IN_PROGRESS` → All participants see **COP Dashboard**

**UI Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ [Session: Christmas Festival Terror Attack] [00:00] [PAUSE]│
├──────────────┬──────────────────────────┬──────────────────┤
│              │                          │                   │
│  SIDEBAR     │      MAP VIEW           │   TIMELINE FEED   │
│              │                          │                   │
│ • Incidents  │  [Interactive Map]      │  [Event Feed]     │
│ • Resources  │  - Suntec City marker   │  - Session started│
│ • Decisions  │  - Incident markers     │  - Briefing read  │
│ • Channels   │  - Resource locations    │  - [New events...] │
│ • Media      │                          │                   │
│ • Sentiment  │                          │                   │
└──────────────┴──────────────────────────┴──────────────────┘
```

**Initial State:**

- **Map:** Shows Suntec City location with marker
- **Timeline Feed:** Shows "Session started" event
- **Incidents Panel:** Empty (no incidents yet)
- **Resources Panel:** Shows initial resource counts per agency
- **Channels Panel:** Shows available communication channels

---

### Step 9: First Inject Arrives (00:05)

**Action:** At 5 minutes, AI inject triggers automatically

**UI Flow:**

- **Notification:** Red alert banner appears: **"New Intelligence Update"**
- **Timeline Feed:** New entry appears:
  ```
  [00:05] Intelligence Update: Vehicle Identified
  White van with license plate SGP-1234 has been identified near main entrance.
  Bomb disposal unit requested.
  ```
- **Map:** New marker appears at main entrance location
- **Incidents Panel:** New incident added:
  ```
  Incident #001: Suspicious Vehicle
  Location: Main Entrance, Suntec City
  Status: Active
  Assigned: Unassigned
  ```

**Role-Specific Views:**

**Police Commander sees:**

- Full incident details
- Can assign officers
- Sees "Request Defence Support" button

**Defence Liaison sees:**

- Incident notification
- Sees "Deploy Bomb Disposal Unit" button
- Can see police operations

**Health Director sees:**

- Incident notification (limited details)
- Sees "Prepare Medical Response" button
- **Blind Spot:** Cannot see exact vehicle location (must request from Police)

**Public Information Officer sees:**

- Incident notification (very limited)
- **Blind Spot:** Cannot see vehicle details (must request from Police/Intelligence)

---

### Step 10: Police Commander Takes Action

**Action:** Police Commander clicks on **Incident #001** → Clicks **"Assign Officers"** button

**UI Flow:**

- Modal opens: "Assign Resources"
- Police Commander selects:
  - **Units:** 10 officers
  - **Action:** "Secure perimeter, evacuate immediate area"
- Clicks **"Execute"**

**Result:**

- **Timeline Feed:** New entry:
  ```
  [00:06] Police Commander: Assigned 10 officers to Incident #001
  Action: Secure perimeter, evacuate immediate area
  ```
- **Incidents Panel:** Incident #001 shows "Assigned to: Police Commander"
- **Map:** Blue markers appear showing police deployment
- **Resources Panel:** Police resources decrease: "Officers: 40/50"

---

### Step 11: Police Commander Requests Intelligence

**Action:** Police Commander needs more details → Opens **"Channels"** panel

**UI Flow:**

- Clicks **"Channels"** in sidebar
- Sees available channels:
  - **Command Channel** (all commanders)
  - **Police-Intelligence** (private channel)
  - **Police-Defence** (private channel)
  - **All Agencies** (public channel)

- Clicks **"Police-Intelligence"** channel
- Types message:
  ```
  Need full intelligence report on vehicle SGP-1234.
  Any known associations? Threat level assessment?
  ```
- Clicks **"Send"**

**Result:**

- Message appears in channel
- Intelligence Analyst receives notification
- Timeline Feed shows: `[00:07] Police Commander requested intelligence report`

---

### Step 12: Intelligence Analyst Responds

**Action:** Intelligence Analyst sees notification → Opens channel → Responds

**UI Flow:**

- Intelligence Analyst clicks notification → Opens **"Police-Intelligence"** channel
- Sees Police Commander's message
- Clicks **"Share Intelligence Report"** button (special action)
- Modal opens: "Share Intelligence"
- Selects report: **"Vehicle Threat Assessment"**
- Clicks **"Share"**

**Result:**

- **Police Commander's View:**
  - Receives notification: "Intelligence Report Shared"
  - Opens channel → Sees report attachment
  - Clicks attachment → Reads:
    ```
    INTELLIGENCE REPORT:
    Vehicle SGP-1234 registered to [REDACTED]. Known associate of
    [REDACTED] organization. Threat level: HIGH. Recommend immediate
    evacuation of 500m radius.
    ```
  - **Blind Spot Removed:** Now sees full threat assessment

- **Timeline Feed:**

  ```
  [00:08] Intelligence Analyst shared intelligence report with Police Commander
  ```

- **Map:** Intelligence Analyst's view updates with threat radius overlay

---

### Step 13: Police Commander Creates Decision

**Action:** Police Commander decides to request evacuation → Opens **"Decisions"** panel

**UI Flow:**

- Clicks **"Decisions"** in sidebar
- Clicks **"Create Decision"** button
- Modal opens: "Create Decision"
- Fills in:
  - **Title:** `Emergency Evacuation Order - 500m Radius`
  - **Type:** Selects `Operational Action` from dropdown
  - **Description:**
    ```
    Request authorization for immediate evacuation of 500m radius
    around suspicious vehicle. Based on intelligence assessment
    indicating HIGH threat level.
    ```
  - **Resources Required:**
    - Police: 20 additional officers
    - Civil Government: Evacuation coordination
  - **Impact Level:** Selects `High`
- Clicks **"Submit for Approval"**

**Result:**

- **Decision Created:**
  - Status: `PROPOSED`
  - Approval Chain:
    1. Civil Government (approver)
    2. Legal Oversight (approver)
  - Decision appears in **"Decisions"** panel with status badge

- **Notifications Sent:**
  - Civil Government receives: "New decision requires your approval"
  - Legal Oversight receives: "Decision pending your review"

- **Timeline Feed:**
  ```
  [00:09] Police Commander proposed decision: Emergency Evacuation Order
  Status: Awaiting approval from Civil Government
  ```

---

### Step 14: Civil Government Reviews Decision

**Action:** Civil Government sees notification → Opens **"Decisions"** panel

**UI Flow:**

- Clicks notification → Opens decision details
- Reads full decision proposal
- Reviews intelligence report (shared by Police Commander)
- Clicks **"Approve"** button
- Modal opens: "Approve Decision"
- Enters comment: `Approved. Coordinate with utilities for traffic management.`
- Clicks **"Confirm Approval"**

**Result:**

- **Decision Status:** `UNDER REVIEW` → Now awaiting Legal Oversight
- **Timeline Feed:**

  ```
  [00:11] Civil Government approved: Emergency Evacuation Order
  Comment: "Approved. Coordinate with utilities for traffic management."
  Next approver: Legal Oversight
  ```

- **Legal Oversight** receives notification: "Decision approved by Civil Government, awaiting your review"

---

### Step 15: Second Inject Arrives (00:10)

**Action:** While decision is pending, media inject triggers

**UI Flow:**

- **Notification:** Yellow alert: **"Media Report"**
- **Timeline Feed:**
  ```
  [00:10] Media Report: Breaking News
  Channel NewsAsia reports: "Unconfirmed reports of security threat
  at Suntec City. Police presence increased."
  ```
- **Media Panel:** New entry in social feed:
  ```
  @ChannelNewsAsia: BREAKING: Security threat reported at Suntec City.
  Police presence increased. More details to follow. #SuntecCity
  ```
- **Sentiment Graph:** Shows slight dip (public concern)

**Public Information Officer sees:**

- Receives priority notification
- Sees sentiment change
- Needs to prepare response

---

### Step 16: Public Information Officer Monitors Sentiment

**Action:** Public Information Officer opens **"Media & Sentiment"** panel

**UI Flow:**

- Clicks **"Media"** in sidebar
- Sees:
  - **Social Feed:** Multiple posts about the incident
  - **News Ticker:** Breaking news updates
  - **Sentiment Graph:** Shows trend line dropping
  - **Current Sentiment:** 45/100 (down from 60)

- Clicks **"Draft Public Statement"** button
- Modal opens: "Draft Statement"
- Enters:
  - **Title:** `Official Statement: Security Situation at Suntec City`
  - **Content:**
    ```
    We are aware of reports regarding Suntec City. Police are on scene
    conducting security operations. Public safety is our top priority.
    We will provide updates as information becomes available.
    ```
  - **Preview Sentiment Impact:** Clicks button → Shows predicted impact: +10 points
- Clicks **"Save Draft"** (waits for evacuation decision to be approved before publishing)

---

### Step 17: Legal Oversight Approves Decision

**Action:** Legal Oversight reviews decision → Approves

**UI Flow:**

- Legal Oversight clicks notification → Opens decision
- Reviews:
  - Original proposal
  - Civil Government's approval
  - Intelligence report
- Clicks **"Approve"**
- Enters comment: `Approved. Ensure proper legal authority cited.`
- Clicks **"Confirm Approval"**

**Result:**

- **Decision Status:** `APPROVED` → Now ready for execution
- **Police Commander** receives notification: "Decision approved. Ready to execute."
- **Timeline Feed:**
  ```
  [00:13] Legal Oversight approved: Emergency Evacuation Order
  Decision Status: APPROVED - Ready for execution
  ```

---

### Step 18: Police Commander Executes Decision

**Action:** Police Commander executes the approved evacuation order

**UI Flow:**

- Police Commander opens **"Decisions"** panel
- Sees decision with **"APPROVED"** status
- Clicks **"Execute Decision"** button
- Modal opens: "Execute Decision"
- Confirms resource allocation:
  - Police: 20 officers deployed
  - Civil Government: Evacuation coordination activated
- Clicks **"Execute"**

**Result:**

- **Decision Status:** `EXECUTED`
- **Scenario State Updates:**
  - Evacuation begins
  - Map shows evacuation zone (500m radius)
  - Resources updated: Police officers: 20/50 remaining
  - Civil Government resources: Evacuation teams activated

- **Timeline Feed:**

  ```
  [00:14] Police Commander executed: Emergency Evacuation Order
  Evacuation of 500m radius initiated. Resources deployed.
  ```

- **All Participants:** See evacuation zone on map
- **Public Information Officer:** Can now publish statement (decision executed)

---

### Step 19: Public Information Officer Publishes Statement

**Action:** Public Information Officer publishes prepared statement

**UI Flow:**

- Opens **"Decisions"** panel
- Clicks **"Create Decision"** → Selects **"Public Statement"** type
- Pastes prepared statement
- Approval chain: Civil Government only (public statements)
- Clicks **"Submit for Approval"**

**Civil Government:**

- Receives notification
- Reviews statement
- Clicks **"Approve"**

**Public Information Officer:**

- Receives approval notification
- Clicks **"Publish Statement"** button
- Statement goes live

**Result:**

- **Media Panel:**
  ```
  [OFFICIAL] Government Statement:
  "We are aware of reports regarding Suntec City. Police are on scene
  conducting security operations. Public safety is our top priority..."
  ```
- **Sentiment Graph:** Updates → Shows +10 point increase (from 45 to 55)
- **Timeline Feed:**
  ```
  [00:16] Public Information Officer published official statement
  Sentiment impact: +10 points
  ```

---

### Step 20: Major Inject - Explosion (00:15)

**Action:** At 15 minutes, major inject triggers (explosion)

**UI Flow:**

- **Critical Alert:** Red flashing banner: **"CRITICAL: EXPLOSION REPORTED"**
- **Timeline Feed:**
  ```
  [00:15] CRITICAL: Explosion Reported
  Loud explosion heard near main entrance. Smoke visible.
  Casualties reported. Emergency response required.
  ```
- **Map:**
  - Explosion marker appears at main entrance
  - Evacuation zone expands
  - Multiple incident markers appear

- **Incidents Panel:** New incidents:

  ```
  Incident #002: Explosion at Main Entrance
  Status: CRITICAL
  Casualties: Unknown
  Assigned: Unassigned

  Incident #003: Structural Damage
  Status: Active
  Assigned: Unassigned

  Incident #004: Fire at Entrance
  Status: Active
  Assigned: Unassigned
  ```

**All Participants:** Receive critical notifications

---

### Step 21: Health Director Responds to Mass Casualty

**Action:** Health Director sees critical alert → Takes immediate action

**UI Flow:**

- Health Director opens **"Incidents"** panel
- Sees Incident #002: Explosion
- Clicks **"Assign Medical Response"** button
- Modal opens: "Medical Response Plan"
- Allocates:
  - **Ambulances:** 15 units
  - **Medical Teams:** 5 teams (20 personnel)
  - **Hospitals:**
    - SGH: Prepare for 50 casualties
    - NUH: Prepare for 30 casualties
    - CGH: Prepare for 20 casualties
- Clicks **"Execute Medical Response"**

**Result:**

- **Resources Updated:** Ambulances: 15/30 remaining
- **Timeline Feed:**

  ```
  [00:16] Health Director: Activated mass casualty response
  - 15 ambulances deployed
  - 5 medical teams dispatched
  - 3 hospitals on standby (100 casualty capacity)
  ```

- **Map:** Medical response markers appear
- **Incidents Panel:** Incident #002 shows "Medical response activated"

---

### Step 22: Health Director Requests Police Support

**Action:** Health Director needs secure access route → Opens **"Channels"** panel

**UI Flow:**

- Clicks **"Channels"** → Opens **"Health-Police"** channel
- Types:
  ```
  Need secure access route for ambulances. Main entrance blocked.
  Request alternative route coordination.
  ```
- Clicks **"Send"**

**Police Commander:**

- Receives notification
- Opens channel
- Responds:
  ```
  Route A cleared. Route B available. Sending 5 officers to escort
  medical teams.
  ```
- Clicks **"Share Route Map"** (attaches map file)

**Health Director:**

- Receives route map
- Updates ambulance routes
- **Timeline Feed:**
  ```
  [00:18] Health Director and Police Commander coordinated medical access routes
  ```

---

### Step 23: Resource Marketplace - Health Requests Additional Ambulances

**Action:** Health Director realizes need more ambulances → Opens **"Resources"** panel

**UI Flow:**

- Clicks **"Resources"** in sidebar
- Sees current inventory: Ambulances: 15/30
- Clicks **"Request Resources"** button
- Modal opens: "Request Resources"
- Selects:
  - **From Agency:** Defence Liaison
  - **Resource Type:** Military Medical Vehicles
  - **Quantity:** 10 units
  - **Reason:** "Mass casualty incident requires additional transport capacity"
  - **Urgency:** High
- Clicks **"Send Request"**

**Result:**

- **Defence Liaison** receives notification: "Resource request from Health Director"
- **Timeline Feed:**
  ```
  [00:19] Health Director requested 10 military medical vehicles from Defence Liaison
  Status: Pending response
  ```

---

### Step 24: Defence Liaison Negotiates Resource Request

**Action:** Defence Liaison reviews request → Makes counteroffer

**UI Flow:**

- Defence Liaison clicks notification → Opens **"Resources"** panel
- Sees pending request
- Clicks **"Respond"** button
- Modal opens: "Respond to Request"
- Reviews request
- Clicks **"Make Counteroffer"**
- Enters:
  - **Available:** 8 units (not 10)
  - **Condition:** "Requires coordination with Police for secure transport routes"
  - **Timeline:** "Can deploy in 5 minutes"
- Clicks **"Send Counteroffer"**

**Health Director:**

- Receives notification: "Defence Liaison made counteroffer"
- Reviews counteroffer
- Clicks **"Accept Counteroffer"**

**Result:**

- **Resources Transferred:**
  - Defence: Military vehicles: 8 units → Health Director
  - Health: Ambulance capacity increases
- **Timeline Feed:**

  ```
  [00:21] Health Director accepted resource request from Defence Liaison
  - 8 military medical vehicles transferred
  - Condition: Coordinate with Police for routes
  ```

- **Map:** Shows resource transfer
- **Resources Panel:** Updated inventories for both agencies

---

### Step 25: Utilities Manager Coordinates Infrastructure

**Action:** Utilities Manager sees explosion → Assesses infrastructure damage

**UI Flow:**

- Utilities Manager opens **"Incidents"** panel
- Sees Incident #003: Structural Damage
- Clicks **"Assess Infrastructure Impact"** button
- Modal opens: "Infrastructure Assessment"
- Checks:
  - **Power:** Status: Stable (backup generators active)
  - **Water:** Status: Minor disruption (isolated area)
  - **Communications:** Status: Cell tower damaged (backup active)
  - **Transportation:** Status: Main entrance blocked
- Clicks **"Share Assessment"**

**Result:**

- **Assessment shared** with all agencies via Command Channel
- **Timeline Feed:**

  ```
  [00:22] Utilities Manager: Infrastructure assessment shared
  - Power: Stable
  - Water: Minor disruption
  - Communications: Backup active
  - Transportation: Main entrance blocked
  ```

- **All Participants:** See infrastructure status in COP
- **Map:** Shows infrastructure status markers

---

### Step 26: Mid-Session Inject - Misinformation Spreads (00:30)

**Action:** At 30 minutes, AI inject triggers misinformation

**UI Flow:**

- **Notification:** Orange alert: **"Misinformation Detected"**
- **Media Panel:** New entry:
  ```
  @AnonymousUser: BREAKING: Multiple explosions at Suntec! Hundreds dead!
  Government covering it up! #SuntecAttack #CoverUp
  ```
- **Sentiment Graph:** Shows sharp drop (from 55 to 35)
- **Timeline Feed:**
  ```
  [00:30] Misinformation Alert: False reports spreading on social media
  Sentiment impact: -20 points
  ```

**Public Information Officer:**

- Receives priority notification
- Sees sentiment drop
- Needs to counter misinformation

---

### Step 27: Public Information Officer Counters Misinformation

**Action:** Public Information Officer drafts counter-message

**UI Flow:**

- Opens **"Media"** panel
- Sees misinformation post
- Clicks **"Create Counter-Message"** button
- Modal opens: "Counter Misinformation"
- Enters:
  - **Message Type:** Factual Correction
  - **Content:**
    ```
    CORRECTION: Reports of "multiple explosions" are false. There was
    one incident. We are providing regular updates. Follow official
    channels for accurate information.
    ```
  - **Preview Impact:** Predicted sentiment recovery: +15 points
- Clicks **"Publish Counter-Message"**

**Result:**

- **Media Panel:**
  ```
  [OFFICIAL] Factual Correction:
  "CORRECTION: Reports of 'multiple explosions' are false..."
  ```
- **Sentiment Graph:** Updates → Recovers to 50 (from 35)
- **Timeline Feed:**
  ```
  [00:32] Public Information Officer published counter-message
  Sentiment impact: +15 points (misinformation countered)
  ```

---

### Step 28: Decision Chain - Request Military Support

**Action:** Police Commander needs additional support → Creates decision

**UI Flow:**

- Opens **"Decisions"** panel
- Clicks **"Create Decision"**
- Enters:
  - **Title:** `Request Military Support for Perimeter Security`
  - **Type:** Operational Action
  - **Description:**
    ```
    Request deployment of SAF units to secure extended perimeter.
    Current police resources stretched thin. Need 50 personnel.
    ```
  - **Approval Chain:**
    1. Defence Liaison (approver)
    2. Civil Government (approver)
  - **Impact:** High
- Clicks **"Submit for Approval"**

**Defence Liaison:**

- Receives notification
- Reviews request
- Clicks **"Approve"**
- Enters: "Approved. Deploying 50 SAF personnel. ETA 10 minutes."

**Civil Government:**

- Receives notification
- Reviews
- Clicks **"Approve"**

**Police Commander:**

- Receives approval
- Clicks **"Execute Decision"**

**Result:**

- **Military Support Deployed:**
  - 50 SAF personnel deployed
  - Perimeter expanded
  - Map shows military deployment markers
- **Timeline Feed:**
  ```
  [00:35] Police Commander executed: Military Support Request
  - 50 SAF personnel deployed
  - Perimeter security expanded
  ```

---

### Step 29: Health Director Provides Casualty Update

**Action:** Health Director updates casualty numbers → Shares with agencies

**UI Flow:**

- Health Director opens **"Channels"** → **"Command Channel"**
- Types:
  ```
  CASUALTY UPDATE:
  - Confirmed casualties: 45
  - Critical: 12 (transported to SGH)
  - Serious: 18 (transported to NUH)
  - Minor: 15 (treated on-site)
  - All casualties accounted for. Medical response ongoing.
  ```
- Clicks **"Send"**

**Result:**

- **All Commanders** receive update
- **Timeline Feed:**

  ```
  [00:38] Health Director: Casualty update shared
  - 45 total casualties
  - 12 critical, 18 serious, 15 minor
  ```

- **COP Updates:**
  - Casualty count displayed
  - Medical response status updated
  - Map shows hospital locations with patient counts

---

### Step 30: Final Inject - Situation Stabilizing (00:45)

**Action:** At 45 minutes, inject indicates situation stabilizing

**UI Flow:**

- **Notification:** Green alert: **"Situation Update"**
- **Timeline Feed:**
  ```
  [00:45] Situation Update: Perimeter secured. Evacuation complete.
  Medical response ongoing. No further threats detected.
  ```
- **Incidents Panel:**
  - Incident #001: Status changed to `RESOLVED`
  - Incident #002: Status changed to `UNDER CONTROL`
  - Incident #003: Status changed to `ASSESSED`
  - Incident #004: Status changed to `CONTAINED`

**All Participants:** See status updates

---

### Step 31: Final Coordination - SITREP Preparation

**Action:** Civil Government requests situation report from all agencies

**UI Flow:**

- Civil Government opens **"Channels"** → **"Command Channel"**
- Types:
  ```
  Requesting SITREP from all agencies for final coordination:
  - Police: Perimeter status
  - Health: Casualty status
  - Defence: Support status
  - Utilities: Infrastructure status
  - PIO: Public communication status
  ```
- Clicks **"Send"**

**Agencies Respond:**

- Each agency provides SITREP via channel
- Information consolidated
- **Timeline Feed:** Shows all SITREPs

---

### Step 32: Session Nears End (00:55)

**Action:** Trainer monitors progress → Prepares to end session

**Trainer View:**

- Trainer sees:
  - **Objectives Progress:**
    - ✅ Multi-agency command center: ESTABLISHED
    - ✅ Evacuation and perimeter: COMPLETE
    - ✅ Medical assistance: ONGOING
    - ✅ Public communication: ACTIVE
  - **Metrics:**
    - Decisions made: 8
    - Average decision latency: 4 minutes
    - Communication efficiency: High
    - Coordination score: 85/100

**Trainer Actions:**

- Clicks **"End Session"** button
- Confirms: "End session now?"
- Clicks **"Yes"**

**Result:**

- Session status changes to `COMPLETED`
- All participants see: **"Session Ended"** message
- Redirected to AAR view

---

## Phase 4: After-Action Review (Post-Session)

### Step 33: Participants View AAR

**Action:** Session ends → All participants see **After-Action Review** screen

**UI Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ [After-Action Review: Christmas Festival Terror Attack]     │
├──────────────┬──────────────────────────┬──────────────────┤
│              │                          │                   │
│  TIMELINE    │      METRICS             │   ANALYTICS       │
│  REPLAY      │      DASHBOARD           │   CHARTS          │
│              │                          │                   │
│ [▶ Play]     │  • Objectives: 3/3 ✅    │  [Sentiment Graph]│
│ [00:00]      │  • Decisions: 8          │  [Decision Latency│
│              │  • Avg Latency: 4 min    │  [Communication] │
│ [Event List] │  • Coordination: 85/100  │                   │
│              │                          │                   │
└──────────────┴──────────────────────────┴──────────────────┘
```

**Timeline Replay:**

- Participant clicks **"Play"** button
- Timeline replays all events
- Can pause, jump to specific times
- Can add annotations

**Metrics Dashboard:**

- Shows:
  - **Objectives:** 3/3 completed ✅
  - **Decisions:** 8 total (6 approved, 2 pending)
  - **Average Decision Latency:** 4 minutes
  - **Communication:** 45 messages exchanged
  - **Coordination Score:** 85/100
  - **Sentiment Recovery:** +15 points (from 35 to 50)

**Analytics Charts:**

- **Sentiment Graph:** Shows full trajectory
- **Decision Timeline:** Shows when decisions were made
- **Communication Network:** Shows who communicated with whom
- **Resource Transactions:** Shows all resource transfers

---

### Step 34: Trainer Reviews Full AAR

**Action:** Trainer opens **"Analytics"** tab → Views comprehensive AAR

**Trainer View:**

- **Full Timeline:** All events with timestamps
- **Decision Analysis:**
  - All 8 decisions with approval chains
  - Latency analysis
  - Approval/rejection rates
- **Communication Analysis:**
  - Message volume per channel
  - Response times
  - Information sharing patterns
- **Performance Metrics:**
  - Per-agency performance
  - Coordination effectiveness
  - Objective completion
- **AI-Generated Summary:**

  ```
  SESSION SUMMARY:
  The exercise successfully demonstrated effective multi-agency coordination
  in response to a terrorist threat at Suntec City. Key achievements:

  - Rapid establishment of command center (5 minutes)
  - Efficient evacuation coordination (9 minutes)
  - Effective medical response activation (1 minute after explosion)
  - Strong public communication (countered misinformation effectively)

  Areas for improvement:
  - Decision latency could be reduced (average 4 minutes)
  - Some agencies could share information more proactively
  - Resource negotiation took longer than ideal (2 minutes average)
  ```

**Trainer Actions:**

- Clicks **"Export Report"** button
- Selects format: PDF
- Clicks **"Generate Report"**
- Report downloads with:
  - Full timeline
  - Metrics
  - Charts
  - AI summary
  - Participant performance

---

## Key Gameplay Mechanics Demonstrated

### 1. **Information Blind Spots**

- Health Director couldn't see exact vehicle location (had to request)
- Public Information Officer had limited incident details (had to request)
- Information sharing was essential for coordination

### 2. **Decision Workflows**

- Decisions required approval chains
- Multiple decisions created and executed
- Decision latency tracked and analyzed

### 3. **Resource Marketplace**

- Health Director requested resources from Defence
- Negotiation with counteroffers
- Resource transfers tracked

### 4. **Communication Channels**

- Multiple channel types used
- Information sharing via channels
- SITREPs and coordination messages

### 5. **Media & Sentiment**

- Media reports affected sentiment
- Misinformation spread
- Public Information Officer countered misinformation
- Sentiment tracked and recovered

### 6. **Real-Time Coordination**

- All actions happened in real-time
- WebSocket updates kept everyone synchronized
- Map and timeline updated live

### 7. **Objective Achievement**

- All 3 objectives completed:
  1. ✅ Multi-agency command center established
  2. ✅ Evacuation and perimeter secured
  3. ✅ Medical assistance provided, public communication managed

---

## Winning Conditions

**This scenario is won by:**

- ✅ Completing all objectives
- ✅ Effective coordination between agencies
- ✅ Timely decision-making
- ✅ Successful information sharing
- ✅ Managing public sentiment
- ✅ Efficient resource allocation

**No "losers"** - Focus is on learning and improvement through the AAR process.

---

## Interface Elements Used

1. **Dashboard:** Main navigation and session overview
2. **COP Map:** Interactive map with markers and overlays
3. **Timeline Feed:** Chronological event feed
4. **Incidents Panel:** List of active incidents
5. **Decisions Panel:** Decision creation and approval workflow
6. **Resources Panel:** Resource inventory and marketplace
7. **Channels Panel:** Communication channels
8. **Media Panel:** Social feed and sentiment tracking
9. **Briefing View:** Pre-session briefing materials
10. **Session Lobby:** Pre-session waiting room
11. **AAR View:** After-action review and analytics

---

## Time Progression

- **00:00** - Session starts
- **00:05** - First inject (vehicle identified)
- **00:10** - Media report inject
- **00:15** - Explosion inject (major event)
- **00:30** - Misinformation inject
- **00:45** - Situation stabilizing
- **00:55** - Session ending
- **00:60** - Session complete, AAR begins

---

This walkthrough demonstrates the complete gameplay flow from setup to completion, showing how all the interface elements work together to create an immersive, coordinated crisis simulation experience.
