# Revert: Pathway outcomes on inject publish

## Summary

This document describes the change that runs **factors and pathway outcome generation when an inject is published** (instead of every 5 minutes), stores **pre-generated outcome injects** in `session_pathway_outcomes`, and at each **5-minute cycle** matches player robustness to a band (low/medium/high) and **publishes the corresponding outcome inject** instead of generating a new inject from decisions from scratch. Reverting restores the previous behavior: factors and pathways are recomputed every 5 minutes in the scheduler, and injects are generated from decisions each cycle via `generateInjectFromDecision`.

---

## Files changed

- **`migrations/053_session_pathway_outcomes.sql`** — New table `session_pathway_outcomes`.
- **`server/services/aiService.ts`** — New: `PathwayOutcome`, `PathwayOutcomeInjectPayload`, `GeneratePathwayOutcomeInjectsResult`, `generatePathwayOutcomeInjects()`.
- **`server/services/pathwayOutcomesService.ts`** — New file: `runPathwayOutcomesOnInjectPublished()`, `buildPathwayUsageSummary()`.
- **`server/routes/injects.ts`** — Import `runPathwayOutcomesOnInjectPublished`; after broadcast in `publishInjectToSession`, fire-and-forget call to `runPathwayOutcomesOnInjectPublished(sessionId, injectId)`.
- **`server/services/aiInjectSchedulerService.ts`** — Removed per-cycle Stage 2/3 (identifyEscalationFactors, generateEscalationPathways, etc.). Now loads latest `session_escalation_factors` and `session_escalation_pathways` from DB. Loads latest `session_pathway_outcomes`; when outcomes exist and there are decisions, computes robustness band, selects matching outcome, creates `scenario_inject` from `inject_payload`, publishes. Fallback: when no pathway outcomes, runs `generateUniversalInject` and `generateTeamSpecificInject` as before. New helper `computeRobustnessBand()`.
- **`docs/REVERT_PATHWAY_OUTCOMES_ON_INJECT_PUBLISH.md`** (this file).

---

## Previous behavior (before this change)

- Every 5 minutes the scheduler ran: identify escalation factors → identify de-escalation factors → generate escalation pathways → generate de-escalation pathways → insert into `session_escalation_factors` and `session_escalation_pathways` → compute impact matrix → generate universal and team-specific injects from decisions via `generateInjectFromDecision` → publish those injects.
- No logic ran when an inject was published.

---

## New behavior (after this change)

- **On every inject publish** (scheduler, trigger, or manual): `runPathwayOutcomesOnInjectPublished(sessionId, injectId)` runs asynchronously. It loads the just-published inject and session, runs identifyEscalationFactors, identifyDeEscalationFactors, generateEscalationPathways, generateDeEscalationPathways, then `generatePathwayOutcomeInjects` to produce 3–8 outcome injects (low/medium/high robustness bands). It writes to `session_escalation_factors`, `session_escalation_pathways`, and `session_pathway_outcomes`.
- **Every 5 minutes** the scheduler loads the latest factors/pathways from the DB (no per-cycle AI for factors/pathways), runs the impact matrix, loads the latest `session_pathway_outcomes`. If outcomes exist and there are decisions, it computes a robustness band from the matrix, picks one outcome matching that band, creates a `scenario_inject` from the outcome’s `inject_payload`, and publishes it (which triggers the on-publish flow again). If no pathway outcomes exist (e.g. first cycle), it falls back to generating injects from decisions as before.

---

## How to revert

1. **Database**
   - Run: `DROP TABLE IF EXISTS session_pathway_outcomes;` (or add a down-migration that does this). Optionally keep the table for historical data and only disable the behavior in code.

2. **`server/routes/injects.ts`**
   - Remove the import of `runPathwayOutcomesOnInjectPublished` from `../services/pathwayOutcomesService.js`.
   - Remove the fire-and-forget block that calls `void runPathwayOutcomesOnInjectPublished(sessionId, injectId).catch(...)` (the lines immediately after the `getWebSocketService().injectPublished(...)` block).

3. **`server/services/pathwayOutcomesService.ts`**
   - Delete the file entirely (or remove/disable the export of `runPathwayOutcomesOnInjectPublished` if you want to keep the file for reference).

4. **`server/services/aiService.ts`**
   - Remove the types: `PathwayOutcomeInjectPayload`, `PathwayOutcome`, `GeneratePathwayOutcomeInjectsResult`.
   - Remove the function `generatePathwayOutcomeInjects` (the entire block from the comment "Inject payload for a pathway outcome" through the end of that function, including the closing `};` before `/** Optional AI reasoning for the impact matrix */`).

5. **`server/services/aiInjectSchedulerService.ts`**
   - Restore the imports: add `identifyEscalationFactors`, `identifyDeEscalationFactors`, `generateEscalationPathways`, `generateDeEscalationPathways` from `./aiService.js`; remove the `PathwayOutcome` type import.
   - Remove the helper `computeRobustnessBand()`.
   - Replace the block that "Load latest escalation factors and pathways" (the two queries to `session_escalation_factors` and `session_escalation_pathways`) with the original **Stage 2/3** block that: runs `identifyEscalationFactors`, `identifyDeEscalationFactors`, inserts into `session_escalation_factors`, runs `generateEscalationPathways`, `generateDeEscalationPathways`, inserts into `session_escalation_pathways` (with the same `ai_step_start` / `ai_step_end` events). Use the same variable names `escalationFactorsSnapshot`, `deEscalationFactorsSnapshot`, `escalationPathwaysSnapshot`, `deEscalationPathwaysSnapshot`.
   - Replace the block that loads `session_pathway_outcomes`, computes `robustnessBand`, and either publishes an outcome inject or falls back to `generateUniversalInject` / `generateTeamSpecificInject`, with the original simple block: when `formattedDecisions.length > 0`, emit `ai_step_start` for inject_generation, call `generateUniversalInject` and then for each team with decisions call `generateTeamSpecificInject`, then emit `ai_step_end` for inject_generation. Remove the pathway-outcomes query and the outcome-inject creation/publish logic.

6. **`docs/REVERT_PATHWAY_OUTCOMES_ON_INJECT_PUBLISH.md`**
   - You can delete this file or keep it for reference.

After reverting, factors and pathways are again computed every 5 minutes in the scheduler, and injects are generated from decisions each cycle; no on-inject-published pathway outcomes run, and the table `session_pathway_outcomes` is dropped (or unused).
