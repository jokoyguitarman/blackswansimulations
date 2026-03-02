# Condition-based inject data model (Step 7)

This document defines how to author **condition-driven injects**: the shape of `conditions_to_appear`, `conditions_to_cancel`, and `eligible_after_minutes` on `scenario_injects`, and the list of **condition keys** the evaluator supports. The inject engine (Step 4) uses this data every 5-minute cycle; the condition evaluator (Step 3) resolves keys against the current session context.

---

## Database columns (`scenario_injects`)

| Column                   | Type    | Purpose                                                                                                 |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `conditions_to_appear`   | JSONB   | When non-null, this inject is **condition-driven**. Format below.                                       |
| `conditions_to_cancel`   | JSONB   | Optional. If any listed condition is true, the inject is not fired (cancelled). Format: `string[]`.     |
| `eligible_after_minutes` | INTEGER | Earliest session minute when this inject may be evaluated. `NULL` = no delay (e.g. from session start). |

For **time-based** injects, set `trigger_time_minutes` and optionally `required_gate_id` / `required_gate_not_met_id`. For **condition-driven** injects, set `conditions_to_appear` (and optionally `conditions_to_cancel`, `eligible_after_minutes`). An inject can have either a time trigger or condition manifest (or be decision-triggered via other flows).

---

## conditions_to_appear (JSONB)

One of two shapes:

### 1. N-of-M (at least N conditions true)

```json
{
  "threshold": 2,
  "conditions": [
    "no_media_management_decision",
    "no_perimeter_establishment_decision",
    "crowd_density_above_0.6"
  ]
}
```

- **threshold**: number — at least this many keys must evaluate to true. If `threshold` is 0 it is treated as 1.
- **conditions**: array of condition key strings.

### 2. All required (every condition must be true)

```json
{
  "all": ["official_public_statement_issued", "triage_zone_established_as_incident_location"]
}
```

- **all**: array of condition key strings. Every key must be true for the inject to be eligible.

---

## conditions_to_cancel (JSONB)

A **string array** of condition keys. If **any** key is true when the engine evaluates this inject, the result is **cancel_met** and the inject is not published.

```json
["official_public_statement_issued", "prior_social_media_rumour_inject_fired"]
```

---

## eligible_after_minutes (INTEGER)

- **NULL**: inject can be evaluated from the first scheduler tick (session start).
- **Number** (e.g. `5`, `10`): inject is only considered when `elapsedMinutes >= eligible_after_minutes`. Use this to avoid a “perfect storm” firing in the first few minutes before players have had time to act.

---

## Condition keys (registry + prefixes)

The evaluator resolves each key against the current session context. Unknown keys evaluate to **false**.

### Prefix rules (dynamic keys)

| Prefix                         | Format                                          | Example                                             | Meaning                                                                                                            |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prior_pathway_outcome_fired:` | `prior_pathway_outcome_fired:<consequence_key>` | `prior_pathway_outcome_fired:exit_b_congestion`     | True if that pathway consequence key has been fired this session.                                                  |
| `inject_fired:`                | `inject_fired:<scenario_inject_id>`             | `inject_fired:550e8400-e29b-41d4-a716-446655440000` | True if that scenario inject has been published this session.                                                      |
| `objective_not_completed:`     | `objective_not_completed:<objective_id>`        | `objective_not_completed:evacuate_civilians`        | True if that objective’s status is not `completed`.                                                                |
| `gate_not_met:`                | `gate_not_met:<gate_id>`                        | `gate_not_met:evacuation_gate`                      | True if that gate’s status is `not_met`. `gate_id` is the text id from `scenario_gates` / `session_gate_progress`. |

### Named keys (registry)

**Decision not made** (true when no executed decision matches):

- `no_media_management_decision`
- `no_perimeter_establishment_decision`
- `no_patient_privacy_or_access_control_decision`
- `no_triage_perimeter_security_decision`

**Decision made** (true when at least one executed decision matches):

- `official_public_statement_issued`
- `triage_zone_established_as_incident_location`

**Prior inject / comms** (true when a matching inject or tag is in published injects; may use `publishedInjectKeysOrTags` when populated):

- `prior_social_media_rumour_inject_fired`
- `civilian_panic_or_rumour_inject_fired`
- `public_comms_channel_inactive`

**Pathway outcome** (no double-hit):

- `pathway_fired_exit_b_congestion` — or use prefix `prior_pathway_outcome_fired:<key>` for other keys.

**Environment (from `current_state.environmental_state.areas`)**:

- `crowd_density_above_0.6` — any area with `crowd_density >= 0.6`
- `crowd_density_in_triage_zone_elevated` — triage area (by label/area_id) with density >= 0.5

**Objective progress** (from `scenario_objective_progress`):

- `objective_evacuation_not_completed` — true if an objective whose id/name contains “evacuation” is not completed.

**Gate** (from `session_gate_progress`; key = gate_id text):

- `evacuation_gate_not_met` — true if any gate whose id contains “evacuation” has status `not_met`. For a specific gate use prefix `gate_not_met:<gate_id>`.

---

## Example condition-driven inject (JSON)

```json
{
  "title": "Rumour spreads after delay",
  "content": "Social media reports suggest...",
  "trigger_time_minutes": null,
  "conditions_to_appear": {
    "threshold": 2,
    "conditions": [
      "no_media_management_decision",
      "crowd_density_above_0.6",
      "objective_evacuation_not_completed"
    ]
  },
  "conditions_to_cancel": ["official_public_statement_issued"],
  "eligible_after_minutes": 10
}
```

This inject is eligible only after 10 minutes have elapsed, when at least 2 of the 3 “appear” conditions are true, and only if no executed decision has satisfied “official public statement issued” (cancel condition).

---

## Reference

- **Evaluator:** `server/services/conditionEvaluatorService.ts` — `ConditionsToAppear`, `ConditionsToCancel`, `EvaluatorResult`, `evaluateInjectConditions`, `evaluateConditionKey`.
- **Engine:** `server/services/injectSchedulerService.ts` — fetches injects with `conditions_to_appear` not null, filters by `eligible_after_minutes` and published/cancelled, calls evaluator, publishes when `appear_met`.
- **Schema:** `migrations/062_inject_conditions_scenario_locations.sql` — columns on `scenario_injects`.
- **Step docs:** [step-03-condition-evaluator.md](roadmap/step-03-condition-evaluator.md), [step-04-inject-engine.md](roadmap/step-04-inject-engine.md), [step-07-scenario-inject-data.md](roadmap/step-07-scenario-inject-data.md).
