# Decision Checkpoints (Three-Checkpoint Model)

This document describes the three-checkpoint decision evaluation system: how decisions are checked for being information-grounded, environmentally consistent, and escalation-aware. Use it when tuning gates, environmental consistency, and robustness scoring.

---

## 1. Overview and order

Decisions are evaluated in three checkpoints **in order**:

1. **Checkpoint 1 – Information-grounded:** Is the decision grounded in enough environmental information (plan-based, not guessing)? If not → punish and push toward negative outcome tree.
2. **Checkpoint 2 – Environmental consistency:** Do the decision’s details match the current state of the environment? If not → branch by severity (low/medium/high) and error type → inject + penalty + robustness cap.
3. **Checkpoint 3 – Escalation/robustness:** How well does the decision mitigate or worsen escalation? Robustness score (1–10) and pathway outcome (low/medium/high band). When Checkpoint 2 marked a decision as environmentally compromised, robustness is **capped** so the pathway outcome reflects the failure.

**Execution flow:** Execute decision → Checkpoint 1 (in execute handler) → Checkpoint 2 (in execute handler) → objective tracking (using skip list from both) → later, in the 5-minute cycle, Checkpoint 3 (with robustness cap from Checkpoint 2).

---

## 2. Checkpoint 1 – Information-grounded (gate / vague)

**Purpose:** Ensure the decision is based on enough environmental/situational information (exits, ground zero, flow, etc.), not generic or guessed.

**Where it runs:** `server/routes/decisions.ts` on execute; uses `server/services/gateEvaluationService.ts`.

**Logic:**

- For the session’s scenario, load **not-met gates** (`session_gate_progress` status `not_met` + `scenario_gates`).
- For each gate, check whether the **author’s team** matches the gate’s `condition.team` and the decision’s type matches `condition.decision_types` (if set).
- **Content check:** The decision **description** must contain enough of the gate’s `content_hints` (at least `min_hints`). If not, the decision is **vague** for that gate.

**When vague:**

- Add the gate’s `objective_id` to `skipPositiveForObjectiveIds` so `trackDecisionImpactOnObjectives` does **not** give positive progress for that objective.
- Fire the gate’s **vague inject** (`if_vague_decision_inject_id`) at most once per gate per session (track in `session_events` with `event_type = 'gate_vague_inject_fired'`).
- The 5-minute scheduler can bias toward **low/medium** pathway outcomes when there are not-met gates (`effectiveRobustnessBand`), so the scenario moves down the **negative outcome tree**.

**No code change required** for Checkpoint 1; it is already implemented. This doc frames it explicitly as “information-grounded”.

---

## 3. Checkpoint 2 – Environmental consistency

**Purpose:** Detect when a decision’s **details** contradict the scenario’s environment (e.g. assembly for 100 in a 50-capacity area, non-existent exit, unrealistic flow). Respond with an inject, objective penalty, and a robustness cap so Checkpoint 3 cannot treat the decision as strong.

**Where it runs:** `server/routes/decisions.ts` after Checkpoint 1; uses `server/services/environmentalConsistencyService.ts`.

**Data:** Scenario’s `insider_knowledge` (same as the Insider), especially `layout_ground_truth` (evacuee_count, exits, zones/areas with capacities). Stored on the decision as `decisions.environmental_consistency` (JSONB).

**Severity bands (Option B):**

| Severity   | Meaning                                                  | Inject                                | Penalty                                                              | Robustness cap |
| ---------- | -------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- | -------------- |
| **Low**    | Minor mismatch (e.g. 60 in 50-capacity area)             | Soft inject, suggest revision         | Minimal or none                                                      | None           |
| **Medium** | Clear mismatch (e.g. 100 in 50, wrong exit name)         | Clear “environmental mismatch” inject | Skip positive for author’s objective; optional penalty (e.g. 10 pts) | Cap at 6       |
| **High**   | Dangerous/impossible (e.g. 200 in 50, non-existent exit) | Strong inject                         | Skip positive + penalty (e.g. 15 pts)                                | Cap at 3       |

**Error types (Option C):** Used for inject wording and which objective to penalise:

- `capacity` → assembly/triage overflow; typically evacuation or triage objective.
- `location` / `exit` → wrong place or route; typically evacuation/coordination.
- `flow` → unrealistic flow/timing; typically evacuation.
- `other` → generic.

**Detail level (Option D):** Checkpoint 2 runs **even when** Checkpoint 1 marked the decision as vague. If the decision is both vague and environmentally inconsistent, the inject can note that the few details provided also do not match site conditions.

**Implementation:**

- **Evaluate:** `evaluateDecisionAgainstEnvironment(sessionId, decision, openAiApiKey)` returns `{ consistent, severity?, error_type?, reason? }`. Uses one LLM call with decision + ground-truth summary; on failure or missing ground truth returns `consistent: true`.
- **Store:** `UPDATE decisions SET environmental_consistency = result WHERE id = decision.id`.
- **If inconsistent:**
  - Create and publish an **environmental mismatch inject** (dynamic `scenario_injects` row + `publishInjectToSession`). Target author team(s); title/content from `reason` and `error_type`.
  - Resolve **objective to penalise:** author’s team(s) from `session_teams`; for C2E, `scenario_objectives.objective_id` often matches team name (evacuation, triage, media). Add those `objective_id`s to `skipPositiveForObjectiveIds`.
  - For **medium/high**, call `addObjectivePenalty(sessionId, objectiveId, reason, points)` (e.g. 10 for medium, 15 for high).

**Edge cases:**

- No `insider_knowledge` / no `layout_ground_truth` → return `consistent: true`, no inject/penalty.
- AI evaluation fails or times out → return `consistent: true`, log, do not block execute.
- Author in multiple teams → use all author teams for inject `target_teams` and for resolving objective_ids to skip/penalise.
- No matching `scenario_objectives` for team name → still fire inject and store `environmental_consistency`; robustness cap still applies in Checkpoint 3.

---

## 4. Checkpoint 3 – Escalation / robustness

**Purpose:** Score each decision (1–10) on how well it mitigates or worsens escalation (vs escalation factors and pathways). Map scores to a **robustness band** (low/medium/high) and select the **pathway outcome** inject (escalation vs de-escalation).

**Where it runs:** `server/services/aiInjectSchedulerService.ts` every 5 minutes; uses `server/services/aiService.ts` `computeInterTeamImpactMatrix`.

**Existing behaviour:**

- Decisions in the window are sent to `computeInterTeamImpactMatrix` with scenario description, escalation factors, and pathways.
- The model returns an **inter-team impact matrix** and **robustness per decision_id** (1–10). Higher = more mitigating.
- Robustness scores are aggregated into a band (e.g. mean or team-specific) and passed to `effectiveRobustnessBand` (which can downgrade “high” to “medium” when there are not-met gates).
- The band selects the **pathway outcome** (low/medium/high) and thus the next inject (escalation vs de-escalation tree).

**Addition – robustness cap from Checkpoint 2:**

- After `computeInterTeamImpactMatrix` returns, load `environmental_consistency` for each decision ID in the window.
- For each decision in `robustnessByDecisionId`:
  - If `environmental_consistency.severity === 'high'` → set `robustnessByDecisionId[id] = min(currentScore, 3)`.
  - If `environmental_consistency.severity === 'medium'` → set `robustnessByDecisionId[id] = min(currentScore, 6)`.
  - Low or consistent → no cap.
- Use this **capped** map for `computeRobustnessBand` / `computeRobustnessBandForTeams` and store it in `session_impact_matrix.robustness_by_decision`.

**Effect:** Environmentally high/medium severity decisions cannot push the window into a high robustness band; they bias the pathway outcome toward low/medium (negative/mixed tree).

---

## 5. Summary table

| Checkpoint | Question                                      | When it runs         | If fail / inconsistent                                         | Robustness                             |
| ---------- | --------------------------------------------- | -------------------- | -------------------------------------------------------------- | -------------------------------------- |
| **1**      | Grounded in enough environmental information? | Execute (gate/vague) | Vague inject, skip positive for gate objective, negative path  | Band can be biased by not-met gates    |
| **2**      | Details consistent with environment?          | Execute (after CP1)  | Inject + skip positive for author objective + optional penalty | Cap: high→3, medium→6 (applied in CP3) |
| **3**      | Good for escalation?                          | 5-min cycle          | Low/medium band → escalation/mixed outcome                     | Uses capped robustness from CP2        |

---

## 6. Files reference

- **Checkpoint 1:** `server/routes/decisions.ts` (execute), `server/services/gateEvaluationService.ts`
- **Checkpoint 2:** `server/routes/decisions.ts` (execute), `server/services/environmentalConsistencyService.ts`, migration `060_decision_environmental_consistency.sql`
- **Checkpoint 3:** `server/services/aiInjectSchedulerService.ts`, `server/services/aiService.ts` (`computeInterTeamImpactMatrix`)

---

**Document version:** 1.0  
**Related:** `docs/C2E_INSIDER_INTEL_REFERENCE.md` (ground truth for Insider and for Checkpoint 2).
