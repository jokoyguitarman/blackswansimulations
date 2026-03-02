# Implementation Roadmap

Single reference for the sequence of work to implement the **environmental state layer**, **hybrid inject engine**, and **condition-based inject firing** (with eligibility time). For design and diagrams, see [ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md](ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md). For phased development and Type A/B rules, see [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md).

---

## Overview

The build follows **game specifics first**, then **load into database** (including locations and conditions), then **map as visual aid**. Core game rules (generic) are in [GAME_RULES.md](GAME_RULES.md); scenario-specific teams, situations, and locations are in [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md). The **database structure** is the same for all scenarios; only the data (teams, locations, conditions, injects) changes per scenario. See [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md) for implementation order.

Goals:

- **Environmental state** — Pre-authored routes/areas (and optional crowd, terrain) stored per scenario in the DB; a scenario can have multiple variants. At session start the service loads one variant (e.g. at random) into session state. Unmanaged state affects evacuation/vehicle decisions via a prerequisite gate (degraded outcome, robustness penalty). Optional per-scenario time-based simulation may run each 5 min.
- **Condition-based injects** — Injects fire when **conditions to appear** (perfect storm) are met and **conditions to cancel** are not met. **Eligibility time** gates when we start checking (avoids all injects firing in the first 5 minutes).
- **Hybrid engine** — Dynamic AI consequences plus a "lying-in-wait" pool of pre-authored injects evaluated each 5-minute cycle. Optional priority queue and cooldown.
- **Adversary** — Optional: keep as a second gate for entity-specific injects, or retire for condition-driven injects.

---

## General steps (no deep specifics)

Work in this order. Each step can be expanded in a dedicated doc under [docs/roadmap/](roadmap/).

| Step | Name                                                                          | Summary                                                                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Game specifics and scenario locations                                         | Decide and document location types (blast site, exits, triage sites, cordon, pathways, parking), good/bad per location, environmental state model; feeds into schema and Step 7.                                                                      |
| 1    | [Database and schema](roadmap/step-01-database.md)                            | Add or extend tables/columns for inject conditions (appear/cancel), eligibility time, environmental state storage, **scenario locations (map pins)** with per-location conditions, and any supporting indexes or constraints.                         |
| 2    | [Environmental state service](roadmap/step-02-environmental-state-service.md) | Load a pre-authored environmental seed (one of multiple variants per scenario, e.g. chosen at random) from the DB at session start and write to session state; optionally run time-based simulation each 5 min if the scenario enables it.            |
| 3    | [Condition evaluator service](roadmap/step-03-condition-evaluator.md)         | New service to evaluate conditions_to_appear and conditions_to_cancel against current game state; used by the inject engine.                                                                                                                          |
| 4    | [Inject engine (scheduler) changes](roadmap/step-04-inject-engine.md)         | Replace or bypass time-as-trigger with eligibility time + condition-based firing and cancellation; integrate condition evaluator; optional priority queue and cooldown.                                                                               |
| 5    | [Environmental prerequisite gate](roadmap/step-05-environmental-gate.md)      | In decision execution flow, add environmental prerequisite check (corridor traffic) and **location-condition gate** (decisions that reference a pin are checked against that location's conditions; bad site without prior clearance yields penalty). |
| 6    | [Map and frontend](roadmap/step-06-map-and-frontend.md)                       | Show environmental state (e.g. traffic) and **map pins** from DB (blast site, exits, triage sites, cordon, pathways, parking) with **labels only**; consume `state.updated` for `environmental_state`; condition details via insider or on request.   |
| 7    | [Scenario and inject data model](roadmap/step-07-scenario-inject-data.md)     | Define or migrate scenario injects to use conditions (appear/cancel) and eligibility time; document format for condition manifests and cancel conditions.                                                                                             |
| 8    | [Cleanup and deprecation](roadmap/step-08-cleanup.md)                         | Identify legacy time-trigger and adversary paths; decide what to remove, what to keep for backward compatibility, and document the decision.                                                                                                          |

---

## Per-step docs

- [roadmap/README.md](roadmap/README.md) — Folder structure and how to add specifics per step.
- [roadmap/step-01-database.md](roadmap/step-01-database.md)
- [roadmap/step-02-environmental-state-service.md](roadmap/step-02-environmental-state-service.md)
- [roadmap/step-03-condition-evaluator.md](roadmap/step-03-condition-evaluator.md)
- [roadmap/step-04-inject-engine.md](roadmap/step-04-inject-engine.md)
- [roadmap/step-05-environmental-gate.md](roadmap/step-05-environmental-gate.md)
- [roadmap/step-06-map-and-frontend.md](roadmap/step-06-map-and-frontend.md)
- [roadmap/step-07-scenario-inject-data.md](roadmap/step-07-scenario-inject-data.md)
- [roadmap/step-08-cleanup.md](roadmap/step-08-cleanup.md)
- [CONDITION_INJECT_DATA_MODEL.md](CONDITION_INJECT_DATA_MODEL.md) — Condition manifest format and condition keys (Step 7 author reference).
- [INJECT_PATHS_AND_POLICY.md](INJECT_PATHS_AND_POLICY.md) — Inject paths and cleanup policy (Step 8).

---

## How to use

- **Agent or developer:** Build in the order of the steps above. Use the master list here for sequence; use the per-step docs for file-level and acceptance-criteria specifics (fill those in when implementing).
- **Review:** Use this file as the single entry point for "what to build and in what order."
