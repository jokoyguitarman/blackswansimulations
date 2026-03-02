# Inject paths and cleanup policy (Step 8)

This document records the **inject firing paths** in the codebase and the **decisions** made for Step 8 (cleanup and deprecation): what is kept, what is deprecated or unused, and how the adversary AI fits in.

---

## Three inject firing paths

### 1. Time-based (scheduler)

- **Where:** `server/services/injectSchedulerService.ts`
- **Trigger:** `scenario_injects.trigger_time_minutes <= elapsedMinutes` (and gate filters: `required_gate_id` / `required_gate_not_met_id`).
- **Decision:** **KEEP.** This is the primary path for scheduled scenario events. It runs every scheduler tick alongside condition-driven injects.
- **Adversary:** **KEEP.** Before publishing a time-based inject, the scheduler optionally calls `shouldCancelScheduledInject()` (in `server/services/aiService.ts`). The AI acts as the adversary: it cancels only when players have explicitly addressed the same entity (channel, facility, location) as in the inject; otherwise the inject runs (adversary adapts). This applies **only to time-based** injects, not to condition-driven ones.

### 2. Condition-driven (scheduler)

- **Where:** `server/services/injectSchedulerService.ts` (same tick as time-based).
- **Trigger:** `scenario_injects.conditions_to_appear` is not null; `eligible_after_minutes` and published/cancelled filters apply; `evaluateInjectConditions()` returns `appear_met` and not `cancel_met`.
- **Decision:** **KEEP.** This is the new “perfect storm” path (Steps 3–4, 7). No adversary AI — cancellation is rule-based via `conditions_to_cancel` and the condition evaluator.

### 3. Decision-triggered (trigger_condition)

- **Where:** `server/services/injectTriggerService.ts` — `evaluateDecisionBasedTriggers()`, `findMatchingInjects()`, `matchesTriggerCondition()`.
- **Trigger:** When a decision is executed, injects with `scenario_injects.trigger_condition` matching the decision’s classification (categories, keywords, semantic tags) could be published.
- **Decision:** **KEEP IN CODE, NOT WIRED.** The service and `trigger_condition` column exist and are used by scenario/admin APIs, but **`evaluateDecisionBasedTriggers()` is not called from the decision execute flow** (e.g. `server/routes/decisions.ts`). So decision-triggered injects do **not** currently fire on execute. Scenario authors can get similar behaviour with **condition-driven** injects using “decision made” condition keys (e.g. `official_public_statement_issued`). To enable decision-triggered firing, the decision execute route would need to call `evaluateDecisionBasedTriggers()` after a decision is executed; no removal or deprecation of the service is required.

---

## Summary table

| Path               | Location               | Status               | Adversary / cancel                  |
| ------------------ | ---------------------- | -------------------- | ----------------------------------- |
| Time-based         | injectSchedulerService | **KEEP**             | AI adversary (optional cancel)      |
| Condition-driven   | injectSchedulerService | **KEEP**             | Rule-based (`conditions_to_cancel`) |
| Decision-triggered | injectTriggerService   | **KEEP** (not wired) | N/A — not invoked on execute        |

---

## What was not removed

- **Time-based path:** Still the main way to run scheduled injects; required for existing scenarios and gates.
- **Adversary (`shouldCancelScheduledInject`):** Kept for time-based injects only; improves scenario challenge by allowing the “adversary” to adapt when players take generic measures.
- **Decision-triggered service:** Code and schema kept; can be wired later if desired. Not deprecated; simply not invoked from the execute flow today.

---

## Reference

- Scheduler: `server/services/injectSchedulerService.ts`
- Condition evaluator: `server/services/conditionEvaluatorService.ts`
- Adversary AI: `server/services/aiService.ts` — `shouldCancelScheduledInject`
- Decision-triggered: `server/services/injectTriggerService.ts`
- Condition manifest: [CONDITION_INJECT_DATA_MODEL.md](CONDITION_INJECT_DATA_MODEL.md)
- Step 8: [roadmap/step-08-cleanup.md](roadmap/step-08-cleanup.md)
