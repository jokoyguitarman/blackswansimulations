# Step 2 — Environmental state service

**Goal:** At session start, load environmental state from the database (pre-authored seed). Support multiple variants per scenario; select one variant (e.g. at random) and write it into `session.current_state.environmental_state`. Optionally, run a time-based simulation step each 5 minutes if the scenario config enables it. No generation of env content from scratch.

---

## Scope

- **Schema:** Table (or structure) for storing one or more environmental seed variants per scenario (e.g. `scenario_environmental_seeds`: `scenario_id`, `variant_label`, `seed_data` JSONB). See migration 063.
- **Service:** Given a session (and its `scenario_id`), load variants for that scenario, select one (random or by rule), merge `seed_data` into `current_state.environmental_state`, write back to `sessions.current_state`, optionally broadcast `state.updated`.
- **Session start:** When session goes `in_progress`, call this service (e.g. from [server/routes/sessions.ts](server/routes/sessions.ts) PATCH handler).
- **Optional:** From the 5‑minute scheduler, if the scenario has simulation enabled, run one simulation step (e.g. worsen/ease some routes/areas) and update `current_state` again.

---

## Files to create or modify

- **migrations/063_scenario_environmental_seeds.sql** — Table `scenario_environmental_seeds` (scenario_id, variant_label, seed_data JSONB), indexes, RLS.
- **server/services/environmentalStateService.ts** — `loadAndApplyEnvironmentalState(sessionId)`: load variants, pick one (e.g. random), merge into current_state, persist, optionally broadcast.
- **server/routes/sessions.ts** — When PATCH sets `status === 'in_progress'` and session is just starting, after gate progress init, call `loadAndApplyEnvironmentalState(sessionId)`.
- Optionally: 5‑min scheduler invokes env simulation step when scenario enables it.

---

## Key structures or contracts

- **scenario_environmental_seeds:** `scenario_id` (FK), `variant_label` (e.g. `"nicoll_congested"`), `seed_data` JSONB. Shape of `seed_data` matches [SESSION_STATE_SHAPE.md](../SESSION_STATE_SHAPE.md): `{ routes: [...], areas?: [...] }` with `route_id`/`area_id`, `label`, `travel_time_minutes?`, `problem?`, `active`, `managed`. Same structure for all scenarios; data varies per scenario/variant.
- **Variant selection:** At session start, select one row for the scenario (e.g. `ORDER BY RANDOM() LIMIT 1` or weighted choice). Optionally store chosen `variant_label` in session (e.g. in `current_state.environmental_variant`) for AAR/debug.
- **Service:** `loadAndApplyEnvironmentalState(sessionId: string): Promise<void>`.

---

## Acceptance criteria

- [ ] Multiple variants per scenario can be stored in the DB (`scenario_environmental_seeds` or equivalent).
- [ ] At session start, one variant is selected (e.g. random) and written to `sessions.current_state.environmental_state`.
- [ ] No env content is generated from scratch; all content comes from DB seed.
- [ ] Optional simulation (if implemented) runs only when configured for the scenario.

---

## Depends on

- Step 1 (Database and schema) — session state shape, scenario_locations.
- Migration 063 (scenario_environmental_seeds) — can be part of this step.
