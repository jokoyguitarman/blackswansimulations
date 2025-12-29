# Implementation Phases: Gameplay Walkthrough Features

## Overview

This document outlines the phased implementation plan to achieve the gameplay walkthrough described in `GAMEPLAY_WALKTHROUGH.md`. Phases are ordered by priority and dependencies.

**Total Estimated Timeline:** 7-10 weeks  
**Team Size Assumption:** 1-2 developers

---

## Phase 1: Foundation - Real-Time Infrastructure (Week 1-2)

**Goal:** Replace polling with real-time WebSocket updates and establish event system

### 1.1 Backend WebSocket Event Broadcasting

**Tasks:**

- [ ] Create WebSocket event types/enums
- [ ] Implement event broadcasting in backend routes:
  - `POST /api/decisions` → emit `decision.proposed`
  - `POST /api/decisions/:id/approve` → emit `decision.approved`
  - `POST /api/decisions/:id/execute` → emit `decision.executed`
  - `POST /api/resources/requests` → emit `resource.requested`
  - `POST /api/channels/:id/messages` → emit `message.sent`
  - `POST /api/injects/:id/publish` → emit `inject.published`
- [ ] Create WebSocket room management (session rooms, channel rooms)
- [ ] Add authentication to WebSocket connections

**Files to Create/Modify:**

- `server/services/websocketService.ts` (new)
- `server/routes/decisions.ts` (modify)
- `server/routes/resources.ts` (modify)
- `server/routes/channels.ts` (modify)
- `server/routes/injects.ts` (modify)
- `server/index.ts` (modify - WebSocket setup)

**Deliverables:**

- ✅ Real-time event broadcasting for decisions, resources, messages, injects
- ✅ WebSocket rooms per session
- ✅ Authenticated WebSocket connections

---

### 1.2 Frontend WebSocket Integration

**Tasks:**

- [ ] Create WebSocket event listeners in components
- [ ] Replace polling with WebSocket subscriptions:
  - `TimelineFeed` - listen for `event.*` events
  - `ChatInterface` - listen for `message.sent` events
  - `DecisionWorkflow` - listen for `decision.*` events
  - `ResourceMarketplace` - listen for `resource.*` events
- [ ] Implement optimistic UI updates
- [ ] Add reconnection logic

**Files to Create/Modify:**

- `frontend/src/lib/websocket.ts` (modify - add event listeners)
- `frontend/src/hooks/useWebSocket.ts` (new - React hook)
- `frontend/src/components/COP/TimelineFeed.tsx` (modify)
- `frontend/src/components/Chat/ChatInterface.tsx` (modify)
- `frontend/src/components/Decisions/DecisionWorkflow.tsx` (modify)
- `frontend/src/components/Resources/ResourceMarketplace.tsx` (modify)

**Deliverables:**

- ✅ All components use WebSocket instead of polling
- ✅ Real-time updates across all tabs
- ✅ Optimistic UI updates for better UX

---

### 1.3 Notification System

**Tasks:**

- [ ] Create notification component (alert banners)
- [ ] Create notification store/context
- [ ] Implement priority levels (critical, high, medium, low)
- [ ] Add notification types:
  - Critical alerts (red banner)
  - Media reports (yellow banner)
  - Updates (green banner)
- [ ] Integrate with WebSocket events

**Files to Create/Modify:**

- `frontend/src/components/Notifications/NotificationBanner.tsx` (new)
- `frontend/src/components/Notifications/NotificationCenter.tsx` (new)
- `frontend/src/contexts/NotificationContext.tsx` (new)
- `frontend/src/pages/SessionView.tsx` (modify - add notification banner)

**Deliverables:**

- ✅ Notification system with priority levels
- ✅ Alert banners for critical events
- ✅ Notification center for history

---

## Phase 2: Core Gameplay - Incidents System (Week 2-3)

**Goal:** Implement incidents system for tracking crisis events

### 2.1 Database Schema

**Tasks:**

- [ ] Create `incidents` table migration
- [ ] Create `incident_assignments` table (many-to-many with agencies)
- [ ] Create `incident_updates` table (status history)
- [ ] Add RLS policies for incidents

**Files to Create:**

- `migrations/008_incidents.sql`

**Schema:**

```sql
CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  title TEXT NOT NULL,
  description TEXT,
  location_lat DECIMAL(10, 8),
  location_lng DECIMAL(11, 8),
  status TEXT NOT NULL DEFAULT 'active', -- active, resolved, under_control, contained
  severity TEXT NOT NULL DEFAULT 'medium', -- low, medium, high, critical
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE incident_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id),
  agency_role TEXT NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Deliverables:**

- ✅ Database schema for incidents
- ✅ RLS policies for role-based access

---

### 2.2 Backend API

**Tasks:**

- [ ] Create `POST /api/incidents` - Create incident
- [ ] Create `GET /api/incidents?sessionId=:id` - List incidents
- [ ] Create `GET /api/incidents/:id` - Get incident details
- [ ] Create `PATCH /api/incidents/:id` - Update incident
- [ ] Create `POST /api/incidents/:id/assign` - Assign to agency
- [ ] Create `POST /api/incidents/:id/resources` - Allocate resources
- [ ] Emit WebSocket events for incident changes

**Files to Create/Modify:**

- `server/routes/incidents.ts` (new)
- `server/index.ts` (modify - add route)

**Deliverables:**

- ✅ Full CRUD API for incidents
- ✅ Assignment and resource allocation endpoints
- ✅ WebSocket events for real-time updates

---

### 2.3 Frontend Components

**Tasks:**

- [ ] Create `IncidentsPanel` component
- [ ] Create `IncidentCard` component
- [ ] Create `CreateIncidentForm` component
- [ ] Create `AssignIncidentModal` component
- [ ] Integrate with COP tab
- [ ] Add incident filters (status, severity)

**Files to Create:**

- `frontend/src/components/Incidents/IncidentsPanel.tsx` (new)
- `frontend/src/components/Incidents/IncidentCard.tsx` (new)
- `frontend/src/components/Forms/CreateIncidentForm.tsx` (new)
- `frontend/src/components/Incidents/AssignIncidentModal.tsx` (new)
- `frontend/src/pages/SessionView.tsx` (modify - add incidents tab/panel)
- `frontend/src/lib/api.ts` (modify - add incidents API methods)

**Deliverables:**

- ✅ Incidents panel in COP tab
- ✅ Create/assign/update incidents UI
- ✅ Real-time incident updates

---

## Phase 3: Interactive Map (Week 3-4)

**Goal:** Replace placeholder map with interactive Leaflet map

### 3.1 Map Integration

**Tasks:**

- [ ] Install Leaflet and React-Leaflet
- [ ] Create `MapView` component
- [ ] Integrate with session location data
- [ ] Add map controls (zoom, pan, layers)

**Files to Create/Modify:**

- `frontend/package.json` (modify - add leaflet dependencies)
- `frontend/src/components/COP/MapView.tsx` (new)
- `frontend/src/pages/SessionView.tsx` (modify - replace placeholder)

**Dependencies:**

```json
{
  "leaflet": "^1.9.4",
  "react-leaflet": "^4.2.1"
}
```

**Deliverables:**

- ✅ Interactive map in COP tab
- ✅ Basic map controls

---

### 3.2 Map Markers & Overlays

**Tasks:**

- [ ] Display incident markers on map
- [ ] Display resource deployment markers
- [ ] Display evacuation zones (circles)
- [ ] Add marker popups with details
- [ ] Color-code markers by severity/type
- [ ] Real-time marker updates via WebSocket

**Files to Create/Modify:**

- `frontend/src/components/COP/MapView.tsx` (modify)
- `frontend/src/components/COP/IncidentMarker.tsx` (new)
- `frontend/src/components/COP/ResourceMarker.tsx` (new)
- `frontend/src/components/COP/EvacuationZone.tsx` (new)

**Deliverables:**

- ✅ Incident markers on map
- ✅ Resource deployment markers
- ✅ Evacuation zone overlays
- ✅ Real-time map updates

---

### 3.3 Map Integration with Incidents

**Tasks:**

- [ ] Click incident on map → show details
- [ ] Click incident in panel → center map
- [ ] Create incident from map click
- [ ] Update map when incidents change

**Files to Modify:**

- `frontend/src/components/COP/MapView.tsx`
- `frontend/src/components/Incidents/IncidentsPanel.tsx`

**Deliverables:**

- ✅ Map and incidents panel synchronized
- ✅ Create incidents from map

---

## Phase 4: Decision Execution & State Management (Week 4-5)

**Goal:** Implement decision execution and scenario state updates

### 4.1 Decision Execution Workflow

**Tasks:**

- [ ] Add `POST /api/decisions/:id/execute` endpoint
- [ ] Update decision status to "executed"
- [ ] Create execution log entry
- [ ] Emit WebSocket event `decision.executed`
- [ ] Add "Execute Decision" button in UI

**Files to Create/Modify:**

- `server/routes/decisions.ts` (modify)
- `frontend/src/components/Decisions/DecisionWorkflow.tsx` (modify)
- `frontend/src/lib/api.ts` (modify)

**Deliverables:**

- ✅ Execute approved decisions
- ✅ Execution updates timeline and state

---

### 4.2 Scenario State Management

**Tasks:**

- [ ] Create state update service
- [ ] Update state when decisions are executed:
  - Evacuation order → update evacuation zones
  - Resource allocation → update resource inventories
  - Public statement → update sentiment
- [ ] Create state snapshot system
- [ ] Track state history for replay

**Files to Create/Modify:**

- `server/services/scenarioStateService.ts` (new)
- `server/routes/decisions.ts` (modify - call state service)
- `migrations/009_scenario_state_history.sql` (new)

**Deliverables:**

- ✅ Scenario state updates on decision execution
- ✅ State history tracking

---

### 4.3 Multi-Step Approval Chains

**Tasks:**

- [ ] Create `decision_steps` table
- [ ] Implement step-by-step approval workflow
- [ ] Track current step in approval chain
- [ ] Show approval progress in UI
- [ ] Auto-advance to next step on approval

**Files to Create/Modify:**

- `migrations/010_decision_steps.sql` (new)
- `server/routes/decisions.ts` (modify)
- `frontend/src/components/Decisions/DecisionWorkflow.tsx` (modify)

**Deliverables:**

- ✅ Multi-step approval chains
- ✅ Approval progress tracking

---

## Phase 5: Resource Marketplace Enhancements (Week 5-6)

**Goal:** Add counteroffer functionality and resource transfers

### 5.1 Resource Counteroffers

**Tasks:**

- [ ] Add `POST /api/resources/requests/:id/counter` endpoint
- [ ] Update request status to "countered"
- [ ] Store counteroffer details (quantity, conditions)
- [ ] Add counteroffer UI
- [ ] Emit WebSocket events

**Files to Create/Modify:**

- `server/routes/resources.ts` (modify)
- `frontend/src/components/Resources/ResourceMarketplace.tsx` (modify)
- `frontend/src/components/Forms/CreateResourceCounterofferForm.tsx` (new)
- `frontend/src/lib/api.ts` (modify)

**Deliverables:**

- ✅ Counteroffer functionality
- ✅ Negotiation workflow

---

### 5.2 Resource Transfers

**Tasks:**

- [ ] Create `resource_transactions` table
- [ ] Implement resource transfer on approval
- [ ] Update agency resource inventories
- [ ] Update map when resources are transferred
- [ ] Track transfer history

**Files to Create/Modify:**

- `migrations/011_resource_transactions.sql` (new)
- `server/routes/resources.ts` (modify)
- `server/services/resourceService.ts` (new or modify)
- `frontend/src/components/Resources/ResourceMarketplace.tsx` (modify)

**Deliverables:**

- ✅ Resource transfers update inventories
- ✅ Transfer history tracking

---

## Phase 6: Information Visibility & Sharing (Week 6-7)

**Goal:** Implement role-based information filtering

### 6.1 Role-Based Information Visibility

**Tasks:**

- [ ] Create `information_visibility` table (role → information type mappings)
- [ ] Create visibility service
- [ ] Filter incidents by role visibility
- [ ] Filter decisions by role visibility
- [ ] Show "CLASSIFIED" blockers for blind spots
- [ ] Create `ClassifiedBlocker` component (already exists, enhance)

**Files to Create/Modify:**

- `migrations/012_information_visibility.sql` (new)
- `server/services/visibilityService.ts` (new)
- `server/routes/incidents.ts` (modify - filter by visibility)
- `server/routes/decisions.ts` (modify - filter by visibility)
- `frontend/src/components/ClassifiedBlocker.tsx` (modify)
- `frontend/src/hooks/useRoleVisibility.ts` (modify)

**Deliverables:**

- ✅ Role-based information filtering
- ✅ Blind spots shown as "CLASSIFIED"

---

### 6.2 Information Sharing

**Tasks:**

- [ ] Add file attachment support to messages
- [ ] Create "Share Intelligence Report" action
- [ ] Create "Share Route Map" action
- [ ] Update visibility when information is shared
- [ ] Remove blind spots after sharing
- [ ] Track information sharing in audit log

**Files to Create/Modify:**

- `server/routes/channels.ts` (modify - add attachments)
- `server/routes/messages.ts` (new - handle file uploads)
- `frontend/src/components/Chat/ChatInterface.tsx` (modify)
- `frontend/src/components/Chat/ShareIntelligenceModal.tsx` (new)
- `migrations/013_message_attachments.sql` (new)

**Deliverables:**

- ✅ File attachments in chat
- ✅ Special share actions
- ✅ Visibility updates on sharing

---

## Phase 7: Sentiment & Media (Week 7-8)

**Goal:** Add sentiment tracking and visualization

### 7.1 Sentiment Tracking

**Tasks:**

- [ ] Create `sentiment_snapshots` table
- [ ] Track sentiment score over time
- [ ] Update sentiment on public statements
- [ ] Update sentiment on misinformation
- [ ] Calculate sentiment impact of statements

**Files to Create/Modify:**

- `migrations/014_sentiment_tracking.sql` (new)
- `server/services/sentimentService.ts` (new)
- `server/routes/decisions.ts` (modify - update sentiment)
- `server/routes/media.ts` (modify - update sentiment)

**Deliverables:**

- ✅ Sentiment score tracking
- ✅ Sentiment updates on events

---

### 7.2 Sentiment Visualization

**Tasks:**

- [ ] Install Recharts
- [ ] Create `SentimentGraph` component
- [ ] Display sentiment trajectory over time
- [ ] Show sentiment impact preview for statements
- [ ] Add sentiment to COP tab

**Files to Create/Modify:**

- `frontend/package.json` (modify - add recharts)
- `frontend/src/components/Media/SentimentGraph.tsx` (new)
- `frontend/src/components/Forms/CreateDecisionForm.tsx` (modify - add sentiment preview)
- `frontend/src/pages/SessionView.tsx` (modify - add sentiment to COP)

**Dependencies:**

```json
{
  "recharts": "^2.10.3"
}
```

**Deliverables:**

- ✅ Sentiment graph visualization
- ✅ Sentiment impact preview

---

### 7.3 Public Statement Workflow

**Tasks:**

- [ ] Create "Public Statement" decision type
- [ ] Add sentiment impact preview
- [ ] Streamline approval chain (Civil Government only)
- [ ] Publish statement to media feed
- [ ] Update sentiment on publish

**Files to Create/Modify:**

- `frontend/src/components/Forms/CreateDecisionForm.tsx` (modify)
- `server/routes/decisions.ts` (modify)
- `server/routes/media.ts` (modify - publish statements)

**Deliverables:**

- ✅ Public statement workflow
- ✅ Sentiment updates on publish

---

## Phase 8: Session Clock & Auto-Injects (Week 8)

**Goal:** Add session timer and automatic inject triggering

### 8.1 Session Clock

**Tasks:**

- [ ] Create `SessionClock` component
- [ ] Track session elapsed time
- [ ] Display timer in session header
- [ ] Store session start time
- [ ] Calculate elapsed time from start

**Files to Create/Modify:**

- `frontend/src/components/Session/SessionClock.tsx` (new)
- `frontend/src/pages/SessionView.tsx` (modify - add clock)
- `server/routes/sessions.ts` (modify - store start_time)

**Deliverables:**

- ✅ Session timer display
- ✅ Elapsed time tracking

---

### 8.2 Auto-Inject Triggering

**Tasks:**

- [ ] Create inject scheduler service
- [ ] Check for scheduled injects every minute
- [ ] Auto-trigger injects at scheduled times
- [ ] Emit WebSocket events for triggered injects
- [ ] Update timeline with inject events

**Files to Create/Modify:**

- `server/services/injectSchedulerService.ts` (new)
- `server/routes/injects.ts` (modify)
- `server/index.ts` (modify - start scheduler)

**Deliverables:**

- ✅ Automatic inject triggering
- ✅ Scheduled injects fire at correct times

---

## Phase 9: AAR Enhancements (Week 9)

**Goal:** Add timeline replay and enhanced analytics

### 9.1 Timeline Replay

**Tasks:**

- [ ] Create `TimelineReplay` component
- [ ] Add play/pause controls
- [ ] Add jump-to-time controls
- [ ] Replay events chronologically
- [ ] Sync map/incidents with replay time

**Files to Create/Modify:**

- `frontend/src/components/AAR/TimelineReplay.tsx` (new)
- `frontend/src/components/AAR/AARDashboard.tsx` (modify)

**Deliverables:**

- ✅ Timeline replay functionality
- ✅ Play/pause/jump controls

---

### 9.2 Enhanced Analytics

**Tasks:**

- [ ] Calculate decision latency metrics
- [ ] Calculate coordination scores
- [ ] Calculate communication efficiency
- [ ] Create analytics charts
- [ ] Display metrics in AAR

**Files to Create/Modify:**

- `server/services/analyticsService.ts` (new)
- `server/routes/aar.ts` (modify)
- `frontend/src/components/AAR/AARDashboard.tsx` (modify)

**Deliverables:**

- ✅ Detailed analytics metrics
- ✅ Analytics visualizations

---

## Phase 10: Polish & Testing (Week 10)

**Goal:** Final polish, bug fixes, and testing

### 10.1 Bug Fixes & Edge Cases

**Tasks:**

- [ ] Fix any bugs discovered during testing
- [ ] Handle edge cases (empty states, errors)
- [ ] Improve error messages
- [ ] Add loading states
- [ ] Optimize performance

**Deliverables:**

- ✅ Bug-free gameplay experience
- ✅ Proper error handling

---

### 10.2 UI/UX Polish

**Tasks:**

- [ ] Improve visual design consistency
- [ ] Add animations/transitions
- [ ] Improve mobile responsiveness
- [ ] Add tooltips and help text
- [ ] Improve accessibility

**Deliverables:**

- ✅ Polished UI/UX
- ✅ Accessible interface

---

### 10.3 Documentation & Testing

**Tasks:**

- [ ] Update gameplay walkthrough with actual features
- [ ] Create user guide
- [ ] Write integration tests
- [ ] Performance testing
- [ ] Security audit

**Deliverables:**

- ✅ Complete documentation
- ✅ Test coverage

---

## Implementation Order Summary

```
Week 1-2:  Phase 1 - Real-Time Infrastructure
Week 2-3:  Phase 2 - Incidents System
Week 3-4:  Phase 3 - Interactive Map
Week 4-5:  Phase 4 - Decision Execution & State
Week 5-6:  Phase 5 - Resource Marketplace Enhancements
Week 6-7:  Phase 6 - Information Visibility & Sharing
Week 7-8:  Phase 7 - Sentiment & Media
Week 8:    Phase 8 - Session Clock & Auto-Injects
Week 9:    Phase 9 - AAR Enhancements
Week 10:   Phase 10 - Polish & Testing
```

---

## Dependencies Between Phases

```
Phase 1 (Real-Time) → All other phases (foundation)
Phase 2 (Incidents) → Phase 3 (Map markers)
Phase 3 (Map) → Phase 4 (State updates on map)
Phase 4 (State) → Phase 5 (Resource transfers)
Phase 6 (Visibility) → Phase 7 (Sentiment filtering)
Phase 7 (Sentiment) → Phase 9 (Analytics)
Phase 8 (Clock) → Phase 2 (Auto-trigger incidents)
```

---

## Quick Start: Minimum Viable Gameplay

To get a **playable version** of the walkthrough, focus on:

1. **Phase 1** - Real-time updates (enables all other features)
2. **Phase 2** - Incidents system (core gameplay)
3. **Phase 3** - Interactive map (visual COP)
4. **Phase 4** - Decision execution (core mechanic)

**Estimated Time:** 4-5 weeks for MVP

---

## Notes

- Each phase builds on previous phases
- Phases can be worked on in parallel where dependencies allow
- Testing should be done incrementally after each phase
- Consider feature flags for gradual rollout
