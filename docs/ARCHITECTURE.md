# Unified Simulation Environment – Architecture Overview

## 1. System Context

- **Clients**: Web application (React/TypeScript) and future mobile companion.
- **Backend Services**: Node.js/Express API, WebSocket gateway, background workers.
- **Platform Services**: Supabase (Postgres, Auth, Storage, Realtime) and OpenAI (ChatGPT APIs).
- **Infrastructure**: Containerised services (Docker/Kubernetes), Observability stack, CI/CD pipeline.

```
[ Users ]
   ↓
[ React Frontend ] ⇄ [ Supabase Auth ]
   ↓ REST/WebSocket
[ Node API / WebSocket Gateway ]
   ↓                        ↘
[ Supabase Postgres | Storage ]   [ OpenAI (AI Orchestrator) ]
   ↓
[ Analytics / AAR Services ]
```

## 2. Component Breakdown

### 2.1 Frontend (React + Vite)

- Uses Supabase client SDK for auth and basic data access.
- Maintains WebSocket connection (Socket.io) for real-time events.
- Modules aligned with functional areas: Scenario Authoring, COP Dashboard, Decision Console, Communications, Media Simulation, AAR Studio.

### 2.2 Backend Services

1. **API Gateway (Express)**
   - REST endpoints for scenarios, sessions, decisions, resources, communications, analytics.
   - Validates Supabase-issued JWTs, enforces RBAC with role metadata claims.
2. **WebSocket Gateway (Socket.io)**
   - Broadcasts session updates, injects, chat messages, resource changes.
   - Subscribes to Supabase realtime channels and internal event bus.
3. **Worker Services**
   - AI orchestrator that composes prompts, calls OpenAI, enforces guardrails.
   - Report generator for AAR exports, scheduled tasks (reminders, follow-ups).

### 2.3 Data Layer (Supabase)

- Postgres hosts core tables (users metadata, scenarios, sessions, events, decisions, resources, communications, analytics snapshots).
- Row Level Security (RLS) ensures agency/role-bound visibility.
- Supabase storage buckets store documents, attachments, exported reports.
- Supabase triggers/functions help create audit logs and support event sourcing.

### 2.4 AI & External Integrations

- **OpenAI (ChatGPT)** for inject generation, coaching, AAR summarisation.
- **Identity Providers** via Supabase Auth SSO integrations.
- **Future integrations**: Video conferencing, LMS exports, mapping providers (Mapbox/Leaflet tiles).

## 3. Data Flow (Example)

1. Trainer creates scenario → React posts to `/api/scenarios` → API writes to Supabase → event recorded.
2. Session starts → API pushes state to WebSocket → connected clients update COP.
3. AI inject triggered → Worker fetches state → calls OpenAI → stores draft inject → trainer approves → WebSocket broadcast.
4. After session, analytics service aggregates events → writes AAR report → stored in Supabase storage → frontend fetches for replay/export.

## 4. Deployment Topologies

- **SaaS**: Managed Supabase, containerised backend on cloud Kubernetes, CDN-served frontend.
- **On-Prem**: Self-hosted Supabase stack, Docker compose/Kubernetes for backend, offline AI option.
- **Air-Gapped**: Supabase self-hosted with alternative auth if needed, cached AI models (optional), manual update procedure.

## 5. Cross-Cutting Concerns

- **Security**: Zero trust, RLS policies, MFA/SSO, audit logging, encryption at rest/in transit.
- **Observability**: Structured logging, metrics (Prometheus), tracing (OpenTelemetry), alerting.
- **Scalability**: Horizontal scaling of API/WebSocket pods, Supabase connection pooling, event bus decoupling.
- **Resilience**: Retry policies, circuit breakers for AI calls, fallback inject workflows.
- **Compliance**: Policy enforcement via approval workflows, content moderation, data retention schedules.

This document will evolve via ADRs as specific design decisions are finalised during subsequent phases.
