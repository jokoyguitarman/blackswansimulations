# Session state shape (current_state)

`sessions.current_state` is JSONB. Services read and write it; the schema does not enforce a fixed structure. This document describes the **intended shapes** for the condition-based inject engine and environmental layer.

## Existing keys (unchanged)

- `evacuation_zones`, `resource_allocations`, `public_sentiment`, `active_incidents`, etc. — see `server/services/scenarioStateService.ts` and related code.

## Environmental state (Step 2+)

This data is populated at session start by the environmental state service, which loads a pre-authored seed from the database (one of several variants per scenario, e.g. chosen at random). The service does not generate env content from scratch.

When the environmental state service is implemented, it will read/write:

- **`environmental_state`** (optional):
  - **`routes`**: array of `{ route_id, label, travel_time_minutes?, problem?, active, managed }`. `problem` null = positive factor; `active` true only when a problem is present; `managed` true = OK to use.
  - **`areas`** (optional): array of facility entries (e.g. hospitals, police) with `area_id`, `label`, `type?` (`'hospital'` | `'police'`), `at_capacity?`, `problem?`, `active?`, `managed?`, `aliases?` (strings for matching decision text). When a decision references a facility by label or alias and that area has `at_capacity: true` (or `problem` set and not `managed`), the environmental prerequisite gate fails and the plan is hindered (same flow as unmanaged traffic).

## Location state (optional)

If scenario locations can change during a session (e.g. “cleared” after player action):

- **`location_state`** (optional): object keyed by scenario location id, e.g. `{ [locationId]: { managed, active } }`.

The environmental prerequisite service (Step 5) reads `location_state` to decide if a referenced location is "managed". No server code currently writes `location_state`; until something (e.g. decision execution or frontend) sets `location_state[locationId].managed === true`, the location-condition gate will treat all bad locations as not managed.

## Team state (C2E and future scenarios)

Per-team state used by condition-driven injects, decision execution updates, and scoring. These three blocks live at the top level of `current_state` (e.g. `current_state.evacuation_state`). Written at session start by the environmental state service (from scenario seed or defaults) and may be updated later by decision execution or inject-publish effects.

- **`evacuation_state`** (optional): `{ exits_congested?: string[]; flow_control_decided?: boolean; coordination_with_triage?: boolean; evacuated_count?: number; total_evacuees?: number }`. Counters: evacuated_count / total_evacuees for team and trainer display; updated by the inject scheduler when flow_control_decided. **exits_congested**: when an inject is published with `state_effect.evacuation_state.exits_congested`, the effect's array entries are **appended** to the current list and deduped (see `injectPublishEffectsService`); the scheduler halves the base evac rate when `exits_congested.length > 0`. **Robustness modulation:** the scheduler reads the latest `session_impact_matrix.robustness_by_team` (Evacuation); if Evacuation robustness ≤ 7 the rate is multiplied by 0.25, if ≥ 8 by 1.25, else 1.0 (applied to the current rate after congestion).
- **`triage_state`** (optional): `{ supply_level?, surge_active?, critical_pending?, deaths_on_site?, supply_request_made?, prioritisation_decided?, handed_over_to_hospital?, patients_being_treated?, patients_waiting?, casualties?, initial_patients_at_site? }`. Counters are **rate- and robustness-driven** in the inject scheduler (no longer keyword-bumped from decisions). Pool/cap: `initial_patients_at_site` from seed or derived from `total_evacuees * 0.25`. Triage team robustness (from `robustness_by_team.Triage`) drives throughput and death/transport splits (low robustness → more deaths, less treated/transported; high → fewer deaths, more treated/transported). Injects' `state_effect` merges (e.g. patients_waiting, deaths_on_site) still apply. Displayed in [TEAM METRICS] triage block.
- **`media_state`** (optional): `{ first_statement_issued?, statement_issued_at_minute?, misinformation_addressed?, journalist_arrived?, public_sentiment?, statements_issued?, misinformation_addressed_count?, sentiment_label?, sentiment_reason? }`. Counters for display; statements_issued and misinformation_addressed_count set by decision execution. **public_sentiment** (1–10), **sentiment_label**, and **sentiment_reason** are set by the AI-backed `computePublicSentiment` step in the AI inject scheduler (every 5 min), based on full game state and media actions.

Implementation: [server/services/environmentalStateService.ts](server/services/environmentalStateService.ts) (Phase 1 team state). **During play:** `journalist_arrived` and `surge_active` can be set by time-based injects that have a `state_effect` (e.g. "Journalist Arrives" at T+12 sets `media_state.journalist_arrived`, "Patient surge at triage site" at T+8 sets `triage_state.surge_active`). See [CONDITION_INJECT_DATA_MODEL.md](CONDITION_INJECT_DATA_MODEL.md) Phase 4 and `migrations/077_c2e_condition_driven_injects_and_state_effects.sql`.

## session_impact_matrix (robustness by team)

Each row stores the AI-computed impact matrix and per-decision robustness for a 5-minute window. **robustness_by_team** (JSONB): per-team average robustness (1–10) from decisions in that window, e.g. `{ "Evacuation": 7, "Triage": 6, "Media": 8 }`. Used by the inject scheduler for evac rate modulation and triage rate modulation (see above).

## Reference

- Design: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md), [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
- Migration: `migrations/062_inject_conditions_scenario_locations.sql`, `migrations/085_robustness_by_team.sql`
