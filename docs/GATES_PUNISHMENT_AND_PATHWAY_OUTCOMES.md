# Gates, Punishment, and Pathway Outcomes – Conversation Summary

Reference document for later. Covers: where punishment scenarios are defined, whether they trigger escalation/de-escalation pathways, and how to avoid contradictory injects when the player is on the punish side of a gate.

---

## 1. Where Are Punishment Scenarios Decided?

- **Punishment = predefined scenario injects** pointed to by the gate, not generated at runtime.
- In **`scenario_gates`** you store:
  - **`if_not_met_inject_ids`** – array of UUIDs (FKs to `scenario_injects`)
  - **`if_met_inject_id`** – optional single UUID for a “success” inject
- Those UUIDs reference rows in **`scenario_injects`** for that scenario (same table as time-based and decision-based injects). Each has `title`, `content`, `severity`, `inject_scope`, `target_teams`, etc.
- **Level:** **Scenario level (authoring time).** When the scenario is created/edited (seed script or future editor), you:
  1. Insert punishment (and success) injects into `scenario_injects` (often with `trigger_time_minutes` = NULL so the scheduler never fires them by time).
  2. Insert the gate row with `if_not_met_inject_ids` = `[uuid1, uuid2, ...]` pointing to those injects.
- At runtime the engine only decides “gate not met” and then **publishes** those pre-authored injects via the same `publishInjectToSession` path. So we effectively **hard-code the punishment scenarios at scenario level** (in the scenario’s data), not in application code and not by AI at runtime.

---

## 2. Do Punishment Injects Trigger Escalation/De-escalation Pathways?

**Yes.** Any inject published through **`publishInjectToSession`** triggers the pathway outcomes flow.

- In [server/routes/injects.ts](server/routes/injects.ts), after creating the session event and broadcasting, the code calls **`runPathwayOutcomesOnInjectPublished(sessionId, injectId)`** (fire-and-forget). There is no filter by inject source.
- So when gate punishment uses the same `publishInjectToSession` entry point (publishing the injects whose IDs are in `if_not_met_inject_ids`):
  1. The inject is published as a session event and broadcast; if the inject has **`requires_response: true`**, an **incident** is also created (so it can show in the frontend incidents list).
  2. **Pathway outcomes run:** [pathwayOutcomesService.ts](server/services/pathwayOutcomesService.ts) uses the just-published inject to identify escalation/de-escalation factors and generate pathway outcome injects for the next 5-minute cycle.

So the “bad side of the gate” inject does trigger the escalation and de-escalation pathways/factors. The game moving forward through the punish branch and publishing the punishment inject feeds into that system.

---

## 3. How Do We Ensure Scheduled Main-Event Injects Don’t Publish While on the Punish Side?

**Use `required_gate_id` on every main-event inject that would contradict the punish state.**

- **Scheduler rule:** Publish a time-based inject only if (1) its time is due, and (2) either it has **no** `required_gate_id`, or its `required_gate_id` is **met** for this session.
- So when the player is on the **punish side** (gate not met):
  - Any inject with `required_gate_id` = that gate **does not publish**, regardless of elapsed time.
  - Main-event / “good branch” injects (e.g. “Plan received”, “Proceed to phase 2”) that would contradict the punish state should have `required_gate_id` set, so they never run on the punish branch.
- **Scenario authoring responsibility:** When building the scenario, attach `required_gate_id` to every Phase 1 (and later) inject that assumes the gate was met. Leave it unset for injects that are neutral or make sense in both branches (e.g. some generic “Exit congestion” injects).

**Overlap / same-tick:**

- If a time-based inject has **no** `required_gate_id`, it can still publish at its time even when the gate is not met. To avoid redundant or contradictory content, either:
  - Don’t put a time-based inject at the exact gate-check time (e.g. no T+8 inject in Phase 0), or
  - Give that inject a `required_gate_id` if it assumes the gate was met.

**Optional future:** A field like `only_if_gate_not_met_id` could support “bad branch only” injects (publish only when gate is not met), for distinct storylines per branch. Current design only has `required_gate_id` (publish only when met).

---

## 4. Reference in Codebase

- Inject publish path: [server/routes/injects.ts](server/routes/injects.ts) – `publishInjectToSession`, incident creation when `requires_response`, `runPathwayOutcomesOnInjectPublished`.
- Pathway outcomes: [server/services/pathwayOutcomesService.ts](server/services/pathwayOutcomesService.ts).
- Gate design and `required_gate_id` filtering: see [docs/GATED_PROGRESSION_AND_TASKS_DESIGN.md](docs/GATED_PROGRESSION_AND_TASKS_DESIGN.md) and the implementation plan (gates + inject scheduler filter).

---

## 5. Short Checklist for Scenario Authors

- [ ] Punishment (and success) injects are created as rows in `scenario_injects` and referenced by `scenario_gates.if_not_met_inject_ids` / `if_met_inject_id`.
- [ ] Any main-event inject that would contradict the “punish” branch has `required_gate_id` set to the appropriate gate.
- [ ] Set `requires_response` on punishment injects if they should appear as incidents in the frontend.
- [ ] Avoid time-based injects at the exact gate-check minute if they could overlap or contradict the punishment message, or give them `required_gate_id` if they assume the gate was met.

---

## 6. C2E Bombing Scenario Authoring Checklist

When authoring or updating the C2E Bombing scenario (or a similar gated scenario):

- [ ] **Punishment and success injects** – Create one punishment inject and one success inject per gate (e.g. "Coordination failure – no evacuation situation report received", "Evacuation plan received"). Insert them with `trigger_time_minutes` = NULL so the scheduler never fires them by time. Reference them in `scenario_gates.if_not_met_inject_ids` and `if_met_inject_id`.
- [ ] **Vague-decision injects** – Create one vague inject per gate (e.g. "Evacuation plan too vague – specify exits and ground zero"). Reference in `scenario_gates.if_vague_decision_inject_id`. Set `scenario_gates.objective_id` so anti-gaming can skip positive objective progress when a vague decision is executed for a not_met gate.
- [ ] **Phase 1+ and `required_gate_id`** – Set `required_gate_id` on every time-based inject at T+10 and later that assumes the evac (or triage/media) deliverable was met. Leave T+0, T+5, T+6, T+9 without `required_gate_id` (Phase 0).
- [ ] **Media gate** – For injects that assume the media team has issued a first statement (e.g. "Press Demand for Confirmation"), set `required_gate_id` to the media gate.
- [ ] **`requires_response`** – Set on punishment injects if they should create incidents and appear in the frontend incidents list.
- [ ] **Minimal brief** – Keep general briefing short; state deliverables in role-specific briefs (evacuation plan, triage report, first public statement) so players discover details via injects and cross-team communication.
