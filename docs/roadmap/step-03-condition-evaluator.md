# Step 3 — Condition evaluator service

**Goal:** New service to evaluate `conditions_to_appear` and `conditions_to_cancel` against current game state; used by the inject engine (Step 4) every 5-minute cycle. Returns whether an inject is eligible to fire (`appear_met`), should be cancelled (`cancel_met`), or is not yet eligible (`not_eligible`). Does not decide "fire once" — the engine tracks which injects have already been published this session.

---

## Scope

- Implement a single entry point: given one inject's condition manifests and an evaluation context (session state snapshot), return one of `appear_met` | `cancel_met` | `not_eligible`.
- **Cancel first:** If any condition in `conditions_to_cancel` is true, return `cancel_met` immediately.
- **Appear:** Support N-of-M (`threshold` + `conditions` array) and "all required" (`all` array). Each condition is a string key resolved via a **condition registry** (decision made/not made, prior inject fired, objective progress, env state threshold, pathway outcome fired).
- **Context** is built once per cycle by the inject engine and passed in (so the evaluator does not fetch DB per inject).
- Null or empty `conditions_to_appear` → return `not_eligible` (engine only calls evaluator for injects that have a non-empty appear manifest).

---

## Files to create or modify

- **server/services/conditionEvaluatorService.ts** (or `conditionCompositeEvaluator.ts`) — `evaluateInjectConditions(conditionsToAppear, conditionsToCancel, context)` and `evaluateConditionKey(key, context)` with a registry of condition kinds.
- **server/services/aiInjectSchedulerService.ts** (Step 4) — Build context once per cycle; for each condition-driven inject, check eligibility time then call evaluator; skip if already fired this session.

---

## Key structures or contracts

### Condition manifest shapes (from DB)

- **conditions_to_appear** (JSONB), one of:
  - `{ "threshold": number, "conditions": string[] }` — N-of-M: at least `threshold` of the keys must evaluate true. If `threshold` is 0 it is treated as 1.
  - `{ "all": string[] }` — Every key must be true.
- **conditions_to_cancel** (JSONB): `string[]` — If **any** key is true, return `cancel_met`.

### Evaluation context (built by inject engine, passed in)

The evaluator receives a snapshot so it does not hit the DB per inject. Suggested shape:

| Field                        | Type                                                                            | Purpose                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                  | string                                                                          | For logging / future use                                                                                                      |
| `scenarioId`                 | string                                                                          | For scenario-specific lookups if needed                                                                                       |
| `elapsedMinutes`             | number                                                                          | Already used by engine for eligibility; optional in evaluator                                                                 |
| `currentState`               | `Record<string, unknown>`                                                       | `session.current_state` (includes `environmental_state`, `location_state`, etc.)                                              |
| `executedDecisions`          | `Array<{ id: string; decision_type?: string; tags?: string[] }>`                | Decisions executed this session (for "decision made/not made")                                                                |
| `publishedScenarioInjectIds` | `string[]`                                                                      | Scenario inject ids that have been published this session (for "prior inject X fired")                                        |
| `publishedInjectKeysOrTags`  | `string[]`                                                                      | Optional: semantic keys/tags of published injects (e.g. `social_media_rumour`) if you identify by key                         |
| `pathwayOutcomeKeysFired`    | `string[]`                                                                      | Consequence keys (e.g. `exit_b_congestion`) for pathway outcomes published this session — for no double-hit cancel conditions |
| `objectiveProgress`          | `Array<{ objective_id: string; status: string; progress_percentage?: number }>` | For "objective X not completed" etc.                                                                                          |
| `gateStatusByGateId`         | `Record<string, 'pending'\|'met'\|'not_met'>`                                   | Optional: only if perfect-storm conditions will reference gate status                                                         |

### Result

```ts
type EvaluatorResult =
  | { status: 'appear_met' } // eligible to fire (engine still applies cooldown/priority)
  | { status: 'cancel_met' } // do not fire / treat as cancelled
  | { status: 'not_eligible' }; // appear not met
```

### Evaluation flow

1. If `conditions_to_cancel` is non-empty: for each key, call `evaluateConditionKey(key, context)`. If any returns true → return `cancel_met`.
2. If `conditions_to_appear` is null or empty → return `not_eligible`.
3. **Appear:** If `"all"` in manifest: every key must be true. If `"threshold"` in manifest: count keys that are true; if count >= threshold → `appear_met`, else `not_eligible`.
4. Unknown condition key → treat as false (safe default; consider logging in dev).

### Condition kinds (registry)

Implement by mapping each condition key to a small function `(context) => boolean`. Extend the registry as new condition keys are added. Examples:

| Kind                   | Example keys                                                                      | Implementation note                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision not made      | `no_media_management_decision`, `no_perimeter_establishment_decision`             | True if no executed decision matches type/tag (e.g. media_management, perimeter).                                                            |
| Decision made          | `official_public_statement_issued`, `triage_zone_established`                     | True if at least one executed decision matches.                                                                                              |
| Prior inject fired     | `prior_social_media_rumour_inject_fired`, `civilian_panic_or_rumour_inject_fired` | True if a matching scenario inject id or inject key/tag is in `publishedScenarioInjectIds` / `publishedInjectKeysOrTags`.                    |
| Pathway outcome fired  | `pathway_fired_exit_b_congestion`, or `prior_pathway_outcome_fired:exit_b`        | True if consequence key is in `pathwayOutcomeKeysFired` (no double-hit).                                                                     |
| Env state threshold    | `crowd_density_above_0.6`, `crowd_density_in_triage_zone_elevated`                | True if `currentState.environmental_state.areas` (or routes) has a value above threshold; triage zone may be identified by area_id or label. |
| Objective progress     | `objective_evacuation_not_completed`                                              | True if evacuation objective in `objectiveProgress` has status !== 'completed' (or progress < 100).                                          |
| Gate status (optional) | `evacuation_gate_not_met`                                                         | True if `gateStatusByGateId[gateId] === 'not_met'`.                                                                                          |

"Fire once" (this inject already fired this session) is **not** a condition key — the inject engine skips injects that have already been published this session before calling the evaluator.

---

## Edge cases and caveats

- **N-of-M threshold:** For `{ "threshold": number, "conditions": string[] }`, a threshold of 0 is treated as 1 (at least one condition must be true). This avoids "always appear" when threshold was mis-specified.
- **Missing optional context:** If the engine omits optional fields (`publishedInjectKeysOrTags`, `pathwayOutcomeKeysFired`, `objectiveProgress`, `gateStatusByGateId`), the evaluator uses empty array/object and unknown keys evaluate to false. Missing gate id in `gateStatusByGateId` → `gate_not_met:<id>` is false.
- **Key/tag overlap:** Semantic keys like `prior_social_media_rumour_inject_fired` and `civilian_panic_or_rumour_inject_fired` both match tags containing "rumour"/"rumor"/"misinformation". One published inject can satisfy both conditions; design keys/tags with that in mind if you need distinct triggers.
- **No matching objective:** `objective_evacuation_not_completed` is **false** when there is no objective whose id/name contains "evacuation" (treated as not applicable). Document for scenario authors if that behaviour is desired.
- **One decision, many keys:** A single executed decision can satisfy multiple "decision made" condition keys (e.g. "Issue public statement" matches both statement- and public-related keys). Condition keys are not mutually exclusive.

---

## Acceptance criteria

- [ ] Service exports `evaluateInjectConditions(conditionsToAppear, conditionsToCancel, context): EvaluatorResult`.
- [ ] Cancel is evaluated first; any cancel condition true → `cancel_met`.
- [ ] Appear supports N-of-M (`threshold` + `conditions`) and "all" (`all`); null/empty appear → `not_eligible`.
- [ ] Condition keys are resolved via a registry; unknown key → false.
- [ ] Context includes at least: `currentState`, `executedDecisions`, `publishedScenarioInjectIds` or `publishedInjectKeysOrTags`, `pathwayOutcomeKeysFired`, `objectiveProgress`.
- [ ] Registry has at least one example per kind: decision not made, decision made, prior inject fired, pathway outcome fired, env threshold, objective progress (and optionally gate).
- [ ] No DB or API calls inside the evaluator; all data comes from the passed-in context.

---

## Depends on

- Step 1 (Database and schema) — `scenario_injects.conditions_to_appear`, `conditions_to_cancel` columns and condition manifest format.
- Inject engine (Step 4) will build context from session, decisions, published injects, pathway outcomes, objectives (and optionally gates) and call this service.
