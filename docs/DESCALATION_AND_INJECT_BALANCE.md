# De-escalation pathways and inject balance

This document describes where de-escalation and inject-balance changes live, what they do, and how to revert them.

## Where the changes happen

| Area | File | Section |
|------|------|---------|
| Database | `migrations/051_add_de_escalation.sql` | New migration |
| AI service | `server/services/aiService.ts` | New interfaces; `identifyDeEscalationFactors`; `generateDeEscalationPathways`; `generateInjectFromDecision` session context and prompt |
| Scheduler | `server/services/aiInjectSchedulerService.ts` | After Stage 2 (factors) and Stage 3 (pathways); baseContext for injects |
| AAR | `server/routes/aar.ts` | Selects and response shape for escalation factors/pathways (de_escalation_factors, de_escalation_pathways) |
| Sessions | `server/routes/sessions.ts` | Selects from `session_escalation_factors` and `session_escalation_pathways`; activities and GET `/sessions/:id/escalation` response |

## What the changes are

### Migration

- **session_escalation_factors**: new column `de_escalation_factors` (JSONB, default `[]`). Comment: de-escalation factors (what helps mitigate); array of `{id, name, description}`.
- **session_escalation_pathways**: new column `de_escalation_pathways` (JSONB, default `[]`). Comment: de-escalation pathways (how situation improves when mitigated); array of `{pathway_id, trajectory, mitigating_behaviours[], emerging_challenges[]?}`.
- No new tables; each evaluation row holds both escalation and de-escalation data.

### AI service

- **New types**: `DeEscalationFactor` (id, name, description), `DeEscalationPathway` (pathway_id, trajectory, mitigating_behaviours, optional emerging_challenges), and their result types.
- **identifyDeEscalationFactors**: same inputs as Stage 2 (scenario, state, objectives, recent injects) plus escalation factors. Returns 3–8 factors that help mitigate. Exported.
- **generateDeEscalationPathways**: scenario, state, escalation pathways, de-escalation factors. Returns 2–6 pathways with trajectory, mitigating_behaviours, and 0–2 emerging_challenges per pathway. Exported.
- **generateInjectFromDecision**: sessionContext extended with `deEscalationFactors` and `deEscalationPathways`. Escalation context block includes a **De-escalation** section when present, and a **rule**: when robustness is high (7–10), prefer de-escalation pathways; **always** introduce or highlight at least one new/remaining challenge (from escalation factors or emerging_challenges). Bullet list and “Important considerations” updated so injects must not be “everything positive”; always leave at least one active problem or emerging challenge.

### Scheduler

- After `identifyEscalationFactors`: call `identifyDeEscalationFactors` (same inputs plus escalation factors); store in `deEscalationFactorsSnapshot`; insert `de_escalation_factors` in the same `session_escalation_factors` row.
- After `generateEscalationPathways`: call `generateDeEscalationPathways` (scenario, state, escalation pathways, de-escalation factors); store in `deEscalationPathwaysSnapshot`; insert `de_escalation_pathways` in the same `session_escalation_pathways` row.
- baseContext for inject generation: `deEscalationFactors` and `deEscalationPathways` added when non-empty.
- Errors in de-escalation calls are caught and logged; cycle continues with empty de-escalation data.

### AAR and sessions routes

- **AAR**: selects for escalation factors/pathways include `de_escalation_factors` and `de_escalation_pathways`; session data and payload expose them so the frontend (and future AAR AI) can use them.
- **Sessions**: both places that select from `session_escalation_factors` and `session_escalation_pathways` now select the new columns; activities (`escalation_factors_computed`, `escalation_pathways_computed`) and GET `/sessions/:id/escalation` include the new fields in the response.

## What they mean

- **De-escalation factors**: what helps mitigate (e.g. clear messaging, controlled evacuation). They complement escalation factors (what makes things worse).
- **De-escalation pathways**: how the situation improves when mitigated (trajectory + mitigating_behaviours). They counter escalation pathways (how things get worse).
- **Emerging challenges**: 0–2 short phrases per de-escalation pathway for “what new problem might appear once this is mitigated” (e.g. media pressure for casualty figures). They keep the scenario engaging so it does not become too easy.
- **Robustness rule**: when robustness is high (7–10), injects can reflect de-escalation (things improving where the team did well). When robustness is low, injects can reflect escalation (risks materialising). **Always** ensure the inject introduces or highlights at least one new or remaining challenge so the sim stays engaging and does not feel fully under control.
- Together, escalation and de-escalation let the story both “get better” where the team performed well and “stay hard” by shifting to new problem areas or emerging challenges.

## How to revert

1. **Database**: Add a down-migration that drops `session_escalation_factors.de_escalation_factors` and `session_escalation_pathways.de_escalation_pathways`, or remove/roll back the migration `051_add_de_escalation.sql` if applicable.
2. **aiService.ts**: Remove the `DeEscalationFactor` / `DeEscalationPathway` interfaces and result types; remove `identifyDeEscalationFactors` and `generateDeEscalationPathways`; from `generateInjectFromDecision` remove `deEscalationFactors` and `deEscalationPathways` from the session context type and remove the de-escalation block and “always new problem” rule from the prompt.
3. **aiInjectSchedulerService.ts**: Remove imports and calls to `identifyDeEscalationFactors` and `generateDeEscalationPathways`; remove `deEscalationFactorsSnapshot` and `deEscalationPathwaysSnapshot`; remove `de_escalation_factors` and `de_escalation_pathways` from the inserts; remove `deEscalationFactors` and `deEscalationPathways` from baseContext.
4. **Routes**: In `server/routes/aar.ts` and `server/routes/sessions.ts`, remove `de_escalation_factors` and `de_escalation_pathways` from the relevant selects and from the response/activity shapes.
5. **Doc**: Remove or archive `docs/DESCALATION_AND_INJECT_BALANCE.md` if desired.
