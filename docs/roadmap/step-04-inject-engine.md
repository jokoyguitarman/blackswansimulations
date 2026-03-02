# Step 4 — Inject engine (scheduler) changes

**Goal:** Replace or bypass time-as-trigger with eligibility time + condition-based firing and cancellation; integrate condition evaluator; optional priority queue and cooldown.

---

## Behaviour (when implementing)

- **Context once per cycle:** Build `EvaluationContext` once per scheduler tick (or 5-minute cycle). Injects published in the same cycle are **not** included in `publishedScenarioInjectIds` until the next cycle. So injects that depend on "inject X fired" will see X only after the cycle that published X has finished. Recommended order: load session + decisions + events + gates/objectives → build context → for each condition-driven inject (not already published), check `eligible_after_minutes` then call `evaluateInjectConditions` → publish those with `appear_met` and not `cancel_met`.
- **Per-session lock:** The time-based inject scheduler uses a per-session lock so the same session is not processed by two overlapping ticks (avoids double publish). When adding condition-driven logic to the same or a shared scheduler, reuse or extend that pattern so only one tick processes a given session at a time.

---

## Scope

- **Same scheduler:** Condition-driven injects run in the same `InjectSchedulerService` tick as time-based injects. Session select includes `current_state` for evaluation context.
- **Context once per tick:** For each session we load gate progress, published/cancelled inject IDs, executed decisions (all), objective progress, then build one `EvaluationContext` (sessionId, scenarioId, elapsedMinutes, currentState, executedDecisions, publishedScenarioInjectIds, objectiveProgress, gateStatusByGateId; pathwayOutcomeKeysFired optional, left empty for now).
- **Time-based unchanged:** Fetch injects with `trigger_time_minutes <= elapsed`, filter by gate and published/cancelled, then (when injectsToPublish.length > 0) run AI cancel for future injects and publish loop. No early return when there are no time-based injects so condition-driven can run.
- **Condition-driven:** Fetch `scenario_injects` with `conditions_to_appear` not null; exclude already published/cancelled; for each inject skip if `elapsedMinutes < eligible_after_minutes`; call `evaluateInjectConditions(conditionsToAppear, conditionsToCancel, context)`; if `appear_met` publish via `publishInjectToSession`. No AI cancel for condition-driven injects in this step.

---

## Files to create or modify

- **server/services/injectSchedulerService.ts** — Session select includes `current_state`. Load published/cancelled events before time-based fetch. Build `EvaluationContext` once per tick (executed decisions, scenario_objective_progress, gateStatusByGateId from session_gate_progress). After time-based publish block, fetch condition-driven injects, evaluate, publish when `appear_met`. Per-session lock unchanged.

---

## Key structures or contracts

- **EvaluationContext** — Built in scheduler from: session (id, scenario_id, current_state), elapsedMinutes, publishedInjectIds (from session_events), executedDecisions (decisions where status = 'executed'), scenario_objective_progress, session_gate_progress (gate_id → status). `pathwayOutcomeKeysFired` and `publishedInjectKeysOrTags` left empty/undefined for now.
- **Condition-driven query** — `scenario_injects` where `scenario_id` = session and `conditions_to_appear` is not null. Filter out ids in publishedInjectIds or cancelledInjectIds.

---

## Acceptance criteria

- [x] Session select includes `current_state`; context is built once per tick with executedDecisions, publishedScenarioInjectIds, objectiveProgress, gateStatusByGateId.
- [x] Condition-driven injects: fetch injects with non-null `conditions_to_appear`, skip already published/cancelled, respect `eligible_after_minutes`, call `evaluateInjectConditions`; publish when result is `appear_met`.
- [x] Time-based path unchanged; no early return when there are no time-based injects so condition-driven runs every tick.
- [x] Same per-session lock used; no new scheduler process.

---

## Depends on

- Step 1 (Database and schema).
- Step 3 (Condition evaluator service).
