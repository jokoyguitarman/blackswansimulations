# Step 6 — Map and frontend

**Goal:** Show environmental state (e.g. traffic) and **map pins** from the DB on the map; pins display **labels only**; condition details via insider or on request.

---

## Scope

Map shows environmental state from `state.updated` and **map pins** from API/DB (blast site, exits, triage sites, cordon, pathways, parking). Each pin shows only a **label** (e.g. "Potential triage tent site", "Exit B") — no condition details on the map. Optional "request details" flow that can drive insider answers. Optional legend for traffic/env state.

---

## Files to create or modify

- `frontend/src/components/COP/MapView.tsx`: reads `environmental_state` from `state.updated`; fetches scenario locations via `api.sessions.getLocations(sessionId)`; renders pins with labels only; optional legend when routes have unmanaged entries.
- `frontend/src/components/COP/ScenarioLocationMarker.tsx`: new component for a single scenario location pin (label + type in popup; no condition details).
- `server/routes/sessions.ts`: new `GET /:id/locations` returns scenario_locations for the session's scenario (id, location_type, label, coordinates, display_order).
- `frontend/src/lib/api.ts`: added `sessions.getLocations(sessionId)`.

---

## Key structures or contracts

- **Map pins:** Loaded from scenario_locations (or equivalent); rendered with labels only. No suitability/construction/terrain on the map; details obtainable via insider or optional "request details" flow.

---

## Acceptance criteria

- [x] Map reads `environmental_state` from `state.updated` (WebSocket) and shows optional legend when routes have unmanaged entries.
- [x] Scenario locations (map pins) are loaded from API `GET /api/sessions/:sessionId/locations` and rendered with **labels only** (popup shows label + location type; no conditions/suitability on map).
- [x] Pins use coordinates from `scenario_locations.coordinates` (e.g. `{ lat, lng }`); pins without valid coordinates are skipped.
- [x] Optional legend displays when `environmental_state.routes` contains unmanaged routes (e.g. "Traffic / routes: N unmanaged").

---

## Depends on

- Step 1 (Database and schema).
- Step 2 (Environmental state service) — state shape for traffic/roads.
