# Step 1 — Database and schema

**Goal:** Add or extend tables/columns for inject conditions (appear/cancel), eligibility time, environmental state storage, and any supporting indexes or constraints.

---

## Scope

Add or extend tables/columns for: inject conditions (appear/cancel), eligibility time, environmental state storage; **scenario locations (map pins)** with per-location conditions; optional session-level location state. Step 2 adds **scenario_environmental_seeds** (or equivalent) for pre-authored env variants per scenario. Supporting indexes or constraints as needed.

---

## Files to create or modify

- **migrations/062_inject_conditions_scenario_locations.sql** — Adds `conditions_to_appear`, `conditions_to_cancel`, `eligible_after_minutes` to `scenario_injects`; creates `scenario_locations` with RLS; documents `current_state` shape in comments.
- **docs/SESSION_STATE_SHAPE.md** — Documents intended shape of `sessions.current_state` (environmental_state, location_state).

---

## Key structures or contracts

- **scenario_injects** (new columns): `conditions_to_appear` JSONB, `conditions_to_cancel` JSONB, `eligible_after_minutes` INTEGER (all nullable). See migration 062.
- **scenario_locations**: `id`, `scenario_id`, `location_type` (e.g. blast_site, exit, triage_site, cordon, pathway, parking), `label`, `coordinates` JSONB, `conditions` JSONB, `display_order`. Per-session location state (managed/active) can live in `current_state.location_state` — see [SESSION_STATE_SHAPE.md](../SESSION_STATE_SHAPE.md).
- **environmental_state** (under `session.current_state`): routes/areas with `route_id`/`area_id`, `label`, `travel_time_minutes` (for routes), `problem` (null for positive factors), `active` (true only when problem present), `managed` (true = OK to use). See [SESSION_STATE_SHAPE.md](../SESSION_STATE_SHAPE.md).

---

## Acceptance criteria

- [x] `scenario_injects` has nullable columns: `conditions_to_appear` (JSONB), `conditions_to_cancel` (JSONB), `eligible_after_minutes` (INTEGER).
- [x] Table `scenario_locations` exists with: `scenario_id`, `location_type`, `label`, `coordinates` (JSONB), `conditions` (JSONB), `display_order`; RLS enabled with trainer/admin policies.
- [x] Session state shape for `environmental_state` and optional `location_state` documented (migration comment + docs/SESSION_STATE_SHAPE.md).
- [x] Migration is reversible: new columns and table can be dropped in a down migration if needed (no down file added; same structure as other steps).

---

## Depends on

- None (first step).
