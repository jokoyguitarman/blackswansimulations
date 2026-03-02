# Step 8 — Cleanup and deprecation

**Goal:** Identify legacy time-trigger and adversary paths; decide what to remove, what to keep for backward compatibility, and document the decision.

---

## Scope

- **Audit** the inject firing paths: time-based (scheduler), condition-driven (scheduler), and decision-triggered (injectTriggerService). No code removed; document which paths are active and how the adversary AI is used.
- **Decision:** Keep time-based path and adversary for time-based injects; keep condition-driven path (no adversary); keep decision-triggered service in code but document that it is **not currently wired** into the decision execute flow (so trigger_condition injects do not fire on execute). Authors can use condition-driven injects with “decision made” keys for similar behaviour, or the execute route can be updated later to call `evaluateDecisionBasedTriggers()`.
- **Policy doc:** Single reference ([INJECT_PATHS_AND_POLICY.md](../INJECT_PATHS_AND_POLICY.md)) that describes the three paths, what is kept, and the adversary policy.

---

## Files to create or modify

- **docs/INJECT_PATHS_AND_POLICY.md** — New: three inject paths (time-based, condition-driven, decision-triggered), status of each (keep / keep but not wired), adversary policy (time-based only).
- **docs/roadmap/step-08-cleanup.md** — This file: scope, files, decisions, acceptance criteria.

---

## Key structures or contracts

- **Time-based:** `injectSchedulerService` publishes injects where `trigger_time_minutes <= elapsedMinutes`, filtered by gates and published/cancelled sets. Optional AI cancel via `shouldCancelScheduledInject()` (adversary) before publish. **Kept.**
- **Condition-driven:** Same scheduler; injects with non-null `conditions_to_appear`; evaluated by `evaluateInjectConditions()`; no adversary. **Kept.**
- **Decision-triggered:** `injectTriggerService.evaluateDecisionBasedTriggers()` matches decisions to injects with `trigger_condition`. **Not called** from decision execute route; service and column kept for future use or admin/UI.

---

## Acceptance criteria

- [x] All inject firing paths (time-based, condition-driven, decision-triggered) are identified and documented.
- [x] Decision recorded: keep time-based and adversary for time-based injects; keep condition-driven; keep decision-triggered code but document “not wired” from execute.
- [x] Policy doc (INJECT_PATHS_AND_POLICY.md) exists and is linked from this step.
- [x] No code removed; backward compatibility preserved. Optional future work: wire `evaluateDecisionBasedTriggers()` into decision execute if decision-triggered firing is desired.

---

## Depends on

- Steps 1–7 (so that the new path is in place before deprecating the old).
