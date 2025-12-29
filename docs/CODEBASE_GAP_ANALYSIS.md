# Codebase Gap Analysis: Gameplay Walkthrough Requirements

## Executive Summary

Based on the gameplay walkthrough for "Christmas Festival Terror Attack", the current codebase has **~40% of the required functionality** implemented. The foundation is solid (auth, scenarios, sessions, basic components), but several critical gameplay elements are missing or incomplete.

**Status:** ❌ **Not Ready** - Significant gaps in core gameplay mechanics

---

## ✅ What EXISTS (Implemented)

### 1. **Session Setup & Pre-Session**

- ✅ Scenario creation with briefing (general + role-specific)
- ✅ Session creation and scheduling
- ✅ Participant invitation (existing users + email invites)
- ✅ Session lobby with briefing view
- ✅ Participant ready status tracking
- ✅ Session status management (scheduled → in_progress)

### 2. **Basic UI Components**

- ✅ `SessionView` with tab navigation (COP, Chat, Decisions, Resources, Injects, Media, AAR)
- ✅ `TimelineFeed` component (displays events)
- ✅ `ChatInterface` component (channels, messages)
- ✅ `DecisionWorkflow` component (create, approve/reject)
- ✅ `ResourceMarketplace` component (request, approve/reject)
- ✅ `MediaFeed` component (displays media posts)
- ✅ `AIInjectSystem` component (trainer-only)
- ✅ `AARDashboard` component (basic AAR view)
- ✅ `SessionLobby` component (pre-session briefing)
- ✅ `BriefingView` component (briefing materials)

### 3. **Backend APIs**

- ✅ `/api/scenarios` (CRUD)
- ✅ `/api/sessions` (CRUD, participants, ready status)
- ✅ `/api/events` (list events)
- ✅ `/api/channels` (list, messages)
- ✅ `/api/decisions` (list, create, approve/reject)
- ✅ `/api/resources` (get, request, update request)
- ✅ `/api/media` (list)
- ✅ `/api/injects` (list, create, publish)
- ✅ `/api/aar` (get, generate)
- ✅ `/api/briefing` (get briefing)

### 4. **Infrastructure**

- ✅ WebSocket setup (`websocket.ts` - basic connection)
- ✅ Authentication (Supabase Auth)
- ✅ API client (`api.ts` with all endpoints)
- ✅ Email service (invitations)

---

## ❌ What's MISSING (Critical Gaps)

### 1. **COP Dashboard - Interactive Map** 🚨 CRITICAL

**Current State:**

- COP tab exists but map is a **placeholder** (`[MAP] Interactive map view coming soon...`)
- No map library integrated (Leaflet/Mapbox mentioned in docs but not implemented)

**Required for Walkthrough:**

- Interactive map showing Suntec City location
- Incident markers on map (e.g., "Incident #001: Suspicious Vehicle")
- Resource location markers (police deployment, medical response)
- Evacuation zone overlays (500m radius)
- Real-time map updates when incidents are created/updated

**Gap:** **100% missing** - Core COP visualization

---

### 2. **Incidents System** 🚨 CRITICAL

**Current State:**

- No incidents API endpoints (`/api/incidents` doesn't exist)
- No incidents database table
- No incidents UI component
- Walkthrough mentions "Incidents Panel" but doesn't exist

**Required for Walkthrough:**

- Create/manage incidents (e.g., "Explosion at Main Entrance")
- Assign incidents to agencies/roles
- Track incident status (Active, Resolved, Under Control)
- Link incidents to map markers
- Incident details (location, casualties, assigned to)

**Gap:** **100% missing** - Core gameplay mechanic

---

### 3. **Real-Time Updates via WebSocket** 🚨 CRITICAL

**Current State:**

- WebSocket connection exists but **not used**
- Components use **polling** (setInterval every 2-5 seconds):
  - `TimelineFeed`: `setInterval(loadEvents, 5000)`
  - `ChatInterface`: `setInterval(loadMessages, 2000)`
  - `DecisionWorkflow`: `setInterval(loadDecisions, 5000)`
  - `ResourceMarketplace`: `setInterval(loadResources, 5000)`

**Required for Walkthrough:**

- Real-time event notifications (red alert banner: "CRITICAL: EXPLOSION REPORTED")
- Instant timeline updates when new events occur
- Instant chat message delivery
- Instant decision status updates
- Instant resource transfer notifications

**Gap:** **90% missing** - WebSocket infrastructure exists but not integrated

---

### 4. **Decision Execution Workflow** 🚨 HIGH PRIORITY

**Current State:**

- Can create decisions
- Can approve/reject decisions
- **Cannot execute approved decisions**

**Required for Walkthrough:**

- Execute approved decisions (changes status to "EXECUTED")
- Update scenario state when decision is executed
- Trigger scenario updates (e.g., evacuation begins, resources deployed)
- Show execution impact on map/timeline

**Gap:** **80% missing** - Execution step not implemented

---

### 5. **Resource Counteroffer & Negotiation** 🚨 HIGH PRIORITY

**Current State:**

- Can request resources
- Can approve/reject requests
- **Cannot make counteroffers** (walkthrough shows Defence Liaison counteroffering 8 units instead of 10)

**Required for Walkthrough:**

- Make counteroffer with different quantity
- Add conditions to counteroffer
- Accept/reject counteroffers
- Track negotiation timeline

**Gap:** **70% missing** - Counteroffer functionality not implemented

---

### 6. **Information Sharing & Attachments** 🚨 HIGH PRIORITY

**Current State:**

- Chat supports text messages only
- No file attachments
- No special "share intelligence report" actions

**Required for Walkthrough:**

- Share intelligence reports via chat
- Attach files (maps, reports, data)
- Remove blind spots when information is shared
- Show "Intelligence Report Shared" notifications

**Gap:** **100% missing** - Information sharing mechanics

---

### 7. **Sentiment Tracking & Visualization** 🚨 HIGH PRIORITY

**Current State:**

- `MediaFeed` displays sentiment (positive/negative/critical) as text
- No sentiment graph/chart
- No sentiment score tracking over time
- No sentiment impact from decisions/statements

**Required for Walkthrough:**

- Sentiment graph showing trajectory (e.g., drops from 55 to 35, recovers to 50)
- Sentiment impact preview when drafting public statements
- Sentiment updates when statements are published
- Sentiment updates when misinformation spreads/countered

**Gap:** **80% missing** - Basic sentiment exists but no visualization or tracking

---

### 8. **Role-Based Information Visibility (Blind Spots)** 🚨 HIGH PRIORITY

**Current State:**

- No information visibility system
- No "blind spots" implementation
- All users see the same information (no filtering)

**Required for Walkthrough:**

- Each role sees different information
- Blind spots show "CLASSIFIED" blockers
- Information sharing removes blind spots
- Role-specific views in COP

**Gap:** **100% missing** - Core game mechanic for coordination

---

### 9. **Incident Assignment & Resource Deployment** 🚨 HIGH PRIORITY

**Current State:**

- No incident assignment UI
- No resource deployment UI
- No "Assign Officers" or "Deploy Medical Response" actions

**Required for Walkthrough:**

- Assign incidents to agencies/roles
- Allocate resources (e.g., "10 officers", "15 ambulances")
- Track resource usage (e.g., "Officers: 40/50 remaining")
- Update map when resources are deployed

**Gap:** **100% missing** - Critical gameplay actions

---

### 10. **Scenario State Management** 🚨 HIGH PRIORITY

**Current State:**

- Session has `current_state` field (JSON)
- No state management logic
- No state updates when decisions are executed
- No state updates when resources are transferred

**Required for Walkthrough:**

- Update scenario state when decisions are executed
- Update resource inventories when transfers occur
- Track scenario variables (evacuation status, perimeter status, casualty counts)
- State changes reflected in COP

**Gap:** **90% missing** - State exists but not managed

---

### 11. **Notification System** 🚨 HIGH PRIORITY

**Current State:**

- No notification system
- No alert banners (e.g., "CRITICAL: EXPLOSION REPORTED")
- No notification badges or indicators

**Required for Walkthrough:**

- Real-time alert banners (red for critical, yellow for media, green for updates)
- Notification system for new decisions requiring approval
- Notification system for resource requests
- Priority notifications (e.g., misinformation alerts for PIO)

**Gap:** **100% missing** - No notification infrastructure

---

### 12. **Decision Approval Chain Multi-Step** ⚠️ MEDIUM PRIORITY

**Current State:**

- Decisions have `required_approvers` (array)
- Approval logic is basic (checks if user role is in array)
- No multi-step approval chain (e.g., Civil Government → Legal Oversight)

**Required for Walkthrough:**

- Multi-step approval chains (decision moves through steps)
- Show current step in approval chain
- Track approval timeline
- Status: "Pending Civil Government" → "Under Review" → "Pending Legal Oversight" → "Approved"

**Gap:** **60% missing** - Basic approval exists but no step tracking

---

### 13. **Public Statement Drafting & Sentiment Preview** ⚠️ MEDIUM PRIORITY

**Current State:**

- Can create decisions with type "Public Statement"
- No sentiment impact preview
- No public statement workflow

**Required for Walkthrough:**

- Draft public statement
- Preview sentiment impact (+10 points predicted)
- Publish statement
- Update sentiment graph when published

**Gap:** **70% missing** - Decision system exists but no statement-specific workflow

---

### 14. **Timeline Replay (AAR)** ⚠️ MEDIUM PRIORITY

**Current State:**

- AAR shows summary and statistics
- **No timeline replay** functionality

**Required for Walkthrough:**

- Timeline replay with play/pause/jump controls
- Replay all events chronologically
- Jump to specific times
- Annotation features

**Gap:** **100% missing** - Timeline exists but no replay

---

### 15. **AI Inject Auto-Trigger** ⚠️ MEDIUM PRIORITY

**Current State:**

- Can create injects with `trigger_time_minutes`
- **No automatic triggering** when session time hits trigger time

**Required for Walkthrough:**

- Automatically trigger injects at scheduled times (e.g., at 00:05, 00:10, 00:15)
- Show injects as notifications/timeline events
- Update scenario state based on inject content

**Gap:** **90% missing** - Injects exist but no auto-trigger system

---

### 16. **Session Clock/Timer** ⚠️ MEDIUM PRIORITY

**Current State:**

- No visible session clock in UI
- No timer tracking elapsed time
- Walkthrough shows "[00:00]", "[00:05]", etc.

**Required for Walkthrough:**

- Display session elapsed time (e.g., "00:15 / 60:00")
- Use clock to trigger scheduled injects
- Show time in timeline feed

**Gap:** **100% missing** - No session timer

---

### 17. **SITREP Templates** ⚠️ LOW PRIORITY

**Current State:**

- No SITREP templates
- Chat supports plain text only

**Required for Walkthrough:**

- SITREP template forms
- Structured situation reports
- Pre-filled templates per role

**Gap:** **100% missing** - Nice-to-have feature

---

### 18. **Metrics & Analytics** ⚠️ LOW PRIORITY

**Current State:**

- AAR shows basic statistics (event count, decision count)
- **No detailed analytics** (decision latency, coordination scores, etc.)

**Required for Walkthrough:**

- Decision latency analysis (time from proposal to execution)
- Coordination scores
- Communication efficiency metrics
- Sentiment trajectory analysis

**Gap:** **70% missing** - Basic stats exist but no detailed analytics

---

## 🎯 Priority Breakdown

### **CRITICAL** (Blocking gameplay)

1. Interactive Map (COP)
2. Incidents System
3. Real-Time WebSocket Updates
4. Role-Based Information Visibility (Blind Spots)
5. Incident Assignment & Resource Deployment

### **HIGH PRIORITY** (Core gameplay mechanics)

6. Decision Execution Workflow
7. Resource Counteroffer & Negotiation
8. Information Sharing & Attachments
9. Sentiment Tracking & Visualization
10. Scenario State Management
11. Notification System

### **MEDIUM PRIORITY** (Enhanced gameplay)

12. Decision Approval Chain Multi-Step
13. Public Statement Drafting & Sentiment Preview
14. Timeline Replay (AAR)
15. AI Inject Auto-Trigger
16. Session Clock/Timer

### **LOW PRIORITY** (Nice-to-have)

17. SITREP Templates
18. Metrics & Analytics

---

## 📊 Implementation Estimate

Based on the gaps identified:

- **Critical:** ~3-4 weeks
- **High Priority:** ~2-3 weeks
- **Medium Priority:** ~1-2 weeks
- **Low Priority:** ~1 week

**Total Estimated Time:** ~7-10 weeks of focused development

---

## 🔧 Technical Recommendations

### Immediate Next Steps:

1. **Integrate Leaflet/Mapbox** for interactive map
2. **Create incidents system** (database table + API + UI)
3. **Implement WebSocket event broadcasting** in backend
4. **Connect frontend components to WebSocket** (remove polling)
5. **Implement role-based information visibility** (filtering logic)

### Architecture Considerations:

- **WebSocket Events:** Need to define event types (e.g., `incident.created`, `decision.executed`, `resource.transferred`)
- **State Management:** Consider using Zustand/Redux for scenario state
- **Real-Time Sync:** Implement optimistic UI updates with server confirmation
- **Notification System:** Build notification queue and priority system

---

## ✅ Conclusion

The codebase has a **solid foundation** with authentication, scenarios, sessions, and basic components. However, **critical gameplay mechanics are missing**:

- ❌ No interactive map (COP is placeholder)
- ❌ No incidents system
- ❌ No real-time updates (using polling instead)
- ❌ No role-based information visibility
- ❌ No incident/resource assignment workflows

**Recommendation:** Focus on **Critical** and **High Priority** items first to make the gameplay walkthrough functional. The current codebase is **not ready** for the described gameplay experience, but with focused development on the gaps above, it can achieve it.
