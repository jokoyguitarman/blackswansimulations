# Unified Simulation Environment (USE) – Product Requirements Document

## 1. Product Overview

- **Purpose**: Provide a secure, AI-assisted training platform where government, defence, emergency services, utilities, media, and civilian leadership rehearse crisis coordination.
- **Scope**: Fictional, non-operational scenarios only. Focus on information flow, leadership, legal compliance, and inter-agency decision-making.
- **Vision Statement**: “Every agency can rehearse chaos — safely.”

## 2. Objectives & Success Metrics

- **Primary Objectives**
  - Deliver end-to-end crisis simulation exercises with adaptive AI-driven events.
  - Enable trainers to author, run, and analyse multi-agency scenarios.
  - Provide quantifiable coordination metrics and after-action reviews (AARs).
- **Success Metrics**
  - Trainer satisfaction ≥ 85% (post-exercise survey).
  - 90%+ exercises produce complete audit trails (decisions, approvals, comms).
  - Average decision latency reduced by ≥ 20% between first and third sessions for recurring teams.
  - Zero critical security incidents during pilot deployments.

## 3. Target Users & Personas

- **Lead Trainer** (primary admin)
  - Goals: Design scenarios, monitor exercises, generate reports.
  - Needs: Authoring tools, real-time oversight, control over AI injects.
- **Agency Role Players**
  - Roles: Defence liaison, police commander, public information officer, health director, civil government, utility manager, intelligence analyst, NGO liaison.
  - Goals: Make decisions within role authority, coordinate with peers, respond to injects.
- **Legal/Ethics Oversight**
  - Goals: Review/approve sensitive decisions, ensure compliance.
  - Needs: Approval queues, audit trails, ability to comment or halt.
- **Executive Observer**
  - Goals: Monitor overall exercise outcomes, review metrics.
  - Needs: Read-only dashboards, AAR summaries.

## 4. Key Use Cases

1. Trainer creates a new scenario with timeline injects and assigns participant roles.
2. Agencies log in, review briefings, and join real-time simulation.
3. AI inject engine introduces media reports, infrastructure failures, misinformation waves.
4. Role-specific dashboards drive decisions; approvals route through chain-of-command.
5. Public Information Officer publishes a statement; sentiment graph updates instantly.
6. Utilities negotiate resource allocations via marketplace; decisions logged.
7. After action, trainer replays timeline, analyses metrics, exports certification report.

## 5. Feature Requirements

### 5.1 Scenario Engine

- Scenario library with templates (cyber, infrastructure, unrest, health, custom).
- Timeline editor with inject triggers (time-based, conditional, trainer-triggered).
- AI-driven event variations with manual override/pause.
- Scenario state variables: public sentiment, political pressure, resource status, weather etc.

### 5.2 Multi-Agency Role System

- Identity and authentication powered by Supabase Auth (email magic link, SSO, or passwordless options) with custom claims for agency/role metadata.
- Role-based access control (RBAC) with configurable permissions per agency.
- Role dashboards tailored to responsibilities (e.g., logistics view vs. public comms).
- Chain-of-command hierarchy and escalation rules.

### 5.3 Common Operating Picture (COP)

- Interactive map (Leaflet or equivalent) with incidents, resources, sentiment overlays.
- Timeline feed: injects, decisions, communications.
- Pinning, tagging, task assignments.
- AI alerts highlighting data gaps (“Health team missing casualty update since 10:45”).

### 5.4 Decision Workflow

- Decision creation with templates and required data fields.
- Configurable approval chains with digital sign-off (timestamped, comments).
- Audit trail: status changes, approvers, rationale, legal compliance indicators.

### 5.5 AI Event Injector

- AI/Rule hybrid system to generate fictional updates (media, weather, misinformation).
- Trainer dashboard to view queue, override, delay, or cancel injects.
- Guardrails ensuring fictional, non-harmful content; logging for governance review.

### 5.6 Media & Public Sentiment Simulation

- Mock social media feed, news ticker, citizen reports.
- Sentiment analytics with trend graphs.
- Misinformation modelling (spread rate, counter-messaging impact).
- Public statement drafting, approval, and impact feedback loop.

### 5.7 Resource Marketplace

- Agency-specific resource inventories (personnel, equipment, budget credits).
- Negotiation interface for resource requests, offers, counteroffers.
- Visualisation of trade-offs and projected impact on scenario state.

### 5.8 Collaboration Tools

- Secure chat channels: private, inter-agency, command, trainer.
- SITREP/briefing templates with drag-and-drop entry fields.
- Optionally integrate voice/video (Phase 2 roadmap; placeholder in MVP).

### 5.9 After-Action Review (AAR)

- Automatic capture of decisions, communications, inject responses.
- Timeline replay with pause, annotate, discuss features.
- Analytics: decision latency, communication delays, compliance rate, sentiment trajectory, missed coordination opportunities.
- Export to PDF/Excel, LMS integration hooks.

### 5.10 Deployment & Modes

- SaaS (cloud), on-prem, and offline-sync companion options.
- Configuration settings for data retention, anonymisation, encryption.
- Admin controls for multi-tenant (training centres) and isolated installs (defence).

## 6. Non-Functional Requirements

- **Security & Compliance**: Supabase-managed sign-ins with MFA/SSO, TLS, encryption at rest, detailed audit logs, permission audits, content moderation workflows.
- **Performance**: Support 100 concurrent users per scenario; <200ms latency for critical updates.
- **Reliability**: HA architecture with failover; offline sync for mobile companion.
- **Usability**: Accessible UI (WCAG 2.1 AA), responsive design, consistent component library.
- **Scalability**: Modular services; support multiple simultaneous exercises.
- **Maintainability**: CI/CD pipelines, automated tests (unit, integration, e2e), infrastructure-as-code.

## 7. Technical Architecture (High-Level)

- **Frontend**: React + TypeScript SPA (Vite build), Zustand or Redux for state, WebSocket for real-time, Tailwind UI.
- **Authentication**: Supabase Auth for user sign-in/session management; RBAC enforced via custom claims and backend policy checks.
- **Backend**: Node.js/Express with REST + WebSocket APIs, role-based auth middleware.
- **Data Layer**: Supabase Postgres (primary), Supabase Edge Functions/Row Level Security for fine-grained control, optional Redis (pub/sub, caching), object storage for documents.
- **AI Services**: Pluggable AI adapters (OpenAI, Anthropic) behind governance service; ability to switch off for air-gapped deployments.
- **Infrastructure**: Containerised services (Docker/Kubernetes), observability (Prometheus/Grafana), feature flags, secrets management.

## 8. AI Governance & Safety

- Fictional content guidelines enforced by scenario authoring review.
- AI outputs tagged, logged, and reviewable; trainer can accept/modify/reject.
- Sensitive decisions require explicit human approval before execution.
- Ethics/legal oversight roles with veto capability.
- Data retention policies for AI-generated content; explainability logs.

## 9. UX & Interaction Flow (MVP)

1. Trainer logs in → selects scenario template → configures injects → schedules session.
2. Participants receive invites → choose roles → view briefing pack.
3. Simulation begins: COP updates, inject feed, decisions created and routed.
4. Communications occur via role-based channels; marketplace handles resources.
5. Decisions executed → AI adjusts scenario → sentiment + metrics update.
6. Trainer monitors dashboards, can pause/adjust inject cadence.
7. Session ends → automatic AAR report generated → team reviews replay.

## 10. Dependencies & Integrations

- External identity providers (government SSO).
- GIS/map data provider (OpenStreetMap baseline, optional premium layers).
- Video conferencing integration (Phase 2): MS Teams, Zoom, or WebRTC.
- LMS or training record systems (data export + API integration).

## 11. Risks & Mitigations

- **Security compliance complexity**: Engage with infosec early; modularise deployments.
- **AI trust**: Provide transparency, override controls, human-in-loop.
- **On-prem installation**: Deliver scripted deployments, support offline updates.
- **User adoption**: Provide guided onboarding, tutorial scenarios, documentation.

## 12. Release Plan

- **Alpha (Internal)**: Core scenario engine, COP map, chat, decision logging, manual injects.
- **Beta (Pilot Agencies)**: AI injects (guarded), resource marketplace, sentiment analytics, AAR replay.
- **GA**: On-prem/offline support, governance dashboards, LMS integration, additional role templates.

## 13. Open Questions

- Define precise legal and compliance requirements per jurisdiction.
- Determine depth of media simulation (volume, authenticity) acceptable to stakeholders.
- Clarify requirements for mobile/offline companion (degree of functionality).
- Decide on standard scenario library vs. custom creation as professional services.
