# Unified Simulation Environment – Build Phases

## Phase 0: Discovery & Alignment

- **Objectives**
  - Capture detailed training goals, compliance boundaries, inter-agency workflows.
  - Identify external systems (SSO, LMS, secure networks) to integrate later.
- **Functional Requirements**
  - Persona catalogue with role mandates, permissions, approval chains.
  - Baseline scenario library outline (categories, desired outcomes, red lines).
- **Technical Tasks**
  - Draft preliminary domain model (users, scenarios, sessions, resources) in Miro/Lucid.
  - Security assessment checklist; document data classification and retention policy.
  - Produce initial risk register in Notion/Jira (AI misuse, data leakage, availability).
- **Deliverables**: Discovery report, requirements backlog, initial risk and compliance matrix.

## Phase 1: Architecture & Foundation

- **Objectives**
  - Lock in stack (React/TypeScript, Node.js, Supabase, Socket.io, OpenAI) and coding standards.
  - Create cohesive architecture docs and repo scaffolding.
- **Functional Requirements**
  - None user-facing; set up health check endpoint, Supabase connection tests.
- **Technical Tasks**
  - Provision Supabase project: enable Auth, configure RLS, create base schemas via SQL migrations.
  - Author ADRs covering key decisions (Supabase vs self-hosted Postgres, AI provider).
  - Scaffold mono-repo or multi-repo structure, set lint/test scripts, Husky hooks.
  - Configure CI pipeline to run lint, type-check, unit tests on PR.
  - Establish environment management pattern (.env templates, secrets handling).
- **Deliverables**: Architecture diagrams, API skeleton with health check, Supabase schema v1, CI pipeline green.

## Phase 2: Core Platform MVP

- **Objectives**
  - Deliver end-to-end experience for session creation and live collaboration basics.
- **Functional Requirements**
  - Supabase-authenticated login with role selection; trainer dashboard shell.
  - Scenario authoring CRUD (title, objectives, inject timeline, participant roster).
  - COP dashboard foundation: base map, incident list, timeline feed, resource summary.
  - Real-time chat channels (role-based) and notifications for key events.
- **Technical Tasks**
  - Implement Supabase client in frontend; backend verifies Supabase JWT using service role.
  - Create REST endpoints: `/scenarios`, `/sessions`, `/incidents`, `/channels`, `/messages`.
  - Wire Socket.io gateway broadcasting changes (scenario updates, chat messages, incidents).
  - Define event log tables in Supabase (`session_events`, `notifications`).
  - Set up initial audit logging (who created scenario, who joined session) using Supabase functions or backend service.
- **Deliverables**: Working trainer workflow from login → create scenario → start session; participants can join, view COP, send chat messages; baseline audit logs available.

## Phase 3: Decision & Workflow Engine

- **Objectives**
  - Enable structured decision-making with approvals and resource allocation mechanics.
- **Functional Requirements**
  - Decision proposal UI and API with customizable approval chains.
  - Digital signature capture for approvals/rejections, including comment trail.
  - Resource marketplace: request, counter, approve flows; inventory updates reflected in COP.
- **Technical Tasks**
  - Expand Supabase schema: `decisions`, `decision_steps`, `decision_signatures`, `resource_requests`, `resource_transactions`.
  - Implement RLS policies ensuring users only see/me decisions relevant to their role/agencies.
  - Backend services to propagate decision status changes over WebSocket and update scenario state.
  - Integrate resource changes into COP map overlays (e.g., heatmaps) using real-time updates.
  - Automated tests covering approval workflows and resource negotiation edge cases.
- **Deliverables**: Decisions can be proposed, routed, approved/rejected, executed; resource negotiations persist and impact scenario state; audit trail captures full decision process.

## Phase 4: AI Injects & Media Simulation

- **Objectives**
  - Introduce AI-assisted scenario evolution and public information dynamics.
- **Functional Requirements**
  - AI-generated inject suggestions with trainer review queue (approve/edit/publish).
  - Media simulation panel with mock social feeds, news ticker, citizen reports; sentiment analytics.
  - Public statement drafting workflow with preview of sentiment impact.
- **Technical Tasks**
  - Implement AI Orchestrator service calling OpenAI (ChatGPT) with scenario context + guardrails.
  - Store pending injects in Supabase (`pending_injects`); ensure PII-safe prompts and outputs.
  - Create Supabase functions/webhooks to log all AI prompts/responses for audit.
  - Build media data model (`media_posts`, `sentiment_snapshots`, `misinformation_events`).
  - Real-time updates to COP and media feeds when injects publish; integrate sentiment visualization (Recharts/D3).
- **Deliverables**: Trainers see AI suggestions, can publish injects; participants receive media updates and observe sentiment shifts; guardrails enforce fictional constraints.

## Phase 5: Analytics & After-Action Review

- **Objectives**
  - Deliver comprehensive post-exercise insights and replay capabilities.
- **Functional Requirements**
  - Timeline replay with play/pause, jump-to-event, annotation features.
  - KPI dashboards: decision latency, comms efficiency, legal compliance, sentiment trajectory, coordination scores.
  - AI-assisted AAR narrative with trainer approval and export options (PDF/Excel/LMS).
- **Technical Tasks**
  - Implement event sourcing pipeline: append-only log + materialized views for quick queries.
  - Build analytics calculations using Supabase SQL functions or backend aggregation service.
  - Integrate AI summariser with templated prompts and manual edit workflow; store outputs in `aar_reports`.
  - Generate PDFs via headless rendering (e.g., Puppeteer) and upload to Supabase storage buckets.
  - E2E tests for replay navigation, metrics accuracy, export integrity.
- **Deliverables**: Completed sessions produce structured AAR packages; trainers can replay events and export reports; analytics are accurate and auditable.

## Phase 6: Hardening & Deployment

- **Objectives**
  - Ensure scalability, resilience, security, and deployment readiness across environments.
- **Functional Requirements**
  - Support multi-session concurrency without degradation.
  - Provide deployment playbooks for SaaS, on-prem, offline companion sync.
- **Technical Tasks**
  - Load testing with k6/Artillery simulating 100+ concurrent users; tune WebSocket scaling (horizontal pods, sticky sessions).
  - Security reviews: verify Supabase RLS, audit logs, MFA enforcement; run penetration testing and fix findings.
  - Implement IaC (Terraform/Ansible) for infrastructure provisioning; configure Supabase backups.
  - Observability stack: Prometheus metrics, Grafana dashboards, alerting rules, log aggregation (Loki/ELK).
  - Document incident response process, backup/restore drills.
- **Deliverables**: Performance benchmarks met, security sign-off achieved, deployment scripts validated, monitoring live.

## Phase 7: Pilot & Feedback Loop

- **Objectives**
  - Validate solution with real users, refine based on actionable feedback.
- **Functional Requirements**
  - Pilot cohorts complete end-to-end exercises; feedback collection built into app (surveys, session rating).
  - Trainer onboarding materials and tutorials accessible from dashboard.
- **Technical Tasks**
  - Instrument product analytics (PostHog/Amplitude) to capture usage stats.
  - Set up feedback pipeline (in-app forms, CSM notes) syncing to issue tracker.
  - Iterate on UX pain points, AI tuning, content packs; track changes via release notes.
  - Localisation groundwork if required by pilot agencies.
- **Deliverables**: Pilot reports summarising outcomes, prioritised backlog of enhancements, refined documentation and training materials.

## Phase 8: General Availability & Continuous Improvement

- **Objectives**
  - Launch broadly with support/operations framework and ongoing feature roadmap.
- **Functional Requirements**
  - SLAs defined, support tiers established, escalation runbooks in place.
  - Regular content updates (scenario packs, AI prompt tuning), compliance renewals.
- **Technical Tasks**
  - Production readiness review (capacity planning, DR tests, cost monitoring).
  - Implement feature flag system for gradual rollouts; schedule recurring security/AI audits.
  - Set cadence for model evaluations, data retention enforcement, ADR updates.
  - Plan and execute roadmap items (mobile companion, voice/video, advanced analytics) via agile cycles.
- **Deliverables**: GA announcement, support structure live, continuous delivery pipeline operating, roadmap execution metrics tracked.
