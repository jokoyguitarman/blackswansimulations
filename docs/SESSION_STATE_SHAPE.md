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

- **`evacuation_state`** (optional): `{ exits_congested?: string[]; flow_control_decided?: boolean; coordination_with_triage?: boolean }`. Used by condition-driven injects and later decision execution updates.
- **`triage_state`** (optional): `{ supply_level?: 'adequate' | 'low' | 'critical'; surge_active?: boolean; critical_pending?: number; deaths_on_site?: number; supply_request_made?: boolean; prioritisation_decided?: boolean }`.
- **`media_state`** (optional): `{ first_statement_issued?: boolean; statement_issued_at_minute?: number; misinformation_addressed?: boolean; journalist_arrived?: boolean; public_sentiment?: number }`.

Implementation: [server/services/environmentalStateService.ts](server/services/environmentalStateService.ts) (Phase 1 team state). **During play:** `journalist_arrived` and `surge_active` can be set by time-based injects that have a `state_effect` (e.g. "Journalist Arrives" at T+12 sets `media_state.journalist_arrived`, "Patient surge at triage site" at T+8 sets `triage_state.surge_active`). See [CONDITION_INJECT_DATA_MODEL.md](CONDITION_INJECT_DATA_MODEL.md) Phase 4 and `migrations/077_c2e_condition_driven_injects_and_state_effects.sql`.

## Reference

- Design: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md), [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
- Migration: `migrations/062_inject_conditions_scenario_locations.sql`
