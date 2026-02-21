# Revert: Escalation factors/pathways recompute every 5 minutes

## Summary

This document describes the change that makes escalation factors and pathways **recompute every 5-minute cycle** (based on current state and injects in the last 5 minutes) and how to **revert** it to the previous behavior (compute once per session, then reuse from DB).

---

## File changed

- **`server/services/aiInjectSchedulerService.ts`**
  - Section: "Stage 2/3: ..." inside `processSessionForAIInjects`, just before "Latest impact matrix/factors for inject generation".

---

## Previous behavior (before this change)

- On each 5-minute tick the service **loaded** the latest row from `session_escalation_factors` and `session_escalation_pathways` for the session.
- If **both** tables already had at least one row for the session, it **reused** those rows (no AI call, no insert). Only the first tick ran Stage 2 and Stage 3 and inserted one row each.
- Result: **One row per session** in each of `session_escalation_factors` and `session_escalation_pathways`.

---

## New behavior (after this change)

- On **every** 5-minute tick the service:
  - Runs **Stage 2** (`identifyEscalationFactors`) with: scenario description, `session.current_state`, objectives, and **injects published in the last 5 minutes** (`formattedInjects`).
  - Inserts a **new** row into `session_escalation_factors`.
  - Runs **Stage 3** (`generateEscalationPathways`) with the newly computed factors and current state.
  - Inserts a **new** row into `session_escalation_pathways`.
- No read from DB for "existing" factors/pathways in this path; the snapshot used for the rest of the cycle (impact matrix, AI injects) is the newly computed result.
- Result: **Multiple rows per session** in each table (one per 5-minute tick until the game ends).

---

## How to revert

To go back to "compute once, reuse from DB":

1. Open **`server/services/aiInjectSchedulerService.ts`**.
2. Find the block that starts with:
   - `// Stage 2/3: Recompute escalation factors and pathways every 5-min cycle...`
3. **Replace** that entire block (from that comment through the closing `}` of the `if (env.openAiApiKey)` that contains it, i.e. just before `// Latest impact matrix/factors for inject generation`) with the following:

```ts
    // Stage 2/3: Load latest escalation factors and pathways, or run Stage 2 + 3 if none (Checkpoint 6)
    let escalationFactorsSnapshot: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
    }> = [];
    let escalationPathwaysSnapshot: Array<{
      pathway_id: string;
      trajectory: string;
      trigger_behaviours: string[];
    }> = [];
    if (env.openAiApiKey) {
      try {
        const [factorsRows, pathwaysRows] = await Promise.all([
          supabaseAdmin
            .from('session_escalation_factors')
            .select('evaluated_at, factors')
            .eq('session_id', session.id)
            .order('evaluated_at', { ascending: false })
            .limit(1),
          supabaseAdmin
            .from('session_escalation_pathways')
            .select('evaluated_at, pathways')
            .eq('session_id', session.id)
            .order('evaluated_at', { ascending: false })
            .limit(1),
        ]);
        const hasExistingFactors = (factorsRows.data?.length ?? 0) > 0;
        const hasExistingPathways = (pathwaysRows.data?.length ?? 0) > 0;

        if (hasExistingFactors && hasExistingPathways) {
          escalationFactorsSnapshot =
            (factorsRows.data![0].factors as typeof escalationFactorsSnapshot) ?? [];
          escalationPathwaysSnapshot =
            (pathwaysRows.data![0].pathways as typeof escalationPathwaysSnapshot) ?? [];
          logger.debug(
            { sessionId: session.id },
            'Using latest escalation factors and pathways from DB',
          );
        } else {
          const objectivesForFactors = (objectives || []).map(
            (o: { objective_id?: string; objective_name?: string }) => ({
              objective_id: o.objective_id,
              objective_name: o.objective_name,
            }),
          );
          const factorsResult = await identifyEscalationFactors(
            scenario?.description ?? '',
            session.current_state ?? {},
            objectivesForFactors,
            formattedInjects.map((i: { type?: string; title?: string; content?: string }) => ({
              type: i.type,
              title: i.title,
              content: i.content,
            })),
            env.openAiApiKey,
          );
          escalationFactorsSnapshot = factorsResult.factors;
          await supabaseAdmin.from('session_escalation_factors').insert({
            session_id: session.id,
            evaluated_at: new Date().toISOString(),
            factors: factorsResult.factors,
          });
          logger.info(
            { sessionId: session.id, factorCount: factorsResult.factors.length },
            'Escalation factors computed and saved',
          );

          try {
            const pathwaysResult = await generateEscalationPathways(
              scenario?.description ?? '',
              session.current_state ?? {},
              factorsResult.factors,
              env.openAiApiKey,
            );
            escalationPathwaysSnapshot = pathwaysResult.pathways;
            await supabaseAdmin.from('session_escalation_pathways').insert({
              session_id: session.id,
              evaluated_at: new Date().toISOString(),
              pathways: pathwaysResult.pathways,
            });
            logger.info(
              { sessionId: session.id, pathwayCount: pathwaysResult.pathways.length },
              'Escalation pathways computed and saved',
            );
          } catch (pathwaysErr) {
            logger.warn(
              { error: pathwaysErr, sessionId: session.id },
              'Failed to compute or save escalation pathways, continuing',
            );
          }
        }
      } catch (factorsErr) {
        logger.warn(
          { error: factorsErr, sessionId: session.id },
          'Failed to load or compute escalation factors, continuing',
        );
      }
    }
```

4. Save the file. After revert, behavior is again: one row per session for factors/pathways, computed on first tick and reused thereafter.
