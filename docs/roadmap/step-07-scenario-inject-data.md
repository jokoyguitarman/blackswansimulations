# Step 7 — Scenario and inject data model

**Goal:** Define or migrate scenario injects to use conditions (appear/cancel) and eligibility time; document format for condition manifests and cancel conditions.

---

## Scope

- **Document** the data model for condition-driven injects: `conditions_to_appear` (N-of-M or all), `conditions_to_cancel` (array of keys), `eligible_after_minutes`. No new code paths — the condition evaluator (Step 3) and inject engine (Step 4) already consume these columns.
- **Author reference:** Single doc for scenario authors listing supported condition keys (registry + prefix rules) and example JSON so new scenarios can add condition-driven injects via admin/UI or migrations.
- **Optional:** Migrate or seed at least one scenario with example condition-driven injects (e.g. “rumour spreads” after N minutes when conditions are met); can be done in a later migration when scenario IDs are known.

---

## Files to create or modify

- **docs/CONDITION_INJECT_DATA_MODEL.md** — New: manifest format (`conditions_to_appear`, `conditions_to_cancel`), `eligible_after_minutes`, full list of condition keys (registry + prefix rules), and example inject JSON. Reference for scenario authors and for any admin/UI that edits injects.
- **docs/roadmap/step-07-scenario-inject-data.md** — This file: scope, files, contracts, acceptance criteria (filled below).

---

## Key structures or contracts

- **conditions_to_appear** (JSONB): `{ "threshold": number, "conditions": string[] }` (N-of-M) or `{ "all": string[] }` (all required). Implemented in `conditionEvaluatorService.ts`; see `ConditionsToAppear` type.
- **conditions_to_cancel** (JSONB): `string[]`. If any key is true → inject not fired. See `ConditionsToCancel` type.
- **eligible_after_minutes** (INTEGER): Earliest session minute to evaluate; `NULL` = no delay. Enforced in `injectSchedulerService.ts` before calling the evaluator.
- **Condition keys:** Resolved by `evaluateConditionKey(key, context)`. Keys are either prefix-based (`inject_fired:<id>`, `gate_not_met:<gate_id>`, `objective_not_completed:<id>`, `prior_pathway_outcome_fired:<key>`) or named registry keys (e.g. `no_media_management_decision`, `official_public_statement_issued`). Full list in [CONDITION_INJECT_DATA_MODEL.md](../CONDITION_INJECT_DATA_MODEL.md).

---

## Acceptance criteria

- [x] Manifest format for `conditions_to_appear` and `conditions_to_cancel` is documented and matches what the condition evaluator expects (N-of-M, all, string array).
- [x] `eligible_after_minutes` is documented; behaviour (skip evaluation until elapsedMinutes >= value) is implemented in inject engine.
- [x] Author-facing doc lists all supported condition keys (registry + prefix rules) and includes at least one full example inject JSON.
- [x] Step 7 doc (this file) records scope, files, and acceptance criteria; no code changes required in evaluator or engine (they already consume the columns).

---

## Depends on

- Step 1 (Database and schema) — `scenario_injects.conditions_to_appear`, `conditions_to_cancel`, `eligible_after_minutes`.
- Step 3 (Condition evaluator service) — condition format and key resolution.
- Step 4 (Inject engine) — how it reads and evaluates condition-driven injects.
