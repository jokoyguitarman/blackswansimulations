# Inject Engine Development Plan

Phased development plan for the condition-based inject engine, environmental state layer, and Type A/B inject handling. For the ordered step list, see [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md). For design and diagrams, see [ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md](ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md).

---

## Goals

- **Condition-based injects** — Injects fire when conditions to appear are met and conditions to cancel are not; time is only an eligibility gate, not a trigger.
- **Type A (opportunistic)** — External actors (journalist, bystander, online actors) exploit an opening; use **time-bound** eligibility (`eligible_after_minutes`).
- **Type B (direct consequence)** — Outcome follows from team decision + environment (e.g. wrong exit capacity, no traffic coordination); can fire **anytime after evaluation** (minimal or no eligibility delay).
- **Environmental prerequisite gate** — Evacuation/vehicle decisions checked against environmental state; unmanaged state yields degraded outcome and robustness penalty.
- **No double-hit** — Pathway outcome and pre-authored inject for the same consequence (e.g. congestion on Exit B) must not both fire; use cancel conditions or a single source.

---

## How to use this plan

- **Work from the top:** Do Step 1, then Step 2, then Step 3, in the order of the [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md). Do not skip steps.
- **Work by phase:** Complete Phase 0, then Phase 1, then Phase 2, then Phase 3, then Phase 4. Do not skip phases.

---

## Implementation order

Tackle the build in this order:

- **Step A — Game specifics:** Document **core game rules** in general terms ([GAME_RULES.md](GAME_RULES.md)) and **scenario-specific** teams, situations, location types, and environmental conditions ([GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)). The same DB structure is used for all scenarios; only data changes per scenario. No implementation yet.
- **Step B — Load into database:** Migrations and seeds so that all conditions, statuses, **environmental state** (routes/areas with positive/negative factors), and **scenario locations (map pins)** with per-location conditions are stored. Single source of truth for the engine and the insider.
- **Step C — Map as visual aid:** Map view shows pins from the DB; pins display **labels only** (e.g. "Potential triage tent site", "Exit B"). Condition details live in the DB and are exposed via the insider (and optionally on request). Decision evaluation checks location conditions when a decision references a pin.

Map to existing phases: Step A is design (feeds into Step 7 scenario data). Step B is Phase 0 (schema + seeds) extended with locations. Step C is Phase 3 map (Step 6) plus Phase 2 gate (Step 5) extended to locations.

---

## Environmental state model

- **Negative factors** (congestion, crowded area, blocked route): Problem exists until the player acts. Represent with a problem type (e.g. `problem: "congestion"`) and **active: true**, **managed: false**. When the player addresses it (e.g. coordinate traffic), set **managed: true** (and optionally reduce travel time or clear the problem).
- **Positive factors** (non-congested street, less crowded area): Already good. Represent as **managed: true** by default; no "active" problem. Gives a dynamic map: some routes/areas are usable from the start, others become usable after player action.
- **managed** = "this route/area is in an acceptable or good state for use" (either favorable by default or player fixed it). **active** = used only for negative factors: "this problem is currently present."
- `environmental_state` (e.g. under `session.current_state`) holds routes/areas with fields such as: `route_id` / `area_id`, `label`, `travel_time_minutes` (for routes), `problem` (null for positive), `active` (true only when problem present), `managed` (true = OK to use).

---

## Map pins and location conditions

- **Pins on the map:** Blast site, available exits, potential triage tent sites, cordon, pathways, parking. Each pin shows only a **label** (e.g. "Potential triage tent site", "Exit B") — no condition details on the map.
- **Database:** Each pinned location has an id, type, coordinates, and **conditions** (e.g. suitability score, `construction_nearby`, `terrain`, `crowd_density`). Stored in a **scenario-level** table (e.g. `scenario_locations` or `scenario_map_pins`); session state can reference or copy these and track `managed` / `active` if locations can change during play.
- **Insider:** When players ask in chat for details about a pin or location, the insider (AI) uses the same DB (or session state) to answer (e.g. "Site A has ongoing construction; Site B is clear"). Map stays a visual aid; information is in the system and obtainable by asking.
- **Punishment:** When a decision references a location (e.g. "establish triage at Site A"), the engine checks that location's conditions. If the location is bad (low suitability, construction nearby, bad terrain) and the player has not "cleared" it (e.g. by asking the insider or a prior decision), apply the same kind of penalty as for unmanaged environmental factors: robustness cap/penalty, degraded outcome inject, optional objective penalty. This is the **location-condition gate** (extension of the environmental prerequisite gate).

---

## Game phases (when things run)

These are the phases of the game lifecycle. Development work in each phase of this plan touches one or more of these.

| Game phase                               | When it runs                                                          | What happens                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session start**                        | Scenario loads; session set to `in_progress`; trainer starts session. | Initial state written; first state broadcast.                                                                                                 |
| **Session in progress — 5-minute cycle** | Every 5 minutes while session is `in_progress`.                       | Inject scheduler runs; condition evaluator runs; environmental state simulated; impact matrix / pathway outcomes computed; injects published. |
| **Decision execution**                   | When a player proposes a decision and it is approved and executed.    | State update; gate evaluation; environmental consistency check; robustness; objectives; optional environmental prerequisite gate.             |
| **Map / frontend**                       | Continuously when the session view is open.                           | Map and UI consume session state and events (e.g. `state.updated`, injects).                                                                  |

---

## Type A vs Type B summary

| Type                       | Meaning                                                             | When to fire                                                                  |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **A — Opportunistic**      | External actor exploits an opening (no cordon, no statement, etc.). | Time-bound: `eligible_after_minutes` required; perfect storm + elapsed time.  |
| **B — Direct consequence** | Team decision (or inaction) + environment/layout → outcome.         | Anytime after evaluation: conditions met → can fire next cycle or as pathway. |
| **Scenario trigger**       | Session opener (e.g. Initial Explosion).                            | First cycle or session start only.                                            |

C2E injects are categorised in the design discussions; when migrating scenario data (Step 7), set `inject_category` and `eligible_after_minutes` per that table.

**C2E second device (second bomb):** The scenario has a second-device storyline: teams can find and defuse it (gate `second_device_defused` → positive inject), or it can detonate. Detonation is condition-driven at T+20: either "area populated" (bad — additional casualties) or "area cleared" (acceptable — no additional casualties). Both detonation injects use `conditions_to_cancel: ["gate_met:second_device_defused"]`. Session state `second_device_zone_cleared` / `area_cleared` selects which detonation inject fires. See [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md#second-device-second-bomb-outcomes).

---

## Phase 0 — Foundation

No new inject behaviour yet; schema and env state only.

| Step                                | What                                                                                                                                                                                                                                                                                  | Outcome                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **1 — Database and schema**         | Add columns/tables: inject `conditions_to_appear`, `conditions_to_cancel`, `conditions_appear_threshold`, `eligible_after_minutes`, `inject_category`; session state support for `environmental_state`; **scenario locations (map pins)** table with per-location conditions.         | Schema supports condition-driven injects, env state, and map pins with conditions. |
| **2 — Environmental state service** | Load pre-authored environmental seed from DB (multiple variants per scenario supported). At session start, select one variant (e.g. at random) and write to `session.current_state.environmental_state`. Optionally run time-based simulation each 5‑min tick if scenario enables it. | Sessions have env state from a chosen pre-authored variant.                        |

**Game phases affected:** Session start (for env state load).

**Changes to make:**

- Add table for environmental seed variants per scenario (e.g. `scenario_environmental_seeds`: scenario_id, variant_label, seed_data JSONB). New `server/services/environmentalStateService.ts`: at session start load variants for scenario, select one (e.g. random), merge into `current_state.environmental_state`, persist and optionally broadcast. Session start handler calls env service when session goes `in_progress`. Optionally: 5‑min scheduler calls env simulator step when scenario has simulation enabled.

---

## Phase 1 — Condition evaluation and inject eligibility

| Step                        | What                                                                                                                                                                                                                                                                                                                                                                                | Outcome                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **3 — Condition evaluator** | Evaluate `conditions_to_appear` (N-of-M) and `conditions_to_cancel` (any met → cancel). Support condition kinds: objective progress, decision made/not made, prior inject fired, env state threshold.                                                                                                                                                                               | Given session state + inject config, returns appear met / cancel met / not eligible. |
| **4 — Inject engine**       | Eligibility: only consider inject if `elapsed_minutes >= eligible_after_minutes`. Type A: use scenario `eligible_after_minutes`. Type B: use 0 (or minimal). When eligible: evaluate appear + cancel; fire once if appear met and cancel not met. Scenario trigger: fire once at start/first cycle. Integrate condition evaluator; optional priority queue and cooldown for Type A. | Injects fire only when conditions and eligibility are satisfied.                     |

**Game phases affected:** 5‑minute cycle (inject evaluation and firing).

**Changes to make:**

- New `server/services/conditionCompositeEvaluator.ts` (or similar): evaluate appear/cancel conditions against session state.
- `server/services/injectSchedulerService.ts` and/or `server/services/aiInjectSchedulerService.ts`: use eligibility time + condition evaluator; fire/cancel by Type A/B; scenario trigger at start/first cycle.

---

## Phase 2 — Environmental gate and pathway vs authored

| Step                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                      | Outcome                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **5 — Environmental prerequisite gate** | In decision execution (evacuation/vehicle deployment): check environmental state for corridor; if unmanaged → degraded outcome, robustness penalty, optional objective penalty. **Location-condition gate:** For any decision that references a scenario location (e.g. triage site, evacuation center, route), evaluate that location's conditions; if bad (low suitability or negative factors) and not managed/cleared → same penalty. | Evac/vehicle and location-based decisions penalised when env or location not managed. |
| **Pathway vs authored**                 | For Type B consequences that can also be produced by AI pathway (e.g. "congestion on Exit B"): either no pre-authored inject for that consequence, or pre-authored inject has cancel condition "pathway outcome about this consequence already fired this session." Implement via condition type (e.g. `prior_pathway_outcome_fired`) or consequence keys when publishing pathway injects.                                                | No double-hit: pathway or authored inject, not both.                                  |

**Game phases affected:** Decision execution (environmental gate); 5‑minute cycle (pathway vs authored dedup).

**Changes to make:**

- `server/routes/decisions.ts` (execute flow): after approval, before or after existing gates, call environmental prerequisite check; apply degraded outcome and robustness penalty. For decisions that reference a scenario location (e.g. triage site, evac center), call location-condition check; if location is bad and not cleared, apply same penalty.
- Condition evaluator or inject config: add cancel condition or consequence key so “pathway already fired” cancels the matching authored inject (pathway vs authored dedup).

---

## Phase 3 — Scenario data and map

| Step                             | What                                                                                                                                                                                                                                                            | Outcome                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **6 — Map and frontend**         | Map shows environmental state (e.g. traffic) from `state.updated`; **map pins** from DB (blast site, exits, triage sites, cordon, pathways, parking) with **labels only**; optional legend. No condition details on the map; details via insider or on request. | Players see traffic and pins as visual aid.                         |
| **7 — Scenario and inject data** | Per inject: set `inject_category`, `eligible_after_minutes`, `conditions_to_appear`, `conditions_to_cancel`, threshold. Document condition manifest and cancel condition format for authors.                                                                    | All injects migrated; authors can add new condition-driven injects. |

**Game phases affected:** Map / frontend; scenario data (all phases, via inject config).

**Changes to make:**

- `frontend/.../MapView.tsx` (or equivalent): read `environmental_state` from `state.updated`, draw traffic layer (and optional legend). Load scenario locations (pins) from API/DB; render pins with **labels only** (e.g. "Potential triage tent site", "Exit B"). Optional "request details" flow that can drive insider answers.
- Scenario seed or migrations or admin UI: set `inject_category`, `eligible_after_minutes`, `conditions_to_appear`, `conditions_to_cancel` per inject; document condition manifest and cancel condition format.

---

## Phase 4 — Cleanup and policy

| Step                            | What                                                                                                                                                | Outcome                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **8 — Cleanup and deprecation** | Decide: keep or remove time-triggered path and adversary cancel for condition-driven injects. Document; remove or guard legacy paths; update tests. | Single, clear inject model. |

**Game phases affected:** 5‑minute cycle (and any path that still uses time-trigger or adversary).

**Changes to make:**

- Remove or guard time-triggered inject path and adversary cancel where condition-driven injects are used; document policy; update tests.

---

## Dependencies

```
Phase 0:  Step 1 (DB) → Step 2 (env state service)
Phase 1:  Step 3 (condition evaluator) → Step 4 (inject engine)
Phase 2:  Step 5 (env gate) + pathway/authored dedup (in Step 3/4 or small sub-step)
Phase 3:  Step 6 (map) and Step 7 (scenario data) — can run in parallel after Phase 1
Phase 4:  Step 8 (cleanup) — after Phases 1–3
```

- Step 4 depends on Step 1 and 3.
- Step 5 depends on Step 1 and 2.
- Step 6 depends on Step 2 (and 1).
- Step 7 depends on Step 3 and 4 (condition format and engine behaviour).
- Step 8 depends on all of the above.

---

## Reference

- Step-by-step list: [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)
- Per-step specifics: [roadmap/](roadmap/)
- Design and diagrams: [ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md](ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md)
- Game specifics and locations: [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
