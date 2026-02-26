# Gated Progression & Task-Based Scenario Design (Conversation Summary)

Recorded from design discussion for future reference.

---

## 1. Design Goals

- **C2E bombing scenario:** Evacuation should feel urgent (e.g. world standard: clear ~1,000 people in ~2 minutes). Players should not know full situation from the brief.
- **Situational awareness:** Players discover details (exits, ground zero, blocked routes) via **injects** and **cross-team comms**, not from the brief.
- **Expectation:** Players reference these specifics in decisions and chat (exits, bomb location, time pressure).
- **Task-based gameplay:** Each team has a **deliverable** that forces them to gather info:
  - **Evac:** Submit an evacuation plan (exits, ground zero, flow) → must get details from injects + other teams.
  - **Triage:** Submit triage situation report (casualty zones, routes) → same pattern.
  - **Media:** Issue first public statement based on verified facts → coordinate with Evac/Triage.
- **Brief = minimal;** storyline and "reality" = **injects**; **tasks** = reason to care and to communicate.

---

## 2. Gated Progression (Backend Gates)

- **Gates:** Backend conditions that must be met before the next part of the main storyline (time-based + AI injects) proceeds.
- **Example:** Gate "Evac situation report" — before Phase 1 injects run, Evac must have submitted a decision that counts as a situation report (e.g. type `emergency_declaration`, content mentions exit/ground zero/situation).
- **If gate met:** Allow Phase 1 injects; optionally fire a short "Plan received" inject.
- **If gate not met (at check time):** Fire **punishment** injects (confusion, disapproval, "Who's in charge?"), then still proceed to Phase 1 in a worse state (or delay until they submit).
- **Flow:** Phase 0 → Gate 1 check → (met → Phase 1 | not met → punishment then Phase 1) → Gate 2 → … .

### Sample Gate (conceptual)

- **Gate ID:** `evac_situation_report`
- **Required before:** Phase 1 (main storyline injects).
- **Condition:** Evacuation team has submitted a decision of type `emergency_declaration` (or `operational_plan`) with body containing at least one of: exit, ground zero, situation, evacuation plan.
- **Check at:** T+8 (or when Phase 1 would start).
- **If met:** Optional inject "Evacuation plan received."
- **If not met:** Fire punishment injects (e.g. "Coordination failure – no situation report").

### Diagram (ASCII)

```
Phase 0 (T+0, T+5) → Gate 1 (check at T+8) → Met? → Yes → Phase 1 (T+10, T+12, … + AI)
                                    → No  → Fire punishment injects → then Phase 1
```

---

## 3. Implementation Scope

### New migrations (one migration)

- **`scenario_gates`:** id (UUID), scenario_id, gate_id (text), gate_order, check_at_minutes, condition (JSONB: team, decision_types[], content_hints[]), if_not_met_inject_ids (UUID[]), if_met_inject_id (UUID nullable).
- **`session_gate_progress`:** session_id, gate_id, status (pending | met | not_met), met_at, satisfying_decision_id. PK (session_id, gate_id).
- **`scenario_injects`:** add `required_gate_id` (UUID nullable, FK to scenario_gates.id). Injects with this set only publish when that gate is met.

### Codebase changes

- **New:** Gate evaluation service (evaluate condition from decisions + session_teams, update session_gate_progress, fire punishment/success injects).
- **Modify:** Inject scheduler — before selecting injects, run gate evaluation for session; when selecting injects, filter by `(required_gate_id IS NULL OR gate met)`.
- **Modify:** Session start — insert session_gate_progress rows (pending) for all scenario gates.
- **Optional:** On decision execute — re-check pending gates so gate can flip to met without waiting for scheduler.
- **Optional:** GET session gates (trainer), small trainer UI for gate status.

### What does NOT become obsolete

- Decision-based injects (trigger_condition, injectTriggerService) — still for "when they do X, fire consequence Y."
- Objective tracking (scenario_objectives, progress, AAR) — still for scoring.
- AI inject cancellation, pathway outcomes, inject CRUD, events, decisions — unchanged in role.

### What becomes redundant or needs update

- **Partially redundant:** `trackDecisionImpactOnObjectives` evacuation block (evacuation_plan_executed) — can derive from gate status instead; optionally remove/relax that block.
- **Incomplete until updated:** "Upcoming injects" logic (scheduler, trigger service, AI context) — should filter or annotate by gate; scenario clone script — clone gates and remap required_gate_id; inject create/edit — add required_gate_id; session start — initialize session_gate_progress.

---

## 4. References in Codebase

- Inject scheduler: `server/services/injectSchedulerService.ts` (processSession, time-based publish).
- Session start: `server/routes/sessions.ts` (status → in_progress).
- Decision execution: `server/routes/decisions.ts` (execute path, trackDecisionImpactOnObjectives).
- Objective tracking: `server/services/objectiveTrackingService.ts`, `scenario_objectives` / `scenario_objective_progress`.
- Decision-based injects: `server/services/injectTriggerService.ts`, `trigger_condition` on scenario_injects.
- Team membership: `session_teams` (session_id, user_id, team_name).

---

## 5. Next Steps (when returning)

1. Create migration for scenario_gates, session_gate_progress, and scenario_injects.required_gate_id.
2. Implement gate evaluation service and plug into inject scheduler and session start.
3. Optionally hook gate re-check on decision execute.
4. Update upcoming-injects logic and clone script for gates; add required_gate_id to inject form/API.
5. Seed C2E (or new scenario) with gates and required_gate_id on Phase 1+ injects; minimal brief + task wording in objectives/briefing.
