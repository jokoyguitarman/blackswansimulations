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

- **`evacuation_state`** (optional): `{ exits_congested?: string[]; flow_control_decided?: boolean; marshals_deployed?: boolean; coordination_with_triage?: boolean; evacuated_count?: number; total_evacuees?: number; evac_rate_modifier?: number; crowd_compliance_score?: number }`. Counters use **delta-based accumulation** (each 30s tick adds `rate * tickDelta` to the running total, not `rate * totalElapsed`). Updated by the inject scheduler when flow_control_decided. **exits_congested**: appended and deduped from inject `state_effect`; halves rate when unmanaged. **marshals_deployed**: when true, multiplies rate by `marshal_boost_mult` (default 1.15×). **evac_rate_modifier**: inject-driven multiplier (default 1.0; e.g. crowd panic → 0.6). **crowd_compliance_score**: live-computed weighted average (0–1) of all active crowd pin behaviors. Weights: panicking=0.2, hostile=0.3, fleeing=0.35, anxious=0.5, curious=0.55, sheltering=0.6, calm=0.7, cooperative=0.85, compliant=1.0. Multiplied into exit flow rate alongside other modifiers. Crowds de-escalate when marshals are within 100m proximity; escalate when unmanaged. **Robustness modulation:** ≤4 → `robustness_low_mult`, ≥8 → `robustness_high_mult`, else 1.0.
- **`triage_state`** (optional): `{ total_patients?, triage_processed?, treatment_rate_modifier?, supply_level?, surge_active?, deaths_on_site?, supply_request_made?, prioritisation_decided?, handed_over_to_hospital?, patients_being_treated?, patients_waiting?, casualties? }`. `triage_processed` is a **time_rate counter** (base 8/min) that drives all derived counters via `rate_key`. `treatment_rate_modifier` (default 1.0) is an inject-driven multiplier (e.g. equipment failure → 0.5, extra ambulances → 1.3). Derived counters use **robustness-driven split fractions**: `split_fractions_low` (≤4), `split_fractions_high` (≥8), or `split_fractions` (mid). Low robustness → more deaths, less transport; high → fewer deaths, more transport. Additive state_effect keys (deaths_on_site, casualties, patients_waiting) are summed, not overwritten.
- **`media_state`** (optional): `{ public_sentiment?, media_protocol_score?, first_statement_issued?, spokesperson_designated?, victim_dignity_respected?, regular_updates_planned?, misinformation_addressed?, statements_issued?, misinformation_addressed_count?, unaddressed_misinformation_count?, sentiment_label?, sentiment_reason? }`. **public_sentiment** (1–10) is updated by: (1) deterministic `sentiment_nudge` from inject state_effect (immediate ±N shift), (2) AI-backed delta evaluation every 5 min (anchored to previous score, max ±2 per cycle), (3) misinformation decay (unaddressed misinfo drags sentiment down 0.5/count), (4) media robustness boost, (5) cross-team impact penalty. **media_protocol_score** (0–10) computed from protocol adherence flags (first statement, spokesperson, victim dignity, regular updates, misinfo addressed). **unaddressed_misinformation_count** incremented by misinfo inject state_effect, decremented when media team addresses it.

Implementation: [server/services/environmentalStateService.ts](server/services/environmentalStateService.ts) (Phase 1 team state). **During play:** `journalist_arrived` and `surge_active` can be set by time-based injects that have a `state_effect` (e.g. "Journalist Arrives" at T+12 sets `media_state.journalist_arrived`, "Patient surge at triage site" at T+8 sets `triage_state.surge_active`). See [CONDITION_INJECT_DATA_MODEL.md](CONDITION_INJECT_DATA_MODEL.md) Phase 4 and `migrations/077_c2e_condition_driven_injects_and_state_effects.sql`.

## session_impact_matrix (robustness by team)

Each row stores the AI-computed impact matrix and per-decision robustness for a 5-minute window. **robustness_by_team** (JSONB): per-team average robustness (1–10) from decisions in that window, e.g. `{ "Evacuation": 7, "Triage": 6, "Media": 8 }`. Used by the inject scheduler for evac rate modulation and triage rate modulation (see above).

## Reference

- Design: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md), [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
- Migration: `migrations/062_inject_conditions_scenario_locations.sql`, `migrations/085_robustness_by_team.sql`
