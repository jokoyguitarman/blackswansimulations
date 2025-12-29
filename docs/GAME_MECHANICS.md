# Unified Simulation Environment – Game Mechanics & Core Features

## Overview

The Unified Simulation Environment (USE) is a **real-time, multi-agency crisis simulation platform** where players take on roles from different agencies and coordinate responses to fictional crisis scenarios. The game emphasizes **information sharing, decision-making, and inter-agency coordination** rather than competition.

---

## Core Gameplay Loop

### 1. **Session Setup** (Trainer Phase)

- Trainer selects or creates a scenario
- Trainer configures scenario parameters (duration, difficulty, objectives)
- Trainer schedules session and invites participants
- Trainer assigns roles to participants
- Trainer sets initial scenario state

### 2. **Pre-Session** (Participant Phase)

- Participants receive invitations
- Participants review briefing materials
- Participants join session lobby
- Trainer provides final instructions
- Session begins when trainer starts the clock

### 3. **Active Session** (Real-Time Play)

- **Scenario clock runs** (real-time or accelerated time)
- **AI injects** introduce new events/challenges
- **Players make decisions** based on their role and available information
- **Players communicate** via chat channels to share information
- **Players request resources** from other agencies via marketplace
- **Scenario state evolves** based on decisions and injects
- **Metrics tracked** in real-time (decision latency, coordination, etc.)

### 4. **Post-Session** (Review Phase)

- Session ends (time limit or trainer-triggered)
- **After-Action Review (AAR)** automatically generated
- **Timeline replay** available for analysis
- **Analytics dashboard** shows performance metrics
- **Export reports** for certification/training records

---

## Core Mechanics

### 1. **Scenarios**

A **scenario** is a pre-configured crisis situation that defines:

- **Type**: Cyber incident, infrastructure failure, civil unrest, natural disaster, health emergency, terrorism, custom
- **Difficulty**: Beginner, Intermediate, Advanced, Expert
- **Duration**: Typically 60-180 minutes (real-time or accelerated)
- **Objectives**: Primary and secondary goals for the exercise
- **Initial State**: Starting conditions (incidents, resources, sentiment, etc.)
- **Timeline**: Scheduled AI injects and events
- **Participant Roles**: Which agencies/roles are required/optional

**Scenario Lifecycle:**

1. **Draft** - Trainer creates and edits
2. **Published** - Available for scheduling
3. **Scheduled** - Session created, participants invited
4. **Active** - Session in progress
5. **Completed** - Session finished, AAR generated
6. **Archived** - Historical record

---

### 2. **Sessions**

A **session** is an active instance of a scenario with:

- **Participants**: Real users assigned to roles
- **Status**: Scheduled → In Progress → Paused → Completed → Archived
- **Clock**: Real-time or accelerated (e.g., 1 minute = 1 hour scenario time)
- **State**: Current scenario variables (incidents, resources, sentiment, etc.)
- **Event Log**: Chronological record of all events, decisions, communications

**Session Flow:**

```
SCHEDULED → LOBBY → IN_PROGRESS → [PAUSED] → COMPLETED → ARCHIVED
```

**Trainer Controls:**

- Start/pause/resume session
- Trigger manual injects
- Adjust scenario clock speed
- View all agency activities (full visibility)
- End session early if needed

---

### 3. **Information & Blind Spots**

**Core Mechanic**: Each role has **limited information visibility** to encourage communication.

**Information Types:**

- **Incidents**: Crisis events and their details
- **Casualties**: Medical data and casualty counts
- **Intelligence**: Classified intelligence reports
- **Public Sentiment**: Public opinion metrics
- **Infrastructure Status**: Utility and infrastructure conditions
- **Resources**: Available resources and allocations
- **Decisions**: Decisions made by other agencies
- **Media Reports**: News and social media updates
- And 16+ more information types...

**How It Works:**

- Each role **automatically sees** certain information types
- Each role has **blind spots** (hidden information)
- To access blind spot information, players must:
  1. **Request** information via communication channels
  2. **Wait** for response from appropriate agency
  3. **Receive** shared information (or denial)
  4. **Use** information to make informed decisions

**Example:**

- **Police Commander** can see incidents and police operations
- **Police Commander** CANNOT see casualties (blind spot)
- **Police Commander** must request casualty data from **Health Director**
- **Health Director** can choose to share or withhold information
- Information sharing builds trust and enables better coordination

---

### 4. **Decisions & Approval Workflows**

**Decision Creation:**

- Players create decisions based on their role authority
- Decisions require specific data fields (what, why, when, resources needed)
- Decisions are assigned to **approval chains** based on:
  - Decision type (e.g., resource allocation, public statement, operational action)
  - Decision impact (low/medium/high)
  - Role hierarchy (chain-of-command)

**Approval Process:**

1. **Proposed** - Decision created, pending first approver
2. **Under Review** - Being reviewed by approver(s)
3. **Approved** - All required approvals received
4. **Rejected** - Rejected by approver with reason
5. **Executed** - Decision implemented, scenario state updated
6. **Cancelled** - Withdrawn by creator

**Approval Chain Example:**

```
Public Statement Decision:
1. Public Information Officer (creates)
2. Civil Government (approves)
3. Legal/Ethics Oversight (approves)
4. EXECUTED → Sentiment updates
```

**Decision Impact:**

- Decisions affect scenario state variables
- Resource allocations update inventories
- Public statements affect sentiment
- Operational decisions affect incidents
- All changes are logged and visible in COP

---

### 5. **Resource Marketplace**

**Resource Types:**

- **Personnel**: Emergency responders, medical staff, specialists
- **Equipment**: Vehicles, medical supplies, communication gear
- **Budget Credits**: Financial resources for operations
- **Infrastructure Access**: Utility access, transportation routes
- **Intelligence Assets**: Surveillance, analysis capabilities

**Marketplace Flow:**

1. **Request**: Agency requests resources from another agency
2. **Negotiation**: Counteroffers, conditions, timelines
3. **Approval**: Resource owner approves/rejects
4. **Transfer**: Resources moved, inventories updated
5. **Impact**: Scenario state reflects resource changes

**Negotiation Mechanics:**

- Players can make **counteroffers** with conditions
- Players can **bundle** multiple resources
- Players can set **time limits** for availability
- Players can **revoke** resources if conditions not met
- All negotiations logged for AAR

**Resource Constraints:**

- Each agency has **limited resources**
- Resources are **consumed** when used
- Resources can be **replenished** via scenario events
- Resource shortages create **challenges** requiring coordination

---

### 6. **AI Event Injector**

**Inject Types:**

- **Time-Based**: Triggered at specific scenario times
- **Conditional**: Triggered when scenario state meets conditions
- **Trainer-Triggered**: Manual injects by trainer
- **AI-Generated**: Suggested by AI based on scenario flow

**Inject Categories:**

- **Media Reports**: News articles, social media posts
- **Infrastructure Events**: Power outages, transportation disruptions
- **Health Updates**: Casualty reports, medical capacity changes
- **Intelligence**: New intelligence reports, threat assessments
- **Weather**: Environmental conditions affecting operations
- **Misinformation**: False information spreading
- **Political Pressure**: Government/public pressure indicators

**AI Inject Generation:**

1. **AI analyzes** current scenario state
2. **AI suggests** appropriate injects based on:
   - Scenario objectives
   - Current timeline
   - Player actions
   - Scenario difficulty
3. **Trainer reviews** AI suggestions
4. **Trainer approves/edits/rejects** injects
5. **Injects publish** to all participants
6. **Scenario state updates** based on inject content

**Guardrails:**

- All content is **fictional** and clearly marked
- AI prompts include **safety filters**
- Trainer has **final approval** on all AI content
- All AI outputs are **logged** for audit

---

### 7. **Common Operating Picture (COP)**

The **COP** is a unified dashboard showing:

- **Interactive Map**: Geographic view of incidents, resources, operations
- **Timeline Feed**: Chronological feed of all events, decisions, communications
- **Resource Status**: Current resource inventories and allocations
- **Sentiment Graph**: Public sentiment trends over time
- **Incident List**: Active incidents with status and assignments
- **Decision Queue**: Pending decisions requiring action

**COP Features:**

- **Real-time Updates**: WebSocket updates as events occur
- **Filtering**: Filter by agency, type, time range
- **Pinning**: Pin important events for quick reference
- **Tagging**: Tag events for categorization
- **Search**: Search events, decisions, communications
- **Export**: Export COP data for reports

**Role-Specific Views:**

- Each role sees **different information** based on visibility rules
- Blind spots show **"CLASSIFIED"** blockers
- Players must **communicate** to get complete picture

---

### 8. **Communication Channels**

**Channel Types:**

- **Private**: One-on-one direct messages
- **Inter-Agency**: Communication between specific agencies
- **Command**: High-level coordination channel (commanders only)
- **Public**: All-participant channel
- **Trainer**: Trainer-to-participant communication
- **Role-Specific**: Channels for specific roles (e.g., all health directors)

**Communication Features:**

- **Real-time Chat**: Instant messaging via WebSocket
- **Message Types**: Text, file attachments, SITREP templates
- **Message Retention**: All messages logged for AAR
- **Notifications**: Alerts for mentions, decisions, injects
- **Search**: Search message history
- **Export**: Export conversations for reports

**Information Sharing:**

- Players can **share information** via chat
- Players can **request information** from other agencies
- Players can **attach files** (briefings, reports, data)
- All sharing is **logged** and visible in AAR

---

### 9. **Media & Public Sentiment**

**Media Simulation:**

- **Social Media Feed**: Mock Twitter/Facebook posts
- **News Ticker**: Breaking news updates
- **Citizen Reports**: Public reports and complaints
- **Misinformation**: False information spreading

**Sentiment System:**

- **Sentiment Score**: -100 (very negative) to +100 (very positive)
- **Sentiment Factors**:
  - Public statements and communications
  - Decision outcomes
  - Media coverage
  - Misinformation spread
  - Response effectiveness

**Public Statement Workflow:**

1. **Draft**: Public Information Officer drafts statement
2. **Review**: Civil Government reviews
3. **Approval**: Legal/Ethics approves
4. **Publish**: Statement published
5. **Impact**: Sentiment updates based on statement content
6. **Feedback**: Sentiment graph shows impact

**Misinformation Mechanics:**

- Misinformation can **spread** organically
- Players can **counter** misinformation with statements
- Counter-messaging **reduces** misinformation impact
- Misinformation affects **public sentiment** negatively

---

### 10. **After-Action Review (AAR)**

**Automatic Capture:**

- All decisions (proposed, approved, rejected, executed)
- All communications (messages, information sharing)
- All injects (AI-generated and trainer-triggered)
- All resource transactions
- All scenario state changes
- Timeline of all events

**AAR Features:**

- **Timeline Replay**: Play/pause/jump through session timeline
- **Annotations**: Add notes to specific events
- **Analytics Dashboard**:
  - Decision latency (time from proposal to execution)
  - Communication efficiency (response times, information sharing)
  - Legal compliance (approval chain adherence)
  - Sentiment trajectory (how sentiment changed)
  - Coordination scores (inter-agency collaboration)
- **AI-Generated Summary**: AI creates narrative summary (trainer can edit)
- **Export Options**: PDF, Excel, LMS-compatible formats

**Metrics Tracked:**

- **Decision Metrics**: Count, latency, approval rate, rejection rate
- **Communication Metrics**: Message count, response time, information sharing rate
- **Coordination Metrics**: Inter-agency collaboration, resource sharing
- **Compliance Metrics**: Approval chain adherence, legal compliance
- **Performance Metrics**: Objective completion, scenario outcome

---

## Victory Conditions & Scoring

**Note**: USE is **not competitive** - it's a **training/coordination exercise**.

**Success Metrics:**

- **Objective Completion**: Did players achieve scenario objectives?
- **Coordination Quality**: How well did agencies coordinate?
- **Decision Quality**: Were decisions timely and appropriate?
- **Information Sharing**: Did players effectively share information?
- **Compliance**: Did players follow proper approval chains?

**No "Winners" or "Losers":**

- Focus is on **learning and improvement**
- Metrics show **areas for improvement**
- AAR provides **actionable feedback**
- Multiple sessions allow **progressive improvement**

---

## Real-Time vs Turn-Based

**USE is Real-Time:**

- Sessions run in **real-time** (or accelerated time)
- Players act **simultaneously**
- Events occur **continuously**
- No turn order or waiting

**Time Acceleration:**

- Trainer can set **time acceleration** (e.g., 1 real minute = 1 scenario hour)
- Allows longer scenarios to complete in shorter real-time
- Clock speed can be **adjusted** during session

---

## Player Interaction

**Cooperation Required:**

- Players **must cooperate** to succeed
- Information sharing is **essential**
- Resource coordination is **critical**
- Decisions often require **multi-agency approval**

**Communication-Driven:**

- Most gameplay happens through **communication**
- Players discuss situations, share information, negotiate resources
- Effective communication leads to **better outcomes**

**Role Constraints:**

- Each role has **specific authority**
- Players can only make decisions within their **role scope**
- Approval chains enforce **hierarchy**
- Blind spots create **information dependencies**

---

## Scenario State Variables

**Tracked Variables:**

- **Public Sentiment**: -100 to +100
- **Political Pressure**: Low/Medium/High
- **Resource Levels**: Per agency, per resource type
- **Incident Status**: Active incidents and their states
- **Casualty Counts**: Total and per incident
- **Infrastructure Status**: Power, water, transportation, communications
- **Weather Conditions**: Current and forecast
- **Media Coverage**: Volume and sentiment of coverage
- **Misinformation Spread**: Level and impact

**State Updates:**

- State updates **automatically** based on:
  - Player decisions
  - AI injects
  - Resource transactions
  - Time progression
- State changes are **visible** in COP
- State history is **tracked** for replay

---

## Session Duration & Pacing

**Typical Durations:**

- **Short Scenarios**: 30-60 minutes
- **Standard Scenarios**: 60-120 minutes
- **Extended Scenarios**: 120-180 minutes
- **Full-Day Exercises**: 4-8 hours

**Pacing:**

- **Injects** spaced throughout session
- **Decisions** required at key moments
- **Communication** continuous
- **State changes** gradual but noticeable

**Trainer Control:**

- Trainer can **pause** session for discussion
- Trainer can **accelerate** time for faster progression
- Trainer can **trigger** additional injects if needed
- Trainer can **end** session early if objectives met

---

## Multi-Session Progression

**Progressive Difficulty:**

- Players start with **beginner** scenarios
- Progress to **intermediate** and **advanced**
- **Expert** scenarios for experienced teams

**Team Building:**

- Same teams can play **multiple sessions**
- Teams learn to **coordinate better** over time
- Metrics show **improvement** in coordination
- AARs provide **actionable feedback**

**Certification:**

- Completed sessions generate **certificates**
- Certificates show **participation** and **performance**
- Certificates can be **exported** to LMS systems
- Certificates track **training hours** and **objectives met**

---

## Technical Implementation Notes

**Real-Time Updates:**

- WebSocket connections for **instant updates**
- Event sourcing for **replay capability**
- Optimistic UI updates for **smooth UX**

**Data Persistence:**

- All events stored in **event log**
- State snapshots for **quick loading**
- Full audit trail for **compliance**

**Scalability:**

- Support **multiple simultaneous sessions**
- Support **100+ concurrent users** per session
- Horizontal scaling for **large deployments**

---

## Future Enhancements

**Planned Features:**

- **Voice/Video Integration**: Real-time voice/video communication
- **Mobile Companion**: Mobile app for field operations
- **Advanced AI**: More sophisticated AI inject generation
- **Scenario Marketplace**: Community-created scenarios
- **Advanced Analytics**: Machine learning for insights
- **VR/AR Support**: Immersive visualization options

---

This document serves as the definitive guide to game mechanics. As features are implemented, this document will be updated to reflect actual implementation details.
