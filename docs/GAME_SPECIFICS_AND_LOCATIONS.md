# Game specifics and locations

This document defines **scenario-level** concepts (location types, environmental state model, map pins) and holds **C2E Bombing–specific** details (teams, situations, environmental conditions that affect each team). Core game rules (how decisions and the system work) are in [GAME_RULES.md](GAME_RULES.md).

**Database structure:** The same tables and schema are used for all scenarios (e.g. `scenarios`, `scenario_teams`, `scenario_locations`, `scenario_injects`, session state). Only the **data** changes when you create a new scenario: different teams, locations, routes, conditions, and injects. New scenarios reuse the structure and add their own rows.

---

## Location types (schema concept)

Scenario authors define **map pins** for location types such as (and any scenario-specific ones):

- **Blast site** — Where the incident occurred.
- **Exits** — Available exit routes (building or area).
- **Triage tent sites** — Potential areas to set up triage (each has conditions: suitability, construction nearby, terrain, crowd density).
- **Cordon** — Areas to secure or cordon off.
- **Pathways** — Routes for movement or transport.
- **Parking** — Vehicle staging or parking areas.

Each pin has **conditions** in the database (good/bad, suitability, etc.). The map shows **labels only**; details are in the DB and available via the insider.

---

## Good vs bad per location

- **Good:** High suitability, no construction nearby, favorable terrain, low crowd density (or managed). In environmental state, **managed: true** by default for positive factors.
- **Bad:** Low suitability, construction nearby, bad terrain, high crowd density. Represent with **problem** set, **active: true**, **managed: false** until the player addresses it or chooses with prior knowledge (e.g. from the insider).
- Choosing a bad location without getting details first yields a penalty (location-condition gate; see [GAME_RULES.md](GAME_RULES.md)).

---

## Environmental state: positive vs negative factors

- These factors are defined in pre-authored environmental seed data (optionally multiple variants per scenario) stored in the DB and loaded into session state at session start; they are not generated at runtime.
- **Negative factors** (congestion, crowded area, blocked route): Problem exists until the player acts. In state: `problem` set, **active: true**, **managed: false**. When the player addresses it, set **managed: true**.
- **Positive factors** (non-congested street, less crowded area): Already good. **managed: true** by default; no active problem.
- **managed** = "this route/area is in an acceptable or good state for use." **active** = used only for negative factors: "this problem is currently present."

---

## Map pins and scenario_locations

- Pins are stored in a **scenario-level** table (e.g. `scenario_locations`): id, type, label, coordinates, **conditions** JSONB. Same structure for every scenario; each scenario has its own rows.
- The **map** shows pins with **labels only**. The **insider** uses the same DB (or session state) to answer questions about a pin. **Location-condition gate:** when a decision references a location, the engine checks that location's conditions and applies penalty if bad and not cleared.

---

## C2E Bombing scenario: teams, situations, and environmental conditions

The following are **specific to the C2E Bombing at Community Event** scenario. Other scenarios will have their own teams, situations, and factors; the DB structure stays the same.

### Teams

- **Evacuation** — Safely evacuate participants, manage bottlenecks, prevent discriminatory segregation, coordinate with other teams.
- **Triage** — Establish medical triage, prioritise injuries, manage casualty zones, shield from intrusive filming.
- **Media** — Manage media relations, counter misinformation, issue statements, de-escalate tensions.

### Situations and factors that affect each team

- **Evacuation in progress:** Factors include exit capacities and congestion, traffic on routes to/from site, crowd density at exits, whether traffic has been coordinated (environmental prerequisite). Wrong exit allocation (e.g. over capacity) is a direct consequence (Type B).
- **Triage site chosen:** Factors include per-pin conditions (suitability, construction nearby, terrain, crowd density). Choosing a bad site without insider details triggers the location-condition gate.
- **No public statement / no perimeter:** Factors include information vacuum and lack of cordon; these create the opening for opportunistic injects (journalist, fake voice note, filming in triage) — Type A, time-bound eligibility.
- **Vehicle deployment / evacuation convoy:** Factors include whether routes are managed (traffic); unmanaged routes trigger the environmental prerequisite gate and degraded outcome.

### Environmental conditions for C2E (example)

- **Routes:** e.g. Route 1 (congested, 20 min) — negative, active until managed; Route 2 (clear, 3 min) — positive, managed by default. Session state holds route list with problem, active, managed, travel_time_minutes.
- **Areas (facilities):** Hospitals and police stations can appear in `environmental_state.areas` with `at_capacity`, `problem`, and `aliases` for name matching. When a decision names such a facility (e.g. in a triage or resource plan) and that facility is at capacity or has an unmanaged problem, the environmental prerequisite gate fails and the same penalty flow as unmanaged traffic applies (inject, robustness cap, objective penalty). This encourages players to consider hospital/police capacity and alternatives.
- **Locations:** Blast site (hard court), exits (e.g. North, South, Exit B with capacity limits), potential triage tent sites (with suitability, construction_nearby, terrain), cordon, pathways, parking. Each has conditions in `scenario_locations` (or equivalent); session state can track managed/active if they change during play.

When building a new scenario, you create new rows in the same tables with that scenario’s teams, locations, routes, and condition values.

---

## Reference

- Core game rules (generic): [GAME_RULES.md](GAME_RULES.md)
- Implementation order and phases: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md)
- Step-by-step list: [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)
