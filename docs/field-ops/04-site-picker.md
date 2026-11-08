# WS3: Site picker on the saved map data

**Status:** v1, 25 Oct 2026. Not built.
**Workstream:** WS3
**Depends on:** [the master plan](00-master-plan.md#10-shared-contracts) and [the prerequisites spec](01-prerequisites.md#6-server) (WS0: `env.enableFieldopsV2`, `requireFieldopsV2`, the schema-feature helpers, `VALIDATION_FAILED`); for named types only, `02-teams-and-doctrines.md` (the vocabulary) and `03-setup-screen.md` (the readiness rule and lane-props contracts)
**Flags:** `ENABLE_FIELDOPS_V2` and `VITE_ENABLE_FIELDOPS_V2`
**Migrations:** 229, 230, 231, 232 (**updated 8 Nov 2026**: every field-ops number moved up by one; master section 9)
**Baseline:** verified against commit 1cd539a (8 Nov 2026); see the README.

## 1. Purpose, goals and non-goals

WS3 moves the first half of the Scene Editor (its "map" phase: find the building, outline it, see its neighbours and streets) onto the new Setup screen as **the site lane**, strips out the steps that make it slow, and runs it only on the saved OpenStreetMap tables in Supabase. The trainer types an address, a building name or a street, picks a match from a dropdown, and the map centres with a 150 m ring, the primary building in cyan, its neighbours in amber and the streets in blue. She can expand or shrink the radius, mark up to five other buildings as involved with a role, and draw or trace a building the data lacks. What she chose is handed to the wizard draft as one validated object, `SiteSelection`, which the layout step (WS4) opens with and compile (WS5) builds from.

**Goals**

1. A `SiteLane` component on `/warroom/field-ops` built from four parts: `PlaceSearch` (the address, landmark and street dropdown), `RadiusControl` (50 to 500 m, default 150), `SiteMap` (Leaflet: ring, streets, footprints, primary, involved and ghost buildings) and `InvolvedBuildingsList` (buildings involved, each with a role).
2. The Scene Editor's visual language kept exactly where it is verified in code (section 3.2), and its Draw and Auto-trace tools reused without copying them.
3. Addresses resolve (D6): the saved data is re-extracted with house number, street, postcode, city and a place class, stamped with a data version, and the same extract fills `osm_sg_facilities` for WS5's area dossier (D18).
4. Type-ahead that feels instant: a narrow search index (`osm_sg_search_index`) with prefix, word-prefix and, where `pg_trgm` exists, substring indexes, ranked by deterministic and tested rules.
5. One contract: `SiteSelection` and `BuildingRef` with their constants and pure helpers in `shared/fieldOps/site.ts (new)` and their zod schemas in `server/lib/fieldOps/siteSchemas.ts (new)`, plus the exports fixed by master 10.8 items 10 and 11 (`SiteHintResolution`, `resolveSiteHint`, `SiteSearchResult`, `normaliseSiteSelection`, `buildSiteSelectionContext`, `SITE_LIMITS`, `ringFingerprint`, `siteFingerprint`, `loadSiteArea`) and `siteToLegacyLocation` for compile.
6. Honest coverage (D13): outside the saved data the lane says "No saved map data for this area yet" and stops. There is no live fallback.
7. No live map data in new code (D5): no Overpass, Nominatim or Google call anywhere WS3 or the new client writes, enforced by a static test; map tiles only through the tile proxy, which this spec hardens.
8. Additive and flagged: everything new sits behind `ENABLE_FIELDOPS_V2`, and every server path works, in a degraded mode, before migrations 229 to 232 are applied.

**Non-goals**

- Editing `frontend/src/components/SceneEditor/SceneEditor.tsx` or any legacy wizard screen (D25). The Scene Editor keeps its own map phase; WS4 hides it behind the flag.
- The `setup_v2` column, the draft save route and the readiness list (WS2), the layout step (WS4) and compile (WS5). WS3 supplies the pieces they call.
- Any geocoder, Overpass query, Nominatim call, Google service or live fallback outside Singapore (D5, D13).
- PostGIS. The saved tables stay plain bounding boxes plus JSON geometry.
- Importing a region other than Singapore. The admin path is written down (section 6.11); the code it needs is listed, not built.
- The legacy map path behind `ENABLE_LOCAL_OSM_SINGAPORE`, which keeps working unchanged.
- Interior layouts for involved buildings, which stay at footprint level (D9) and are WS4's.
- The radar's prompt. WS2 writes it; WS3 only turns the place words it returns into a search result (section 6.8).

## 2. Decisions and assumptions

**Added 3 Nov 2026.** One addition for WS1's revision for D29 (`02-teams-and-doctrines.md`): `SiteDataVersion` also reports the data version's `region`, so WS1's `defaultAgencyCountry` can read the saved map data's country instead of assuming Singapore (sections 5.2 and 6.7, AC3.32, answered in section 15.4). Nothing already built changes: `osm_sg_data_versions.region` exists in migration 229. WS9's living world (`11-living-world.md`) also starts its units at WS3's facilities and builds its road graph from the saved roads; it asks only that the facility kinds and the data version's label stay as they are (section 15.4).

**Decisions from the master plan that this spec applies**

| Ref | What it means here | Status |
| --- | --- | --- |
| D5 | The site comes only from `osm_sg_buildings`, `osm_sg_roads` and the new WS3 tables. Tiles come through `/api/tiles`. No Overpass, Nominatim or Google in new code. | Decided |
| D6 | The re-extract adds house number, street, postcode and city; the search index includes addresses. | Decided |
| D9 | Involved buildings are stored as footprints with a kind and a label. Only the primary gets an interior later (WS4). | Decided |
| D13 | Outside the saved data's coverage the lane says so and stops. The admin import path is documented in section 6.11. | Assumed (D13) |
| D15 | At most five involved buildings besides the primary (`SITE_LIMITS.maxInvolved`). | Assumed (D15) |
| D18 | The dossier's hospitals, police and fire stations come from `osm_sg_facilities` (migration 232), read through `listFacilitiesNear`. | Assumed (D18) |
| D23 | WS3's migrations are 229 to 232, additive and idempotent. | Assumed (D23) |
| D25 | The picker lives on the new page; `SceneEditor.tsx` is not edited. | Assumed (D25) |
| D28 | Where the mockup and this spec differ, the mockup wins unless accessibility, the data model or the design brief requires otherwise. The differences are listed for the UI sheet in section 15. | Assumed (D28) |
| 10.8 item 5 | Missing tables, columns and functions are detected with WS0's helpers, including `isMissingFunctionError`; a negative answer is re-checked after about a minute (section 5.5). | Settled (master) |
| 10.8 item 21 | No WS3 table has a foreign key to `scenarios`, so WS5's deletion of draft scenarios never touches WS3's rows. | Settled (master) |
| 10.8 item 29 | The file map lists other workstreams' files with an Owner column and keeps their `(new)` marker (section 14). | Settled (master) |
| 10.8 items 20, 22 to 28, 30 | Compile, layout survival, setup caps, free text, doctrine steps, session start, published edits, the participant projection and the review revision do not touch WS3's contracts. | Settled (master) |

**Proposed by this spec** (each is the design this spec specifies; an owner can overrule it through section 15)

| Ref | Proposal | Why |
| --- | --- | --- |
| P1 | The search index is a narrow table built offline by the generator, with search text normalised by one shared function used by the generator, the server and the browser. | The stored text and the query text cannot drift; ranking is testable without a database. |
| P2 | Prefix search uses a btree on `search_text COLLATE "C"` queried as a range; word-prefix uses a built-in `tsvector` GIN index; substring uses a `pg_trgm` GIN index when the extension can be created and a scan of the narrow table otherwise. | Fast without depending on an extension, and safe with generic query plans (section 6.4). |
| P3 | The ring is centred on the primary building's vertex mean whenever a primary is set. | The vertex mean is the sim-space origin the layout uses (`frontend/src/lib/evacuation/geometry.ts:12-13`). |
| P4 | For a building that has an `osm_id`, the server replaces the client's polygon and name with the stored footprint. If the `osm_id` is no longer in the saved data, the building becomes a custom polygon and a warning is returned. | The client is never trusted for map data; a re-import never breaks an old draft. |
| P5 | Ghost buildings follow the mockup: a building outside the radius is drawn as a dashed ghost when the radar proposed it or when the trainer had involved it before shrinking the radius. Other buildings beyond the radius are hidden, as in the mockup. | D28; the mockup draws exactly one ghost, the radar's MRT station (`docs/design/warroom/field-ops-setup.html:714`). |
| P6 | Shrinking the radius removes involved buildings that fall outside it, as the mockup does (`docs/design/warroom/field-ops-setup.html:1322-1326`), announces the removal and keeps them as ghosts for the session so one click restores them. | The stored selection never holds a building outside its own ring. |
| P7 | The re-import is mark and sweep on `osm_id` with a data version per run, never a truncate, and refuses to run without a dry run, a matching project reference and an explicit confirmation. | One Supabase project serves every environment (journey finding 17.17). |
| P8 | Coverage is the union of the active data versions' bounding boxes, with a measured fallback box, plus a "no data nearby" check. | A box alone includes sea and Johor. |
| P9 | The tile proxy is hardened additively: parameter validation, a timeout, a bounded cache and an identifying User-Agent; the global limiter already counts tile requests per address. | Journey finding 4.7; the picker depends on it. |
| P10 | Auto-trace gains an optional `debug` switch so the new picker never opens the debug pop-up; the Scene Editor's behaviour is unchanged. | Journey finding 4.16 without editing `SceneEditor.tsx`. |

**Assumptions about things that cannot be checked from the repository** (each is a question in section 15)

- The share of buildings that will gain an address is unknown until the extract runs (section 5.6).
- The densest 600 m circle in Singapore holds fewer than 1,500 building footprints (the area cap). Not measured.

**Checked on the live project on 25 Oct 2026** (read-only, reported in the reconciliation brief; no database tool was used for this spec): the project runs PostgreSQL 17.6, so the stored generated column of migration 230 is supported; `pg_trgm` 1.6 is available but not installed, and on Supabase it is created with `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions`, which is the statement migration 230 runs. The trigram index is therefore expected to exist once 230 is applied; the fallback without it stays, in case the owner applies the migration under a role that cannot create extensions.

## 3. Current state (verified)

Everything in this section was read in the code on the baseline. Line numbers are as on disk on 25 Oct 2026. Figures about the live data (row counts, coverage, timings) were measured read-only on 24 Oct 2026 and are quoted from the common brief; they were not re-measured for this spec.

### 3.1 The Scene Editor's map phase: state and handlers

`frontend/src/components/SceneEditor/SceneEditor.tsx` is 2,761 lines. Its map phase is the part this workstream moves. Paths in this table are relative to `frontend/src/components/SceneEditor/`.

| What | Where | Fate in the site picker |
| --- | --- | --- |
| The `phase` switch between map and edit | `frontend/src/components/SceneEditor/SceneEditor.tsx:424-425` | Gone: the picker is always the map |
| Search, coordinate and radius state: `appliedRadius`, `osmSourceMode`, `searchQuery`, `searchCountry`, `userGeoPos`; the radius starts at `'500'` | `frontend/src/components/SceneEditor/SceneEditor.tsx:427-443` | Replaced by `SiteLane` state; radius starts at 150 |
| Fetch state: `fetchResult` (grids, roads, `roadPolylines`), `selectedGridIdx`, `fetchLoading` | `frontend/src/components/SceneEditor/SceneEditor.tsx:444-456` | Replaced by the area response (section 6.5) |
| Draw state `isDrawing`, `drawnBuildingName` | `frontend/src/components/SceneEditor/SceneEditor.tsx:472-475` | Kept as a mode of `SiteMap` |
| Auto-trace state `isAutoTracing`, `autoTracePreview`, `autoTraceTolerance` (default 20) | `frontend/src/components/SceneEditor/SceneEditor.tsx:477-481` | Kept as a mode of `SiteMap` |
| GPS on mount through `navigator.geolocation`, falling back to 1.2989008, 103.855176, then a reverse lookup of the country through Nominatim | `frontend/src/components/SceneEditor/SceneEditor.tsx:670-703` | Dropped |
| `handleSearchInput`: at least 3 characters, a 400 ms debounce, then Nominatim search from the browser | `frontend/src/components/SceneEditor/SceneEditor.tsx:707-748` | Replaced by `PlaceSearch` on the saved index |
| `handleSelectResult` sets the coordinates and flies the map | `frontend/src/components/SceneEditor/SceneEditor.tsx:750-762` | Replaced by the pick flow (section 7.4) |
| `handleFetch` calls the staff-only diagnostic route with `osmSource` | `frontend/src/components/SceneEditor/SceneEditor.tsx:766-795` | Replaced by the area route |
| A re-fetch when the source switch changes | `frontend/src/components/SceneEditor/SceneEditor.tsx:797-806` | Dropped |
| `selectBuilding` clears the scene, makes wall points and enters the edit phase | `frontend/src/components/SceneEditor/SceneEditor.tsx:810-832` | Replaced: a click marks a building primary or involved |
| `handleDrawComplete` turns a drawn polygon into the selected building | `frontend/src/components/SceneEditor/SceneEditor.tsx:836-874` | Replaced by the draw outcome (section 7.6) |
| `backToMap` | `frontend/src/components/SceneEditor/SceneEditor.tsx:876-880` | Gone |
| `clipRoadPolylineToRadius` cuts a street to the ring in local metres | `frontend/src/components/SceneEditor/SceneEditor.tsx:174-275` | Re-implemented in shared code (section 7.2) |
| `displayRoadPolylines` applies that cut with `appliedRadius` | `frontend/src/components/SceneEditor/SceneEditor.tsx:562-576` | Replaced by a local clip on shrink |
| Street widths: `getEstimatedRoadWidthM` and `getRoadStrokeWeight` (4 to 10 px) | `frontend/src/components/SceneEditor/SceneEditor.tsx:132-172` | Copied exactly into `siteMapLayers.tsx (new)` |
| Leaflet helpers `MapRefSync`, `FitBounds`, `FlyToPoint` and `AutoTraceClickHandler` | `frontend/src/components/SceneEditor/SceneEditor.tsx:336-409` | Extracted (section 7.2) |

### 3.2 The map-phase screen and its visual language

The map-phase render is `frontend/src/components/SceneEditor/SceneEditor.tsx:1518-1971`.

| Element | Where | Fate |
| --- | --- | --- |
| "Locating you..." banner | `frontend/src/components/SceneEditor/SceneEditor.tsx:1528-1532` | Dropped |
| Country list: 66 countries plus "All Countries" | `frontend/src/components/SceneEditor/SceneEditor.tsx:1534-1610` | Dropped |
| "Search Place" input and its result list | `frontend/src/components/SceneEditor/SceneEditor.tsx:1612-1635` | Replaced by `PlaceSearch` |
| Lat, Lng and Radius boxes | `frontend/src/components/SceneEditor/SceneEditor.tsx:1637-1672` | Dropped |
| "OSM Source" select (local cache or live) | `frontend/src/components/SceneEditor/SceneEditor.tsx:1674-1686` | Dropped |
| Drawing banner with a building-name input | `frontend/src/components/SceneEditor/SceneEditor.tsx:1688-1716` | Replaced: the name is asked after drawing |
| Fetch Buildings | `frontend/src/components/SceneEditor/SceneEditor.tsx:1719-1726` | Dropped |
| Draw Building on Map | `frontend/src/components/SceneEditor/SceneEditor.tsx:1734-1740` | Kept as "Not on the map? Draw it" |
| Auto-Trace Building (Magic Wand) | `frontend/src/components/SceneEditor/SceneEditor.tsx:1742-1752` | Kept as "Auto-trace (magic wand)" |
| Auto-trace panel: status, tolerance 10 to 40, accept, retry, cancel | `frontend/src/components/SceneEditor/SceneEditor.tsx:1756-1834` | Kept, restyled |
| "N buildings found ... Select one:" pick list | `frontend/src/components/SceneEditor/SceneEditor.tsx:1838-1859` | Dropped |

The layers drawn on the map, with the exact values in the code:

| Layer | Verified style | Where |
| --- | --- | --- |
| Tiles | `TileLayer` on `/api/tiles/{z}/{x}/{y}.png` with `crossOrigin="anonymous"`, `maxNativeZoom` 19, `maxZoom` 22, attribution "&copy; OSM" | `frontend/src/components/SceneEditor/SceneEditor.tsx:1870-1876` |
| Fly-to | `FlyToPoint` at zoom 19 on every coordinate change, inside an effect | `frontend/src/components/SceneEditor/SceneEditor.tsx:1878` |
| Ring | `Circle` stroke `#22c55e`, weight 1, fill `#22c55e` at 0.08, `dashArray` `'6 4'`, radius `appliedRadius`; a centre `CircleMarker` of radius 8, fill 0.6, weight 2 | `frontend/src/components/SceneEditor/SceneEditor.tsx:1880-1905` |
| Streets | `Polyline` colour `#1d4ed8`, weight from `getRoadStrokeWeight`, opacity 0.95 | `frontend/src/components/SceneEditor/SceneEditor.tsx:1907-1918` |
| Footprints | `Polygon` stroke `#f59e0b`, weight 2, fill `#f59e0b` at 0.15, click selects | `frontend/src/components/SceneEditor/SceneEditor.tsx:1920-1935` |
| Draw handler | `BuildingDrawHandler` while drawing | `frontend/src/components/SceneEditor/SceneEditor.tsx:1937-1945` |
| Trace preview | `Polygon` `#a855f7`, weight 3, fill 0.2, `dashArray` `'8, 4'` | `frontend/src/components/SceneEditor/SceneEditor.tsx:1955-1967` |
| Primary building (edit phase) | `Polygon` stroke `#22d3ee`, weight 2, fill `#0f172a` at 0.2 | `frontend/src/components/SceneEditor/SceneEditor.tsx:2278-2288` |

So the brief's four colours are all verified: the green dashed ring `#22c55e`, the blue centre-lines `#1d4ed8` weighted by highway type, the amber footprints `#f59e0b` at 15 per cent fill, and the primary building in cyan `#22d3ee`. The cyan appears only in the edit phase, where the fill is dark navy at 20 per cent; the mockup fills the primary with cyan at 28 per cent and a 3 px stroke (`docs/design/warroom/field-ops-setup.html:328`). Section 7.3 settles this under D28.

### 3.3 The edit phase, reload and save

- The edit phase draws its tiles straight from `https://{s}.tile.openstreetmap.org` without the proxy (`frontend/src/components/SceneEditor/SceneEditor.tsx:2259-2264`), as does the legacy `frontend/src/components/WarRoom/SceneSetup.tsx:382-387`. Only the map phase uses the proxy.
- Reloading a saved scene calls `setFetchResult` with the polygon alone and empty roads, so the streets and neighbours are lost (`frontend/src/components/SceneEditor/SceneEditor.tsx:615-668`).
- `handleSave` creates a scene with the polygon, the name and the vertex-mean centre, and later updates send only the elements (`frontend/src/components/SceneEditor/SceneEditor.tsx:1312-1399`); journey finding 4.4 follows from this.
- The sim-space origin of everything placed in a scene is the vertex mean of the stored polygon (`frontend/src/lib/evacuation/geometry.ts:3-20`, `projectPolygon`). A repeated closing vertex would move that origin, which is why a stored ring must not repeat its first point.

### 3.4 Draw and Auto-trace

- `BuildingDrawHandler` is already its own component. Its `finish` emits the clicked `[lat, lng]` vertices without repeating the first (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:66-74`); it needs `MIN_VERTICES` 3 (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:12`) and closes on a click within `SNAP_RADIUS_PX` 18 of the first vertex (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:11`).
- Its keyboard handler listens on `window` for Escape, Enter, Backspace and Delete (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:132-148`), so a focused text input would lose those keys while drawing (journey finding 4.16).
- A double click (`dblclick`) finishes (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:98-108`) and a right click (`contextmenu`) cancels (`frontend/src/components/SceneEditor/BuildingDrawHandler.tsx:114-118`).
- `captureMapPixels` composites only the `img.leaflet-tile` elements of the tile pane onto a canvas and says the tiles must come through the proxy with CORS headers (`frontend/src/components/SceneEditor/buildingAutoTrace.ts:3-47`). Vector overlays are not in the capture, so footprints drawn over the map do not disturb a trace.
- `autoTraceBuilding` calls `showDebugPopup` on every trace, successful or not (`frontend/src/components/SceneEditor/buildingAutoTrace.ts:604-652`); the pop-up is built with `innerHTML` and has no development guard.
- `AutoTraceClickHandler` turns a click into a trace and reports "Tracing...", "No building detected at this point. Try clicking directly on a building.", "Could not trace a clean outline. Try a different spot." or "Trace failed. Try again." (`frontend/src/components/SceneEditor/SceneEditor.tsx:364-409`).

### 3.5 The saved OpenStreetMap data

- `osm_sg_roads` and `osm_sg_buildings` store a text `osm_id` (unique), bounding-box columns, a vertex-mean centre, JSON geometry and a `source_updated_at` (`migrations/193_singapore_local_osm_cache.sql:5-41`). Building levels became fractional in `migrations/194_osm_sg_building_levels_fractional.sql:1-3`.
- Indexes: a bounding-box btree on each table, `highway_type` on roads and `name` on buildings (`migrations/193_singapore_local_osm_cache.sql:43-53`). Roads have no name index, so the brief's "name btree indexes" holds for buildings only.
- RLS is on with one policy each that admits only the service role (`migrations/193_singapore_local_osm_cache.sql:55-70`).
- Live data (common brief): 158,599 buildings of which 9,565 are named; 185,893 roads of which 84,793 are named; Singapore only; roughly lat 1.235 to 1.508 and lng 103.593 to 104.055; no addresses; `source_updated_at` is null everywhere; no PostGIS; a building name search took about 514 ms and a road name search about 46 ms. A second read-only check on 25 Oct (reconciliation brief) found PostgreSQL 17.6 with `pg_trgm` 1.6 available but not installed.
- The generator runs osmium on a local PBF. `ROAD_TYPES` lists the 14 highway types it keeps (`scripts/generate_singapore_local_osm.mjs:16-31`). Buildings are filtered by `osmium` with `a/building` (`scripts/generate_singapore_local_osm.mjs:320-328`) and exported with every tag plus `type,id` (`scripts/generate_singapore_local_osm.mjs:330-342`), but the building rows keep only name, the `building` tag, levels and height (`scripts/generate_singapore_local_osm.mjs:251-262`). So the address tags are already in the export and are dropped there.
- The generator keeps only the largest outer ring of a multipolygon and drops holes (`selectBestPolygonRing`, `scripts/generate_singapore_local_osm.mjs:154-170`), removes a repeated closing vertex (`dedupeClosingPoint`, `scripts/generate_singapore_local_osm.mjs:144-152`), takes the vertex mean as the centre (`buildCenter`, `scripts/generate_singapore_local_osm.mjs:183-186`), falls back to `ref` when a road has no name (`scripts/generate_singapore_local_osm.mjs:222`) and always writes `source_updated_at` as null (`scripts/generate_singapore_local_osm.mjs:228`).
- The importer loads `.env` and `frontend/.env.local` (`scripts/import_singapore_local_osm.mjs:8-9`) and needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (`scripts/import_singapore_local_osm.mjs:71-77`). Its `--truncate` flag sets `shouldTruncate`, which deletes every row through the API before importing (`scripts/import_singapore_local_osm.mjs:316-322`).
- Rows are written by `upsert` with `onConflict` on the `osm_id` column (`scripts/import_singapore_local_osm.mjs:337`), in batches whose `batchSize` must be 1 to 5,000 (`scripts/import_singapore_local_osm.mjs:82-92`). There is no dry run, no confirmation and no record of which extract was loaded.
- Both scripts run with plain `node` (`package.json:21-22`). `.gitignore:71-73` ignores the PBF and the generated files, and `server/data` does not exist on this machine, so the current extract could not be inspected.

### 3.6 The server paths today

- `SINGAPORE_BOUNDS` is lat 1.13 to 1.5 and lng 103.58 to 104.1 (`server/services/osmVicinityService.ts:592-597`). The saved data reaches lat 1.508, so the legacy box clips its northern edge.
- `shouldUseLocalSingaporeCache` uses the saved tables only inside that box and only when asked or when `env.enableLocalOsmSingapore` is on (`server/services/osmVicinityService.ts:608-617`); the flag is read at `server/env.ts:144-146`.
- `fetchLocalSingaporeRouteGeometries` pages 1,000 rows at a time by bounding box and keeps streets by polyline distance (`server/services/osmVicinityService.ts:652-722`). `fetchLocalSingaporeBuildings` does the same for buildings using the nearest vertex (`server/services/osmVicinityService.ts:724-809`).
- The road query reads an explicit column list from `osm_sg_roads` (`server/services/osmVicinityService.ts:669-673`) and the building query from `osm_sg_buildings` (`server/services/osmVicinityService.ts:737-741`), so new columns do not change what they read.
- Five public Overpass mirrors are listed in `OVERPASS_ENDPOINTS` (`server/services/osmVicinityService.ts:12-18`).
- The hospitals, police and fire-station query is `runOverpassQuery` (`server/services/osmVicinityService.ts:167-192`).
- The whole diagnostic router runs `requireAuth` and `requireStaff` (`server/routes/debug.ts:47`). `/building-studs` parses `osmSource`, `lat`, `lng` and `radius` (`server/routes/debug.ts:68-83`), skips road footprints in local-cache mode (`server/routes/debug.ts:161-168`) and caps road centre-lines by radius (`server/routes/debug.ts:189-196`).
- The tile proxy interpolates raw `z`, `x` and `y`, rotates the `a`, `b` and `c` subdomains, sends `User-Agent: Prophyion/1.0`, has no timeout and no cache, and answers with `Access-Control-Allow-Origin: *` and a one-day `Cache-Control` (`server/routes/tileProxy.ts:9-36`). It needs no authentication.
- It is mounted at `server/index.ts:300`, after helmet (`server/index.ts:117-121`), whose version 8.1.0 sends `Cross-Origin-Resource-Policy: same-origin` by default because the options there do not change it, and after the CORS allow-list with credentials (`server/index.ts:124-159`). The app trusts one proxy hop (`server/index.ts:68`), rate-limits every `/api/` request at 10,000 per 15 minutes per user (`server/index.ts:196-214`), parses JSON up to 10 MB (`server/index.ts:255`) and answers unknown routes with `{ "error": "Not found" }` (`server/index.ts:311-313`).
- The report-only CSP lists `nominatim.openstreetmap.org` and the OpenStreetMap tile hosts but not the API origin, in either `img-src` or `connect-src` (`frontend/vercel.json:48-49`). In development Vite proxies `/api` to port 3001 (`frontend/vite.config.ts:20-25`).

### 3.7 The legacy location hand-off and the conventions this spec follows

- Step 3 of the legacy wizard mounts `SceneEditor` with `initialSceneId` (`frontend/src/pages/WarRoom.tsx:1269-1282`). Step 5 copies the scene's centre into `geocode_override` and its names into `location` and `venue_name` (`frontend/src/pages/WarRoom.tsx:431-448`).
- The server prefers `input.geocode_override` and otherwise reads the scene's centre (`server/routes/warroom.ts:706-746`), then passes it to `stageParseAndGeocode` (`server/services/warroomService.ts:308-314`), which sets `hasOverride` and skips Nominatim (`server/services/warroomService.ts:349-376`). Persist writes `vicinity_radius_meters` as 10,000 (`server/services/warroomService.ts:1690-1695`) and then refreshes the vicinity through Overpass (`server/services/warroomPersistenceService.ts:679-691`).
- The draft table is `migrations/160_warroom_wizard_drafts.sql:5-27`, with `rts_scene_id` added at `migrations/163_rts_scene_configs.sql:61-63`.
- Field-ops routes check the role in the handler and answer "Only trainers can use the War Room" (`server/routes/warroom.ts:198-199`); `requireStaff` makes the same trainer-or-admin check as middleware (`server/middleware/auth.ts:88-99`).
- `validate()` answers 400 with `error` and `details` and no `code` (`server/lib/validation.ts:5-36`); WS0 adds `VALIDATION_FAILED`.
- The per-user limiter pattern, keyed on the verified user id after `requireAuth`, is `perUserLimit` in `server/routes/trainerAgreements.ts:214-222`.
- The test list is the `test` script (`package.json:25`); `tsx` is a development dependency (`package.json:69`) and zod a root dependency (`package.json:103`). A test of a shared module imports it with a `.js` suffix (`server/lib/authLinkError.test.ts:3`).
- The browser project type-checks `shared/` with its `types` limited to `vite/client` (`frontend/tsconfig.json:7`), with `erasableSyntaxOnly` (`frontend/tsconfig.json:24`) and with `../shared` in its include list (`frontend/tsconfig.json:34`).
- The client API helpers `apiUrl` and `getAuthHeaders` are private to `frontend/src/lib/api.ts:69-92`, one of the five files another session edits (README), so the site client has its own small fetch helper (section 7.8).
- `WrIcon` draws one path from `PATHS` (`frontend/src/components/UI/WarRoomIcon.tsx:11`), and its names are typed as `WrIconName` (`frontend/src/components/UI/WarRoomIcon.tsx:96`). The glyphs the picker needs:

| Glyph | Where |
| --- | --- |
| `building` | `frontend/src/components/UI/WarRoomIcon.tsx:12` |
| `pin` | `frontend/src/components/UI/WarRoomIcon.tsx:46` |
| `map` | `frontend/src/components/UI/WarRoomIcon.tsx:45` |
| `layers` | `frontend/src/components/UI/WarRoomIcon.tsx:59` |
| `train` | Missing; the mockup's station row uses it (`docs/design/warroom/field-ops-setup.html:638`) |

- The lane primitives already exist: `.wr-lane` (`frontend/src/design/warroom.css:976`), `.wr-lanehead` (`frontend/src/design/warroom.css:986`), `.wr-node` (`frontend/src/design/warroom.css:1040`), `.wr-field` (`frontend/src/design/warroom.css:219`), `.wr-btn` (`frontend/src/design/warroom.css:108`), `.wr-lbl` (`frontend/src/design/warroom.css:210`) and `.wr-help` (`frontend/src/design/warroom.css:278`), loaded once from `frontend/src/main.tsx:44`.
- `findCountry` resolves a country name from the shared list (`shared/countries.ts:143-146`). A live session has the status `in_progress` (`server/services/engineTicker.ts:46`).

### 3.8 Where the design sources and the code disagree

| Source says | The code says | This spec |
| --- | --- | --- |
| The map is OpenStreetMap tiles through our own proxy (journey, "What we verified") | True for the map phase only; the edit phase and `SceneSetup` load tiles directly (section 3.3) | Every new map uses the proxy |
| The site saved to the draft includes surrounding footprints and street lines (journey, Design 2 and 6) | No such store exists; the master plan's first principle stores the trainer's choices, not map data | `setup_v2.site` holds the selection only; surroundings are re-read through `loadSiteArea` |
| Bounding-box and name indexes on both tables (brief) | Roads have no name index (section 3.5) | The search index replaces both |
| Primary filled cyan (mockup) | Primary filled navy in the edit phase (section 3.2) | Mockup style, by D28 (section 7.3) |
| Data note "Map data: saved OpenStreetMap for Singapore. Nothing is fetched live." (mockup, `docs/design/warroom/field-ops-setup.html:663`) | Not built | Master 10.8 item 10 copy, which is binding |
| A `train` icon on the station row (mockup) | `WrIcon` has none | WS3 adds `train` to `WrIcon` (section 7.9) |
| Type labels such as "Shopping mall · building" (mockup, `docs/design/warroom/field-ops-setup.html:635-640`) | Rows keep only the raw `building` tag (section 3.5) | A derived `place_class` column (migration 229) |

## 4. Target behaviour and acceptance criteria

### 4.1 What the trainer sees and does

All of this is **Proposed**. The structure and copy follow the mockup's site lane (`docs/design/warroom/field-ops-setup.html:616-735`) except where section 15 lists a difference.

1. **The lane at rest.** Lane 2 of Setup has the illustrated head "The site", the heading "Where", the line "Type an address, landmark or street. The building, its neighbours and the streets are outlined from our saved map data." and a count pill that reads "Not set" until a primary building exists. The map shows Singapore at zoom 12 around 1.2989, 103.855 (the Scene Editor's fallback point) with the data note under the controls.
2. **Searching.** After two characters and 250 ms without typing, the dropdown lists up to eight matches from the saved data: addresses, named buildings and named streets, each with an icon and a type label ("Address · Marina Court Mall", "Shopping mall · building", "Street · click a building after"), and a closing note. Arrow keys move through the rows, Enter picks, Escape closes.
3. **Picking a building or an address with a building.** The map centres on the building and fits a 150 m ring; the building becomes the primary, drawn in cyan; the neighbours inside the ring are amber; the streets are blue centre-lines clipped to the ring; a line under the search box reads "Found in the saved map data · building outline loaded"; the head pill reads "Marina Court Mall · 150 m"; the top-right counter reads "150 m · 14 buildings · 9 streets".
4. **Picking a street, or an address with no building.** The map centres there with the ring, nothing is primary, and the line under the search box reads "Street found in the saved map data · click the building on the map". The first footprint she clicks becomes the primary and the ring re-centres on it.
5. **Radius.** A slider from 50 to 500 m in steps of 10 with minus and plus buttons; it starts at 150 m. Shrinking hides buildings and trims streets at once without asking the server. Expanding beyond what was loaded fetches more 300 ms after she stops.
6. **Buildings involved.** Clicking an amber footprint inside the ring adds it to "Buildings involved" with a role (Car park, Station / transit, Adjacent building or Other, defaulted from the building's class) and its name, or "Unnamed in the map data · name it" with an inline name box. Clicking it again, or its remove button, takes it out. The primary row is cyan and reads "Primary · full interior layout next". A sixth building is refused with "You can add up to 5 buildings besides the primary. Remove one first."
7. **Ghosts.** A building the radar proposed, or one she had involved before shrinking the ring, is drawn as a grey dashed outline when it is outside the ring, and a pill at the top of the map reads "MRT station is 207 m away — outside the radius" with a button "Expand to 220 m", which widens the ring and involves it.
8. **Not on the map.** "Not on the map? Draw it" and "Auto-trace (magic wand)" put the map in draw or trace mode with a strip of instructions and Cancel. A finished outline becomes the primary when there is none; otherwise she chooses "Use as the primary building" or "Add to the buildings involved".
9. **Prefilled by the radar.** When WS2's radar found the document's place in the saved data, WS2 applies the ready selection from `resolveSiteHint` to a draft with no site, so the lane opens with that place picked at 150 m, the involved buildings inside the ring added, and the ones outside shown as ghosts. When the place was ambiguous, its candidates wait in the dropdown; when it was not found, its words wait in the search box with the reason. She can change any of it.
10. **Outside coverage.** If the document's place is outside the saved data, or a point she reaches has no saved data, the map area shows "No saved map data for this area yet" with an explanation and "Search in Singapore instead". Nothing is looked up live (D13). WS2's readiness list keeps its "site missing" blocker, and WS3's note "Your document places the incident outside the saved map data. Set a site in Singapore, or ask an administrator about another area." appears beside it.
11. **Saving.** Every change goes through WS2's draft save, which normalises the selection on the server with WS3's helpers. The readiness list shows the site line, and "Lay out the scene" opens WS4's step with the site loaded.

### 4.2 Acceptance criteria

Test files are listed in section 11; each criterion names the test case that proves it.

- **AC3.1** Given the index holds the building "Marina Court Mall" with the address "1 Marina Way, Singapore 018900" and the street "Marina Court Road", when the trainer searches "marina court", then the results are, in order, the address row, the building row, any other building whose name starts with "marina court", and the street row last, with the type labels "Address · Marina Court Mall", "Shopping mall · building" and "Street · click a building after". Proved by `server/services/fieldOps/site/siteRanking.test.ts (new)`, case "orders an address, its building and a street for a name prefix".
- **AC3.2** Given the same index, when the query is "018900" or "1 marina way", then the address row is first with `match` `exact_address`. Proved by `siteRanking.test.ts`, cases "a postcode puts its address first" and "a house number and street put the address first".
- **AC3.3** Given any query, when it contains `%`, `_`, a backslash or quotes, then the server normalises it, never passes a wildcard to SQL and answers 200 (with no results if nothing is left); a query over 80 characters answers 400 `VALIDATION_FAILED`. Proved by `server/lib/fieldOps/siteSearchText.test.ts (new)`, case "removes wildcards and operators", and `server/routes/fieldOpsSite.test.ts (new)`, cases "search with wildcards answers 200" and "search over 80 characters answers 400".
- **AC3.4** Given the dropdown, when the trainer types one character, then no request is sent; when she types "mar", then exactly one request is sent 250 ms after the last keystroke; when she repeats a query within five minutes, then it is answered from the client cache; when an older request returns after a newer one, then its results are ignored. Proved by `frontend/tests/placeSearchState.test.ts (new)`, cases "below two characters nothing is sent", "debounces to one request", "repeats come from the cache" and "a stale response is dropped".
- **AC3.5** Given migration 230 is not applied, when the trainer searches, then the response has `mode` `names_only`, results come from the `name` columns of the base tables, and nothing fails. Proved by `server/services/fieldOps/site/siteSearch.test.ts (new)`, case "falls back to names only when the index is missing".
- **AC3.6** Given the index is loaded on the shared project, when the search candidates function runs for ten common queries, then the 95th-percentile execution time is under 80 ms with the trigram index and under 150 ms without it. Proved by manual step M7 in section 11.3.
- **AC3.7** Given a building result, when the trainer picks it, then the selection has `radius_m` 150, the building as `primary` with its `osm_id`, `centre` equal to the vertex mean of its polygon, and the area is requested once for that centre. Proved by `frontend/tests/siteLaneState.test.ts (new)`, case "picking a building sets the primary and the default radius", and manual step M2.
- **AC3.8** Given a street result, when the trainer picks it, then there is no primary and the lane prompts her to click a building; when she clicks a footprint, then it becomes the primary and the centre moves to its vertex mean. Proved by `siteLaneState.test.ts`, case "a street pick waits for a footprint click".
- **AC3.9** Given an area loaded at 300 m, when the trainer shrinks to 120 m, then no area request is sent, buildings beyond 120 m are hidden, streets are re-clipped, and involved buildings beyond 120 m are removed, announced and kept as ghosts; when she expands back to 300 m, then no request is sent; when she expands to 450 m, then one request is sent 300 ms after the last change. Proved by `siteLaneState.test.ts`, cases "shrinking is local and drops outside buildings" and "expanding past the loaded radius fetches once".
- **AC3.10** Given the radar proposed "MRT station" 207 m from the primary and the radius is 150 m, then the station is a ghost with the nudge "MRT station is 207 m away — outside the radius" and "Expand to 220 m"; when she presses it, then the radius is 220 m and the station is involved with kind `transit_station`. Proved by `server/lib/fieldOps/site.test.ts (new)`, cases "expandTargetFor rounds 207 m up to 220 m" and "includeBuilding expands and adds", and `siteLaneState.test.ts`, case "a radar ghost expands and joins".
- **AC3.11** Given five involved buildings, when the trainer adds a sixth, then it is refused with reason `limit` and the message from section 7.7; the normaliser refuses six with `SITE_INVOLVED_LIMIT`, which the validate route returns as 400 `VALIDATION_FAILED` with a detail of that code. Proved by `site.test.ts`, cases "includeBuilding refuses a sixth" and "normalise refuses six involved", and `fieldOpsSite.test.ts`, case "validate returns the normaliser's details".
- **AC3.12** Given no primary, when the trainer draws or traces an outline, then it becomes the primary with `osm_id` null; given a primary, then she is asked to choose primary or involved; and the trace never opens the debug pop-up. Proved by `siteLaneState.test.ts`, case "a drawn outline becomes the primary or asks", and manual step M4.
- **AC3.13** Given an input whose primary has `osm_id` `way/1` and a tampered polygon, when it is normalised with a context that holds `way/1`, then the stored footprint and name replace the input's, `centre` is recomputed and `data_version` is stamped from the context. Proved by `site.test.ts`, case "normalise trusts the saved footprint".
- **AC3.14** Given inputs with a repeated closing vertex, two points, 501 points on a custom polygon, a self-intersecting custom polygon, a vertex outside coverage, an involved building beyond the radius, or two involved buildings with the same key, when normalised, then the first succeeds with the warning `closing_vertex_removed` and the others fail with `SITE_POLYGON_INVALID`, `SITE_POLYGON_INVALID`, `SITE_POLYGON_INVALID`, `SITE_OUTSIDE_COVERAGE`, `SITE_INVOLVED_OUTSIDE_RADIUS` and `SITE_INVOLVED_DUPLICATE`. Proved by `site.test.ts`, the "normalise rejects" group.
- **AC3.15** Given a stored draft whose involved building's `osm_id` is no longer in the saved data, when it is normalised, then the building is kept as a custom polygon with the warning `building_not_in_saved_data`. Proved by `site.test.ts`, case "a vanished building becomes custom".
- **AC3.16** Given one ring rotated and reversed, then `ringFingerprint` is the same; given a new place label or a renamed primary, then `siteFingerprint` is the same; given a radius change, an involved kind change or an involved building relabelled, then `siteFingerprint` changes. Proved by `site.test.ts`, the "fingerprints" group.
- **AC3.17** Given the fixture site in section 11.2, when `siteToLegacyLocation` runs, then it returns the fixture's `location`, `venue_name`, `geocode_override` and centre exactly. Proved by `site.test.ts`, case "maps a site to the legacy location fields".
- **AC3.18** Given a radar hint with the country "Malaysia", or coordinates outside every coverage box, when it is resolved, then the status is `outside_coverage`, the lane shows "No saved map data for this area yet", and no area request is sent; an area request outside coverage answers 200 with `coverage` `outside_bbox` and empty lists. Proved by `server/services/fieldOps/site/siteHint.test.ts (new)`, case "outside coverage by country or coordinates", `server/services/fieldOps/site/siteArea.test.ts (new)`, case "outside the boxes returns an empty area", and `siteLaneState.test.ts`, case "an outside hint stops the lane".
- **AC3.19** Given 2,000 buildings within the fetched radius, when the area is shaped, then the nearest 1,500 are returned with `truncated` true, every polygon has at most 500 vertices, every street segment at most 400 points, and the serialised area is at most 1.5 MB. Proved by `siteArea.test.ts`, case "caps buildings, vertices and size".
- **AC3.20** Given `ENABLE_FIELDOPS_V2` is off, then every site route answers 404 `{ "error": "Not found" }`; given it is on, a request without a token answers 401 and a signed-in participant answers 403 `FORBIDDEN`. Proved by `fieldOpsSite.test.ts`, cases "flag off answers 404", "no token answers 401" and "a participant answers 403".
- **AC3.21** Given one trainer, when she sends 121 searches within a minute, then the last answers 429 `RATE_LIMITED` and other trainers are unaffected. Proved by `fieldOpsSite.test.ts`, case "the search limit is per user".
- **AC3.22** Given the files WS3 creates and the new client tree, when the static test runs, then it fails on any Overpass, Nominatim or Google host, any direct OpenStreetMap tile host, any import of `osmVicinityService` or `geocodingService`, and any call to the diagnostic route. Proved by `server/lib/fieldOps/siteNoLiveProviders.test.ts (new)`, cases "the scanned tree is clean" and "the scanner catches a planted host".
- **AC3.23** Given the tile proxy, when `z`, `x` or `y` is not an integer in range, then it answers 400 without calling upstream; when upstream takes over eight seconds, then 504; when the same tile is asked for twice, then upstream is called once; and every upstream request carries the identifying User-Agent. Proved by `server/routes/tileProxy.test.ts (new)`, cases "rejects bad tile numbers", "times out", "caches" and "identifies itself".
- **AC3.24** Given the importer, when it runs without `--apply`, then it writes nothing; when `--project-ref` does not match `SUPABASE_URL`, then it refuses; when a session is `in_progress`, then it refuses unless `--allow-live-sessions` is given; when a sweep would leave fewer than 90 per cent of the previous version's rows, then it refuses. Proved by `server/lib/fieldOps/osmImportGuard.test.ts (new)`, the "guard" group.
- **AC3.25** Given extract features, when the generator's pure helpers run, then a building with its own address tags gets `addr_source` `way`, a building containing an address point gets `node`, "S018900" becomes "018900", facility tags map to the kinds of section 6.11, and the search rows, street clusters and importance values match the fixture. Proved by `server/lib/fieldOps/osmExtract.test.ts (new)`.
- **AC3.26** Given an active version with a source timestamp of 2 Nov 2026, then the data note reads "Map data: saved OpenStreetMap for Singapore. Extract of 2 Nov 2026."; given the legacy version, it reads "Map data: saved OpenStreetMap for Singapore.". Proved by `site.test.ts`, case "the data note adds the extract date when known".
- **AC3.27** Given a centre and a 5 km radius, when `listFacilitiesNear` runs, then it returns at most 50 facilities per kind, nearest first, each with a distance; given migration 232 is missing, then it returns `status` `unavailable`. Proved by `server/services/fieldOps/site/facilities.test.ts (new)`.
- **AC3.28** Given the hint `{ place_text: "Marina Court Mall", involved: [car park next door, the MRT station] }`, when `resolveSiteHint` runs, then the status is `resolved` with the mall's footprint; the car park at 82 m is `inside_radius` and in `selection.involved`; the station at 207 m is outside with `expand_to` 220 and not in the selection; and `selection` passes `normaliseSiteSelection` with radius 150. Given two candidates with equal rank, the status is `ambiguous` with both and no selection; given nothing, `not_found`. Proved by `siteHint.test.ts`, cases "resolves the place and builds the selection", "two equal matches are ambiguous" and "no match is not found".
- **AC3.29** Given a keyboard-only user, when she uses the lane, then she can search, pick, change the radius, add a building inside the ring from the "Add a building inside the radius" list, change a role and remove a building without a pointer. Proved by manual step M8.
- **AC3.30** Given `ENABLE_FIELDOPS_V2` is off and migrations 229 to 232 are applied, when a trainer uses the legacy wizard, then the Scene Editor's map phase, Fetch Buildings and the local cache behave exactly as before. Proved by manual step M9.
- **AC3.31** Given the radar's resolution with a ready selection, when `SiteLane` receives it as `proposal`, with no site, after the trainer cleared the site, or with a site set, then the lane leaves the site as it is: only WS2's merge applies a radar selection, and only to a draft with no site. Proved by `frontend/tests/siteLaneState.test.ts (new)`, case "the lane never applies the radar's site".
- **AC3.32** **Added 3 Nov 2026.** Given an active data version whose `region` is 'SG', when `getSiteCoverage` or `buildSiteSelectionContext` runs, then `data_version.region` is 'SG'; given migration 229 missing, `data_version` is null, and WS1's `defaultAgencyCountry` falls back to its own 'SG'. Proved by `siteArea.test.ts`, case "the data version reports its region".

## 5. Data model

### 5.1 What is stored where

| Data | Where | Owner |
| --- | --- | --- |
| The trainer's site choice (`SiteSelection`) | `warroom_wizard_drafts.setup_v2.site` (WS2's migration 226). Nothing is added to the draft by WS3 | Contract WS3, column WS2 |
| Buildings, roads, addresses, place classes | `osm_sg_buildings`, `osm_sg_roads` plus the columns of migration 229 | WS3 |
| Which extract is loaded | `osm_sg_data_versions` (migration 229) | WS3 |
| The type-ahead index | `osm_sg_search_index` (migration 230) | WS3 |
| The area read | `fieldops_site_area` (migration 231) | WS3 |
| Facilities for the area dossier | `osm_sg_facilities` (migration 232) | WS3 (read by WS5) |

**Proposed.** The draft keeps the selection only: the centre, the radius, the primary and involved polygons and their names. The surrounding footprints and streets are read again from the saved tables whenever a screen needs them (master section 4). The primary and involved polygons are copied into the selection on purpose, so that a later re-import never moves a building the trainer has already laid out.

### 5.2 The contract: `shared/fieldOps/site.ts (new)`

Owned by WS3. Types, constants and pure helpers only; it imports nothing outside `shared/` (master 10.7). The zod schemas that mirror these types are in section 6.2.

```ts
// shared/fieldOps/site.ts (new). Owned by WS3. Imports only from shared/.
import type { InvolvedBuildingKind } from './vocabulary.js'; // WS1, master 10.1
import type { ReadinessRule } from './readiness.js'; // WS2, 03-setup-screen.md section 5.6
import type { FacilityKind, PlaceClass, SiteResultIcon } from './sitePlaces.js';

/** [lat, lng]: the order of the saved tables and the Scene Editor (master 10.1). */
export type LatLng = [number, number];

export interface BuildingRef {
  /** 'way/123' or 'relation/456' from osm_sg_buildings; null for a polygon the trainer drew or traced. */
  osm_id: string | null;
  /** The OpenStreetMap name, or the trainer's name for a custom polygon. At most 120 characters. */
  name: string | null;
  /** A closed ring stored open: 3 to 500 vertices, first vertex not repeated at the end, source order kept. */
  polygon: LatLng[];
}

export type InvolvedBuildingRef = BuildingRef & {
  kind: InvolvedBuildingKind; // car_park | transit_station | adjacent | other
  label: string; // what the trainer calls it: 1 to 80 characters
};

export interface SiteAddress {
  house_number: string | null; // at most 20 characters
  street: string | null; // at most 120 characters
  postcode: string | null; // six digits
  city: string | null; // at most 60 characters
  line: string; // display line, at most 200 characters, built by addressLine()
}

export interface SiteSelection {
  place_label: string; // 1 to 160 characters: the result the trainer picked
  centre: LatLng; // always the vertex mean of primary.polygon (P3), recomputed by the server
  radius_m: number; // integer from 50 to 500, default 150
  primary: BuildingRef;
  involved: InvolvedBuildingRef[]; // at most 5 (D15), each touching the ring
  source: 'saved_osm';
  address?: SiteAddress | null; // present when the pick was an address
  data_version?: string | null; // label of the data version active when the server last normalised it
}

export const SITE_LIMITS = {
  radiusMin: 50,
  radiusMax: 500,
  radiusDefault: 150,
  radiusStep: 10,
  maxInvolved: 5, // D15
  polygonMinPoints: 3,
  polygonMaxPoints: 500,
  polygonMinAreaM2: 4,
  coordinateDecimals: 7,
  placeLabelMax: 160,
  buildingNameMax: 120,
  involvedLabelMax: 80,
  searchMinChars: 2,
  substringMinChars: 3,
  searchMaxChars: 80,
  searchDebounceMs: 250,
  searchResultLimit: 8,
  searchStreetCap: 3,
  areaPrefetchMarginM: 100,
  areaFetchMaxM: 600,
  areaMaxBuildings: 1500,
  areaMaxStreets: 800,
  areaMaxStreetPoints: 400,
  areaMaxResponseBytes: 1_500_000,
  expandMarginM: 10,
  facilityRadiusDefaultM: 5000,
  facilityRadiusMaxM: 10000, // WS5 widens hospitals to 10 km
  facilityMaxPerKind: 50,
} as const;

export interface CoverageBox {
  min_lat: number;
  max_lat: number;
  min_lng: number;
  max_lng: number;
}
/** Extent of the saved tables measured on 24 Oct 2026. Used only when no active data version records one. */
export const SITE_COVERAGE_FALLBACK: CoverageBox = {
  min_lat: 1.235,
  max_lat: 1.508,
  min_lng: 103.593,
  max_lng: 104.055,
};
export const SITE_COVERAGE_STATES = ['inside', 'outside_bbox', 'no_data_nearby'] as const;
export type SiteCoverageState = (typeof SITE_COVERAGE_STATES)[number];

export interface SiteDataVersion {
  label: string; // osm_sg_data_versions.label, for example 'sg-2026-11-02'
  extract_date: string | null; // 'YYYY-MM-DD' (UTC) of the extract, null when unknown
  region: string; // added 3 Nov 2026: osm_sg_data_versions.region, 'SG' today; WS1's defaultAgencyCountry reads it (D29)
}
export const SITE_DATA_NOTE = 'Map data: saved OpenStreetMap for Singapore.'; // master 10.8 item 10
/** SITE_DATA_NOTE, plus " Extract of 2 Nov 2026." when the extract date is known. */
export declare function siteDataNote(version: SiteDataVersion | null): string;

// ---- search ----
export const SITE_RESULT_KINDS = ['address', 'building', 'street'] as const;
export type SiteResultKind = (typeof SITE_RESULT_KINDS)[number];
export const SITE_MATCH_TIERS = ['exact_address', 'name_prefix', 'word_prefix', 'substring', 'street'] as const;
export type SiteMatchTier = (typeof SITE_MATCH_TIERS)[number];
export const SITE_SEARCH_MODES = ['index', 'index_no_trigram', 'names_only'] as const;
export type SiteSearchMode = (typeof SITE_SEARCH_MODES)[number];

export interface SiteSearchResult {
  id: string; // 'a:way/123:0', 'b:way/123', 's:marina way:0'
  kind: SiteResultKind;
  label: string; // first line, for example '1 Marina Way, Singapore 018900'
  type_label: string; // second line, for example 'Address · Marina Court Mall'
  icon: SiteResultIcon;
  centre: LatLng;
  building_osm_id: string | null; // the building an address or building result selects
  place_class: PlaceClass | null;
  address: SiteAddress | null;
  match: SiteMatchTier;
}
export interface SiteSearchResponse {
  results: SiteSearchResult[]; // at most SITE_LIMITS.searchResultLimit
  mode: SiteSearchMode;
  data_version: SiteDataVersion | null;
}

// ---- the area around a site ----
export interface SiteAreaBuilding {
  osm_id: string;
  name: string | null;
  polygon: LatLng[]; // at most 500 vertices (simplifyRing)
  centroid: LatLng; // vertex mean
  distance_m: number; // from the request centre to the polygon, 0 when inside, rounded to 0.1 m
  place_class: PlaceClass | null;
  type_label: string; // 'Car park', 'Shopping mall', 'Building'
  address_line: string | null;
  levels: number | null;
  height_m: number | null;
}
export interface SiteAreaRoad {
  osm_id: string;
  name: string | null;
  highway: string; // one of the generator's 14 highway types (WS4's request R4.1 names it so)
  segments: LatLng[][]; // clipped to fetched_radius_m; each segment has 2 to 400 points
  distance_m: number;
}
export interface SiteArea {
  centre: LatLng;
  radius_m: number; // the radius asked for
  fetched_radius_m: number; // radius_m + areaPrefetchMarginM, at most areaFetchMaxM
  coverage: SiteCoverageState;
  buildings: SiteAreaBuilding[]; // nearest first, distance_m <= fetched_radius_m
  roads: SiteAreaRoad[]; // the streets, nearest first
  truncated: boolean;
  data_version: SiteDataVersion | null;
  source: 'area_function' | 'table_scan';
}

// ---- the radar's place words (master 10.8 item 10; WS2's request R8) ----
/** WS2's SiteProposal fields, plus the country WS2's guard rail derives (03, section 8.5) and coordinates, which version 1 never sends. */
export interface SiteHint {
  place_text: string; // the document's words for the main place, at most 120 characters
  involved: Array<{ text: string; kind_hint: InvolvedBuildingKind | null }>; // at most 8
  country?: string | null; // a country name from shared/countries.ts when the document states one
  coords?: LatLng | null; // only when the document itself states coordinates
}
export const SITE_HINT_STATUSES = ['resolved', 'ambiguous', 'not_found', 'outside_coverage', 'unavailable'] as const;
export type SiteHintStatus = (typeof SITE_HINT_STATUSES)[number];
export interface SiteHintBuilding {
  osm_id: string;
  name: string | null;
  polygon: LatLng[];
  place_class: PlaceClass | null;
}
export interface SiteInvolvedResolution {
  text: string; // the hint's words
  kind: InvolvedBuildingKind; // kind_hint, else defaultInvolvedKind(place_class)
  status: Exclude<SiteHintStatus, 'outside_coverage'>;
  result: SiteSearchResult | null;
  building: SiteHintBuilding | null;
  distance_m: number | null; // from the primary's centre to this footprint, rounded to a metre
  inside_radius: boolean; // distance_m <= SITE_LIMITS.radiusDefault
  expand_to: number | null; // expandTargetFor(distance_m) when outside, null when inside or too far
}
export interface SiteHintResolution {
  place_text: string; // the hint's place_text, echoed so the lane can prefill the search box
  status: SiteHintStatus; // for the main place
  reason: string; // one sentence for the trainer, from SITE_HINT_REASONS
  best: SiteSearchResult | null;
  candidates: SiteSearchResult[]; // at most 5, ranked
  building: SiteHintBuilding | null; // the primary footprint best selects, when it selects one
  involved: SiteInvolvedResolution[]; // one per hint.involved item, same order
  selection: SiteSelection | null; // ready to apply when status is 'resolved': radius 150, inside-radius buildings involved
}

// ---- coverage and facilities ----
export interface SiteCoverageResponse {
  boxes: CoverageBox[];
  data_version: SiteDataVersion | null;
  data_note: string; // siteDataNote(data_version)
  point: { lat: number; lng: number; state: SiteCoverageState } | null;
}
export interface FacilityRef {
  osm_id: string;
  kind: FacilityKind;
  name: string | null;
  lat: number;
  lng: number;
  distance_m: number; // from the requested centre, rounded to a metre
  operator: string | null;
  emergency: string | null; // the raw emergency tag, for example 'yes' on a hospital with an emergency department
  healthcare: string | null;
  address_line: string | null;
}
export type FacilitiesNearResult =
  | { status: 'ok'; facilities: FacilityRef[]; data_version: SiteDataVersion | null }
  | { status: 'outside_coverage' }
  | { status: 'unavailable' };

// ---- validation ----
export const SITE_ERROR_CODES = [
  'SITE_INVALID',
  'SITE_POLYGON_INVALID',
  'SITE_OUTSIDE_COVERAGE',
  'SITE_INVOLVED_LIMIT',
  'SITE_INVOLVED_DUPLICATE',
  'SITE_INVOLVED_OUTSIDE_RADIUS',
] as const;
export type SiteErrorCode = (typeof SITE_ERROR_CODES)[number];
export const SITE_WARNING_CODES = ['building_not_in_saved_data', 'polygon_simplified', 'closing_vertex_removed'] as const;
export type SiteWarningCode = (typeof SITE_WARNING_CODES)[number];
export interface SiteIssue {
  path: string; // 'primary.polygon', 'involved.2.label'
  code: SiteErrorCode | SiteWarningCode;
  message: string; // a sentence for the trainer
}
export interface SiteSelectionContext {
  buildings: ReadonlyMap<string, { osm_id: string; name: string | null; polygon: LatLng[] }>;
  coverage: readonly CoverageBox[];
  data_version: SiteDataVersion | null;
}
export type NormaliseSiteResult =
  | { ok: true; site: SiteSelection; warnings: SiteIssue[]; fingerprint: string }
  | { ok: false; code: SiteErrorCode; message: string; details: SiteIssue[] };

// ---- the legacy shape compile reads (section 6.10) ----
export interface LegacyLocationFields {
  location: string;
  venue_name: string | null;
  geocode_override: { lat: number; lng: number; display_name: string };
  center_lat: number;
  center_lng: number;
}

// ---- readiness (section 6.10): WS2 owns the "site missing" and "site set" rows; these add WS3's notes ----
export declare const siteReadinessRules: readonly ReadinessRule[];

export declare function normaliseSiteSelection(input: unknown, ctx: SiteSelectionContext): NormaliseSiteResult;
export declare function validateSiteSelectionShape(input: unknown): SiteIssue[];
export declare function ringFingerprint(polygon: readonly LatLng[]): string; // 'r1_' + 16 hex digits
export declare function siteFingerprint(site: SiteSelection): string; // 's1_' + 16 hex digits
export declare function siteToLegacyLocation(site: SiteSelection): LegacyLocationFields;
export declare function involvedKey(ref: BuildingRef): string; // osm_id, else ringFingerprint(polygon)
export declare function expandTargetFor(distanceM: number): number | null; // null when beyond radiusMax
export declare function includeBuilding(
  site: SiteSelection,
  building: InvolvedBuildingRef,
  distanceM: number,
): { ok: true; site: SiteSelection; expandedTo: number | null } | { ok: false; reason: 'limit' | 'too_far' | 'duplicate' | 'is_primary' };
export declare function removeInvolved(site: SiteSelection, key: string): SiteSelection;
export declare function applyRadius(
  site: SiteSelection,
  radiusM: number,
  distanceOf: (b: BuildingRef) => number,
): { site: SiteSelection; dropped: InvolvedBuildingRef[] };
/** WS2's request R9: add (on) or remove (off) an involved building, widening the radius when needed. */
export declare function toggleInvolved(
  site: SiteSelection,
  building: InvolvedBuildingRef,
  distanceM: number,
  on: boolean,
): ReturnType<typeof includeBuilding>;
export declare function describeSite(site: SiteSelection): {
  title: string;
  radius: string;
  buildings: string;
  summary: string;
  readiness: string;
};
export declare function addressLine(a: Omit<SiteAddress, 'line'>): string;
export declare function defaultInvolvedKind(placeClass: PlaceClass | null): InvolvedBuildingKind;
export declare const INVOLVED_KIND_LABELS: Readonly<Record<InvolvedBuildingKind, string>>;
export declare const SITE_HINT_REASONS: Readonly<Record<SiteHintStatus, string>>;
```

`declare` marks a function the implementer writes in the same file; the behaviour of each is specified in sections 6 and 7. The exact rules:

| Helper | Behaviour |
| --- | --- |
| `siteDataNote` | Returns `SITE_DATA_NOTE` alone, or followed by `" Extract of 2 Nov 2026."` with the date in `en-GB` day, short month and year, read as UTC. |
| `ringFingerprint` | Stable: the `r1_` prefix names the algorithm, and any change to it takes a new prefix. Cleans the ring with `cleanRing`, rounds each coordinate to 6 decimals, reverses it if it is clockwise in the lng-lat plane, rotates it so the vertex with the smallest latitude (then longitude) comes first, joins the vertices as `lat,lng` with `;`, and returns `'r1_'` plus the FNV-1a 64-bit hash of that text as 16 lower-case hex digits (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, over the string's code units, which are all ASCII). It never reorders the stored polygon: only the hash input is canonical, so a stored ring and its `edgeIndex` references stay as they are. |
| `siteFingerprint` | `'s1_'` plus the same hash of `s1`, the centre rounded to 6 decimals, `radius_m`, `ringFingerprint(primary.polygon)` and the sorted list of `ringFingerprint(b.polygon) + ':' + b.kind + ':' + b.label` for the involved buildings, joined by `|`. It covers exactly what WS4's site-change diff can classify (WS4's request R4.1): the centre and radius (`radius_only`), the primary ring (`primary_changed`), and the involved buildings with their kinds and labels (`involved_only`, including relabels). The place label, the primary's name, the address and the data version are left out, so renaming the site or its primary never invalidates a layout. |
| `siteToLegacyLocation` | `location` is `address.line` when an address is present, else `place_label`; `venue_name` is `primary.name`, else `place_label`; `geocode_override` and `center_lat`, `center_lng` use the vertex mean of the primary polygon, the same point the legacy wizard sent (`frontend/src/pages/WarRoom.tsx:431-448`) and the sim-space origin; `display_name` is `primary.name ?? place_label`. |
| `involvedKey` | The `osm_id` when present, otherwise `ringFingerprint(polygon)`. Used as the row key in the list and for de-duplication. |
| `expandTargetFor` | `ceil((distanceM + expandMarginM) / radiusStep) * radiusStep`, so 207 m gives 220 m as in the mockup (`docs/design/warroom/field-ops-setup.html:727`); `null` when the result exceeds `radiusMax`. |
| `includeBuilding` | Refuses the primary (`is_primary`), a duplicate key (`duplicate`), a sixth building (`limit`) and anything beyond `radiusMax` (`too_far`); otherwise appends the building and, when `distanceM` is beyond `radius_m`, raises the radius to `expandTargetFor(distanceM)` and reports it as `expandedTo`. |
| `applyRadius` | Clamps to 50 to 500 in steps of 10, then removes and returns every involved building whose distance is beyond the new radius (P6). |
| `siteReadinessRules` | Three rules for WS2's registry (`03-setup-screen.md` section 5.6), lane `site`, owner `WS3`, item ids `<rule>:<subject>`, reading only the setup. `site.document_outside` (info): no site is set and `setup.footprint.site.resolution_status` is `outside_coverage`; "Your document places the incident outside the saved map data. Set a site in Singapore, or ask an administrator about another area."; field `fo:site:search`. `site.drawn_outline` (info, one per custom polygon): "<name> was drawn by you, not taken from the saved map data."; field `fo:site:primary` or `fo:site:involved:<key>`. `site.unnamed_involved` (info, one per involved building with no name whose label is still its kind's label): "Name <label> so players can tell the buildings apart."; field `fo:site:involved:<key>`. Every item has `gate` null, `where` "The site" and the action `{ kind: 'jump', label: 'Go to the site' }`. WS2's own rules keep `site.missing` and `site.ok`. |
| `toggleInvolved` | `on` calls `includeBuilding`; off calls `removeInvolved` and returns `{ ok: true, site, expandedTo: null }`. WS2's outside-radius chip passes `SiteInvolvedResolution.distance_m` (request R9). |
| `describeSite` | `title` is `place_label`; `radius` is `'150 m radius'`; `buildings` is `'2 buildings involved · 1 full layout'` (counting the primary, as in the layout step's site bar, `docs/design/warroom/field-ops-setup.html:1023-1024`); `summary` is `'<title> · saved map data · <radius>'`; `readiness` is "Site set from the saved map data: <place_label> plus <n> involved building(s), <radius> m." (the mockup's wording, `docs/design/warroom/field-ops-setup.html:918`), with "plus no other buildings" when there are none, for WS2's `site.ok` row. |
| `addressLine` | `'<house number> <street>, <city or Singapore> <postcode>'`, leaving out missing parts and their separators: `'1 Marina Way, Singapore 018900'`, `'Marina Way, Singapore'`, `'Singapore 018900'`. |
| `defaultInvolvedKind` | `car_park` for the `car_park` class, `transit_station` for `transit_station`, otherwise `adjacent`. |
| `INVOLVED_KIND_LABELS` | `car_park` 'Car park', `transit_station` 'Station / transit', `adjacent` 'Adjacent building', `other` 'Other' (the mockup's role list, `docs/design/warroom/field-ops-setup.html:1291`). |
| `SITE_HINT_REASONS` | Section 6.8. |

### 5.3 Place classes, geometry and search text

Three more shared modules, all owned by WS3 and free of imports outside `shared/`.

```ts
// shared/fieldOps/sitePlaces.ts (new). Owned by WS3.
export const PLACE_CLASSES = [
  'mall', 'car_park', 'transit_station', 'apartments', 'house', 'office', 'retail', 'hotel',
  'hospital', 'clinic', 'school', 'university', 'place_of_worship', 'government', 'police',
  'fire_station', 'stadium', 'community_centre', 'industrial', 'warehouse', 'airport',
] as const;
export type PlaceClass = (typeof PLACE_CLASSES)[number];
export const SITE_RESULT_ICONS = ['pin', 'building', 'layers', 'train', 'map'] as const;
export type SiteResultIcon = (typeof SITE_RESULT_ICONS)[number];
export declare const PLACE_CLASS_LABELS: Readonly<Record<PlaceClass, string>>;
export declare const PLACE_CLASS_ICONS: Readonly<Record<PlaceClass, SiteResultIcon>>;
/** Deterministic: the first rule that matches wins; null for a generic building. */
export declare function placeClassFromTags(tags: Readonly<Record<string, string | undefined>>): PlaceClass | null;
/** 'Shopping mall · building', or 'Building' when the class is null. */
export declare function buildingTypeLabel(placeClass: PlaceClass | null): string;

export const FACILITY_KINDS = [
  'hospital', 'clinic', 'police', 'fire_station', 'ambulance_station',
  'fuel_station', 'power_substation', 'surveillance_camera',
] as const;
export type FacilityKind = (typeof FACILITY_KINDS)[number];
```

`placeClassFromTags` applies these rules in order; the first match wins:

| Order | Tags | Class | Label | Icon |
| --- | --- | --- | --- | --- |
| 1 | `aeroway=terminal` | `airport` | Airport terminal | `building` |
| 2 | `railway=station`, `public_transport=station`, `building=train_station`, or `station` is `subway` or `light_rail` | `transit_station` | Station | `train` |
| 3 | `amenity=parking`, `building=parking`, or `parking=multi-storey` | `car_park` | Car park | `layers` |
| 4 | `shop=mall` or `shop=department_store` | `mall` | Shopping mall | `building` |
| 5 | `amenity=hospital`, `healthcare=hospital` or `building=hospital` | `hospital` | Hospital | `building` |
| 6 | `amenity` is `clinic` or `doctors`, or `healthcare` is `clinic` or `centre` | `clinic` | Clinic | `building` |
| 7 | `amenity=school` or `building=school` | `school` | School | `building` |
| 8 | `amenity` is `university` or `college`, or `building=university` | `university` | University | `building` |
| 9 | `amenity=place_of_worship`, or `building` is `church`, `mosque`, `temple`, `chapel`, `cathedral`, `shrine`, `synagogue` or `religious` | `place_of_worship` | Place of worship | `building` |
| 10 | `amenity=police` | `police` | Police station | `building` |
| 11 | `amenity=fire_station` | `fire_station` | Fire station | `building` |
| 12 | `tourism=hotel` or `building=hotel` | `hotel` | Hotel | `building` |
| 13 | `leisure=stadium` or `building=stadium` | `stadium` | Stadium | `building` |
| 14 | `amenity=community_centre` | `community_centre` | Community centre | `building` |
| 15 | `office=government`, or `building` is `government` or `public` | `government` | Government building | `building` |
| 16 | `building` is `apartments` or `residential` | `apartments` | Apartments | `building` |
| 17 | `building` is `house`, `detached`, `terrace` or `semidetached_house` | `house` | House | `building` |
| 18 | `building=office` or any `office` tag | `office` | Office | `building` |
| 19 | `building` is `industrial`, `factory` or `manufacture` | `industrial` | Industrial | `building` |
| 20 | `building=warehouse` | `warehouse` | Warehouse | `building` |
| 21 | `building` is `commercial` or `retail`, or any `shop` tag | `retail` | Shops | `building` |

The mall, car park, station and apartments rows give exactly the mockup's labels and icons (`docs/design/warroom/field-ops-setup.html:635-640`); the mockup draws the mall with the generic building glyph, so the class icon follows it.

```ts
// shared/fieldOps/siteGeometry.ts (new). Owned by WS3. Local equirectangular metres, 111,320 m per degree,
// the constants of frontend/src/lib/evacuation/geometry.ts.
import type { CoverageBox, LatLng } from './site.js';
export declare function toLocalMetres(origin: LatLng, p: LatLng): { x: number; y: number }; // x east, y south
export declare function polygonVertexMean(polygon: readonly LatLng[]): LatLng; // the sim-space origin
export declare function pointInPolygon(p: LatLng, polygon: readonly LatLng[]): boolean; // even-odd rule
export declare function distanceToPolygonM(p: LatLng, polygon: readonly LatLng[]): number; // 0 inside, else nearest edge
export declare function distanceToPolylineM(p: LatLng, line: readonly LatLng[]): number;
export declare function polygonAreaM2(polygon: readonly LatLng[]): number;
export declare function isSelfIntersecting(polygon: readonly LatLng[]): boolean; // non-adjacent edges that cross
export declare function cleanRing(polygon: readonly LatLng[]): {
  ring: LatLng[]; // rounded to 7 decimals, consecutive duplicates and the closing repeat removed
  removedClosing: boolean;
  removedDuplicates: number;
};
/** Douglas-Peucker in local metres with epsilon 0.25, 0.5, 1, 2, 4 and 8 m until the ring has maxPoints or fewer. */
export declare function simplifyRing(polygon: readonly LatLng[], maxPoints: number): { ring: LatLng[]; simplified: boolean };
/** Douglas-Peucker on an open line, same epsilon steps, until it has maxPoints or fewer; the end points are kept. */
export declare function simplifyLine(line: readonly LatLng[], maxPoints: number): LatLng[];
/** The parts of a polyline inside a circle, as separate segments; nothing outside the circle is returned. */
export declare function clipPolylineToCircle(line: readonly LatLng[], centre: LatLng, radiusM: number): LatLng[][];
export declare function insideCoverage(p: LatLng, boxes: readonly CoverageBox[], marginDeg?: number): boolean; // margin default 0.002
```

`clipPolylineToCircle` uses the same circle-segment intersection as `clipRoadPolylineToRadius` (`frontend/src/components/SceneEditor/SceneEditor.tsx:174-275`) with two deliberate differences: a street that leaves and re-enters the ring comes back as two segments instead of being joined by a straight chord, and a street with no part inside comes back empty instead of whole (the Scene Editor returns the unclipped coordinates when fewer than two points survive, `frontend/src/components/SceneEditor/SceneEditor.tsx:274`). The colours and weights are unchanged; only the geometry is more faithful.

```ts
// shared/fieldOps/siteSearchText.ts (new). Owned by WS3. One normaliser for the generator, the server and the browser.
/** NFKD, strip combining marks, lower-case, delete apostrophes, every run of other non-letters and non-digits becomes
 *  one space, trim, cut to 80 characters. "St. Andrew's Cathedral" becomes "st andrews cathedral". */
export declare function normaliseSearchText(input: string): string;
export declare function searchTokens(normalised: string): string[]; // split on spaces, empties dropped, at most 6
export declare function looksLikePostcode(normalised: string): boolean; // exactly six digits
export declare function cleanPostcode(raw: string | null | undefined): string | null; // the first run of exactly six digits
```

Because `normaliseSearchText` keeps only letters, digits and single spaces, a normalised query can never contain a `LIKE` wildcard or a text-search operator. The SQL in migration 230 still escapes both, as a second line of defence.

### 5.4 Migrations

The four files are applied in order. Each is idempotent, additive, keeps RLS on with no permissive policy, and revokes its functions from browser roles. All three environments share one Supabase project (finding 17.17), so each must be safe for code already running: the legacy local-cache code selects explicit columns (section 3.6), so new columns never change what it reads.

**229: data versions, addresses and place classes.**

```sql
-- migrations/229_osm_sg_addresses_and_versions.sql (WS3)
-- Records which OpenStreetMap extract is loaded, and adds address, place-class, tag and
-- version columns to the saved tables. Additive and idempotent; safe to re-run.
-- Requires migrations/193_singapore_local_osm_cache.sql.
-- Before it is applied, the site routes detect the missing columns and serve names only.
-- Rollback, only while no deployed code reads these objects:
--   DROP FUNCTION IF EXISTS public.fieldops_osm_activate_version(text);
--   ALTER TABLE public.osm_sg_roads DROP COLUMN IF EXISTS data_version_id;
--   ALTER TABLE public.osm_sg_buildings DROP COLUMN IF EXISTS data_version_id, DROP COLUMN IF EXISTS osm_tags,
--     DROP COLUMN IF EXISTS place_class, DROP COLUMN IF EXISTS addr_source, DROP COLUMN IF EXISTS addr_city,
--     DROP COLUMN IF EXISTS addr_postcode, DROP COLUMN IF EXISTS addr_street, DROP COLUMN IF EXISTS addr_housenumber;
--   DROP TABLE IF EXISTS public.osm_sg_data_versions;

CREATE TABLE IF NOT EXISTS public.osm_sg_data_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  region text NOT NULL DEFAULT 'SG' CHECK (region ~ '^[A-Z]{2}$'),
  status text NOT NULL DEFAULT 'importing'
    CHECK (status IN ('importing', 'verified', 'active', 'superseded', 'failed')),
  source_name text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 200),
  source_timestamp timestamptz,
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  generator_version text NOT NULL CHECK (char_length(generator_version) BETWEEN 1 AND 40),
  coverage jsonb CHECK (coverage IS NULL OR jsonb_typeof(coverage) = 'object'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  operator_note text CHECK (operator_note IS NULL OR char_length(operator_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz
);

COMMENT ON TABLE public.osm_sg_data_versions IS
  'One row per import of the saved OpenStreetMap extract (WS3). At most one active row per region.';
COMMENT ON COLUMN public.osm_sg_data_versions.source_timestamp IS
  'Replication timestamp of the extract, from osmium fileinfo; null when the file does not carry one.';
COMMENT ON COLUMN public.osm_sg_data_versions.coverage IS
  'Measured extent of the imported rows: {"min_lat","max_lat","min_lng","max_lng"}.';
COMMENT ON COLUMN public.osm_sg_data_versions.counts IS
  'Row and address counts written by the importer, see the runbook in 04-site-picker.md section 6.11.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_osm_sg_data_versions_active_region
  ON public.osm_sg_data_versions (region)
  WHERE status = 'active';

ALTER TABLE public.osm_sg_data_versions ENABLE ROW LEVEL SECURITY;

-- The rows already loaded were imported before versions existed.
INSERT INTO public.osm_sg_data_versions
  (label, region, status, source_name, generator_version, operator_note, activated_at)
SELECT 'sg-legacy', 'SG', 'active', 'Singapore extract imported before migration 229', 'sg-osm-1',
       'Date and source were not recorded; source_updated_at is null on every row.', now()
WHERE NOT EXISTS (SELECT 1 FROM public.osm_sg_data_versions WHERE region = 'SG');

ALTER TABLE public.osm_sg_buildings
  ADD COLUMN IF NOT EXISTS addr_housenumber text
    CHECK (addr_housenumber IS NULL OR char_length(addr_housenumber) <= 20),
  ADD COLUMN IF NOT EXISTS addr_street text
    CHECK (addr_street IS NULL OR char_length(addr_street) <= 120),
  ADD COLUMN IF NOT EXISTS addr_postcode text
    CHECK (addr_postcode IS NULL OR addr_postcode ~ '^[0-9]{6}$'),
  ADD COLUMN IF NOT EXISTS addr_city text
    CHECK (addr_city IS NULL OR char_length(addr_city) <= 60),
  ADD COLUMN IF NOT EXISTS addr_source text
    CHECK (addr_source IS NULL OR addr_source IN ('way', 'node')),
  ADD COLUMN IF NOT EXISTS place_class text
    CHECK (place_class IS NULL OR place_class ~ '^[a-z_]{2,40}$'),
  ADD COLUMN IF NOT EXISTS osm_tags jsonb
    CHECK (osm_tags IS NULL OR jsonb_typeof(osm_tags) = 'object'),
  ADD COLUMN IF NOT EXISTS data_version_id bigint
    REFERENCES public.osm_sg_data_versions (id) ON DELETE SET NULL;

ALTER TABLE public.osm_sg_roads
  ADD COLUMN IF NOT EXISTS data_version_id bigint
    REFERENCES public.osm_sg_data_versions (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_osm_sg_buildings_data_version
  ON public.osm_sg_buildings (data_version_id);
CREATE INDEX IF NOT EXISTS idx_osm_sg_roads_data_version
  ON public.osm_sg_roads (data_version_id);

COMMENT ON COLUMN public.osm_sg_buildings.addr_source IS
  'way: the address is on the building itself; node: copied from an address point inside the footprint.';
COMMENT ON COLUMN public.osm_sg_buildings.place_class IS
  'Derived by placeClassFromTags in shared/fieldOps/sitePlaces.ts; null for a generic building.';
COMMENT ON COLUMN public.osm_sg_buildings.osm_tags IS
  'Allow-listed raw tags kept for re-derivation, at most 16 keys (see the generator).';
COMMENT ON COLUMN public.osm_sg_buildings.data_version_id IS
  'The import that last wrote this row; null for rows loaded before migration 229.';

CREATE OR REPLACE FUNCTION public.fieldops_osm_activate_version(p_label text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
  v_region text;
  v_status text;
BEGIN
  SELECT id, region, status INTO v_id, v_region, v_status
    FROM public.osm_sg_data_versions
   WHERE label = p_label
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'data version % does not exist', p_label USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'data version % is %, not verified', p_label, v_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.osm_sg_data_versions
     SET status = 'superseded', superseded_at = now()
   WHERE region = v_region AND status = 'active';
  UPDATE public.osm_sg_data_versions
     SET status = 'active', activated_at = now()
   WHERE id = v_id;
END;
$$;

COMMENT ON FUNCTION public.fieldops_osm_activate_version(text) IS
  'Makes a verified data version active and supersedes the previous one, in one transaction (WS3).';

REVOKE ALL ON FUNCTION public.fieldops_osm_activate_version(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_osm_activate_version(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_osm_activate_version(text) TO service_role;
```

**230: the search index.**

```sql
-- migrations/230_osm_sg_search_index.sql (WS3)
-- A narrow type-ahead index of addresses, named buildings and street names, filled by the
-- importer from the generator's osm-sg-search-index.ndjson. Prefix search uses a C-collation
-- btree, word-prefix search a tsvector GIN index, substring search a pg_trgm GIN index when the
-- extension can be created (otherwise a scan of this narrow table).
-- Requires 229_osm_sg_addresses_and_versions.sql.
-- Before it is applied, search falls back to names only on the base tables.
-- Rollback, only while no deployed code reads these objects:
--   DROP FUNCTION IF EXISTS public.fieldops_site_search_features();
--   DROP FUNCTION IF EXISTS public.fieldops_site_search_candidates(text, integer);
--   DROP TABLE IF EXISTS public.osm_sg_search_index;
--   (pg_trgm is left installed: other code may come to rely on it.)

CREATE TABLE IF NOT EXISTS public.osm_sg_search_index (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 3 AND 200),
  kind text NOT NULL CHECK (kind IN ('address', 'building', 'street')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  search_text text NOT NULL CHECK (char_length(search_text) BETWEEN 1 AND 200),
  alt_search_text text CHECK (alt_search_text IS NULL OR char_length(alt_search_text) <= 200),
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, search_text || ' ' || coalesce(alt_search_text, ''))
  ) STORED,
  house_number text CHECK (house_number IS NULL OR char_length(house_number) <= 20),
  street text CHECK (street IS NULL OR char_length(street) <= 120),
  postcode text CHECK (postcode IS NULL OR postcode ~ '^[0-9]{6}$'),
  city text CHECK (city IS NULL OR char_length(city) <= 60),
  building_osm_id text CHECK (building_osm_id IS NULL OR char_length(building_osm_id) <= 40),
  building_name text CHECK (building_name IS NULL OR char_length(building_name) <= 200),
  place_class text CHECK (place_class IS NULL OR place_class ~ '^[a-z_]{2,40}$'),
  near_name text CHECK (near_name IS NULL OR char_length(near_name) <= 200),
  centre_lat double precision NOT NULL CHECK (centre_lat BETWEEN -90 AND 90),
  centre_lng double precision NOT NULL CHECK (centre_lng BETWEEN -180 AND 180),
  importance real NOT NULL DEFAULT 0 CHECK (importance >= 0 AND importance <= 1),
  data_version_id bigint REFERENCES public.osm_sg_data_versions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.osm_sg_search_index IS
  'Type-ahead index for the field-ops site picker (WS3). search_text is normaliseSearchText(label).';
COMMENT ON COLUMN public.osm_sg_search_index.alt_search_text IS
  'For an address row, the normalised name of its building, so the address is found by that name too.';
COMMENT ON COLUMN public.osm_sg_search_index.near_name IS
  'For a street name used in several places, the nearest named building, shown to tell the places apart.';

CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_prefix
  ON public.osm_sg_search_index (search_text COLLATE "C");
CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_postcode
  ON public.osm_sg_search_index (postcode)
  WHERE postcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_tsv
  ON public.osm_sg_search_index USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_building
  ON public.osm_sg_search_index (building_osm_id)
  WHERE building_osm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_data_version
  ON public.osm_sg_search_index (data_version_id);

ALTER TABLE public.osm_sg_search_index ENABLE ROW LEVEL SECURITY;

-- pg_trgm is optional. If it cannot be created the migration still succeeds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
  ELSE
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm could not be created (%): substring search will scan osm_sg_search_index', SQLERRM;
END
$$;

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';
  IF v_schema IS NULL THEN
    RAISE NOTICE 'pg_trgm is not installed: no trigram index on osm_sg_search_index';
  ELSE
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_osm_sg_search_index_trgm ON public.osm_sg_search_index USING gin (search_text %I.gin_trgm_ops)',
      v_schema
    );
  END IF;
END
$$;

-- Candidate recall for one normalised query. Ranking is done in TypeScript (siteRanking.ts).
-- Every branch uses a predicate that an index serves with a runtime key, so generic plans stay fast.
CREATE OR REPLACE FUNCTION public.fieldops_site_search_candidates(p_q text, p_limit integer DEFAULT 20)
RETURNS TABLE (
  id text,
  kind text,
  label text,
  search_text text,
  alt_search_text text,
  house_number text,
  street text,
  postcode text,
  city text,
  building_osm_id text,
  building_name text,
  place_class text,
  near_name text,
  centre_lat double precision,
  centre_lng double precision,
  importance real,
  recall smallint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  (SELECT i.id, i.kind, i.label, i.search_text, i.alt_search_text, i.house_number, i.street,
          i.postcode, i.city, i.building_osm_id, i.building_name, i.place_class, i.near_name,
          i.centre_lat, i.centre_lng, i.importance, 0::smallint
     FROM public.osm_sg_search_index i
    WHERE char_length(p_q) BETWEEN 2 AND 80
      AND i.kind = 'address'
      AND (i.postcode = p_q
           OR (i.search_text COLLATE "C" >= p_q
               AND i.search_text COLLATE "C" < p_q || chr(1114111)))
    ORDER BY i.importance DESC, i.id
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 40))
  UNION ALL
  (SELECT i.id, i.kind, i.label, i.search_text, i.alt_search_text, i.house_number, i.street,
          i.postcode, i.city, i.building_osm_id, i.building_name, i.place_class, i.near_name,
          i.centre_lat, i.centre_lng, i.importance, 1::smallint
     FROM public.osm_sg_search_index i
    WHERE char_length(p_q) BETWEEN 2 AND 80
      AND i.kind IN ('building', 'street')
      AND i.search_text COLLATE "C" >= p_q
      AND i.search_text COLLATE "C" < p_q || chr(1114111)
    ORDER BY i.importance DESC, i.id
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 40))
  UNION ALL
  (SELECT i.id, i.kind, i.label, i.search_text, i.alt_search_text, i.house_number, i.street,
          i.postcode, i.city, i.building_osm_id, i.building_name, i.place_class, i.near_name,
          i.centre_lat, i.centre_lng, i.importance, 2::smallint
     FROM public.osm_sg_search_index i
    WHERE char_length(p_q) BETWEEN 2 AND 80
      AND i.search_tsv @@ to_tsquery('simple', (
            SELECT string_agg(quote_literal(t) || ':*', ' & ')
              FROM unnest(string_to_array(p_q, ' ')) AS t
             WHERE t <> ''))
    ORDER BY i.importance DESC, i.id
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 40))
  UNION ALL
  (SELECT i.id, i.kind, i.label, i.search_text, i.alt_search_text, i.house_number, i.street,
          i.postcode, i.city, i.building_osm_id, i.building_name, i.place_class, i.near_name,
          i.centre_lat, i.centre_lng, i.importance, 3::smallint
     FROM public.osm_sg_search_index i
    WHERE char_length(p_q) BETWEEN 3 AND 80
      AND i.search_text LIKE
            '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    ORDER BY i.importance DESC, i.id
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 40))
$$;

COMMENT ON FUNCTION public.fieldops_site_search_candidates(text, integer) IS
  'Up to four groups of candidates for a query already passed through normaliseSearchText (WS3).';

CREATE OR REPLACE FUNCTION public.fieldops_site_search_features()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'trigram', EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'idx_osm_sg_search_index_trgm'),
    'estimated_rows', (
      SELECT c.reltuples::bigint FROM pg_class c
       WHERE c.oid = 'public.osm_sg_search_index'::regclass)
  );
$$;

REVOKE ALL ON FUNCTION public.fieldops_site_search_candidates(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_site_search_candidates(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_site_search_candidates(text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fieldops_site_search_features() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_site_search_features() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_site_search_features() TO service_role;
```

**Why these indexes.** The measured timings are about 514 ms for a building name search and 46 ms for a road name search on the base tables (common brief). The building rows carry their footprint JSON, so a scan of them is slow; a type-ahead with a 250 ms debounce needs well under 100 ms on the server to feel instant. The index table is narrow (text and two numbers, roughly 170,000 rows at most, section 5.6), so even a full scan of it costs about what the road scan costs. On top of that: the C-collation btree answers "starts with" as an index range; the `tsvector` GIN index answers "a word starts with" for every word, with no extension; and `pg_trgm`, when it can be created, answers "contains" from an index. Without `pg_trgm` the substring branch runs only for queries of three characters or more and scans the narrow table. A plain `LIKE 'abc%'` with a parameter cannot use a btree in a generic plan, which a SQL function gets; the explicit range on `COLLATE "C"` can, which is why the prefix branches are written as ranges. Targets, measured in acceptance (AC3.6): a 95th-percentile server time under 80 ms with the trigram index and under 150 ms without it.

**231: the site-area function.**

```sql
-- migrations/231_fieldops_site_area.sql (WS3)
-- One round trip for the buildings and streets around a point, nearest first, using the existing
-- bounding-box indexes. Exact polygon distances and clipping are done in TypeScript (siteArea.ts).
-- Requires 229_osm_sg_addresses_and_versions.sql (it reads place_class and the address columns).
-- Before it is applied, loadSiteArea pages the base tables instead.
-- Rollback: DROP FUNCTION IF EXISTS public.fieldops_site_area(double precision, double precision, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.fieldops_site_area(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer,
  p_max_buildings integer DEFAULT 1500,
  p_max_streets integer DEFAULT 800
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_r double precision := least(greatest(coalesce(p_radius_m, 150), 50), 600);
  v_m_lat constant double precision := 111320.0;
  v_m_lng double precision;
  v_min_lat double precision;
  v_max_lat double precision;
  v_min_lng double precision;
  v_max_lng double precision;
  v_max_b integer := least(greatest(coalesce(p_max_buildings, 1500), 1), 3000);
  v_max_s integer := least(greatest(coalesce(p_max_streets, 800), 1), 2000);
  v_result jsonb;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -85 AND 85 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RETURN jsonb_build_object('buildings', '[]'::jsonb, 'streets', '[]'::jsonb,
                              'buildings_capped', false, 'streets_capped', false);
  END IF;
  v_m_lng := v_m_lat * cos(radians(p_lat));
  v_min_lat := p_lat - v_r / v_m_lat;
  v_max_lat := p_lat + v_r / v_m_lat;
  v_min_lng := p_lng - v_r / v_m_lng;
  v_max_lng := p_lng + v_r / v_m_lng;

  WITH b AS (
    SELECT o.osm_id, o.name, o.building_type, o.building_levels, o.height_m,
           o.center_lat, o.center_lng, o.footprint_polygon_json, o.place_class,
           o.addr_housenumber, o.addr_street, o.addr_postcode, o.addr_city,
           sqrt(power(greatest(o.min_lng - p_lng, 0, p_lng - o.max_lng) * v_m_lng, 2)
              + power(greatest(o.min_lat - p_lat, 0, p_lat - o.max_lat) * v_m_lat, 2)) AS box_distance_m
      FROM public.osm_sg_buildings o
     WHERE o.min_lat <= v_max_lat AND o.max_lat >= v_min_lat
       AND o.min_lng <= v_max_lng AND o.max_lng >= v_min_lng
  ),
  b_in AS (
    SELECT * FROM b WHERE b.box_distance_m <= v_r
  ),
  b_top AS (
    SELECT * FROM b_in ORDER BY b_in.box_distance_m, b_in.osm_id LIMIT v_max_b
  ),
  s AS (
    SELECT o.osm_id, o.name, o.highway_type, o.coordinates_json,
           sqrt(power(greatest(o.min_lng - p_lng, 0, p_lng - o.max_lng) * v_m_lng, 2)
              + power(greatest(o.min_lat - p_lat, 0, p_lat - o.max_lat) * v_m_lat, 2)) AS box_distance_m
      FROM public.osm_sg_roads o
     WHERE o.min_lat <= v_max_lat AND o.max_lat >= v_min_lat
       AND o.min_lng <= v_max_lng AND o.max_lng >= v_min_lng
  ),
  s_in AS (
    SELECT * FROM s WHERE s.box_distance_m <= v_r
  ),
  s_top AS (
    SELECT * FROM s_in ORDER BY s_in.box_distance_m, s_in.osm_id LIMIT v_max_s
  )
  SELECT jsonb_build_object(
           'buildings', coalesce((SELECT jsonb_agg(to_jsonb(b_top) ORDER BY b_top.box_distance_m, b_top.osm_id)
                                    FROM b_top), '[]'::jsonb),
           'streets', coalesce((SELECT jsonb_agg(to_jsonb(s_top) ORDER BY s_top.box_distance_m, s_top.osm_id)
                                  FROM s_top), '[]'::jsonb),
           'buildings_capped', (SELECT count(*) FROM b_in) > v_max_b,
           'streets_capped', (SELECT count(*) FROM s_in) > v_max_s)
    INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fieldops_site_area(double precision, double precision, integer, integer, integer) IS
  'Buildings and streets whose bounding box lies within p_radius_m (50 to 600) of a point, nearest first (WS3).';

REVOKE ALL ON FUNCTION public.fieldops_site_area(double precision, double precision, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_site_area(double precision, double precision, integer, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_site_area(double precision, double precision, integer, integer, integer) TO service_role;
```

The bounding-box distance is never larger than the true distance to a footprint, so filtering on it never drops a building that touches the circle; `loadSiteArea` then computes the exact distance and drops the rest.

**232: facilities for the area dossier.**

```sql
-- migrations/232_osm_sg_facilities.sql (WS3)
-- Hospitals, clinics, police, fire and ambulance stations, fuel stations, power substations and
-- surveillance cameras from the same extract, for the area dossier (D18) that WS5 builds.
-- Requires 229_osm_sg_addresses_and_versions.sql.
-- Before it is applied, listFacilitiesNear answers status 'unavailable' and WS5 keeps its legacy path.
-- Rollback: DROP TABLE IF EXISTS public.osm_sg_facilities;

CREATE TABLE IF NOT EXISTS public.osm_sg_facilities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  osm_id text NOT NULL UNIQUE CHECK (osm_id ~ '^(node|way|relation)/[0-9]+$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),
  name text CHECK (name IS NULL OR char_length(name) <= 200),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  operator text CHECK (operator IS NULL OR char_length(operator) <= 200),
  amenity text CHECK (amenity IS NULL OR char_length(amenity) <= 60),
  healthcare text CHECK (healthcare IS NULL OR char_length(healthcare) <= 60),
  emergency text CHECK (emergency IS NULL OR char_length(emergency) <= 60),
  addr_housenumber text CHECK (addr_housenumber IS NULL OR char_length(addr_housenumber) <= 20),
  addr_street text CHECK (addr_street IS NULL OR char_length(addr_street) <= 120),
  addr_postcode text CHECK (addr_postcode IS NULL OR addr_postcode ~ '^[0-9]{6}$'),
  building_osm_id text CHECK (building_osm_id IS NULL OR char_length(building_osm_id) <= 40),
  osm_tags jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(osm_tags) = 'object'),
  data_version_id bigint REFERENCES public.osm_sg_data_versions (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.osm_sg_facilities IS
  'Emergency and hazard-relevant facilities from the saved extract (WS3), read by listFacilitiesNear.';
COMMENT ON COLUMN public.osm_sg_facilities.kind IS
  'One of FACILITY_KINDS in shared/fieldOps/sitePlaces.ts. Checked in code so that adding a kind stays additive.';
COMMENT ON COLUMN public.osm_sg_facilities.building_osm_id IS
  'The osm_sg_buildings footprint that contains this facility, when one does.';

CREATE INDEX IF NOT EXISTS idx_osm_sg_facilities_lat_lng
  ON public.osm_sg_facilities (lat, lng);
CREATE INDEX IF NOT EXISTS idx_osm_sg_facilities_kind
  ON public.osm_sg_facilities (kind);
CREATE INDEX IF NOT EXISTS idx_osm_sg_facilities_data_version
  ON public.osm_sg_facilities (data_version_id);

ALTER TABLE public.osm_sg_facilities ENABLE ROW LEVEL SECURITY;
```

### 5.5 Code that runs before the migrations

WS0's helpers in `server/lib/schemaFeatures.ts (new)` detect each missing object (master 10.8 item 5); WS3 wraps them in `server/services/fieldOps/site/siteFeatures.ts (new)`. `createCachedDetector` keeps a positive answer for the life of the process and probes a negative one again after its default 60 seconds, and a real query that meets a missing object calls `markMissing()`, so applying a migration takes effect within about a minute, without a restart.

| Missing | Detected by | Behaviour until it is applied |
| --- | --- | --- |
| 229 (columns, `osm_sg_data_versions`) | `isMissingColumnError` on `place_class`, `isMissingRelationError` on the versions table | Area rows carry no place class or address (`type_label` "Building"); search runs in `names_only` mode; coverage uses `SITE_COVERAGE_FALLBACK`; `data_version` is null; the data note has no date |
| 230 (`osm_sg_search_index` and its functions) | `isMissingRelationError`, or WS0's `isMissingFunctionError` | `names_only` mode: two capped `ilike` queries on the base tables' `name` columns, buildings first, no addresses. The dropdown's note says addresses are not searchable yet |
| 231 (`fieldops_site_area`) | Missing function | `loadSiteArea` pages the base tables by bounding box, 1,000 rows a page, at most 3,000 buildings and 3,000 streets, as the legacy code does |
| 232 (`osm_sg_facilities`) | `isMissingRelationError` | `listFacilitiesNear` returns `{ status: 'unavailable' }` |

### 5.6 Data volumes, and what is unknown until the extract runs

| Item | Today | After the re-extract |
| --- | --- | --- |
| Buildings | 158,599 rows, 9,565 named | About the same, minus buildings deleted from OpenStreetMap since the last extract |
| Buildings with an address | 0 (the columns do not exist) | **Unknown.** The address tags are already in the generator's export and are dropped today (section 3.5), so the share is fixed by what OpenStreetMap holds for Singapore. Nobody on this project has measured it, and it cannot be measured without the PBF, which is not on this machine |
| Address points not on a building | Not extracted | **Unknown** until the generator's `--stats` run counts them |
| Search index rows | None | Named buildings (about 9,565) plus address rows plus street rows (one per distinct named street per area, a few thousand); at most about 170,000 if every building had an address |
| Facilities | None | **Unknown**; the generator prints a count per kind |

The generator's `--stats` dry run (section 6.11) prints, per run: buildings with their own address, buildings given an address from a point inside them, address points left outside every footprint, rejected postcodes, named buildings, distinct street names, facilities per kind and the coverage box. The importer stores the same counts in `osm_sg_data_versions.counts`. Decision D6 is already taken, so no threshold blocks the import: whatever share comes out is used, the dropdown works on names and streets either way, and the share is reported to the owner (task T3.14).

## 6. Server

### 6.1 Modules

| File | Exports | Notes |
| --- | --- | --- |
| `server/lib/fieldOps/siteSchemas.ts (new)` | `latLngSchema`, `osmIdSchema`, `polygonSchema`, `buildingRefSchema`, `involvedBuildingSchema`, `siteAddressSchema`, `siteSelectionSchema`, `siteHintSchema`, and the four request schemas | zod 4; mirrors section 5.2 |
| `server/lib/fieldOps/osmExtract.ts (new)` | `pickAllowedTags`, `buildingRowFromFeature`, `assignAddresses`, `facilityFromFeature`, `clusterStreets`, `buildSearchIndexRows`, `importanceForBuilding`, `importanceForStreet` | Pure; imported by the generator through `tsx` |
| `server/lib/fieldOps/osmImportGuard.ts (new)` | `parseProjectRef`, `checkImportGuard`, `checkSweepGuard` | Pure; imported by the importer through `tsx` |
| `server/services/fieldOps/site/siteFeatures.ts (new)` | `siteFeatures` with `addresses()`, `searchIndex()`, `areaFunction()`, `facilities()` | Cached detectors built on WS0's helpers (section 5.5) |
| `server/services/fieldOps/site/siteCoverage.ts (new)` | `getSiteCoverage`, `coverageAt` | Five-minute cache |
| `server/services/fieldOps/site/siteRanking.ts (new)` | `rankSiteCandidates`, `typeLabelFor`, `iconFor`, `SearchCandidateRow` | Pure |
| `server/services/fieldOps/site/siteSearch.ts (new)` | `searchSites` | Index or names-only fallback, server cache |
| `server/services/fieldOps/site/siteArea.ts (new)` | `loadSiteArea`, `shapeSiteArea` | The stable read WS4 uses (master 10.8 item 11) |
| `server/services/fieldOps/site/siteContext.ts (new)` | `buildSiteSelectionContext` | For WS2's save route (master 10.8 item 10) |
| `server/services/fieldOps/site/siteHint.ts (new)` | `resolveSiteHint`, `decideHintResolution` | For WS2's radar (master 10.8 item 10) |
| `server/services/fieldOps/site/facilities.ts (new)` | `listFacilitiesNear` | For WS5's dossier (D18) |
| `server/services/fieldOps/site/siteErrors.ts (new)` | `SiteDataUnavailableError` | Mapped to 503 `SITE_DATA_UNAVAILABLE` |
| `server/routes/fieldOpsSite.ts (new)` | `createFieldOpsSiteRouter`, `fieldOpsSiteRouter` | Mounted at `/api/warroom/field-ops/site` |
| `server/routes/tileProxy.ts` (touched) | `createTileProxyRouter`, `parseTileParams`, `tileProxyRouter` | Hardened, section 6.12 |

Every database read uses `supabaseAdmin`; authorisation is route code (common brief). No module under `server/services/fieldOps/site/` imports `osmVicinityService`, `geocodingService` or the diagnostic router.

### 6.2 Schemas

```ts
// server/lib/fieldOps/siteSchemas.ts (new). Owned by WS3. zod 4.
import { z } from 'zod';
import { INVOLVED_BUILDING_KINDS } from '../../../shared/fieldOps/vocabulary.js';
import { SITE_LIMITS } from '../../../shared/fieldOps/site.js';

const lat = z.number().finite().min(-90).max(90);
const lng = z.number().finite().min(-180).max(180);
export const latLngSchema = z.tuple([lat, lng]);
export const osmIdSchema = z.string().regex(/^(way|relation)\/[0-9]{1,15}$/);
// One extra point is allowed so that a repeated closing vertex reaches the normaliser, which removes it.
export const polygonSchema = z.array(latLngSchema).min(SITE_LIMITS.polygonMinPoints).max(SITE_LIMITS.polygonMaxPoints + 1);

export const buildingRefSchema = z.strictObject({
  osm_id: osmIdSchema.nullable(),
  name: z.string().max(SITE_LIMITS.buildingNameMax).nullable(),
  polygon: polygonSchema,
});
export const involvedBuildingSchema = z.strictObject({
  osm_id: osmIdSchema.nullable(),
  name: z.string().max(SITE_LIMITS.buildingNameMax).nullable(),
  polygon: polygonSchema,
  kind: z.enum(INVOLVED_BUILDING_KINDS),
  label: z.string().max(SITE_LIMITS.involvedLabelMax),
});
export const siteAddressSchema = z.strictObject({
  house_number: z.string().max(20).nullable(),
  street: z.string().max(120).nullable(),
  postcode: z.string().max(12).nullable(), // cleaned to six digits by the normaliser
  city: z.string().max(60).nullable(),
  line: z.string().max(200),
});
export const siteSelectionSchema = z.strictObject({
  place_label: z.string().max(SITE_LIMITS.placeLabelMax),
  centre: latLngSchema,
  radius_m: z.number().int().min(SITE_LIMITS.radiusMin).max(SITE_LIMITS.radiusMax),
  primary: buildingRefSchema,
  // A payload bound only: the limit of five is applied by normaliseSiteSelection with its own code.
  involved: z.array(involvedBuildingSchema).max(20),
  source: z.literal('saved_osm'),
  address: siteAddressSchema.nullable().optional(),
  data_version: z.string().max(64).nullable().optional(),
});
// The radar's site words (WS2's SiteProposal), checked before resolveSiteHint runs.
export const siteHintSchema = z.strictObject({
  place_text: z.string().min(1).max(120),
  involved: z
    .array(z.strictObject({ text: z.string().min(1).max(120), kind_hint: z.enum(INVOLVED_BUILDING_KINDS).nullable() }))
    .max(8),
  country: z.string().max(80).nullable().optional(),
  coords: latLngSchema.nullable().optional(),
});

// Request schemas for validate() (server/lib/validation.ts).
const nearParam = z.string().regex(/^-?[0-9]{1,2}(\.[0-9]{1,9})?,-?[0-9]{1,3}(\.[0-9]{1,9})?$/);
export const siteSearchRequestSchema = z.object({
  query: z.object({
    q: z.string().max(SITE_LIMITS.searchMaxChars),
    near: nearParam.optional(),
    limit: z.coerce.number().int().min(1).max(10).optional(),
  }),
});
export const siteAreaRequestSchema = z.object({
  query: z.object({
    lat: z.coerce.number().finite().min(-90).max(90),
    lng: z.coerce.number().finite().min(-180).max(180),
    radius: z.coerce.number().int().min(SITE_LIMITS.radiusMin).max(SITE_LIMITS.radiusMax),
  }),
});
export const siteValidateRequestSchema = z.object({
  body: z.object({ site: z.unknown() }),
});
export const siteCoverageRequestSchema = z.object({
  query: z
    .object({
      lat: z.coerce.number().finite().min(-90).max(90).optional(),
      lng: z.coerce.number().finite().min(-180).max(180).optional(),
    })
    .refine((q) => (q.lat === undefined) === (q.lng === undefined), { message: 'Give both lat and lng, or neither.' }),
});
```

`validateSiteSelectionShape` in `shared/fieldOps/site.ts (new)` is the hand-written twin of `siteSelectionSchema` for the browser (master 10.7 rule 2). The parity test in section 11 feeds one corpus to both.

### 6.3 Routes

Mounted in `server/index.ts` as `app.use('/api/warroom/field-ops/site', fieldOpsSiteRouter)`, next to WS2's field-ops routers after the existing `warroomRouter` mount (`server/index.ts:289`), which has no router-wide middleware and no path under `/field-ops` (`03-setup-screen.md` section 6.11). Every route runs, in this order: WS0's `requireFieldopsV2` gate, `requireAuth`, the trainer check, a per-user limiter, `validate()`, the handler. The gate sits on each route, not on the router, because several routers share the `/api/warroom/field-ops` prefix (master 10.8 item 3; `01-prerequisites.md` section 6.4).

| Method and path | Request | 200 body | Cache-Control |
| --- | --- | --- | --- |
| `GET /api/warroom/field-ops/site/search` | `q` (at most 80 characters), `near` (`lat,lng`, optional), `limit` (1 to 10, default 8) | `{ "data": SiteSearchResponse }` | `private, max-age=60` |
| `GET /api/warroom/field-ops/site/area` | `lat`, `lng`, `radius` (integer, 50 to 500) | `{ "data": SiteArea }` | `private, max-age=300` |
| `POST /api/warroom/field-ops/site/validate` | body `{ "site": SiteSelection }` | `{ "data": { "site": SiteSelection, "warnings": SiteIssue[], "fingerprint": string } }` | `no-store` |
| `GET /api/warroom/field-ops/site/coverage` | optional `lat` and `lng` | `{ "data": SiteCoverageResponse }` | `private, max-age=300` |

`SiteCoverageResponse` is `{ boxes: CoverageBox[]; data_version: SiteDataVersion | null; data_note: string; point: { lat: number; lng: number; state: SiteCoverageState } | null }`, declared in `shared/fieldOps/site.ts (new)` next to the types of section 5.2.

Errors, with the body `{ "error": <sentence>, "code": <CODE>, "details": [...] }` of master 10.3:

| Status | Code | When | Message |
| --- | --- | --- | --- |
| 400 | `VALIDATION_FAILED` | `validate()` rejects the query or body (WS0 adds the code) | "Validation failed" |
| 400 | `VALIDATION_FAILED` | `POST /validate` only: the normaliser refuses the site. The body is WS0's `validationErrorBody`, and each detail is `{ field: 'site.<path>', message, code }` with a `SITE_*` code of section 5.2, the same shape WS2's save route returns (`03-setup-screen.md` section 6.4) | "Validation failed", with the normaliser's messages in `details` |
| 401 | none (existing body) | No or bad token (`requireAuth`) | `Missing authorization header` or `Invalid or expired token` |
| 403 | `FORBIDDEN` | The user is not a trainer or an admin | "Only trainers can use the War Room" (`server/routes/warroom.ts:198-199`) |
| 404 | none | `ENABLE_FIELDOPS_V2` is off | `{ "error": "Not found" }`, the same body as the app's 404 handler (`server/index.ts:311-313`) |
| 429 | `RATE_LIMITED` | Over the per-user limit | "Too many map requests. Wait a moment and try again." |
| 503 | `SITE_DATA_UNAVAILABLE` | A read of the saved tables failed for a reason other than a missing migration | "The saved map data could not be read. Try again in a moment." |

Outside coverage is a state, not an error: `area` answers 200 with `coverage` `outside_bbox` or `no_data_nearby` and empty lists, and `coverage` answers 200 with the point's state.

Per-user limits, keyed `user:<id>` after `requireAuth` with the `perUserLimit` pattern of `server/routes/trainerAgreements.ts:214-222` but a one-minute window: search 120, area 40, validate 30, coverage 60. The global limiter still applies on top (`server/index.ts:196-214`).

The trainer check is WS0's one trainer-or-admin guard, `requireFieldopsTrainer` (`01-prerequisites.md`, AC0.40), which answers 403 with the body above; until it lands, the router holds the same middleware: if `req.user.role` is neither `trainer` nor `admin`, answer 403 with that body. The flag gate is WS0's `requireFieldopsV2`, which reads `env.enableFieldopsV2` and answers 404 `{ "error": "Not found" }` when it is off; the value is read once at boot (master section 8), so a change takes effect when the server restarts, with no build.

```ts
// server/routes/fieldOpsSite.ts (new). Owned by WS3.
import { Router, type RequestHandler } from 'express';

export interface SiteRouterDeps {
  flagGate: RequestHandler; // WS0's requireFieldopsV2
  authenticate: RequestHandler; // requireAuth
  searchSites: typeof import('../services/fieldOps/site/siteSearch.js').searchSites;
  loadSiteArea: typeof import('../services/fieldOps/site/siteArea.js').loadSiteArea;
  buildSiteSelectionContext: typeof import('../services/fieldOps/site/siteContext.js').buildSiteSelectionContext;
  getSiteCoverage: typeof import('../services/fieldOps/site/siteCoverage.js').getSiteCoverage;
  coverageAt: typeof import('../services/fieldOps/site/siteCoverage.js').coverageAt;
  limitsPerMinute: { search: number; area: number; validate: number; coverage: number };
}
export declare function createFieldOpsSiteRouter(overrides?: Partial<SiteRouterDeps>): Router;
export declare const fieldOpsSiteRouter: Router; // createFieldOpsSiteRouter()
```

The factory exists so the route test can inject a fake `authenticate`, fake services and small limits, and run the real router on an ephemeral port.

### 6.4 Search

`searchSites({ q, near, limit, userId }): Promise<SiteSearchResponse>` in `server/services/fieldOps/site/siteSearch.ts (new)`:

1. `qn = normaliseSearchText(q)`. If `qn` is shorter than `searchMinChars`, return no results with the current mode.
2. Look in an in-process cache of 500 entries, five minutes each, keyed by `qn`, the `near` point rounded to 0.01 degrees, `limit` and the active data-version label.
3. Ask `siteFeatures.searchIndex()`: `index` (table and trigram index), `index_no_trigram`, or missing.
4. With the index: `supabaseAdmin.rpc('fieldops_site_search_candidates', { p_q: qn, p_limit: 20 })`, then `rankSiteCandidates(qn, rows, { near, limit })`.
5. Without it (`names_only`): two queries on the base tables with the trimmed raw query, its `%`, `_` and backslash escaped: `osm_sg_buildings` `name ilike %q%` limit 20, and `osm_sg_roads` `name ilike %q%` limit 40 de-duplicated by name. Each row becomes a candidate with `search_text = normaliseSearchText(name)`, then the same ranking.
6. If the RPC fails with a missing relation or function, mark the feature missing and retry once in `names_only` mode. Any other failure throws `SiteDataUnavailableError`.
7. Log `fieldops_site_search` with the query length, never the text (section 10.4).

**Ranking.** `rankSiteCandidates(qn, rows, opts)` in `server/services/fieldOps/site/siteRanking.ts (new)` recomputes every tier itself, so the SQL only has to recall candidates and the order is fully covered by tests. With `tokens = searchTokens(qn)`, `starts(t)` = `t` starts with `qn`, `wordStarts(t)` = every token is the start of some word of `t`, and `contains(t)` = `qn` has three characters or more and `t` contains it:

| Tier | Match | Rule |
| --- | --- | --- |
| 0 | `exact_address` | An address row whose `postcode` equals `qn` (when `qn` is six digits), whose `search_text` equals `qn`, or, when `qn` contains a digit, whose `search_text` starts with `qn` |
| 1 | `name_prefix` | A building row with `starts(search_text)`; an address row with `starts(alt_search_text)` (its building's name) |
| 2 | `word_prefix` | A building row with `wordStarts(search_text)`; an address row with `wordStarts` on its address or its building's name |
| 3 | `substring` | A building or address row with `contains` on its text or its building's name |
| 4 | `street` | A street row: first `starts`, then `wordStarts`, then `contains` (a sub-order inside the tier) |

Rows that match no rule are dropped. Then:

1. **Families.** An address row in tiers 1 to 3 whose `building_osm_id` is also in the list as a building row takes that row's tier and sort key and sorts directly before it. This gives the mockup's order: "1 Marina Way, Singapore 018900" immediately above "Marina Court Mall".
2. **Order within a tier:** distance band from `near` when given (under 2 km, under 10 km, further), then `importance` descending (three decimals), then label length ascending, then label alphabetically (`en`, base sensitivity), then `id`.
3. **Street cap.** At most `searchStreetCap` (3) street rows, unless nothing else matched.
4. **Limit.** The first `limit` rows (default 8).
5. **Labels and icons.** `typeLabelFor(row)`: an address with a named building is "Address · <building name>", with an unnamed building "Address · <class label or Building>", with no building "Address · click a building after"; a building is `buildingTypeLabel(place_class)`; a street is "Street · click a building after", or "Street · near <near_name> · click a building after" when the name occurs in more than one place. `iconFor(row)`: `pin` for addresses, the class icon for buildings, `map` for streets. An unknown `place_class` value is read as null.

### 6.5 The area around a site

`loadSiteArea(input: Pick<SiteSelection, 'centre' | 'radius_m'>): Promise<SiteArea>` in `server/services/fieldOps/site/siteArea.ts (new)` is the stable read that the picker and WS4's layout both use (master 10.8 item 11). A whole `SiteSelection` fits the parameter, so WS4 calls `loadSiteArea(site)` as it writes. Its route is `GET /api/warroom/field-ops/site/area`, and neither changes shape without a master-plan change.

1. Clamp `radius_m` to an integer from 50 to 500. `fetched_radius_m = min(radius_m + 100, 600)`.
2. If `centre` is outside every coverage box, return `coverage: 'outside_bbox'` with empty lists, without reading the tables.
3. Look in a cache of 100 entries, ten minutes each, keyed by the centre rounded to five decimals, `fetched_radius_m` and the data-version label.
4. With migration 231: `rpc('fieldops_site_area', { p_lat, p_lng, p_radius_m: fetched_radius_m, p_max_buildings: 2000, p_max_streets: 1000 })`. Without it: page both base tables by bounding box, 1,000 rows a page, at most 3,000 rows each, selecting only the columns that exist (section 5.5).
5. `shapeSiteArea(rows, request)`, a pure function:
   - Buildings: parse the footprint (pairs with finite numbers only, at least three), `simplifyRing` to 500 vertices, `distance_m = distanceToPolygonM(centre, polygon)`, keep those within `fetched_radius_m`, sort by distance then `osm_id`, keep the first 1,500, round coordinates to seven decimals, add the vertex-mean `centroid`, the class label as `type_label` ("Building" when the class is null), and `address_line` from `addressLine` when any address part is present.
   - Streets: parse the line, cut it with `clipPolylineToCircle` at `fetched_radius_m`, drop it if nothing is left, thin each segment to 400 points, keep the 800 nearest by `distanceToPolylineM`.
   - Size: if the serialised area is over 1.5 MB, drop the farthest building or street, whichever is farther, until it fits.
   - `truncated` is true if the SQL reported a cap or any of these steps dropped something. `coverage` is `inside` when anything is left, otherwise `no_data_nearby`.
6. A read failure other than a missing migration throws `SiteDataUnavailableError`. Log `fieldops_site_area_loaded`.

The client hides what lies between `radius_m` and `fetched_radius_m`; the margin lets a small expansion happen without a request.

**What WS4 gets (its request R4.1).** `loadSiteArea` has three outcomes, and WS4's `SceneCtx.loadSiteArea` adapter (`05-layout-step.md` section 6.4) maps each one:

| Outcome | How it shows | WS4's adapter |
| --- | --- | --- |
| The area | `coverage` is `inside`; `buildings` and `roads` are filled | `SiteAreaForLayout`: each building as it is (`osm_id`, `name`, `polygon`); one road entry per clipped segment, with the road's `osm_id`, `name` and `highway` and the segment as `coordinates` |
| No saved data | `coverage` is `outside_bbox` or `no_data_nearby`, with empty lists. This is the distinct outcome WS4 asked for, kept as a state rather than an error | `null`, shown as WS4's `no_saved_data` state |
| Failure | `SiteDataUnavailableError` is thrown (503 `SITE_DATA_UNAVAILABLE` on the route) | `null`, and WS4's `fieldops_scene_area_unavailable` event |

The client wrapper is `loadArea(centre, radiusM)` in `frontend/src/components/FieldOps/Site/siteApi.ts (new)` (section 7.8), which returns the same `SiteArea` and throws `SiteApiError` on a failure. The fingerprints WS4 compares are defined in section 5.2: `siteFingerprint` covers the centre, the radius, the primary ring and the involved buildings with their kinds and labels; `ringFingerprint` is stable under its `r1_` prefix.

### 6.6 Validation and normalisation

WS2's draft save route calls these two functions for `setup_v2.site` (master 10.8 item 10); the `POST /validate` route calls them for the picker.

`buildSiteSelectionContext(input: unknown): Promise<SiteSelectionContext>` in `server/services/fieldOps/site/siteContext.ts (new)`:

1. Collect the `osm_id` strings of `input.primary` and `input.involved[]` that match `osmIdSchema`, at most six; anything else is ignored here and caught by the shape check.
2. Read them in one query: `osm_sg_buildings` `select osm_id, name, footprint_polygon_json` `in osm_id`.
3. Add the coverage boxes and the active data version from `getSiteCoverage()`.
4. A read failure throws `SiteDataUnavailableError`, which WS2's route maps to 503 `SITE_DATA_UNAVAILABLE`.

`normaliseSiteSelection(input, ctx)` in `shared/fieldOps/site.ts (new)` is pure and runs these steps in order. The first failing step decides `code`; `details` lists every issue found up to that point.

| Step | Rule | Failure or warning |
| --- | --- | --- |
| 1 | `validateSiteSelectionShape(input)` finds no issue | `SITE_INVALID`: "The site is not in the expected form." |
| 2 | For each building with an `osm_id` found in `ctx.buildings`, replace `polygon` and `name` with the stored footprint and name (an involved building keeps its `label`), simplifying a stored ring over 500 vertices | Warning `polygon_simplified` |
| 3 | For each building with an `osm_id` not in `ctx.buildings`, set `osm_id` to null and keep its polygon (P4) | Warning `building_not_in_saved_data`: "<name or label> is no longer in the saved map data, so its outline is kept as drawn." |
| 4 | `cleanRing` every polygon | Warning `closing_vertex_removed` when a repeat was removed |
| 5 | A custom polygon (`osm_id` null) has 3 to 500 vertices, an area of at least 4 square metres, and no crossing edges | `SITE_POLYGON_INVALID`: "An outline needs 3 to 500 corners.", "This outline is too small to be a building." or "The outline crosses itself. Draw it again." |
| 6 | Every vertex of every polygon is inside a coverage box (with `insideCoverage`'s margin of 0.002 degrees, about 200 m, so a building on the edge of a measured or rounded box is not refused) | `SITE_OUTSIDE_COVERAGE`: "Part of <name> is outside the saved map data." |
| 7 | `centre` becomes the vertex mean of the primary polygon, rounded to seven decimals (P3) | `SITE_OUTSIDE_COVERAGE` if that point is outside every box |
| 8 | At most five involved buildings | `SITE_INVOLVED_LIMIT`: "You can add up to 5 buildings besides the primary." |
| 9 | No two buildings share an `involvedKey`, and none shares the primary's | `SITE_INVOLVED_DUPLICATE`: "This building is already in the list." |
| 10 | Each involved building's distance from `centre` is at most `radius_m` plus 1 m | `SITE_INVOLVED_OUTSIDE_RADIUS`: "<label> is outside the <radius> m radius. Expand the radius or remove it." |
| 11 | Trim names and labels; an empty label becomes the name, else the kind's label; an empty name becomes null | None |
| 12 | Trim `place_label`; if empty use the primary's name, then the address line, then "Selected site" | None |
| 13 | Clean the address: trim, `cleanPostcode`, rebuild `line` with `addressLine`; drop the address if nothing is left | None |
| 14 | Set `source` to `saved_osm` and `data_version` to `ctx.data_version?.label ?? null`; ignore the client's value | None |

On success it returns `{ ok: true, site, warnings, fingerprint: siteFingerprint(site) }`. The polygon order of a stored footprint is never changed, so the sim-space origin and any `edgeIndex` stay valid.

### 6.7 Coverage

`getSiteCoverage(): Promise<{ boxes: CoverageBox[]; data_version: SiteDataVersion | null }>` in `server/services/fieldOps/site/siteCoverage.ts (new)`, cached for five minutes:

- Read the `active` rows of `osm_sg_data_versions`. Each row's `coverage` becomes a box after checking that the four numbers are finite and ordered; an SG row without one uses `SITE_COVERAGE_FALLBACK`.
- `data_version` is the SG active row as `{ label, extract_date }`, with `extract_date` the UTC date of `source_timestamp`, or null. **Added 3 Nov 2026:** it also carries the row's `region`, so `SiteSelectionContext.data_version` reports the saved data's country (AC3.32).
- With migration 229 missing: `{ boxes: [SITE_COVERAGE_FALLBACK], data_version: null }`.

`coverageAt(point)` answers `outside_bbox` when the point is outside every box; otherwise it asks the area function for 300 m with one building and one street, and answers `inside` if anything comes back and `no_data_nearby` if not (P8). `GET /coverage` returns the boxes, the version, `siteDataNote(data_version)` and, when `lat` and `lng` are given, the point's state.

### 6.8 Resolving the radar's place words

`resolveSiteHint(hint: SiteHint): Promise<SiteHintResolution>` in `server/services/fieldOps/site/siteHint.ts (new)`. WS2's radar job calls it once per run, in its guard stage, with its `SiteProposal`'s `place_text` and `involved` items and the country name its guard rail derives from the document (`03-setup-screen.md` section 8.5, rule 11), and stores the result as `built.site = { resolution, selection: resolution.selection }` in its ledger (master 10.8 item 10). Its `applyRadarResult` applies `selection` only to a draft with no site (`03-setup-screen.md` section 7.5), and the page passes the site proposal and `built.site` to `SiteLane` as `proposal`. `resolveSiteHint` makes no model call and no live lookup. The decisions are the pure `decideHintResolution(...)`, fed by injected search and footprint readers, so they can be tested without a database.

**The main place.**

1. **Country.** If `hint.country` resolves with `findCountry` (`shared/countries.ts:143-146`) to a code other than `SG`, the status is `outside_coverage` and nothing is searched. An unknown country name is ignored.
2. **Coordinates.** If `hint.coords` is outside every box, `outside_coverage`. Inside, the nearest building within 100 m (from the area function) is the result; with none, `not_found` with the reason "Your document gives coordinates, but no saved building is within 100 m of them."
3. **Text.** `searchSites` with `place_text` and a limit of 5.
4. **Decision.** No result: `not_found`. The top two results with the same tier, each selecting a different building, and labels that normalise to the same text: `ambiguous`, with both in `candidates`. A top result that selects no building (a street, or a lone address point): `ambiguous`, because the trainer still has to click a footprint. Otherwise `resolved`.
5. **Footprint.** For a resolved result, read its footprint into `building`.

**The involved places**, only when the main place is `resolved` (otherwise each gets `not_found` with no search). The centre is the vertex mean of the primary footprint.

1. `searchSites` with the item's `text`, `near` set to that centre, and a limit of 5; keep results whose building lies within 600 m of the centre.
2. If none is left and `kind_hint` is `car_park` or `transit_station`, take the nearest building of that class within 500 m of the centre (from the area function), with the reason "The nearest car park to the primary building." or "The nearest station to the primary building."
3. `kind` is `kind_hint`, else `defaultInvolvedKind(place_class)`; `distance_m` is the distance from the centre to the footprint; `inside_radius` is `distance_m <= 150`; `expand_to` is `expandTargetFor(distance_m)` when outside, else null.
4. An item that resolves to the primary building itself is dropped (status `not_found`, reason "This is the primary building.").

**The selection.** When the main place is `resolved`, `selection` is built with `place_label` from the best result, `radius_m` 150 (`SITE_LIMITS.radiusDefault`), the primary footprint, every resolved involved building with `inside_radius` true in order, up to five (D15), labelled with its name or its kind's label, and `address` from an address result. It is passed through `normaliseSiteSelection` with a context built from the footprints just read, so it is exactly what a save would store; if that fails, `selection` is null. WS2's merge applies `selection` only to a draft with no site; the lane never does (section 7.4). Involved buildings outside the radius stay out of the selection: WS2 offers them as unticked chips ("{d} m · outside radius"), and turning one on calls `includeBuilding` with its `distance_m`, or `toggleInvolved`, which wraps `includeBuilding` and `removeInvolved` (request R9).

**Failure.** A read failure makes the whole resolution `unavailable` (WS2 then stores a null resolution, its section 6.6). Log `fieldops_site_hint_resolved` with the status, the number of involved items and how many resolved, never the text.

`SITE_HINT_REASONS`:

| Status | Reason |
| --- | --- |
| `resolved` | "Found in the saved map data." |
| `ambiguous` | "Several places in the saved map data match. Pick one." |
| `not_found` | "Not found in the saved map data. Search for it by address, building or street." |
| `outside_coverage` | "No saved map data for this area yet." |
| `unavailable` | "The saved map data could not be searched just now." |

**What the radar does outside coverage.** WS2 shows the site chip unticked with the reason and does not apply a selection (there is none); the site lane shows its outside-coverage state (section 7.7) and WS3's `site.document_outside` readiness note appears; every other lane works; WS2's own `site.missing` blocker keeps "Lay out the scene" and compile closed. Nothing is fetched live (D13). WS2's guard rail turns the document's country words into a country name with `findCountry` (`03-setup-screen.md` section 8.5, rule 11), so a place set abroad comes back `outside_coverage` rather than `not_found`; coordinates are never extracted, so `coords` is always null in version 1.

### 6.9 Facilities for the area dossier

`listFacilitiesNear(centre: LatLng, opts?: { radiusM?: number; kinds?: FacilityKind[]; maxPerKind?: number }): Promise<FacilitiesNearResult>` in `server/services/fieldOps/site/facilities.ts (new)`, for WS5's dossier (D18):

1. `radiusM` defaults to 5,000 and is capped at 10,000; `kinds` defaults to all of `FACILITY_KINDS`; `maxPerKind` defaults to 50.
2. Outside every coverage box: `{ status: 'outside_coverage' }`. Migration 232 missing: `{ status: 'unavailable' }`.
3. One bounding-box query on `osm_sg_facilities (lat, lng)`, filtered by `kind`, at most 5,000 rows.
4. Distance in local metres; keep those within the radius; per kind, nearest first then by name; at most `maxPerKind` each; `address_line` from `addressLine`.

The legacy vicinity counts clinics, `healthcare=centre` and `building=hospital` as hospitals (`server/services/osmVicinityService.ts:250-255`); WS3 keeps hospital and clinic apart and lets WS5 merge them if it wants the legacy grouping.

**The names WS5 reads (its request).** Hospitals are `hospital`, police `police` and fire stations `fire_station`; `clinic` and `ambulance_station` are their own kinds. The hazard-relevant kinds are `fuel_station` and `power_substation`, and `surveillance_camera` marks sensitive infrastructure. `listFacilitiesNear` calls no map service: it runs the one query of step 3 through the server's Supabase client, and the static test of AC3.22 scans `server/services/fieldOps/site/facilities.ts (new)` with WS3's other files.

### 6.10 The hand-off to setup, layout and compile

| Consumer | What it uses | How |
| --- | --- | --- |
| WS2, draft save | `buildSiteSelectionContext`, `normaliseSiteSelection`, `siteSelectionSchema` | Run the normaliser on a changed site (`03-setup-screen.md` section 6.4); store the normalised site; map `ok: false` to 400 `VALIDATION_FAILED` with the issues as `details` (`field` `site.<path>`, the `SITE_*` `code`); emit `fieldops_site_selected` when `siteFingerprint` changes (section 10.4). The schema replaces WS2's stand-in import |
| WS2, readiness | `siteReadinessRules`, `describeSite` | WS3's rules replace the stand-in line in WS2's registry. WS2's `site.ok` (when `setup.site` is set, with the text `describeSite(site).readiness`) and `site.missing` (when it is null, with WS2's own text) stay WS2's rules. There is no `siteReadiness` function (WS2's request R8, section 15.4) |
| WS2, radar | `resolveSiteHint`, `SiteSearchResult`, `SiteHintResolution`, `includeBuilding`, `removeInvolved`, `expandTargetFor`, `toggleInvolved` | Section 6.8; the site chips call `includeBuilding` and `removeInvolved` (or `toggleInvolved`) on `setup.site` (request R9) |
| WS2, page | `SiteLane` with `SiteLaneProps` (`draftId`, `site`, `onChange`, `proposal`, `issueAt`, `readOnly`) | Section 7.7; the lane never writes the radar's site, which WS2's merge applies only to a draft with no site (request R10) |
| WS4, layout | `GET /api/warroom/field-ops/site/area` (or `loadSiteArea` on the server), `ringFingerprint`, `siteFingerprint`, `describeSite`, the map layers of section 7.2 | Open with `setup_v2.site`: draw the primary and involved polygons from the selection itself and the surroundings from the area read at `site.centre` and `site.radius_m`; detect a changed primary with `ringFingerprint(site.primary.polygon)` and any other change with `siteFingerprint(site)`. WS4's own `SceneCtx.loadSiteArea(site)` (`05-layout-step.md` section 6.4, request R4.1) wraps `loadSiteArea`: its `SiteAreaForLayout` takes `buildings` as they are and one `roads` entry per clipped segment (`osm_id`, `name`, `highway`, the segment as `coordinates`); it answers null when the area's `coverage` is not `inside` (WS4's `no_saved_data` state) and on a failure, which WS4 logs as `fieldops_scene_area_unavailable`; WS3 keeps the two apart (section 6.5) |
| WS5, compile | `siteToLegacyLocation(site)`, `listFacilitiesNear`, `site.data_version` | Feed the legacy generators the location fields they read today (section 3.7) without writing them into the draft's `input` (master 10.8 item 6); build the dossier's facilities from the saved data; record the data version in provenance |

The layout re-reads the surroundings rather than storing them, so a reloaded layout no longer loses the streets and neighbours (journey Design 6; section 3.3). The primary and involved polygons come from the selection, so a re-import cannot move a building that has already been laid out; if `site.data_version` differs from the area's `data_version`, WS4 may show "The saved map data has been updated since this site was set."

### 6.11 The re-extract and re-import

**Generator** (`scripts/generate_singapore_local_osm.mjs`, touched). It runs with `node --import tsx` (the `generate:sg-osm` script in `package.json` changes accordingly) so it can import `shared/fieldOps/sitePlaces.ts (new)`, `shared/fieldOps/siteSearchText.ts (new)`, `shared/fieldOps/siteGeometry.ts (new)` and `server/lib/fieldOps/osmExtract.ts (new)`. It still reads only a local PBF and calls no network service.

- New flags: `--label <data version label>` (required), `--source-name <text>` (required), `--stats` (count and print, write nothing).
- Building rows keep today's fields and add `addr_housenumber`, `addr_street`, `addr_postcode` (through `cleanPostcode`), `addr_city`, `addr_source` (`way` when the building carries the address), `place_class` (`placeClassFromTags`) and `osm_tags`. The tag allow-list is `amenity`, `shop`, `building`, `building:use`, `railway`, `public_transport`, `station`, `parking`, `healthcare`, `emergency`, `operator`, `tourism`, `leisure`, `office`, `aeroway` and `name:en`, each value cut to 120 characters.
- A second osmium pass exports address points (`n/addr:housenumber` and `n/addr:postcode`). `assignAddresses` puts each point in the footprint that contains it (even-odd rule, with a grid of 0.002-degree cells over the footprints' boxes). A building with no address of its own takes the most frequent address among its points (ties: the point nearest its vertex mean) with `addr_source` `node`. Up to five distinct addresses per building become address rows in the index; points in no footprint become address rows with no building.
- A third pass exports facilities: `nwr/amenity=hospital,clinic,doctors,police,fire_station,fuel`, `nwr/healthcare=hospital,clinic,centre`, `nwr/emergency=ambulance_station`, `nwr/building=hospital`, `nwr/power=substation` and `n/man_made=surveillance`, as points and polygons (a polygon's vertex mean is its point). `facilityFromFeature` maps the first matching rule, in this order: hospital (`amenity`, `healthcare` or `building` is `hospital`), clinic (`amenity` is `clinic` or `doctors`, or `healthcare` is `clinic` or `centre`), police, fire station, ambulance station, fuel station, power substation, surveillance camera. A node and a way of the same kind and name within 50 m keep the way.
- `buildSearchIndexRows` writes one row per named building (`b:<osm_id>`), one per building address (`a:<osm_id>:<n>`), one per lone address point (`a:<node id>`) and one per street place. `clusterStreets` groups named roads by normalised name, puts their segment midpoints in 0.01-degree cells and joins touching cells into places; each place becomes `s:<name>:<n>`, numbered by latitude then longitude, centred on the segment midpoint nearest the place's mean, and given `near_name` (the nearest named building within 1 km) when the name has more than one place.
- Importance, from 0 to 1, rounded to three decimals: a building is `min(1, log10(1 + area in square metres) / 5)` plus 0.1 for the classes `mall`, `transit_station`, `hospital`, `hotel`, `stadium`, `airport`, `university` and `government`, capped at 1; an address takes its building's value, or 0.3 without one; a street place is `min(1, log10(1 + length in metres) / 4.5)`.
- The source timestamp comes from `osmium fileinfo --json` (`header.option.osmosis_replication_timestamp`, else `header.option.timestamp`, else null); the SHA-256 of the PBF from `node:crypto`.
- Output in `server/data/generated/<label>/`, which `.gitignore:71-73` keeps out of the repository: `osm-sg-buildings.ndjson`, `osm-sg-roads.ndjson`, `osm-sg-facilities.ndjson`, `osm-sg-search-index.ndjson` and `manifest.json` with the label, region `SG`, source name, SHA-256, source timestamp, `generator_version` `sg-osm-2`, coverage box, counts (section 5.6) and each file's row count and SHA-256.

**Importer** (`scripts/import_singapore_local_osm.mjs`, touched), run with `node --import tsx` so it can import `server/lib/fieldOps/osmImportGuard.ts (new)`:

| Mode | Flags | What it does |
| --- | --- | --- |
| Dry run (default) | `--manifest <path>` | Checks the files against the manifest, checks that migrations 229 to 232 are applied, prints the plan and the counts. Writes nothing |
| Export | `--export-current <dir>` | Reads every row of the four tables, in `osm_id` order, into NDJSON files and a manifest in the generator's format. Read-only; this is the rollback copy |
| Apply | `--manifest <path> --apply --project-ref <ref> --confirm-shared-database` | Inserts the version row as `importing`; upserts buildings, roads, facilities (on `osm_id`) and index rows (on `id`) with `data_version_id`; checks the row counts against the manifest; marks the version `verified` |
| Activate | `--activate <label> --project-ref <ref> --confirm-shared-database` | Calls `fieldops_osm_activate_version` |
| Sweep | `--sweep <label> --project-ref <ref> --confirm-shared-database` | Deletes rows of older versions (and rows with no version) from the four tables, in batches |
| Fail | `--fail <label> --project-ref <ref> --confirm-shared-database` | Marks an `importing` or `verified` version `failed` |

**The guard** (`checkImportGuard` and `checkSweepGuard`, pure). Every mode that writes refuses to start when:

- `--project-ref` is missing or differs from the reference in `SUPABASE_URL` (`https://<ref>.supabase.co`). Development, preview and production share that one project, so the check makes the operator type the project they mean.
- `--confirm-shared-database` is missing.
- A session has the status `in_progress` (`server/services/engineTicker.ts:46`), unless `--allow-live-sessions` is given.
- Another version is `importing`, unless the label is the same one (a resumed run).
- For a sweep: the active version's rows would be fewer than 90 per cent of the rows the sweep would leave untouched before it, for buildings or for roads, unless `--allow-shrink` is given.

The legacy `--roads` and `--buildings` flags keep working for an empty database, and `--truncate` is refused whenever the target table has rows.

**Runbook.**

1. Apply migrations 229, 230, 231 and 232, in order, outside a live session (each adds columns or indexes under a short lock).
2. Run the importer with `--export-current server/data/generated/before-<date>` and keep the copy until the new version has been active for a release.
3. Place a fresh Singapore PBF at the generator's default input path, `server/data/Singapore.osm.pbf` (the owner chooses the extract provider; the current file's source is not recorded). This is an operator download, not a call the app makes.
4. `npm run generate:sg-osm -- --input server/data/Singapore.osm.pbf --label sg-<yyyy-mm-dd> --source-name "<provider and file>" --stats`, then read the counts with the owner.
5. Run the same command without `--stats`.
6. Run the importer as a dry run with `--manifest`, then with `--apply` and the guard flags.
7. Run the verification queries below in the SQL editor, and search a few known places on staging (the database is shared, so staging shows the new rows at once; the active version, and so the data note, changes only at activation).
8. `--activate sg-<yyyy-mm-dd>`.
9. After one release without problems, `--sweep sg-<yyyy-mm-dd>`, then run `ANALYZE` on the four tables.

**Verification queries** (replace the example label with the one being imported):

```sql
SELECT label, status, source_timestamp, counts, coverage
  FROM public.osm_sg_data_versions
 ORDER BY id DESC
 LIMIT 3;

SELECT (SELECT count(*) FROM public.osm_sg_buildings b WHERE b.data_version_id = v.id) AS buildings,
       (SELECT count(*) FROM public.osm_sg_roads r WHERE r.data_version_id = v.id) AS roads,
       (SELECT count(*) FROM public.osm_sg_facilities f WHERE f.data_version_id = v.id) AS facilities,
       (SELECT count(*) FROM public.osm_sg_search_index s WHERE s.data_version_id = v.id) AS search_rows
  FROM public.osm_sg_data_versions v
 WHERE v.label = 'sg-2026-11-02';

SELECT count(*) AS buildings,
       count(*) FILTER (WHERE addr_housenumber IS NOT NULL OR addr_postcode IS NOT NULL) AS with_address,
       count(*) FILTER (WHERE addr_source = 'node') AS address_from_point,
       round(100.0 * count(*) FILTER (WHERE addr_housenumber IS NOT NULL OR addr_postcode IS NOT NULL)
             / greatest(count(*), 1), 1) AS percent_with_address
  FROM public.osm_sg_buildings;

SELECT kind, count(*) FROM public.osm_sg_search_index GROUP BY kind ORDER BY kind;
SELECT kind, count(*) FROM public.osm_sg_facilities GROUP BY kind ORDER BY kind;
SELECT public.fieldops_site_search_features();

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.fieldops_site_search_candidates('marina', 20);
EXPLAIN (ANALYZE, BUFFERS) SELECT public.fieldops_site_area(1.2834, 103.8607, 600, 2000, 1000);
```

**Rollback.** Before activation: `--fail <label>`. The rows already upserted carry the new extract, so to put the old rows back, import the step 2 export as a new version, activate it, and sweep. After activation the same applies. Code rollback is the flag (section 10). The columns and tables stay: they are additive and the legacy code does not read them.

**Adding an area other than Singapore (D13).** The admin path, written down but not built in version 1:

1. Generate an extract of the new region with the same generator and a label naming the region.
2. Import it as a version with its own `region` code; the partial unique index allows one active version per region.
3. `getSiteCoverage` already returns the union of active versions' boxes, so the picker would then accept points there.

What version 1 lacks, and an owner decision must precede: a `--region` flag in both scripts; a per-region data note (master 10.8 item 10 fixes the Singapore wording); removing the default city "Singapore" from `addressLine` for other regions; and an answer to whether the tables keep their `osm_sg_` names. Section 15 holds the question.

### 6.12 The tile proxy

`server/routes/tileProxy.ts` (touched) keeps its path, its `Access-Control-Allow-Origin: *` and its one-day browser cache, and gains (P9):

- `parseTileParams(z, x, y)`: integers only, `z` from 0 to 19 (the tile layer's `maxNativeZoom`), `x` and `y` from 0 to `2^z - 1`; anything else answers 400 before any upstream call.
- An eight-second timeout (`AbortSignal.timeout(8000)`) answering 504.
- An in-process cache of at most 1,000 tiles and 24 MB, keyed `z/x/y`, kept for the upstream `max-age` clamped to between one and seven days (one day when absent), with an `X-Tile-Cache: hit` or `miss` header.
- `User-Agent: Prophyion/1.0 (+https://prophyion.com)`: the tile usage policy asks for an identifying agent with a contact. The domain is the one the app already redirects to (`frontend/vercel.json`).
- The upstream host: the implementer reads the live tile usage policy (https://operations.osmfoundation.org/policies/tiles/) before the change and uses the host it recommends; if it still lists the `a`, `b` and `c` subdomains, the rotation stays.
- An upstream 5xx answers 502; other statuses pass through, as today.
- `createTileProxyRouter(deps)` takes `fetchImpl`, `timeoutMs` and the cache limits, for the test; `tileProxyRouter` stays the default export the app mounts.

Tile requests carry no token, so the global `limiter` already counts them by client address through its `keyGenerator`, at 10,000 per 15 minutes in production (`server/index.ts:196-214`); no second limiter is added. Authentication is not added either: tile images are requested by the browser without an `Authorization` header. The tiles reach the cross-origin production front end only because the tile layer asks for them in CORS mode (`crossOrigin="anonymous"`, `frontend/src/components/SceneEditor/SceneEditor.tsx:1875`): helmet's default `Cross-Origin-Resource-Policy: same-origin` is enforced by browsers on no-cors requests only. `SiteMap` keeps that attribute (section 7.3), which is also what lets auto-trace read the pixels. This is checked by hand in production (manual step M4).

## 7. Client

### 7.1 Files

All new files sit in `frontend/src/components/FieldOps/Site/ (new)`, except the stylesheet. Nothing here edits `SceneEditor.tsx`, `WarRoom.tsx`, `api.ts` or `warroom.css`.

| File | Contents |
| --- | --- |
| `frontend/src/components/FieldOps/Site/SiteLane.tsx (new)` | `SiteLane`: the lane head, the controls column, the map box; owns the reducer and the requests |
| `frontend/src/components/FieldOps/Site/PlaceSearch.tsx (new)` | `PlaceSearch`: the combobox and its dropdown |
| `frontend/src/components/FieldOps/Site/RadiusControl.tsx (new)` | `RadiusControl`: minus, slider, plus, value |
| `frontend/src/components/FieldOps/Site/SiteMap.tsx (new)` | `SiteMap`: Leaflet map, layers, HUD, nudge, legend, draw and trace modes |
| `frontend/src/components/FieldOps/Site/InvolvedBuildingsList.tsx (new)` | `InvolvedBuildingsList`: primary row, involved rows with roles, the accessible add list |
| `frontend/src/components/FieldOps/Site/RadiusNudge.tsx (new)` | `RadiusNudge`: the "outside the radius" pill and its Expand button (the UI sheet's row 4.161) |
| `frontend/src/components/FieldOps/Site/siteMapLayers.tsx (new)` | Extracted layers and helpers, also used by WS4 (section 7.2) |
| `frontend/src/components/FieldOps/Site/siteMapStyle.ts (new)` | `SITE_MAP_STYLE`, `getEstimatedRoadWidthM`, `getRoadStrokeWeight`; no Leaflet import, so a Node test can load it; re-exported by `siteMapLayers.tsx` |
| `frontend/src/components/FieldOps/Site/AutoTraceClickHandler.tsx (new)` | The Scene Editor's click-to-trace handler, extracted |
| `frontend/src/components/FieldOps/Site/siteLaneState.ts (new)` | The pure reducer and selectors (section 7.4); no React import, so client tests can load it |
| `frontend/src/components/FieldOps/Site/placeSearchState.ts (new)` | Pure helpers for the dropdown: `shouldSearch`, `createSearchScheduler`, `createSearchCache` |
| `frontend/src/components/FieldOps/Site/siteApi.ts (new)` | The four calls of section 6.3 and `SiteApiError` |
| `frontend/src/design/fieldops-site.css (new)` | The `fo-site-*` classes (section 7.9), imported by `SiteLane.tsx` |

Touched: `frontend/src/components/SceneEditor/buildingAutoTrace.ts` (one optional parameter) and `frontend/src/components/UI/WarRoomIcon.tsx` (the `train` and `minus` glyphs).

### 7.2 What moves out of the Scene Editor, what is dropped, what is new

**Extracted** (the Scene Editor keeps its own copies, D25):

| From | Lines | To | How |
| --- | --- | --- | --- |
| `MapRefSync` | `frontend/src/components/SceneEditor/SceneEditor.tsx:336-343` | `siteMapLayers.tsx` | Copied |
| `FitBounds` | `frontend/src/components/SceneEditor/SceneEditor.tsx:345-353` | `siteMapLayers.tsx` as `FitCircle` | Re-written to fit the ring (`L.latLng(centre).toBounds(2 * radius)`, padding 24) |
| `FlyToPoint` | `frontend/src/components/SceneEditor/SceneEditor.tsx:355-362` | `siteMapLayers.tsx` as `FlyTo` | Copied: an effect, skipping 0, 0 |
| `AutoTraceClickHandler` | `frontend/src/components/SceneEditor/SceneEditor.tsx:364-409` | `AutoTraceClickHandler.tsx` | Copied with its four status messages; it passes `{ debug: false }` |
| `getEstimatedRoadWidthM` and `getRoadStrokeWeight` | `frontend/src/components/SceneEditor/SceneEditor.tsx:132-172` | `siteMapStyle.ts` | Copied exactly; a test pins the table |
| `clipRoadPolylineToRadius` | `frontend/src/components/SceneEditor/SceneEditor.tsx:174-275` | `clipPolylineToCircle` in `shared/fieldOps/siteGeometry.ts (new)` | Re-implemented (section 5.3) |
| The tile, ring, street, footprint and trace-preview JSX | `frontend/src/components/SceneEditor/SceneEditor.tsx:1870-1967` | `SiteTiles`, `SiteRingLayer`, `SiteStreetsLayer`, `SiteFootprintsLayer` in `siteMapLayers.tsx`; the preview in `SiteMap` | Same `pathOptions` (section 7.3) |
| `BuildingDrawHandler` | the whole file | stays where it is, imported by `SiteMap` | Unchanged |
| `autoTraceBuilding` | `frontend/src/components/SceneEditor/buildingAutoTrace.ts:604-652` | stays where it is, imported | Gains `options: { debug?: boolean } = {}` as a fifth parameter; `showDebugPopup` runs only when `options.debug ?? true` (P10). The Scene Editor calls it with four arguments (`frontend/src/components/SceneEditor/SceneEditor.tsx:382`), so its behaviour is unchanged |

```tsx
// frontend/src/components/FieldOps/Site/siteMapStyle.ts (new) holds SITE_MAP_STYLE and the two road helpers;
// frontend/src/components/FieldOps/Site/siteMapLayers.tsx (new) re-exports them with the layers. Owned by WS3; WS4 imports both.
import type { LatLng, SiteAreaBuilding, SiteAreaRoad } from '@shared/fieldOps/site'; // alias as in frontend/src/lib/api.ts:11

export declare const SITE_MAP_STYLE: {
  ring: { color: '#22c55e'; weight: 1; fillColor: '#22c55e'; fillOpacity: 0.08; dashArray: '6 4' };
  centreDot: { radius: 8; color: '#22c55e'; fillColor: '#22c55e'; fillOpacity: 0.6; weight: 2 };
  street: { color: '#1d4ed8'; opacity: 0.95 };
  footprint: { color: '#f59e0b'; weight: 2; fillColor: '#f59e0b'; fillOpacity: 0.15; hoverFillOpacity: 0.35 };
  primary: { color: '#22d3ee'; weight: 3; fillColor: '#22d3ee'; fillOpacity: 0.28 };
  involved: { color: '#d97706'; weight: 2.2; fillColor: '#f8c766'; fillOpacity: 0.55 };
  ghost: { color: '#9ca3af'; weight: 1.5; dashArray: '4 3'; fillOpacity: 0 };
  tracePreview: { color: '#a855f7'; weight: 3; fillColor: '#a855f7'; fillOpacity: 0.2; dashArray: '8, 4' };
};
export declare function getEstimatedRoadWidthM(highwayType: string): number;
export declare function getRoadStrokeWeight(highwayType: string): number;
export declare function MapRefSync(props: { onMap: (map: import('leaflet').Map) => void }): null;
export declare function FlyTo(props: { centre: LatLng | null; zoom: number }): null;
export declare function FitCircle(props: { centre: LatLng | null; radiusM: number; trigger: number }): null;
export declare function SiteTiles(): JSX.Element; // /api/tiles through VITE_API_URL, crossOrigin="anonymous"
export declare function SiteRingLayer(props: { centre: LatLng; radiusM: number }): JSX.Element;
export declare function SiteStreetsLayer(props: { roads: Array<Pick<SiteAreaRoad, 'highway' | 'segments'>> }): JSX.Element;
export declare function SiteFootprintsLayer(props: {
  buildings: SiteAreaBuilding[];
  interactive: boolean;
  onClick?: (osmId: string) => void;
}): JSX.Element;
// frontend/src/components/FieldOps/Site/RadiusNudge.tsx (new): the UI sheet's RadiusNudge (its row 4.161), owned by WS3.
export declare function RadiusNudge(props: {
  ghost: { name: string; distance_m: number; expandTo: number | null } | null;
  onExpand: () => void;
}): JSX.Element | null;
export type { SiteAreaRoad };
```

**Dropped** (none of these appear in the new picker): the GPS lookup and its "Locating you..." banner, the country list, the Lat, Lng and Radius boxes, the OSM source switch and its re-fetch, Fetch Buildings, the "Select one" pick list, the browser's Nominatim search and reverse lookup, the building-name box shown while drawing, and the auto-trace debug pop-up.

**New**: the dropdown over the saved index; the 150 m default with a 50 to 500 m control where expanding re-fetches and shrinking clips locally; primary, involved and ghost styles; the involved list with roles; the nudge "expand to include it"; the primary chosen from the search result; the outside-coverage state; the data note.

### 7.3 `SiteMap`: layers, styles and modes

The visual language stays the Scene Editor's where the code has it (section 3.2); the states the code lacks take the mockup's (D28).

| Layer | Source of the style | Values |
| --- | --- | --- |
| Tiles | Code (`frontend/src/components/SceneEditor/SceneEditor.tsx:1870-1876`) | `/api/tiles/{z}/{x}/{y}.png` behind `VITE_API_URL`, `crossOrigin="anonymous"`, `maxNativeZoom` 19, `maxZoom` 22. Attribution `&copy; OpenStreetMap contributors`, as the mockup shows (`docs/design/warroom/field-ops-setup.html:729`) and the tile policy asks, instead of `&copy; OSM` |
| Ring and centre dot | Code (`frontend/src/components/SceneEditor/SceneEditor.tsx:1880-1905`) | `SITE_MAP_STYLE.ring` and `centreDot`; not interactive |
| Streets | Code (`frontend/src/components/SceneEditor/SceneEditor.tsx:1907-1918`) | `#1d4ed8`, weight `getRoadStrokeWeight(highway_type)`, opacity 0.95, one `Polyline` per segment; not interactive |
| Other buildings inside the ring | Code (`frontend/src/components/SceneEditor/SceneEditor.tsx:1920-1935`) | `SITE_MAP_STYLE.footprint`; on hover fill 0.35 and weight 3, so the outline reads against the tiles (the UI sheet's contrast note); clickable in select mode only |
| Primary | Mockup (`docs/design/warroom/field-ops-setup.html:328`) | The primary entry of `SITE_MAP_STYLE`: cyan stroke 3 and cyan fill 0.28 (the edit phase's navy fill is not used); not clickable; a permanent centred label in `#0e7490` |
| Involved | Mockup (`docs/design/warroom/field-ops-setup.html:327`) | The involved entry of `SITE_MAP_STYLE`; the mockup's solid `#F8C766` becomes 0.55 opacity so tile text stays readable; a permanent label |
| Ghost | Mockup (`docs/design/warroom/field-ops-setup.html:330`) | `SITE_MAP_STYLE.ghost`, with a permanent label; not clickable while outside, as in the mockup, where `pointer-events: none` stays on (`docs/design/warroom/field-ops-setup.html:329`); `RadiusNudge` acts for it |
| Buildings between the radius and the fetched radius | Mockup (`docs/design/warroom/field-ops-setup.html:329`) | Not drawn (P5) |
| Trace preview | Code (`frontend/src/components/SceneEditor/SceneEditor.tsx:1955-1967`) | `SITE_MAP_STYLE.tracePreview` |
| Draw preview | Code (`BuildingDrawHandler`) | Its own styles, unchanged |

Overlays inside the map box, all above Leaflet's panes:

- **HUD**, top right: "150 m · 14 buildings · 9 streets", counting every footprint that touches the ring (primary and involved included) and every street with a segment inside it, the mockup's format (`docs/design/warroom/field-ops-setup.html:1332`). While an area loads it reads "Loading the saved map data".
- **`RadiusNudge`**, top centre, for the nearest ghost (one at a time, as in the mockup): "<name> is <d> m away — outside the radius" and a button "Expand to <t> m". When that ghost joins, the next nearest ghost's nudge appears. For a ghost beyond 500 m: "<name> is <d> m away, beyond the 500 m limit", with no button. Hidden in draw and trace modes.
- **Legend**, bottom left: Primary, Involved, Other building, Streets, with the four swatches.
- **Mode strip**, bottom, in draw or trace mode (section 7.6).

**Modes.** `select` (the default): clicks on footprints inside the ring. `draw`: `BuildingDrawHandler` is active and footprints are not interactive. `trace`: `AutoTraceClickHandler` is active, footprints are not interactive, and the tolerance slider shows. The Leaflet `doubleClickZoom` is disabled by the draw handler itself while drawing.

**Fitting.** After a pick, a click that sets the primary, or a radius change by the nudge, `FitCircle` fits the ring. A plain slider change does not move the map. A street pick also flies to zoom 17.

```ts
// frontend/src/components/FieldOps/Site/SiteMap.tsx (new). Props.
export interface SiteMapProps {
  centre: LatLng | null;
  radiusM: number;
  buildings: SiteAreaBuilding[]; // visibleBuildings(state): inside the ring, not primary or involved
  roads: Array<Pick<SiteAreaRoad, 'highway' | 'segments'>>; // visibleRoads(state)
  primary: BuildingRef | null;
  involved: InvolvedBuildingRef[];
  ghosts: SiteGhost[];
  mode: 'select' | 'draw' | 'trace';
  traceTolerance: number; // 10 to 40, default 20
  hud: { radiusM: number; buildings: number; streets: number; loading: boolean };
  fitTrigger: number; // bumped by the lane when the ring should be fitted
  onFootprintClick: (osmId: string) => void;
  onExpandToGhost: (key: string) => void; // from RadiusNudge
  onOutlineFinished: (polygon: LatLng[], source: 'draw' | 'trace') => void;
  onModeCancel: () => void;
  onTraceStatus: (status: string | null) => void;
}
```

### 7.4 The lane's state

`siteLaneReducer` in `frontend/src/components/FieldOps/Site/siteLaneState.ts (new)` is pure. `SiteLane` holds it with `useReducer`, runs the requests the selectors ask for, and calls `onChange` when the normalised site changes.

```ts
// frontend/src/components/FieldOps/Site/siteLaneState.ts (new). No React import.
export interface SiteGhost {
  key: string; // involvedKey
  ref: InvolvedBuildingRef;
  distance_m: number;
  expandTo: number | null; // expandTargetFor(distance_m)
  source: 'radar' | 'dropped';
}
export interface SiteLaneState {
  phase: 'empty' | 'loading_area' | 'awaiting_primary' | 'ready' | 'outside_coverage' | 'unavailable';
  mode: 'select' | 'draw' | 'trace';
  query: string;
  current: SiteSearchResult | null; // the row marked current in the dropdown
  centre: LatLng | null;
  radiusM: number;
  area: SiteArea | null;
  areaRequestId: number;
  coverage: SiteCoverageResponse | null;
  site: SiteSelection | null; // the last site that passed normaliseSiteSelection on the client
  ghosts: SiteGhost[];
  pendingOutline: { polygon: LatLng[]; source: 'draw' | 'trace' } | null;
  proposal: { place_text: string; resolution: SiteHintResolution | null } | null; // from WS2's ledger
  offered: SiteSearchResult[] | null; // an ambiguous resolution's candidates, shown without a request
  notice: { text: string; tone: 'info' | 'warn' } | null; // read out by the live region
  problem: string | null; // the message of a refused change
  fitTrigger: number;
}
export type SiteLaneEvent =
  | { type: 'coverage_loaded'; coverage: SiteCoverageResponse }
  | { type: 'proposal_received'; place_text: string; resolution: SiteHintResolution | null }
  | { type: 'site_replaced'; site: SiteSelection | null } // the site prop changed from outside the lane
  | { type: 'query_changed'; query: string }
  | { type: 'result_picked'; result: SiteSearchResult }
  | { type: 'area_loaded'; area: SiteArea; requestId: number }
  | { type: 'area_failed'; requestId: number }
  | { type: 'footprint_clicked'; osmId: string }
  | { type: 'nearby_added'; osmId: string }
  | { type: 'radius_changed'; radiusM: number }
  | { type: 'ghost_expand'; key: string }
  | { type: 'involved_kind_changed'; key: string; kind: InvolvedBuildingKind }
  | { type: 'involved_label_changed'; key: string; label: string }
  | { type: 'primary_name_changed'; name: string }
  | { type: 'involved_removed'; key: string }
  | { type: 'mode_changed'; mode: 'select' | 'draw' | 'trace' }
  | { type: 'outline_finished'; polygon: LatLng[]; source: 'draw' | 'trace' }
  | { type: 'outline_used'; as: 'primary' | 'involved' }
  | { type: 'outline_discarded' }
  | { type: 'reset_to_search' };
export declare function initialSiteLaneState(site: SiteSelection | null): SiteLaneState;
export declare function siteLaneReducer(state: SiteLaneState, event: SiteLaneEvent): SiteLaneState;
export declare function areaRequestFor(state: SiteLaneState): { centre: LatLng; radius_m: number; immediate: boolean } | null;
export declare function visibleBuildings(state: SiteLaneState): SiteAreaBuilding[];
export declare function visibleRoads(state: SiteLaneState): Array<Pick<SiteAreaRoad, 'highway' | 'segments'>>;
export declare function hudCounts(state: SiteLaneState): { radiusM: number; buildings: number; streets: number };
export declare function nearbyOptions(state: SiteLaneState): Array<{ osm_id: string; label: string; distance_m: number }>;
```

| Event | Rule |
| --- | --- |
| `result_picked`, building or address with a building | `centre` = the result's centre, `radiusM` = 150, involved and ghosts cleared, `phase` `loading_area`. On `area_loaded`, the building with that `osm_id` becomes the primary, `centre` moves to its vertex mean, `place_label` is the result's label and `address` its address; `phase` `ready` |
| `result_picked`, street or address without a building | `centre` = the result's centre, `radiusM` = 150, `phase` `loading_area`, then `awaiting_primary`; for an address, a footprint containing the point becomes the primary at once |
| `footprint_clicked` while `awaiting_primary` | That building becomes the primary; `place_label` = its name, else the picked label; `centre` moves to its vertex mean (a new area request follows) |
| `footprint_clicked` while `ready` | An involved building is removed; another inside the ring is added with `includeBuilding`, kind `defaultInvolvedKind(place_class)` and label = its name or the kind's label; the primary is ignored; a refusal sets `problem` |
| `radius_changed` | `applyRadius`; dropped buildings become ghosts with `source` `dropped` and a `notice` "{name} is now outside the radius and no longer involved." (P6; this settles the UI sheet's open point in its section 8.4 in favour of the mockup, with the notice and the ghost as the safety net) |
| `ghost_expand` | `includeBuilding` with the ghost's distance; the ring fits; the ghost goes |
| `outline_finished` | With no primary, the outline becomes the primary (`osm_id` null, `name` null). Otherwise `pendingOutline` is set and the strip asks "Use as the primary building" or "Add to the buildings involved" |
| `outline_used` `involved` | Added with kind `other` and label "Drawn building", expanding the radius when needed; refused with "This outline is more than 500 m from the primary building." when `expandTargetFor` is null |
| `outline_used` `primary` | Replaces the primary; involved buildings now outside the ring are dropped as for a radius change |
| `proposal_received` | The lane never applies the radar's site itself and never changes `state.site` on this event: WS2's `applyRadarResult` (`03-setup-screen.md` section 5.4) applies `resolution.selection` only to a draft with no site, and the lane then receives it as `site_replaced` (WS2's request R10). With no site: `outside_coverage` sets `phase` `outside_coverage` with "Your document places the incident in <place_text>."; `ambiguous` puts `place_text` in the box and its candidates in `offered`; `not_found` puts `place_text` in the box with the reason as `notice`; `resolved` and `unavailable` change nothing until the site arrives. With a site: every involved resolution that has a building, is not involved, and lies outside the ring becomes a ghost with `source` `radar` and its `expand_to` |
| `site_replaced` | The site prop changed (WS2 applied a selection, a save came back normalised, or another tab won): adopt it as `state.site`, take its centre and radius, request the area if needed, and drop ghosts that are now involved or inside the ring |
| `area_loaded` | Ignored unless `requestId` is the latest. `coverage` `outside_bbox` or `no_data_nearby` sets `phase` `outside_coverage` |
| `area_failed` | `phase` `unavailable` unless a newer request is in flight |
| `reset_to_search` | Back to `empty`, keeping `coverage`; the cleared site goes out through `onChange(null)` and stays cleared, because nothing in the lane re-applies the radar's selection |

After every event the reducer builds a client context from `area.buildings`, the ghosts' footprints (which came from the server's resolution, so a radar ghost joined before the wider area loads is still recognised) and `coverage.boxes`, and runs `normaliseSiteSelection` on the candidate site. On success the result becomes `state.site`; on failure the change is refused, `state.site` is unchanged and `problem` holds the message. `SiteLane` calls `onChange(state.site)` when `siteFingerprint` or `place_label` changes.

`areaRequestFor` asks for a request when there is a centre and either no area, an area whose centre differs by more than 1 m, or a radius beyond `area.fetched_radius_m`. A request caused by a pick or a centre change is immediate; one caused by the slider waits 300 ms after the last change. `visibleBuildings` keeps area buildings within `radiusM` that are neither primary nor involved; `visibleRoads` re-clips the loaded segments to `radiusM` with `clipPolylineToCircle`, so shrinking never asks the server.

### 7.5 `PlaceSearch`

```ts
// frontend/src/components/FieldOps/Site/PlaceSearch.tsx (new). Props.
export interface PlaceSearchProps {
  query: string;
  currentId: string | null; // the row shown as the current pick (the mockup's "sel")
  near: LatLng | null; // the map centre, used to bias the ranking
  status: 'idle' | 'found' | 'street' | 'drawn' | 'none'; // drives the line under the box
  offered?: SiteSearchResult[] | null; // an ambiguous radar resolution's candidates, listed without a request
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  onPick: (result: SiteSearchResult) => void;
  search?: (q: string, near: LatLng | null, signal: AbortSignal) => Promise<SiteSearchResponse>; // injectable; defaults to siteApi.searchSites
}
```

- **When it asks.** `shouldSearch(query)` is true when `normaliseSearchText(query)` has at least two characters. `createSearchScheduler` waits 250 ms after the last keystroke, aborts the previous request with an `AbortController`, and numbers requests so a late answer to an older one is dropped.
- **Cache.** `createSearchCache` keeps 50 answers for five minutes, keyed by the normalised query and the `near` point rounded to 0.01 degrees; a hit answers at once without a request.
- **Rows.** An icon tile (`WrIcon` by `icon`), the label in bold and the type label below, as in the mockup (`docs/design/warroom/field-ops-setup.html:635-640`). The current pick carries the current style. The closing note row is always last.
- **Keyboard and ARIA.** The input has `data-field="fo:site:search"` (so WS2's readiness can jump to it), `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded` and `aria-controls`; the list has `role="listbox"` and the rows `role="option"` with `aria-selected`; `aria-activedescendant` follows the arrow keys; Enter picks the active row (or the first); Escape closes; Tab closes. A polite live region reads "8 matches", "No matches" or the error.
- **The line under the box**, by `status`: `found` "Found in the saved map data · building outline loaded" (`docs/design/warroom/field-ops-setup.html:644`); `street` "Street found in the saved map data · click the building on the map"; `drawn` "Drawn by you · not in the saved map data"; `none` and `idle` show nothing.

### 7.6 `RadiusControl`, `InvolvedBuildingsList`, Draw and Auto-trace

```ts
export interface RadiusControlProps {
  value: number; // 50 to 500
  onChange: (radiusM: number) => void; // called on every input event; the lane debounces requests
  disabled?: boolean;
}
export interface InvolvedBuildingsListProps {
  primary: BuildingRef | null;
  involved: InvolvedBuildingRef[];
  nearby: Array<{ osm_id: string; label: string; distance_m: number }>; // nearbyOptions(state)
  max: number; // SITE_LIMITS.maxInvolved
  disabled?: boolean;
  onKindChange: (key: string, kind: InvolvedBuildingKind) => void;
  onLabelChange: (key: string, label: string) => void;
  onPrimaryNameChange: (name: string) => void; // shown only for a custom primary
  onRemove: (key: string) => void;
  onAddNearby: (osmId: string) => void;
}
```

- **RadiusControl** follows the mockup (`docs/design/warroom/field-ops-setup.html:647-651`): a minus button (`WrIcon` `minus`, "Smaller"), a range from 50 to 500 in steps of 10 ("Radius in metres", `aria-valuetext` "150 metres"), a plus button (`WrIcon` `plus`, "Larger") and the value "150 m", then the help line. Buttons move by 10 and stop at the ends.
- **InvolvedBuildingsList** follows the mockup (`docs/design/warroom/field-ops-setup.html:653-657`, `docs/design/warroom/field-ops-setup.html:1335-1349`): the label "Buildings involved" with a count pill (the primary plus the involved buildings); the primary row in cyan with its name (or "Unnamed building") and "Primary · full interior layout next"; one row per involved building with an amber square, its label, "Involved · shown on the scene map" or "Unnamed in the map data · name it" with a name box, a role select ("Role of {name}") offering the four `INVOLVED_KIND_LABELS`, and a remove button ("Remove {name}", `WrIcon` `x`). Under the rows: a select "Add a building inside the radius" listing `nearbyOptions` as "<name or type label> · <d> m", disabled at the limit or when empty; then the help line.
- **Draw.** "Not on the map? Draw it" (`WrIcon` `edit`) sets draw mode. The strip reads "Click the map to place corners. Click the first corner, press Enter or double-click to finish. Esc cancels; Backspace removes the last corner." with a "Cancel drawing" button. No text box is shown while drawing, so the draw handler's window-level keys never fight an input (section 3.4), and draw and trace modes end as soon as focus moves to any control outside the map box, so typing elsewhere on Setup can never edit an outline.
- **Auto-trace.** "Auto-trace (magic wand)" (`WrIcon` `sparkle`) sets trace mode. The strip reads "Click a building on the map to trace its outline." with "Colour tolerance" from Tight (10) to Loose (40), default 20, and "Cancel". Statuses are the Scene Editor's four messages (section 3.4). A traced outline shows in the preview style with "Traced <n> corners." and the buttons "Use this outline", "Try again" and "Cancel".
- **After an outline.** With a primary present, the strip asks "Use as the primary building" or "Add to the buildings involved" (section 7.4).

### 7.7 `SiteLane` and its copy

```ts
// frontend/src/components/FieldOps/Site/SiteLane.tsx (new). Rendered by WS2's SetupStep as lane 2.
// The same props as WS2's mount point (03-setup-screen.md section 7.7): WS3 may add optional props, never rename these.
export interface SiteLaneProps {
  draftId: string | null;
  site: SiteSelection | null; // setup.site
  onChange: (next: SiteSelection | null) => void; // updateSetup({ site }); WS2's save route normalises it again
  proposal: { footprint: SiteProposal; built: RadarLedgerPayload['built']['site'] } | null; // setup.footprint.site and the adopted run's built.site
  issueAt: (field: string) => LaneIssue | null; // WS2's field notes, anchors fo:site:<part>
  readOnly: boolean; // true while the draft is compiling or compiled
}
```

The lane reads `proposal.footprint.place_text` and `proposal.built?.resolution` and turns them into `proposal_received` (section 7.4). It never writes the radar's site: WS2's `applyRadarResult` applies `built.site.selection` only to a draft with no site, once per adopted run (`03-setup-screen.md` section 7.5), so a site the trainer set or cleared is never overwritten from the lane (WS2's request R10, AC3.31). It marks its elements with WS2's `data-field` anchors (`fieldAnchor.site(part)`) and shows `issueAt` notes under them: `fo:site:search` on the search input itself (WS2's request R8), `fo:site:radius`, `fo:site:primary` (the primary row), `fo:site:involved:<key>` (each involved row) and `fo:site:map`. A site stays at about 75 KB of JSON at most (six polygons of 500 points at about 24 characters a point, plus at most 1 KB of text), inside WS2's 96 KB allowance (request R10).

Layout, from the mockup (`docs/design/warroom/field-ops-setup.html:616-735`): a `wr-lane` with a `wr-lanehead` (vignette `/marketing/library/44-map-table-sm.webp`, caption "The site", heading "Where" with `WrIcon` `map`, the description, the count pill), then one `wr-node` holding the `fo-site` grid: the controls column (search, radius, buildings involved, the two outline buttons, the data note) and the map box. The lane and its head are built with WS2's `LaneShell` and `LaneHead` (`frontend/src/components/WarRoom/lanes/LaneShell.tsx (new)`), the head's values going to their `art`, `caption`, `title`, `icon`, `lead` and `count`.

| Element | Copy |
| --- | --- |
| Lane caption | The site |
| Heading | Where |
| Description | Type an address, landmark or street. The building, its neighbours and the streets are outlined from our saved map data. |
| Count pill | `<place_label> · <radius> m`, or "Not set"; text `#166534` on the lane tint, for contrast (the UI sheet's request) |
| Search label and placeholder | Address, landmark or street / "Search the saved map data" |
| Dropdown note | Addresses, building names and street names from the saved map data. A street opens the map there; then click the building. |
| Dropdown: too short | Type at least 2 characters. |
| Dropdown: loading | Searching the saved map data |
| Dropdown: empty | No matches in the saved map data. Try a street name, a postcode or a building name. |
| Dropdown: error | Search is not available right now. Try again in a moment. |
| Dropdown: names-only mode | Addresses are not searchable yet. Building and street names work. |
| Radius label and help | Radius around the site / Starts at 150 m. Expand to pull in more streets and buildings, or shrink to trim the map. |
| Involved label and help | Buildings involved / Click footprints on the map to add them. The primary building gets the full interior layout next; the others get exits and wall points generated from their footprint. |
| Limit | You can add up to 5 buildings besides the primary. Remove one first. |
| Waiting for a primary | Click the building on the map to make it the primary building. |
| Outline buttons | Not on the map? Draw it / Auto-trace (magic wand) |
| Data note | `siteDataNote(coverage.data_version)`: "Map data: saved OpenStreetMap for Singapore." plus " Extract of 2 Nov 2026." when known |
| Outside coverage: title | No saved map data for this area yet |
| Outside coverage: body | The site picker uses only the saved OpenStreetMap data, which covers Singapore. Nothing is looked up live, so a place outside it cannot be set. Ask an administrator if you need another area. |
| Outside coverage from the document | Your document places the incident in <country or place>. |
| Outside coverage: action | Search in Singapore instead |
| Unavailable | The saved map data could not be loaded. / Try again |
| Shrink notice | {name} is now outside the radius and no longer involved. |
| Added and removed notices | {name} added to the buildings involved. / {name} removed. |
| Primary with no name | Unnamed building |
| Remove button | Remove {name} (accessible name) |
| Vanished building (server warning) | {name} is no longer in the saved map data, so its outline is kept as drawn. |

### 7.8 `siteApi.ts`

```ts
// frontend/src/components/FieldOps/Site/siteApi.ts (new). Same URL and token pattern as
// frontend/src/components/SceneEditor/SceneEditor.tsx:87-99, because the helpers in api.ts are private.
export declare class SiteApiError extends Error {
  status: number;
  code: string | null;
  details: unknown[];
}
export declare function searchSites(q: string, near: LatLng | null, signal?: AbortSignal): Promise<SiteSearchResponse>;
export declare function loadArea(centre: LatLng, radiusM: number, signal?: AbortSignal): Promise<SiteArea>;
export declare function validateSite(site: SiteSelection): Promise<{ site: SiteSelection; warnings: SiteIssue[]; fingerprint: string }>;
export declare function getCoverage(point?: LatLng): Promise<SiteCoverageResponse>;
```

Each call unwraps `{ data }`; any other status throws `SiteApiError` with the body's `code`. `SiteLane` calls `getCoverage()` once on mount and `validateSite` only for a custom outline, before it is emitted, so a crossing outline is refused at once with the server's own message; every other change is checked on the client and again by WS2's save.

### 7.9 Stylesheet and icon

`frontend/src/design/fieldops-site.css (new)` holds only `fo-` classes (master 10.8 item 19) and reuses the existing lane primitives (`wr-lane`, `wr-lanehead`, `wr-node`, `wr-field`, `wr-btn`, `wr-lbl`, `wr-help`, section 3.7). The class names are the ones the UI sheet assigns to WS3's elements (`10-ui-spec-sheet.md`, its class-mapping table), plus five for elements the mockup lacks. Each ports the mockup rule named:

| Class | Mockup rule (`docs/design/warroom/field-ops-setup.html`) | Notes |
| --- | --- | --- |
| `fo-site`, `fo-site-controls` | `.site`, `.site .ctl` (lines 284-285) | Grid of 330 px and the rest, gap 18 px; one column at 1,100 px and below (line 361); the controls stack 14 px apart |
| `fo-place-search`, `fo-place-list`, `fo-place-option`, `fo-place-type`, `fo-place-note` | `.acwrap`, `.ac`, `.ac button`, `.ac .ty`, `.ac .note` (lines 286-295) | The list's `z-index` is 1100 so it sits above the map; the note text is `#475467`, for contrast (the UI sheet's request) |
| `fo-place-option.is-active`, `fo-place-option.is-current` | `.ac button:hover`, `.ac button.sel` (line 291) | Active is the keyboard row; current is the pick |
| `fo-radius` | `.rad`, `.rad .val` (lines 296-298) | Range `accent-color` `#16A34A`; the value is mono, right aligned, 52 px minimum |
| `fo-buildings`, `fo-building`, `fo-building.primary` | `.blist`, `.bld`, `.bld.primary`, `.bld .sq` (lines 299-307) | |
| `fo-sitemap` | `.mapbox` (line 308) | `isolation: isolate` so Leaflet's own `z-index` values stay inside; height 380 px, 300 px at 1,100 px and below |
| `fo-sitemap-hud`, `fo-sitemap-legend`, `fo-radius-nudge` | `.mapbox .hud`, `.mapbox .legend`, `.nudge` (lines 313-318) | `z-index` 1001, above Leaflet's controls |
| `fo-site-okline` | `.okline` (line 147) | Not in the UI sheet's table |
| `fo-site-outline-btn` | The dashed small buttons (line 660) | A dashed `wr-btn sm`; not in the UI sheet's table |
| `fo-sitemap-label`, `fo-sitemap-label.primary` | `svg .bl`, `svg .bl.cy` (lines 331-332) | For Leaflet tooltips: no box, white halo, 9.5 px bold; the UI sheet leaves these to path options |
| `fo-site-modebar`, `fo-site-state` | None | The draw and trace strip, and the outside-coverage and unavailable panel |

`WrIcon` gains two glyphs, both requested of WS3 by the UI sheet. `train`, drawn from the mockup's `i-train` symbol (`docs/design/warroom/field-ops-setup.html:409`): `'M8 3h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M5 11h14 M9 21l2-4 M15 21l-2-4 M9 14h.01 M15 14h.01'`. `minus`, for the Smaller button: `'M5 12h14'`, matching the existing `plus` stroke. If another workstream adds either first, WS3 reuses it.

### 7.10 Accessibility and small screens

- The search is a full combobox (section 7.5); every icon-only button has an `aria-label`; the legend names each colour in words.
- Map footprints cannot take keyboard focus, so "Add a building inside the radius" and each row's remove button give a keyboard path to everything a click does (AC3.29). This is an accessibility addition to the mockup under D28.
- One polite live region in the lane reads `notice`, `problem`, trace statuses and result counts.
- Focus moves to the search box after "Search in Singapore instead" and after "Cancel drawing".
- At 1,100 px and below the controls stack above the map (the mockup's breakpoint); the map keeps a 300 px height so it stays usable on a tablet. Leaflet's touch dragging and pinch zoom are unchanged.

## 8. AI and LLM contracts

Not applicable: WS3 makes no model call. The footprint radar's model call belongs to WS2; WS3 receives the place words it extracted as a `SiteHint` (section 5.2) and resolves them deterministically against the saved index with `resolveSiteHint` (section 6.8). No model output is ever used as map data: a place becomes a site only when it matches a row of the saved tables, and no model is asked for coordinates. WS2's guard rail adds the document's country name when the document states one (`03-setup-screen.md` section 8.5, rule 11), so that `resolveSiteHint` can say "outside coverage" instead of "not found".

## 9. Security, privacy and safety

**Authentication and authorisation.** Every site route runs `requireAuth` and the trainer-or-admin check, and answers 404 while `ENABLE_FIELDOPS_V2` is off (section 6.3). The server reads the tables with the service role, so the route is the only gate. The new tables (`osm_sg_data_versions`, `osm_sg_search_index`, `osm_sg_facilities`) have RLS on and no policy, so the browser's anon key reads nothing (master section 9). The four new functions revoke `EXECUTE` from `PUBLIC`, `anon` and `authenticated` and grant it to `service_role` only, so they cannot be called through the public RPC endpoint either.

**Cost and abuse.** Per-user limits of 120 searches, 40 area reads, 30 validations and 60 coverage checks a minute sit under the global limiter. The area read is bounded three times: the radius is capped at 600 m in SQL, the SQL limits rows to 3,000 buildings and 2,000 streets, and the shaped response to 1,500 buildings, 800 streets, 500 vertices a footprint and 1.5 MB. Server caches are bounded (500 searches, 100 areas, 1,000 tiles or 24 MB). The `/validate` body is bounded by the schema (at most 21 polygons of 501 points); the app-wide JSON limit stays 10 MB (`server/index.ts:255`).

**Input handling.** Every query and body goes through `validate()` with the zod schemas of section 6.2. The search text is normalised to letters, digits and single spaces before it reaches SQL, so it carries no `LIKE` wildcard or text-search operator; the SQL still escapes `%`, `_` and backslashes and quotes every text-search token with `quote_literal`. No SQL is built from strings in TypeScript: the functions take parameters, and the names-only fallback passes an escaped value to `ilike`.

**The client is not trusted for map data.** The server replaces any polygon that names an `osm_id` with the stored footprint, recomputes the centre, stamps the data version, and checks every custom polygon (P4, section 6.6). A browser cannot make the draft hold a building the saved data does not have under that id.

**No live map data.** New code calls no Overpass, Nominatim or Google service, and the static test of AC3.22 keeps it that way. The browser loads tiles only through `/api/tiles`. The legacy Scene Editor still calls Nominatim and the tile hosts from the browser (section 3.1) until WS4 hides its map phase; that is unchanged and outside the static test's scope. The report-only CSP in `frontend/vercel.json:48-49` lacks the API origin; before anyone enforces it, `img-src` and `connect-src` must list the API origin, and `nominatim.openstreetmap.org` can go once the legacy map phase is retired (section 15).

**The tile proxy.** Journey finding 4.7 called it an open relay. Section 6.12 adds parameter validation, a timeout, a bounded cache and an identifying User-Agent; it stays unauthenticated because image requests carry no token, and the global limiter counts it per address. Fully closing the relay (signed tile URLs or a separate limiter) is left to an owner decision (section 15).

**Privacy.** The saved tables hold public OpenStreetMap data: footprints, street names, addresses and the names of public facilities, and no personal data. Search text, place labels and polygons are never logged (section 10.4). The site a trainer picks lives in her draft, which only WS2's owner-checked draft routes return; WS3 adds no route that reads a draft.

**The answer key.** WS3 writes nothing to `scenarios` (master 10.8 item 16) and stores no device data. Master risk 14 is unchanged by WS3: the live check of 25 Oct 2026 found that the public anon key alone, with no sign-in, reads every `rts_scene_configs` row, planted devices included, and that the bucket `rts-scene-images` is public. **Updated 8 Nov 2026:** migration 218 has since closed the policy to the creator and admins in production; the bucket is still public. WS3's own tables are not in that position, because they have RLS on with no policy.

**Safety stance.** This workstream handles no device information. The facilities table records public map features, including fuel stations and power substations, so that the responders' area dossier can name nearby hazards (D18); nothing in WS3 ranks places by crowding, vulnerability or effect, and the picker never suggests where anything should be placed.

**Licence.** OpenStreetMap data is used under the Open Database Licence: the map shows `&copy; OpenStreetMap contributors` (section 7.3), and the saved tables are an internal derived database that the app does not redistribute.

**The shared database.** The importer's guard (section 6.11) is the main protection against writing to the live project by mistake: dry run by default, the project reference typed by the operator, an explicit confirmation, a refusal during live sessions, and a shrink check before any delete.

## 10. Flags, rollout and observability

### 10.1 Flags and settings

| Flag | Where it is read | What it gates in WS3 |
| --- | --- | --- |
| `ENABLE_FIELDOPS_V2` | `env.enableFieldopsV2`, defined by WS0 in `server/env.ts`, read on every request | The four site routes (404 when off) |
| `VITE_ENABLE_FIELDOPS_V2` | WS2's page gate | Whether `/warroom/field-ops`, and so `SiteLane`, exists at all |
| `ENABLE_LOCAL_OSM_SINGAPORE` (existing) | `server/env.ts:144-146` | Nothing: the new code reads the tables directly and does not consult it |

Not flag-gated, on purpose: the tile proxy changes (valid requests get the same bytes; only malformed ones change, from an upstream error to 400), the optional auto-trace parameter (the Scene Editor's call is unchanged), the `train` glyph, and the generator and importer changes (operator tools). WS3 adds no non-flag setting to master section 8; its tuning values are the `SITE_LIMITS` constants.

### 10.2 Rollout

1. Merge the shared contract and the server code with the flag off in production (on in development, master section 8).
2. Apply migrations 229 to 232 (section 6.11 runbook, step 1). The code already tolerates them missing (section 5.5) and starts using them within about a minute.
3. Run the re-extract and import with the guard (task T3.14), and activate the version.
4. Build a staging front end with `VITE_ENABLE_FIELDOPS_V2` and turn `ENABLE_FIELDOPS_V2` on: run the manual steps of section 11.3.
5. Production for the owner's account, then everyone, together with WS2's page (slice B of master section 6).

**Rollback.** Turn `ENABLE_FIELDOPS_V2` off: the routes answer 404 and the page is absent; drafts keep their `setup_v2.site`, which stays valid. Migrations stay (additive). A bad import is undone forward, by importing the last export as a new version (section 6.11).

### 10.3 Feature detection

Section 5.5. Each detector logs its result once at first use and again when it changes (`fieldops_site_feature`), so the logs show when a migration took effect.

### 10.4 Events

Pino, snake case, prefix `fieldops_` (master 10.5). Never the query text, a place label, an address or a polygon.

| Event | Level | Fields | Emitted by |
| --- | --- | --- | --- |
| `fieldops_site_search` | info | `user_id`, `q_length`, `results`, `mode`, `cache` (`hit` or `miss`), `ms` | `searchSites` |
| `fieldops_site_area_loaded` | info | `user_id`, `radius_m`, `fetched_radius_m`, `buildings`, `roads`, `truncated`, `source`, `coverage`, `ms` | `loadSiteArea` |
| `fieldops_site_validated` | info | `user_id`, `ok`, `code`, `involved`, `custom_polygons`, `warnings`, `ms` | `POST /validate` |
| `fieldops_site_hint_resolved` | info | `status`, `candidates`, `involved`, `involved_resolved`, `ms` | `resolveSiteHint` |
| `fieldops_site_outside_coverage` | info | `route`, `state` | area, coverage and hint paths |
| `fieldops_site_data_unavailable` | error | `route`, `pg_code` | any read failure that is not a missing migration |
| `fieldops_site_feature` | info | `feature`, `available` | `siteFeatures` |
| `fieldops_site_selected` | info | `draft_id`, `radius_m`, `involved`, `custom_polygons`, `data_version`, `fingerprint` | WS2's draft save, when `siteFingerprint` changes (WS2's save route emits it) |
| `fieldops_tile_proxy` | warn | `status`, `reason` (`bad_params`, `timeout`, `upstream`) | the tile proxy, for failures only |

What to watch after launch: the 95th percentile of `ms` for search and area, the share of `names_only` searches (should be zero once 230 is applied), the share of truncated areas (if above a few per cent, revisit the cap), and any `fieldops_site_data_unavailable`.

## 11. Tests

All automated tests use `node:test` through `tsx`, as the `test` script does today (`package.json:25`). Tests of `shared/` modules sit in `server/lib/fieldOps/` and import the module with a `.js` suffix (master 10.7 rule 3); client tests sit in `frontend/tests/` and load only modules without React or Leaflet. Services take their database calls through a small injectable `deps` object (`createSiteSearch(deps)`, `createSiteArea(deps)`, `createSiteHint(deps)`, `createFacilities(deps)`, each also exported as the default instance), so no test needs a database.

**Every file below is new and must be added to the explicit list in the `test` script of `package.json`; a file that is not listed never runs.**

### 11.1 Test files and cases

**`server/lib/fieldOps/site.test.ts (new)`**, for `shared/fieldOps/site.ts (new)`:

| Case | Input | Expected |
| --- | --- | --- |
| normalise trusts the saved footprint (AC3.13) | Primary `way/1` with a shifted polygon; context holds `way/1` | Stored polygon and name; centre is its vertex mean to seven decimals; `data_version` from the context; client `data_version` ignored |
| normalise removes a closing repeat (AC3.14) | Custom polygon whose last point equals the first | `ok: true`, warning `closing_vertex_removed`, ring without the repeat |
| normalise rejects: two points | Custom polygon of two points | `SITE_POLYGON_INVALID` |
| normalise rejects: 501 points | Custom polygon of 501 distinct points | `SITE_POLYGON_INVALID` |
| normalise rejects: crossing outline | A bow-tie of four points | `SITE_POLYGON_INVALID`, message "The outline crosses itself. Draw it again." |
| normalise rejects: outside coverage | A vertex at lat 1.60 | `SITE_OUTSIDE_COVERAGE` |
| normalise rejects: involved beyond the radius | Radius 150, involved footprint 200 m away | `SITE_INVOLVED_OUTSIDE_RADIUS` |
| normalise rejects: duplicate | Two involved with `way/7` | `SITE_INVOLVED_DUPLICATE` |
| normalise rejects: shape | `source: 'live_osm'`, or `radius_m: 49` | `SITE_INVALID` with the path in `details` |
| normalise refuses six involved (AC3.11) | Six valid involved buildings | `SITE_INVOLVED_LIMIT` |
| a vanished building becomes custom (AC3.15) | Involved `way/9` not in the context | `ok: true`, its `osm_id` null, warning `building_not_in_saved_data` |
| normalise fills labels | Empty involved label, empty place label | Label from the name, else the kind's label; place label from the primary's name |
| fingerprints (AC3.16) | One ring rotated by two and reversed; a new place label; a renamed primary; radius 150 against 160; kind `adjacent` against `other`; involved label "Car park" against "Multi-storey car park"; involved order swapped | Same `ringFingerprint`; same `siteFingerprint`; same; different; different; different; same |
| maps a site to the legacy location fields (AC3.17) | Fixture F2 | Exactly the expected object of F2 |
| expandTargetFor rounds 207 m up to 220 m (AC3.10) | 207, 140, 495 | 220, 150, null |
| includeBuilding expands and adds (AC3.10) | Radius 150, building at 207 m | `ok: true`, radius 220, `expandedTo` 220 |
| includeBuilding refuses a sixth (AC3.11) | Five involved | `{ ok: false, reason: 'limit' }`; also `is_primary`, `duplicate` and `too_far` (620 m) |
| applyRadius drops outside buildings | Involved at 80 m and 130 m; radius 100 | One kept, one returned in `dropped`; 47 clamps to 50 and 503 to 500 |
| the data note adds the extract date when known (AC3.26) | `{ label: 'sg-2026-11-02', extract_date: '2026-11-02' }`, then null | "Map data: saved OpenStreetMap for Singapore. Extract of 2 Nov 2026." and "Map data: saved OpenStreetMap for Singapore." |
| readiness rules and descriptions | Setups with no site and an `outside_coverage` radar proposal; a custom primary; an unnamed involved building; fixture F1 | `site.document_outside`, `site.drawn_outline` and `site.unnamed_involved` items with their fields and `info` level, ids `<rule>:<subject>`; nothing for F1; `describeSite(F1).readiness` is "Site set from the saved map data: Marina Court Mall plus 1 involved building, 150 m." |
| toggleInvolved | F1 with the MRT at 207 m, on then off | Radius 220 and the MRT involved; then removed, radius stays 220 |
| addressLine leaves out missing parts | Three partial addresses | "1 Marina Way, Singapore 018900", "Marina Way, Singapore", "Singapore 018900" |

**`server/lib/fieldOps/siteGeometry.test.ts (new)`**: `polygonVertexMean` equals the origin `projectPolygon` uses for the same ring (`frontend/src/lib/evacuation/geometry.ts:12-13`); `distanceToPolygonM` is 0 inside a 100 m square and about 30 m (within 0.5 m) for a point 30 m outside; `pointInPolygon` on an L-shaped footprint; `clipPolylineToCircle` returns an inside line unchanged, cuts a crossing line at the circle (matching the Scene Editor's intersection to 0.01 m on the same input), returns two segments for a line that leaves and re-enters, and nothing for a line wholly outside; `cleanRing` removes a closing repeat and consecutive duplicates; `simplifyRing` brings a 1,200-point ring to 500 or fewer, the same way every time; `simplifyLine` keeps the end points; `isSelfIntersecting` is true for a bow-tie and false for an L shape; `insideCoverage` on the fallback box.

**`server/lib/fieldOps/siteSearchText.test.ts (new)`**: "St. Andrew's Cathedral" becomes "st andrews cathedral"; "CAFÉ" becomes "cafe"; the case "removes wildcards and operators" (`%_\ ' & | ! ( ) :*` becomes empty; AC3.3); non-Latin letters are kept; the result is at most 80 characters; `cleanPostcode` turns "S018900" and "Singapore 018900" into "018900" and returns null for "01890" and "0189001"; `searchTokens` returns at most six tokens.

**`server/lib/fieldOps/sitePlaces.test.ts (new)`**: one tag set per rule of section 5.3 gives its class; precedence (`railway=station` with `amenity=parking` gives `transit_station`); `building=yes` gives null; the mall, car park, station and apartments labels and icons equal the mockup's; `buildingTypeLabel(null)` is "Building".

**`server/lib/fieldOps/siteSchemas.test.ts (new)`**: request schemas (an 81-character `q`, a bad `near`, `limit` 0 and 11, `radius` 49 and 501, `lat` without `lng` are all rejected; the valid forms pass); the parity case feeds a corpus of 30 site inputs (valid sites, missing fields, extra keys, wrong types, out-of-range numbers, a 502-point polygon, a bad `osm_id`, an unknown kind, `involved` of 21) to `siteSelectionSchema` and to `validateSiteSelectionShape`, and asserts that both accept or both reject every item.

**`server/lib/fieldOps/osmExtract.test.ts (new)`** (AC3.25): own address tags give `addr_source` `way`; a point inside a footprint gives `node`, the most frequent address wins and a tie goes to the point nearest the vertex mean; points in no footprint become lone address rows; `pickAllowedTags` keeps only the 16 keys and cuts values to 120 characters; facility tags follow the rule order of section 6.11, and a node and a way of the same kind and name within 50 m keep the way; `clusterStreets` splits one name used 3 km apart into two places, numbers them by latitude then longitude and adds `near_name`; `buildSearchIndexRows` writes the ids, labels and alt text of fixture F3; importance values for a 10,000 m² mall (0.9, with its class bonus), a 100 m² building with no class (0.401) and a 1 km street (0.667).

**`server/lib/fieldOps/osmImportGuard.test.ts (new)`** (AC3.24), the "guard" group: `parseProjectRef('https://abcd1234.supabase.co')` is `abcd1234` and a custom domain gives null; without `--apply` the plan has no writes; a mismatched or missing `--project-ref` refuses; a missing `--confirm-shared-database` refuses; one `in_progress` session refuses unless `--allow-live-sessions`; another `importing` version refuses and the same label resumes; a sweep leaving 89 per cent refuses, 90 per cent passes, and `--allow-shrink` passes; `--truncate` refuses when the table has rows.

**`server/lib/fieldOps/siteNoLiveProviders.test.ts (new)`** (AC3.22): "the scanned tree is clean" reads every existing file under `shared/fieldOps/ (new)` whose name starts with `site`, `server/services/fieldOps/site/ (new)`, `server/routes/fieldOpsSite.ts (new)`, `server/lib/fieldOps/siteSchemas.ts (new)`, `server/lib/fieldOps/osmExtract.ts (new)`, `server/lib/fieldOps/osmImportGuard.ts (new)`, `frontend/src/components/FieldOps/ (new)`, `frontend/src/pages/FieldOpsWizard.tsx (new)` (WS2's page) and `frontend/src/design/fieldops-site.css (new)`, and fails on any of, case-insensitively: `nominatim`, `overpass`, `googleapis`, `maps.google`, `google.com/maps`, `tile.openstreetmap.org`, `osmVicinityService`, `geocodingService`, `fetchStreetViewImage`, `VITE_GOOGLE_MAPS_API_KEY` or `/api/debug/`, reporting the file and line. "The scanner catches a planted host" runs the same scanner on an in-memory string. Missing paths are skipped, so the test passes before the files exist and bites as soon as they do.

**`server/services/fieldOps/site/siteRanking.test.ts (new)`** (AC3.1, AC3.2), on fixture F3:

| Case | Query | Expected first rows |
| --- | --- | --- |
| orders an address, its building and a street for a name prefix | `marina court` | "1 Marina Way, Singapore 018900" (`name_prefix`, family), "Marina Court Mall", "Marina Court Car Park", "Marina Court MRT Station", "Marina Court Residences", "Marina Court Road" last |
| a postcode puts its address first | `018900` | The address, `exact_address` |
| a house number and street put the address first | `1 marina way` | The address, `exact_address` |
| word prefix | `court mall` | "Marina Court Mall", `word_prefix` |
| substring from three characters | `ourt` | Buildings containing "ourt", `substring` |
| two characters use prefixes only | `ma` | No `substring` row |
| near bias | `block 12` with `near` at one of two blocks | The block within 2 km first |
| importance breaks ties | two prefix matches | The higher importance first |
| deterministic ties | equal importance | Shorter label, then alphabetical, then `id` |
| street cap | five streets and two buildings match | The buildings, then at most three streets |
| apostrophes | `st andrews` | "St. Andrew's Cathedral" |
| nothing matches | `zzzz` | An empty list |

**`server/services/fieldOps/site/siteSearch.test.ts (new)`** (AC3.5): uses the index and the ranking when the RPC answers; "falls back to names only when the index is missing" (`mode` `names_only`); retries once in names-only mode after a missing-function error; a one-character query makes no call; a cache hit makes no call; any other error throws `SiteDataUnavailableError`.

**`server/services/fieldOps/site/siteArea.test.ts (new)`** (AC3.18, AC3.19): "outside the boxes returns an empty area" without a database call; "caps buildings, vertices and size" (2,000 synthetic buildings, one of 1,200 vertices, a street of 900 points: 1,500 buildings, at most 500 vertices, segments of at most 400 points, `truncated` true, serialised size at most 1.5 MB); streets come back as clipped segments; `no_data_nearby` when nothing is within the radius; the fallback pages the base tables when the function is missing (`source` `table_scan`). **Added 3 Nov 2026** (AC3.32): "the data version reports its region", through an injected version row and with migration 229 missing.

**`server/services/fieldOps/site/siteHint.test.ts (new)`** (AC3.18, AC3.28): "outside coverage by country or coordinates" (country "Malaysia"; coordinates at lat 3.1; nothing is searched); "resolves the place and builds the selection" (AC3.28); "two equal matches are ambiguous"; a street as the best result is `ambiguous` with no selection; "no match is not found"; involved items keep only matches within 600 m of the primary; a car-park item with no name match takes the nearest car park within 500 m; an involved item that resolves to the primary is dropped; involved items are not searched when the place is not resolved; a read failure makes the whole resolution `unavailable`.

**`server/services/fieldOps/site/facilities.test.ts (new)`** (AC3.27): at most 50 per kind, nearest first, then by name; the radius filter; `kinds` narrows the result; `unavailable` when the table is missing; `outside_coverage` outside the boxes.

**`server/routes/fieldOpsSite.test.ts (new)`** (AC3.3, AC3.20, AC3.21): builds an Express app with `createFieldOpsSiteRouter` and injected fakes, listens on port 0 and calls it with `fetch`. Cases: "flag off answers 404" on all four routes; "no token answers 401"; "a participant answers 403" with `FORBIDDEN`; "search with wildcards answers 200"; "search over 80 characters answers 400" (with `code` `VALIDATION_FAILED` once WS0's change to `validate()` has landed); `radius=600` answers 400; "validate returns the normaliser's details" (six involved: 400 `VALIDATION_FAILED` with a detail `{ field: 'site.involved', code: 'SITE_INVOLVED_LIMIT' }`); a data failure answers 503 `SITE_DATA_UNAVAILABLE`; "the search limit is per user" (limit set to 3: the fourth search by one user answers 429 `RATE_LIMITED`, a second user still gets 200); each route's `Cache-Control`.

**`server/routes/tileProxy.test.ts (new)`** (AC3.23): `parseTileParams` accepts `19/0/524287` and rejects `20/0/0`, `5/-1/0`, `5/0/32` and `a/b/c`; "rejects bad tile numbers" answers 400 without calling `fetchImpl`; "times out" (a `fetchImpl` that never settles and `timeoutMs` 50) answers 504; "caches" (two requests, one upstream call, the second with `X-Tile-Cache: hit`); "identifies itself" (the User-Agent of section 6.12); an upstream 500 answers 502.

**`frontend/tests/siteLaneState.test.ts (new)`** (AC3.7 to AC3.12, AC3.18, AC3.31), on fixture F1:

| Case | Events | Expected |
| --- | --- | --- |
| picking a building sets the primary and the default radius | `result_picked` (building), `area_loaded` | Primary `way/1001`, radius 150, centre its vertex mean, `phase` `ready`, one immediate area request before the load |
| a street pick waits for a footprint click | `result_picked` (street), `area_loaded`, `footprint_clicked` | `awaiting_primary`, then that building primary, centre moved, a new immediate area request |
| shrinking is local and drops outside buildings | Radius 300 loaded; `radius_changed` 120 | No area request; involved car park at 82 m kept; a building at 130 m dropped, a ghost with `source` `dropped`, a `notice` |
| expanding past the loaded radius fetches once | Loaded at 300 (fetched 400); 350, 380, then 450 | No request for 350 or 380; one non-immediate request for 450 |
| a radar ghost expands and joins | `site_replaced` with F1's site, `proposal_received` with the MRT at 207 m, then `ghost_expand` | Ghost with `expandTo` 220; then radius 220 and the MRT involved as `transit_station` |
| the sixth building is refused | Five involved; `footprint_clicked` on a sixth | `problem` holds the limit message; site unchanged |
| a drawn outline becomes the primary or asks | `outline_finished` with no primary; again with a primary; `outline_used` `involved` | Primary with `osm_id` null; then `pendingOutline`; then involved with kind `other` |
| a crossing outline is refused | `outline_finished` with a bow-tie and no primary | `problem` "The outline crosses itself. Draw it again."; no site |
| an outside hint stops the lane | `proposal_received` with `outside_coverage` and no site | `phase` `outside_coverage`; `areaRequestFor` returns null |
| an ambiguous proposal offers its candidates | `proposal_received` with `ambiguous` and two candidates | `query` is the place text; `offered` holds both; no search request |
| a stale area answer is ignored | Two picks; the first `area_loaded` arrives last | The second pick's area stays |
| the lane never applies the radar's site (AC3.31) | From no site: `proposal_received` with a resolved selection; then `reset_to_search` after `site_replaced` with that selection and `proposal_received` again; then from `initialSiteLaneState` with F1's site: `proposal_received` with another resolved selection | `site` stays null until `site_replaced`; after the reset `site` stays null; F1's site is kept and only ghosts are added |

**`frontend/tests/placeSearchState.test.ts (new)`** (AC3.4), with `node:test` mock timers: "below two characters nothing is sent"; "debounces to one request" (typing "m", "ma", "mar" within 250 ms sends one request for "mar"); "repeats come from the cache" (within five minutes, none after); "a stale response is dropped" (the answer to "ma" arriving after "mar" is ignored).

**`frontend/tests/siteMapStyle.test.ts (new)`**: `getRoadStrokeWeight` gives 10, 8, 8, 8, 8, 6, 6, 6, 6, 5, 5, 5, 4, 4 and 5 for `motorway`, `motorway_link`, `trunk`, `trunk_link`, `primary`, `primary_link`, `secondary`, `secondary_link`, `tertiary`, `tertiary_link`, `residential`, `unclassified`, `service`, `living_street` and an unknown type, the Scene Editor's table (`frontend/src/components/SceneEditor/SceneEditor.tsx:132-172`); `SITE_MAP_STYLE` equals the values of section 7.3.

### 11.2 Fixtures

- **F1, the neighbourhood.** A synthetic area around 1.2834, 103.8607, written as a `SiteArea` in `frontend/tests/fixtures/siteArea.json (new)`: "Marina Court Mall" (`way/1001`, six vertices) as the building at the centre; "Marina Court Car Park" (`way/1002`, class `car_park`) at 82 m; "Marina Court MRT Station" (`way/1003`, class `transit_station`) at 207 m; twelve other buildings between 20 m and 300 m, two of them unnamed; six streets, one of which leaves and re-enters a 150 m ring. The names are the mockup's, and invented.
- **F2, the legacy mapping.** Primary `way/1001` named "Marina Court Mall" with the square `[[1.2830, 103.8600], [1.2830, 103.8610], [1.2840, 103.8610], [1.2840, 103.8600]]`, `place_label` and address line "1 Marina Way, Singapore 018900". Expected: `location` "1 Marina Way, Singapore 018900", `venue_name` "Marina Court Mall", `geocode_override` `{ lat: 1.2835, lng: 103.8605, display_name: "Marina Court Mall" }`, `center_lat` 1.2835 and `center_lng` 103.8605, compared after rounding to seven decimals.
- **F3, the index rows.** About 40 `SearchCandidateRow` objects in `server/services/fieldOps/site/fixtures/searchRows.json (new)`: the F1 buildings and their address, "Marina Court Residences", "Marina Court Road", two "Block 12" buildings 5 km apart, "St. Andrew's Cathedral", five streets whose names contain "court", and rows that match nothing.

### 11.3 Manual acceptance

| Step | What to do | Pass when |
| --- | --- | --- |
| M1 | Apply 229 to 232 in order on the shared project, then apply each again | No error on either run; `SELECT public.fieldops_site_search_features()` reports whether the trigram index exists |
| M2 | On staging, search "Marina" or a known mall and pick a building | The ring, colours, labels, HUD, the line under the box and the head pill are as section 4.1 says |
| M3 | Shrink the radius to 80 m and grow it to 240 m with the network panel open | No request while shrinking or up to the fetched radius; one request beyond it |
| M4 | On the production build (front end and API on different origins), auto-trace a building, then draw one | Tiles load from the API origin; the trace returns an outline; no debug pop-up; no CORS or CORP error in the console; Enter, Esc and Backspace work while drawing |
| M5 | With WS2's radar on, drop a document that names the mall, a car park next door and a nearby station | The station shows as a ghost with the nudge; "Expand to" widens the ring and involves it |
| M6 | Use a document set in Kuala Lumpur; then search "Kuala Lumpur" | The outside-coverage panel; then "No matches in the saved map data" |
| M7 | In the SQL editor, run `EXPLAIN ANALYZE` on the candidates function five times each for `ma`, `mar`, `marina`, `orchard`, `018900`, `1 marina way`, `block 12`, `jurong`, `changi` and `tampines` | The 95th percentile of execution time is under 80 ms with the trigram index and under 150 ms without it (AC3.6) |
| M8 | Walk the lane by keyboard only, with NVDA running | Search, pick, radius, add a building from the list, change a role and remove a building all work and are announced (AC3.29) |
| M9 | With the flag off and the migrations applied, use the legacy wizard's Scene Editor: Fetch Buildings in local-cache mode at a fixed point, before and after the migrations | Same building and street counts; tiles still load; nothing else changed (AC3.30) |

## 12. Tasks

Tasks run in this order. T3.1 to T3.3 need nothing from other workstreams except WS1's vocabulary list; T3.6 onwards need WS0's helpers; T3.13 is seen on screen only inside WS2's page.

1. **T3.1 Shared contract and helpers.**
   - Goal: the types, constants and pure helpers of sections 5.2 and 5.3.
   - Files: new `shared/fieldOps/site.ts (new)`, `shared/fieldOps/sitePlaces.ts (new)`, `shared/fieldOps/siteGeometry.ts (new)`, `shared/fieldOps/siteSearchText.ts (new)`. Uses `shared/fieldOps/vocabulary.ts (new)` (WS1) for `InvolvedBuildingKind`.
   - Steps: write the modules exactly as specified; import only from `shared/` with `.js` suffixes; no enums, namespaces or parameter properties; `ringFingerprint` hashes with `BigInt` FNV-1a; `siteReadinessRules` implements WS2's `ReadinessRule` from `shared/fieldOps/readiness.ts (new)`; once WS2's registry exists, replace its site stand-in line in `shared/fieldOps/readinessRegistry.ts (new)` with the import from `./site.js`. WS1 already exports `INVOLVED_BUILDING_KINDS` (`02-teams-and-doctrines.md` section 5); if its file has not landed yet, wait for it rather than defining the list here.
   - Done when: the frontend type-check (`tsc` in `frontend/`) and the server type-check pass; the four test files pass.
   - Tests: `server/lib/fieldOps/site.test.ts (new)`, `server/lib/fieldOps/siteGeometry.test.ts (new)`, `server/lib/fieldOps/siteSearchText.test.ts (new)`, `server/lib/fieldOps/sitePlaces.test.ts (new)`.
   - Commit: commit 1.
2. **T3.2 Server schemas and parity.**
   - Goal: the zod schemas of section 6.2 and the parity with `validateSiteSelectionShape`.
   - Files: new `server/lib/fieldOps/siteSchemas.ts (new)`.
   - Steps: write the schemas; build the 30-item corpus; assert parity; replace the site stand-in import line in WS2's `server/lib/fieldOps/setupSchemas.ts (new)` with `siteSelectionSchema` once that file exists (WS2's request R8).
   - Done when: `server/lib/fieldOps/siteSchemas.test.ts (new)` passes, including parity.
   - Tests: that file.
   - Commit: commit 1.
3. **T3.3 The static guard.**
   - Goal: AC3.22.
   - Files: new `server/lib/fieldOps/siteNoLiveProviders.test.ts (new)`; touched `package.json` (the test list, with every test file of section 11 as it lands).
   - Steps: write the scanner as a function inside the test file; scan the paths of section 11.1; skip missing paths.
   - Done when: the test passes on the tree, and the planted-host case fails the scanner as expected.
   - Tests: that file.
   - Commit: commit 1.
4. **T3.4 Migrations 229 to 232.**
   - Goal: the schema of section 5.4.
   - Files: new `migrations/229_osm_sg_addresses_and_versions.sql (new)`, `migrations/230_osm_sg_search_index.sql (new)`, `migrations/231_fieldops_site_area.sql (new)`, `migrations/232_osm_sg_facilities.sql (new)`.
   - Steps: copy the SQL of section 5.4 verbatim; apply twice on a local Supabase stack to prove idempotence; hand the files to the owner, who applies them to the shared project outside a live session.
   - Done when: manual step M1 passes and M9 shows the legacy path unchanged.
   - Tests: manual M1 and M9.
   - Commit: commit 2.
5. **T3.5 The re-extract and import tools.**
   - Goal: the generator, importer and guard of section 6.11.
   - Files: new `server/lib/fieldOps/osmExtract.ts (new)`, `server/lib/fieldOps/osmImportGuard.ts (new)`; touched `scripts/generate_singapore_local_osm.mjs`, `scripts/import_singapore_local_osm.mjs`, `package.json` (`generate:sg-osm` and `import:sg-osm` become `node --import tsx scripts/...`).
   - Steps: move all tag and geometry logic into the pure modules; add the passes, flags and outputs; add the modes and the guard; keep the legacy `--roads` and `--buildings` flags working for an empty database.
   - Done when: on a small clipped test extract (made locally with `osmium extract`), `--stats` prints the counts of section 5.6 and a full run writes the five files; a dry-run import prints its plan and writes nothing; the guard refuses each case of AC3.24.
   - Tests: `server/lib/fieldOps/osmExtract.test.ts (new)`, `server/lib/fieldOps/osmImportGuard.test.ts (new)`.
   - Commit: commit 2.
6. **T3.6 Features, coverage and errors.**
   - Goal: sections 5.5 and 6.7.
   - Files: new `server/services/fieldOps/site/siteFeatures.ts (new)`, `server/services/fieldOps/site/siteCoverage.ts (new)`, `server/services/fieldOps/site/siteErrors.ts (new)`.
   - Steps: build the four detectors on WS0's `createCachedDetector`, `isMissingColumnError`, `isMissingRelationError` and `isMissingFunctionError`, with WS0's default 60-second re-check after a miss; the coverage cache.
   - Done when: with migration 229 missing, `getSiteCoverage` returns the fallback box and logs `fieldops_site_feature` once; with it applied, the active version's box. **Added 3 Nov 2026:** and its `data_version` carries the row's `region` (AC3.32).
   - Tests: covered through `siteArea.test.ts`, `siteHint.test.ts` and `facilities.test.ts`.
   - Commit: commit 3.
7. **T3.7 Search.**
   - Goal: section 6.4.
   - Files: new `server/services/fieldOps/site/siteRanking.ts (new)`, `server/services/fieldOps/site/siteSearch.ts (new)`, `server/services/fieldOps/site/fixtures/searchRows.json (new)`.
   - Steps: the ranking as a pure function; the service with the index path, the names-only fallback, the retry and the cache.
   - Done when: the ranking and search tests pass.
   - Tests: `server/services/fieldOps/site/siteRanking.test.ts (new)`, `server/services/fieldOps/site/siteSearch.test.ts (new)`.
   - Commit: commit 3.
8. **T3.8 Area, context, hints and facilities.**
   - Goal: sections 6.5, 6.6, 6.8 and 6.9.
   - Files: new `server/services/fieldOps/site/siteArea.ts (new)`, `server/services/fieldOps/site/siteContext.ts (new)`, `server/services/fieldOps/site/siteHint.ts (new)`, `server/services/fieldOps/site/facilities.ts (new)`.
   - Steps: `shapeSiteArea` pure with the caps; the function path and the paged fallback; the context reader; `decideHintResolution` pure; the facilities query.
   - Done when: the four test files pass.
   - Tests: `server/services/fieldOps/site/siteArea.test.ts (new)`, `server/services/fieldOps/site/siteHint.test.ts (new)`, `server/services/fieldOps/site/facilities.test.ts (new)`, plus the context through `site.test.ts`.
   - Commit: commit 3.
9. **T3.9 Router and mount.**
   - Goal: section 6.3.
   - Files: new `server/routes/fieldOpsSite.ts (new)`; touched `server/index.ts` (one import and one `app.use` after the `warroomRouter` mount, beside WS2's).
   - Steps: the factory with injectable dependencies; the middleware order with WS0's `requireFieldopsV2` on each route; the error mapping, with WS0's `validationErrorBody` for the normaliser's refusals; the cache headers; the per-user limiters.
   - Done when: the route test passes, and in development with the flag on, a trainer's token gets results from all four routes while the flag off gives 404.
   - Tests: `server/routes/fieldOpsSite.test.ts (new)`.
   - Commit: commit 3.
10. **T3.10 The tile proxy.**
    - Goal: section 6.12.
    - Files: touched `server/routes/tileProxy.ts`; new `server/routes/tileProxy.test.ts (new)`.
    - Steps: read the live tile policy first; add `parseTileParams`, the timeout, the cache, the User-Agent and the factory; keep `tileProxyRouter` exported.
    - Done when: the test passes and the legacy Scene Editor's map phase still loads tiles (M9).
    - Tests: that file.
    - Commit: commit 4.
11. **T3.11 Map style, layers, auto-trace and icon.**
    - Goal: section 7.2 and the icon of section 7.9.
    - Files: new `frontend/src/components/FieldOps/Site/siteMapStyle.ts (new)`, `frontend/src/components/FieldOps/Site/siteMapLayers.tsx (new)`, `frontend/src/components/FieldOps/Site/AutoTraceClickHandler.tsx (new)`; touched `frontend/src/components/SceneEditor/buildingAutoTrace.ts` (the optional `options` parameter) and `frontend/src/components/UI/WarRoomIcon.tsx` (`train` and `minus`).
    - Steps: copy and re-write as section 7.2 says; keep every `pathOptions` value.
    - Done when: the style test passes; the legacy Scene Editor still shows its debug pop-up (behaviour unchanged) and the new handler does not.
    - Tests: `frontend/tests/siteMapStyle.test.ts (new)`.
    - Commit: commit 5.
12. **T3.12 Lane state, search state and the API client.**
    - Goal: sections 7.4, 7.5 and 7.8.
    - Files: new `frontend/src/components/FieldOps/Site/siteLaneState.ts (new)`, `frontend/src/components/FieldOps/Site/placeSearchState.ts (new)`, `frontend/src/components/FieldOps/Site/siteApi.ts (new)`, `frontend/tests/fixtures/siteArea.json (new)`.
    - Steps: the reducer and selectors with no React import; the scheduler and cache; the four calls and `SiteApiError`.
    - Done when: both client test files pass.
    - Tests: `frontend/tests/siteLaneState.test.ts (new)`, `frontend/tests/placeSearchState.test.ts (new)`.
    - Commit: commit 5.
13. **T3.13 Components and stylesheet.**
    - Goal: sections 7.3, 7.5, 7.6, 7.7, 7.9 and 7.10.
    - Files: new `frontend/src/components/FieldOps/Site/SiteLane.tsx (new)`, `frontend/src/components/FieldOps/Site/PlaceSearch.tsx (new)`, `frontend/src/components/FieldOps/Site/RadiusControl.tsx (new)`, `frontend/src/components/FieldOps/Site/SiteMap.tsx (new)`, `frontend/src/components/FieldOps/Site/InvolvedBuildingsList.tsx (new)`, `frontend/src/components/FieldOps/Site/RadiusNudge.tsx (new)`, `frontend/src/design/fieldops-site.css (new)`.
    - Steps: build the components on the reducer, with the `SiteLaneProps` of section 7.7 (the same as WS2's mount point) and WS2's anchors, `data-field="fo:site:search"` on the search input (WS2's request R8), and WS2's `LaneShell` and `LaneHead` for the lane head; import the stylesheet from `SiteLane.tsx`; use `WrIcon` only, no emoji; replace the `SiteLane` stand-in import line in WS2's `frontend/src/components/FieldOps/Setup/laneStandIns.tsx (new)` (WS2's request R10).
    - Done when: `npm run build` in `frontend/` passes, and inside WS2's page in development (flag on) the lane passes manual steps M2, M3 and M8.
    - Tests: manual M2, M3, M4 and M8 (the logic is covered by T3.12).
    - Commit: commit 5.
14. **T3.14 Run the re-extract and import.**
    - Goal: the data of D6 on the shared project.
    - Files: none in the repository; the export and the new extract stay under the ignored `server/data/generated/<label>/`.
    - Steps: the runbook of section 6.11, steps 2 to 8, by the owner or with the owner present; the sweep (step 9) one release later.
    - Done when: the verification queries match the manifest; the address share and the facility counts are reported to the owner; M7 is recorded; the version is active and the data note shows its date.
    - Tests: the verification queries and manual M7.
    - Commit: none (an operation, after commits 2 and 3 are deployed).
15. **T3.15 Acceptance and the journey register.**
    - Goal: master section 11, items 1 and 9.
    - Files: touched `docs/field-ops-user-journey.html` (the finding register only).
    - Steps: run M1 to M9 on staging; mark findings 4.7 (partly: the proxy is hardened, not authenticated), 4.8, 4.16 and 4.17 as fixed for the new site picker, each with its commit.
    - Done when: every criterion of section 4.2 has passed, with its test named in the pull request.
    - Tests: section 11.3.
    - Commit: commit 6.

## 13. Commit plan and backtracking

Six commits. Each leaves `npm test`, the frontend build and the server type-check green, and each can be reverted on its own in reverse order.

| Commit | Message | Tasks | Verify before pushing | Backtracking step |
| --- | --- | --- | --- | --- |
| 1 | `fieldops(site): shared site contract, schemas and the no-live-data guard` | T3.1, T3.2, T3.3 | `npm test`; `tsc` in `frontend/`; `npx tsc --noEmit` for the server | Revert commit 1. Nothing imports these files until commit 3 and WS2's save route; if WS2 already imports them, revert WS2's import first or keep commit 1 |
| 2 | `fieldops(site): migrations 229 to 232 and the re-extract tools` | T3.4, T3.5 | `npm test`; the migrations applied twice locally; a dry-run import on the test extract | Revert commit 2 to restore the old scripts (their legacy flags still work). Applied migrations stay: they are additive and nothing in the legacy path reads them; drop them only with the rollback comments in each file, and only if no deployed code reads them |
| 3 | `fieldops(site): site search, area, validation, hints and routes` | T3.6, T3.7, T3.8, T3.9 | `npm test`; the four routes answer in development with the flag on and 404 with it off | Turn `ENABLE_FIELDOPS_V2` off first (an environment change and a restart, no build); then revert commit 3, which removes the mount. WS2's save route must stop calling `normaliseSiteSelection` first, or keep commit 3 and only turn the flag off |
| 4 | `fieldops(site): harden the tile proxy` | T3.10 | `npm test`; the legacy Scene Editor's map phase loads tiles and auto-traces | Revert commit 4 alone: the proxy returns to today's behaviour; nothing else depends on it |
| 5 | `fieldops(site): the site lane` | T3.11, T3.12, T3.13 | `npm test`; `npm run build` in `frontend/`; manual M2, M3, M4 and M8 inside WS2's page | Revert commit 5; WS2's page loses lane 2, so put WS2's stand-in import back first. The optional auto-trace parameter and the two glyphs are additive; keep a glyph if another lane uses it |
| 6 | `docs(journey): mark the site-picker findings fixed` | T3.15 | The checker and the HTML build for the set | Revert commit 6 if any criterion later fails |

T3.14 is an operation, not a commit. Its backtracking step is the rollback of section 6.11: mark the version failed, or import the step 2 export as a new version, activate it and sweep.

## 14. File map

**New files created by WS3**

| File | Purpose |
| --- | --- |
| `shared/fieldOps/site.ts (new)` | The contract, limits and pure helpers (section 5.2) |
| `shared/fieldOps/sitePlaces.ts (new)` | Place classes, labels, icons, facility kinds (section 5.3) |
| `shared/fieldOps/siteGeometry.ts (new)` | Geometry helpers (section 5.3) |
| `shared/fieldOps/siteSearchText.ts (new)` | The search-text normaliser (section 5.3) |
| `server/lib/fieldOps/siteSchemas.ts (new)` | zod schemas (section 6.2) |
| `server/lib/fieldOps/osmExtract.ts (new)` | Pure extract helpers for the generator (section 6.11) |
| `server/lib/fieldOps/osmImportGuard.ts (new)` | The importer's guard (section 6.11) |
| `server/services/fieldOps/site/siteFeatures.ts (new)` | Migration detection (section 5.5) |
| `server/services/fieldOps/site/siteCoverage.ts (new)` | Coverage and the data version (section 6.7) |
| `server/services/fieldOps/site/siteErrors.ts (new)` | `SiteDataUnavailableError` |
| `server/services/fieldOps/site/siteRanking.ts (new)` | Ranking (section 6.4) |
| `server/services/fieldOps/site/siteSearch.ts (new)` | Search (section 6.4) |
| `server/services/fieldOps/site/siteArea.ts (new)` | `loadSiteArea` (section 6.5) |
| `server/services/fieldOps/site/siteContext.ts (new)` | `buildSiteSelectionContext` (section 6.6) |
| `server/services/fieldOps/site/siteHint.ts (new)` | `resolveSiteHint` (section 6.8) |
| `server/services/fieldOps/site/facilities.ts (new)` | `listFacilitiesNear` (section 6.9) |
| `server/services/fieldOps/site/fixtures/searchRows.json (new)` | Fixture F3 |
| `server/routes/fieldOpsSite.ts (new)` | The router (section 6.3) |
| `migrations/229_osm_sg_addresses_and_versions.sql (new)` | Section 5.4 |
| `migrations/230_osm_sg_search_index.sql (new)` | Section 5.4 |
| `migrations/231_fieldops_site_area.sql (new)` | Section 5.4 |
| `migrations/232_osm_sg_facilities.sql (new)` | Section 5.4 |
| `frontend/src/components/FieldOps/Site/SiteLane.tsx (new)` | `SiteLane` |
| `frontend/src/components/FieldOps/Site/PlaceSearch.tsx (new)` | `PlaceSearch` |
| `frontend/src/components/FieldOps/Site/RadiusControl.tsx (new)` | `RadiusControl` |
| `frontend/src/components/FieldOps/Site/SiteMap.tsx (new)` | `SiteMap` |
| `frontend/src/components/FieldOps/Site/InvolvedBuildingsList.tsx (new)` | `InvolvedBuildingsList` |
| `frontend/src/components/FieldOps/Site/RadiusNudge.tsx (new)` | `RadiusNudge` |
| `frontend/src/components/FieldOps/Site/siteMapStyle.ts (new)` | Style constants and road weights |
| `frontend/src/components/FieldOps/Site/siteMapLayers.tsx (new)` | Extracted layers, used by WS4 too |
| `frontend/src/components/FieldOps/Site/AutoTraceClickHandler.tsx (new)` | Extracted trace handler |
| `frontend/src/components/FieldOps/Site/siteLaneState.ts (new)` | The reducer and selectors |
| `frontend/src/components/FieldOps/Site/placeSearchState.ts (new)` | Dropdown scheduling and cache |
| `frontend/src/components/FieldOps/Site/siteApi.ts (new)` | The client calls |
| `frontend/src/design/fieldops-site.css (new)` | The `fo-site-*` classes |
| Tests: `server/lib/fieldOps/site.test.ts (new)`, `server/lib/fieldOps/siteGeometry.test.ts (new)`, `server/lib/fieldOps/siteSearchText.test.ts (new)`, `server/lib/fieldOps/sitePlaces.test.ts (new)`, `server/lib/fieldOps/siteSchemas.test.ts (new)`, `server/lib/fieldOps/osmExtract.test.ts (new)`, `server/lib/fieldOps/osmImportGuard.test.ts (new)`, `server/lib/fieldOps/siteNoLiveProviders.test.ts (new)` | Section 11.1 |
| Tests: `server/services/fieldOps/site/siteRanking.test.ts (new)`, `server/services/fieldOps/site/siteSearch.test.ts (new)`, `server/services/fieldOps/site/siteArea.test.ts (new)`, `server/services/fieldOps/site/siteHint.test.ts (new)`, `server/services/fieldOps/site/facilities.test.ts (new)`, `server/routes/fieldOpsSite.test.ts (new)`, `server/routes/tileProxy.test.ts (new)` | Section 11.1 |
| Tests: `frontend/tests/siteLaneState.test.ts (new)`, `frontend/tests/placeSearchState.test.ts (new)`, `frontend/tests/siteMapStyle.test.ts (new)`, `frontend/tests/fixtures/siteArea.json (new)` | Section 11.1 and fixture F1 |

**Existing files WS3 touches**

| File | Change |
| --- | --- |
| `server/index.ts` | One import and one `app.use('/api/warroom/field-ops/site', fieldOpsSiteRouter)` after the `warroomRouter` mount, beside WS2's routers |
| `server/routes/tileProxy.ts` | Hardening and the factory (section 6.12) |
| `scripts/generate_singapore_local_osm.mjs` | Addresses, place classes, facilities, the index rows, the manifest (section 6.11) |
| `scripts/import_singapore_local_osm.mjs` | Versions, modes and the guard (section 6.11) |
| `package.json` | The `generate:sg-osm` and `import:sg-osm` scripts run through `tsx`; every new test file joins the `test` list |
| `frontend/src/components/SceneEditor/buildingAutoTrace.ts` | The optional `options` parameter (P10) |
| `frontend/src/components/UI/WarRoomIcon.tsx` | The `train` and `minus` glyphs |
| `docs/field-ops-user-journey.html` | The finding register (T3.15) |

**Files other specs create or change that WS3 uses** (master 10.8 item 29: each is listed with its owner, and `(new)` means the owner creates it)

| File | Owner | Use |
| --- | --- | --- |
| `shared/fieldOps/vocabulary.ts (new)` | WS1 | `InvolvedBuildingKind` and `INVOLVED_BUILDING_KINDS` (`02-teams-and-doctrines.md` section 5.1) |
| `shared/fieldOps/readiness.ts (new)` | WS2 | The `ReadinessRule` type that `siteReadinessRules` implements |
| `shared/fieldOps/readinessRegistry.ts (new)` | WS2 | Touched by WS3: the one site stand-in import line becomes `siteReadinessRules` |
| `server/lib/fieldOps/setupSchemas.ts (new)` | WS2 | Touched by WS3: the site stand-in import line becomes `siteSelectionSchema` from `./siteSchemas.js` |
| `frontend/src/components/FieldOps/Setup/laneStandIns.tsx (new)` | WS2 | Touched by WS3: the `SiteLane` stand-in import line |
| `frontend/src/pages/FieldOpsWizard.tsx (new)` | WS2 | The page that hosts lane 2; WS3's static test scans it (AC3.22) |
| `frontend/src/components/FieldOps/Setup/SetupStep.tsx (new)` | WS2 | Renders `SiteLane` with the props of section 7.7 |
| `frontend/src/components/WarRoom/lanes/LaneShell.tsx (new)` | WS2 | `LaneShell` and `LaneHead` for the lane head |
| `frontend/src/components/WarRoom/lanes/LaneIssues.tsx (new)` | WS2 | The `LaneIssue` type behind `issueAt` |
| `server/routes/fieldOpsSetup.ts (new)` | WS2 | The draft save route calls `normaliseSiteSelection` with `buildSiteSelectionContext` |
| `server/services/fieldOps/radar/radarJob.ts (new)` | WS2 | The radar job's guard stage calls `resolveSiteHint` |
| `server/lib/schemaFeatures.ts (new)` | WS0 | The detectors behind `siteFeatures` |
| `server/lib/fieldOps/requireFieldopsFlag.ts (new)` | WS0 | `requireFieldopsV2` on every site route |
| `server/env.ts` (the `enableFieldopsV2` property) | WS0 | The flag |
| `server/lib/validation.ts` (`VALIDATION_FAILED`, `validationErrorBody`) | WS0 | The 400 bodies |

**Not touched**: `frontend/src/components/SceneEditor/SceneEditor.tsx`, `frontend/src/components/SceneEditor/BuildingDrawHandler.tsx`, `frontend/src/components/WarRoom/SceneSetup.tsx`, `frontend/src/pages/WarRoom.tsx`, `frontend/src/lib/api.ts`, `frontend/src/design/warroom.css`, `frontend/src/main.tsx`, `server/routes/warroom.ts`, `server/routes/debug.ts`, `server/services/osmVicinityService.ts` and `server/env.ts` (WS0 adds the flag there).

## 15. Risks and open questions

### 15.1 Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Few buildings gain an address (master risk 1) | Names and streets work either way; the share is measured and reported (section 5.6, T3.14); D6 stands |
| 2 | `pg_trgm` cannot be created on the shared project | The migration still succeeds; substring search scans the narrow table; M7 measures both cases |
| 3 | The densest areas exceed the area caps | Nearest first, `truncated` in the response and the log; the cap is revisited from the logs (Q4) |
| 4 | An import writes to the live shared database by mistake | The guard of section 6.11, the export before every import, mark and sweep instead of truncate |
| 5 | A re-import moves or removes buildings already laid out | The selection keeps its polygons; vanished ids become custom polygons (P4); WS4 compares fingerprints |
| 6 | The tile service blocks the server's address (journey finding 4.7) | The hardened proxy with a cache and an identifying agent; a provider decision before wide launch (Q5) |
| 7 | A later edit drops `crossOrigin="anonymous"` from the tile layer, and helmet's same-origin resource policy then blocks tiles in production | Stated in sections 6.12 and 7.3; manual step M4 checks it |
| 8 | Someone enforces the report-only CSP without the API origin | Section 9; Q8 |
| 9 | A document names a foreign city but no country, so the radar's place reads "not found" rather than "outside coverage" | WS2's guard rail passes the country whenever the document states one (`03-setup-screen.md` section 8.5, rule 11); otherwise the trainer still sees no site and the reason |
| 10 | A change to `normaliseSearchText` silently splits stored and query text | Any change bumps `generator_version` and needs a re-import; the normaliser's tests pin examples |
| 11 | A later clean-up of the legacy Scene Editor deletes `BuildingDrawHandler.tsx` or `buildingAutoTrace.ts`, which the picker imports | The request to WS4 below; the files move with the picker instead |
| 12 | The legacy `SINGAPORE_BOUNDS` (lat up to 1.5) is narrower than the data (1.508) | Legacy only; the new code uses the measured coverage (P8) |
| 13 | The draw handler's window-level keys catch typing elsewhere on Setup | Draw and trace modes end when focus leaves the map box (section 7.6) |

### 15.2 Open questions

1. **Outside Singapore (D13).** Confirm that the picker stops with no live fallback. If another region will ever be imported, decide the region model of section 6.11 and whether the tables keep their `osm_sg_` names.
2. **The extract.** Which provider supplies the PBF, and how often is it refreshed (quarterly would keep the addresses current)?
3. **`pg_trgm`.** Answered by the live check of 25 Oct 2026: version 1.6 is available, and migration 230 creates it in the `extensions` schema (section 2). The owner only confirms that the role applying migrations may create extensions.
4. **Area caps.** Is 1,500 buildings enough for the densest 600 m circle? This query, read-only, gives the densest cells of about 1.1 km, roughly the area of such a circle:

```sql
SELECT round(center_lat::numeric, 2) AS lat_cell,
       round(center_lng::numeric, 2) AS lng_cell,
       count(*) AS buildings
  FROM public.osm_sg_buildings
 GROUP BY 1, 2
 ORDER BY 3 DESC
 LIMIT 5;
```

5. **Tiles.** Keep the OpenStreetMap Foundation tiles through the proxy, or move to a commercial or self-hosted tile service before wide launch? Should the relay be closed with signed tile URLs?
6. **Facility kinds.** D18 names hospitals, police and fire stations within 5 km and nearby hazards. Are fuel stations, power substations and surveillance cameras wanted in the dossier, or should the extract drop them?
7. **The sweep.** Run it one release after activation (proposed) or straight away?
8. **CSP.** Who updates `frontend/vercel.json` when the policy is enforced, so that it lists the API origin and drops Nominatim?
9. **Database version.** Answered by the live check of 25 Oct 2026: PostgreSQL 17.6, so the stored generated column of migration 230 is supported.

### 15.3 Differences from the mockup, for the UI sheet (D28)

1. The data note is master 10.8 item 10's wording; the mockup's second sentence ("Nothing is fetched live.") is dropped.
2. Ghosts follow the mockup: only buildings the radar proposed, or that the trainer had involved before shrinking, are drawn beyond the radius, and they are not clickable (P5).
3. A shrink drops involved buildings outside the new radius, as the mockup does, with the announcement "{name} is now outside the radius and no longer involved." and the dropped building kept as a ghost (P6). This settles the open point in the UI sheet's section 8.4.
4. The primary follows the mockup's cyan fill, not the edit phase's navy; involved buildings use the mockup's amber at 0.55 opacity so the tiles stay readable.
5. Accessibility additions: the "Add a building inside the radius" list, a remove button per involved row, one polite live region, and a thicker outline on hover.
6. New glyphs `train` and `minus`; the attribution reads `&copy; OpenStreetMap contributors`.
7. States the mockup does not draw: the outside-coverage and unavailable panels, the draw and trace strip, the "primary or involved" choice after an outline, and "Loading the saved map data" in the HUD.

### 15.4 Requests made of WS3

| From | Request | Answer | Where |
| --- | --- | --- | --- |
| WS1, `02-teams-and-doctrines.md` | List `shared/fieldOps/vocabulary.ts (new)` among the files WS3 uses, not the files it creates; WS1 adopts WS3's `train` rule (whoever lands first adds the glyph) | Accepted, and settled by master 10.8 item 29: section 14 lists the file under other specs' files, with owner WS1 and its `(new)` marker | Section 14; task T3.1 |
| WS2, `03-setup-screen.md` (R8) | Keep `siteReadiness(site)` pure in `shared/fieldOps/site.ts (new)`, with WS2's `site.missing` and `site.ok` taking their copy from it | Modified: WS3 has no `siteReadiness`. `site.ok` takes its text from `describeSite(site).readiness`; `site.missing` keeps WS2's own text; both turn on whether `setup.site` is null, as WS2's section 7.9 now reads; WS3's three notes are `siteReadinessRules`. All are pure, in `shared/fieldOps/site.ts (new)` | Sections 5.2 and 6.10 |
| WS2 (R8) | Keep `siteSelectionSchema` in `server/lib/fieldOps/siteSchemas.ts (new)` for the stand-in swap | Accepted | Section 6.2; task T3.2 |
| WS2 (R8) | Put `data-field="fo:site:search"` on the search input | Accepted | Sections 7.5 and 7.7; task T3.13 |
| WS2 (R9) | Keep `includeBuilding`, `removeInvolved` and `expandTargetFor` pure and exported; the radar's site chips call them on `setup.site` | Accepted; `toggleInvolved` wraps the first two for a chip switched on and off | Sections 5.2, 6.8 and 6.10 |
| WS2 (R10) | List WS2's page `FieldOpsWizard.tsx` without the `(new)` marker | Settled by master 10.8 item 29, which keeps the marker and names the owner: section 14 lists the page as WS2's | Section 14 |
| WS2 (R10) | Confirm that `SiteLane` applies `hints` only while `value` is null | Modified: the lane never applies the radar's site. WS2's `applyRadarResult` applies `built.site.selection` only to a draft with no site, once per adopted run, as WS2's sections 5.4 and 7.5 now say, so a site that is set, or that the trainer cleared, is never overwritten. The props are `site` and `proposal`, as in WS2's section 7.7, not `value` and `hints` | Sections 7.4 and 7.7; AC3.31 |
| WS4, `05-layout-step.md` (R4.1) | `loadSiteArea(site)` returns at least `SiteAreaForLayout` (buildings with `osm_id`, `name`, `polygon`; roads with `osm_id`, `name`, highway type and `[lat, lng]` coordinates) and a distinct `NO_SAVED_DATA` outcome, with a client wrapper | Modified: `loadSiteArea` takes any object with `centre` and `radius_m`, so `loadSiteArea(site)` works. Buildings carry `osm_id`, `name` and `polygon`; each road carries `osm_id`, `name`, `highway` and `segments` of `[lat, lng]` points, which WS4's `toSiteAreaForLayout` flattens to one road per segment. The distinct outcome is a state, not a code: `coverage` `outside_bbox` or `no_data_nearby` with empty lists, while a failure throws `SiteDataUnavailableError`. The client wrapper is `loadArea(centre, radiusM)` in `siteApi.ts`. WS4's section 6.4 already follows this | Section 6.5 |
| WS4 (R4.1) | `siteFingerprint` covers the centre, radius, primary polygon and the involved list with labels and kinds; `ringFingerprint` stays stable | Accepted: `siteFingerprint` now includes the involved labels and still leaves out the place label, the primary's name, the address and the data version; `ringFingerprint` keeps its algorithm under the `r1_` prefix | Section 5.2; AC3.16 |
| WS5, `06-compile-and-review.md` | Confirm the `FACILITY_KINDS` names for hospitals, police, fire stations and the hazard-relevant kinds, and that `listFacilitiesNear` never makes a network call | Accepted: `hospital`, `police` and `fire_station`, with `clinic` and `ambulance_station` kept apart; hazard-relevant `fuel_station` and `power_substation`; `surveillance_camera` for sensitive infrastructure. `listFacilitiesNear` calls no map service, only one query on `osm_sg_facilities`, and the static test of AC3.22 scans its file | Sections 5.3 and 6.9 |
| UI sheet, `10-ui-spec-sheet.md` | Own `RadiusNudge` and the glyphs `train` and `minus`; use `#166534` for the lane count | Accepted | Sections 7.7, 7.9 and 14 |
| WS2 | The name `siteReadiness`, attributed to WS3 | Modified: not a WS3 name. The right names are `siteReadinessRules` (WS3's notes) and `describeSite(site).readiness` (the `site.ok` text) | Section 5.2 |
| WS2 | The names `site_set` and `site_missing`, attributed to WS3 | Modified: not WS3 names. The right names are WS2's own readiness ids `site.ok` and `site.missing`, which WS2's section 7.9 already uses | Not in WS3 |
| WS2 | The name `outside_radius`, attributed to WS3 | Declined as a WS3 name: it is WS2's own `ProposalNote` and right as WS2 uses it. The WS3 facts behind it are `SiteInvolvedResolution.inside_radius` (false) and `expand_to` | Section 5.2 |
| WS4 | The names `crowd_headcount`, `involved_layouts`, `site_fingerprint`, `SITE_CHANGED` and `diffSiteForScene`, attributed to WS3 | Declined as WS3 names: they are WS4's own columns, error code and function, right as WS4 defines them. WS3 supplies only the value stored in `site_fingerprint`, which is `siteFingerprint(setup.site)` | Section 5.2 |
| WS4 | The name `people_present`, attributed to WS3 | Declined as a WS3 name: it is WS2's `incident.people_present` | Not in WS3 |
| WS9, `11-living-world.md` section 15.3 | **Added 3 Nov 2026.** Keep the facility kinds `fire_station`, `ambulance_station`, `police` and `hospital` stable, with `listFacilitiesNear` returning each facility's kind, name and position; keep the active data version's label readable for the road graph's cache key | Accepted, as already specified: the four are in `FACILITY_KINDS`, `FacilityRef` carries `kind`, `name`, `lat` and `lng`, and `FacilitiesNearResult` returns `data_version` with its `label`. A change to any of them is a change to WS9's unit origins too | Sections 5.2, 5.3 and 6.9 |
| WS1, `02-teams-and-doctrines.md` section 15.3 | **Added 3 Nov 2026.** Report the active data version's `region` with `SiteDataVersion` (or in `SiteSelectionContext`), so `defaultAgencyCountry` reads the saved data's country instead of assuming `SAVED_MAP_DATA_COUNTRY` | Accepted, on `SiteDataVersion`, so the coverage answer and `SiteSelectionContext` both carry it | Sections 5.2 and 6.7; AC3.32; T3.6 |

### 15.5 Requests WS3 makes of other specs

| To | Request | Why |
| --- | --- | --- |
| WS4, `05-layout-step.md` | Leave `frontend/src/components/SceneEditor/BuildingDrawHandler.tsx` and `frontend/src/components/SceneEditor/buildingAutoTrace.ts` in place when the edit phase is extracted, and list them as not touched; if a later clean-up retires the legacy map phase, they move with the picker | The picker imports both (section 7.6; risk 11) |
| UI sheet, `10-ui-spec-sheet.md` | Add copy keys for the section 7.7 strings the deck still lacks: the dropdown's loading, empty, error and names-only rows, the unavailable panel, the draw and trace strip, and "Loading the saved map data" in the HUD | One copy deck (D28) |

## 16. Definition of done

WS3 is done when all of these hold, together with master section 11:

1. AC3.1 to AC3.31 pass, each with the test or manual step named beside it. **Added 3 Nov 2026:** AC3.32 too.
2. Every test file of section 11.1 is in the `test` list of `package.json` and `npm test` passes; `npx tsc --noEmit` is clean for the server, and `npm run build` in `frontend/` is clean with the new `shared/fieldOps/` files type-checked.
3. `node scripts/verify-field-ops-specs.mjs` passes for this spec, and the migrations apply twice without error on a scratch database (a Supabase branch or a local Postgres, never the shared project).
4. With `ENABLE_FIELDOPS_V2` and `VITE_ENABLE_FIELDOPS_V2` off, the site routes answer 404, `/warroom/field-ops` is absent, and the legacy wizard's Scene Editor behaves exactly as before (M9).
5. Migrations 229 to 232 are applied on the shared project, re-running them changes nothing (M1), and the code was shown to work without them (`names_only`, `table_scan`, `unavailable`).
6. A re-extract has been imported through the guard, its version is active, the data note shows its date, and the address share and facility counts have been reported to the owner (T3.14).
7. The static guard passes: no Overpass, Nominatim or Google call and no direct tile host in WS3's files or the new client tree.
8. No search text, place label, address or polygon appears in any log line during the staging run, and no new secret was added.
9. Section 9's items are closed: RLS on the new tables, function grants revoked from browser roles, per-user limits, response caps, the hardened tile proxy.
10. `frontend/src/components/SceneEditor/SceneEditor.tsx` is unchanged, and the file map of section 14 matches what was actually touched.
11. Journey findings 4.7 (in part), 4.8, 4.16 and 4.17 are marked fixed for the new site picker in the journey's register, with the commits (T3.15).
12. Every request of section 15.5 is answered by its owner or recorded as open in the master plan's change log.
