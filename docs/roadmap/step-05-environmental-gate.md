# Step 5 — Environmental prerequisite gate

**Goal:** In decision execution flow, add environmental prerequisite check (corridor traffic) and **location-condition gate**: for any decision that references a scenario location (e.g. triage site, evacuation center, route), evaluate that location's conditions; if bad and not managed/cleared, apply degraded outcome or robustness penalty.

---

## Scope

Environmental prerequisite check for evacuation/vehicle deployment (corridor traffic). **Location-condition gate:** When a decision references a pin (e.g. "establish triage at Site A"), check that location's conditions; if the location is bad (low suitability, construction nearby, bad terrain) and the player has not cleared it (e.g. by asking the insider or a prior decision), apply the same penalty as for unmanaged environmental factors.

---

## Files to create or modify

- **server/services/environmentalPrerequisiteService.ts** — New service: `evaluateEnvironmentalPrerequisite(sessionId, decision)` returns `EnvironmentalConsistencyResult | null`. (1) Corridor traffic: if `current_state.environmental_state.routes` has any route with `managed === false` and the decision text is evacuation/vehicle/route-related, return inconsistent (error_type `flow`). (2) Location-condition gate: load `scenario_locations` for the session's scenario; for each location with bad conditions (`suitability === 'low'` or `unsuitable === true`), if decision text references that location (by label or type) and `current_state.location_state[locationId].managed` is not true, return inconsistent (error_type `location`). Same result shape as Checkpoint 2 so existing penalty flow applies.
- **server/routes/decisions.ts** (execute flow): After `evaluateDecisionAgainstEnvironment`, call `evaluateEnvironmentalPrerequisite`; if it returns a non-null result with `consistent === false`, use it as the stored `environmental_consistency` (overriding AI result) so mismatch inject, robustness cap, and objective skip/penalty run as today.

---

## Key structures or contracts

- **evaluateEnvironmentalPrerequisite(sessionId, decision)** → `EnvironmentalConsistencyResult | null`. Uses `sessions.current_state.environmental_state.routes` (Step 2) and `scenario_locations.conditions` (Step 1). Location "bad" when `conditions.suitability === 'low'` or `conditions.unsuitable === true`; "managed" from `current_state.location_state[locationId].managed === true`.
- **Integration:** Prerequisite result takes precedence over AI environmental consistency when prerequisite fails; same `environmental_consistency` column and same downstream handling (createAndPublishEnvironmentalMismatchInject, skipPositiveForObjectiveIds, addObjectivePenalty, robustness cap in AI inject scheduler).

---

## Acceptance criteria

- [x] Corridor traffic: if session has unmanaged route(s) in `environmental_state.routes` and the decision is evacuation/vehicle/route-related, prerequisite returns inconsistent with error_type `flow` and reason describing unmanaged routes.
- [x] Location-condition gate: if decision references a scenario location (by label or type) that has bad conditions and that location is not managed in `location_state`, prerequisite returns inconsistent with error_type `location`.
- [x] Execute flow calls prerequisite after AI environmental check; when prerequisite fails, stored `environmental_consistency` and all existing penalties (inject, robustness cap, objective skip/penalty) apply.
- [x] No new columns; reuses `decisions.environmental_consistency` and existing mismatch inject/penalty logic.

---

## Depends on

- Step 1 (Database and schema).
- Step 2 (Environmental state service).
