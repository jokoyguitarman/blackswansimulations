# Session state shape (current_state)

`sessions.current_state` is JSONB. Services read and write it; the schema does not enforce a fixed structure. This document describes the **intended shapes** for the condition-based inject engine and environmental layer.

## Existing keys (unchanged)

- `evacuation_zones`, `resource_allocations`, `public_sentiment`, `active_incidents`, etc. — see `server/services/scenarioStateService.ts` and related code.

## Environmental state (Step 2+)

This data is populated at session start by the environmental state service, which loads a pre-authored seed from the database (one of several variants per scenario, e.g. chosen at random). The service does not generate env content from scratch.

When the environmental state service is implemented, it will read/write:

- **`environmental_state`** (optional):
  - **`routes`**: array of `{ route_id, label, travel_time_minutes?, problem?, active, managed }`. `problem` null = positive factor; `active` true only when a problem is present; `managed` true = OK to use.
  - **`areas`** (optional): array of `{ area_id, label, problem?, active, managed }` for non-route areas.

## Location state (optional)

If scenario locations can change during a session (e.g. “cleared” after player action):

- **`location_state`** (optional): object keyed by scenario location id, e.g. `{ [locationId]: { managed, active } }`.

The environmental prerequisite service (Step 5) reads `location_state` to decide if a referenced location is "managed". No server code currently writes `location_state`; until something (e.g. decision execution or frontend) sets `location_state[locationId].managed === true`, the location-condition gate will treat all bad locations as not managed.

## Reference

- Design: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md), [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
- Migration: `migrations/062_inject_conditions_scenario_locations.sql`
