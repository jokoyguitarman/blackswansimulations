# Unified Simulation Environment – Technical Architecture & Stack Overview

## 1. Architectural Goals

- **Security-first**: Role-based access, full audit logging, encryption, deployable in air-gapped or SaaS environments.
- **Real-time collaboration**: Low-latency updates for incident reports, decisions, and resource allocations across agencies.
- **AI-assisted but human-controlled**: AI services augment trainers (event injects, summaries) with clear guardrails and overrides.
- **Modular & scalable**: Components can scale independently (scenario engine, communications, analytics) and support high concurrency.
- **Deployable anywhere**: Cloud-native baseline with scripts and containerization for on-premise and offline deployments (Supabase self-hosting or fallback auth available for air-gapped mode).

## 2. High-Level Architecture

- **Client Apps**
  - Web client (React SPA) for trainers, participants, observers.
  - Optional mobile companion (future) for offline data capture.
- **APIs & Services**
  - REST API for CRUD operations and admin tasks.
  - WebSocket gateway for real-time events (Socket.io).
  - Background workers for AI generation, report compilation, notifications.
- **Data Layer**
  - Supabase Postgres (managed) as the primary relational store.
  - Supabase Auth for identity, session, and user metadata management.
  - Redis (optional) for pub/sub event fan-out and caching where Supabase real-time is insufficient.
  - Supabase storage buckets (or S3-compatible) for documents and exports.
- **Integration & Infrastructure**
  - Identity providers (SAML/OIDC) via auth gateway.
  - AI providers (OpenAI, Anthropic, local models) via AI orchestration service.
  - Observability stack (Prometheus + Grafana/ELK) for metrics/logs.
  - Deployment via containers (Docker/Kubernetes); infrastructure-as-code (Terraform/Ansible).

```
[Clients] → [API Gateway] → [Service Layer] → [DB/Cache/Storage]
                    ↓                ↑
                [WebSocket] ← [Event Bus/Workers]
                    ↓
                [AI Orchestrator]
```

## 3. Frontend Stack & Inner Workings

- **Framework**: React 18 + TypeScript (Vite build) for fast iterative dev.
- **State Management**: Zustand or Redux Toolkit; React Query for server state caching.
- **UI Layer**: Tailwind CSS + component library (Radix UI) for consistent styling. Custom data-visualisation via Recharts/D3.
- **Mapping**: Leaflet or Mapbox GL with agency overlays, incident markers, resource heatmaps.
- **Routing**: React Router for protected routes per role.
- **Real-Time Updates**: Socket.io client maintains WebSocket connection for COP updates, inject alerts, chat.
- **Offline Capability**: Service workers cache briefing packs; conflict resolution handled server-side when resynced.

### Frontend Modules

1. **Authentication Shell**: Supabase client SDK handles sign-in (email magic link, SSO, OTP) and session refresh, injects role metadata into app context, passes JWT access tokens to API calls.
2. **Scenario Workspace**: timeline editor, inject builder (drag-and-drop, AI suggestions), participant roster management.
3. **COP Dashboard**: map, incident feed, resource tracker, sentiment gauges, AI insights panel.
4. **Decision Console**: workflow builder, approval queue, digital signature capture, compliance indicators.
5. **Communications Hub**: chat channels, SITREP templates, announcement composer, voice/video integration placeholder.
6. **Media Simulation**: social feed UI, misinformation tracking, public sentiment analytics.
7. **Resource Marketplace**: negotiation board, trade timeline, visual impact modeling.
8. **AAR Studio**: replay timeline, metric dashboards, annotation tools, export controls.

Each module communicates with the backend via REST (initial loads) and WebSocket (live updates). Local caching ensures smooth UX; server pushes diff updates to minimize payload size.

## 4. Backend Stack & Inner Workings

- **Runtime**: Node.js (LTS) with TypeScript for shared domain models.
- **Framework**: Express.js or Fastify for HTTP APIs; Socket.io or uWebSockets for WebSocket layer.
- **Database ORM/Client**: Supabase client (postgrest + pg) or Prisma (with Supabase connection) for schema management (supports multi-tenant, migrations).
- **Real-Time Coordination**: Supabase Realtime or Redis pub/sub channels feed WebSocket gateway; event sourcing for replay features.
- **Background Workers**: BullMQ (Redis-backed queue) or Temporal for long-running tasks (AI generation, report compilation).
- **AI Orchestration**: Dedicated service mediates prompts, applies guardrails, and caches outputs.
- **Authentication**: Supabase Auth sessions validated via JWT middleware; role metadata derived from Supabase profiles/claims.
- **Audit & Logging**: Structured logs (Winston/Pino) streamed to central log store.
- **Configuration**: `.env` or secrets store per deployment; feature flags toggled via LaunchDarkly/open-source equivalent.

### Service Breakdown

1. **Auth Integration Layer**
   - Delegates identity management to Supabase Auth (email, SSO, MFA).
   - Syncs Supabase user metadata into internal `users` domain table for role/agency mapping.
   - Exposes `/auth/profile`, `/auth/roles` by reading Supabase profile + custom claims.

2. **Scenario Service**
   - CRUD for scenarios, inject templates, state variables.
   - Timeline scheduler triggers injects → event bus.
   - Uses rule engine (e.g., JSONLogic) plus AI suggestions.

3. **Session Manager**
   - Orchestrates live exercises: tracks participants, status (`scheduled`, `in_progress`, `paused`).
   - Manages scenario clocks, syncs state snapshots.

4. **Decision Workflow Service**
   - Stores decisions, approval chains, digital signatures.
   - Enforces required approvers, timeouts, escalation notifications.

5. **Communications Service**
   - Chat persistence, channel access control, message retention policies.
   - Integrates with WebSocket for live delivery.

6. **Resource Marketplace Service**
   - Manages inventories, allocation proposals, negotiation states.
   - Simulates impact on scenario state (feedback via scenario engine).

7. **Media & Sentiment Service**
   - Generates mock posts, tracks sentiment curves, misinformation flags.
   - Provides APIs for public statement authoring and effect modeling.

8. **Analytics & AAR Service**
   - Aggregates event data, computes metrics, renders charts.
   - Produces replay sequences from event log.
   - Generates export packages (PDF/Excel) and LMS-compatible results.

9. **AI Orchestrator**
   - Wraps external/local LLMs.
   - Applies templates, scenario context, red-teaming filters.
   - Logs prompts/responses for audit; provides trainer override queue.

### Event Flow Example (AI Inject)

1. Scenario clock hits trigger → Scenario Service emits `inject.requested` event.
2. AI Orchestrator consumes event, generates content (ensuring fictional parameters).
3. Trainer dashboard receives preview via WebSocket; trainer approves or edits.
4. On approval, event emitted `inject.published` → COP dashboard updates, notifications sent.
5. Event stored in event log → Analytics uses data for AAR.

## 5. Data Model Highlights

- **Users & Roles**: `users`, `roles`, `permissions`, `role_assignments` tables. Support custom roles per agency.
- **Scenarios**: `scenarios`, `scenario_injects`, `scenario_states`, `scenario_assets`.
- **Sessions**: `sessions`, `session_participants`, `session_events` (event-sourced log).
- **Decisions**: `decisions`, `decision_steps`, `decision_signatures`, `decision_attachments`.
- **Communications**: `channels`, `channel_members`, `messages`, `sitrep_templates`.
- **Resources**: `agency_resources`, `resource_allocations`, `resource_transactions`.
- **Media & Sentiment**: `media_posts`, `sentiment_snapshots`, `misinformation_events`.
- **Analytics**: Derived tables/materialized views for metrics; precomputed for performance.

## 6. Security & Compliance Layers

- **Authentication**: Supabase Auth (with SSO/MFA) issues JWTs; backend validates signatures, enforces role/agency rules via Supabase Row-Level Security and service role access for privileged operations.
- **Authorization**: Policy engine (Casbin or homegrown) evaluating role + scenario context.
- **Data Protection**: AES at rest, TLS in transit. Field-level encryption for sensitive data. Row-level security for multi-tenancy.
- **Audit Logging**: Immutable event store (append-only) with periodic hashing for tamper detection.
- **Content Moderation**: Scenario submissions flagged for review; AI outputs scanned for prohibited topics.
- **Governance**: Admin dashboards for policy management, data retention schedules, export controls.

## 7. DevOps & Deployment

- **CI/CD**: GitHub Actions/GitLab CI pipelines running linting, tests, security scans, container builds.
- **Testing**: Jest/Vitest (unit), Playwright/Cypress (e2e), contract tests for APIs.
- **Infrastructure**:
  - Supabase managed project (cloud) or self-hosted Supabase stack for on-prem; Kubernetes cluster for the additional backend services; docker-compose/Ansible scripts for fully air-gapped deployments.
  - Observability: Prometheus (metrics), Loki/ELK (logs), Alertmanager (alerts).
  - Feature flag service for gradual rollout.
- **Offline Mode**:
  - Local data store (SQLite/IndexedDB) on mobile companion.
  - Sync service reconciles events when connectivity restored.
- **Disaster Recovery**: Point-in-time backups, cross-region replication (cloud), documented restore drills.

## 8. AI Integration Details

- **Scenario Logic Engine**: Rule-based core with AI suggestions; reinforcement rules adjust difficulty.
- **Coach Assistant**: Pulls from current state, highlights missing coordination, provides reminders (labelled as AI suggestions).
- **AAR Summaries**: Structured prompts based on event logs; outputs reviewed by trainers before distribution.
- **Risk Modeling**: Uses sentiment data + decision history to simulate public/media/political reactions.
- **Safety Controls**:
  - Allowlist of topics, banned keywords.
  - Trainer approval queue for all AI outputs during exercises.
  - Option to disable AI entirely for sensitive deployments; Supabase auth still manages access.

## 9. Inner Workings by Workflow

### Exercise Setup

1. Trainer selects template → customizing scenario state (objectives, injects).
2. Scenario Service validates timeline, dependencies.
3. Session scheduled; invites generated; RBAC roles assigned.

### Live Simulation

1. Session Manager starts scenario clock; WebSocket pushes state sync.
2. Participants interact via dashboards; actions hit REST endpoints.
3. Actions create events → persisted → broadcast via WebSocket.
4. AI injects queued and approved → state updates cascaded.
5. Resource allocations adjust state via Scenario Service.

### After-Action Review

1. Session closes → Session Manager finalizes event log.
2. Analytics Service processes events → metrics, charts, insights.
3. AI summariser drafts narrative → trainer edits/approves.
4. AAR package generated → stored + optionally exported to LMS.

## 10. Future Enhancements

- Extended reality support (VR/AR) for immersive command centers.
- Interoperability APIs for national training frameworks.
- Machine learning on historical exercises to recommend best practices (with anonymised data).
- Advanced sentiment modeling using localized demographic datasets.
- Automated scenario validation against policy constraints.

---

This document serves as the baseline for engineering, security review, and operations teams to understand how the Unified Simulation Environment is built and how its components interact. Adjustments can be captured in subsequent architecture decision records (ADRs).

## 11. End-to-End User Flows & Data Interactions

### 11.1 Trainer Creates and Schedules a Scenario

1. **UI Action**: Trainer selects “New Scenario” in Scenario Workspace, fills metadata, adds injects.
2. **APIs**
   - `POST /api/scenarios` → Scenario Service validates payload, stores draft.
   - `POST /api/scenarios/{id}/injects` (bulk or individual) → Inject definitions persisted.
   - `POST /api/sessions` → Schedules session with scenario ID, start time, participant roles.
3. **Database Writes**
   - `scenarios` (metadata, objectives, initial state snapshot).
   - `scenario_injects` (timeline triggers, content, affected roles).
   - `sessions`, `session_participants` (scheduling info, invitations).
4. **Events**
   - `scenario.created`, `scenario.injects.updated`, `session.scheduled` emitted to event bus for audit + notifications.
5. **Notifications**
   - Email/WS notification to invited participants via Communications Service.

### 11.2 Participant Joins Live Session

1. **UI Action**: Participant logs in, selects assigned role, enters session lobby.
2. **APIs**
   - `POST /api/auth/login` (or SSO callback) → JWT issued.
   - `GET /api/sessions/{id}` → Session details, current state.
   - `GET /api/cops/{sessionId}` (COP data), `GET /api/decisions?sessionId=...`, `GET /api/channels?sessionId=...`.
3. **Database Reads**
   - `users`, `role_assignments` for RBAC validation.
   - `sessions`, `scenario_states`, `session_events` for initial sync.
   - `incidents`, `resources`, `messages` for relevant dashboards.
4. **WebSocket**
   - Client subscribes to `session:{id}` room; receives future updates.
5. **Audit**
   - `auth.login` and `session.join` events logged with timestamp + role.

### 11.3 Decision Proposal and Approval Chain

1. **UI Action**: Role player drafts a decision (e.g., emergency declaration) and submits.
2. **APIs**
   - `POST /api/decisions` → Decision stored with status `proposed`.
   - `POST /api/decisions/{id}/attachments` (optional).
   - Notifications to approvers via `POST /api/notifications` or WebSocket emit.
   - Approver actions: `POST /api/decisions/{id}/approve` or `/reject`.
3. **Database Operations**
   - `decisions`, `decision_steps`, `decision_attachments` updated per action.
   - Status transitions persisted with timestamps.
4. **Events**
   - `decision.proposed`, `decision.step.pending`, `decision.approved/rejected`, `decision.executed` events for analytics + AAR.
5. **Scenario Impact**
   - Upon execution, Scenario Service updates `scenario_states`; may trigger new injects.

### 11.4 Resource Negotiation

1. **UI Action**: Agency requests additional ambulances from another agency.
2. **APIs**
   - `POST /api/resources/requests` → Creates negotiation record.
   - `POST /api/resources/requests/{id}/counter` → Counteroffer.
   - `POST /api/resources/requests/{id}/accept` → Finalise allocation.
3. **Database Writes**
   - `resource_requests`, `resource_transactions`, `resource_allocations` tables.
   - Inventory adjustments in `agency_resources` and historical log in `resource_history` view.
4. **Scenario Update**
   - Scenario Service recalculates resource availability; COP map updates via WebSocket event `resource.update`.
5. **Analytics**
   - Data fed into `resource_metrics` for efficiency and negotiation time calculations.

### 11.5 AI Inject Lifecycle

1. **Trigger**: Scheduled time hit or conditional trigger satisfied.
2. **Event**: `inject.requested` placed on queue with context (session, state snapshot).
3. **AI Orchestrator**
   - Pulls context from DB (`scenario_injects`, `scenario_states`, recent `session_events`).
   - Generates draft inject → stored in temporary table `pending_injects`.
4. **Trainer Review**
   - UI fetches via `GET /api/injects/pending`; trainer approves with `POST /api/injects/{id}/publish` or edits.
5. **Distribution**
   - Upon publish, event `inject.published` emitted; WebSocket pushes to participants.
   - Persisted into `session_events`, `media_posts` (if public), `incident` updates as needed.

### 11.6 After-Action Review Generation

1. **Session End**: Trainer ends exercise via UI (`POST /api/sessions/{id}/complete`).
2. **Background Job**
   - Analytics service consumes `session.completed` event.
   - Queries `session_events`, `decisions`, `messages`, `resource_transactions`.
3. **AI Summary**
   - AI orchestration produces narrative draft → stored in `aar_drafts` with trace.
4. **Report Assembly**
   - Metrics computation populates `aar_metrics`, `participant_scores`.
   - Final `AARReport` saved; `GET /api/aar/{sessionId}` serves to UI.
5. **Exports**
   - Optional `POST /api/aar/{sessionId}/export?format=pdf` generates file stored in object storage and referenced via signed URL.

---

These flows ensure traceability from user action through API calls, database interactions, event propagation, and analytics, keeping every decision and inject accountable and replayable.
