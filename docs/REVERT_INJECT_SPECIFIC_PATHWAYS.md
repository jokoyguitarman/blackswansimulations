# Revert: Inject-specific factors and pathways

## Summary

This change (1) makes factors and pathways **inject-specific** (prompt emphasis + optional inject passed into pathway generators), and (2) publishes **one pathway outcome inject per trigger inject** in each 5-minute cycle (from all pathway outcome rows in the last 5 minutes instead of only the latest). Reverting restores generic factors/pathways wording, removes the inject parameter from pathway generation, and restores **single** pathway-outcome publish per cycle (latest row only).

---

## Files changed

- **`server/services/aiService.ts`** — Prompt text in `identifyEscalationFactors`, `identifyDeEscalationFactors`; optional `justPublishedInject` parameter and prompt branches in `generateEscalationPathways`, `generateDeEscalationPathways`.
- **`server/services/pathwayOutcomesService.ts`** — Pass `justPublishedInject` into the two pathway calls.
- **`server/services/aiInjectSchedulerService.ts`** — Replace "load all rows in last 5 min, publish one per row" with the original "load latest row only, publish one outcome" logic.
- **`docs/REVERT_INJECT_SPECIFIC_PATHWAYS.md`** (this file).

---

## How to revert

1. **`server/services/aiService.ts`**
   - Remove the inject-specific sentences from the system/user prompts in `identifyEscalationFactors` and `identifyDeEscalationFactors` (the "When a just-published inject is provided..." and the conditional label "Just-published inject (...)" back to "Recent injects (current situation):").
   - In `generateEscalationPathways`: Remove the optional 4th parameter and 5th parameter; restore signature to `(scenarioDescription, currentState, escalationFactors, openAiApiKey)`. Remove the `injectInstruction` and `injectBlock` logic; use the original system and user prompts only.
   - In `generateDeEscalationPathways`: Remove the optional 5th and 6th parameters; restore signature to `(scenarioDescription, currentState, escalationPathways, deEscalationFactors, openAiApiKey)`. Remove the `injectInstruction` and `injectBlock` logic; use the original system and user prompts only.

2. **`server/services/pathwayOutcomesService.ts`**
   - Remove the `justPublishedInject` variable (the line `const justPublishedInject = singleInjectContext[0] ?? null;`).
   - In `generateEscalationPathways(...)` call: remove the `justPublishedInject` argument (revert to 4 args: scenario, state, factors, env.openAiApiKey).
   - In `generateDeEscalationPathways(...)` call: remove the `justPublishedInject` argument (revert to 5 args: scenario, state, pathways, deEscalationFactors, env.openAiApiKey).

3. **`server/services/aiInjectSchedulerService.ts`**
   - Restore the single-row query: from `session_pathway_outcomes` with `.eq('session_id', session.id).order('evaluated_at', { ascending: false }).limit(1).single()`, select `id, outcomes` only.
   - Remove the multi-row query, `fiveMinutesAgo` filter, `rowsToProcess`, `parseOutcomes` helper, and the loop over rows.
   - Restore single parse of `outcomes` (the existing defensive array/string parsing), single `toPublish` selection, single `scenario_injects` insert, and single `publishInjectToSession` call. Remove the `publishedCount` and the fallback that runs only when `publishedCount === 0`.

4. Optionally delete or keep `docs/REVERT_INJECT_SPECIFIC_PATHWAYS.md`.

No database or API contract changes; no new migrations. Revert is code-only.
