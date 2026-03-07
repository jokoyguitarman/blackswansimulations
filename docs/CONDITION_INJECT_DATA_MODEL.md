# Condition-based inject data model (Step 7)

This document defines how to author **condition-driven injects**: the shape of `conditions_to_appear`, `conditions_to_cancel`, and `eligible_after_minutes` on `scenario_injects`, and the list of **condition keys** the evaluator supports. The inject engine (Step 4) uses this data every 5-minute cycle; the condition evaluator (Step 3) resolves keys against the current session context.

---

## Database columns (`scenario_injects`)

| Column                   | Type    | Purpose                                                                                                                                                                                               |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditions_to_appear`   | JSONB   | When non-null, this inject is **condition-driven**. Format below.                                                                                                                                     |
| `conditions_to_cancel`   | JSONB   | Optional. If any listed condition is true, the inject is not fired (cancelled). Format: `string[]`.                                                                                                   |
| `eligible_after_minutes` | INTEGER | Earliest session minute when this inject may be evaluated. `NULL` = no delay (e.g. from session start).                                                                                               |
| `objective_penalty`      | JSONB   | **Phase 3.** When this inject is published, apply penalty: `{ "objective_id": "triage", "reason": "Death on site", "points": 15 }`. Optional.                                                         |
| `state_effect`           | JSONB   | **Phase 3.** When this inject is published, merge into `session.current_state` e.g. `{ "triage_state": { "deaths_on_site": 1 } }`. Keys: `evacuation_state`, `triage_state`, `media_state`. Optional. |

For **time-based** injects, set `trigger_time_minutes` and optionally `required_gate_id` / `required_gate_not_met_id`. For **condition-driven** injects, set `conditions_to_appear` (and optionally `conditions_to_cancel`, `eligible_after_minutes`). An inject can have either a time trigger or condition manifest (or be decision-triggered via other flows). When an inject with `objective_penalty` or `state_effect` is published, the apply logic runs in `publishInjectToSession` ([server/routes/injects.ts](server/routes/injects.ts)).

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
- **Number** (e.g. `5`, `10`): inject is only considered when `elapsedMinutes >= eligible_after_minutes`. Use this to avoid a "perfect storm" firing in the first few minutes before players have had time to act.

---

## Condition keys (registry + prefixes)

The evaluator resolves each key against the current session context. Unknown keys evaluate to **false**.

### Prefix rules (dynamic keys)

| Prefix                         | Format                                          | Example                                             | Meaning                                                                                                            |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prior_pathway_outcome_fired:` | `prior_pathway_outcome_fired:<consequence_key>` | `prior_pathway_outcome_fired:exit_b_congestion`     | True if that pathway consequence key has been fired this session.                                                  |
| `inject_fired:`                | `inject_fired:<scenario_inject_id>`             | `inject_fired:550e8400-e29b-41d4-a716-446655440000` | True if that scenario inject has been published this session.                                                      |
| `objective_not_completed:`     | `objective_not_completed:<objective_id>`        | `objective_not_completed:evacuate_civilians`        | True if that objective's status is not `completed`.                                                                |
| `gate_not_met:`                | `gate_not_met:<gate_id>`                        | `gate_not_met:evacuation_gate`                      | True if that gate's status is `not_met`. `gate_id` is the text id from `scenario_gates` / `session_gate_progress`. |

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

- `objective_evacuation_not_completed` — true if an objective whose id/name contains "evacuation" is not completed.

**Gate** (from `session_gate_progress`; key = gate_id text):

- `evacuation_gate_not_met` — true if any gate whose id contains "evacuation" has status `not_met`. For a specific gate use prefix `gate_not_met:<gate_id>`.

**Team state (from `current_state`; Phase 2)**

Keys read from top-level `evacuation_state`, `triage_state`, and `media_state` (set at session start by the environmental state service, or by later updates). Use in `conditions_to_appear` / `conditions_to_cancel` for condition-driven injects.

| Key                                       | Meaning                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `evacuation_no_flow_control_decision`     | No executed decision indicates flow/bottleneck control (keywords: flow, bottleneck, stagger, congestion, egress). |
| `evacuation_flow_control_decided`         | `evacuation_state.flow_control_decided === true`.                                                                 |
| `evacuation_exit_bottleneck_active`       | `evacuation_state.exits_congested` is a non-empty array.                                                          |
| `evacuation_coordination_not_established` | `evacuation_state.coordination_with_triage !== true`.                                                             |
| `evacuation_coordination_established`     | `evacuation_state.coordination_with_triage === true`.                                                             |
| `triage_supply_critical`                  | `triage_state.supply_level === 'critical'`.                                                                       |
| `triage_supply_low`                       | `triage_state.supply_level` is `'low'` or `'critical'`.                                                           |
| `triage_surge_active`                     | `triage_state.surge_active === true`.                                                                             |
| `triage_no_supply_management_decision`    | No executed decision matches supply management (supply, request, ration, shortage, equipment, etc.).              |
| `triage_no_prioritisation_decision`       | No executed decision matches prioritisation (prioritise, critical first, severity, triage protocol, etc.).        |
| `triage_prioritisation_decided`           | `triage_state.prioritisation_decided === true`.                                                                   |
| `triage_supply_request_made`              | `triage_state.supply_request_made === true`.                                                                      |
| `triage_deaths_on_site_positive`          | `triage_state.deaths_on_site > 0`.                                                                                |
| `media_no_statement_by_T12`               | `elapsedMinutes >= 12` and `media_state.first_statement_issued !== true`.                                         |
| `media_statement_issued`                  | `media_state.first_statement_issued === true`.                                                                    |
| `media_misinformation_not_addressed`      | `media_state.misinformation_addressed !== true`.                                                                  |
| `media_journalist_arrived`                | `media_state.journalist_arrived === true`.                                                                        |
| `media_misinformation_addressed`          | True when `media_state.misinformation_addressed === true`.                                                        |

**Phase 4: C2E condition-driven injects (examples)**

The following condition-driven injects use the keys above. State-setting time-based injects (e.g. "Journalist Arrives", "Patient surge at triage site") use `state_effect` so `media_state.journalist_arrived` and `triage_state.surge_active` become true when those injects are published.

| Team       | Inject title                             | Condition keys (appear)                                                                      | Cancel keys                                | Penalty / state_effect            |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Evacuation | Exit bottleneck – flow control needed    | `evacuation_exit_bottleneck_active`, `evacuation_no_flow_control_decision`                   | `evacuation_flow_control_decided`          | —                                 |
| Evacuation | Coordination with triage not established | `evacuation_exit_bottleneck_active`, `evacuation_coordination_not_established`               | `evacuation_coordination_established`      | —                                 |
| Triage     | Supply crisis at triage                  | `triage_supply_critical`, `triage_no_supply_management_decision`                             | `triage_supply_request_made`               | objective_penalty: triage, 20 pts |
| Triage     | Surge – prioritisation needed            | `triage_surge_active`, `triage_no_prioritisation_decision`                                   | `triage_prioritisation_decided`            | —                                 |
| Triage     | Death at Triage (Phase 3)                | `triage_no_prioritisation_decision`, `triage_surge_active`                                   | `triage_deaths_on_site_positive`           | objective_penalty + state_effect  |
| Media      | No official statement by T+12            | `media_no_statement_by_T12`                                                                  | `media_statement_issued`                   | —                                 |
| Media      | Misinformation still unaddressed         | `media_misinformation_not_addressed`, `prior_social_media_rumour_inject_fired` (threshold 2) | `media_misinformation_addressed` (Phase 5) | —                                 |

Migration: `migrations/077_c2e_condition_driven_injects_and_state_effects.sql`. Phase 5: `migrations/078_c2e_misinformation_inject_cancel_condition.sql` sets `conditions_to_cancel` for "Misinformation still unaddressed".

**Phase 5: Verification**

Manual verification steps for the C2E granular-pressures pipeline (Phases 1–4 and Phase 5):

1. **Session start (Phase 1):** Start a C2E session; confirm `current_state` includes `evacuation_state`, `triage_state`, and `media_state` (from environmental seed or defaults).
2. **Time-based state effects (Phase 4):** Let T+8 and T+12 time-based injects fire; confirm `triage_state.surge_active` and `media_state.journalist_arrived` are set via `state_effect`.
3. **Triage condition-driven (Phases 2–4):** As Triage with no prioritisation decision, confirm "Surge – prioritisation needed" and (if eligible) "Death at Triage" can fire; after a prioritisation decision, confirm they cancel.
4. **Media statement (Phase 4):** As Media with no statement by T+12, confirm "No official statement by T+12" fires; after a public statement decision, confirm it cancels.
5. **Misinformation loop (Phase 5):** With a rumour inject already fired and no debunk decision, confirm "Misinformation still unaddressed" can fire. After a Media decision classified as `misinformation_management` (or matching keywords: debunk, counter, correct, misinformation, rumour, narrative), confirm `current_state.media_state.misinformation_addressed === true` and that "Misinformation still unaddressed" cancels on the next scheduler tick.

Objective penalties (e.g. "Death on site", "Supply crisis") from injects are stored in `scenario_objective_progress.penalties` and are available to AAR/reporting.

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

This inject is eligible only after 10 minutes have elapsed, when at least 2 of the 3 "appear" conditions are true, and only if no executed decision has satisfied "official public statement issued" (cancel condition).

---

## Reference

- **Evaluator:** `server/services/conditionEvaluatorService.ts` — `ConditionsToAppear`, `ConditionsToCancel`, `EvaluatorResult`, `evaluateInjectConditions`, `evaluateConditionKey`.
- **Engine:** `server/services/injectSchedulerService.ts` — fetches injects with `conditions_to_appear` not null, filters by `eligible_after_minutes` and published/cancelled, calls evaluator, publishes when `appear_met`.
- **Schema:** `migrations/062_inject_conditions_scenario_locations.sql` — columns on `scenario_injects`.
- **Step docs:** [step-03-condition-evaluator.md](roadmap/step-03-condition-evaluator.md), [step-04-inject-engine.md](roadmap/step-04-inject-engine.md), [step-07-scenario-inject-data.md](roadmap/step-07-scenario-inject-data.md).
