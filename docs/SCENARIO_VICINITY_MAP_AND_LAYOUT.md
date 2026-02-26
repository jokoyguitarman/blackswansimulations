# Scenario Vicinity Map and Building Layout – Reference

This document records the design and code changes needed to add **vicinity map** and **building layout** images to scenarios, generate them along with scenario generation, and refer to them in the game.

---

## 1. Database: Store Image References

### Option A – Columns on `scenarios` (recommended for one map + one layout per scenario)

Add to `scenarios` in a new migration:

- **`vicinity_map_url`** – TEXT NULL. URL of the vicinity/site map image (e.g. Supabase Storage public URL or external).
- **`layout_image_url`** – TEXT NULL. URL of the building layout/blueprint image.
- **`layout_metadata`** – JSONB NULL (optional). For structured data (exits, zones) if you later generate diagrams from data; can stay empty if you only store images.

### Option B – Separate assets table

New table `scenario_assets`:

- `id`, `scenario_id`, `asset_type` (e.g. `'vicinity_map'`, `'layout'`), `url`, `metadata` JSONB, `created_at`.

Use Option B if you plan multiple asset types or multiple images per scenario.

---

## 2. Storage: Where Images Live

- **Supabase Storage:** Create a bucket (e.g. `scenario-assets`) with policy so authenticated users (or server) can upload and the public can read (for public URLs).
- **Existing pattern:** `server/services/aarExportService.ts` uses `supabaseAdmin.storage.from('aar-exports')` and `getPublicUrl()`.
- **Flow:** When an image is generated, the server uploads the file to the bucket and stores the **public URL** in `scenarios.vicinity_map_url` / `scenarios.layout_image_url` (or in `scenario_assets.url`).

---

## 3. Scenario Create/Update: Accept and Save URLs

**File:** `server/routes/scenarios.ts`

- **Create:** In the handler that inserts into `scenarios`, add optional body fields `vicinity_map_url`, `layout_image_url` (and optionally `layout_metadata`). Include them in the `.insert({ ... })` and in the create schema if present.
- **Update (PATCH):** Allow optional `vicinity_map_url`, `layout_image_url` (and `layout_metadata`) in the body and pass them through to the update.
- **Clone:** When cloning a scenario, either copy `vicinity_map_url` and `layout_image_url` to the new scenario (same URLs) or omit them so the clone has no images until the user uploads/generates new ones.

---

## 4. Scenario Generation: Producing the Images

Layout and vicinity map should be **generated along with scenario generation**. Two approaches:

### A) Generated from structured data (recommended)

- **AI scenario generation** (`server/services/aiService.ts` – `generateScenario`):
  - Extend the AI response schema to include a **layout** object, e.g. `exits: [{ id, label, x, y, flow_per_min }]`, `zones: [{ id, label, shape, ... }]`, optional `bounds`.
  - After creating the scenario (in the route that calls `generateScenario`), add a **post-step**:
    - Call a new **layout diagram service** (e.g. `server/services/scenarioLayoutService.ts`) that:
      - Takes that layout JSON and generates an **SVG** (or PNG via a library).
      - Optionally generates a second “vicinity” diagram (simplified site map) from the same or another structure.
    - Upload each image to Supabase Storage (`scenario-assets`), get public URLs.
    - Update the new scenario with `layout_image_url` and `vicinity_map_url` (and optionally save the same JSON in `layout_metadata`).

- **Code changes:**
  - `aiService.ts`: extend `GeneratedScenario` and the system prompt so the model returns the layout structure; parse and validate it.
  - New `scenarioLayoutService.ts`: input = layout JSON, output = SVG (or buffer); optionally a second function for “vicinity” SVG.
  - New small helper (or in existing service) to upload a buffer to Storage and return URL.
  - In `server/routes/ai.ts` (or wherever scenario creation after AI runs): after insert, call layout service, upload, then PATCH scenario with the two URLs.

### B) AI image generation (e.g. DALL·E)

- Same flow, but instead of a layout service you call an image API with a text prompt (e.g. “floor plan of a convention hall with 4 exits”), get an image buffer, upload to Storage, save URL.
- **Code changes:** add an image-generation call in `aiService` or a dedicated service; then in the route after scenario create, call it (e.g. twice: vicinity + layout), upload, update scenario with URLs.

---

## 5. APIs: Expose Images to the Game

- **Briefing API** (`server/routes/briefing.ts`):
  - In the handler that loads the scenario for the session, extend the select to include `vicinity_map_url`, `layout_image_url` (and optionally `layout_metadata`).
  - Include them in the JSON response (e.g. on the same object as the briefing or under `scenario_assets`).

- **Optional dedicated endpoint:**
  - `GET /api/scenarios/:id/assets` or `GET /api/sessions/:id/vicinity-map` that returns `{ vicinity_map_url, layout_image_url, granted?: boolean }` for the session’s scenario (and optionally whether the current user/team has “unlocked” the vicinity map).
  - Use this if the vicinity map is shown in a separate “Vicinity map” panel with access control (e.g. only after request to Insider).

---

## 6. Frontend: Display Images in the Game

- **Briefing view** (`frontend/src/components/Session/BriefingView.tsx`):
  - After loading briefing (and new fields), if `vicinity_map_url` or `layout_image_url` exist, render them:
    - Section “Vicinity map” with `<img src={briefing.vicinity_map_url} alt="Vicinity map" />` (and optional link to open full-size).
    - Section “Building layout” with `<img src={briefing.layout_image_url} alt="Building layout" />`.
  - Use appropriate styling (max-width, border) so they fit the layout.

- **Vicinity map panel (optional):**
  - If you add a dedicated “Vicinity map” tab/panel (separate from briefing), that panel calls the API that returns `vicinity_map_url` (and optionally `layout_image_url`), and only shows when e.g. `granted` is true.
  - Renders with `<img src={...} />` or an image viewer component.

- **Session/scenario context:** Wherever you fetch scenario or session for the active game, ensure the response includes `vicinity_map_url` and `layout_image_url` if you need them outside the briefing (e.g. in a shared “Resources” panel).

---

## 7. Summary Table

| Area                          | Change                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB**                        | New migration: add `scenarios.vicinity_map_url`, `scenarios.layout_image_url` (and optionally `layout_metadata`).                                                      |
| **Storage**                   | New bucket `scenario-assets` (or reuse existing); upload from server and use public URL.                                                                               |
| **Scenarios API**             | Create/update/clone: accept and persist `vicinity_map_url`, `layout_image_url` (and optionally `layout_metadata`).                                                     |
| **Scenario generation**       | After creating scenario (AI or manual): generate layout/vicinity image(s) (from structured data or AI image API), upload to Storage, set the two URLs on the scenario. |
| **Briefing (or session) API** | Return `vicinity_map_url`, `layout_image_url` (and optionally `layout_metadata`) for the session’s scenario.                                                           |
| **Frontend briefing**         | In `BriefingView` (and/or vicinity map panel), render `<img src={...} />` for those URLs when present.                                                                 |

---

## 8. Example Layout Metadata (for data-driven diagram)

If using structured data to generate the layout diagram, store or pass something like:

```json
{
  "bounds": { "width": 800, "height": 600 },
  "exits": [
    { "id": "north", "label": "North Exit", "x": 400, "y": 0, "flow_per_min": 120 },
    { "id": "south", "label": "South Exit", "x": 400, "y": 600, "flow_per_min": 80 }
  ],
  "zones": [
    { "id": "ground_zero", "label": "Ground zero", "shape": "polygon", "points": [[...]] },
    { "id": "triage_a", "label": "Triage A", "shape": "rect", "x": 100, "y": 200, "w": 150, "h": 100 }
  ]
}
```

This can drive both the generated SVG and (later) gate content hints (e.g. “north exit”, “triage A”).

---

## 9. Map, Insider, and AI Judgement (Design)

### 9.1 Role of the map

- The **map** shows the layout of the blast site (or, in other scenarios, the building or environment of play).
- Each map has its **own specifics**: exits, narrow staircases, triage zones, choke points, etc.

### 9.2 Insider: map only when asked for the map

- When a player asks for **"the map"**, the **Insider gives only the map** and no other detail (no narrative, no evacuee count, no flow rates, etc.).
- The player must then either:
  - **Read the map** and infer what they can (e.g. "there's an exit here", "narrow staircase there"), or
  - **Ask the Insider for other specifics** in separate questions (e.g. "How many evacuees?", "What's the flow rate at North exit?", "What's the capacity of Triage Zone A?").
- So: the map is one type of intel the Insider can release; other details are requested separately unless the player can derive them from the map.

### 9.3 Decisions in context

- Players make **decisions** involving moving people inside/outside, evacuation routes, triage placement, escape routes (e.g. prison breakers), etc.
- The **AI** (inject generation, pathway outcomes, impact/robustness evaluation) must be able to **judge those decisions** using the **added context** of:
  - **Number of evacuees** (vs exit flow and time)
  - **Space available** (e.g. triage zone capacities)
  - **Chosen area for triage** (does it have enough capacity?)
  - **Chosen escape/evacuation route** (is it feasible? bottlenecks? flow rate?)
- So the same "ground truth" that backs the map and the Insider's answers should be available to the AI when it evaluates decisions and generates consequences.

### 9.4 What the codebase needs for AI to judge with layout context

**Current state:** The AI receives `scenarioDescription`, `currentState`, `recentDecisions`, `objectives`, `recentInjects`, etc. It does **not** receive structured layout ground truth (exits, flow rates, zones, evacuee count, capacities).

**Required:**

1. **Stored layout ground truth (per scenario)**  
   A structured representation that backs both the map and the Insider, e.g.:
   - Evacuee count (or range)
   - Exits: id, label, flow_per_min, status (e.g. blocked/clear)
   - Zones: id, label, capacity (e.g. triage), type
   - Optional: escape routes, choke points, "narrow staircase", etc.

   This can live in **scenario.initial_state** (e.g. `layout: { evacuee_count, exits, zones }`) or in **scenario.layout_metadata** / scenario_assets metadata.

2. **Pass layout context into AI prompts**  
   Wherever the AI is called to generate injects from decisions, produce pathway outcomes, or evaluate impact/robustness, add a **layout/ground-truth** block to the prompt, e.g.:
   - _"LAYOUT / ENVIRONMENT GROUND TRUTH: Evacuees: 1000. Exits: North 120/min, South 80/min, East blocked. Triage zones: A capacity 50, B capacity 100. Narrow staircase at West."_  
     So the model can check decisions against evacuees, space, and routes.

3. **Insider behaviour**  
   When the user asks for "the map", the Insider returns **only the map** (asset/link). Other questions ("How many evacuees?", "What's the flow at North exit?") are answered from the same layout data, without sending the map again.

4. **Optional: record choices in session state**  
   If players choose triage location or evacuation route during play, record in `session.current_state` (e.g. `chosen_triage_zone: "A"`, `evacuation_route: "North Exit"`). The AI can then compare those to the layout ground truth (e.g. "Triage A chosen; capacity 50 but casualty estimate 200 → overflow").

### 9.5 Summary

- **Map** = visual of the layout; **Insider** gives only the map when asked for "the map"; players must use the map and/or ask for other specifics.
- **Decisions** about movement, evacuation, triage, escape routes should be **judged by the AI** using **structured layout context** (evacuees, space, exits, capacities, routes).
- **Implementation:** (1) Store layout ground truth per scenario (e.g. in `initial_state.layout` or `layout_metadata`). (2) Include that structure in the prompts for all AI calls that evaluate decisions or generate consequences. (3) Implement Insider logic so "give me the map" returns only the map. The codebase already has the extension points (scenario description, session context, current state); the missing piece is the structured layout data and passing it into those AI calls.

---

## 10. OSM Realism Layer (Design)

Use **real OpenStreetMap (OSM) data** for the scenario vicinity so the Insider can answer with real-world facts—and only when players ask the right questions. This measures how aware players are of their surroundings and how clever they are at asking for the right intel.

### 10.1 Example use cases

- **Security** asking for **CCTV footage** to look for a bomber → Insider answers from available surveillance/CCTV data (OSM or seeded) for the area.
- **Triage** asking **how many hospitals** in the vicinity and which can be activated → Insider answers from OSM hospitals (names, locations, count).
- **Ops** asking **possible routes** for emergency teams → Insider answers from OSM road network (key corridors, one-way, access).
- **Police** asking **how many police outposts** and **which ones with real names/locations** → Insider answers from OSM police POIs (real names and locations).

All of this is available via the Insider **only if the player asks the right question**; the Insider does not volunteer it with the map.

### 10.2 Scenario geography

Scenarios need a **geographic footprint** for both the vicinity map and OSM queries:

- Add **center + radius** (e.g. `center_lat`, `center_lng`, `vicinity_radius_meters`) or a **bbox** on the scenario (or in `initial_state`).
- Use the same footprint for generating/fetching the vicinity map and for querying OSM (Overpass API).

### 10.3 What OSM provides

| Use case                | OSM coverage | Notes                                                                                                                                        |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hospitals**           | Very good    | `amenity=hospital`, `healthcare=hospital`; name, location.                                                                                   |
| **Police**              | Good         | `amenity=police`; name, address, location.                                                                                                   |
| **Emergency routes**    | Good         | Roads: `highway=*`; one-way, access, maxspeed. Return "possible routes" as key corridors.                                                    |
| **CCTV / surveillance** | Patchy       | Some regions use `surveillance:type=camera`, `man_made=surveillance`. Often sparse; may need seeded points or "no public data" for the area. |

Precompute this at scenario create/update and store in the scenario (see §11); the Insider answers from stored data, not live OSM.

### 10.4 Measuring awareness and cleverness

- **Awareness:** Did the team think to ask for hospitals, CCTV, routes, police?
- **Cleverness:** Did they ask in a way that retrieves the right category (e.g. "hospitals we can activate")?
- **Implementation:** Log each Insider question (and optionally the category and answer) per session (§11) so AAR/trainer can show what was asked and what was not.

---

## 11. Insider Knowledge in the Database (Design)

Store **all information the Insider can use** in the database so it is loaded once per scenario/session, versioned with the scenario, and available for AAR. No live OSM or generation at query time.

### 11.1 Single store per scenario: `insider_knowledge`

Add one column on `scenarios`:

- **`insider_knowledge`** – JSONB NULL. Single structured blob containing everything the Insider is allowed to say.

Suggested schema (enforce in app or with JSON schema):

- **Map/layout:** `vicinity_map_url`, `layout_image_url`, `layout_ground_truth` (evacuee_count, exits, zones, etc.) – aligns with §8–9.
- **OSM-derived:** `osm_vicinity`: `center`, `radius_meters`, `hospitals[]`, `police[]`, `emergency_routes[]`, `cctv_or_surveillance[]` – real names/locations from OSM, pre-fetched.
- **Optional:** `custom_facts[]` – topic, summary, detail for author- or AI-defined facts the Insider can use when asked the right question.

The Insider service loads `insider_knowledge` for the session’s scenario and answers only from the relevant slice (map only for "the map"; hospitals/police/CCTV/routes when the question matches).

### 11.2 Who populates it

- **Scenario create/update:** Author or AI fills layout ground truth and custom_facts; optional URLs for map/layout.
- **OSM pipeline:** When scenario has a geographic footprint, a job or backend step calls Overpass (and optionally Nominatim), normalizes POIs into `osm_vicinity`, and writes it into `insider_knowledge`.
- **Clone scenario:** Copy `insider_knowledge` as-is so the clone has the same Insider behaviour.

### 11.3 Optional: log what was asked and answered (session-level)

To measure awareness and cleverness in AAR, persist each Insider Q&A per session:

- **Option A:** Table **`session_insider_qa`** – `session_id`, `asked_at`, `asked_by` (user_id), `question_text`, `category` (map | hospitals | police | cctv | routes | other), `answer_snippet` or full answer, `sources_used`.
- **Option B:** Append to `sessions.current_state` or a generic `session_events` log.
- **Option C:** Application logs / AAR export only, if DB querying is not needed.

AAR can then show e.g. "Security asked for CCTV at 00:12; Triage asked for hospitals at 00:18; no one asked for police outposts."

### 11.4 Summary

- **All Insider information** is stored in **`scenarios.insider_knowledge`** (JSONB) with a clear schema: map/layout, OSM vicinity (hospitals, police, routes, CCTV), and optional custom_facts.
- **Population:** At scenario create/update (AI, OSM job, author); clone copies `insider_knowledge`.
- **Insider behaviour:** Load `insider_knowledge` for the session’s scenario; answer only from the slice that matches the question (map vs hospitals vs police vs CCTV vs routes).
- **Optional:** Persist each Insider Q&A (e.g. `session_insider_qa`) so AAR can report what was asked and measure awareness/cleverness.
