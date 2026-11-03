# The living world (WS9)

**Status:** v1, 3 Nov 2026 (added 3 Nov 2026). Not built.
**Workstream:** WS9
**Depends on:** [the master plan](00-master-plan.md); [01](01-prerequisites.md), [04](04-site-picker.md), [05](05-layout-step.md), [06](06-compile-and-review.md), [07](07-device-and-physics.md) and [08](08-people-or-ai.md); softly [09](09-after-publish.md)
**Flags:** `ENABLE_FIELDOPS_WORLD_SIM`
**Migrations:** 249 to 256
**Baseline:** verified against commit 588387f (3 Nov 2026); see the README.

## 1. Purpose, goals and non-goals

**Purpose.** WS9 turns a compiled field-ops scenario into a live world that runs on the server during a session, as in a real-time strategy game (D32). Every detail the trainer gave builds the starting state (D36): the site with its buildings and roads (WS3), the primary building's walls and their materials, its stairwells, exits and inspection points, the crowd zones (WS4), the hazards, the devices with their calculated effects (WS6), and the weather and the time of day (WS2). During the session a deterministic simulation evolves that state. Fire and smoke spread through the building by material and wall and are pushed by the wind; structural damage starts from the blast and worsens with fire exposure and time; gas and smoke plumes drift outdoors; the crowd moves through exits and stairs and avoids smoke; people who stay exposed are hurt. Teams dispatch units that travel over the saved roads (D33). Each team sees only what its units and posts can observe, plus what other teams report to it (D34). Weather and traffic change spread, visibility and travel times (D35). The simulation is code over stored data and calls no model (D31). It ships in five slices behind `ENABLE_FIELDOPS_WORLD_SIM`, each falling back to today's scripted escalation (master section 6, build-order item 7; master risk 22). The first slice, the stored spread library and the compile-time fire-spread timeline, lands with WS5 (master 10.8 items 35 and 38).

This spec is new as a whole on 3 Nov 2026, so its text carries no "Added" markers.

**Goals**

1. **G9.1 The spread library (slice 1; D31; master 10.8 item 38).** Stored, reviewed parameters for materials (how each ignites, how fast fire spreads over it, how long it burns, its smoke yield, how long a wall of it resists burn-through, how long a structure of it resists fire), for hazard behaviour, for exposure and for weather. They live in migration 249, come from seed files that carry a source note per row, and pass a review gate like WS6's (D22). `loadSpreadLibrary`, `hazardEventsFor` and `deteriorationFactsFor` serve WS5.
2. **G9.2 Fire spread kept at compile (slice 1; master 10.8 item 35).** `buildSpreadTimeline` runs today's `runEnvironmentalSimulation` with the stored parameters in a worker thread, under a time limit and a size limit, so WS5's pins stage keeps today's fire-spread pins without the research step and without blocking the server (journey finding 4.14).
3. **G9.3 One starting world (slice 2; D36).** A `WorldModel` built once per scenario revision by a job kind of WS9's own (master 10.8 item 39) from WS5's snapshots, WS4's scene, WS6's effects, WS3's roads and facilities, and WS8's setup copy.
4. **G9.4 A live simulation (slice 2; D32).** Fire, smoke, gas, structure, plumes, crowd flows and casualty exposure, stepped once a second, deterministic and replayable, reacting to suppression, ventilation, cordons, exit control, shoring, rescue and evacuation.
5. **G9.5 A runtime that cannot stall the server (slice 2; master risk 19).** Worker threads with tick and size budgets, a per-session lease, an append-only event log, snapshots, recovery after a restart, back-pressure, and a fallback to today's scripted escalation.
6. **G9.6 Units (slice 3; D33).** A unit catalogue per archetype; origins at WS3's facilities or at staging points the trainer sets; dispatch and routing over a road graph built once from the saved roads and cached; travel times by road type; arrival as placed assets that today's checks understand; tasks taken from WS1's capabilities. AI agencies dispatch through the same routes as people.
7. **G9.7 Fog of war (slice 4; D34).** Observation by unit and post range, cut by smoke, walls, weather and darkness; last-known markers; shared reports; every payload filtered on the server on top of WS0's participant projections, today's hazard and casualty routes and broadcasts included; the trainer's full view; AI agencies through the same fog.
8. **G9.8 Weather and traffic (slice 5; D35).** `WeatherSetting` and its effects table; Singapore presets; stored traffic profiles by road group, day type and hour; cordons, closures and evacuation jams; Setup's weather label and incident time feeding both.
9. **G9.9 The trainer during play.** A world console to change the weather, close a road, start a secondary fire and pause or resume the world; a lobby card for the world settings; a spectator view.
10. **G9.10 The client.** Map layers on `MapView` for fire and smoke, structure states, plumes, crowds, units with their paths and arrival times, fog and last-known markers, and weather and traffic; a units panel for players; a replay panel in the After-Action Review.

**Non-goals**

- Computational fire models (field or zone models of the CFAST kind), per-person crowd agents, and any vertical model beyond the trainer's one plan replicated on at most four floors linked by her stairwells (section 15.2, question 11).
- Explosions of stored materials (version 1 gives hazards no `explode` event), secondary devices planned by the world, and any blast physics: blast, structural and thermal radii come only from WS6, which "stays the owner of the blast calculator" (master 10.8 item 38).
- Live data of any kind (D5): no traffic or weather feed, no Overpass, no Google.
- CCTV, drones and sensors as observers (section 15.2, question 13).
- More than one server instance. Version 1 runs every world in the one Render instance that serves the sockets (master section 12); a Socket.IO adapter for several instances is later work (risk R9.6).
- Changing the world's speed during a session, apart from the bounded catch-up after a restart or a late start (section 6.11).
- Ambulances that carry patients over the roads on their own initiative. Version 1 moves a patient over the road network only when a team's transport decision and one of its ambulance units coincide (section 6.8); today's transport decisions keep working otherwise.
- Rewriting today's engines. WS9 adds narrow gates to four services and changes nothing else in them (section 6.12).
- The corporate wizard, the legacy field-ops wizard and social-media sessions, which keep today's behaviour.
- Doctrine coverage by country, Design 7's sixteenth question, which is WS1's (section 15.2 records a default).

## 2. Decisions and assumptions

### 2.1 Master decisions this spec implements

| ID | Status in the master | What it means here |
| --- | --- | --- |
| D5 | Decided | No live data. Roads come from `osm_sg_roads`, origins from WS3's `osm_sg_facilities`; traffic is a stored profile and weather a trainer setting. No code in `server/services/fieldOps/world/` makes a network call other than to the database (AC9.54). |
| D8 | Decided | Device effects come from WS6's deterministic calculator through WS5's physics snapshot. WS9 reads radii and never computes a blast effect. |
| D9 | Decided | Each involved building is one compartment at footprint level, with WS4's generated exits. Only the primary building gets a cell grid. |
| D10 | Decided | The crowd is the setup headcount, placed by WS4's crowd zones and `allocateCrowd`; the world moves it. |
| D13 | Assumed | A site outside the saved data cannot be chosen, so a world always has saved roads around it. An origin outside the road box enters at the box edge (section 6.8.3). |
| D22 | Assumed | When WS6's physics snapshot is unreviewed, the world's initial damage carries "Unreviewed model" too. The spread library has its own review record, modelled on WS6's (W24). |
| D23 | Assumed | Migrations 249 to 255 are additive and idempotent, and every reader works before they are applied (section 5.13). Number 256 stays unused in version 1. |
| D28 | Assumed | The mockup draws no WS9 surface, so WS9 follows the UI sheet's conventions: `fo-` classes in its own stylesheet, `WrIcon` glyphs and no emoji. |
| D31 | Decided | All spread and deterioration physics is stored data, seeded and reviewed during development. The simulation, the compile-time timeline and the facts block call no model. |
| D32 | Decided | Slice 2: the live simulation of fire, smoke, structure, gas and smoke plumes and crowds, reacting to the teams. |
| D33 | Decided | Slice 3: units with a type, capabilities, a position and a status, dispatched over the saved roads. |
| D34 | Decided | Slice 4: fog of war for people and AI agencies alike; the trainer sees everything. |
| D35 | Decided | Slice 5: weather and traffic change spread, plumes, visibility, travel speed and casualties. |
| D36 | Decided | Section 6.6 maps each detail the trainer gives to the part of the world it builds; AC9.14 proves none is dropped. |

Settled interface decisions this spec owns or consumes (master 10.8): item 5 (WS0's detectors for every table and function of 249 to 255); items 12 and 28 (fog filtering runs after WS0's participant projections and never widens them); item 16 (device positions and effects live only in WS9's tables, with row level security on and no policy, never in a `scenarios` column); item 17 (WS9 asks no model anything); item 21 (every foreign key to `scenarios` cascades); item 26 (WS9 does not touch the start branch of `PATCH /api/sessions/:id`; it reads the revision WS8's start claim pinned); item 31 (one refusal for a role, the bare 404 for a flag, WS0's client error class); item 32 (the prepare job's stages use WS0's stage context names); items 35 and 38 (the spread library and the compile-time timeline); item 39 (the live world's seams).

### 2.2 WS9 design decisions (Proposed)

| # | Decision | Why |
| --- | --- | --- |
| W1 | `loadSpreadLibrary()` answers null while migration 249 is missing and also while its tables hold no complete library. There is no seed-file fallback at run time; the seed files reach the tables through an admin route. | Master 10.8 item 38 fixes the null; a fallback would let an unseeded, unreviewed set of numbers drive compile without anyone noticing. |
| W2 | `buildSpreadTimeline` passes the stored parameters to `runEnvironmentalSimulation` through one new optional argument and a time scale of 1. Without the argument the function is exactly today's. | Item 38 says "runs today's `runEnvironmentalSimulation`"; the function hard-codes its wall and hazard tables (section 3.2), so the stored physics must reach it somehow, and legacy callers must not change. |
| W3 | The live world uses a new steppable engine in `server/services/fieldOps/world/engine/ (new)`, not today's batch function. | Today's function runs the whole session in one call, builds neighbours in O(N²), lets fire spread only inside hazard radii and cannot take an intervention (section 3.2). |
| W4 | Inside the primary building the world is a grid of 3 m cells, the runtime stud spacing, clipped to the outline with no exterior padding; 4 m and then 5 m cells when the building would need more than 20,000. | Journey chapter 13: the runtime grid is 3 m and the compile grid 5 m; today's grids pad 150 m of outdoor studs around the polygon (section 3.2), which is what makes them large. |
| W5 | The trainer draws one plan. The world replicates it on at most four floors (from -1 to 2) that her stairwells or devices name, with exits on floor 0 only. Crowd zones stand on floor 0; the unassigned remainder is spread evenly over the modelled floors. | WS4's walls, hazards and crowd zones carry no floor (`05-layout-step.md` section 5.4); stairwells name the floors they link. |
| W6 | Each involved building is one compartment with an involvement fraction, smoke, a structural state, its occupants and WS4's generated exits. | D9. |
| W7 | Outdoors there is no grid: each smoke or gas source has a wind-aligned plume shape, recomputed every 5 seconds. | The brief's "simple plume shapes outdoors"; an outdoor grid would multiply the cell count by ten. |
| W8 | The crowd moves as groups of at most 50 people on flow fields towards usable exits, then towards a muster point. | The brief's "crowds as zone flows"; 400 groups bound the cost whatever the headcount. |
| W9 | Engine state is integers (permille levels, whole seconds); randomness comes from named seeded streams; every snapshot carries a hash of the state. | Bit-identical replays for the After-Action Review and for tests. |
| W10 | Worlds run in `node:worker_threads`, at most two threads hosting at most four worlds per process, with a 250 ms budget per one-second tick. | Master risk 19: the main thread runs every engine and Socket.IO (journey finding 4.14). |
| W11 | One process runs a session's world, under a lease in the database with WS0's scope rule, and only where `env.runBackgroundEngines` is true. | Master 10.8 item 39 ("leased per session as WS0 leases jobs, so one process runs it"); a development server must never run a production world (`server/env.ts:104-114`). |
| W12 | Team and trainer commands are written to a table and applied at tick boundaries in a fixed order. | Determinism, replay after a restart, and no lost command when a request reaches a process that does not hold the lease. |
| W13 | The world drives today's pins through a bridge: it creates and updates session hazard and casualty rows and places its arrived units as `placed_assets`. World-owned rows carry `properties.world_owned`. | Today's response panel, decision evaluation, scoring, counters and AI perception all read those rows; a parallel world nobody can respond to would be a second game. |
| W14 | Coexistence is four narrow gates in existing services, each active only while the world runs, plus a hand-back that retires the compiled fire-spread children still waiting when the world stops (section 6.12). | Master section 9 ("the legacy behaviour is unchanged with it off"); fallback must be instant. |
| W15 | WS9 owns the unit catalogue; WS1's `actionScopeFor` and `zone_access` decide what a unit of an agency may do and where it may go. | Master 10.8 item 39 ("WS1's archetype capabilities say what a unit can do"); WS1 names no unit types. |
| W16 | The road graph is built once per road box and data version and cached in the database. | The brief ("build the graph once and cache it"); a 14 km box holds tens of thousands of road rows. |
| W17 | An arrived unit becomes a placed asset of a mapped type, through `validatePlacement`. | Today's medic range check, marshal proximity and pin resolution read asset types (section 3.5). |
| W18 | In a fog session, today's hazard and casualty routes return only what the caller's teams know, and their broadcasts are reduced to a refetch signal. Placed assets and units stay visible to every team (a shared responder picture) unless the trainer turns sharing off. | "No hidden fact reaches a browser" (the brief); in practice agencies at one incident share where their resources are. |
| W19 | Team views travel as `fieldops_world.delta` events to each member's existing `user:<id>` room; the trainer's as `fieldops_world.trainer`. No new socket room. | The socket layer has session and user rooms only (section 3.6); per-user emission needs no change to the join handshake. |
| W20 | There is no `VITE_` mirror of the flag. The client asks `GET /api/field-ops/sessions/:id/world/view`, which answers the bare 404 while the flag is off. | Master section 8 allocates no client flag; WS6 and WS8 ask capability routes the same way. |
| W21 | The world clock advances only while the session is `in_progress` and the trainer has not paused the world. | A paused exercise must not burn down unseen. |
| W22 | A world that becomes ready after the session started catches up silently, at most 600 ticks in a burst; later than 10 minutes it does not start, and the session keeps today's escalation. | A late world must not be a different story from the one players already saw. |
| W23 | Setup's weather becomes a `WeatherSetting` stored beside the label (master 10.8 item 39). When the trainer sets none, `weatherFromLabel` derives it from the label and the incident's time. | One source for the world, labels that keep working for the narrative. |
| W24 | The spread library has a review record like WS6's. While the deployed dataset is unreviewed, production runs live worlds only for sessions whose trainer is an admin, and every world surface shows "Unreviewed model". | D31 says the parameters are reviewed during development; WS6 handles D22 the same way (`07-device-and-physics.md` section 2.1). |

### 2.3 Assumptions

- **Assumed (D32):** version 1's fidelity is that of W4 to W8. Design 7's question 11 and its default are in section 15.2.
- **Assumed (D33):** the unit catalogue of section 5.10 and its default counts; origins at the nearest WS3 facility of the right kind. Design 7's question 12.
- **Assumed (D34):** observers are units and the team's own placed assets; reports are shared deliberately; CCTV and drones wait (question 13). Units and placed assets are shared with every team by default (W18).
- **Assumed (D35):** the six weather conditions and the Singapore presets of section 5.12; the trainer may change the weather during a session (question 14); traffic profiles for Singapore first, by road group, day type and hour, read at the incident's time from Setup (question 15).
- **Assumed (D29):** doctrine coverage starts with Singapore, Malaysia, Indonesia, the Philippines and Thailand (question 16, WS1's to settle).
- **Assumed (D31):** the person who reviews the spread library has fire-engineering or fire-service experience, as D22 asks for the blast library.
- **Assumed (D10):** compiled casualties come out of the crowd before it starts to move: a zone's moving people are its count minus the killed, serious and moderate casualties WS6's plan placed in it (section 6.6.5).
- **Assumed (D35):** the default weather, when neither a setting nor a usable label exists, is Singapore's ordinary day: clear, 31 °C by day and 27 °C at night, a 3 m/s wind from the north-east, 10 km visibility.

## 3. Current state (verified)

All line numbers are at commit `588387f` (3 Nov 2026), with no uncommitted change in the files cited.

### 3.1 How the world changes today: scripted escalation

- **Verified.** A hazard escalates by the clock. `runHazardDeterioration` (`server/services/hazardDeteriorationService.ts:20`) runs on every scheduler tick and moves each active hazard of the session to the 10, 20 or 30 minute stage of its `deterioration_timeline`, marking it `escalating` (`server/services/hazardDeteriorationService.ts:47-87`). It then reveals that hazard's `delayed` children whose `parent_unresolved` spawn condition is met (`server/services/hazardDeteriorationService.ts:98-140`) and broadcasts `hazard.updated` with the child's `stud_id` (`server/services/hazardDeteriorationService.ts:126-136`). With no child revealed it places a generic new hazard in the hot zone (`server/services/hazardDeteriorationService.ts:179-200`).
- **Verified.** Today those children never reach a session. `cloneScenarioPinsForSession` copies template hazards into session rows and skips every `delayed` one (`server/services/sessionPinCloningService.ts:154-164`), so the deterioration service's lookup of `delayed` children with the session's id finds nothing and the generic spawn runs instead ([journey finding 13.7](../field-ops-user-journey.html#i13-7)). The compile-time fire-spread pins are `delayed` too (`server/services/warroomService.ts:1011-1036`), so today they never appear in a session either. Master 10.8 item 40 changes that for new-flow scenarios: WS5's session start also copies the delayed hazards and casualties and remaps every `parent_pin_id` to the session's copy of its parent (`06-compile-and-review.md` section 5.8, AC5.40), so in those sessions the fire-spread pins are the scripted escalation that the deterioration service reveals.
- **Verified.** The session lists hide a row by time, not by status. `GET /api/sessions/:id/hazards` returns the session's rows whose `appears_at_minutes` has passed, whatever their `status` (`server/routes/hazards.ts:40-46`), the casualty list does the same (`server/routes/casualties.ts:54-60`), and `MapView` draws every hazard row it receives on the active floor (`frontend/src/components/COP/MapView.tsx:1878-1884`). A pre-generated child carries the minute its condition names as its `appears_at_minutes` (`server/services/warroomService.ts:1011-1036`, `server/services/warroomService.ts:1120-1144`). So master 10.8 item 40 hides each copy until it is revealed (`06-compile-and-review.md` section 5.8, AC5.40): the copied delayed row gets `appears_at_minutes` 1,000,000, its minute stays in `spawn_condition.at_minutes`, which the reveal reads, and the reveal sets `appears_at_minutes` to the current minute (`server/services/hazardDeteriorationService.ts:119-122`). Every delayed child compile writes has the `parent_unresolved` trigger, so none appears by its minute alone.
- **Verified.** People deteriorate by the clock. `runPeopleDeterioration` (`server/services/peopleDeteriorationService.ts:94`) steps an untreated patient's colour along `TRIAGE_ESCALATION` (`server/services/peopleDeteriorationService.ts:22-26`) every `ESCALATION_INTERVAL_MIN`, 10 minutes, and lets a red patient die after the 20-minute `CRITICAL_TRANSPORT_WINDOW_MIN` (`server/services/peopleDeteriorationService.ts:57-62`).
- **Verified.** Hazard and casualty rows are session-scoped copies of the scenario's templates: `scenario_hazards` has `session_id`, `properties`, `status` and `appears_at_minutes` (`migrations/125_scenario_hazards.sql:4-26`), its status admits `delayed` (`migrations/139_hazard_status_delayed.sql:1-4`), and `scenario_casualties` holds patients, crowds and evacuee groups with a `headcount` (`migrations/127_scenario_casualties.sql:2-24`) and fourteen statuses (`migrations/161_casualty_status_delayed.sql:4-12`).

### 3.2 The compile-time environment simulation

- **Verified.** `runEnvironmentalSimulation(studs, walls, hazards, hazardAnalyses, gameDurationMin, timeScale, snapshotTimesMin)` (`server/services/environmentalSimService.ts:202-210`) is deterministic code with no model call. Its header says it replicates the browser's `SpatialEffectsEngine` and `FireSimulation` for batch snapshots and imports nothing from the frontend (`server/services/environmentalSimService.ts:1-10`). It takes `SimStud`, `SimWall` and `SimHazard` in sim-space metres (`server/services/environmentalSimService.ts:28-48`) and returns snapshots.
- **Verified.** Its physics is hard-coded: `DEFAULT_WALL_RESISTANCE` in seconds per material (`server/services/environmentalSimService.ts:72-88`), `DEFAULT_HAZARD_ACCELERATION` per hazard type (`server/services/environmentalSimService.ts:90-97`), `BURN_DURATION` 300 and `HEAT_TRANSFER_RATE` 15 (`server/services/environmentalSimService.ts:99-100`), `SMOKE_RATE` per smoke class (`server/services/environmentalSimService.ts:102-108`), and `DEFAULT_TIME_SCALE` 0.5 (`server/services/environmentalSimService.ts:110-111`), which halves every physical rate.
- **Verified.** `lookupResistance` matches materials by substring in both directions (`server/services/environmentalSimService.ts:161-167`). An empty material matches the first entry, `concrete`, because every string contains the empty string, so a wall with no material holds fire for ever; `stone` and `cinder_block`, two of the Scene Editor's ten choices (`frontend/src/components/SceneEditor/SceneEditor.tsx:2693-2703`), fall through to 900 seconds. The legacy route sends `material: ''` for every wall the trainer left unset (`server/routes/warroom.ts:981-988`).
- **Verified.** Fire spreads only inside hazard radii: a stud next to a burning one heats only when `getHazardAcceleration` finds a hazard whose radius covers it (`server/services/environmentalSimService.ts:169-179`, `server/services/environmentalSimService.ts:356-361`). Everything else in the building never burns.
- **Verified.** It is quadratic and synchronous. `neighborCache` compares every stud with every other (`server/services/environmentalSimService.ts:233-242`), and the main loop steps every stud once per game second for the whole duration (`server/services/environmentalSimService.ts:272`), on the calling thread ([journey finding 4.14](../field-ops-user-journey.html#i4-14)). The neighbour test uses x and y only, so studs of different floors at the same position are neighbours at distance zero.
- **Verified.** The grids are large because they are padded. `generateStudsForPolygon` fills the polygon's bounding box plus `EXTERIOR_PADDING_M`, 150 m, naming inside studs `bldg-` and outside ones `ext-` (`server/services/buildingStudService.ts:100-139`); `generateStudGrids` repeats that for every floor, and its default spacing is `DEFAULT_SPACING_M`, 3 m, the runtime grid (`server/services/buildingStudService.ts:182-214`). Compile calls `generateStudGrids` with 5 m (`server/services/warroomService.ts:1309-1323`), and so does the legacy research route (`server/routes/warroom.ts:931-947`).
- **Verified.** Each snapshot lists, per affected stud, smoke density, fire intensity, gas, structural damage and a visibility from fixed smoke bands of 15, 12, 8, 3, 1 and 0.5 m (`server/services/environmentalSimService.ts:616-632`). The shapes are `StudEnvironmentalEffect` and `EnvironmentalSnapshot` (`server/services/rtsSceneEnrichmentService.ts:147-160`).

### 3.3 The research step, the facts and the fire-spread pins

- **Verified.** Today's timeline comes from the legacy `research-doctrines` route, not from compile: it builds a 5 m grid for every floor and calls `enrichScene` with the interior walls and the draft's duration (`server/routes/warroom.ts:950-997`). `enrichScene` asks the model for each hazard's events through `analyzeHazard` (`server/services/rtsSceneEnrichmentService.ts:750-758`), then calls `runEnvironmentalSimulation` with every hazard at a fixed 5 m radius (`server/services/rtsSceneEnrichmentService.ts:819-832`) and stores the engine's snapshots as `environmentalTimeline` (`server/services/rtsSceneEnrichmentService.ts:862-868`).
- **Verified.** The events are model output. `HazardEvent` holds `triggerTimeSec`, `eventType`, `spreadType`, `spreadRadius`, `spreadRate`, a description, a severity and optional smoke fields (`server/services/rtsSceneEnrichmentService.ts:113-124`); `HazardAnalysis` wraps them with the model's prose (`server/services/rtsSceneEnrichmentService.ts:133-145`). The prompt asks the model for each event's `triggerTimeSec`, `spreadRadius` and `spreadRate` (`server/services/rtsSceneEnrichmentService.ts:202-235`). A failed analysis gives `defaultHazardAnalysis`, whose `events` are empty (`server/services/rtsSceneEnrichmentService.ts:328-347`).
- **Verified.** `researchDeteriorationPhysics` makes one model call for each hazard's dispersion "in local climate conditions", its structural progression and a precedent (`server/services/warroomResearchService.ts:1542-1600`) and returns `DeteriorationResearch` (`server/services/warroomResearchService.ts:1519-1535`). `deteriorationResearchToPromptBlock` turns it into a text block with the headings HAZARD PHYSICS, CROSS-HAZARD INTERACTIONS and PATIENT DETERIORATION NOTES (`server/services/warroomResearchService.ts:1664-1680`), which compile passes as the `deteriorationResearch` string of `generateDeteriorationTimeline` (`server/services/warroomAiService.ts:7274-7293`, called at `server/services/warroomService.ts:1553-1557`).
- **Verified.** `generateFireSpreadSpawnPins` (`server/services/warroomService.ts:925-929`) reads the snapshots at 5, 10, 15, 20 and 30 minutes, counts a stud as burning from 0.3, keeps clusters of at least three newly burning studs within 15 m and stops at 12 pins (`FIRE_SPREAD_SNAPSHOT_MINUTES` to `MAX_SPREAD_PINS`, `server/services/warroomService.ts:910-914`). Compile calls it only when the scene row carries an enrichment (`server/services/warroomService.ts:1626-1653`).

### 3.4 The session engines and their cadence

- **Verified.** The inject scheduler ticks every `injectSchedulerIntervalMs`, 30 seconds by default (`server/env.ts:122-123`, `server/services/injectSchedulerService.ts:227-234`), and runs `processSession` for the live sessions one after another (`server/services/injectSchedulerService.ts:315-335`). For each session, after injects and conditions, it runs pin resolution, the two deterioration services, the evacuation pipeline, the movement tick, the area monitors, the detonation timers and the sweep, patient and hazard queues, in that order (`server/services/injectSchedulerService.ts:1104-1186`). The patient queue sleeps two seconds inside the tick (`server/services/injectSchedulerService.ts:1785`).
- **Verified.** The engine queues play teams: `checkHazardQueue` finds the fire and bomb teams by name and posts canned responses for active hazards (`server/services/injectSchedulerService.ts:1827-1865`). WS7 gates these queues by the session's play mode (master 10.8 item 15).
- **Verified.** `startGeneratorEngines` ticks every `TICK_MS`, 60 seconds (`server/services/engineTicker.ts:18-33`), and its tick reads only `social_media` sessions (`server/services/engineTicker.ts:41-48`), so a field-ops world never meets it.
- **Verified.** Exit flow moves crowd pins through claimed exits: `processExitFlow` (`server/services/exitFlowService.ts:91`) reads the session's claims (`server/services/exitFlowService.ts:100-104`), a session-wide `flow_rate_modifier` and compliance (`server/services/exitFlowService.ts:146-154`), counts every active placed asset as a marshal (`server/services/exitFlowService.ts:156-163`) and moves `min(headcount, effectiveFlowRate)` people per tick from a `BASE_FLOW_RATE_PER_MIN` of 40 (`server/services/exitFlowService.ts:18`, `server/services/exitFlowService.ts:169-173`, `server/services/exitFlowService.ts:222-245`), a per-minute rate applied per 30-second tick ([journey finding 13.14](../field-ops-user-journey.html#i13-14)).
- **Verified.** `runMovementTick` (`server/services/movementService.ts:39-43`) moves pins that have a destination, at `CROWD_WALK_MPM` 72, `STRETCHER_CARRY_MPM` 30, `AMBULATORY_PATIENT_MPM` 40 or `AMBULANCE_MPM` 500 metres a minute (`server/services/movementService.ts:14-17`), in a straight line.
- **Verified.** `runAreaMonitors` checks player areas for crowding, carer ratios, equipment and exit congestion and publishes injects (`server/services/areaMonitorService.ts:125-130`), with capacities per square metre in `CAPACITY_PER_M2` (`server/services/areaMonitorService.ts:54-60`).
- **Verified.** Transport outcomes are judged, not simulated. `evaluateTransportOutcome` (`server/services/transportOutcomeService.ts:176-183`) asks a model whether a decision is a transport (`server/services/transportOutcomeService.ts:29-53`) and compares the session's route rows, each with a `problem`, `managed` and `travel_time_minutes` (`server/services/transportOutcomeService.ts:14-22`). A transport decision moves the patient pin with `AMBULANCE_MPM` towards the destination (`server/services/decisionCasualtyEffectsService.ts:466-473`).
- **Verified.** At session start `loadAndApplyEnvironmentalState` (`server/services/environmentalStateService.ts:157`) reads the scenario's `routeLocations` and copies them into the session's environmental state (`server/services/environmentalStateService.ts:250-279`). `evaluateEnvironmentalManagementIntentAndUpdateState` (`server/services/environmentalConditionManagementService.ts:336`) asks a model whether a decision managed one of those routes or a poor location (`server/services/environmentalConditionManagementService.ts:1-7`).
- **Verified.** `checkDetonationTimers` handles live suspicious packages whose `detonation_deadline` has passed (`server/services/injectSchedulerService.ts:2049-2066`).

### 3.5 Placed assets, placement checks and pin resolution

- **Verified.** A placed asset is a row of `placed_assets` with a team, an `asset_type`, GeoJSON `geometry`, `properties`, a score and a status (`migrations/124_placed_assets.sql:4-23`), later linked to a hazard or a casualty (`migrations/131_placed_assets_linking.sql:1-4`). `placed_by` is a required user.
- **Verified.** `POST /api/sessions/:id/placements` checks `assertSessionAccess` and `assertTeamMembership` (`server/routes/placements.ts:286-295`), snaps a point to the nearest classified stud (`server/routes/placements.ts:297-330`), runs `validatePlacement` and answers 422 "Placement blocked" with its blocks (`server/routes/placements.ts:333-347`), scores it, inserts it and broadcasts `placement.created` with the whole row (`server/routes/placements.ts:377-386`).
- **Verified.** `validatePlacement` (`server/services/placementValidationService.ts:55-62`) blocks a point inside an incident site's `blast_radius_m` and warns within 1.5 times it (`server/services/placementValidationService.ts:98-118`), warns when another team's asset among the `existingPlacements` is within 20 m (`server/services/placementValidationService.ts:120-148`), and checks water and vehicle access at the nearest of the `candidateSpaces` (`server/services/placementValidationService.ts:150-191`).
- **Verified.** Pin resolution matches asset types by substring: `evaluateHazardResolution` (`server/services/pinResolutionService.ts:60-75`) resolves or contains a hazard when assets within `PROXIMITY_THRESHOLD_M`, 80 m, include the required personnel type in either direction (`server/services/pinResolutionService.ts:115-119`), and broadcasts `hazard.updated` (`server/services/pinResolutionService.ts:147-152`). A casualty can be assessed only with an asset of a `MEDIC_TYPES` type within 80 m (`server/routes/casualties.ts:215-243`).

### 3.6 How events reach browsers

- **Verified.** One Socket.IO server is set up on the HTTP server (`server/index.ts:70-74`). On connection each socket joins `user:<id>` (`server/websocket/index.ts:68-72`); `join_session` checks the trainer, an admin or a participant and joins `session:<id>` (`server/websocket/index.ts:74-112`). There are no team rooms.
- **Verified.** `broadcastToSession` emits an `event` to the whole session room and to the internal bus (`server/services/websocketService.ts:62-73`); `emitToUser` emits to one user's room (`server/services/websocketService.ts:117-124`). Every hazard, casualty and placement change today reaches every member of the session.
- **Verified.** The browser's client routes each `event` by its `type` (`frontend/src/lib/websocketClient.ts:101`, `frontend/src/lib/websocketClient.ts:188-200`), and `useWebSocket` subscribes a component to a list of types (`frontend/src/hooks/useWebSocket.ts:12-26`).

### 3.7 The live map client

- **Verified.** `MapView` takes `sessionId`, `scenarioId`, `teamName`, `showAllPins`, `bypassExitGate` and optional `children` rendered inside the map (`frontend/src/components/COP/MapView.tsx:127-204`). It draws each route of the environmental state as a `RoutePolyline` (`frontend/src/components/COP/MapView.tsx:1609-1615`), `BuildingStudOverlay` (`frontend/src/components/COP/MapView.tsx:1637-1645`), a `CrowdDensityOverlay` and a `WindIndicator` from `environmental_state.areas` and `wind` (`frontend/src/components/COP/MapView.tsx:1648-1654`), and gates hazards, casualties and crowds behind the exit claims (`frontend/src/components/COP/MapView.tsx:1878-1884`). It listens to eleven event types (`frontend/src/components/COP/MapView.tsx:762-782`).
- **Verified.** `WindData` is `direction_degrees`, an optional `speed_kph` and a label (`frontend/src/components/COP/WindIndicator.tsx:5-9`); the indicator rotates a down arrow by the angle (`frontend/src/components/COP/WindIndicator.tsx:30-55`), so it reads the angle as where the wind comes from. `scoreWindAwareness` treats the same angle, its `windDir`, as where the wind goes (`server/services/spatialScoringService.ts:214-227`). No server code writes `environmental_state.wind`; it is read by spatial scoring (`server/services/spatialScoringService.ts:365`) and by the map.
- **Verified.** Spectator mode is a URL parameter: `SessionView` renders `MapView` with `showAllPins` and `bypassExitGate` for `?spectator=true` (`frontend/src/pages/SessionView.tsx:1477-1502`), so a spectator sees every pin today.
- **Verified.** WS0 makes `MapView` the live map for participants and spectators (`01-prerequisites.md` section 6.5), and WS4 mounts its `FieldOpsSceneOverlay` next to `BuildingStudOverlay` (`05-layout-step.md` section 7.16).

### 3.8 The debug sandbox

- **Verified.** `/debug/rts-sim` renders `DebugRTSSim` (`frontend/src/main.tsx:179-182`, `frontend/src/pages/DebugRTSSim.tsx:299`), a 5,203-line page that holds an `RTSEngine` (`frontend/src/pages/DebugRTSSim.tsx:367`), drives it from `requestAnimationFrame` (`frontend/src/pages/DebugRTSSim.tsx:1467`), and builds a `SpatialEffectsEngine` for previews (`frontend/src/pages/DebugRTSSim.tsx:2520`).
- **Verified.** `RTSEngine` keeps a clock, units with waypoints and a work timer, and moves them in a straight line at their speed (`frontend/src/lib/rts/engine.ts:21-29`, `frontend/src/lib/rts/engine.ts:133-175`); `issueMove` routes through building exits with `computePathThroughExits` (`frontend/src/lib/rts/engine.ts:116-131`, `frontend/src/lib/rts/pathfinding.ts:141-201`). The units are people on foot of seven teams with speeds of 0.3 to 2.2 m/s and lists of abilities (`frontend/src/lib/rts/types.ts:29-134`).
- **Verified.** `SpatialEffectsEngine` is the steppable twin of the server simulation: `step(dt, walls, hazards)` processes hazard events, then fire, gas, flood, structure and smoke (`frontend/src/lib/rts/spatialEffects.ts:189-200`), and its `init` builds the same quadratic neighbour cache (`frontend/src/lib/rts/spatialEffects.ts:156-167`). `FireSimulation` holds the same defaults as the server (`DEFAULT_FIRE_PARAMS`, `frontend/src/lib/rts/fireSimulation.ts:30-59`).
- **Verified.** `drawStudGrid` draws each stud's structure, flood, gas and fire layers with fixed colour ramps (`frontend/src/lib/rts/renderer.ts:209-305`). `HAZARD_DEFS` labels the six hazard types with emoji (`frontend/src/lib/rts/types.ts:619-626`), which new surfaces must not reuse (`10-ui-spec-sheet.md` section 12).
- **Verified.** None of it is reachable from the server: the root `tsconfig.json` compiles `src`, `server`, `shared` and `scripts` only (`tsconfig.json:31`), and the frontend files import browser types.

### 3.9 The saved roads and facilities

- **Verified.** `osm_sg_roads` stores a text `osm_id`, `name`, `highway_type`, `oneway`, a centre, a bounding box and `coordinates_json` (`migrations/193_singapore_local_osm_cache.sql:5-21`), with bounding-box and highway-type indexes (`migrations/193_singapore_local_osm_cache.sql:43-47`) and row level security for the service role only (`migrations/193_singapore_local_osm_cache.sql:55-63`). The generator keeps 14 highway types in `ROAD_TYPES` (`scripts/generate_singapore_local_osm.mjs:16-31`). Coordinates are `[lat, lng]` pairs, parsed by `parseLatLngPairs` (`server/services/osmVicinityService.ts:639-650`); `isDrivableRoadType` admits all 14 (`server/services/osmVicinityService.ts:811-829`).
- **Verified.** The saved data has 185,893 roads, Singapore only (common brief, 24 Oct). There is no road graph, no intersection table and no node id: two ways meet where they share a coordinate.
- **Verified (in WS3's spec).** `loadSiteArea` reads at most 600 m around the site (`SITE_LIMITS.areaFetchMaxM`, `04-site-picker.md` section 5.2), so it cannot serve a route from a fire station 5 km away. `listFacilitiesNear` returns `hospital`, `clinic`, `police`, `fire_station`, `ambulance_station` and others up to 10 km with no network call (`04-site-picker.md` section 6.9).

### 3.10 One process, one build

- **Verified.** One Node process serves HTTP and sockets and, where `env.runBackgroundEngines` holds, runs every background engine (`server/index.ts:80-111`, `server/env.ts:104-114`). Shutdown stops the schedulers, closes the servers and exits after 10 seconds (`server/index.ts:314-338`).
- **Verified.** Production runs `node dist/server/index.js` after `tsc --project tsconfig.json` (`package.json:14`, `package.json:17`); development runs `tsx watch server/index.ts` (`package.json:12`); tests run `node --import tsx --test` with an explicit list of files (`package.json:25`). The compiler writes `dist/` from the repository root (`tsconfig.json:3-4`). No server code uses `worker_threads` today.
- **Verified.** A session's status is one of `scheduled`, `in_progress`, `paused`, `completed` and `cancelled` (`server/routes/sessions.ts:51`). `start_time` is set once, on the first start (`server/routes/sessions.ts:1424-1426`); the start then clones the pins and loads the environmental state (`server/routes/sessions.ts:1472-1511`). Every engine computes elapsed time from `start_time`, so paused minutes count.

### 3.11 Where Design 7 and the code differ

| Design 7 says (journey, [Design 7](../field-ops-user-journey.html#c8a-d7)) | The code | Consequence here |
| --- | --- | --- |
| Fire and smoke are "worked out for 60 minutes at compile" | They are worked out by the legacy research route for the draft's duration, and today the pins they produce are dropped when a session starts (sections 3.1 and 3.3); master 10.8 item 40 makes WS5's session start copy them for new-flow scenarios | Without a live world, the fire-spread pins are the session's scripted escalation; with one, the world's own fires replace them, and they are retired when it hands back (section 6.12). Either way a copied child stays off the session lists until it is revealed, because item 40's copy hides it (section 3.1) |
| "Walls block the spread" | Walls block, but an unset material blocks for ever and fire never leaves the hazard radii (section 3.2) | The library resolves materials by exact key and alias, and the live engine spreads fire through contents everywhere |
| The crowd "flows through the exits every 30-second tick" | It does, at a per-minute rate applied per tick, for crowd pins in claimed exit pathways only (section 3.4) | The world's crowd is a separate population taken from the crowd zones; today's crowd pins keep today's exit flow |
| Weather is "a free-text label used in the story" | Also a wind direction that the map reads one way and spatial scoring the other, and that nothing writes (section 3.7) | WS9's `WeatherSetting` stores the wind in the meteorological convention the map's indicator uses, draws its own indicator, and leaves `environmental_state.wind` as it is (section 6.9.5); section 15.2 raises the scoring defect |
| "Teams place assets on the map instantly, and the placement is checked" | True (section 3.5) | Units arrive through the same check |

## 4. Target behaviour and acceptance criteria

### 4.1 The exercise, as the trainer and the players meet it (Proposed)

1. **Before the session.** In the lobby the trainer opens the "Live world" card. It says whether the world is ready ("World ready", "Preparing the world…" or why it is not available), and lets her keep the world on or off, keep fog of war on or off, set each agency's units and where they start (the nearest station, a staging point she clicks on the map, or on site for venue staff), and check the weather that Setup gave the exercise. Preparing the world builds the grid, the compartments, the crowd and the road graph once for the scenario's revision; a second session of the same scenario reuses it.
2. **T+0.** When the session starts, the world starts with it. The main device's calculated effects (WS6) set the first structural damage and break the glazing in range; combustible contents inside its thermal reach ignite; hazards the blast reaches react as the library says. Compiled casualties are where compile placed them; everyone else in the crowd zones begins to move after a short delay.
3. **During play.** Fire spreads from cell to cell through the contents, held back by walls until they burn through, faster where a door or a broken window lets the wind in. Smoke fills rooms and stairwells and leaks out of openings into plumes that drift downwind. Damaged areas become unsafe and some collapse. People head for the nearest usable exit, avoid smoke and blocked exits, queue at narrow ones, and walk to a muster point; those caught in smoke or a collapse become casualties. Each team dispatches its units from the units panel: a unit drives over the saved roads, its arrival time shown and updated with traffic, weather and closures, and on arrival it deploys on foot and does its task: suppress, ventilate, rescue, shore, triage, cordon, direct the crowd, close an exit. Each team sees what its units and posts can see; elsewhere its map is dark, with markers where it last saw something. Teams share what they see with a report. The trainer sees everything, and can change the weather, close a road, start a secondary fire or pause the world.
4. **What stays as it is.** Injects, decisions, chat, scoring, the hazard and casualty panels, triage and the existing evacuation of crowd pins work as today. The world feeds them: its fires and collapses appear as hazard pins, its exposure casualties as casualty pins, its arrived units as placed assets.
5. **When the world cannot keep up.** If the world falls behind or fails, it stops, says "Live world stopped. The exercise continues with scripted escalation.", hands its hazards back to today's deterioration, and the session goes on as it would without WS9.
6. **Afterwards.** The After-Action Review shows the world's timeline (ignitions, collapses, dispatches, arrivals, exposures, weather changes, closures) and lets the trainer step through the world once a minute.

### 4.2 The slices (master section 6, build-order item 7)

| Slice | Delivers | Lands with | Without it, or when it fails |
| --- | --- | --- | --- |
| 1 | Migration 249, the seed files and the review record; `loadSpreadLibrary`, `hazardEventsFor`, `deteriorationFactsFor`; `buildSpreadTimeline` in a worker; the library admin routes | WS5 (master 10.8 item 35) | `loadSpreadLibrary` answers null: WS5 compiles with no fire-spread pins and an empty facts block and records a warning (item 38) |
| 2 | Migrations 250 to 252; the world model and its job kind; the engine for fire, smoke, gas, structure, plumes, crowds and exposure; the runtime, lease, log, snapshots and recovery; the bridge and the four gates; the console, the lobby card and the map layers; the replay panel | After WS5 and WS6 | No world rows: the session runs today's scripted escalation |
| 3 | Migration 253; road graphs, speed classes and units; dispatch, routing, arrival as placed assets and tasks | After slice 2 | No units: teams place assets as today; the world's fires respond only to today's pin resolution and decisions |
| 4 | Migration 254; observation, knowledge, reports; fog filtering of every payload; broadcast redaction | After slice 3 | `fog_enabled` is false: every participant sees the whole world except the devices |
| 5 | Migration 255; `WeatherSetting` presets, the effects of weather, traffic profiles, cordons, closures, jams; WS2's stored weather setting | After slice 4 | Fixed defaults: the default weather of section 2.3 and free-flow road speeds |

Each slice is switched on by the same flag; a slice whose migration is missing degrades as in the last column (section 5.13).

### 4.3 Acceptance criteria

The test files are in section 11.1. Pure modules are tested without a database or a model.

**Slice 1: the spread library and the compile-time timeline**

1. **AC9.1** Given migration 249 is not applied, when `loadSpreadLibrary()` runs, then it resolves to null without throwing and logs `fieldops_spread_library_missing` once per minute; given the tables exist but hold no active rows, then it also resolves to null and logs `fieldops_spread_library_empty`; given the seeded tables, then it resolves to a `SpreadLibrary` with a 16-hex `dataset_version`. Test: `server/services/fieldOps/world/spreadLibrary.test.ts (new)`, "null when missing or empty".
2. **AC9.2** Given seeded rows with one required default removed (`unknown_wall`, `contents_generic`, `frame_unknown`, any of the six hazard types or any exposure agent), when the library loads, then it resolves to null and logs `fieldops_spread_library_invalid` with the missing keys. Test: `spreadLibrary.test.ts`, "integrity".
3. **AC9.3** Given the same active rows in any order, and given the seed files, when `datasetVersionOf` runs on each, then all give the same `dataset_version`; changing one number changes it. Test: `spreadLibrary.test.ts`, "dataset version".
4. **AC9.4** Given each of WS4's six hazard types at each severity, when `hazardEventsFor(hazard, library)` runs twice, then both results are deep-equal arrays of `HazardEvent` objects with exactly the fields of `server/services/rtsSceneEnrichmentService.ts:113-124`, no `eventType` of `explode`, `spreadRadius` at most the row's `max_radius_m`, and events in ascending `triggerTimeSec`; an unknown type gives an empty array. Test: `server/services/fieldOps/world/hazardEvents.test.ts (new)`.
5. **AC9.5** Given a combustible hazard whose `blast` is 34 m in the `serious` band, with a library delay of 20 s, when `hazardEventsFor` runs, then its `triggerTimeSec` is 20 (the blast arrives at about 0.1 s, rounded to 0, plus the delay); given `within_thermal`, then it is the arrival alone; given the band `outside` or `blast` null, then it has no event; given a hazard whose trigger is `ignition`, then it has no event and only accelerates fire that reaches it; given a `material` that resolves to a contents key, then the event's spread rate is that material's. Test: `hazardEvents.test.ts`, "trigger timing".
6. **AC9.6** Given two hazards (combustible and electrical) and three patients, when `deteriorationFactsFor(hazards, casualties, library)` runs, then the text has the headings HAZARD PHYSICS, CROSS-HAZARD INTERACTIONS and PATIENT DETERIORATION NOTES in that order, one block per library hazard type present naming its hazards' labels, with the library's dispersion, structural and timeline lines and its `source_ref`, the electrical-to-combustible interaction only, and the exposure notes; it contains no device field and no number that is not a library value; given 60 hazards of every type it is at most 6,000 characters; given a null library it returns the empty string. Test: `spreadLibrary.test.ts`, "facts block".
7. **AC9.7** Given a fixture of 15,000 studs and four hazards, when `buildSpreadTimeline` runs while a 10 ms interval timer runs on the main thread, then the timer's 95th-percentile lateness stays under 50 ms and the promise resolves with snapshots at 0, 1, 3, 5, 10, 15, 20, 30, 45 and 60 minutes. Test: `server/services/fieldOps/world/compileSpread.test.ts (new)`, "off the main thread".
8. **AC9.8** Given more studs than `SPREAD_LIMITS.maxStuds`, when the timeline is built, then only studs within `SPREAD_LIMITS.reachM` of a hazard are kept, nearest first; given a worker that overruns `SPREAD_LIMITS.timeoutMs`, then the promise rejects with `SpreadTimelineError` code `timeout` within one second of the limit and the worker is terminated; given the input's `signal` aborts, then it rejects with `aborted` at once and the worker is terminated; given a worker that throws, then it rejects with `worker_failed`. Test: `compileSpread.test.ts`, "limits".
9. **AC9.9** Given parameters equal to today's constants and analyses built the way today's caller builds them, when `buildSpreadTimeline` and a direct call of `runEnvironmentalSimulation` run on the same input with a time scale of 1, then their snapshots are deep-equal. Test: `compileSpread.test.ts`, "runs today's simulation".
10. **AC9.10** Given the golden fixture recorded from the baseline, when `runEnvironmentalSimulation` is called without the new argument, then its output is byte-identical to the fixture. Test: `server/services/environmentalSimService.test.ts (new)`.
11. **AC9.11** Given wall materials `''`, `concrete`, `cinder_block`, `stone`, `Plasterboard`, `steel` and `glass window`, when `resolveMaterialKey(text, 'wall', library)` runs, then they resolve to `unknown_wall`, `concrete`, `cinder_block`, `stone`, `drywall`, `metal` and `glass`, never to `concrete` for an empty string. Test: `server/lib/fieldOps/worldRules.test.ts (new)`, "materials".
12. **AC9.12** Given an approved review for the current `dataset_version`, then the library's `review.state` is `reviewed`; after an admin edit changes the version, then it is `unreviewed`; given production and an unreviewed library, then `worldAllowedFor('trainer')` is false and `worldAllowedFor('admin')` is true. Test: `spreadLibrary.test.ts`, "review gate".
13. **AC9.13** Given the library admin routes, when a trainer calls them then 403 `FORBIDDEN`; when both `ENABLE_FIELDOPS_V2` and `ENABLE_FIELDOPS_WORLD_SIM` are off then the bare 404; when `seed` runs on non-empty tables then 409 `LIBRARY_NOT_EMPTY`; when a text field fails `moderateDeviceText` then 400 `LIBRARY_TEXT_REFUSED`. Test: `server/routes/fieldOpsSpreadLibrary.test.ts (new)`.

**Slice 2: the world and its runtime**

14. **AC9.14** Given the mockup fixture scenario (section 11.2), when `buildWorldModel` runs, then every input of the D36 table (section 6.6.1) appears in the model: the primary's cells, each wall's material key, each door gap, each stairwell, each exit, each wall point, each involved building as a compartment, each hazard, each placed device's radii, each crowd zone's groups, the weather and the time of day. Test: `server/services/fieldOps/world/model/buildWorldModel.test.ts (new)`, "every detail".
15. **AC9.15** Given a 60 by 40 m primary building, then the grid is 3 m and only cells whose centre is inside the outline exist (no exterior padding); given a building that would need 30,000 cells at 3 m, then 4 m is used; given one that still exceeds 20,000 at 5 m on its modelled floors, then the build fails with `WORLD_TOO_LARGE` and the session keeps today's escalation. Test: `buildWorldModel.test.ts`, "grid size".
16. **AC9.16** Given a room of `contents_retail` with a fire started in one corner, when the engine steps 600 ticks with no wind, then the burning front advances at the row's `flame_spread_m_min` within one cell per minute; a concrete wall never passes fire; a drywall wall passes it only after its `burn_through_s`; a door gap passes it like open floor; a cell suppressed until wet does not re-ignite while wet. Test: `server/services/fieldOps/world/engine/fire.test.ts (new)`.
17. **AC9.17** Given a burning room with a door and a closed solid wall to two neighbours, then smoke in the door's neighbour exceeds the wall's neighbour after 120 ticks; given an open exit, then cells within 6 m of it clear faster; given a `ventilate` task at the exit, then they clear at least four times faster and fire within 12 m spreads 20 per cent faster. Test: `server/services/fieldOps/world/engine/smoke.test.ts (new)`.
18. **AC9.18** Given WS6's structural radii for the main device, then at tick 0 cells inside `structural_severe` are `unsafe`, inside `structural_moderate` and `structural_light` `damaged`, and glazed walls inside `glass_breakage` become openings; given an unsafe cell left unshored, then it collapses when its damage reaches 850 permille at the frame's creep rate, with every neighbour at 600 or more; given a shored cell, then its damage stops rising; given people in a collapsing cell, then casualties are created in the library's shares. Test: `server/services/fieldOps/world/engine/structure.test.ts (new)`.
19. **AC9.19** Given a smoke source outdoors and a 5 m/s wind from 90 degrees, then the plume lies downwind to the west, its length grows to the row's maximum and no further, it turns within one recomputation when the wind turns, and heavy rain shortens it by the weather row's factor. Test: `server/services/fieldOps/world/engine/plumes.test.ts (new)`.
20. **AC9.20** Given 200 people in a zone with two exits, one of them smoke-logged, then every group leaves by the clear exit; given an exit 1 m wide and one 3 m wide at equal distance, then throughput follows width; given every exit blocked, then the groups are `trapped`; given a cordon line between the groups and the incident, then groups walking away from the incident pass it and none walk in. Test: `server/services/fieldOps/world/engine/crowd.test.ts (new)`.
21. **AC9.21** Given a group of 50 in heavy smoke, when its dose passes the library's light, serious and fatal thresholds, then the library's shares of it become yellow, red and black casualties, written once each; given a patient pin in smoke, then its colour steps green to yellow to red to black at the same thresholds, on top of today's clock. Test: `server/services/fieldOps/world/engine/exposure.test.ts (new)`.
22. **AC9.22** Given one fire engine crew suppressing a burning cell of `contents_office`, then the cell goes out after the row's `extinguish_s`; given `direct_crowd` at a zone, then its groups start within 15 s and take the directed exit; given `close_exit`, then no group targets that exit. Test: `server/services/fieldOps/world/engine/actions.test.ts (new)`.
23. **AC9.23** Given the fixture world and a script of commands, when it runs 1,800 ticks twice, then the state hashes at every snapshot are equal; when it is restored from the snapshot at tick 1,200 and the commands after it are replayed, then the hash at tick 1,800 is the same. Test: `server/services/fieldOps/world/engine/determinism.test.ts (new)`.
24. **AC9.24** Given a world of 20,000 cells, 400 crowd groups, 40 units and 24 plumes hosted in a worker, when it ticks for 300 seconds, then the mean tick is under 50 ms, no tick exceeds 250 ms, and the main thread's event-loop lag stays under 50 ms at the 95th percentile. Test: `server/services/fieldOps/world/perf/worldBudget.test.ts (new)`.
25. **AC9.25** Given two runtimes sharing a store, then only one holds a session's lease; when the holder stops heartbeating, then the other claims the lease within the lease plus one reconcile interval, restores the latest snapshot, replays the commands after it and reaches the hash the uninterrupted run had at that tick; a runtime whose scope differs never claims it. Test: `server/services/fieldOps/world/runtime/worldRuntime.test.ts (new)`, "lease and recovery".
26. **AC9.26** Given a 20-minute run with events, units and knowledge, then the store receives at most one event batch per 2 seconds, one snapshot per `FIELDOPS_WORLD_SNAPSHOT_SECONDS`, and at most 150 writes a minute in total. Test: `worldRuntime.test.ts`, "write budget".
27. **AC9.27** Given ticks forced over `FIELDOPS_WORLD_TICK_BUDGET_MS`, then the world degrades to level 1 after 5 slow ticks and level 2 after 10 more, and falls back after 30 seconds over budget or 30 seconds behind the wall clock, with reason `WORLD_BEHIND`; on fallback every world-owned hazard of the session loses `properties.world_owned` in one update, and the world-session row is `fallback`. Test: `worldRuntime.test.ts`, "back-pressure".
28. **AC9.28** Given a session with a running world, then `runHazardDeterioration` skips hazards whose `properties.world_owned` is true, `evaluateHazardResolution` skips them, and `processExitFlow` scales each exit's rate by the world's factor for it; given the flag off, no world row, or a world in fallback, then all three behave exactly as today. Test: `server/services/fieldOps/world/bridge/worldGates.test.ts (new)`.
29. **AC9.29** Given a fire region that grows to three cells more than 15 m from every world fire pin, then exactly one session hazard row is inserted with `hazard_type` `fire`, `status` `active` and `properties.world_owned`; when all its cells have been out for 60 seconds, then its status is `resolved`; a collapse inserts one `structural_collapse` row. Test: `server/services/fieldOps/world/bridge/pinBridge.test.ts (new)`.
30. **AC9.30** Given `ENABLE_FIELDOPS_WORLD_SIM` off, then no world row is created for any session, every world route answers the bare 404, and `MapView` renders no world layer. Test: `server/routes/fieldOpsWorld.test.ts (new)`, "flag off"; manual step M1.
31. **AC9.31** Given the session's trainer, when she changes the weather, closes a road, starts a fire, pauses and resumes, then each is applied at the next tick boundary, logged as an event, and reflected in the next delta; given a participant or another trainer, then 403. Test: `fieldOpsWorld.test.ts`, "trainer console".
32. **AC9.32** Given a session paused for 5 minutes, then the world's clock does not advance during the pause and continues from the same tick on resume; the console shows both clocks. Test: `worldRuntime.test.ts`, "pause".
33. **AC9.33** Given a legacy scenario, then no world row is created; given a v2 scenario with the flag on, then a row exists within one reconcile interval of the start; given a world ready more than 10 minutes after the start, then it does not start and records `STARTED_TOO_LATE`; ready within 10 minutes, then it catches up without sending intermediate deltas. Test: `worldRuntime.test.ts`, "eligibility and late start".

**Slice 3: units**

34. **AC9.34** Given each of the 13 archetypes, then `unitsForAgency` returns the catalogue's kinds and default counts, none for `media_comms`, `hospital_ed` and `ministry_liaison`; a unit's tasks are its kind's tasks less `triage` when the team's action scope has no `can_triage` and less `sweep` when it has no `can_sweep`. Test: `worldRules.test.ts`, "unit catalogue".
35. **AC9.35** Given a fixture of road rows (two ways crossing at a shared coordinate, a one-way street and a service road), when the graph is built, then the crossing is one node, the one-way edge exists in one direction only, edge lengths match the haversine sum within 0.5 m, and the encoded graph round-trips; a second build for the same box and data version reads the cache. Test: `server/services/fieldOps/world/roads/roadGraph.test.ts (new)`.
36. **AC9.36** Given the fixture graph and speed classes, when a unit is routed, then the route is the minimum-time path, its time is the sum of its edges' times, ties break on node index, and a closed edge is never used. Test: `server/services/fieldOps/world/roads/routing.test.ts (new)`.
37. **AC9.37** Given a dispatched fire engine, then it passes `at_origin`, `en_route`, `arrived`, `deploying` and `working` in order; its arrival time is updated at least every 15 seconds; recalled, it returns to its origin. Test: `server/services/fieldOps/world/engine/units.test.ts (new)`.
38. **AC9.38** Given a unit arriving inside an incident site's blast exclusion radius, then its placed asset is created at the first point of its route outside it, the team gets a `unit_blocked` event with the block text, and otherwise the asset has the mapped `asset_type` and `properties.world_unit_id`; a casualty is assessable once a medical team's asset is within 80 m. Test: `pinBridge.test.ts`, "units as placed assets".
39. **AC9.39** Given a unit whose archetype's `zone_access` excludes `hot`, then a target inside the hot zone is refused with 422 `ACCESS_DENIED_ZONE`; given an unsafe area, then only a rescue crew within 6 m of shoring may enter it, and no unit enters a collapsed cell. Test: `units.test.ts`, "access".
40. **AC9.40** Given the dispatch route, then another team's unit is refused 403 `UNIT_NOT_YOURS`, a task outside the unit's tasks 422 `TASK_NOT_ALLOWED`, a target with no road or path within 300 m 422 `TARGET_NOT_REACHABLE`, more than 60 commands a minute 429 `COMMAND_RATE_LIMITED`, and a valid dispatch 202 with the predicted arrival. Test: `fieldOpsWorld.test.ts`, "dispatch".
41. **AC9.41** Given an AI agency's actor token, when it calls the dispatch route for its own team's unit, then the command is accepted as for a person. Test: `fieldOpsWorld.test.ts`, "AI actor".

**Slice 4: fog of war**

42. **AC9.42** Given observers of each type, then their ranges are those of section 6.10.1, halved inside smoke denser than 600 permille, cut by solid walls indoors, multiplied by the weather row's factor outdoors and by 0.6 at night without lighting. Test: `server/services/fieldOps/world/fog/visibility.test.ts (new)`.
43. **AC9.43** Given a team view, then it holds only cells, groups, plumes and pins inside the team's cover now, plus last-known entries with the tick they were seen, plus reports addressed to the team; shared units appear; the trainer's view holds everything; a spectator's view is the union of the team views. Test: `server/services/fieldOps/world/fog/views.test.ts (new)`.
44. **AC9.44** Given a fog session, when a participant calls `GET /api/sessions/:id/hazards` or `GET /api/sessions/:id/casualties`, then rows the caller's teams do not know are absent (the detail route answers 404), known rows not in view carry their last-known status and position and `world_last_seen_s`, and the trainer receives every row as today. Test: `server/services/fieldOps/world/bridge/fogFilter.test.ts (new)`.
45. **AC9.45** Given a fog session, when any service broadcasts `hazard.updated`, `casualty.created`, `casualty.updated` or `casualty.moved`, then the session room receives `{ refetch: 'hazards' }` or `{ refetch: 'casualties' }` and nothing else, and `MapView` refetches. Test: `fogFilter.test.ts`, "broadcast redaction"; `frontend/tests/worldLayerModel.test.ts (new)`, "refetch signal".
46. **AC9.46** Given 1,000 seeded random world states, then no team view or delta contains a cell, group, plume or pin outside the team's cover or knowledge, any device marker, or any key of WS7's `FORBIDDEN_KEYS`. Test: `views.test.ts`, "no hidden fact".
47. **AC9.47** Given an AI agency's actor, when it perceives through WS7's routes during a fog session, then the hazards and casualties it receives equal those of a person of the same team. Test: `fogFilter.test.ts`, "same fog for AI".

**Slice 5: weather and traffic**

48. **AC9.48** Given labels such as "afternoon thunderstorm", "heavy haze, PSI 180", "light drizzle" and "" with times 15:30 and 21:00, when `weatherFromLabel(label, when)` runs, then it returns the presets of section 5.12 with night visibility after sunset; a `WeatherSetting` outside the ranges of section 5.10 fails `weatherSettingSchema`. Test: `worldRules.test.ts`, "weather from the label".
49. **AC9.49** Given each weather condition, then outdoor spread, plume decay, observation range, road speed, walking speed and heat stress take the weather row's factors; a wind of 8 m/s biases fire spread in ventilated cells downwind and turns plumes. Test: `server/services/fieldOps/world/engine/weather.test.ts (new)`.
50. **AC9.50** Given a weekday at 08:00 and at 02:00, then the same route's time differs by the traffic profiles' factors for its road groups; given a closed road on the best route, then units re-route within 15 seconds; given 300 evacuees within 15 m of an edge, then that edge's speed drops to the jam factor; edges within 500 m of the site are slowed by the rubbernecking factor for the first 30 minutes. Test: `server/services/fieldOps/world/roads/traffic.test.ts (new)`.
51. **AC9.51** Given the trainer changes the weather mid-session with a 60-second transition, then wind and rain move linearly to the new values over 60 ticks and every team receives a `weather_changed` event. Test: `weather.test.ts`, "transition".

**The After-Action Review, logging and safety**

52. **AC9.52** Given a finished session with a world, when its trainer opens the After-Action Review, then the replay panel lists the world's events and shows the snapshot nearest a chosen minute; a participant sees only the events their teams could see. Test: `fieldOpsWorld.test.ts`, "replay"; manual step M9.
53. **AC9.53** Given a full run, then no log line of WS9 contains a device field, a hazard description or a report note, only ids, counts, kinds and durations. Test: `worldRuntime.test.ts`, "log hygiene".
54. **AC9.54** Given the source of `server/services/fieldOps/world/` and `server/routes/fieldOpsWorld.ts (new)`, then no file imports the chat client, `fetch` or a map service. Test: `server/services/fieldOps/world/staticChecks.test.ts (new)`.
55. **AC9.55** Given the seed files, then every text field passes `moderateDeviceText(text, { maxLength })`, every row has a `source_ref` and a `source_note`, and no row describes a device. Test: `spreadLibrary.test.ts`, "seed hygiene".

**Added with the reconciliation: session start under master 10.8 item 40, and WS4's hazard material**

56. **AC9.56** Given a new-flow session whose start copied a hazard with two fire-spread children (`properties.spawned_from` `environmental_timeline`), one still `delayed` and hidden at `appears_at_minutes` 1,000,000 with its minute in `spawn_condition.at_minutes`, as master 10.8 item 40's copy leaves it, and one revealed before a late world started, when the world runs past that minute, then `runHazardDeterioration` does not reveal the delayed child, even when its parent is not world-owned (the primary explosion hazard), and `GET /api/sessions/:id/hazards` does not return it; when the world then falls back, or the trainer stops it, then in the same transaction as the hand-back the delayed child keeps `status` `delayed` and `appears_at_minutes` 1,000,000 and gets `spawn_condition.trigger` `superseded_by_world` and `properties.world_superseded` true, while the revealed child is unchanged; and afterwards `runHazardDeterioration` reveals no child of that hazard and the list never returns the retired one. Test: `pinBridge.test.ts`, "hand-back retires the timeline's children"; `worldGates.test.ts`, "no reveal while the world runs".
57. **AC9.57** Given `CONTENTS_MATERIAL_OPTIONS` and the seed file `spread-materials.json`, then the constant's keys and labels equal those of the seed's `contents` rows, in the constant's order, and each key resolves to itself with `resolveMaterialKey(key, 'contents', library)`; given a scene hazard whose `material` is `fuel_flammable_liquid`, then `hazardEventsFor` gives its fire event that row's flame spread and smoke, and `buildWorldModel` gives the floor-0 cells within its radius that contents. Test: `spreadLibrary.test.ts`, "contents options parity"; `buildWorldModel.test.ts`, "hazard material".

## 5. Data model

### 5.1 Where everything lives (Proposed)

| Data | Where | Migration | Readers |
| --- | --- | --- | --- |
| Material, hazard, exposure and weather-effect rows; the review record; the change log | `fieldops_spread_materials`, `fieldops_spread_hazards`, `fieldops_spread_exposure`, `fieldops_spread_weather_effects`, `fieldops_spread_reviews`, `fieldops_spread_changes` | 249 | `loadSpreadLibrary` (WS5's compile, WS9's world, the admin routes) |
| The static world of one scenario revision | `fieldops_world_models` | 250 | The runtime; the replay route |
| One row per session with a world: settings, status, lease, clock; the hand-back | `fieldops_world_sessions` and five functions | 251 | The runtime; the world routes; the gates of section 6.12 |
| Commands, events and snapshots | `fieldops_world_commands`, `fieldops_world_events`, `fieldops_world_snapshots` | 252 | The runtime (replay, recovery); the replay route |
| Road speeds, cached road graphs, units | `fieldops_road_speed_classes`, `fieldops_road_graphs`, `fieldops_world_units` | 253 | The prepare job; the runtime; the world routes |
| What each team knows, and the reports teams share | `fieldops_world_knowledge`, `fieldops_world_reports` | 254 | The fog filter of section 6.10; the views |
| Weather presets and traffic profiles | `fieldops_weather_presets`, `fieldops_traffic_profiles` | 255 | `weatherFromLabel`, the console, routing |
| The structured weather of a draft and of a published scenario | `setup_v2.options.weather_setting` (WS2, request in section 15.3) and WS8's setup copy | none of WS9's | The world model |
| Unit positions as today's game sees them | `placed_assets` rows with `properties.world_unit_id` | existing (`migrations/124_placed_assets.sql`) | Today's checks and map |
| World fires, collapses and exposure casualties as today's game sees them | `scenario_hazards` and `scenario_casualties` rows of the session, with `properties.world_owned` or `conditions.spawned_from` | existing | Today's response layer |

Every WS9 table has row level security enabled with no policy, and its privileges are revoked from `PUBLIC`, `anon` and `authenticated`, as WS0 does for its job tables (`01-prerequisites.md` section 5.2): the world tables hold answer keys (device positions, hidden fires, what a team has not seen). Every function revokes `EXECUTE` from the same roles and grants it to `service_role`, as `migrations/193_payment_portal.sql:182-185` does for `consume_credit`. Every foreign key to `scenarios` or `sessions` cascades (master 10.8 item 21). The tables carrying `updated_at` use the existing `update_updated_at_column()` (`migrations/001_initial_schema.sql:333`). Apply 249 to 255 in order; 251 checks that 250 is present and 252 to 254 that 251 is. Number 256 stays unused in version 1.

### 5.2 Migration 249: `migrations/249_fieldops_spread_library.sql (new)`

```sql
-- Migration 249: the stored spread and deterioration library (D31; master 10.8 items 35 and 38).
-- WS9, docs/field-ops/11-living-world.md section 5.2.
--
-- Additive and idempotent. loadSpreadLibrary answers null until these tables hold a complete active
-- library (W1), so applying the file changes no running behaviour: WS5 compiles without fire-spread
-- pins and with an empty facts block until an admin seeds the tables from the reviewed seed files.
-- Only the service role reads or writes them: row level security is on with no policy, and the
-- table privileges of PUBLIC, anon and authenticated are revoked.
--
-- Rollback, tried on a branch database only, never on the shared project (WS5 then degrades as above;
-- the world refuses to start):
--   DROP TABLE IF EXISTS public.fieldops_spread_changes;
--   DROP TABLE IF EXISTS public.fieldops_spread_reviews;
--   DROP TABLE IF EXISTS public.fieldops_spread_weather_effects;
--   DROP TABLE IF EXISTS public.fieldops_spread_exposure;
--   DROP TABLE IF EXISTS public.fieldops_spread_hazards;
--   DROP TABLE IF EXISTS public.fieldops_spread_materials;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_spread_materials (
  material_key TEXT PRIMARY KEY CHECK (material_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  material_role TEXT NOT NULL CHECK (material_role IN ('wall', 'contents', 'structure')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  aliases TEXT[] NOT NULL DEFAULT '{}',
  combustible BOOLEAN NOT NULL DEFAULT false,
  flame_spread_m_min NUMERIC(6, 3) CHECK (flame_spread_m_min IS NULL OR flame_spread_m_min BETWEEN 0.01 AND 30),
  burn_duration_s INTEGER CHECK (burn_duration_s IS NULL OR burn_duration_s BETWEEN 10 AND 14400),
  extinguish_s INTEGER CHECK (extinguish_s IS NULL OR extinguish_s BETWEEN 5 AND 3600),
  smoke_yield TEXT NOT NULL DEFAULT 'none'
    CHECK (smoke_yield IN ('none', 'light', 'moderate', 'heavy', 'toxic')),
  heat_release TEXT NOT NULL DEFAULT 'none'
    CHECK (heat_release IN ('none', 'slow', 'medium', 'fast', 'ultra_fast')),
  burn_through_s INTEGER CHECK (burn_through_s IS NULL OR burn_through_s BETWEEN 10 AND 86400),
  smoke_leak NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (smoke_leak BETWEEN 0 AND 1),
  gas_leak NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (gas_leak BETWEEN 0 AND 1),
  glazed BOOLEAN NOT NULL DEFAULT false,
  fire_resistance_min INTEGER CHECK (fire_resistance_min IS NULL OR fire_resistance_min BETWEEN 5 AND 480),
  creep_per_min NUMERIC(6, 2) CHECK (creep_per_min IS NULL OR creep_per_min BETWEEN 0 AND 100),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_materials_contents CHECK (
    material_role <> 'contents'
    OR (flame_spread_m_min IS NOT NULL AND burn_duration_s IS NOT NULL AND extinguish_s IS NOT NULL)
  ),
  CONSTRAINT fieldops_spread_materials_structure CHECK (
    material_role <> 'structure' OR (fire_resistance_min IS NOT NULL AND creep_per_min IS NOT NULL)
  ),
  CONSTRAINT fieldops_spread_materials_glazed CHECK (glazed = false OR material_role = 'wall')
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_hazards (
  hazard_type TEXT PRIMARY KEY CHECK (hazard_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  trigger_on TEXT NOT NULL CHECK (trigger_on IN ('blast', 'ignition', 'none')),
  event_type TEXT CHECK (event_type IS NULL OR event_type IN ('ignite', 'rupture', 'collapse', 'arc')),
  spread_kind TEXT CHECK (spread_kind IS NULL OR spread_kind IN ('fire', 'gas', 'structural_zone')),
  delay_s INTEGER NOT NULL DEFAULT 0 CHECK (delay_s BETWEEN 0 AND 3600),
  radius_low_m NUMERIC(6, 2) NOT NULL CHECK (radius_low_m BETWEEN 0.5 AND 100),
  radius_medium_m NUMERIC(6, 2) NOT NULL CHECK (radius_medium_m BETWEEN 0.5 AND 100),
  radius_high_m NUMERIC(6, 2) NOT NULL CHECK (radius_high_m BETWEEN 0.5 AND 100),
  spread_rate_m_min NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (spread_rate_m_min BETWEEN 0 AND 60),
  max_radius_m NUMERIC(6, 2) NOT NULL CHECK (max_radius_m BETWEEN 0.5 AND 200),
  acceleration NUMERIC(5, 2) NOT NULL DEFAULT 1 CHECK (acceleration BETWEEN 0 AND 10),
  contents_key TEXT REFERENCES public.fieldops_spread_materials(material_key) ON UPDATE CASCADE,
  smoke_yield TEXT NOT NULL DEFAULT 'none'
    CHECK (smoke_yield IN ('none', 'light', 'moderate', 'heavy', 'toxic')),
  gas_agent TEXT CHECK (gas_agent IS NULL OR gas_agent IN ('toxic_gas', 'irritant_gas')),
  gas_source_rate INTEGER CHECK (gas_source_rate IS NULL OR gas_source_rate BETWEEN 1 AND 1000),
  gas_duration_s INTEGER CHECK (gas_duration_s IS NULL OR gas_duration_s BETWEEN 10 AND 14400),
  event_text TEXT NOT NULL CHECK (char_length(event_text) BETWEEN 3 AND 200),
  fact_dispersion TEXT NOT NULL CHECK (char_length(fact_dispersion) BETWEEN 3 AND 300),
  fact_structural TEXT NOT NULL CHECK (char_length(fact_structural) BETWEEN 3 AND 300),
  interactions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(interactions) = 'array'),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_hazards_radii CHECK (
    radius_low_m <= radius_medium_m AND radius_medium_m <= radius_high_m AND radius_high_m <= max_radius_m
  ),
  CONSTRAINT fieldops_spread_hazards_gas CHECK (
    (gas_agent IS NULL) = (gas_source_rate IS NULL) AND (gas_agent IS NULL) = (gas_duration_s IS NULL)
  ),
  CONSTRAINT fieldops_spread_hazards_event CHECK (spread_kind IS NULL OR event_type IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_exposure (
  agent TEXT PRIMARY KEY CHECK (agent IN ('smoke', 'toxic_gas', 'irritant_gas', 'heat', 'heat_stress', 'collapse')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  incapacitation_bands JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(incapacitation_bands) = 'array'),
  light_at NUMERIC(6, 3) NOT NULL CHECK (light_at > 0),
  serious_at NUMERIC(6, 3) NOT NULL,
  fatal_at NUMERIC(6, 3) NOT NULL,
  share_light INTEGER NOT NULL CHECK (share_light BETWEEN 0 AND 1000),
  share_serious INTEGER NOT NULL CHECK (share_serious BETWEEN 0 AND 1000),
  share_fatal INTEGER NOT NULL CHECK (share_fatal BETWEEN 0 AND 1000),
  share_trapped INTEGER NOT NULL DEFAULT 0 CHECK (share_trapped BETWEEN 0 AND 1000),
  patient_note TEXT NOT NULL CHECK (char_length(patient_note) BETWEEN 3 AND 300),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_exposure_order CHECK (light_at < serious_at AND serious_at < fatal_at),
  CONSTRAINT fieldops_spread_exposure_shares CHECK (
    share_light + share_serious + share_fatal + share_trapped <= 1000
  )
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_weather_effects (
  weather_condition TEXT PRIMARY KEY
    CHECK (weather_condition IN ('clear', 'cloudy', 'light_rain', 'heavy_rain', 'thunderstorm', 'haze')),
  outdoor_spread NUMERIC(4, 3) NOT NULL CHECK (outdoor_spread BETWEEN 0 AND 2),
  plume_decay NUMERIC(4, 3) NOT NULL CHECK (plume_decay BETWEEN 0.1 AND 5),
  observation NUMERIC(4, 3) NOT NULL CHECK (observation BETWEEN 0.1 AND 1),
  road_speed NUMERIC(4, 3) NOT NULL CHECK (road_speed BETWEEN 0.1 AND 1),
  walking_speed NUMERIC(4, 3) NOT NULL CHECK (walking_speed BETWEEN 0.1 AND 1),
  day_stability TEXT NOT NULL CHECK (day_stability IN ('unstable', 'neutral', 'stable')),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 3 AND 40),
  dataset_version TEXT NOT NULL CHECK (dataset_version ~ '^[0-9a-f]{16}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'revoked')),
  reviewer_name TEXT NOT NULL CHECK (char_length(reviewer_name) BETWEEN 2 AND 120),
  reviewer_qualification TEXT NOT NULL CHECK (char_length(reviewer_qualification) BETWEEN 2 AND 300),
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'object'),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 4000),
  library_snapshot JSONB NOT NULL CHECK (jsonb_typeof(library_snapshot) = 'object'),
  recorded_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  supersedes UUID REFERENCES public.fieldops_spread_reviews(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL CHECK (table_name IN ('materials', 'hazards', 'exposure', 'weather_effects', 'road_speeds', 'traffic', 'weather_presets')),
  row_key TEXT NOT NULL CHECK (char_length(row_key) BETWEEN 1 AND 120),
  action TEXT NOT NULL CHECK (action IN ('seed', 'create', 'update', 'retire')),
  row_before JSONB,
  row_after JSONB,
  dataset_version_before TEXT CHECK (dataset_version_before IS NULL OR dataset_version_before ~ '^[0-9a-f]{16}$'),
  dataset_version_after TEXT CHECK (dataset_version_after IS NULL OR dataset_version_after ~ '^[0-9a-f]{16}$'),
  changed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fieldops_spread_materials_role
  ON public.fieldops_spread_materials (material_role) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fieldops_spread_reviews_versions
  ON public.fieldops_spread_reviews (model_version, dataset_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fieldops_spread_changes_created
  ON public.fieldops_spread_changes (created_at DESC);

DROP TRIGGER IF EXISTS trg_fieldops_spread_materials_updated_at ON public.fieldops_spread_materials;
CREATE TRIGGER trg_fieldops_spread_materials_updated_at
  BEFORE UPDATE ON public.fieldops_spread_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_hazards_updated_at ON public.fieldops_spread_hazards;
CREATE TRIGGER trg_fieldops_spread_hazards_updated_at
  BEFORE UPDATE ON public.fieldops_spread_hazards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_exposure_updated_at ON public.fieldops_spread_exposure;
CREATE TRIGGER trg_fieldops_spread_exposure_updated_at
  BEFORE UPDATE ON public.fieldops_spread_exposure
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_weather_updated_at ON public.fieldops_spread_weather_effects;
CREATE TRIGGER trg_fieldops_spread_weather_updated_at
  BEFORE UPDATE ON public.fieldops_spread_weather_effects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_spread_materials IS
  'WS9 spread library (D31): how walls, contents and structural frames behave in fire. Seeded from reviewed files with a source per row; edits make the dataset Unreviewed. Service role only.';
COMMENT ON COLUMN public.fieldops_spread_materials.burn_through_s IS
  'Walls: seconds of fire on one side before the wall is breached. NULL means it holds for any session length.';
COMMENT ON TABLE public.fieldops_spread_hazards IS
  'WS9: how each scene hazard type reacts and grows. hazardEventsFor turns a row into today''s HazardEvent shape; deteriorationFactsFor quotes its fact lines.';
COMMENT ON TABLE public.fieldops_spread_exposure IS
  'WS9: exposure doses (fractional effective dose bands) and the share of a crowd group hurt at each threshold, per agent.';
COMMENT ON TABLE public.fieldops_spread_weather_effects IS
  'WS9: multipliers each weather condition applies to outdoor spread, plumes, observation, road and walking speed.';
COMMENT ON TABLE public.fieldops_spread_reviews IS
  'WS9 review record, modelled on WS6''s physics reviews. The latest row for a (model_version, dataset_version) decides the review state.';
COMMENT ON TABLE public.fieldops_spread_changes IS
  'WS9: every seed, edit and retirement of a stored row, with the dataset version before and after.';

ALTER TABLE public.fieldops_spread_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_hazards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_weather_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_spread_materials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_hazards FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_exposure FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_weather_effects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_changes FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.3 Migration 250: `migrations/250_fieldops_world_models.sql (new)`

```sql
-- Migration 250: the static world model of a compiled scenario revision (D36; master 10.8 item 39).
-- WS9, docs/field-ops/11-living-world.md section 5.3.
--
-- One row per scenario and inputs hash, written by the fieldops_world_prepare job and reused by every
-- session of that revision. The model holds answer-key data (device positions and radii, hidden
-- hazards), so only the service role reaches it. Additive and idempotent; unread until a world runs.
-- road_graph_id points at fieldops_road_graphs (migration 253) without a foreign key, so this file
-- applies on its own.
--
-- Rollback, tried on a branch database only, never on the shared project (sessions then run without a world):
--   DROP TABLE IF EXISTS public.fieldops_world_models;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_world_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  revision_no INTEGER CHECK (revision_no IS NULL OR revision_no >= 0),
  inputs_hash TEXT NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 3 AND 40),
  dataset_version TEXT NOT NULL CHECK (dataset_version ~ '^[0-9a-f]{16}$'),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  cell_m SMALLINT CHECK (cell_m IS NULL OR cell_m IN (3, 4, 5)),
  cell_count INTEGER NOT NULL DEFAULT 0 CHECK (cell_count BETWEEN 0 AND 20000),
  floors SMALLINT[] NOT NULL DEFAULT '{0}',
  road_graph_id UUID,
  model JSONB NOT NULL CHECK (jsonb_typeof(model) = 'object' AND octet_length(model::text) <= 16777216),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  built_by_job UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_world_models_unique UNIQUE (scenario_id, inputs_hash),
  CONSTRAINT fieldops_world_models_failed CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_models_scenario
  ON public.fieldops_world_models (scenario_id, created_at DESC);

COMMENT ON TABLE public.fieldops_world_models IS
  'WS9: the starting world of one compiled scenario revision: grid, walls, compartments, exits, stairwells, hazards, devices with WS6 radii, crowd groups, origins, weather and time. Answer-key data; service role only.';
COMMENT ON COLUMN public.fieldops_world_models.inputs_hash IS
  'SHA-256 hex of the canonical JSON of every input (scene revision, setup copy, physics snapshot, site data version, library dataset version, model version).';

ALTER TABLE public.fieldops_world_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_world_models FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.4 Migration 251: `migrations/251_fieldops_world_sessions.sql (new)`

The lease follows WS0's job lease (`01-prerequisites.md` section 6.10): a worker id per process, a scope that keeps a development server off production rows, a heartbeat that answers `lost` to anyone but the holder, and a release at shutdown.

```sql
-- Migration 251: one live world per session, its settings, status, clock and lease (D32; item 39).
-- WS9, docs/field-ops/11-living-world.md section 5.4.
--
-- Requires 250. Additive and idempotent. Rows are created by the world runtime for sessions of
-- world-eligible scenarios, or by the lobby card before the start; nothing else reads them, so
-- applying the file changes no running behaviour. Service role only.
--
-- Rollback, tried on a branch database only, never on the shared project (there, first set
-- FIELDOPS_WORLD_MAX_SESSIONS=0 and restart, so no world runs):
--   DROP FUNCTION IF EXISTS public.fieldops_world_hand_back(UUID);
--   DROP FUNCTION IF EXISTS public.fieldops_world_release(UUID);
--   DROP FUNCTION IF EXISTS public.fieldops_world_finish(UUID, UUID, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.fieldops_world_heartbeat(UUID, UUID, INTEGER, INTEGER, TEXT, SMALLINT, INTEGER);
--   DROP FUNCTION IF EXISTS public.fieldops_world_claim(UUID, UUID, TEXT, INTEGER);
--   DROP TABLE IF EXISTS public.fieldops_world_sessions;
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_world_models') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/250_fieldops_world_models.sql before 251_fieldops_world_sessions.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fieldops_world_sessions (
  session_id UUID PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'preparing', 'ready', 'running', 'paused', 'fallback', 'stopped', 'failed')),
  status_reason TEXT CHECK (status_reason IS NULL OR status_reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 32768),
  model_id UUID REFERENCES public.fieldops_world_models(id) ON DELETE SET NULL,
  prepare_job_id UUID,
  seed BIGINT NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  tick INTEGER NOT NULL DEFAULT 0 CHECK (tick >= 0),
  trainer_paused BOOLEAN NOT NULL DEFAULT false,
  degrade_level SMALLINT NOT NULL DEFAULT 0 CHECK (degrade_level BETWEEN 0 AND 2),
  lag_ms INTEGER NOT NULL DEFAULT 0 CHECK (lag_ms >= 0),
  unreviewed BOOLEAN NOT NULL DEFAULT true,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  stop_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  last_snapshot_tick INTEGER CHECK (last_snapshot_tick IS NULL OR last_snapshot_tick >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_world_sessions_running_owner CHECK (status <> 'running' OR lease_owner IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_sessions_claim
  ON public.fieldops_world_sessions (scope, status)
  WHERE status IN ('ready', 'running', 'paused');
CREATE INDEX IF NOT EXISTS idx_fieldops_world_sessions_scenario
  ON public.fieldops_world_sessions (scenario_id);

DROP TRIGGER IF EXISTS trg_fieldops_world_sessions_updated_at ON public.fieldops_world_sessions;
CREATE TRIGGER trg_fieldops_world_sessions_updated_at
  BEFORE UPDATE ON public.fieldops_world_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Claim or renew the lease of one session's world. True when the caller holds it afterwards.
CREATE OR REPLACE FUNCTION public.fieldops_world_claim(
  p_session_id UUID,
  p_worker UUID,
  p_scope TEXT,
  p_lease_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.fieldops_world_sessions%ROWTYPE;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'fieldops_world_claim: lease seconds out of range %', p_lease_seconds;
  END IF;
  SELECT * INTO v_row FROM public.fieldops_world_sessions WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_row.scope <> p_scope OR v_row.status NOT IN ('ready', 'running', 'paused') THEN
    RETURN false;
  END IF;
  IF v_row.lease_owner IS NOT NULL
     AND v_row.lease_owner <> p_worker
     AND v_row.lease_expires_at IS NOT NULL
     AND v_row.lease_expires_at > now() THEN
    RETURN false;
  END IF;
  UPDATE public.fieldops_world_sessions
     SET lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         started_at = COALESCE(started_at, now())
   WHERE session_id = p_session_id;
  RETURN true;
END;
$$;

-- Extend the lease and record the clock. Returns ok, stop_requested or lost.
CREATE OR REPLACE FUNCTION public.fieldops_world_heartbeat(
  p_session_id UUID,
  p_worker UUID,
  p_lease_seconds INTEGER,
  p_tick INTEGER,
  p_status TEXT,
  p_degrade_level SMALLINT,
  p_lag_ms INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.fieldops_world_sessions%ROWTYPE;
BEGIN
  IF p_status NOT IN ('running', 'paused') THEN
    RAISE EXCEPTION 'fieldops_world_heartbeat: unknown status %', p_status;
  END IF;
  SELECT * INTO v_row FROM public.fieldops_world_sessions WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_row.lease_owner IS DISTINCT FROM p_worker THEN
    RETURN 'lost';
  END IF;
  UPDATE public.fieldops_world_sessions
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         tick = GREATEST(tick, COALESCE(p_tick, 0)),
         status = p_status,
         degrade_level = LEAST(2, GREATEST(0, COALESCE(p_degrade_level, 0))),
         lag_ms = GREATEST(0, COALESCE(p_lag_ms, 0))
   WHERE session_id = p_session_id;
  IF v_row.stop_requested_at IS NOT NULL THEN
    RETURN 'stop_requested';
  END IF;
  RETURN 'ok';
END;
$$;

-- The holder ends its world: fallback, stopped or failed, with a reason code. Returns ok or lost.
CREATE OR REPLACE FUNCTION public.fieldops_world_finish(
  p_session_id UUID,
  p_worker UUID,
  p_status TEXT,
  p_reason TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('fallback', 'stopped', 'failed') THEN
    RAISE EXCEPTION 'fieldops_world_finish: unknown status %', p_status;
  END IF;
  UPDATE public.fieldops_world_sessions
     SET status = p_status,
         status_reason = p_reason,
         lease_owner = NULL,
         lease_expires_at = NULL
   WHERE session_id = p_session_id AND lease_owner = p_worker;
  IF NOT FOUND THEN
    RETURN 'lost';
  END IF;
  RETURN 'ok';
END;
$$;

-- At shutdown: let every lease of this worker lapse now, so the next claim can take it at once.
CREATE OR REPLACE FUNCTION public.fieldops_world_release(p_worker UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.fieldops_world_sessions w
     SET lease_expires_at = now()
   WHERE w.lease_owner = p_worker;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- At a fallback, a trainer stop or NO_CAPACITY: hand the world's hazards back to today's engines and,
-- in the same transaction, retire the compiled fire-spread children that are still delayed, so today's
-- deterioration never reveals them on top of the world's fires (section 6.12.3). Returns both counts.
CREATE OR REPLACE FUNCTION public.fieldops_world_hand_back(p_session_id UUID)
RETURNS TABLE (handed_back INTEGER, superseded INTEGER)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_handed INTEGER;
  v_superseded INTEGER;
BEGIN
  UPDATE public.scenario_hazards h
     SET properties = h.properties || jsonb_build_object('world_owned', false, 'world_handed_back', true)
   WHERE h.session_id = p_session_id
     AND h.properties ->> 'world_owned' = 'true';
  GET DIAGNOSTICS v_handed = ROW_COUNT;

  UPDATE public.scenario_hazards h
     SET spawn_condition = COALESCE(h.spawn_condition, '{}'::jsonb)
                           || jsonb_build_object('trigger', 'superseded_by_world'),
         properties = h.properties || jsonb_build_object('world_superseded', true),
         appears_at_minutes = 1000000
   WHERE h.session_id = p_session_id
     AND h.status = 'delayed'
     AND h.properties ->> 'spawned_from' = 'environmental_timeline';
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  handed_back := v_handed;
  superseded := v_superseded;
  RETURN NEXT;
END;
$$;

COMMENT ON TABLE public.fieldops_world_sessions IS
  'WS9: the live world of one session: settings from the lobby, status, the world clock (tick), back-pressure level and the per-session lease. Service role only.';
COMMENT ON COLUMN public.fieldops_world_sessions.scope IS
  'WS0 job scope of the process that created the row (production or local:<hostname>); only a runtime of the same scope claims it.';

ALTER TABLE public.fieldops_world_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_world_sessions FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fieldops_world_claim(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_world_heartbeat(UUID, UUID, INTEGER, INTEGER, TEXT, SMALLINT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_world_finish(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_world_release(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_world_hand_back(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_world_claim(UUID, UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_world_heartbeat(UUID, UUID, INTEGER, INTEGER, TEXT, SMALLINT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_world_finish(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_world_release(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_world_hand_back(UUID) TO service_role;

COMMIT;
```

### 5.5 Migration 252: `migrations/252_fieldops_world_log.sql (new)`

```sql
-- Migration 252: commands, the append-only event log and the snapshots of a live world (item 39).
-- WS9, docs/field-ops/11-living-world.md section 5.5.
--
-- Requires 251. Additive and idempotent. Commands are written by the world routes and applied by
-- the lease holder at tick boundaries; events are appended in batches and never updated; snapshots
-- hold the whole engine state once a minute for recovery and the After-Action Review. Service role only.
--
-- Rollback, tried on a branch database only, never on the shared project (world sessions then fall back
-- at their next tick):
--   DROP TABLE IF EXISTS public.fieldops_world_snapshots;
--   DROP TABLE IF EXISTS public.fieldops_world_events;
--   DROP TABLE IF EXISTS public.fieldops_world_commands;
--   DROP FUNCTION IF EXISTS public.fieldops_world_events_append_only();
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_world_sessions') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/251_fieldops_world_sessions.sql before 252_fieldops_world_log.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fieldops_world_commands (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  issued_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  issuer_role TEXT NOT NULL CHECK (issuer_role IN ('participant', 'trainer', 'system')),
  team_name TEXT CHECK (team_name IS NULL OR char_length(team_name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applied', 'rejected')),
  apply_tick INTEGER CHECK (apply_tick IS NULL OR apply_tick >= 0),
  result JSONB CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  CONSTRAINT fieldops_world_commands_tick CHECK ((status = 'queued') = (apply_tick IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_commands_queued
  ON public.fieldops_world_commands (session_id, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_fieldops_world_commands_replay
  ON public.fieldops_world_commands (session_id, apply_tick, id) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_fieldops_world_commands_rate
  ON public.fieldops_world_commands (session_id, issued_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fieldops_world_events (
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,47}$'),
  audience TEXT NOT NULL DEFAULT 'positional' CHECK (audience IN ('public', 'positional', 'teams', 'trainer')),
  teams TEXT[] NOT NULL DEFAULT '{}',
  lat DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  floor SMALLINT CHECK (floor IS NULL OR floor BETWEEN -1 AND 2),
  data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_events_tick
  ON public.fieldops_world_events (session_id, tick);

-- The log is append-only: an update is refused. Deletes come only from the session cascade and the
-- retention sweep of section 6.11.
CREATE OR REPLACE FUNCTION public.fieldops_world_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'fieldops_world_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_fieldops_world_events_append_only ON public.fieldops_world_events;
CREATE TRIGGER trg_fieldops_world_events_append_only
  BEFORE UPDATE ON public.fieldops_world_events
  FOR EACH ROW EXECUTE FUNCTION public.fieldops_world_events_append_only();

CREATE TABLE IF NOT EXISTS public.fieldops_world_snapshots (
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  tick INTEGER NOT NULL CHECK (tick >= 0),
  state_hash TEXT NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  last_command_id BIGINT NOT NULL DEFAULT 0 CHECK (last_command_id >= 0),
  engine_version TEXT NOT NULL CHECK (char_length(engine_version) BETWEEN 3 AND 40),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object' AND octet_length(state::text) <= 8388608),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tick)
);

COMMENT ON TABLE public.fieldops_world_commands IS
  'WS9: team, trainer and system commands for a live world, applied by the lease holder at tick boundaries in (apply_tick, id) order. Replayed after a restart.';
COMMENT ON TABLE public.fieldops_world_events IS
  'WS9: append-only log of world events (ignitions, collapses, dispatches, arrivals, exposures, weather and road changes) for deltas, recovery and the After-Action Review.';
COMMENT ON TABLE public.fieldops_world_snapshots IS
  'WS9: the whole engine state at a tick, with its SHA-256 state hash. Kept every minute while live; thinned to one in five after the session ends.';

ALTER TABLE public.fieldops_world_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_world_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_world_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_world_commands FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_world_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_world_snapshots FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_world_events_append_only() FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.6 Migration 253: `migrations/253_fieldops_world_units.sql (new)`

```sql
-- Migration 253: road speed classes, cached road graphs and the units of a live world (D33).
-- WS9, docs/field-ops/11-living-world.md section 5.6.
--
-- Requires 251. Additive and idempotent. The road graph is built once per road box and saved-data
-- version from osm_sg_roads (migrations/193_singapore_local_osm_cache.sql) and shared by every
-- scenario whose box matches; it holds only public map data. Units are per session. Service role only.
--
-- Rollback, tried on a branch database only, never on the shared project (worlds then run without units):
--   DROP TABLE IF EXISTS public.fieldops_world_units;
--   DROP TABLE IF EXISTS public.fieldops_road_graphs;
--   DROP TABLE IF EXISTS public.fieldops_road_speed_classes;
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_world_sessions') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/251_fieldops_world_sessions.sql before 253_fieldops_world_units.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fieldops_road_speed_classes (
  highway_type TEXT PRIMARY KEY CHECK (highway_type IN (
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
    'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'service', 'living_street'
  )),
  road_group TEXT NOT NULL CHECK (road_group IN ('expressway', 'arterial', 'collector', 'local')),
  free_flow_kph NUMERIC(5, 1) NOT NULL CHECK (free_flow_kph BETWEEN 5 AND 120),
  emergency_factor NUMERIC(4, 3) NOT NULL DEFAULT 1 CHECK (emergency_factor BETWEEN 0.5 AND 1.5),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_road_graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  area_key TEXT NOT NULL CHECK (area_key ~ '^[a-z0-9:._-]{8,160}$'),
  data_version TEXT NOT NULL DEFAULT 'none' CHECK (char_length(data_version) BETWEEN 1 AND 80),
  graph_version TEXT NOT NULL CHECK (char_length(graph_version) BETWEEN 3 AND 40),
  bbox JSONB NOT NULL CHECK (jsonb_typeof(bbox) = 'object'),
  node_count INTEGER NOT NULL CHECK (node_count BETWEEN 0 AND 200000),
  edge_count INTEGER NOT NULL CHECK (edge_count BETWEEN 0 AND 400000),
  graph JSONB NOT NULL CHECK (jsonb_typeof(graph) = 'object' AND octet_length(graph::text) <= 25165824),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_road_graphs_unique UNIQUE (area_key, data_version, graph_version)
);

CREATE TABLE IF NOT EXISTS public.fieldops_world_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL CHECK (unit_key ~ '^u[0-9]{1,3}$'),
  team_name TEXT NOT NULL CHECK (char_length(team_name) BETWEEN 1 AND 100),
  archetype_key TEXT CHECK (archetype_key IS NULL OR archetype_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind TEXT NOT NULL CHECK (kind IN (
    'fire_engine', 'rescue_tender', 'hazmat_unit', 'ambulance', 'medical_team', 'patrol_car', 'cordon_team',
    'marshal_team', 'venue_staff', 'eod_team', 'command_unit', 'investigation_team', 'utility_crew',
    'transport_supervisor'
  )),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN (
    'at_origin', 'turning_out', 'en_route', 'arrived', 'deploying', 'working', 'returning', 'blocked', 'out_of_action'
  )),
  task TEXT CHECK (task IS NULL OR task ~ '^[a-z][a-z_]{1,31}$'),
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  floor SMALLINT NOT NULL DEFAULT 0 CHECK (floor BETWEEN -1 AND 2),
  origin JSONB NOT NULL CHECK (jsonb_typeof(origin) = 'object'),
  eta_tick INTEGER CHECK (eta_tick IS NULL OR eta_tick >= 0),
  placed_asset_id UUID REFERENCES public.placed_assets(id) ON DELETE SET NULL,
  updated_tick INTEGER NOT NULL DEFAULT 0 CHECK (updated_tick >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_world_units_key UNIQUE (session_id, unit_key)
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_units_team
  ON public.fieldops_world_units (session_id, team_name);

DROP TRIGGER IF EXISTS trg_fieldops_road_speed_classes_updated_at ON public.fieldops_road_speed_classes;
CREATE TRIGGER trg_fieldops_road_speed_classes_updated_at
  BEFORE UPDATE ON public.fieldops_road_speed_classes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_world_units_updated_at ON public.fieldops_world_units;
CREATE TRIGGER trg_fieldops_world_units_updated_at
  BEFORE UPDATE ON public.fieldops_world_units
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_road_speed_classes IS
  'WS9: free-flow speed and road group per saved highway type (the 14 of scripts/generate_singapore_local_osm.mjs). Seeded with a source per row.';
COMMENT ON TABLE public.fieldops_road_graphs IS
  'WS9: a routable graph of the saved roads inside one box, encoded as base64 integer arrays, cached per saved-data version.';
COMMENT ON TABLE public.fieldops_world_units IS
  'WS9: the units of a live world as last persisted (every state change and at most every 5 seconds while moving).';

ALTER TABLE public.fieldops_road_speed_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_road_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_world_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_road_speed_classes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_road_graphs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_world_units FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.7 Migration 254: `migrations/254_fieldops_world_visibility.sql (new)`

```sql
-- Migration 254: what each team of a live world knows, and the reports teams share (D34).
-- WS9, docs/field-ops/11-living-world.md section 5.7.
--
-- Requires 251. Additive and idempotent. The lease holder keeps knowledge in memory and upserts the
-- changed entries every 10 seconds; the fog filter of today's hazard and casualty routes reads them
-- when the process serving a request does not hold the world. Service role only.
--
-- Rollback, tried on a branch database only, never on the shared project (worlds then run with fog of
-- war off):
--   DROP TABLE IF EXISTS public.fieldops_world_reports;
--   DROP TABLE IF EXISTS public.fieldops_world_knowledge;
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_world_sessions') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/251_fieldops_world_sessions.sql before 254_fieldops_world_visibility.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fieldops_world_knowledge (
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  team_name TEXT NOT NULL CHECK (char_length(team_name) BETWEEN 1 AND 100),
  entity_key TEXT NOT NULL CHECK (entity_key ~ '^[a-z_]{3,20}:[A-Za-z0-9_.:-]{1,120}$'),
  entity_kind TEXT NOT NULL CHECK (entity_kind IN (
    'hazard', 'casualty', 'crowd', 'plume', 'compartment', 'fire_region', 'unit', 'road'
  )),
  source TEXT NOT NULL CHECK (source IN ('observed', 'reported', 'shared')),
  first_seen_tick INTEGER NOT NULL CHECK (first_seen_tick >= 0),
  last_seen_tick INTEGER NOT NULL CHECK (last_seen_tick >= 0),
  last_lat DOUBLE PRECISION CHECK (last_lat IS NULL OR last_lat BETWEEN -90 AND 90),
  last_lng DOUBLE PRECISION CHECK (last_lng IS NULL OR last_lng BETWEEN -180 AND 180),
  last_status TEXT CHECK (last_status IS NULL OR char_length(last_status) <= 40),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 2048),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, team_name, entity_key),
  CONSTRAINT fieldops_world_knowledge_ticks CHECK (last_seen_tick >= first_seen_tick)
);

CREATE TABLE IF NOT EXISTS public.fieldops_world_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.fieldops_world_sessions(session_id) ON DELETE CASCADE,
  from_team TEXT NOT NULL CHECK (char_length(from_team) BETWEEN 1 AND 100),
  to_teams TEXT[] NOT NULL DEFAULT '{}',
  entity_key TEXT NOT NULL CHECK (entity_key ~ '^[a-z_]{3,20}:[A-Za-z0-9_.:-]{1,120}$'),
  tick INTEGER NOT NULL CHECK (tick >= 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  sent_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fieldops_world_reports_session
  ON public.fieldops_world_reports (session_id, tick);

COMMENT ON TABLE public.fieldops_world_knowledge IS
  'WS9: per team, every world entity it has observed, been told about or shares, with the last position and status it saw. Read by the fog filter.';
COMMENT ON COLUMN public.fieldops_world_reports.to_teams IS
  'Team names the report is addressed to; an empty array means every team of the session.';

ALTER TABLE public.fieldops_world_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_world_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_world_knowledge FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_world_reports FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.8 Migration 255: `migrations/255_fieldops_weather_traffic.sql (new)`

```sql
-- Migration 255: weather presets and stored traffic profiles (D35; D5: no live feed).
-- WS9, docs/field-ops/11-living-world.md section 5.8.
--
-- Additive and idempotent; independent of 250 to 254. Seeded from reviewed files with a source per
-- row. Without this file the world uses its built-in presets and free-flow road speeds.
--
-- Rollback, tried on a branch database only, never on the shared project:
--   DROP TABLE IF EXISTS public.fieldops_traffic_profiles;
--   DROP TABLE IF EXISTS public.fieldops_weather_presets;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_weather_presets (
  preset_key TEXT PRIMARY KEY CHECK (preset_key ~ '^[a-z][a-z0-9_]{2,47}$'),
  region TEXT NOT NULL DEFAULT 'SG' CHECK (region ~ '^[A-Z]{2}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  setting JSONB NOT NULL CHECK (jsonb_typeof(setting) = 'object'),
  label_keywords TEXT[] NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 100,
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_traffic_profiles (
  region TEXT NOT NULL CHECK (region ~ '^[A-Z]{2}$'),
  road_group TEXT NOT NULL CHECK (road_group IN ('expressway', 'arterial', 'collector', 'local')),
  day_type TEXT NOT NULL CHECK (day_type IN ('weekday', 'weekend')),
  hour_of_day SMALLINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  speed_factor NUMERIC(4, 3) NOT NULL CHECK (speed_factor BETWEEN 0.1 AND 1),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (region, road_group, day_type, hour_of_day)
);

DROP TRIGGER IF EXISTS trg_fieldops_weather_presets_updated_at ON public.fieldops_weather_presets;
CREATE TRIGGER trg_fieldops_weather_presets_updated_at
  BEFORE UPDATE ON public.fieldops_weather_presets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_traffic_profiles_updated_at ON public.fieldops_traffic_profiles;
CREATE TRIGGER trg_fieldops_traffic_profiles_updated_at
  BEFORE UPDATE ON public.fieldops_traffic_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_weather_presets IS
  'WS9: named WeatherSetting presets per region (Singapore first), with the label words that select them.';
COMMENT ON TABLE public.fieldops_traffic_profiles IS
  'WS9: stored congestion as a share of free-flow speed, per road group, day type and hour. Never fetched live (D5).';

ALTER TABLE public.fieldops_weather_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_traffic_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_weather_presets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_traffic_profiles FROM PUBLIC, anon, authenticated;

COMMIT;
```

### 5.9 Migration 256

Not used in version 1. It stays in WS9's range for the next revision of this spec (for example CCTV observers or a vertical model), so a later change need not ask for a new allocation.

### 5.10 Shared types: `shared/fieldOps/world.ts (new)`

Owned by WS9. Types, constants and labels only; it imports only files under `shared/` (master 10.7). `MaterialBehaviour`, `HazardBehaviour` and `SpreadLibrary` are the names master 10.8 item 38 fixes; `WeatherSetting` is the name item 39 fixes. The view and delta types use none of the keys of WS7's `FORBIDDEN_KEYS` (`08-people-or-ai.md` section 6.8), so an AI agency can read them (AC9.46).

```ts
// shared/fieldOps/world.ts (new). Owned by WS9. No package imports (master 10.7).
import type { ArchetypeKey } from './vocabulary.js';
import type { FacilityKind } from './sitePlaces.js';

export const SPREAD_MODEL_VERSION = 'fo-spread-1.0.0' as const;
export const WORLD_ENGINE_VERSION = 'fo-world-1.0.0' as const;

/* ---------- The spread library (master 10.8 item 38) ---------- */

export const MATERIAL_ROLES = ['wall', 'contents', 'structure'] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];
/** The same five words as today's SmokeGeneration. */
export const SMOKE_YIELDS = ['none', 'light', 'moderate', 'heavy', 'toxic'] as const;
export type SmokeYield = (typeof SMOKE_YIELDS)[number];
/** Design fire growth classes of the t-squared family. */
export const FIRE_GROWTH_CLASSES = ['none', 'slow', 'medium', 'fast', 'ultra_fast'] as const;
export type FireGrowthClass = (typeof FIRE_GROWTH_CLASSES)[number];

/** One row of fieldops_spread_materials. Fields that do not apply to the role are null or their defaults. */
export interface MaterialBehaviour {
  key: string;                          // ^[a-z][a-z0-9_]{1,47}$
  role: MaterialRole;
  label: string;
  aliases: readonly string[];           // normalised words that resolve to this key
  combustible: boolean;
  flame_spread_m_min: number | null;    // contents: how fast flame spreads over it, metres a minute
  burn_duration_s: number | null;       // contents: how long a 3 m cell of it burns once alight
  extinguish_s: number | null;          // contents: crew-seconds of suppression that put a burning cell out
  smoke_yield: SmokeYield;
  heat_release: FireGrowthClass;
  burn_through_s: number | null;        // walls: seconds of fire on one side before a breach; null holds for the session
  smoke_leak: number;                   // walls: share of an open edge's smoke transfer that a solid stretch lets through
  gas_leak: number;                     // walls: the same for gas
  glazed: boolean;                      // walls: becomes an opening inside WS6's glass-breakage radius
  fire_resistance_min: number | null;   // structure: minutes of fire exposure before load-bearing damage starts
  creep_per_min: number | null;         // structure: how fast an unsafe area worsens when not shored, permille a minute
  source_ref: string;
  source_note: string;
}

export const HAZARD_TRIGGERS = ['blast', 'ignition', 'none'] as const;
export type HazardTrigger = (typeof HAZARD_TRIGGERS)[number];
/** HazardEvent.spreadType values the library uses; flood is not in version 1. */
export const SPREAD_KINDS = ['fire', 'gas', 'structural_zone'] as const;
export type SpreadKind = (typeof SPREAD_KINDS)[number];
/** HazardEvent.eventType values the library may write. 'explode' is excluded on purpose. */
export const LIBRARY_EVENT_TYPES = ['ignite', 'rupture', 'collapse', 'arc'] as const;
export type LibraryEventType = (typeof LIBRARY_EVENT_TYPES)[number];

export interface HazardInteraction {
  with: string;                         // the other hazard type
  interaction: string;                  // at most 160 characters
  compound_effect: string;              // at most 160 characters
  timeline: string;                     // at most 80 characters
}

/** One row of fieldops_spread_hazards. */
export interface HazardBehaviour {
  hazard_type: string;                  // WS4's HazardTypeKey, or the world's own 'fire'
  label: string;
  trigger_on: HazardTrigger;            // blast: reacts when the blast reaches it; ignition: when fire reaches its cell
  event_type: LibraryEventType | null;
  spread_kind: SpreadKind | null;
  delay_s: number;
  radius_m: { low: number; medium: number; high: number };   // by the trainer's severity
  spread_rate_m_min: number;
  max_radius_m: number;
  acceleration: number;                 // what today's DEFAULT_HAZARD_ACCELERATION holds per type
  contents_key: string | null;          // the contents material the hazard puts in its cells
  smoke_yield: SmokeYield;
  gas: { agent: 'toxic_gas' | 'irritant_gas'; source_rate: number; duration_s: number } | null;
  event_text: string;                   // HazardEvent.description, at most 200 characters
  fact_dispersion: string;              // deteriorationFactsFor's Dispersion line
  fact_structural: string;              // deteriorationFactsFor's Structural line
  interactions: readonly HazardInteraction[];
  source_ref: string;
  source_note: string;
}

/** heat: the fire's heat; heat_stress: hot weather outdoors, whose level is the air temperature in tenths of a degree. */
export const EXPOSURE_AGENTS = ['smoke', 'toxic_gas', 'irritant_gas', 'heat', 'heat_stress', 'collapse'] as const;
export type ExposureAgent = (typeof EXPOSURE_AGENTS)[number];

/** One row of fieldops_spread_exposure: a fractional effective dose model per agent. */
export interface ExposureBehaviour {
  agent: ExposureAgent;
  label: string;
  /** Ascending by `from` (the local level in permille): seconds to an incapacitating dose at that level. */
  incapacitation_bands: ReadonlyArray<{ from: number; seconds: number }>;
  light_at: number;                     // dose at which a group's light share becomes yellow casualties
  serious_at: number;                   // red
  fatal_at: number;                     // black
  shares: { light: number; serious: number; fatal: number; trapped: number };   // permille of the group then present
  patient_note: string;                 // deteriorationFactsFor's PATIENT DETERIORATION NOTES line
  source_ref: string;
  source_note: string;
}

export const WEATHER_CONDITIONS = ['clear', 'cloudy', 'light_rain', 'heavy_rain', 'thunderstorm', 'haze'] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];
export type AtmosphericStability = 'unstable' | 'neutral' | 'stable';

/** One row of fieldops_spread_weather_effects. Every value multiplies a base value. */
export interface WeatherEffect {
  condition: WeatherCondition;
  outdoor_spread: number;
  plume_decay: number;
  observation: number;
  road_speed: number;
  walking_speed: number;
  day_stability: AtmosphericStability;  // at night the world uses 'stable'
  source_ref: string;
  source_note: string;
}

export interface SpreadLibrary {
  model_version: typeof SPREAD_MODEL_VERSION;
  dataset_version: string;              // 16 hex characters (section 6.2)
  version: string;                      // the label WS5 records: `${model_version}:${dataset_version}`
  review: { state: 'reviewed' | 'unreviewed'; review_id: string | null; reviewed_at: string | null };
  materials: Readonly<Record<string, MaterialBehaviour>>;
  hazards: Readonly<Record<string, HazardBehaviour>>;
  exposure: Readonly<Record<ExposureAgent, ExposureBehaviour>>;
  weather: Readonly<Record<WeatherCondition, WeatherEffect>>;
  /** Normalised alias to material key, built by the loader from every active row's aliases. */
  aliases: Readonly<Record<string, string>>;
}

/** The keys loadSpreadLibrary requires; a library without any of them is refused (AC9.2). */
export const SPREAD_REQUIRED_KEYS = {
  wall: 'unknown_wall',
  contents: 'contents_generic',
  structure: 'frame_unknown',
  hazards: ['combustible', 'ignitable', 'debris_risk', 'falling_object', 'electrical', 'chemical', 'fire'],
} as const;

/**
 * What can burn or be stored at a hazard: the contents rows of section 5.12.2, in this fixed order, with the
 * labels the trainer sees. WS4's hazard panel offers them and its save checks SceneHazard.material against the
 * keys (05 sections 5.4, 5.7 and 7.7; its request R4.15), in the browser and on the server, before any library
 * is loaded. The seed file spread-materials.json must hold the same keys and labels; a parity test keeps them
 * equal (AC9.57), so a new contents row is added to both in one change.
 */
export const CONTENTS_MATERIAL_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'contents_retail', label: 'Shop stock and fittings' },
  { key: 'contents_office', label: 'Office furniture and paper' },
  { key: 'contents_transit', label: 'Station concourse' },
  { key: 'contents_car_park', label: 'Parked vehicles' },
  { key: 'contents_residential', label: 'Household furnishings' },
  { key: 'contents_hotel', label: 'Hotel rooms and corridors' },
  { key: 'contents_industrial', label: 'Workshop and storage' },
  { key: 'contents_generic', label: 'Furnished space' },
  { key: 'fuel_combustible', label: 'Combustible stock (hazard)' },
  { key: 'fuel_flammable_liquid', label: 'Flammable liquid (hazard)' },
  { key: 'fuel_chemical', label: 'Chemical store (hazard)' },
  { key: 'fuel_electrical', label: 'Electrical plant and cabling (hazard)' },
  { key: 'inert_debris', label: 'Rubble, nothing to burn' },
];

/**
 * One scene hazard as hazardEventsFor takes it. WS5's CompileSpreadHazard (06 section 6.16) has these fields
 * and SimHazard's position, so WS5 passes its objects unchanged; the world builds the same shape (section 6.6).
 */
export interface SpreadHazardInput {
  id: string;                           // WS4's SceneHazard id, which is also its scene_item_id
  hazardType: string;                   // WS4's HazardTypeKey
  severity: 'low' | 'medium' | 'high';
  radius: number;                       // the trainer's radius in metres (WS5 clamps it to 1 to 50)
  building_key?: string | null;
  material?: string | null;             // WS4's SceneHazard.material, a key of CONTENTS_MATERIAL_OPTIONS; null when none is chosen
  /** The main device's effect at the hazard; null when the main device is not placed. */
  blast: { distance_m: number; band: 'lethal' | 'serious' | 'minor' | 'outside'; within_thermal: boolean } | null;
}

/* ---------- Weather (master 10.8 item 39) ---------- */

export interface WeatherSetting {
  condition: WeatherCondition;
  wind_from_deg: number;                // 0 to 359: where the wind comes from, the angle WindIndicator draws
  wind_speed_ms: number;                // 0 to 30
  visibility_m: number;                 // 50 to 20,000
  temperature_c: number;                // 10 to 45
  rain_mm_h: number;                    // 0 to 150
  haze_psi: number | null;              // 0 to 500 (Singapore's Pollutant Standards Index); null when not hazy
  preset_key: string | null;
  origin: 'trainer' | 'preset' | 'label' | 'default';
}

export const WEATHER_LIMITS = {
  windFromMax: 359, windSpeedMax: 30, visibilityMin: 50, visibilityMax: 20_000,
  temperatureMin: 10, temperatureMax: 45, rainMax: 150, psiMax: 500, transitionMaxS: 600,
} as const;

export const ROAD_GROUPS = ['expressway', 'arterial', 'collector', 'local'] as const;
export type RoadGroup = (typeof ROAD_GROUPS)[number];

/* ---------- Units (D33) ---------- */

export const UNIT_KINDS = [
  'fire_engine', 'rescue_tender', 'hazmat_unit', 'ambulance', 'medical_team', 'patrol_car', 'cordon_team',
  'marshal_team', 'venue_staff', 'eod_team', 'command_unit', 'investigation_team', 'utility_crew',
  'transport_supervisor',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const UNIT_TASKS = [
  'move', 'observe', 'suppress', 'ventilate', 'rescue', 'shore', 'decon', 'triage', 'transport', 'cordon',
  'direct_crowd', 'close_exit', 'open_exit', 'close_road', 'sweep', 'command_post', 'isolate_utility',
] as const;
export type UnitTask = (typeof UNIT_TASKS)[number];

export const UNIT_STATUSES = [
  'at_origin', 'turning_out', 'en_route', 'arrived', 'deploying', 'working', 'returning', 'blocked', 'out_of_action',
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export interface UnitKindDefinition {
  kind: UnitKind;
  label: string;
  archetype: ArchetypeKey;              // the agency type that fields it
  mode: 'vehicle' | 'foot';
  crew: number;
  default_count: number;
  turnout_s: number;                    // from a dispatch order to leaving the origin
  foot_speed_ms: number;                // the crew deployed on foot
  tasks: readonly UnitTask[];
  asset_type: string;                   // the placed_assets type on arrival (W17)
  observe_m: number;                    // outdoor observation range
  breathing_apparatus_s: number;        // seconds the crew can work in smoke; 0 when it cannot
  origin_kinds: readonly FacilityKind[];// WS3 facility kinds it starts from, in order of preference
  starts_on_site: boolean;
}
/** The values are the table of section 5.10.1. */
export declare const UNIT_CATALOGUE: Readonly<Record<UnitKind, UnitKindDefinition>>;

export type UnitOrigin =
  | { kind: 'auto' }                                     // the nearest facility of origin_kinds, else an entry point
  | { kind: 'facility'; osm_id: string }
  | { kind: 'staging'; lat: number; lng: number }
  | { kind: 'on_site' };

/* ---------- Commands, events, settings ---------- */

export type WorldTarget =
  | { kind: 'point'; lat: number; lng: number; floor?: number }
  | { kind: 'exit'; exit_id: string }
  | { kind: 'hazard'; hazard_id: string }
  | { kind: 'casualty'; casualty_id: string }
  | { kind: 'crowd'; group_key: string }
  | { kind: 'facility'; osm_id: string }
  | { kind: 'road'; edge_key: string };

export const WORLD_COMMAND_KINDS = [
  'dispatch', 'recall', 'set_task', 'share_report',
  'set_weather', 'close_road', 'open_road', 'start_fire', 'pause', 'resume',
  'sync_pins', 'device_detonated', 'transport_patient',
] as const;
export type WorldCommandKind = (typeof WORLD_COMMAND_KINDS)[number];

export const WORLD_EVENT_KINDS = [
  'world_started', 'world_paused', 'world_resumed', 'world_stopped', 'world_fallback', 'blast_applied',
  'fire_region_ignited', 'fire_region_grew', 'fire_region_out', 'wall_breached', 'glazing_failed',
  'structure_damaged', 'structure_unsafe', 'structure_collapsed', 'plume_started', 'plume_ended',
  'crowd_moving', 'exit_congested', 'exit_blocked', 'crowd_mustered', 'crowd_trapped', 'exposure_casualties',
  'unit_dispatched', 'unit_arrived', 'unit_task_started', 'unit_task_ended', 'unit_recalled', 'unit_blocked',
  'unit_out_of_action', 'road_closed', 'road_opened', 'road_jammed', 'weather_changed', 'report_shared',
  'command_rejected', 'device_detonated', 'trainer_fire_started',
] as const;
export type WorldEventKind = (typeof WORLD_EVENT_KINDS)[number];

export interface WorldEvent {
  seq: number;
  tick: number;
  kind: WorldEventKind;
  lat: number | null;
  lng: number | null;
  floor: number | null;
  data: Readonly<Record<string, string | number | boolean | null>>;   // ids, counts and labels only
}

export const WORLD_STATUSES = ['pending', 'preparing', 'ready', 'running', 'paused', 'fallback', 'stopped', 'failed'] as const;
export type WorldStatus = (typeof WORLD_STATUSES)[number];

export const WORLD_STATUS_REASONS = [
  'WORLD_BEHIND', 'WORLD_TOO_LARGE', 'STARTED_TOO_LATE', 'NO_CAPACITY', 'MODEL_FAILED', 'LIBRARY_MISSING',
  'ENGINE_ERROR', 'SESSION_ENDED', 'TRAINER_STOPPED', 'NOT_ALLOWED_UNREVIEWED', 'TABLES_MISSING',
] as const;
export type WorldStatusReason = (typeof WORLD_STATUS_REASONS)[number];

/** fieldops_world_sessions.settings. Written by the lobby card before the start; locked afterwards. */
export interface WorldSettings {
  enabled: boolean;                     // default true for an eligible scenario
  fog_enabled: boolean;                 // default true once slice 4 is on
  share_unit_positions: boolean;        // default true (W18)
  weather: WeatherSetting | null;       // a lobby override; null keeps the scenario's
  units: Array<{ team_name: string; kind: UnitKind; count: number; origin: UnitOrigin }>;   // empty: catalogue defaults
}

/* ---------- Views and deltas (what a browser or an AI agency receives) ---------- */

export const STRUCTURE_STATES = ['sound', 'damaged', 'unsafe', 'collapsed'] as const;
export type StructureState = (typeof STRUCTURE_STATES)[number];
export const CROWD_STATES = ['waiting', 'moving', 'queued', 'outside', 'mustered', 'trapped', 'held'] as const;
export type CrowdState = (typeof CROWD_STATES)[number];
export type WorldAudience = 'team' | 'trainer' | 'spectator';

/** Public geometry: the trainer's plan and the site, which every audience may see. */
export interface WorldFrameView {
  origin: { lat: number; lng: number }; // the vertex mean of the primary ring, WS4's sim frame
  primary_ring: Array<[number, number]>;
  cell_m: 3 | 4 | 5;
  cols: number;
  rows: number;
  grid_x0: number;                      // sim-space metres of the grid's north-west corner
  grid_y0: number;
  floors: number[];
  exits: Array<{ exit_id: string; lat: number; lng: number; width_m: number; label: string; building_key: string }>;
  stairs: Array<{ stair_id: string; cell: number; floors: [number, number] }>;
  buildings: Array<{ building_key: string; label: string; ring: Array<[number, number]> }>;
}

/** Flat groups of five integers per cell: index, fire state (0 to 4), smoke decile, structure state index, gas decile. */
export interface WorldCellsView {
  encoding: 'c5';
  values: number[];
}
export interface WorldLastKnownCells {
  values: number[];                     // the same encoding, the state when last seen
  seen_tick: number[];                  // one per cell, in the same order
}
export interface CompartmentView {
  building_key: string;
  involvement: number;                  // permille of the floor area alight
  smoke: number;                        // permille
  structure: StructureState;
  seen_tick: number | null;             // null while in view
}
export interface PlumeView {
  plume_key: string;
  agent: 'smoke' | 'toxic_gas' | 'irritant_gas';
  ring: Array<[number, number]>;
  density: 'light' | 'moderate' | 'dense';
  seen_tick: number | null;
}
export interface CrowdGroupView {
  group_key: string;
  lat: number;
  lng: number;
  floor: number;
  people: number;
  state: CrowdState;
  target_exit: string | null;
  seen_tick: number | null;
}
export interface UnitView {
  unit_key: string;
  team_name: string;
  kind: UnitKind;
  label: string;
  status: UnitStatus;
  task: UnitTask | null;
  lat: number;
  lng: number;
  floor: number;
  path: Array<[number, number]>;        // the remaining route, simplified to 5 m
  eta_s: number | null;
  own: boolean;
}
export interface RoadStatusView {
  edge_key: string;
  state: 'closed' | 'cordoned' | 'jammed' | 'slow';
  line: Array<[number, number]>;
  reason: 'trainer' | 'cordon' | 'evacuation' | 'collapse' | 'traffic' | 'incident';
}
export interface ReportView {
  report_id: number;
  from_team: string;
  entity_key: string;
  tick: number;
  note: string | null;
  lat: number | null;
  lng: number | null;
}
export interface WorldCover {
  circles: Array<{ lat: number; lng: number; r_m: number }>;   // outdoor observation
  cells: number[];                      // primary cells in view
}
export interface WorldCounters {
  burning_cells: number;
  smoke_cells: number;
  unsafe_cells: number;
  collapsed_cells: number;
  people_inside: number;
  people_out: number;
  people_trapped: number;
  exposure_casualties: number;
}
/** Trainer audience only: where each planted device is and what has become of it. */
export interface DeviceMarkerView {
  scene_item_id: string;
  lat: number;
  lng: number;
  floor: number;
  state: 'pending' | 'detonated' | 'removed';
}

export interface WorldView {
  session_id: string;
  audience: WorldAudience;
  team_names: string[];
  status: WorldStatus;
  status_reason: WorldStatusReason | null;
  tick: number;
  world_time_s: number;
  session_elapsed_s: number;
  unreviewed: boolean;
  weather: WeatherSetting;
  frame: WorldFrameView;
  cells: WorldCellsView;
  last_known: WorldLastKnownCells;
  compartments_state: CompartmentView[];
  plumes: PlumeView[];
  crowd_groups: CrowdGroupView[];
  units: UnitView[];
  roads: RoadStatusView[];
  reports: ReportView[];
  cover: WorldCover;
  counters: WorldCounters;
  device_markers: DeviceMarkerView[];   // always empty unless the audience is 'trainer'
  events: WorldEvent[];                 // the latest 50 the audience may see
}

/** Only what changed since the audience's previous delta. */
export interface WorldDelta {
  session_id: string;
  audience: WorldAudience;
  tick: number;
  world_time_s: number;
  status?: WorldStatus;
  weather?: WeatherSetting;
  cells?: WorldCellsView;
  last_known?: WorldLastKnownCells;
  compartments_state?: CompartmentView[];
  plumes?: PlumeView[];
  plumes_removed?: string[];
  crowd_groups?: CrowdGroupView[];
  crowd_groups_removed?: string[];
  units?: UnitView[];
  roads?: RoadStatusView[];
  roads_removed?: string[];
  reports?: ReportView[];
  cover?: WorldCover;
  counters?: WorldCounters;
  device_markers?: DeviceMarkerView[];
  events?: WorldEvent[];
  resync?: true;                        // the delta would exceed WORLD_LIMITS.maxDeltaBytes: fetch the view again
}

export const WORLD_LIMITS = {
  cellSizesM: [3, 4, 5],
  maxCells: 20_000,
  maxFloors: 4,
  floorMin: -1,
  floorMax: 2,
  crowdGroupMax: 50,
  maxCrowdGroups: 400,
  maxUnitsPerAgency: 8,
  maxUnitsPerSession: 40,
  maxPlumes: 24,
  maxReportsPerTeam: 200,
  maxKnowledgePerTeam: 2_000,
  tickSeconds: 1,
  deltaEverySeconds: 2,
  plumeEverySeconds: 5,
  visibilityEverySeconds: 2,
  bridgeEverySeconds: 5,
  knowledgeEverySeconds: 10,
  eventBatchSeconds: 2,
  maxCatchUpTicks: 600,
  maxDeltaBytes: 65_536,
  commandsPerMinute: 60,
  reportsPerMinute: 30,
  reportNoteMax: 280,
} as const;
```

#### 5.10.1 The unit catalogue (Proposed; Assumed (D33) for the counts)

Every value is a constant in `UNIT_CATALOGUE`. A unit can do the tasks of its kind, less `triage` when its team's action scope (WS1's `actionScopeFor`, `02-teams-and-doctrines.md` section 5.2.4) has `can_triage` false, less `sweep` when `can_sweep` is false; every unit can `move` and `observe`. Where it may go is its team's `zone_access` (section 6.8.6).

| Kind | Label | Archetype | Mode | Crew | Default count | Turnout | Tasks besides move and observe | Asset type on arrival | Observes | Breathing apparatus | Starts from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fire_engine` | Fire engine | `fire_rescue` | vehicle | 4 | 2 | 60 s | suppress, ventilate, rescue | `firefighter_post` | 60 m | 1,800 s | `fire_station` |
| `rescue_tender` | Rescue tender | `fire_rescue` | vehicle | 6 | 1 | 90 s | rescue, shore | `firefighter_post` | 60 m | 1,800 s | `fire_station` |
| `hazmat_unit` | HazMat unit | `fire_rescue` | vehicle | 4 | 1 | 120 s | decon | `hazmat_team` | 60 m | 3,600 s | `fire_station` |
| `ambulance` | Ambulance | `medical_triage` | vehicle | 2 | 3 | 60 s | triage, transport | `paramedic` | 60 m | 0 | `ambulance_station`, `hospital` |
| `medical_team` | Medical team | `medical_triage` | foot | 4 | 1 | 120 s | triage | `triage_officer` | 50 m | 0 | `hospital` |
| `patrol_car` | Patrol car | `police_security` | vehicle | 2 | 2 | 30 s | cordon, direct_crowd, close_road | `police_officer` | 60 m | 0 | `police` |
| `cordon_team` | Cordon team | `police_security` | foot | 6 | 1 | 120 s | cordon, direct_crowd, close_exit, open_exit | `police_officer` | 50 m | 0 | `police` |
| `marshal_team` | Marshal team | `evacuation_crowd` | foot | 6 | 2 | 60 s | direct_crowd, close_exit, open_exit | `marshal_post` | 50 m | 0 | an entry point |
| `venue_staff` | Venue staff | `venue_operations` | foot | 4 | 2 | 0 s | direct_crowd, close_exit, open_exit | `steward` | 50 m | 0 | on site |
| `eod_team` | EOD team | `bomb_disposal_eod` | vehicle | 4 | 1 | 120 s | sweep | `eod_team` | 60 m | 0 | `police` |
| `command_unit` | Command unit | `incident_command` | vehicle | 3 | 1 | 60 s | command_post | `command_post` | 100 m | 0 | `police`, `fire_station` |
| `investigation_team` | Investigation team | `pursuit_investigation` | vehicle | 2 | 1 | 60 s | none | `investigator` | 60 m | 0 | `police` |
| `utility_crew` | Utility crew | `utilities` | vehicle | 3 | 1 | 300 s | isolate_utility | `utility_control` | 60 m | 0 | `power_substation` |
| `transport_supervisor` | Transport supervisor | `transport_operator` | vehicle | 2 | 1 | 120 s | close_road | `ops_center_post` | 60 m | 0 | an entry point |

`media_comms`, `hospital_ed` and `ministry_liaison` field no units: they talk and decide, as WS1's `talk_only` and `operational` capabilities say for the agencies that act on the map (`02-teams-and-doctrines.md` section 5.2). A team with no archetype gets no unit. The asset types are chosen so today's checks recognise them: `paramedic` and `triage_officer` are `MEDIC_TYPES` (`server/routes/casualties.ts:222-230`), `marshal_post`, `steward` and `police_officer` pass the marshal test of exit flow (`server/services/exitFlowService.ts:38-45`), and `firefighter_post` matches the fire personnel types that pin resolution compares (`server/services/pinResolutionService.ts:115-119`). Foot speed is 1.2 m/s, the `CROWD_WALK_MPM` of `server/services/movementService.ts:14`, and 0.8 m/s for crews in breathing apparatus.

#### 5.10.2 Pure rules: `shared/fieldOps/worldRules.ts (new)`

```ts
// shared/fieldOps/worldRules.ts (new). Owned by WS9. Pure functions over the types of world.ts and WS4's sceneGeometry.
import type { ArchetypeKey } from './vocabulary.js';
import type {
  MaterialRole, RoadGroup, SpreadLibrary, StructureState, UnitKind, UnitTask, UnitView, WeatherSetting, WorldDelta,
  WorldFrameView, WorldView,
} from './world.js';

export interface WeatherPreset {
  preset_key: string;
  label: string;
  setting: WeatherSetting;
  label_keywords: readonly string[];
}
/** The presets of section 5.12.6, used when migration 255 is missing; the seed file holds the same rows. */
export declare const BUILTIN_WEATHER_PRESETS: readonly WeatherPreset[];

/** NFKC, lower case, '&' to 'and', punctuation to spaces, runs of spaces collapsed, trimmed. */
export declare function normaliseMaterialText(text: string): string;
/** Exact key, then exact alias, then the role's required default. Never a substring match (section 3.2). */
export declare function resolveMaterialKey(
  text: string | null | undefined,
  role: MaterialRole,
  library: Pick<SpreadLibrary, 'materials' | 'aliases'>,
): string;
/** Section 6.9.2. Deterministic; presets from the table when given, else BUILTIN_WEATHER_PRESETS. */
export declare function weatherFromLabel(
  label: string | null,
  when: { day: 'weekday' | 'weekend'; time: string },
  presets?: readonly WeatherPreset[],
  description?: string,
): WeatherSetting;
export declare function defaultWeather(when: { time: string }): WeatherSetting;
/** Singapore's light changes little over the year: night is 19:15 to 07:00 local time. */
export declare function isNightAt(time: string): boolean;
export declare function hourOf(time: string): number;
export declare function roadGroupOf(highwayType: string): RoadGroup;
export declare function unitsForAgency(archetype: ArchetypeKey | null): Array<{ kind: UnitKind; count: number }>;
export declare function tasksForUnit(kind: UnitKind, scope: { can_triage: boolean; can_sweep: boolean }): UnitTask[];
export declare function structureStateOf(damagePermille: number): StructureState;   // 0-249, 250-499, 500-849, 850-1000
/** Applies a delta to a view; answers 'resync' when the delta says so or its tick is older than the view's. */
export declare function applyWorldDelta(view: WorldView, delta: WorldDelta): WorldView | 'resync';
export declare function decodeCells(values: readonly number[]): Array<{
  index: number; fire: number; smoke: number; structure: number; gas: number;
}>;
/** Cell index to its centre in latitude and longitude, with WS4's simToLatLng (shared/fieldOps/sceneGeometry.ts). */
export declare function cellCentre(frame: WorldFrameView, index: number): { lat: number; lng: number; floor: number };
export declare function cellRing(frame: WorldFrameView, index: number): Array<[number, number]>;
/** 'HH:MM:SS' of world time. */
export declare function worldClockText(seconds: number): string;
/** For WS7's planner: the team's nearest idle unit that can do the task, by straight distance; null when none. */
export declare function suggestUnitForTask(units: readonly UnitView[], task: UnitTask, target: { lat: number; lng: number }): string | null;
```

### 5.11 Server-only types

The world model and the engine state hold answer-key data and never leave the server, except the public frame.

```ts
// server/services/fieldOps/world/model/worldModel.ts (new). Owned by WS9.
import type { InvolvedBuildingKind, ArchetypeKey } from '../../../../../shared/fieldOps/vocabulary.js';
import type { CrowdDensity, SceneSetting } from '../../../../../shared/fieldOps/layout.js';
import type { FacilityKind } from '../../../../../shared/fieldOps/sitePlaces.js';
import type {
  SpreadLibrary, UnitKind, UnitOrigin, WeatherSetting, WorldFrameView, WORLD_ENGINE_VERSION,
} from '../../../../../shared/fieldOps/world.js';

export interface WorldModel {
  model_version: typeof WORLD_ENGINE_VERSION;
  scenario_id: string;
  revision_no: number | null;
  inputs_hash: string;
  dataset_version: string;
  /** The spread library the model was built with, frozen: a world never re-reads the tables (section 6.11.7). */
  library: SpreadLibrary;
  frame: WorldFrameView;
  grid: {
    cell_m: 3 | 4 | 5;
    cols: number;
    rows: number;
    floors: number[];
    inside_b64: string;                 // one bit per cell and floor: inside the primary outline
    contents_b64: string;               // one byte per cell: index into contents_keys
    contents_keys: string[];
    stair_cells: Array<{ stair_id: string; cell: number; floors: [number, number]; blocked: boolean }>;
    exit_cells: Array<{ exit_id: string; cell: number; width_m: number; status: 'open' | 'blocked' | 'congested' | 'unknown' }>;
  };
  /** Edges between two neighbouring cells that a wall crosses, on every modelled floor. */
  wall_edges: Array<{ a: number; b: number; material_key: string; door: boolean; glazed: boolean }>;
  structure_key: string;
  compartments: Array<{
    building_key: string; label: string; kind: InvolvedBuildingKind; area_m2: number;
    centroid: { lat: number; lng: number }; contents_key: string; structure_key: string;
    exits: Array<{ exit_id: string; lat: number; lng: number; width_m: number }>;
  }>;
  hazards: Array<{
    scene_item_id: string; hazard_type: string; severity: 'low' | 'medium' | 'high'; radius_m: number;
    lat: number; lng: number; cell: number | null; building_key: string | null;
  }>;
  devices: Array<{
    scene_item_id: string; device_index: number; is_main: boolean; lat: number; lng: number; floor: number;
    at_start: boolean; unreviewed: boolean;
    radii: {
      glass_breakage_m: number | null; structural_light_m: number | null; structural_moderate_m: number | null;
      structural_severe_m: number | null; thermal_m: number | null; minor_m: number;
    };
  }>;
  wall_points: Array<{ wall_point_id: string; lat: number; lng: number; building_key: string | null }>;
  crowd: Array<{
    zone_id: string; label: string; setting: SceneSetting; building_key: string | null; density: CrowdDensity | null;
    people: number; cells: number[] | null; ring: Array<[number, number]> | null;
  }>;
  operational_zones: Array<{ type: 'hot' | 'warm' | 'cold'; lat: number; lng: number; radius_m: number }>;
  facilities: Array<{ osm_id: string; kind: FacilityKind; name: string | null; lat: number; lng: number }>;
  entry_points: Array<{ node: number; lat: number; lng: number }>;
  road_graph_id: string | null;
  weather: WeatherSetting;
  when: { day: 'weekday' | 'weekend'; time: string; night: boolean };
  duration_minutes: number;
  agencies: Array<{
    team_name: string; archetype_key: ArchetypeKey | null; zone_access: Array<'hot' | 'warm' | 'cold'>;
    can_triage: boolean; can_sweep: boolean; operation: 'people' | 'ai';
  }>;
  unit_plan: Array<{ unit_key: string; team_name: string; kind: UnitKind; label: string; origin: UnitOrigin; origin_point: { lat: number; lng: number } }>;
  casualties_by_zone: Record<string, { black: number; red: number; yellow: number }>;
}
```

```ts
// server/services/fieldOps/world/worker/protocol.ts (new). Owned by WS9. Messages between the runtime and its workers.
import type { SpreadTimelineInput } from '../compileSpread.js';
import type { EnvironmentalSnapshot } from '../../../rtsSceneEnrichmentService.js';
import type { WorldDelta, WorldEvent } from '../../../../../shared/fieldOps/world.js';
import type { WorldModel } from '../model/worldModel.js';
import type { RoadGraph } from '../roads/roadGraph.js';
import type { AppliedCommand, BridgeOps, EngineSnapshot, KnowledgeChange, UnitChange } from '../engine/state.js';

export type ToWorker =
  | { op: 'spread_timeline'; job: number; input: SpreadTimelineInput }
  | { op: 'host'; session_id: string; model: WorldModel; roads: RoadGraph | null; snapshot: EngineSnapshot | null; replay: AppliedCommand[]; until_tick: number }
  | { op: 'tick'; session_id: string; commands: AppliedCommand[]; target_tick: number }
  | { op: 'snapshot'; session_id: string }
  | { op: 'unhost'; session_id: string };

export type FromWorker =
  | { op: 'spread_timeline_done'; job: number; snapshots: EnvironmentalSnapshot[] }
  | { op: 'spread_timeline_failed'; job: number; code: 'worker_failed'; message: string }
  | { op: 'hosted'; session_id: string; tick: number; state_hash: string }
  | {
      op: 'ticked'; session_id: string; tick: number; ms: number; events: WorldEvent[];
      deltas: Record<string, WorldDelta>;             // keyed 'trainer', 'spectator' or 'team:<name>'
      bridge: BridgeOps; units: UnitChange[]; knowledge: KnowledgeChange[];
      rejected: Array<{ command_id: number; code: string }>;
    }
  | { op: 'snapshot'; session_id: string; tick: number; state_hash: string; state: Record<string, unknown> }
  | { op: 'error'; session_id: string | null; code: string; message: string };
```

The engine state (`server/services/fieldOps/world/engine/state.ts (new)`) is plain structured-cloneable data: per-cell `Uint8Array` and `Uint16Array` layers (fire state, fire timer, smoke, gas, damage, shoring, suppression), a `Uint16Array` of breach seconds per wall edge, arrays of compartment, plume, crowd-group and unit records, road closures and jam factors, the current and target weather, per-team knowledge (a `Uint16Array` of last-seen ticks per cell and a map of entity knowledge), the named random streams, the event sequence and the counters. `serialiseState` writes the typed arrays as base64 in a fixed key order; `stateHash` is the SHA-256 of that canonical JSON.

### 5.12 Seed files and the version 1 content

**Proposed.** Seven files under `server/services/fieldOps/world/data/seed/ (new)`: `spread-materials.json`, `spread-hazards.json`, `spread-exposure.json`, `spread-weather-effects.json`, `road-speed-classes.json`, `traffic-profiles-sg.json` and `weather-presets-sg.json`. Each has the header `{ "file", "schema_version": 1, "prepared_by", "prepared_on", "review_status": "unreviewed", "rows": [] }`, and each row holds exactly the columns of its table without ids, status, versions, actors or timestamps, including a `source_ref` naming the published source and a `source_note` saying what was taken from it. `seedFileSchema` checks them (section 5.14). The values below are planning values for training, prepared from the named sources during development; the D31 review may change any of them, and until it is recorded every surface says "Unreviewed model" (W24). No row describes a device: the library is about buildings, fire, smoke, gas, people and weather.

#### 5.12.1 Walls

| Key | Label | Aliases | Burn-through | Smoke leak | Gas leak | Glazed | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `concrete` | Concrete | concrete, cement | holds | 0.02 | 0.05 | no | Eurocode 2, BS EN 1992-1-2, tabulated fire resistance of concrete walls |
| `reinforced_concrete` | Reinforced concrete | reinforced concrete, rc, reinforced | holds | 0.02 | 0.05 | no | as above |
| `brick` | Brick | brick, brickwork | holds | 0.03 | 0.06 | no | Eurocode 6, BS EN 1996-1-2, masonry fire resistance |
| `stone` | Stone or masonry | stone, masonry | holds | 0.03 | 0.06 | no | as above |
| `cinder_block` | Concrete block | cinder block, block, blockwork | 7,200 s | 0.03 | 0.06 | no | as above, hollow block |
| `drywall` | Plasterboard partition | drywall, gypsum, plasterboard | 1,800 s | 0.05 | 0.10 | no | BS EN 1364-1 test classifications of single-layer partitions |
| `plywood` | Timber-board partition | plywood, partition, chipboard | 600 s | 0.08 | 0.12 | no | Eurocode 5, BS EN 1995-1-2, charring rates of wood-based panels |
| `wood` | Timber | wood, timber | 900 s | 0.08 | 0.12 | no | as above, solid timber |
| `metal` | Metal sheet | metal, steel, aluminium, aluminum | 900 s | 0.04 | 0.08 | no | integrity of uninsulated steel sheet in standard furnace tests (BS 476-22) |
| `glass` | Glazing | glass, glazing, window | 120 s | 0.15 | 0.20 | yes | SFPE Handbook of Fire Protection Engineering, 5th edition (2016), glass breakage in fires |
| `unknown_wall` | Wall, material not set | none | 1,800 s | 0.05 | 0.10 | no | Assumed as a plasterboard partition, so an unset material neither stops fire for ever nor lets it through |

The ten keys other than `unknown_wall` are the ten values of the Scene Editor's material list (`frontend/src/components/SceneEditor/SceneEditor.tsx:2693-2703`), so every saved wall resolves exactly.

#### 5.12.2 Contents and structural frames

| Key | Role | Label | Flame spread | Burn time | Extinguish | Smoke | Growth | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `contents_retail` | contents | Shop stock and fittings | 1.5 m/min | 900 s | 60 s | heavy | fast | BS PD 7974-1:2019 design fire growth rates by occupancy; SFPE Handbook t-squared classes |
| `contents_office` | contents | Office furniture and paper | 1.0 m/min | 1,200 s | 45 s | moderate | medium | as above |
| `contents_transit` | contents | Station concourse | 0.5 m/min | 600 s | 30 s | moderate | slow | as above, low fire load |
| `contents_car_park` | contents | Parked vehicles | 0.6 m/min | 1,800 s | 120 s | heavy | medium | BRE report BD 2552, Fire spread in car parks (2010), car-to-car spread intervals |
| `contents_residential` | contents | Household furnishings | 1.2 m/min | 1,200 s | 45 s | heavy | fast | BS PD 7974-1:2019 |
| `contents_hotel` | contents | Hotel rooms and corridors | 1.0 m/min | 1,200 s | 45 s | heavy | medium | as above |
| `contents_industrial` | contents | Workshop and storage | 1.5 m/min | 1,800 s | 90 s | heavy | fast | as above |
| `contents_generic` | contents | Furnished space | 1.0 m/min | 900 s | 45 s | moderate | medium | as above, medium growth |
| `fuel_combustible` | contents | Combustible stock (hazard) | 2.0 m/min | 1,200 s | 90 s | heavy | fast | SFPE Handbook, stacked combustibles |
| `fuel_flammable_liquid` | contents | Flammable liquid (hazard) | 8.0 m/min | 600 s | 120 s | heavy | ultra_fast | SFPE Handbook, pool fires |
| `fuel_chemical` | contents | Chemical store (hazard) | 1.0 m/min | 900 s | 120 s | toxic | medium | SFPE Handbook; US EPA AEGL programme for the toxic products |
| `fuel_electrical` | contents | Electrical plant and cabling (hazard) | 0.8 m/min | 900 s | 60 s | toxic | medium | SFPE Handbook, cable fires and halogenated smoke |
| `inert_debris` | contents | Rubble, nothing to burn | 0.01 m/min (not combustible) | 10 s | 5 s | none | none | Assumed |
| `frame_reinforced_concrete` | structure | Reinforced concrete frame | fire resistance 120 min, creep 2 permille a minute | | | | | Singapore Civil Defence Force, Code of Practice for Fire Precautions in Buildings 2018, chapter 3 |
| `frame_steel` | structure | Protected steel frame | 60 min, 4 | | | | | as above |
| `frame_masonry` | structure | Load-bearing masonry | 90 min, 3 | | | | | as above |
| `frame_timber` | structure | Timber frame | 30 min, 6 | | | | | as above |
| `frame_unknown` | structure | Frame not known | 60 min, 4 | | | | | Assumed, the protected steel values |

The primary building's contents and frame come from WS3's place class of its footprint (section 6.6.3): `mall` and `retail` give `contents_retail`; `office` and `government` `contents_office`; `transit_station` and `airport` `contents_transit`; `car_park` `contents_car_park`; `apartments` and `house` `contents_residential`; `hotel` `contents_hotel`; `industrial` and `warehouse` `contents_industrial`; every other class and a null class `contents_generic`. The frame is `frame_steel` for `transit_station`, `airport`, `stadium` and `warehouse`, `frame_reinforced_concrete` for every other class, and `frame_unknown` when the class is null. Both are shown to the trainer as assumptions.

#### 5.12.3 Hazards

| Type | Trigger | Event | Spread | Delay | Radius low, medium, high | Rate | Max | Acceleration | Contents | Smoke | Gas | Source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `combustible` | blast | ignite | fire | 20 s | 2, 4, 6 m | 1.5 m/min | 20 m | 3 | `fuel_combustible` | heavy | none | SFPE Handbook, fast growth |
| `ignitable` | blast | ignite | fire | 5 s | 3, 5, 8 m | 8 m/min | 30 m | 5 | `fuel_flammable_liquid` | heavy | none | SFPE Handbook, pool fires |
| `chemical` | blast | rupture | gas | 10 s | 3, 6, 10 m | 4 m/min | 60 m | 4 | `fuel_chemical` | toxic | toxic, rate 400, 1,800 s | US EPA and NOAA ALOHA technical documentation (Jones and others, 2013) for release behaviour |
| `electrical` | blast | arc | fire | 30 s | 1, 2, 3 m | 0.8 m/min | 10 m | 2 | `fuel_electrical` | toxic | none | SFPE Handbook, electrical ignition |
| `debris_risk` | blast | collapse | structural_zone | 0 s | 2, 4, 6 m | 0.5 m/min | 15 m | 1 | `inert_debris` | none | none | FEMA P-58 seismic performance methodology, collapse fragility used as a planning analogue |
| `falling_object` | blast | collapse | structural_zone | 60 s | 1, 2, 4 m | 0.2 m/min | 8 m | 1 | `inert_debris` | none | none | Assumed |
| `fire` | none | ignite | fire | 0 s | 3, 3, 3 m | 1.0 m/min | 30 m | 1 | none | moderate | none | Assumed: the world's own fires and the trainer's secondary fire |

The acceleration values equal today's `DEFAULT_HAZARD_ACCELERATION` (`server/services/environmentalSimService.ts:90-97`). Each row also carries an `event_text`, the two fact lines and its interactions; for example `combustible` reads "Combustible stock catches fire and burns fiercely." with the dispersion line "Smoke from burning stock fills an enclosed floor within minutes and travels along ceilings, corridors and stairwells." and the interaction with `electrical`: "Arcing equipment can ignite nearby stock", "a second fire starts", "within minutes".

#### 5.12.4 Exposure

| Agent | Incapacitation bands (level permille: seconds) | Light, serious, fatal at | Shares light, serious, fatal, trapped (permille) | Source |
| --- | --- | --- | --- | --- |
| `smoke` | 200: 1,800; 400: 900; 600: 300; 800: 120 | 0.3, 1.0, 3.0 | 300, 200, 100, 0 | ISO 13571:2012, fractional effective dose method; 0.3 is its limit for susceptible people |
| `toxic_gas` | 200: 900; 500: 300; 800: 60 | 0.3, 1.0, 2.0 | 300, 250, 150, 0 | ISO 13571:2012; US EPA Acute Exposure Guideline Levels, tiers 2 and 3 |
| `irritant_gas` | 300: 1,200; 600: 600 | 0.5, 1.5, 4.0 | 400, 100, 20, 0 | as above, tier 1 and 2 effects |
| `heat` | 300: 300 (next to fire); 800: 20 (inside fire) | 0.3, 1.0, 2.0 | 200, 300, 300, 0 | ISO 13571:2012, heat and radiant flux tenability |
| `heat_stress` | 330 (33.0 °C): 14,400; 360: 7,200 | 1.0, 2.0, 4.0 | 50, 10, 0, 0 | ISO 7243:2017 heat stress assessment and the National Environment Agency's heat stress advisories, as planning analogues |
| `collapse` | none (immediate) | not used | 250, 300, 150, 200 | HAZUS-MH Technical Manual, indoor casualty rates for collapsed structures, used as a planning analogue |

#### 5.12.5 Weather effects, road speeds and traffic

| Condition | Outdoor spread | Plume decay | Observation | Road speed | Walking speed | Day stability | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clear` | 1.00 | 1.0 | 1.00 | 1.00 | 1.00 | unstable | Assumed baseline |
| `cloudy` | 0.95 | 1.0 | 0.95 | 1.00 | 1.00 | neutral | Turner, Workbook of Atmospheric Dispersion Estimates (1970), stability by cloud cover |
| `light_rain` | 0.70 | 1.3 | 0.85 | 0.90 | 0.95 | neutral | US FHWA Road Weather Management Program, speed reductions in rain |
| `heavy_rain` | 0.40 | 1.8 | 0.60 | 0.75 | 0.85 | neutral | as above |
| `thunderstorm` | 0.30 | 2.0 | 0.50 | 0.65 | 0.80 | neutral | as above; Meteorological Service Singapore on thunderstorm gusts |
| `haze` | 1.00 | 0.8 | 0.80 | 0.95 | 1.00 | stable | National Environment Agency, Pollutant Standards Index bands |

Road speed classes (free flow, emergency factor, road group): `motorway` 80 km/h, 1.10, expressway; `motorway_link` 50, 1.00, expressway; `trunk` 60, 1.10, arterial; `trunk_link` 40, 1.00, arterial; `primary` 50, 1.10, arterial; `primary_link` 35, 1.00, arterial; `secondary` 45, 1.10, collector; `secondary_link` 30, 1.00, collector; `tertiary` 40, 1.05, collector; `tertiary_link` 30, 1.00, collector; `residential` 30, 1.00, local; `unclassified` 30, 1.00, local; `service` 15, 1.00, local; `living_street` 10, 1.00, local. Source: the Land Transport Authority's published speed limits (50 km/h by default, 70 to 90 km/h on expressways); the emergency factors are Assumed.

Traffic profiles for Singapore (`region` SG), as a share of free-flow speed for expressway, arterial, collector and local roads; every hour of a band has the band's value:

| Day type | Hours | Expressway | Arterial | Collector | Local |
| --- | --- | --- | --- | --- | --- |
| weekday | 00 to 05 | 1.00 | 1.00 | 1.00 | 1.00 |
| weekday | 06 | 0.85 | 0.85 | 0.90 | 0.95 |
| weekday | 07 to 09 | 0.60 | 0.50 | 0.60 | 0.80 |
| weekday | 10 to 16 | 0.85 | 0.75 | 0.80 | 0.90 |
| weekday | 17 to 19 | 0.55 | 0.45 | 0.55 | 0.75 |
| weekday | 20 to 23 | 0.90 | 0.85 | 0.90 | 0.95 |
| weekend | 00 to 07 | 1.00 | 1.00 | 1.00 | 1.00 |
| weekend | 08 to 10 | 0.90 | 0.85 | 0.90 | 0.95 |
| weekend | 11 to 20 | 0.80 | 0.70 | 0.80 | 0.90 |
| weekend | 21 to 23 | 0.90 | 0.85 | 0.90 | 0.95 |

Source: the Land Transport Authority's Singapore Land Transport Statistics in Brief (average peak-hour speeds on expressways and arterial roads), turned into shares of free-flow speed. The seed file writes all 192 rows.

#### 5.12.6 Weather presets for Singapore

| Key | Label | Condition | Wind from, speed | Visibility | Temperature | Rain | PSI | Label words |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sg_clear_day` | Clear day | clear | 45°, 3 m/s | 10 km | 31 °C | 0 | none | clear, sunny, fine, dry |
| `sg_clear_night` | Clear night | clear | 45°, 2 m/s | 8 km | 27 °C | 0 | none | night, evening |
| `sg_hot_afternoon` | Hot afternoon | clear | 135°, 2 m/s | 10 km | 34 °C | 0 | none | hot, heat, humid |
| `sg_light_rain` | Light rain | light_rain | 45°, 3 m/s | 6 km | 27 °C | 2 mm/h | none | drizzle, light rain, shower |
| `sg_monsoon_rain` | Monsoon rain | heavy_rain | 30°, 6 m/s | 3 km | 25 °C | 15 mm/h | none | heavy rain, downpour, monsoon |
| `sg_afternoon_thunderstorm` | Afternoon thunderstorm | thunderstorm | 200°, 10 m/s | 2 km | 25 °C | 40 mm/h | none | thunderstorm, storm, lightning, thunder |
| `sg_squall` | Early-morning squall | thunderstorm | 260°, 14 m/s | 1.5 km | 24 °C | 50 mm/h | none | squall, gale, strong wind, gusts |
| `sg_haze` | Haze | haze | 225°, 3 m/s | 2.5 km | 32 °C | 0 | 180 | haze, smog, psi, smoky |

Source: Meteorological Service Singapore, Climate of Singapore (the monsoon seasons, afternoon thunderstorms and the westerly squalls from Sumatra), and the National Environment Agency's PSI bands.

### 5.13 Before the migrations are applied

Every reader detects a missing table with WS0's helpers (`server/lib/schemaFeatures.ts (new)`, master 10.8 item 5), and a negative answer is re-checked after about a minute.

| Missing | Behaviour |
| --- | --- |
| 249 | `loadSpreadLibrary()` is null: WS5 compiles without fire-spread pins and with an empty facts block (item 38); no world starts (`LIBRARY_MISSING`); the library admin routes answer 503 `LIBRARY_TABLES_MISSING` |
| 250, 251 or 252 | No world row is created and no world starts; the world routes answer 409 `WORLD_NOT_AVAILABLE` with reason `TABLES_MISSING`; the session runs today's escalation |
| 253 | The world runs without units: the units panel says "Units are not available on this server yet."; the dispatch route answers 409 `WORLD_NOT_AVAILABLE` |
| 254 | The world runs with fog of war off for every session, whatever the setting, and the lobby card says so |
| 255 | Weather comes from `BUILTIN_WEATHER_PRESETS`; traffic is free flow; the console's preset list is the built-in one |

### 5.14 Server validation: `server/lib/fieldOps/worldSchemas.ts (new)`

zod schemas at the server edge (master 10.7 rule 2), each with an explicit size cap:

| Schema | Shape | Used by |
| --- | --- | --- |
| `weatherSettingSchema` | the `WeatherSetting` fields with the ranges of `WEATHER_LIMITS`; `haze_psi` only with `condition` `haze`, else null; `wind_from_deg` an integer | settings, the console, WS2's stored setting (request in section 15.3) |
| `worldSettingsSchema` | `WorldSettings`; at most 10 agencies' overrides and `WORLD_LIMITS.maxUnitsPerAgency` units of a kind; staging points inside the road box | `PATCH /settings` |
| `worldTargetSchema` | the `WorldTarget` union; ids at most 120 characters; points inside the road box; `floor` from -1 to 2 | dispatch, tasks, fires |
| `dispatchBodySchema` | `{ target: WorldTarget, task: UnitTask }` | dispatch |
| `taskBodySchema` | `{ task: UnitTask, target?: WorldTarget }` | set task |
| `reportBodySchema` | `{ entity_key, to_teams: string[] (at most 10, empty for every team), note: string up to 280 or null }`, the note passed through `moderateDeviceText(note, { maxLength: 280 })` | reports |
| `weatherBodySchema` | `{ weather: WeatherSetting, transition_s: 0 to 600 }` | the console |
| `roadBodySchema` | `{ reason: 'trainer' }` | close and open a road |
| `fireBodySchema` | `{ target: { kind: 'point', lat, lng, floor? } }` inside the primary building or an involved one | the console |
| `seedFileSchema` | the header of section 5.12 and one row schema per file, mirroring the SQL checks of sections 5.2, 5.6 and 5.8 | the seed route and the seed test |
| `materialPatchSchema`, `hazardPatchSchema`, `exposurePatchSchema`, `weatherEffectPatchSchema` | the editable columns of each table, with the SQL ranges; text through `moderateDeviceText(text, { maxLength })` | the admin edit routes |
| `reviewBodySchema` | `{ decision, reviewer_name, reviewer_qualification, checklist: Record<string, 'yes' \| 'no' \| 'not_applicable'>, notes?, expected_dataset_version }` | the review route |

## 6. Server

### 6.1 Module map (Proposed)

Everything lives under `server/services/fieldOps/world/ (new)`, the area master 10.8 item 38 names. Modules marked pure do no I/O and are tested without a database.

| Module | Kind | Exports |
| --- | --- | --- |
| `server/services/fieldOps/world/spreadLibrary.ts (new)` | database | `loadSpreadLibrary`, `invalidateSpreadLibrary`, `datasetVersionOf`, `reviewStateFor`, `worldAllowedFor`, `hazardEventsFor` (pure), `deteriorationFactsFor` (pure), `spreadTablesDetector` |
| `server/services/fieldOps/world/spreadLibraryAdmin.ts (new)` | database | `seedWorldTables`, `writeLibraryRow`, `retireLibraryRow`, `recordSpreadReview` |
| `server/services/fieldOps/world/compileSpread.ts (new)` | worker | `buildSpreadTimeline`, `SpreadTimelineError`, `SPREAD_LIMITS`, `prepareSpreadInput` (pure) |
| `server/services/fieldOps/world/worker/workerPool.ts (new)` | threads | `getWorldWorkerPool`, `runInWorker` for world threads, `runSpreadThread` for the short-lived spread threads |
| `server/services/fieldOps/world/worker/worldWorker.ts (new)` | worker entry | the message loop of section 6.11.2 |
| `server/services/fieldOps/world/worker/protocol.ts (new)` | types | `ToWorker`, `FromWorker` |
| `server/services/fieldOps/world/model/buildWorldModel.ts (new)` | pure | `buildWorldModel`, `worldInputsHash`, `WorldModelError` |
| `server/services/fieldOps/world/model/worldInputs.ts (new)` | database | `loadWorldInputs` |
| `server/services/fieldOps/world/model/prepareJob.ts (new)` | job kind | registers `fieldops_world_prepare` with WS0's `registerJobKind` |
| `server/services/fieldOps/world/model/worldModelStore.ts (new)` | database | `findWorldModel`, `saveWorldModel` |
| `server/services/fieldOps/world/model/worldModel.ts (new)` | types | `WorldModel` (section 5.11) |
| `server/services/fieldOps/world/engine/state.ts (new)` | pure | the state types, `createInitialState`, `serialiseState`, `restoreState`, `stateHash` |
| `server/services/fieldOps/world/engine/rng.ts (new)` | pure | `mulberry32`, `fnv1a32`, `streamFor` |
| `server/services/fieldOps/world/engine/grid.ts (new)` | pure | the neighbour tables, the active set, `flowField` |
| `server/services/fieldOps/world/engine/fire.ts (new)` | pure | `stepFire`, `stepCompartments` |
| `server/services/fieldOps/world/engine/smoke.ts (new)` | pure | `stepSmoke`, `stepGas` |
| `server/services/fieldOps/world/engine/structure.ts (new)` | pure | `applyBlast`, `stepStructure` |
| `server/services/fieldOps/world/engine/plumes.ts (new)` | pure | `stepPlumes`, `plumeRing` |
| `server/services/fieldOps/world/engine/crowd.ts (new)` | pure | `spawnGroups`, `stepCrowd` |
| `server/services/fieldOps/world/engine/exposure.ts (new)` | pure | `stepExposure` |
| `server/services/fieldOps/world/engine/actions.ts (new)` | pure | `stepTasks`, `applyCommand` |
| `server/services/fieldOps/world/engine/units.ts (new)` | pure | `stepUnits`, `planUnits` |
| `server/services/fieldOps/world/engine/weather.ts (new)` | pure | `stepWeather`, `weatherFactors` |
| `server/services/fieldOps/world/engine/visibility.ts (new)` | pure | `stepVisibility` |
| `server/services/fieldOps/world/engine/step.ts (new)` | pure | `stepWorld(state, model, ctx, commands): StepResult` |
| `server/services/fieldOps/world/roads/roadGraph.ts (new)` | pure | `buildRoadGraph`, `encodeRoadGraph`, `decodeRoadGraph`, `roadBoxFor`, `areaKeyOf`, `snapToGraph` |
| `server/services/fieldOps/world/roads/roadGraphStore.ts (new)` | database | `loadRoadRowsInBox`, `findRoadGraph`, `saveRoadGraph` |
| `server/services/fieldOps/world/roads/routing.ts (new)` | pure | `routeUnit`, `edgeTimeS` |
| `server/services/fieldOps/world/roads/traffic.ts (new)` | pure | `trafficFactor`, `incidentFactor` |
| `server/services/fieldOps/world/weather/weatherData.ts (new)` | database | `loadWeatherPresets`, `loadTrafficProfiles`, `loadRoadSpeedClasses` |
| `server/services/fieldOps/world/fog/views.ts (new)` | pure | `buildView`, `buildDelta`, `teamCover`, `canSeeEvent` |
| `server/services/fieldOps/world/fog/fogFilter.ts (new)` | database and pure | `filterHazardRowsForViewer`, `filterCasualtyRowsForViewer`, `filterPlacementRowsForViewer`, `viewerOf`, `isFogSession`, `redactForFog` |
| `server/services/fieldOps/world/bridge/pinBridge.ts (new)` | database | `applyBridgeOps`, `handBackWorldPins`, `sweepInspectionPoint` |
| `server/services/fieldOps/world/bridge/worldGates.ts (new)` | cache | `isWorldActive`, `isWorldOwned`, `worldExitFactor`, `deviceDetonated(sessionId, sceneItemId)`, which queues a `device_detonated` command when the session's world is active |
| `server/services/fieldOps/world/runtime/worldRuntime.ts (new)` | process | `getWorldRuntime`, `startWorldRuntime`, `stopWorldRuntime` |
| `server/services/fieldOps/world/runtime/worldStore.ts (new)` | database | every read and write of migrations 251 to 254 |
| `server/services/fieldOps/world/runtime/backPressure.ts (new)` | pure | `nextDegradeLevel` |
| `server/services/fieldOps/world/index.ts (new)` | | the exports of section 6.18 |

Two routers: `server/routes/fieldOpsWorld.ts (new)` (the session world, master 10.3) and `server/routes/fieldOpsSpreadLibrary.ts (new)` (the library's admin routes). The settings reader is `server/lib/fieldOps/worldSettings.ts (new)`.

### 6.2 The spread library

```ts
// server/services/fieldOps/world/spreadLibrary.ts (new). Owned by WS9.
import type { HazardEvent } from '../../rtsSceneEnrichmentService.js';
import type { SpreadHazardInput, SpreadLibrary } from '../../../../shared/fieldOps/world.js';

/** Null while migration 249 is missing, while its tables hold no complete active library, or on a read failure with no earlier good library. */
export declare function loadSpreadLibrary(): Promise<SpreadLibrary | null>;
export declare function invalidateSpreadLibrary(): void;
/** Steps 4 to 7 below as a pure function, so tests and the seed check build a library without a database. */
export declare function buildSpreadLibrary(
  rows: CanonicalSpreadRows,
  reviews: readonly SpreadReviewRow[],
): { library: SpreadLibrary | null; outcome: 'ok' | 'empty' | 'invalid'; problems: string[] };
/** First 16 hex characters of the SHA-256 of the canonical active rows (below). */
export declare function datasetVersionOf(rows: CanonicalSpreadRows): string;
export declare function reviewStateFor(reviews: readonly SpreadReviewRow[], modelVersion: string, datasetVersion: string): SpreadLibrary['review'];
/** False with no library. Outside production true. In production true when reviewed, else only for an admin trainer (W24). */
export declare function worldAllowedFor(trainerRole: string | undefined, library: SpreadLibrary | null): boolean;
export declare function hazardEventsFor(hazard: SpreadHazardInput, library: SpreadLibrary): HazardEvent[];
export declare function deteriorationFactsFor(
  hazards: Array<{ label: string; hazard_type: string; properties?: Record<string, unknown> }>,
  casualties: Array<{ casualty_type: string; conditions?: Record<string, unknown> }>,
  library: SpreadLibrary | null,
): string;
```

`loadSpreadLibrary` runs these steps:

1. `spreadTablesDetector`, a WS0 cached detector on `fieldops_spread_materials`, says whether 249 is applied. Missing: answer null and log `fieldops_spread_library_missing` at most once a minute.
2. A cached library younger than 60 seconds is returned as it is. Every admin write calls `invalidateSpreadLibrary`.
3. Read the active rows of the four tables with explicit column lists and map them to `MaterialBehaviour`, `HazardBehaviour`, `ExposureBehaviour` and `WeatherEffect`; numbers come back as JavaScript numbers, arrays as arrays.
4. Check integrity: every key of `SPREAD_REQUIRED_KEYS`, every exposure agent and every weather condition is present; every hazard's `contents_key` names an active `contents` row; no alias resolves to two keys; incapacitation bands ascend; every number is finite; the canonical JSON of the library is at most 262,144 bytes, so WS5 can freeze it in a stage checkpoint (its Choice 17; the seed library is about 40 KB). No active row at all is "empty", logged `fieldops_spread_library_empty`; anything else wrong is logged `fieldops_spread_library_invalid` with the failing keys. Either way the answer is the last good library this process loaded, or null.
5. Build `aliases`: each key maps to itself, then each alias, normalised with `normaliseMaterialText`, maps to its key.
6. `dataset_version` is the first 16 hex characters of the SHA-256 of the canonical JSON of the active rows: keys sorted, rows ordered by their key, numbers written as decimal strings without trailing zeros, over materials, hazards, exposure and weather effects in that order, without status, version, actor and timestamp columns. The seed files give the same version as the tables seeded from them (AC9.3). `version` is `fo-spread-1.0.0:` followed by the dataset version, the label WS5 records in its spread record.
7. `review` comes from `reviewStateFor` over `fieldops_spread_reviews`: the latest row for `SPREAD_MODEL_VERSION` and this `dataset_version` decides; `approved` is `reviewed`, anything else or no row `unreviewed`.

**Admin writes** (`spreadLibraryAdmin.ts`), behind the admin routes of section 6.14: `seedWorldTables` fills every empty WS9 table (249, 253 and 255) from its seed file after `seedFileSchema`, and refuses a table that already has rows; `writeLibraryRow` updates one row, increments `row_version` and writes a change row with the dataset versions before and after; `retireLibraryRow` sets `status` to `retired`; `recordSpreadReview` refuses a stale view (409 `VERSION_MISMATCH` unless `expected_dataset_version` is the current one), refuses `approved` unless every checklist answer is `yes` or `not_applicable` (409 `REVIEW_INCOMPLETE`), and stores the canonical rows in `library_snapshot`. Every text field passes `moderateDeviceText(text, { maxLength })` (WS6, master 10.8 item 24) before it is written (AC9.55). The review checklist covers: the wall burn-through times, the contents spread and burn rates, the structural frames, the exposure bands and shares, the hazard rows, the weather factors, the road speeds and traffic shares, the source of every row, and the absence of device content.

### 6.3 `hazardEventsFor`

Deterministic, pure, the replacement for the per-hazard model analysis (`HazardAnalysis.events`, master 10.8 item 38). It returns today's `HazardEvent` shape (`server/services/rtsSceneEnrichmentService.ts:113-124`) and never a model's words.

```text
hazardEventsFor(hazard, library):
  row ← library.hazards[hazard.hazardType]
  if row is missing, or row.trigger_on ≠ 'blast', or row.event_type is null: return []
      // 'ignition' rows react when fire reaches their cells: the batch simulation expresses that
      // through row.acceleration (section 6.5); the live world through the cell's contents (section 6.7.2)
  if hazard.blast is null or hazard.blast.band = 'outside': return []
      // the blast does not reach it with force; fire spreading into it still finds its acceleration
  arrival ← round(hazard.blast.distance_m / 340)
      // the blast wave at the speed of sound, as today's prompt tells the model (rtsSceneEnrichmentService.ts:203)
  delay ← hazard.blast.within_thermal and row.spread_kind = 'fire' ? 0 : row.delay_s
  material ← hazard.material resolves (resolveMaterialKey, role 'contents') to a key other than contents_generic
             ? library.materials[that key] : null
  radius ← min(row.max_radius_m, max(row.radius_m[hazard.severity], hazard.radius))
  return [{
    triggerTimeSec: arrival + delay,
    eventType: row.event_type,
    spreadType: row.spread_kind,
    spreadRadius: round to 0.1 m (radius),
    spreadRate: material and row.spread_kind = 'fire' ? material.flame_spread_m_min : row.spread_rate_m_min,
    description: row.event_text,
    severity: hazard.severity,
    smokeGeneration: material ? material.smoke_yield : row.smoke_yield,
  }]
```

One event per hazard in version 1; `affectedStuds` is left out (it is optional). `triggerTimeSec` is in simulation seconds, which `runEnvironmentalSimulation` compares with its elapsed simulation time (`server/services/environmentalSimService.ts:264-279`); at the time scale of 1 that `buildSpreadTimeline` uses, they are also game seconds. The trainer's drawn radius widens the event but never beyond the row's maximum. WS4's `SceneHazard` now has an optional `material`, chosen in the hazard panel from `CONTENTS_MATERIAL_OPTIONS` and checked against its keys on save (`05-layout-step.md` sections 5.4, 5.7 and 7.7, AC4.30). WS5 passes it as `CompileSpreadHazard.material` (`06-compile-and-review.md` section 6.16), and the world model reads it from the scene (section 6.6.3). When it is absent or null, or resolves only to `contents_generic`, the hazard type's own row decides, as before.

### 6.4 `deteriorationFactsFor`

Deterministic and pure. It replaces the output of `researchDeteriorationPhysics` as the `deteriorationResearch` string of `generateDeteriorationTimeline` (master 10.8 item 38), keeping the three headings that `deteriorationResearchToPromptBlock` writes today (`server/services/warroomResearchService.ts:1664-1680`) so the generator's prompt needs no change. It reads each hazard's `label` and `hazard_type` and each casualty's `casualty_type` only; `properties` and `conditions` are never read, so no device field can reach the text.

```text
deteriorationFactsFor(hazards, casualties, library):
  if library is null or hazards is empty: return ''
  types ← for each hazard h, in order, typeOf(h.hazard_type), dropping nulls, de-duplicated in first-seen order
      // typeOf: the type itself when the library has it; otherwise by keyword: fire|blaze|flame|smoke → 'fire';
      // gas|chemical|toxic|hazmat|spill → 'chemical'; collapse|structural|debris → 'debris_risk';
      // electric → 'electrical'; anything else → null (no block)
  for each type t (at most 7):
    row ← library.hazards[t]; contents ← library.materials[row.contents_key] when set
    labels ← the labels of the hazards of type t: the first five, then "and {n} more"
    block(t) ←
      "[" + row.label + ": " + labels + "]"
      "  Dispersion: " + row.fact_dispersion
      "  Structural: " + row.fact_structural
      "  Timeline: Reacts " + row.delay_s + " s after the blast reaches it; spreads about "
          + row.spread_rate_m_min + " m a minute up to " + row.max_radius_m + " m"
          + (contents ? "; its contents burn for about " + contents.burn_duration_s + " s per 3 m" : "") + "."
      "  Source: " + row.source_ref
  interactions ← for each pair of distinct present types (a, b) in first-seen order, each entry of
      library.hazards[a].interactions whose `with` is b, at most six lines:
      row(a).label + " + " + row(b).label + ": " + interaction + " → " + compound_effect + " (" + timeline + ")"
  notes ← the patient_note of 'smoke' and 'heat', of 'toxic_gas' when 'chemical' is present, and of
      'collapse' when 'debris_risk' or 'falling_object' is present, de-duplicated, joined by spaces;
      empty when no casualty has casualty_type 'patient'
  text ← "HAZARD PHYSICS:\n" + blocks joined by blank lines
       + "\n\nCROSS-HAZARD INTERACTIONS:\n" + interactions joined by new lines
       + "\n\nPATIENT DETERIORATION NOTES:\n" + notes
  while text is longer than 6,000 characters:
      drop the last interaction line; when none is left, drop the Dispersion line of the last block that has one
  return text
```

Every number in the text is a library value, and the text never exceeds 6,000 characters, the length WS5 keeps (`06-compile-and-review.md` section 6.16; AC9.6). WS5 passes the text into its existing data block; it is stored, reviewed data, not instructions (section 8). Blocks are per hazard type rather than per hazard because hazards of one type share one row: repeating the row's lines for twelve combustible hazards would say nothing new and would break the length.

### 6.5 `buildSpreadTimeline` and the change to the simulation

```ts
// server/services/fieldOps/world/compileSpread.ts (new). Owned by WS9.
import type { SimStud, SimWall } from '../../environmentalSimService.js';
import type { EnvironmentalSnapshot } from '../../rtsSceneEnrichmentService.js';
import type { SpreadHazardInput, SpreadLibrary } from '../../../../shared/fieldOps/world.js';

export interface SpreadTimelineInput {
  studs: SimStud[];                                   // WS5's compile grid in sim-space metres, every stud (section 3.2)
  walls: SimWall[];                                   // the primary building's interior walls, materials as the trainer wrote them
  /** WS5's CompileSpreadHazard[] (06 section 6.16) is assignable to this. */
  hazards: Array<SpreadHazardInput & { pos: { x: number; y: number } }>;
  library: SpreadLibrary;
  durationMin: number;                                // setup_v2.options.duration_minutes, 20 to 240
  /** Optional. When it aborts, the worker is stopped and the promise rejects with 'aborted' (WS5's 90-second budget). */
  signal?: AbortSignal;
}

/** timeoutMs is a backstop above WS5's SPREAD_TIMELINE_BUDGET_MS of 90 seconds, for callers that pass no signal. */
export const SPREAD_LIMITS = { maxStuds: 20_000, reachM: 60, timeoutMs: 120_000, maxDurationMin: 240, maxConcurrent: 2 } as const;

export type SpreadTimelineErrorCode = 'timeout' | 'aborted' | 'worker_failed' | 'input_invalid';
export class SpreadTimelineError extends Error {
  readonly code: SpreadTimelineErrorCode;
  constructor(code: SpreadTimelineErrorCode, message: string);
}

/** Runs today's runEnvironmentalSimulation in a worker thread with the stored parameters (master 10.8 item 38). */
export declare function buildSpreadTimeline(input: SpreadTimelineInput): Promise<EnvironmentalSnapshot[]>;
/** The pure preparation the worker receives; exported for tests. */
export declare function prepareSpreadInput(input: SpreadTimelineInput): PreparedSpreadInput;
```

**The change to today's function (touched).** `runEnvironmentalSimulation` (`server/services/environmentalSimService.ts:202-210`) gains an optional eighth argument, after `snapshotTimesMin`:

```ts
// server/services/environmentalSimService.ts (touched). Additive: without params the function is exactly today's.
export interface EnvSimParams {
  /** Seconds of fire resistance by resolved material key; Infinity for walls that hold. Looked up exactly. */
  wallResistanceByKey: Record<string, number>;
  /** The key used for a wall whose material is not in the table. */
  fallbackWallKey: string;
  hazardAcceleration: Record<string, number>;
  burnDurationS: number;
  heatTransferS: number;
}
```

With `params` set, the function uses `params.wallResistanceByKey[wall.material] ?? params.wallResistanceByKey[params.fallbackWallKey]` where today it calls `lookupResistance`, `params.hazardAcceleration` where it reads `DEFAULT_HAZARD_ACCELERATION`, and the two durations where it reads `BURN_DURATION` and `HEAT_TRANSFER_RATE`. Every other line is unchanged, so the legacy caller (`server/services/rtsSceneEnrichmentService.ts:826-831`) gets byte-identical output (AC9.10).

**`prepareSpreadInput`** (pure):

1. Refuse with `input_invalid` a duration outside 1 to 240 minutes, a non-finite coordinate, or more than 300 walls or 60 hazards (WS4's `LAYOUT_LIMITS`).
2. Studs: de-duplicate by id keeping the first; drop interior studs of any floor but the ground (an id of the form `bldg-{i}-{floor}-…` with a floor other than `G`), because the simulation's neighbour test ignores floors (section 3.2); keep exterior studs once. When more than `SPREAD_LIMITS.maxStuds` remain, keep those within `reachM` of a hazard, nearest first, and then the nearest `maxStuds`.
3. Walls: each `material` is replaced by `resolveMaterialKey(material, 'wall', library)`, so an empty material is `unknown_wall` (AC9.11).
4. Hazards: each becomes a `SimHazard` with its `id` and `pos`, a `radius` of `min(row.max_radius_m, max(row.radius_m[severity], hazard.radius))` (the radius `hazardEventsFor` uses, so fire can spread through the hazard's reach as the library says, where today's caller forced 5 m), and a `hazardType` that is the row's type, or `m:<key>` when the hazard's `material` resolves to a contents key; and a `HazardAnalysis` whose `events` are `hazardEventsFor(hazard, library)` and whose text fields are empty strings (the simulation reads only `hazardId` and `events`). WS5's extra fields (`building_key`, `blast`, `material`) are read here and not passed on.
5. Params: `wallResistanceByKey` from the wall rows (`burn_through_s`, or `Infinity` when it holds); `fallbackWallKey` `unknown_wall`; `hazardAcceleration` from the hazard rows' `acceleration`, plus one `m:<key>` entry per contents material in use, from its growth class (slow 1, medium 2, fast 3, ultra-fast 5, none 0); `burnDurationS` and `heatTransferS` from `contents_generic` (its `burn_duration_s`, and 60 times the 5 m spacing over its `flame_spread_m_min`).
6. Snapshot minutes: today's `DEFAULT_SNAPSHOT_TIMES_MIN` (0, 1, 3, 5, 10, 15, 20, 30, 45 and 60) up to the duration, then every 15 minutes after 60 up to the duration. That holds the 5, 10, 15, 20 and 30 minutes today's pins read and the later minutes WS5 asks for (`06-compile-and-review.md` section 15.4).
7. Time scale 1: the library's seconds are real seconds, where today's default of 0.5 halved them.

**`buildSpreadTimeline`** posts `{ op: 'spread_timeline' }` to a short-lived spread thread of its own (`runSpreadThread`, section 6.11.2), never to a thread that hosts worlds, which calls `runEnvironmentalSimulation(studs, walls, hazards, analyses, durationMin, 1, snapshotMinutes, params)` and returns the snapshots, keyed by the input stud ids so WS5 can hand them to `generateFireSpreadSpawnPins` unchanged. When `input.signal` aborts, that thread is terminated and the promise rejects with `aborted`; WS5 passes a signal that aborts at its 90-second `SPREAD_TIMELINE_BUDGET_MS` or with its stage, so a simulation WS5 has stopped waiting for no longer holds a thread. A job that runs past `SPREAD_LIMITS.timeoutMs` without a signal is stopped the same way and rejects with `timeout`; a worker error rejects with `worker_failed`. It logs `fieldops_spread_timeline_built { studs_in, studs_used, hazards, events, snapshots, ms }` or `fieldops_spread_timeline_failed { code, ms }`. WS5's own timer gives `timeout` when it fires first, and any rejection gives `failed`; both mean no fire-spread pins, a manifest warning and a Review item, and neither fails the job (`06-compile-and-review.md` section 6.16).

**What the timeline does not take.** No weather: master 10.8 item 38 fixes the inputs, and the batch simulation has no outdoor fire or plume for weather to change, because its fire stays inside the hazard radii and its smoke is a per-stud level (section 3.2). Weather acts in the live world (section 6.9), which is where the trainer sees fire and plumes move. WS5 offered to pass a `WeatherSetting`; version 1 declines (section 15.4).

### 6.6 The world model

#### 6.6.1 Every detail the trainer gives (D36)

| Detail | Read from | Becomes in the world |
| --- | --- | --- |
| The scene description | the setup copy's `brief.description` | Weather words when the label and the setting are empty (the fourth argument of `weatherFromLabel`). No model reads it here |
| The incident's time | `incident.when` | `when`, the night flag (section 5.10.2), the traffic hour, the stability of plumes at night |
| The weather | `options.weather_setting`, else `weatherFromLabel(options.weather, when, presets, description)`, else the lobby's override | `weather` (section 6.9) |
| The headcount | `incident.people_present`, else the scene's `crowd_headcount` | The crowd groups, less the compiled casualties |
| The devices and their effects | WS5's physics snapshot (`CompileEffects`) | `devices`: position, floor and the structural, glass, thermal and minor radii; the main device's blast at T+0 |
| The site | `site.primary`, `site.involved` | The frame, the primary's grid and one compartment per involved building |
| The building type and levels | WS3's `loadSiteArea(site)`, the footprint whose `osm_id` is the primary's | The contents and frame keys (section 5.12.2) and the highest modelled floor |
| The walls, their materials and doors | `authored.primary.interior_walls` | Wall edges with a resolved material key, door gaps and glazing |
| The stairwells | `authored.primary.stairwells` | Stair cells linking floors; a blocked stairwell is closed to the crowd |
| The exits | the primary's `exits` and each involved layout's `exits` | Exit cells and compartment exits with their widths; a `blocked` exit starts closed |
| The inspection points | the scene's wall points (the primary's generated points and each involved layout's `wall_points`) | Vent points where smoke leaves a building, and the places an EOD team sweeps (section 6.8.8) |
| The hazards | `authored.hazards` | Hazard records with their cells, contents and behaviour row |
| The crowd zones | `crowd_zones` through WS4's `toCrowdZoneInputs` | Crowd groups at the zones' cells, compartments or outdoor rings |
| The operational zones | `authored.operational_zones` | The hot, warm and cold rings units are kept to (section 6.8.6) |
| The agencies | the setup copy's `agencies` and the scenario's `scenario_teams` | Agencies with their archetype, zone access and action flags; the unit plan |
| The decoys | `authored.decoys` | Nothing: a decoy is found by today's sweep, not simulated |

AC9.14 builds the mockup fixture and checks that each row lands.

#### 6.6.2 Inputs

`loadWorldInputs(scenarioId)` in `server/services/fieldOps/world/model/worldInputs.ts (new)` reads, with the service role:

1. **The revision.** The latest `revision_no` of WS8's `fieldops_scenario_revisions` (`09-after-publish.md` section 5.3), or null when migration 246 is missing.
2. **The setup copy.** WS8's `fieldops_scenario_setups.setup_v2`, else the `setup_v2` of the draft whose `scenario_id` is this scenario (WS5 never writes that draft after publish), else the model fails with `MODEL_FAILED` and reason `setup_missing`.
3. **The scene.** WS4's `loadSceneByScenario(ctx, scenarioId): Promise<SceneLoadView>` (`server/services/fieldOps/layout/index.ts (new)`, `05-layout-step.md` section 6.4). The world reads the view's `scene`, a `SceneConfigV2` with its wall points and each hazard's `material`, and ignores `photos`, `readiness` and `read_only`. `ctx` is a `SceneCtx` (`server/services/fieldOps/layout/sceneStore.ts (new)`) that the job builds: its `user` is the scenario's creator (`scenarios.created_by`, `migrations/001_initial_schema.sql:53`) with that user's role, so WS4's by-scenario rule admits it whoever runs the session (`05-layout-step.md` section 6.5); its `repo`, `loadSiteArea` and `moderateDeviceText` are WS4's production wiring, and `now` the clock. `SCENARIO_SCENE_NOT_FOUND`, a null `scene` or a legacy scene (`schema_version` 1): not eligible (section 6.11.1). `LAYOUT_STORE_UNAVAILABLE`: the inputs stage fails and WS0's job engine retries it.
4. **The physics.** WS5's `loadPhysicsSnapshot(scenarioId)` (`server/services/fieldOps/compile/snapshotReaders.ts (new)`, `06-compile-and-review.md` section 6.15), which answers the mode, the review flag and `CompileEffects` without the device pool. Each device's radii come from its `estimate`, WS6's `EffectEstimate` (`07-device-and-physics.md` section 5.3): `glass_breakage`, `structural_light`, `structural_moderate` and `structural_severe` from `structural[].radius.central`, `thermal_m` from `thermal.radius.central`, `minor_m` from `bands_m.minor`. In `legacy_bands` mode there are no structural radii, so the world maps the bands it has: `lethal` as severe, `serious` as moderate, `minor` as light and as glass. No snapshot: the world starts without a blast.
5. **The teams.** `scenario_teams` (`team_name`, `function_key`, and `operation` when WS7's migration 242 is applied), each with WS1's `actionScopeFor({ team_name, function_key })` (`shared/fieldOps/actionScope.ts (new)`) for `zone_access`, `can_triage` and `can_sweep`.
6. **The site area and facilities.** WS3's `loadSiteArea(site)` for the primary's `place_class` and `levels`, and `listFacilitiesNear(site.centre, { radiusM: 10000, kinds: ['fire_station', 'police', 'ambulance_station', 'hospital', 'power_substation'], maxPerKind: 10 })` (`04-site-picker.md` sections 6.5 and 6.9), neither of which calls a network service.
7. **Stored data.** `loadSpreadLibrary()` (null fails the model with `LIBRARY_MISSING`), the road speed classes, the weather presets and the traffic profiles.

Nothing is read from a `scenarios` column that master 10.8 item 16 keeps clean, and nothing here calls a model.

#### 6.6.3 The grid

```text
ring ← the primary polygon in sim space (WS4's projectRing, shared/fieldOps/sceneGeometry.ts)
floors ← sorted unique {0} ∪ the stairwells' connectsFloors ∪ the devices' floors, clipped to -1..2;
         when WS3 knows the primary's levels L, floors above L − 1 are dropped; at most 4, keeping those nearest 0
for cell_m in 3, 4, 5:
    cols ← ceil(ring width / cell_m); rows ← ceil(ring height / cell_m); grid_x0, grid_y0 ← the ring's minimum x and y
    inside(c) ← the centre of c is inside the ring (WS4's pointInRing)
    if count(inside) × |floors| ≤ 20,000: stop
otherwise fail with WORLD_TOO_LARGE
index(floor, row, col) ← floorIndex × cols × rows + row × cols + col
contents(c) ← the building's contents key (section 5.12.2); on floor 0, inside a hazard's radius, the hazard's own material
              when WS4's hazard panel set one (SceneHazard.material, a key of CONTENTS_MATERIAL_OPTIONS), else the
              hazard row's contents_key, the hazard nearest the cell winning
```

No exterior padding: outdoors is handled by plumes, compartments and straight-line movement (W7). A 60 m by 40 m building at 3 m gives 20 by 14 cells, 280 per floor, where today's runtime grid gives about 13,600 studs per floor (section 3.2).

#### 6.6.4 Walls, doors, exits and stairwells

```text
for each modelled floor, for each pair of 8-neighbour cells (a, b) both inside:
    s ← the segment from the centre of a to the centre of b
    for each interior wall w whose bounding box meets s (walls are bucketed on a 12 m grid first):
        if s crosses w (the test of segmentsIntersect, server/services/environmentalSimService.ts:115-125):
            door ← w.hasDoor and the crossing lies inside the door gap (the gap rule of wallBlocksPath, :127-141)
            edge ← { a, b, material_key: resolveMaterialKey(w.material, 'wall', library), door, glazed: the material's glazed }
    when two walls cross the same edge, the one with the longer burn-through wins
exits ← each primary exit at the inside cell of floor 0 nearest its centre, with its width; status 'blocked' starts closed
stairs ← each stairwell at the inside cell nearest its position, on both floors it connects when both are modelled;
         'blocked' closes it to the crowd; fire and smoke still pass, as through an open shaft
compartments ← each involved layout: its polygon, area, centroid, exits (WS4's FootprintExit), contents and frame by its own place class
```

The outline of the primary building has no cells outside it: a person leaves only through an exit, and smoke leaves through exits, broken glazing, breaches of the outline at wall points and ventilated openings.

#### 6.6.5 Crowd, devices, hazards and everything else

- **Crowd.** `toCrowdZoneInputs(crowdGeometryOf(scene), headcount)` (`shared/fieldOps/crowd.ts (new)`, WS4) gives one input per painted zone and the remainder. A zone's moving people are its count less the compiled casualties standing in it: the black, red and yellow counts of WS5's casualty plan for that `crowd_zone_id` (`CompileCasualtyPlan`, `06-compile-and-review.md` section 5.5), or, with no plan, the headcount of compiled patient pins inside the zone's polygon (Assumed (D10)). Green casualties walk out with the crowd. A primary-interior zone keeps the inside cells of floor 0 whose centre lies in its polygon; the remainder keeps every inside cell of every modelled floor, spread evenly; an involved-interior zone keeps its compartment; an outdoor zone keeps its ring.
- **Devices.** One record per placed device with a `CompileDeviceEffect`: position, floor and radii (section 6.6.2). The main device (role `main`, else index 0) applies its blast at tick 0 (section 6.7.4). Every other device applies its blast only when today's detonation timer fires for it (section 6.12). Device records never leave the server except as the trainer's markers.
- **Hazards.** Each of `authored.hazards`: its scene item id, type, severity, radius, position, cell (floor 0) or compartment, and its behaviour row.
- **Operational zones.** The hot, warm and cold rings of `authored.operational_zones`, centred on the main device when their centre is null.
- **Wall points.** Each wall point with its position and building key.
- **Origins.** The facilities of section 6.6.2 and the entry points of section 6.8.2.
- **Agencies and the unit plan.** Section 6.8.1.

#### 6.6.6 The inputs hash and the prepare job

`worldInputsHash` is the SHA-256 hex of the canonical JSON of `WORLD_ENGINE_VERSION`, the scenario id, the revision, the scene id and layout revision, the hash of the setup copy, the physics snapshot's id and mode, the library's `dataset_version`, WS3's data-version label, the hashes of the weather presets, road speeds and traffic profiles, and each team's name, `function_key` and `operation`. A model with the same hash is reused by every session of the scenario.

`server/services/fieldOps/world/model/prepareJob.ts (new)` registers the job kind `fieldops_world_prepare` with WS0's `registerJobKind` (`01-prerequisites.md` section 6.10.1) when the module is imported:

| Field | Value |
| --- | --- |
| `kind` and `handlers()` | `fieldops_world_prepare` |
| `locksDraft`, `lockKey`, `consumesCredit` | false, null, false: no draft and no credit (D27 untouched) |
| `maxJobAttempts` | 2 |
| `draftStatusOnFail` | `restore` (no draft is involved) |
| `params` | `{ scenario_id, session_id }`, with `draft_id` null and `created_by` the session's trainer |
| Stage `inputs` | `loadWorldInputs`; 2 attempts, 60 seconds; summary: counts only |
| Stage `roads` | find the cached road graph for the box and data version, or build it in a worker and save it (section 6.8.3); 2 attempts, 180 seconds |
| Stage `model` | `buildWorldModel(inputs, library, roads)` in a worker; a `WorldModelError` such as `WORLD_TOO_LARGE` fails the job with that code; 2 attempts, 120 seconds |
| Stage `persist` | `saveWorldModel` (an upsert on scenario and inputs hash), then the waiting world sessions of the scenario get `model_id` and `ready`; 3 attempts, 30 seconds |

There is no commit step, so the runner passes the last summary to `completeJob` (master 10.8 item 3). Stages report with `ctx.progress(message, done, total)` and stop on `ctx.signal` (master 10.8 item 32). The job counts against the trainer's `FIELDOPS_JOBS_MAX_ACTIVE_PER_USER`; refused with `too_many_jobs`, the runtime tries again 30 seconds later.

### 6.7 The engine

#### 6.7.1 State and the order of a tick

`stepWorld(state, model, ctx, commands)` advances the world by one second. It is pure: `ctx` holds the library, the decoded road graph, the traffic and speed tables and the weather presets; everything it changes is in `state`; everything it reports is in its result (events, bridge operations, unit and knowledge changes, rejected commands).

```text
stepWorld(state, model, ctx, commands):        // state.tick = t
  1. commands with apply_tick = t, in id order: applyCommand (section 6.7.9); a refused one is reported, never thrown
  2. stepWeather: move wind and rain one second along a transition (section 6.9.3)
  3. at t = 0: applyBlast for the main device; any tick: applyBlast for a device_detonated command
  4. hazard triggers whose time has come (section 6.7.2)
  5. stepFire and stepCompartments
  6. stepSmoke and stepGas, collecting what leaves through openings
  7. stepStructure
  8. stepUnits (movement, deployment) and stepTasks (the effects of working units)
  9. stepCrowd
 10. stepExposure
 11. every 5 ticks: stepPlumes
 12. every 2 ticks: stepVisibility (cover and knowledge, section 6.10)
 13. every 5 ticks: the bridge operations (section 6.12.2)
 14. counters; state.tick ← t + 1
```

Only the active set is stepped in steps 5 to 7: cells that burn, heat, hold smoke or gas, or whose damage is changing, and their neighbours. A building with nothing happening in it costs almost nothing, which is the master's "only near active hazards" (master risk 19).

#### 6.7.2 Fire

Cell fire states are 0 none, 1 heating, 2 burning, 3 burnt out and 4 wet. `ignition(c)` is `round(60 × cell_m / flame_spread_m_min(contents(c)))` seconds: how long a cell takes to catch from one burning neighbour across an open edge, which makes the front advance at the material's flame-spread rate (AC9.16).

```text
for each burning cell c (state 2):
    fuel(c) ← fuel(c) − 1; at 0: state 3 (burnt out)
    for each neighbour n on the same floor in state 0 or 1, combustible and not wet:
        if the edge (c, n) is a wall edge without a door:
            if its burn_through_s is null: skip                   // it holds
            breach(edge) ← breach(edge) + 1
            if breach(edge) < burn_through_s: skip                // the first time it reaches it: event wall_breached
        w ← (diagonal ? 0.7 : 1) × windBias(c, n) × ventBoost(n)
        heat(n) ← heat(n) + w; state(n) ← 1
    a burning stair cell heats the stair cell of the linked floors the same way
for each heating cell n: if heat(n) ≥ ignition(n): state 2, fuel(n) ← burn_duration_s(contents(n));
                         with no burning neighbour this second: heat(n) ← max(0, heat(n) − 1)
trigger: a hazard whose row says 'blast' reacts at triggerTimeSec of hazardEventsFor (with the world's blast record);
         one whose row says 'ignition' reacts when one of its cells starts burning:
         fire rows set every combustible cell inside the event radius to burning; gas rows start a gas source;
         structural_zone rows add 300 permille of damage inside the radius, at most 1000
```

`windBias(c, n)` is 1 except in a ventilated cell (within 6 m of an open exit, a breach, broken glazing or a vented opening), where it is `1 + 0.5 × min(1, wind_speed_ms / 10) × cos θ`, θ being the angle between the direction from c to n and the direction the wind blows towards; it lies between 0.5 and 1.5. The eight values for the eight neighbour directions are computed once per weather change and stored as permille integers. `ventBoost(n)` is 1.2 within 12 m of a `ventilate` task, because air feeds the fire as well as clearing the smoke (AC9.17).

**Compartments** (involved buildings, W6). A compartment ignites when a hazard inside it reacts, when the trainer starts a fire in it, or when a neighbouring building less than 6 m away has been fully involved for 300 seconds. Its involvement grows by `1000 / t_full` permille a second, where `t_full = ceil(60 × sqrt(area_m2) / flame_spread_m_min(contents))`; at full involvement it burns for twice its contents' `burn_duration_s`, then dies down over 600 seconds. Its smoke rises by `involvement × yield / 1000` a second (yield as in section 6.7.3), capped at 1000, and vents to a plume source at its centroid. Its damage rises by `1000 / (fire_resistance_min × 60) × involvement / 1000` a second. Outdoor weather multiplies the growth of an involved building by its `outdoor_spread` factor only when its involvement has passed 800, when the fire has broken through to the outside (Assumed (D35)).

#### 6.7.3 Smoke and gas

```text
yield ← { none: 0, light: 15, moderate: 30, heavy: 45, toxic: 45 } permille a second, from contents(c).smoke_yield;
        a toxic yield also marks the cell's smoke toxic
for each burning cell: smoke ← min(1000, smoke + yield); for each heating cell: smoke ← min(1000, smoke + 5)
for each pair of neighbours (a, b) on a floor with smoke(a) > smoke(b) + 20:
    rate ← 25 permille of the difference a second            // today's 0.025 (section 3.2)
         × (diagonal ? 0.7 : 1)
         × (a wall edge without a door, not breached: the wall's smoke_leak; otherwise 1)
         × windBias(a, b)
    move rate × (smoke(a) − smoke(b)) / 1000 from a to b
stairs: a stair cell passes 50 permille of its smoke a second to the stair cell of the floor above and 5 to the floor below
decay: 2 permille a second indoors (today's 0.002); 8 within 6 m of an open exit, breach or broken glazing;
       20 within 12 m of a ventilate task; what decays at an opening is added to that opening's plume source
gas: the same scheme with a transfer of 20 permille, walls' gas_leak and a decay of 5 (today's 0.02 and 0.005);
     a gas source raises the cells inside its radius to its source_rate for its duration_s
visibility(c) ← today's smoke bands: above 800 permille 0.5 m, 600 1 m, 400 3 m, 200 8 m, 50 12 m, else 15 m
```

#### 6.7.4 Structure and the blast

Damage is held per cell (and per compartment) in permille; `structureStateOf` turns it into a state: sound below 250, damaged to 499, unsafe to 849, collapsed from 850.

```text
applyBlast(device):                              // WS6's radii; distances in metres from the device
    for each cell on the device's floor:          // ±1 floor: half the radii; farther floors: nothing
        d ← distance from the device to the cell centre
        d ≤ structural_severe_m   → damage ← max(damage, 600)     // unsafe
        d ≤ structural_moderate_m → damage ← max(damage, 400)     // damaged
        d ≤ structural_light_m    → damage ← max(damage, 250)     // damaged
    each glazed wall edge within glass_breakage_m: becomes an opening (event glazing_failed)
    each combustible cell within thermal_m: burning
    each compartment within structural_severe_m of its outline: damage ← max(damage, 600); within thermal_m: ignites
    hazards whose row triggers on 'blast' get their blast record (distance, band, within the thermal radius) for hazardEventsFor
    event blast_applied, trainer audience only

stepStructure, for each cell with damage > 0:
    fire ← burning: 1; heating: 0.3; else 0
    damage += fire × (1000 / (fire_resistance_min(frame) × 60)) × (1 + damage / 1000)
    if damage ≥ 500 and not shored: damage += creep_per_min(frame) / 60
    at 850: collapsed (event structure_collapsed); every 8-neighbour on the floor at 600 or more collapses with it;
            the same cells of the floor above get 300 more damage; the people in them are hurt (section 6.7.7)
```

The blast takes no account of the walls between the device and a cell: WS6's radii are free-field and confined estimates, and version 1 applies them by distance (section 15.2). A collapsed cell is impassable and does not burn; a shored cell keeps its damage.

#### 6.7.5 Plumes

Every 5 ticks each source is recomputed: each opening with smoke leaving it, each compartment with smoke, each gas source outdoors or venting. A source's strength S is the permille-seconds it emitted over the last 5 seconds.

```text
u ← max(0.5, wind_speed_ms)                       // calm air still drifts
b ← (wind_from_deg + 180) mod 360                  // the bearing the plume points to
stability ← night ? 'stable' : weather row's day_stability
L_max ← base(agent) × clamp(S / 500, 0.2, 1) / plume_decay(weather)     // base: smoke 400 m, toxic gas 600 m, irritant 300 m
L ← min(L_max, u × age_s)                          // the plume grows downwind from when the source started
w(x) ← 3 + k × x, k: unstable 0.25, neutral 0.12, stable 0.06           // half-width at distance x
ring ← the source, then the right edge at x = L/4, L/2, 3L/4 and L, a rounded tip, and the left edge back:
       12 points in sim space, turned by b and converted to latitude and longitude
bands: dense to L/3, moderate to 2L/3, light beyond; levels 700, 400 and 150 permille of its agent
calm (wind below 0.5 m/s): a circle of radius min(L_max, 0.25 × age_s)
a source silent for 60 s ends its plume (event plume_ended)
```

The half-width growth rates follow the shape of the stability classes in Turner's *Workbook of Atmospheric Dispersion Estimates* (1970), reduced to three values; they are planning values, under the D31 review with the rest (section 15.2). At most `WORLD_LIMITS.maxPlumes`; beyond it the weakest sources are merged into their nearest neighbour.

#### 6.7.6 Crowds

```text
spawnGroups: each zone's people in groups of at most 50 (more than 400 groups: the group size grows to fit 400);
             each group starts on a cell of its zone in the order of the seeded stream 'crowd_place'
wait ← 30 s within the main device's minor radius, 120 s elsewhere inside the primary, 60 s outdoors or in a compartment,
       each times (0.7 + 0.6 × u), u from the stream 'crowd_wait'; a direct_crowd task within 20 m cuts it to at most 15 s
flowField(exit set): Dijkstra from the usable exits over the inside cells of every floor and the stair links;
       cost of a step = its length × (1 + smoke / 250) × (unsafe ? 5 : 1) × (stair ? 3 : 1);
       burning and collapsed cells and closed stairs are impassable;
       usable exit: not closed by a task or the trainer, not burning, smoke under 800 at its cell;
       one field for all usable exits, and one per exit a task directs groups to; recomputed when the usable set or
       an impassable cell changes, at most every 10 ticks
move: speed ← 1.2 m/s × density (sparse 1, moderate 0.9, dense 0.6, packed 0.4)
             × (smoke ≥ 800: 0.3; ≥ 600: 0.5; else 1) × (on a stair: 0.5) × (temperature ≥ 33 °C: 0.9)
       a group moves along the field's gradient; its position is a cell and a progress in decimetres
exits: an exit passes up to 1.3 people a second per metre of width, the specific flow of the SFPE Handbook's
       movement models, carrying the fraction; a queue above 100 people for 30 s marks it congested (event exit_congested)
outside: a group walks in a straight line at 1.2 m/s × the weather's walking_speed to its muster point: the nearest
       active assembly_point placed asset of any team within 400 m, else a point 150 m from its exit directly away from
       the main device; arriving: mustered (counted as out)
       a cordon line crossed while moving towards the site centre stops it (held); crossing away is allowed
compartments: groups leave by the compartment's nearest exit after their wait, at the same exit rate, then walk outside
trapped: a group with no path for 30 s is trapped (event crowd_trapped); a rescue task within 5 m frees it
roads: every outside group within 15 m of a road edge adds its people to that edge's pedestrian count (section 6.9.4)
```

Today's crowd pins keep today's exit flow and movement (section 6.12): the world's groups are the people of the crowd zones, a population the scripted engines never modelled.

#### 6.7.7 Exposure

```text
for each crowd group, each patient pin the bridge has synced (casualty_type 'patient', not resolved, transported or deceased),
and each unit crew:
    levels: smoke and gas from its cell, or from the plume bands it stands in outdoors, or from its compartment;
            heat 800 in a burning cell, 300 in a heating one; heat_stress outdoors only, the air temperature in tenths
            of a degree (so 34 °C is 340, which the stored bands treat as hours, not minutes)
    for each agent with a level ≥ the first band's 'from': dose(agent) += 1 / seconds(level), seconds from the highest band
            whose 'from' is at most the level (fieldops_spread_exposure.incapacitation_bands)
    groups: the first time a dose passes light_at, serious_at and fatal_at, floor(shares × people / 1000) people (the
            remainder carried) leave the group as casualties of colour yellow, red and black: one bridge operation each,
            a patient pin at the group's position with that headcount and conditions.spawned_from 'world_exposure'
    patient pins: each threshold passed steps the pin one colour along today's escalation (green, yellow, red, black,
            server/services/peopleDeteriorationService.ts:22-26), with last_deterioration_at set, on top of today's clock
    crews: breathing apparatus protects from smoke and gas for its seconds; without it a unit in smoke ≥ 600 or gas ≥ 300
            withdraws to the nearest exit (event unit_task_ended, reason exposure); a crew in a collapse: out_of_action
collapse: the people in the cells that collapse are converted at once by the 'collapse' shares; the trapped share stays
          trapped until a rescue task frees it
```

The doses are fractional effective doses in the sense of ISO 13571 (section 5.12.4): planning values for training, never advice about real exposure.

#### 6.7.8 What the teams' units do

Each working unit applies its task every second (section 6.8.5 gives how it gets there).

| Task | Kinds | Effect while working |
| --- | --- | --- |
| `suppress` | fire engine | Inside (the crew deployed through an exit): the nearest burning cell within 10 m of the crew, reached through doors, gains one suppression second per two crew members; at its contents' `extinguish_s` it goes out and stays wet for 600 seconds; heating cells within reach lose 5 heat a second. Outside (the crew at the engine): cells within 30 m of it and within 6 m of an opening, the same way. A compartment loses `1000 / (extinguish_s × max(1, sqrt(area_m2) / 3))` involvement per crew pair a second |
| `ventilate` | fire engine | The target exit or opening is vented: faster smoke decay and a 1.2 fire boost within 12 m (section 6.7.3) |
| `rescue` | fire engine, rescue tender | Trapped groups and patient pins within 5 m of the crew are moved to the crew's exit at 0.5 m/s; for a pin the bridge writes the destination and `movement_speed_mpm` 30, so today's `runMovementTick` moves it (`server/services/movementService.ts:14-17`) |
| `shore` | rescue tender | Cells within 6 m are shored: their creep stops, and rescue crews may enter them while unsafe |
| `decon` | HazMat unit | A decontamination point: people and pins within 20 m stop gaining gas dose |
| `triage` | ambulance, medical team | Presence: the unit's placed asset is a `MEDIC_TYPES` type, so today's assess route accepts tags within 80 m |
| `transport` | ambulance | Section 6.8.9 |
| `cordon` | patrol car, cordon team | A ring of 10 to 300 m around the target, or a line from the unit to a second point: crowds may not cross it inwards; road edges crossing it are cordoned (section 6.9.4); it lapses 120 seconds after the last cordon unit leaves it |
| `direct_crowd` | patrol car, cordon team, marshal team, venue staff | Groups within 20 m start within 15 seconds and take the exit the task names, or the nearest usable one |
| `close_exit`, `open_exit` | cordon team, marshal team, venue staff | The exit is closed to, or reopened for, the crowd |
| `close_road` | patrol car, transport supervisor | Road edges within 30 m of the unit are closed to civilian traffic; emergency units still pass |
| `sweep` | EOD team | Presence, and at a wall point the sweep of section 6.8.8 |
| `command_post` | command unit | Presence: a 100 m observation post |
| `isolate_utility` | utility crew | Electrical hazards within 50 m that have not reacted lose their trigger, and electrical contents there stop accelerating fire |
| `move`, `observe` | every unit | Presence only |

#### 6.7.9 The trainer's commands and the system's

| Command | Effect at its tick |
| --- | --- |
| `set_weather` | The target `WeatherSetting` with a transition of 0 to 600 seconds (section 6.9.3); event `weather_changed`, public |
| `close_road`, `open_road` | The edge is closed to every vehicle, emergency or not, or reopened; event `road_closed` or `road_opened`, public when the trainer announces it, else positional |
| `start_fire` | The cell or compartment at the point starts burning; event `trainer_fire_started`, positional |
| `pause`, `resume` | The runtime stops or restarts ticking (section 6.11.5); the command is logged at the tick it took effect |
| `sync_pins` | The bridge's every-5-seconds read of the session's patient pins and crowd pins (position, status, colour, headcount), so exposure and rescue use what today's engines and players changed. Logged like any command, so a replay sees the same pins |
| `device_detonated` | `applyBlast` for the device whose scene item id the detonation names (section 6.12) |
| `transport_patient` | Section 6.8.9 |

#### 6.7.10 Determinism

- Randomness comes only from `mulberry32` streams (the generator WS4 uses for `crowdSpawnPoints`, `05-layout-step.md` section 7.12), each seeded with `fnv1a32` of the session's seed and the stream's name (`crowd_place`, `crowd_wait`, `tie_break`), and drawn in entity order, so a new draw in one stream never shifts another.
- Engine state is integers. Floating point appears only in the model build and in the per-weather direction table, and both are stored rounded, so a replay on another machine gives the same integers.
- Cells are visited by index, entities by key, commands by `apply_tick` then id. The engine never reads the clock: world time is the tick.
- `stateHash` is the SHA-256 of `serialiseState`, the canonical JSON with typed arrays in base64; AC9.23 compares hashes.

### 6.8 Units

#### 6.8.1 The unit plan

```text
for each agency of the setup copy, in its order, matched to its scenario_teams row by display_name = team_name:
    kinds ← the lobby's overrides for that team (WorldSettings.units), else unitsForAgency(archetype) (section 5.10.1)
    each unit: unit_key 'u' + a running number from 1; label '<kind label> <n>', n counting per team and kind;
               origin from the override, else 'auto'
caps: 8 units per agency and 40 per session (WORLD_LIMITS); beyond them the catalogue order is kept and the rest dropped,
      and the lobby card says how many were dropped
```

AI-operated agencies (`operation` `ai`) get their units the same way; their brain dispatches them through the same routes (section 6.8.10).

#### 6.8.2 Origins

```text
'auto'      the nearest facility of the kind's origin_kinds within 10 km of the site centre, by straight distance, ties by
            osm_id, trying the kinds in order; none: the nearest entry point
'facility'  the facility with that osm_id (one of the model's facilities)
'staging'   the trainer's point, which must be inside the road box
'on_site'   the primary's first open exit; the unit is 'arrived' at tick 0 (venue staff)
entry points: up to four road nodes of motorway, trunk or primary roads between 2,000 and 3,000 m from the site centre,
            one per quadrant, each the nearest such node to 2,500 m: where help from beyond the map comes in
outside the road box: the unit starts at the box-edge node nearest its origin, with extra turnout time for its straight
            distance outside the box at 40 km/h (Assumed (D13))
```

Every unit starts `at_origin`, with nobody on scene but venue staff: dispatching is the teams' decision.

#### 6.8.3 The road graph, built once

```text
roadBoxFor(site centre, origins): the bounding box of the site centre and every origin, widened by 1,000 m,
      capped at 14 km by 14 km centred on the site (origins beyond enter at its edge)
areaKeyOf(box): 'sg:' + the box's corners rounded outwards to 0.01 degree + ':' + WS3's data-version label
loadRoadRowsInBox(box): osm_sg_roads rows whose bounding box meets the box, 1,000 a page, at most 120,000 rows, columns
      osm_id, name, highway_type, oneway and coordinates_json; service and living_street ways farther than 1,500 m from the
      site are left out
buildRoadGraph(rows), in a worker:
      a node is a coordinate, rounded to 7 decimals, that is a way's end or is shared by two ways
      each way is split at its nodes into edges: from, to, length in decimetres (haversine sum), highway type index,
      oneway, name index, and its polyline thinned to 5 m for drawing; a oneway way gives one direction, others two
      only the largest connected component is kept; the others are counted in the summary
      at more than 200,000 nodes or 400,000 edges, service and living_street ways are dropped and the build repeated
encodeRoadGraph: base64 Int32 arrays (coordinates times 10^7, edge fields) and a JSON name table
cache: fieldops_road_graphs by (area key, data version, ROAD_GRAPH_VERSION 'fo-roads-1'); a model whose box rounds to
      the same key reuses it, across scenarios
snapToGraph(point): the nearest point on any edge within 300 m, found through a 250 m bucket index and split virtually;
      none: the target has no road access
```

The paging follows today's `fetchLocalSingaporeRouteGeometries` (`server/services/osmVicinityService.ts:652-706`), which also reads `oneway` and `coordinates_json`; the coordinates are `[lat, lng]` pairs as `parseLatLngPairs` reads them (`server/services/osmVicinityService.ts:639-650`). Nothing is fetched live (D5). A 14 km box of Singapore holds tens of thousands of road rows; the build runs once per box and saved-data version, in the prepare job, never in a session's tick.

#### 6.8.4 Travel time

```text
edgeTimeS(edge, unit, t) ← length_m / (speedKph(edge, unit, t) / 3.6)
speedKph ← free_flow_kph(highway_type)                         // fieldops_road_speed_classes
         × emergency_factor(highway_type)                       // every world unit is an emergency unit
         × trafficFactor(road_group, day type, hour)            // section 6.9.4
         × the weather's road_speed
         × incidentFactor(edge, unit)                           // section 6.9.4; 0 makes the edge impassable
routeUnit(from, to): A* over the decoded graph with edgeTimeS as the cost and straight distance at 120 km/h as the
      heuristic, ties broken on node index; the time adds the two legs off the graph at 10 km/h; no route: not reachable
re-routing: every 15 ticks an en-route unit's ETA is recomputed; it re-plans at its next node when an edge ahead went to 0
      or slowed by more than 20 per cent
```

Without migration 253 there are no speed classes and no graph, so there are no units (section 5.13). Without 255, `trafficFactor` is 1.

#### 6.8.5 The life of a unit

```text
dispatch(unit, target, task):
   checks (section 6.14 answers each refusal): the caller may command the unit; task ∈ tasksForUnit(kind, scope);
          the target is in the road box, snaps to the graph (or, for a target inside a building, to the access node
          nearest the exit it will use) and is allowed (section 6.8.6)
   at_origin → turning_out for the kind's turnout_s → en_route: it drives the route at road speed
   → arrived at the access node nearest the target → the bridge places its asset (section 6.8.7)
   → deploying: the crew walks from the access node to the target; inside a building through the nearest usable exit
     and the crowd's walkable cells, at foot speed (0.8 m/s with breathing apparatus)
   → working: the task applies every second (section 6.7.8)
recall: from any state it drives back to its origin (returning, then at_origin); its asset is removed when it leaves
set_task: a working unit changes task where it stands when the new task is allowed there
blocked: the target became unreachable or forbidden on the way; the unit stops at its last node and waits
out_of_action: its crew was caught in a collapse; it stays, cannot work, and its team is told
```

Every unit travels by road, foot teams included (they are driven to the scene); `mode` says only whether the vehicle stays at the access point while the crew works (`vehicle`) or the whole team works on foot (`foot`).

#### 6.8.6 Where a unit may go

- **Zones.** A target, or a crew's path on foot, may enter the hot ring of the operational zones only when the team's `zone_access` includes `hot`, and the warm ring only with `warm` (WS1's `actionScopeFor`; a team without an archetype has cold only). Otherwise 422 `ACCESS_DENIED_ZONE` at dispatch, or `unit_blocked` on the way.
- **Structure.** No crew enters a collapsed cell. Only a rescue crew enters an unsafe one, and only within 6 m of shoring; others stop at its edge.
- **Smoke and gas.** Section 6.7.7.
- **Cordons and closures.** A team's own cordon never stops it. Another team's cordon stops a vehicle of a team without access to the zone inside it. A road the trainer closed stops everyone.

#### 6.8.7 Arrival as a placed asset (W17)

```text
on arrival (a vehicle at its access node; a foot team when it reaches its target):
   validatePlacement(session, team, asset_type, Point)            // server/services/placementValidationService.ts:55-62
   blocked (inside an incident site's blast exclusion radius): the unit backs along its route to the first point that
          passes, is placed there, and its team gets unit_blocked with the first block's text
   otherwise insert placed_assets { session_id, team_name, placed_by: the user who dispatched it (the session's trainer
          for an on-site unit), asset_type: the kind's asset_type, label: the unit's label, geometry: Point,
          properties: { world_unit_id: unit_key, kind, crew }, placement_score: the validation's modifiers }
   broadcast placement.created as the placements route does, and run evaluatePinResolution in the background
while a crew moves on foot: the asset's point is updated at most every 10 seconds (placement.updated)
on leaving: status 'removed', removed_at set, placement.removed
```

The broadcast and the background pin resolution are those of `POST /api/sessions/:id/placements` for `placement.created` (`server/routes/placements.ts:377-402`). That route's `PATCH` and `DELETE` refuse an asset whose `properties.world_unit_id` is set, with 409 `WORLD_UNIT_ASSET` ("Move this unit from the units panel."), so a unit is never moved off its world position by hand (touched, section 6.12).

#### 6.8.8 Sweeps at inspection points (WS5's request)

```text
an EOD team dispatched with task 'sweep' to an inspection point (a point target snapped to the nearest wall point within
10 m) works there for 120 seconds, then:
   sweepInspectionPoint(session, assetId, wallPointId):
      entry ← the first entry of sessions.sweep_device_pool whose wall_point_id is this point
      if entry: move it from sweep_device_pool to sessions.hidden_devices as
                { asset_id: assetId, device_profile: entry, discovered: false, attached_at }
      performSweep(session, assetId, { personnel: crew })
```

The hidden-device shape is the one `tryAttachHiddenDevice` writes (`server/services/demoActionDispatcher.ts:1547-1580`), and `performSweep` (`server/services/bombSquadSweepService.ts:15-19`) then finds the device on the unit's asset and reveals it exactly as today, or answers "Area clear". So a team that sweeps the right inspection point finds the device planted there, and today's sweep code is unchanged. The team sees only the sweep's answer, as WS7 keeps it (`08-people-or-ai.md` section 6.9).

#### 6.8.9 Transport by ambulance

When a team's transport decision gives a patient pin `endorsed_to_transport` and a destination (today's decision effect, section 3.4), and an idle ambulance of that team is within 80 m, the ambulance takes the patient (one, or two when both are green or yellow), routes to the destination's access node, and the bridge sets the pin's `movement_speed_mpm` to the route's length over its time, so today's `runMovementTick` (`server/services/movementService.ts:39-43`) brings the pin to the hospital when the ambulance arrives, and the pin reaches today's `transported` status. With no ambulance within reach, today's straight-line movement at `AMBULANCE_MPM` stands. The command is `transport_patient`, issued by the bridge when it sees the endorsement in `sync_pins`.

#### 6.8.10 AI agencies

An AI agency's actor is a member of its team (`08-people-or-ai.md` section 6.6), so the world routes accept its token exactly as a person's (AC9.41), and every payload it reads is fogged for its team (section 6.10). WS7 adds the view route to its actor allow-list and a `dispatch_unit` action to its closed action set (request in section 15.3). `suggestUnitForTask` (section 5.10.2) gives its planner the nearest idle unit that can do a task, so the planner stays deterministic. WS9 makes no model call for the AI either.

### 6.9 Weather and traffic

#### 6.9.1 What weather changes

| Mechanic | Weather input | Effect |
| --- | --- | --- |
| Fire inside, near openings | wind direction and speed | `windBias`, up to 50 per cent faster downwind and slower upwind (section 6.7.2) |
| Fire in involved buildings once it has broken out | condition | the row's `outdoor_spread` |
| Plumes | wind direction and speed; condition; night | direction, length (`plume_decay`), width (stability: the row's by day, stable at night) |
| Observation and fog of war | condition; visibility; night | outdoor ranges times `observation`, times 0.6 at night, times `min(1, visibility_m / 1000)` |
| Unit travel | condition | road speeds times `road_speed` |
| The crowd outdoors | condition; temperature | walking speed times `walking_speed`, times 0.9 at 33 °C or more |
| Casualties | wind; rain; temperature | plumes carried onto people, shortened by rain; `heat_stress` doses outdoors (section 6.7.7) |

#### 6.9.2 Weather from Setup

```text
setting ← the setup copy's options.weather_setting (WS2 stores it beside the label, master 10.8 item 39), origin 'trainer'
otherwise weatherFromLabel(options.weather, incident.when, presets, brief.description):
      text ← the normalised label; when empty, the weather words found in the description
             (rain, drizzle, shower, downpour, storm, thunder, lightning, squall, haze, smog, smoke haze, hot, heat, wind,
             gust, night, dark, clear, sunny)
      preset ← the first preset, in sort order, one of whose label_keywords is a whole word or phrase of text
      none: defaultWeather(when), origin 'default'; else the preset's setting, origin 'label'
      night (isNightAt(when.time)): a day-only preset becomes 'sg_clear_night'; any other loses 3 °C and a fifth of its visibility
      'psi <n>' in the text, with a haze preset, sets haze_psi to n (0 to 500)
the lobby's WorldSettings.weather, when set, replaces it before the start; the console changes it during play
```

#### 6.9.3 Changing weather during play

`set_weather` with `transition_s` T moves wind speed, wind direction (along the shorter arc), temperature, rain and visibility a T-th of the way each second; the condition switches at the half-way tick; the direction table of `windBias` is recomputed every 10 ticks while it moves. Every team receives the `weather_changed` event, because weather is something everyone can see.

#### 6.9.4 Traffic and the incident

```text
trafficFactor(group, day_type, hour): fieldops_traffic_profiles for region SG (section 5.12.5); 1 without migration 255
      day_type ← incident.when.day; hour ← the hour of incident.when.time plus the world's elapsed time
incidentFactor(edge, unit):
      0     the trainer closed it; or a collapsed involved building's outline lies within 10 m (debris);
            or a cordon crosses it and the unit's team has no access to the zone inside
      × 0.6 a cordoned edge the unit may pass
      × 0.5 101 to 300 pedestrians within 15 m (evacuation); × 0.2 above 300 (a jam: event road_jammed, once per edge)
      × 0.7 within 500 m of the site centre during the first 1,800 seconds (onlookers and diverted traffic; Assumed (D35))
      × 0.5 inside a dense plume band, for a unit whose crew has no breathing apparatus
```

No traffic or weather data is fetched live (D5): the profiles are stored rows, and the weather is what the trainer and Setup set.

#### 6.9.5 What today's engines see of the weather

The world does not write `sessions.current_state`. The scheduler rewrites the whole column at each tick from the state it read at the tick's start (`nextState`, `server/services/injectSchedulerService.ts:522-531`), so a concurrent write would be lost, and the world's wind would flicker. Instead the world layer draws its own wind indicator from the view, and `environmental_state.wind` stays as today. Spatial scoring's opposite reading of the wind angle (section 3.7) is a defect today's code already has; section 15.2 raises it.

### 6.10 Fog of war

#### 6.10.1 What a team can observe

| Observer | Outdoors | Inside a building |
| --- | --- | --- |
| A unit's crew or vehicle, wherever it is | the kind's `observe_m`: 50, 60 or 100 m | 20 m through open edges and doors |
| A `command_post` or `camera_position` asset of the team | 100 m | 20 m |
| Any other point asset of the team | 30 m | 20 m |

```text
outdoor range ← base × the weather's observation × (night ? 0.6 : 1) × min(1, visibility_m / 1000)
                × (the observer inside a plume band: dense 0.2, moderate 0.5, light 0.8)
indoor sight: a search from the observer's cell over edges that are open or doors (never through a solid wall),
              each step costing its length, up to min(20 m, 2 × the visibility of the observer's cell, at least 2 m);
              a cell whose visibility is under 1 m is seen but not looked through
from outside: cells within 6 m of an opening (an exit, a breach, broken glazing) inside an outdoor observer's range are seen
compartments: seen when an outdoor observer is within range of its outline (involvement, smoke and structure)
plumes: seen within range plus 600 m by day with visibility of 2 km or more, else range plus 150 m
collapses: heard within 300 m: the team gets the structure_collapsed event without its detail
```

A team's cover is the union of its observers' circles and seen cells, recomputed every 2 ticks.

#### 6.10.2 Knowledge and last-known markers

Each team keeps, in memory, the tick it last saw each cell and the cell's state then, and an entity map: `hazard:<id>`, `casualty:<id>`, `crowd:<group_key>`, `plume:<plume_key>`, `compartment:<building_key>`, `fire_region:<n>`, `unit:<unit_key>` and `road:<edge_key>`, each with its source (`observed`, `reported` or `shared`), first and last tick, and last position and status. What is in cover now is current; what is known but not in cover is drawn where and as it was last seen, with its age ("seen 4 min ago"). The changed entries are written to `fieldops_world_knowledge` every 10 seconds (at most `WORLD_LIMITS.maxKnowledgePerTeam` per team, the oldest dropped first).

#### 6.10.3 Reports

A team shares an entity it knows with `POST /api/field-ops/sessions/:id/world/reports`, to every team or to named teams, with an optional note of up to 280 characters checked by `moderateDeviceText`. Each receiving team gains the entity with source `reported`, as the reporter last saw it, and the event `report_shared`. With `share_unit_positions` on (the default), every team's units are known to every team, source `shared`, at every tick: the responder picture that agencies at one incident share (W18). A report says nothing the reporter does not know (422 `REPORT_NOT_KNOWN`).

#### 6.10.4 The views

| Audience | Who | Sees |
| --- | --- | --- |
| `team` | a participant of one or more teams, people and AI actors alike | the union of its teams' cover and knowledge, the reports to them, its own units and the shared ones, the public events and the events inside its cover; never a device marker |
| `trainer` | the session's trainer and admins: WS0's `canSeeSessionAnswerKey` (`01-prerequisites.md` section 6.5.2) | everything, device markers included |
| `spectator` | a participant with no team | the union of every team's view: the common operating picture; never a device marker |

`buildView` builds a `WorldView` for an audience; `buildDelta` diffs it against the audience's previous one. A delta over 64 KB is replaced by `{ resync: true }`, and the client fetches the view again.

#### 6.10.5 Every payload is filtered on the server

In a session whose world runs with `fog_enabled` (`isFogSession`), for every caller who is not the trainer's audience:

1. **The world's own payloads.** The view route, the deltas and the replay route carry only the caller's audience (section 6.10.4).
2. **Today's hazard and casualty routes.** `GET /api/sessions/:id/hazards`, `GET /api/sessions/:id/hazards/:hazardId`, `GET /api/sessions/:id/casualties` and `GET /api/sessions/:id/casualties/:casualtyId` (`server/routes/hazards.ts:16-85`, `server/routes/casualties.ts:40-77`) pass their rows, after WS0's projections, through `filterHazardRowsForViewer` or `filterCasualtyRowsForViewer`. A row is kept when its position is in the caller's teams' cover; or when they know it, with its last-known status and position in place of the current ones and `world_last_seen_s` added; or, for a casualty, when one of the caller's teams assessed it or is assigned to it. Otherwise a list drops it and a detail route answers 404 with its existing body. The casualty `PATCH` and `assess` routes answer the same 404 for a row the caller's teams do not know.
3. **Today's broadcasts.** `broadcastToSession` (`server/services/websocketService.ts:62-73`) passes each event through `redactForFog(sessionId, event)`: in a fog session, `hazard.updated` becomes `{ refetch: 'hazards' }`, `casualty.created`, `casualty.updated` and `casualty.moved` become `{ refetch: 'casualties' }`, and, while `share_unit_positions` is off, `placement.*` events of world-unit assets become `{ refetch: 'placements' }`. The internal bus still gets the full event, because only server code listens there.
4. **Placements.** With `share_unit_positions` off, `GET /api/sessions/:id/placements` drops the world-unit assets of other teams that the caller's teams do not know. Every other placement stays visible: it is a team's own act on the map.
5. **Not filtered.** Locations and claims (the exit gate needs them, section 3.7), injects, decisions and chat (they are reports by nature), and WS0's scene projection, which holds no hidden fact (master 10.8 item 28).

The filters are pure functions over the rows and a `Viewer` (`{ team_names, cover, knowledge }`); the routes get the viewer from the runtime's memory when this process holds the world, else from `fieldops_world_knowledge` and a cover rebuilt from the last persisted units, cached for 2 seconds. AC9.46 checks that no hidden fact gets through.

#### 6.10.6 The trainer, spectators and AI agencies

The trainer's view is the whole world, sent as `fieldops_world.trainer` to the trainer's user room; admins who open the session get the same. Spectators get the common operating picture. AI agencies see what their team sees, through the same filtered routes and the same view route (D34; section 6.8.10).

### 6.11 The runtime

#### 6.11.1 Which sessions get a world

```text
isWorldEligible(session, scenario):
    env.enableFieldopsWorldSim
    and migrations 250 to 252 are applied (WS0 detectors)
    and the scenario has a v2 scene (rts_scene_configs.schema_version 2 with its scenario_id)
    and it is a field-ops session (sessions.sim_mode is null) of a scenario that is not a social-media crisis
    and the session's world settings do not say enabled = false
    and worldAllowedFor(the trainer's role, the library) (W24)
the row: created by the lobby card's first PATCH /settings (status 'pending'), or else by the reconcile loop within one
    interval of the session reaching in_progress. scope ← WS0's job scope of the creating process (P0.3 of
    01-prerequisites.md); seed ← fnv1a32(session id); unreviewed ← the library or WS5's physics snapshot is unreviewed
then: a model of the scenario with the current inputs hash → 'ready'; else 'preparing' and a fieldops_world_prepare job
```

A legacy scenario, a social-media session or a session whose trainer turned the world off never gets a row, and the session runs exactly as today.

#### 6.11.2 Worker threads

```text
getWorldWorkerPool(): FIELDOPS_WORLD_WORKERS threads (default 2), started on first use, each running worldWorker:
    the entry is resolved beside the calling module: worldWorker.ts with execArgv ['--import', 'tsx'] when that module is
    a .ts file (development and tests), worldWorker.js otherwise (production's compiled dist/)
    resourceLimits.maxOldGenerationSizeMb 512 per thread
worlds: a world is hosted on the thread with the fewest; at most FIELDOPS_WORLD_MAX_SESSIONS (default 4) per process
spread timelines (WS5's compile and, through WS5's rebuildFireSpread, WS8's edits): never on a thread that hosts worlds,
    because one runEnvironmentalSimulation call is synchronous and an abort terminates its thread; each runs on a
    short-lived thread of its own (runSpreadThread), with the same entry rule and memory limit, at most
    SPREAD_LIMITS.maxConcurrent (2) at a time per process, the rest waiting first in first out; the caller's signal and
    SPREAD_LIMITS.timeoutMs count from the call, so a waiting timeline is bounded too
a thread that exits or throws: a fresh thread replaces it and its worlds are hosted again from their last snapshot and the
    commands after it (section 6.11.7); a world that kills a thread twice in 10 minutes falls back with ENGINE_ERROR
messages: ToWorker and FromWorker (section 5.11), as structured clones; the model is posted once per hosting, never per tick
```

The entry rule follows how the server runs: `tsx watch server/index.ts` in development and `node --import tsx --test` in tests (`package.json:12`, `package.json:25`), and `node dist/server/index.js` after `tsc` in production (`package.json:14`, `package.json:17`).

#### 6.11.3 Leases and the reconcile loop

`startWorldRuntime()` runs inside the background-engines block of `server/index.ts` (`server/index.ts:85-106`), so only a process with `env.runBackgroundEngines` runs worlds, and only when `env.enableFieldopsWorldSim` is on. Its worker id is WS0's `WORKER_ID` and its scope WS0's job scope, so a development server never claims a production world (W11).

```text
every 5 seconds (WORLD_RECONCILE_MS):
  1. create rows for eligible in_progress sessions that have none (section 6.11.1)
  2. for each row of this scope in ready, running or paused whose session is in_progress or paused:
       hosted here: fieldops_world_heartbeat(session, worker, FIELDOPS_WORLD_LEASE_SECONDS, tick, status, level, lag)
                    'lost': unhost at once and write nothing more; 'stop_requested': stop with TRAINER_STOPPED
       not hosted, with capacity: fieldops_world_claim(...); true: host it (section 6.11.7)
  3. sessions completed or cancelled: stop their worlds with SESSION_ENDED
  4. 'preparing' rows whose job failed: 'failed', MODEL_FAILED; still preparing 10 minutes after the start: 'fallback',
     STARTED_TOO_LATE
  5. a 'ready', 'running' or 'paused' row whose lease has been free or expired for 120 seconds, because no
     process had capacity: 'fallback', NO_CAPACITY, with the hand-back of section 6.12.3
```

The lease is 30 seconds by default, so a holder killed without shutdown hands its worlds over within about 35 seconds. Step 5 runs in every process with the runtime, including one whose `FIELDOPS_WORLD_MAX_SESSIONS` is 0, so a world nobody can host always ends in today's escalation and never leaves its hazards frozen by the gates.

#### 6.11.4 The tick loop

```text
for each hosted world, on the main thread, every 1,000 ms (corrected for drift against the wall clock):
    session paused, or the world paused by the trainer: nothing; the world clock stands still (W21)
    commands ← the session's queued commands: handed over by a route in this process at once, otherwise read from
               fieldops_world_commands every second; each is given apply_tick = the next tick
    post { op: 'tick', commands, target_tick } to the world's thread
    on 'ticked': mark the commands applied or rejected; queue the events (written every 2 s); apply the bridge operations
               (every 5 s, section 6.12.2); send the deltas (every 2 s, section 6.15); queue the unit changes (on a change,
               at most every 5 s while moving) and the knowledge changes (every 10 s)
    every FIELDOPS_WORLD_SNAPSHOT_SECONDS (60): { op: 'snapshot' }, then insert the snapshot and set last_snapshot_tick
```

#### 6.11.5 Pause, resume and the end of a session

- A session paused with today's status stops the world's ticks; back `in_progress`, it continues from the same tick.
- The trainer's pause and resume set `trainer_paused` and log the `pause` and `resume` commands.
- A session `completed` or `cancelled` gets a last snapshot; the world is `stopped` with `SESSION_ENDED`, unhosted and released.
- The console shows two clocks: the world's time and the session's elapsed time, because today's engines count the paused minutes (section 3.10) and the world does not.

#### 6.11.6 What is written, and how often

| Data | When | Table |
| --- | --- | --- |
| Events | batched every 2 seconds, at most 200 rows a batch | `fieldops_world_events` |
| Snapshots | every 60 seconds by default, at a pause and at the end | `fieldops_world_snapshots` |
| The session row | a heartbeat every 5 seconds | `fieldops_world_sessions` |
| Units | on a change of status or task, and every 5 seconds while moving | `fieldops_world_units` |
| Knowledge | the changed entries every 10 seconds | `fieldops_world_knowledge` |
| Reports and commands | as they happen | `fieldops_world_reports`, `fieldops_world_commands` |
| The bridge | every 5 seconds, only rows that changed | `scenario_hazards`, `scenario_casualties`, `placed_assets` |

That is at most 150 writes a minute for one world and 600 for four (AC9.26).

#### 6.11.7 Hosting a world, and recovery after a restart

```text
host(session):
    model ← its fieldops_world_models row (the frozen library inside it); roads ← the cached road graph
    snapshot ← the session's latest snapshot, or the initial state at tick 0
    replay ← the applied commands with apply_tick ≥ snapshot.tick, in (apply_tick, id) order
    post { op: 'host', model, roads, snapshot, replay, until_tick: the row's tick }
    the thread restores the state, re-applies each command at its tick and steps up to until_tick at full speed, sending
    no delta, and answers 'hosted' with its state hash; real-time ticking resumes from there
```

The world clock does not advance while no process holds the world. After an outage of 40 seconds the world is 40 seconds behind the session clock, and the console says "Live world resumed after 40 seconds." Because the library is frozen in the model, an admin's edit during a session changes only the worlds prepared afterwards.

#### 6.11.8 Back-pressure and fallback

```text
nextDegradeLevel(recent tick times):
    0 → 1 after 5 consecutive ticks over FIELDOPS_WORLD_TICK_BUDGET_MS (250): plumes every 10 ticks, visibility and deltas every 4
    1 → 2 after 10 more: fire, smoke, gas and structure stepped every 2 ticks with two seconds at a time
    fallback after 30 seconds over budget at level 2, or when the world is 30 seconds behind the wall clock: WORLD_BEHIND
    one level down after 60 seconds under budget
socket queue: more than 50 deltas waiting for one world drops the intermediate ones; the next delta is a resync
fallback(session, reason):
    a last snapshot; handBackWorldPins, which also retires the still-delayed fire-spread children (section 6.12.3);
    fieldops_world_finish(session, worker, 'fallback', reason);
    the public event world_fallback; the clients hide the world layers and show the fallback line
```

#### 6.11.9 A late start

A world that becomes ready after its session started is hosted with `until_tick` set to the session's elapsed seconds, at most 600: it steps through that time without commands and without deltas, then runs in real time (AC9.33). Ready more than 10 minutes after the start, it falls back with `STARTED_TOO_LATE`, so players never see the world jump to a state unlike the one the scripted escalation has shown them.

#### 6.11.10 Shutdown and retention

- `stopWorldRuntime()` runs in `shutdown` right after WS0's `stopJobEngine` (`server/index.ts:314-322`): a last snapshot of each hosted world (at most 3 seconds in all), `fieldops_world_release(worker)`, then the threads are terminated, inside the 10-second exit.
- A daily sweep, in the same block, thins the snapshots of ended sessions to one in five, deletes events and snapshots older than 180 days except each session's last snapshot, and deletes road graphs that no model has used for 90 days.

### 6.12 Coexistence with today's engines

#### 6.12.1 What the world replaces and what stays

| Engine or service | While the world runs for the session | Otherwise |
| --- | --- | --- |
| The inject scheduler's tick and its order (`server/services/injectSchedulerService.ts:1104-1186`) | Stays: time and condition injects, gates, pursuit, counters, the queues | As today |
| `runHazardDeterioration` | Skips hazards whose `properties.world_owned` is true, because the world escalates them; does not reveal children whose `properties.spawned_from` is `environmental_timeline`, because the world's own fires replace them, and counts such a held-back child as revealed, so today's generic spawn (`server/services/hazardDeteriorationService.ts:179-200`) does not add a hazard in its place; every other hazard as today | As today |
| `runPeopleDeterioration` | Stays: its clock steps colours, and the world's exposure adds steps on top (section 6.7.7) | As today |
| `processExitFlow` | Stays for today's crowd pins; each claimed exit's rate is multiplied by `worldExitFactor`, found through the exit pin's `conditions.scene_item_id`: 0 when the world finds the exit unusable, 0.5 when the world's crowd queues at it, else 1 | As today |
| `runMovementTick` | Stays, and also moves the pins the world sends to an exit or a hospital (sections 6.7.8 and 6.8.9) | As today |
| `evaluatePinResolution` | Skips world-owned hazards; units' assets resolve other hazards like any asset | As today |
| `checkDetonationTimers` | Stays; after it detonates a device it sends `device_detonated` with the hazard's scene item id | As today |
| `runAreaMonitors`, `evaluateTransportOutcome`, `evaluateEnvironmentalManagementIntentAndUpdateState`, `loadAndApplyEnvironmentalState` | Stay: they judge decisions and areas, which the world does not | As today |
| The sweep, patient and hazard queues | Gated by WS7 on the play mode (master 10.8 item 15), not by WS9 | As today |
| `engineTicker` | Not involved: social-media sessions only | As today |
| `cloneScenarioPinsForSession` | Changed by WS5, not by WS9: for a new-flow scenario it also copies the delayed hazards and casualties, with every `parent_pin_id` remapped to the session's copy (master 10.8 item 40; `06-compile-and-review.md` section 5.8). The world starts after it, from the cloned rows, so the session already holds the compiled fire-spread children, each hidden at `appears_at_minutes` 1,000,000 until it is revealed (section 3.1). WS9 adds no filter to the session lists: while the world runs, the gate above stops the reveal, so those children stay hidden | A legacy scenario's copy is today's; a new-flow one is WS5's |

Every gate calls `isWorldActive(sessionId)`, which answers from the runtime's memory when this process holds the world, else from `fieldops_world_sessions` (`running` or `paused`) cached for 15 seconds, and false whenever the flag is off or migration 251 is missing. So with no world every service behaves exactly as today (AC9.28). The touched lines are small: one filter each in `server/services/hazardDeteriorationService.ts` and `server/services/pinResolutionService.ts`, one factor in `server/services/exitFlowService.ts`, and one call after a detonation in `server/services/injectSchedulerService.ts`. A gate that turns false at a fallback or a trainer stop would let today's deterioration reveal those children on top of the world's fires, so the hand-back retires them first (section 6.12.3).

#### 6.12.2 The bridge

```text
applyBridgeOps(session, ops), every 5 seconds on the main thread, in this order:
  fire regions (8-connected burning cells of one floor): a region of 3 or more cells with no world fire pin within 15 m
      → insert scenario_hazards { scenario_id, session_id, hazard_type 'fire', the position of the region's first cell to
        ignite, floor_level 'G', 'L1', 'L2' or 'B1', status 'active', appears_at_minutes now,
        properties { world_owned: true, spawned_from: 'world', world_region: n, size: 'small' | 'medium' | 'large',
                     description: the hazard row's event_text } }
      a pin whose region grew by half since its last change → 'escalating'; all its cells out for 60 seconds → 'resolved'
  scene hazards: the cloned rows whose properties.scene_item_id is a world hazard are marked world_owned at hosting, and
      their status follows the world: 'escalating' while their cells burn, 'resolved' when they are out
  collapses: each structure_collapsed event → a 'structural_collapse' hazard row at the collapse, active, world_owned
  plumes: a plume that starts → a 'smoke_plume' or 'gas_release' hazard row at its source, world_owned; ended → 'resolved'
  exposure casualties: insert scenario_casualties { casualty_type 'patient', headcount n, status 'undiscovered',
      conditions { triage_color, spawned_from 'world_exposure', world_agent, injuries: [] } }
  colour steps of patient pins: conditions.triage_color and last_deterioration_at
  rescue and transport: destination_lat, destination_lng, destination_label, movement_speed_mpm and the status today's
      movement reads
  unit assets: section 6.8.7
  every write broadcasts the event today's code would (hazard.updated, casualty.created, casualty.updated,
      placement.created) through broadcastToSession, so the fog redaction of section 6.10.5 applies
```

The true colour goes into `conditions.triage_color`, one of WS0's `CASUALTY_ANSWER_KEYS`, so participants never receive it (`01-prerequisites.md` section 6.5.2). The hazard types are the words today's queues and panels already recognise: `fire` (`server/services/warroomService.ts:1011-1036` writes the same type), and `structural_collapse`, `smoke_plume` and `gas_release`, which match the collapse, fire and hazmat tests of the hazard queue (`server/services/injectSchedulerService.ts:1907-1909`).

#### 6.12.3 Handing the pins back

`handBackWorldPins(session)` runs at every end that leaves the session going: a fallback for any reason, the trainer's stop (`TRAINER_STOPPED`) and the reconcile's `NO_CAPACITY` (section 6.11.3). It calls `fieldops_world_hand_back(session_id)` (migration 251, section 5.4), which makes both changes below in one transaction, before any gate can answer false to today's engines:

1. **The world's hazards.** Every hazard of the session whose `properties.world_owned` is true gets `world_owned: false` and `world_handed_back: true`. The pins the world created have an empty `deterioration_timeline`, so today's deterioration leaves them as they are while pin resolution and the response panel resume. The cloned scene hazards keep WS5's timelines and resume today's escalation from their current stage.
2. **The compiled fire-spread children still waiting.** Every hazard of the session that is still `delayed` and whose `properties.spawned_from` is `environmental_timeline` is retired, so that escalation never adds them on top of the fires the world already made. Its `status` stays `delayed`, which `scenario_hazards` admits (`migrations/139_hazard_status_delayed.sql:1-4`); its `spawn_condition.trigger` becomes `superseded_by_world`, which today's deterioration never reveals, because its child loop skips every `spawn_condition` whose trigger is not `parent_unresolved` (`server/services/hazardDeteriorationService.ts:108-118`); its `properties.world_superseded` is set; and its `appears_at_minutes` stays at 1,000,000, the hidden minute item 40's copy gave it, which the update also writes in case a row lacks it, so no session list ever returns it (section 3.1). Children revealed before a late world started are no longer `delayed`, so they stay ordinary hazards, as do the session's other pre-generated children.

The function answers the two counts, which the fallback logs with `fieldops_world_fallback`. No event is broadcast for a retired child: no list ever returned it, because its copy has been hidden since the session started. The generic spawn of today's service still runs for a scene hazard whose timeline asks for one, as in any session without a world. Exposure casualties stay as they are. Unit assets stay as ordinary placed assets: the `PATCH` and `DELETE` refusal lifts with the world, because it asks `isWorldActive` too.

### 6.13 Environment, flag and settings

```ts
// server/env.ts (touched), inside the env object after WS0's field-ops block (01-prerequisites.md section 6.4).
// ON in development, OFF in production unless ENABLE_FIELDOPS_WORLD_SIM=true: the enableTeammateBots rule.
enableFieldopsWorldSim: readFieldopsWorldFlag(process.env, nodeEnv),
...readFieldopsWorldSettings(process.env),
```

```ts
// server/lib/fieldOps/worldSettings.ts (new). Owned by WS9. Pure: nothing from server/env.ts.
export const WORLD_SETTING_BOUNDS = {
  FIELDOPS_WORLD_MAX_SESSIONS: { fallback: 4, min: 0, max: 8 },       // 0: this process runs no world
  FIELDOPS_WORLD_WORKERS: { fallback: 2, min: 1, max: 4 },
  FIELDOPS_WORLD_LEASE_SECONDS: { fallback: 30, min: 15, max: 120 },
  FIELDOPS_WORLD_TICK_BUDGET_MS: { fallback: 250, min: 50, max: 900 },
  FIELDOPS_WORLD_SNAPSHOT_SECONDS: { fallback: 60, min: 30, max: 300 },
} as const;

export interface FieldopsWorldSettings {
  fieldopsWorldMaxSessions: number;
  fieldopsWorldWorkers: number;
  fieldopsWorldLeaseSeconds: number;
  fieldopsWorldTickBudgetMs: number;
  fieldopsWorldSnapshotSeconds: number;
}

/** WS0's readIntSetting for each: a missing or non-integer value takes the fallback, an integer is clamped. */
export declare function readFieldopsWorldSettings(source: Record<string, string | undefined>): FieldopsWorldSettings;
/** 'true' turns it on anywhere; outside production it is on unless 'false'. */
export declare function readFieldopsWorldFlag(source: Record<string, string | undefined>, nodeEnv: string): boolean;
```

The flag's property name follows master 10.7 rule 5, and the reading rule is the one `enableTeammateBots` uses (`server/env.ts:155-157`). The settings are tuning values that master section 8 leaves to the workstream that names them; section 15.3 asks the master to list them. `FIELDOPS_WORLD_MAX_SESSIONS=0` is the operational switch that keeps the flag on for compile's library and turns live worlds off in one process.

### 6.14 Routes

`server/routes/fieldOpsWorld.ts (new)` is a router with `mergeParams`, mounted at `/api/field-ops/sessions/:id/world` (master 10.3), as today's `teammateBotsRouter` is mounted under a session (`server/index.ts:252`). Every route runs `requireAuth`, then `requireFieldopsFlag(() => env.enableFieldopsWorldSim)` (the bare 404 while the flag is off, master 10.8 item 31), then its access check. Bodies go through `validate()` with the schemas of section 5.14 (400 `VALIDATION_FAILED`). Success bodies are `{ data }`. As WS0's job router is (`01-prerequisites.md` section 6.13), each router is built by a factory so the route tests can pass fakes: the module exports `createFieldOpsWorldRouter(deps)`, whose `deps` hold the runtime, the store, the access checks and the clock, and `fieldOpsWorldRouter`, built with the real ones; the library module exports `createSpreadLibraryRouter(deps)` and `fieldOpsSpreadLibraryRouter` the same way.

| Method and path | Who | Body | Success | Refusals |
| --- | --- | --- | --- | --- |
| `GET /api/field-ops/sessions/:id/world/view` | a session member (`assertSessionAccess`) | none | 200 `WorldView` for the caller's audience | 409 `WORLD_NOT_AVAILABLE` with `details.reason` when the session has no world row |
| `POST /api/field-ops/sessions/:id/world/units/:unitKey/dispatch` | a member of the unit's team, or the session's trainer or an admin | `dispatchBodySchema` | 202 `{ command_id, eta_s }` | 404 `UNIT_NOT_FOUND`; 403 `UNIT_NOT_YOURS`; 409 `WORLD_NOT_RUNNING`; 422 `TASK_NOT_ALLOWED`, `TARGET_OUT_OF_BOUNDS`, `TARGET_NOT_REACHABLE`, `ACCESS_DENIED_ZONE`; 429 `COMMAND_RATE_LIMITED` |
| `POST /api/field-ops/sessions/:id/world/units/:unitKey/recall` | as dispatch | none | 202 `{ command_id }` | as dispatch |
| `POST /api/field-ops/sessions/:id/world/units/:unitKey/task` | as dispatch | `taskBodySchema` | 202 `{ command_id }` | as dispatch, and 409 `UNIT_BUSY` when it is not working |
| `POST /api/field-ops/sessions/:id/world/reports` | a member of a team of the session | `reportBodySchema` | 201 `{ report_id }` | 403 `NOT_A_TEAM_MEMBER`; 422 `REPORT_NOT_KNOWN`; 400 `REPORT_TEXT_REFUSED`; 429 `COMMAND_RATE_LIMITED` |
| `GET /api/field-ops/sessions/:id/world/replay` | the session's trainer or an admin: every event; a participant: the events their teams could see | query `from_tick`, `to_tick`, `kinds` | 200 `{ events, snapshot_ticks }`, at most 2,000 events a page | 409 `WORLD_NOT_AVAILABLE` |
| `GET /api/field-ops/sessions/:id/world/replay/view` | the session's trainer or an admin | query `tick` | 200 `WorldView` (trainer audience) rebuilt from the snapshot at or before the tick | 404 `SNAPSHOT_NOT_FOUND` |
| `GET /api/field-ops/sessions/:id/world/settings` | the session's trainer or an admin (`requireFieldopsTrainer`, then `assertSessionOwner`) | none | 200 `{ settings, eligibility, status, model_ready, unit_plan, dropped_units }` | 403 per master 10.8 item 31 |
| `PATCH /api/field-ops/sessions/:id/world/settings` | as above | `worldSettingsSchema` | 200, the same body | 409 `SETTINGS_LOCKED` once the session is `in_progress` |
| `POST /api/field-ops/sessions/:id/world/prepare` | as above | none | 202 `{ job_id }`, the running job's id when one exists | 409 `WORLD_NOT_AVAILABLE` (not eligible) |
| `POST /api/field-ops/sessions/:id/world/weather` | as above | `weatherBodySchema` | 202 `{ command_id }` | 409 `WORLD_NOT_RUNNING` |
| `POST /api/field-ops/sessions/:id/world/roads/:edgeKey/close` and `.../open` | as above | `roadBodySchema` | 202 `{ command_id }` | 404 `ROAD_NOT_FOUND`; 409 `WORLD_NOT_RUNNING` |
| `POST /api/field-ops/sessions/:id/world/fires` | as above | `fireBodySchema` | 202 `{ command_id }` | 422 `TARGET_OUT_OF_BOUNDS`; 409 `WORLD_NOT_RUNNING` |
| `POST /api/field-ops/sessions/:id/world/pause`, `.../resume` | as above | none | 202 `{ command_id }` | 409 `WORLD_NOT_RUNNING` |
| `POST /api/field-ops/sessions/:id/world/stop` | as above | none | 202: the world falls back with `TRAINER_STOPPED` at its next heartbeat | 409 `WORLD_NOT_RUNNING` |

`server/routes/fieldOpsSpreadLibrary.ts (new)` is mounted at `/api/field-ops/spread-library`, a library resource (master 10.3). Its routes run `requireAuth`, the admin check, and `requireFieldopsFlag(() => env.enableFieldopsV2 || env.enableFieldopsWorldSim)`, because WS5's compile needs the library whether or not live worlds are on.

| Method and path | Body | Success | Refusals |
| --- | --- | --- | --- |
| `GET /api/field-ops/spread-library` | none | 200 `{ rows, dataset_version, version, review, review_history }`, every table of 249, 253 and 255 with retired rows | 503 `LIBRARY_TABLES_MISSING` |
| `POST /api/field-ops/spread-library/seed` | `{ tables?: string[] }` | 200 `{ inserted, dataset_version }` | 409 `LIBRARY_NOT_EMPTY`; 503 `LIBRARY_TABLES_MISSING` |
| `PATCH /api/field-ops/spread-library/:table/:key` | the table's patch schema | 200 `{ row, dataset_version }` | 404 `ROW_NOT_FOUND`; 400 `LIBRARY_TEXT_REFUSED` |
| `POST /api/field-ops/spread-library/:table/:key/retire` | none | 200 `{ row, dataset_version }` | 404 `ROW_NOT_FOUND`; 409 `ROW_REQUIRED` for a required key |
| `POST /api/field-ops/spread-library/reviews` | `reviewBodySchema` | 201 `{ review_id, state }` | 409 `VERSION_MISMATCH`; 409 `REVIEW_INCOMPLETE` |

**Rate limits**, keyed on the verified user id as the existing limiters are: world commands and reports 60 and 30 a minute per user and session (counted on `idx_fieldops_world_commands_rate`), the view 120 a minute, trainer commands 30 a minute, library edits 120 an hour, seeds 10 an hour.

**Command checks at the route**, before anything is queued: the session is `in_progress` or `paused` and its world `running` or `paused`; the caller may command the unit (`getCallerTeams` holds its team, or the caller is the session's trainer or an admin, `server/lib/access.ts:141-151`); the task is in `tasksForUnit`; the target is in the road box and allowed. The world checks again when it applies the command, because the world may have changed in between, and a refusal then reaches the team as a `command_rejected` event with the same code.

### 6.15 Socket events

| Event | Sent to | Data | When |
| --- | --- | --- | --- |
| `fieldops_world.delta` | `emitToUser` for each member of each team of the session, and for each participant with no team (the spectator audience) (`server/services/websocketService.ts:117-124`) | `WorldDelta` for that member's audience, with `session_id` so a user in two sessions can tell them apart | every 2 seconds when anything changed for that audience, and at once for a status change |
| `fieldops_world.trainer` | `emitToUser` for the session's trainer, and for admins who opened the world view in the last 5 minutes | `WorldDelta` of the trainer audience | as above |

Both use the existing `event` channel with `{ type, data, timestamp }`, so `useWebSocket` subscribes to them by type (section 3.6). No socket room is added (W19). Team membership is read from `session_teams` and refreshed every 15 seconds, so a player moved to another team gets the new team's deltas within 15 seconds and the old team's no longer. Today's events keep their rooms; in a fog session the four of section 6.10.5 are redacted.

### 6.16 Error codes

| Code | Status | Message |
| --- | --- | --- |
| `WORLD_NOT_AVAILABLE` | 409 | "There is no live world for this session." `details.reason` is one of `not_eligible`, `TABLES_MISSING`, `LIBRARY_MISSING` or a status reason |
| `WORLD_NOT_RUNNING` | 409 | "The live world is not running." |
| `UNIT_NOT_FOUND` | 404 | "Unit not found." |
| `UNIT_NOT_YOURS` | 403 | "That unit belongs to another agency." |
| `UNIT_BUSY` | 409 | "That unit is not on scene yet." |
| `TASK_NOT_ALLOWED` | 422 | "This unit cannot do that." |
| `TARGET_OUT_OF_BOUNDS` | 422 | "That place is outside the exercise area." |
| `TARGET_NOT_REACHABLE` | 422 | "No road or path reaches that place." |
| `ACCESS_DENIED_ZONE` | 422 | "Your agency may not enter that zone." |
| `NOT_A_TEAM_MEMBER` | 403 | "Only members of a team can share reports." |
| `REPORT_NOT_KNOWN` | 422 | "Your team has not seen that." |
| `REPORT_TEXT_REFUSED` | 400 | the reason `moderateDeviceText` gives |
| `COMMAND_RATE_LIMITED` | 429 | "Too many orders. Wait a moment." with `Retry-After` |
| `SETTINGS_LOCKED` | 409 | "World settings cannot change once the session has started." |
| `ROAD_NOT_FOUND` | 404 | "That road is not on the world's map." |
| `SNAPSHOT_NOT_FOUND` | 404 | "No saved state for that minute." |
| `WORLD_UNIT_ASSET` | 409 | "Move this unit from the units panel." (today's placements `PATCH` and `DELETE`) |
| `LIBRARY_TABLES_MISSING` | 503 | "The spread library is not installed on this server yet." |
| `LIBRARY_NOT_EMPTY` | 409 | "The library already has entries; seeding only fills empty tables." |
| `LIBRARY_TEXT_REFUSED` | 400 | the reason `moderateDeviceText` gives |
| `ROW_NOT_FOUND` | 404 | "No such library row." |
| `ROW_REQUIRED` | 409 | "This row is required and cannot be retired." |
| `VERSION_MISMATCH` | 409 | "The library changed while you were reviewing it. Reload and review again." |
| `REVIEW_INCOMPLETE` | 409 | "Every checklist item must be answered yes or not applicable before approval." |
| `VALIDATION_FAILED` | 400 | WS0's body (master 10.3) |
| `FORBIDDEN` | 403 | WS0's trainer refusal (master 10.8 item 31) |

### 6.17 Performance budgets

One Render instance runs the API, the sockets and every engine (master section 12; journey finding 4.14), so the world is bounded on every axis:

| Budget | Value | Enforced by |
| --- | --- | --- |
| Tick rate | 1 tick per second of world time, 1 second of world time per tick | the tick loop |
| Time per tick, in the thread | mean under 50 ms and never over 250 ms at the largest world | back-pressure (section 6.11.8); AC9.24 |
| Largest building | 20,000 cells over at most 4 floors, at 3, 4 or 5 m | the grid (section 6.6.3) |
| Crowd | 400 groups | `spawnGroups` |
| Units | 8 per agency, 40 per session | the unit plan |
| Plumes | 24 | `stepPlumes` |
| Worlds per process | 4, on 2 threads | the settings |
| Main thread | at most 5 ms per world per second (deltas, bridge, writes); event-loop lag under 50 ms at the 95th percentile | AC9.24 |
| Database writes | at most 150 a minute per world, 600 per process | section 6.11.6; AC9.26 |
| Socket traffic | one delta per audience every 2 seconds, at most 64 KB | `buildDelta` |
| Memory | 512 MB per thread | `resourceLimits` |
| Road graph | 200,000 nodes, 400,000 edges, 24 MB stored | `buildRoadGraph` and the 253 check |
| Spread timeline | 20,000 studs; a 120-second backstop under WS5's 90-second budget and signal | `SPREAD_LIMITS` |

**Added 3 Nov 2026. Verified: the instance these budgets run on.** Render's settings and metrics on 3 Nov 2026 show the backend on one Standard instance with 1 CPU and 2 GB. Over the day before, it used about 0.2 CPU and 0.4 GB. The table assumes 2 CPUs: two world threads beside the main thread. On 1 CPU the threads share the core with the API, the sockets and every engine, so the main thread's 50 ms lag target is not expected to hold with four worlds. There are two ways to run it:

- **Keep the Standard plan.** Run with `FIELDOPS_WORLD_WORKERS=1` and `FIELDOPS_WORLD_MAX_SESSIONS=1`, and raise them only when the soak of section 11.3 passes at the higher values.
- **Move the backend to a plan with 2 CPUs** (Render's Pro plan has 2 CPUs and 4 GB) before rollout step 3, and keep the defaults.

The choice is the owner's (question 22).

### 6.18 Exports and wiring

`server/services/fieldOps/world/index.ts (new)` exports, for WS5: `loadSpreadLibrary`, `deteriorationFactsFor`, `buildSpreadTimeline` and `SpreadTimelineError` (WS5 imports `buildSpreadTimeline` from `compileSpread.js` directly, as its section 6.16 writes, which the index also allows); for WS8, through WS5: the same `loadSpreadLibrary` and `buildSpreadTimeline`, which WS8's editor reaches only through WS5's `rebuildFireSpread` when a published layout or device edit changes the hazards, the interior walls or the main device (`06-compile-and-review.md` sections 6.15 and 6.16, `09-after-publish.md` section 6.8; section 15.5); for WS4: `CONTENTS_MATERIAL_OPTIONS`, from `shared/fieldOps/world.ts (new)` rather than the index; for WS7: the view route and, through `shared/`, `suggestUnitForTask`; for the touched services and routes: `isWorldActive`, `isWorldOwned`, `worldExitFactor`, `redactForFog`, `filterHazardRowsForViewer`, `filterCasualtyRowsForViewer`, `filterPlacementRowsForViewer`, `deviceDetonated` and `getWorldRuntime`.

`server/index.ts` (touched) gains:

1. The imports and mounts of `fieldOpsWorldRouter` at `/api/field-ops/sessions/:id/world` and `fieldOpsSpreadLibraryRouter` at `/api/field-ops/spread-library`, next to the other field-ops routers.
2. An import of `server/services/fieldOps/world/model/prepareJob.ts (new)`, so the job kind registers before the job engine starts (master 10.8 item 3).
3. `startWorldRuntime()` inside the background-engines block, after `startGeneratorEngines()` (`server/index.ts:100-105`).
4. `await stopWorldRuntime()` in `shutdown`, after WS0's `stopJobEngine()` (`server/index.ts:314-322`).

## 7. Client

### 7.1 Files and where they render (Proposed)

| Surface | Component | Mounted by | Shown when |
| --- | --- | --- | --- |
| The live map, everyone | `FieldOpsWorldLayer` with its layers and controls | one element in `frontend/src/components/COP/MapView.tsx`, next to `BuildingStudOverlay` (`frontend/src/components/COP/MapView.tsx:1637-1645`) and WS4's `FieldOpsSceneOverlay` | the view route answers 200 |
| The units panel, team members | `WorldUnitPanel`, a Leaflet control inside the layer | `FieldOpsWorldLayer` | the caller's audience is `team` and its teams have units |
| The world console, the trainer | `WorldConsole` | `frontend/src/pages/SessionView.tsx`, a trainer card after the Participants card (`frontend/src/pages/SessionView.tsx:2469-2536`), beside WS7's `AiAgencyConsole` | trainer, the session has a world row |
| The lobby, the trainer | `WorldLobbyCard` | `frontend/src/components/Session/SessionLobby.tsx`, beside `AITeammatesPanel` (`frontend/src/components/Session/SessionLobby.tsx:412-425`) and WS7's `FieldOpsLobbyPanel` | trainer, the settings route answers 200 |
| The After-Action Review | `WorldReplayPanel` | `frontend/src/components/AAR/AARDashboard.tsx`, after `PursuitTimeline` (`frontend/src/components/AAR/AARDashboard.tsx:1250`) | the replay route answers 200 |

Every component lives in `frontend/src/components/FieldOps/World/ (new)`, takes its classes from `frontend/src/design/fieldops-world.css (new)` and the existing `wr-` primitives, and draws its icons with `WrIcon` only (`docs/design/warroom/IMPLEMENTATION_SPEC.md:20`; master 10.8 item 19). There is no client flag (W20): every component asks its route and renders nothing on 404 or 409.

New files: `FieldOpsWorldLayer.tsx`, `WorldCellsLayer.tsx`, `WorldPlumesLayer.tsx`, `WorldCrowdLayer.tsx`, `WorldUnitsLayer.tsx`, `WorldRoadsLayer.tsx`, `WorldFogLayer.tsx`, `WorldStatusChip.tsx`, `WorldUnitPanel.tsx`, `WorldConsole.tsx`, `WorldLobbyCard.tsx`, `WorldReplayPanel.tsx`, the pure `worldLayerModel.ts` and `worldPalette.ts`, the hook `useWorldView.ts` and the small pick store `worldPick.ts`, all in that folder, and the API module `frontend/src/lib/fieldOps/worldApi.ts (new)`.

### 7.2 `FieldOpsWorldLayer`

```ts
// frontend/src/components/FieldOps/World/FieldOpsWorldLayer.tsx (new). Owned by WS9.
export function FieldOpsWorldLayer(props: { sessionId: string; teamName?: string }): JSX.Element | null;
```

It calls `useWorldView(sessionId)`, turns the view into shapes with the pure `worldLayerModel(view)` and draws them in Leaflet panes above the tiles and below today's pins, so hazard and casualty markers stay clickable:

| Layer (pane z-index) | Drawn from | Style (`worldPalette.ts`) |
| --- | --- | --- |
| `WorldFogLayer` (390) | `cover` and `last_known` | a canvas over the site's road box filled with `rgba(14, 26, 43, 0.55)`, the `--wr-deep` ink, with the cover circles and seen cells cut out (`destination-out`); not drawn for the trainer |
| `WorldCellsLayer` (400) | `cells`, `last_known` | one canvas: each cell a square in latitude and longitude (`cellRing`). Burning `rgba(239, 68, 68, 0.7)` with an inner `rgba(251, 146, 60, 0.9)`; heating `rgba(251, 146, 60, 0.45)`; burnt out `rgba(75, 75, 75, 0.35)`; wet `rgba(59, 130, 246, 0.25)`; smoke `rgba(55, 65, 81, a)` with `a` from 0.10 to 0.64 by decile; gas `rgba(163, 230, 53, 0.08 + 0.035 × decile)`; damaged cells hatched `#D97706`, unsafe `#B91C1C`, collapsed solid `#44403C` with a cross. Last-known cells at half opacity. Only the active floor is drawn, from MapView's floor selector |
| `WorldPlumesLayer` (410) | `plumes` | polygons: smoke `#6B7280`, toxic gas `#84CC16`, irritant `#EAB308`; fill opacity 0.12, 0.22 and 0.35 for light, moderate and dense; a dashed outline for last-known plumes |
| `WorldRoadsLayer` (420) | `roads` | closed `#B91C1C` dashed 6 4, weight 4; cordoned `#2563EB` dashed; jammed `#D97706`; slow `#EAB308` |
| `WorldCrowdLayer` (430) | `crowd_groups` | circles in WS4's crowd purple `#A855F7`, radius growing with the square root of the people; a thin arrow to the target exit; trapped groups with a `#B91C1C` ring, queued ones `#D97706`; tooltip "{people} people · {state}" |
| `WorldUnitsLayer` (440) | `units` | a 22 px disc in the team's `ARCHETYPE_TONE` with its `ARCHETYPE_ICON` glyph (WS1's maps in `frontend/src/components/UI/WarRoomIcon.tsx`, `10-ui-spec-sheet.md` section 12.3); own units ringed in white; the remaining path dashed in the tone; an arrival chip "{n} min" while en route; last-known units at half opacity with "seen {n} min ago" |
| `WorldStatusChip` (control, top left) | `tick`, `weather`, `status`, `unreviewed` | world clock, weather glyph and temperature, a wind arrow (the angle drawn as `WindIndicator` draws it, section 3.7), "Unreviewed model" while it applies, and the status line |
| `WorldUnitPanel` (control, top left, under the chip) | `units` | section 7.3 |

The colour ramps of the cells are those of the sandbox's `drawStudGrid` (`frontend/src/lib/rts/renderer.ts:209-305`), moved into `worldPalette.ts` so a person who knows the debug page recognises them. The layer never draws a device: `device_markers` reach only the trainer, and the trainer's markers are WS4's hidden-device marker: a white disc in a dashed (3 2) `#D97706` ring with the `eye-off` glyph (`10-ui-spec-sheet.md` section 2.5).

**Map clicks.** When `worldPick` is in a pick mode (a dispatch target, a road to close, a fire to start), the layer takes the next map click, resolves it to a point, the nearest exit within 8 m, the nearest road edge within 25 m or a cell, and hands it to whoever asked; Escape cancels. Otherwise clicks fall through to today's map.

### 7.3 `WorldUnitPanel` (team members)

A collapsible panel titled "Units" with the `truck` glyph. One row per unit of the member's teams: label, status ("At the station", "Turning out", "On the way · 6 min", "On scene", "Working: suppressing", "Returning", "Blocked", "Out of action"), and three buttons: **Dispatch**, **Recall** and **Change task**.

**Dispatch** is three steps in the panel: choose the task (only `tasksForUnit` for this unit, each with a one-line help), choose the place (click the map, or for keyboard use pick from "Exits", "Known hazards", "Known casualties", "Inspection points"), then confirm: "Send {unit} to {task} at {place}? About {eta} min." The route's refusals are shown under the confirm button with their messages. A known entity selected on the map shows **Share report**, which offers "Every team" or a team list and a note of up to 280 characters.

### 7.4 `WorldConsole` (the trainer)

A card titled "Live world" with the `layers` glyph and four blocks:

1. **Status.** World clock and session clock side by side; the status ("Running", "Paused", "Catching up", "Stopped", "Scripted escalation"); lag and degrade level in small text; buttons **Pause world** (or **Resume world**) and **Stop the live world**, the second with the confirmation "Stop the live world? The exercise continues with scripted escalation and the world cannot be restarted for this session."
2. **Weather.** A preset select, then the fields of `WeatherSetting` (condition, wind from in degrees, wind speed, temperature, rain, visibility, PSI when hazy) and "Change over {n} seconds" (0 to 600); **Apply weather**. Every team sees the change.
3. **Roads.** **Close a road** puts the map in pick mode; the closed roads are listed with **Reopen**; a box "Tell every team" (checked by default) makes the closure public.
4. **Fire.** **Start a fire** puts the map in pick mode inside the primary or an involved building, then asks "Start a fire at {place}?".

Under the blocks, one line: "Spectators see what all teams can see together. Hidden devices are shown only to you."

### 7.5 `WorldLobbyCard` (the trainer, before the start)

A card titled "Live world" with three switches (**Live world**, **Fog of war**, **Share unit positions with every team**), a status line ("World ready", "Preparing the world…", "Not available: {reason}") with **Prepare the world**, and one row per agency listing its units with a count stepper (0 to 8) and a start select: "Nearest {kind}" (automatic), each facility of the right kind within 10 km by name and distance, "An entry point", "A staging point…", which opens a small map dialog on the tile proxy centred on the site to click the point, and "On site" for venue staff. Under the rows: the weather the world will use, with **Change for this session**, which opens the console's weather form. Changes save through `PATCH /settings` and lock when the session starts.

### 7.6 `WorldReplayPanel` (the After-Action Review)

A panel titled "Live world timeline". For the trainer: a list of the world's events with filters (Fire, Structure, Crowd, Units, Roads, Weather, Reports), each row "{world time} · {what happened} · {where}"; a minute slider over the snapshot ticks; and a small map that draws the replay view of the chosen minute with the layers of section 7.2. For a participant: the events their teams could see, as a list, with no map.

### 7.7 The client API, the hook and the pick store

```ts
// frontend/src/lib/fieldOps/worldApi.ts (new). Owned by WS9. Uses WS0's fieldOpsRequest and FieldOpsApiError (master 10.8 item 31).
import type { UnitTask, WeatherSetting, WorldSettings, WorldTarget, WorldView } from '../../../../shared/fieldOps/world';

export const worldApi: {
  view(sessionId: string): Promise<WorldView | null>;          // 404 and 409 resolve to null
  dispatch(sessionId: string, unitKey: string, body: { target: WorldTarget; task: UnitTask }): Promise<{ command_id: number; eta_s: number | null }>;
  recall(sessionId: string, unitKey: string): Promise<{ command_id: number }>;
  setTask(sessionId: string, unitKey: string, body: { task: UnitTask; target?: WorldTarget }): Promise<{ command_id: number }>;
  report(sessionId: string, body: { entity_key: string; to_teams: string[]; note: string | null }): Promise<{ report_id: number }>;
  settings(sessionId: string): Promise<unknown>;
  saveSettings(sessionId: string, body: WorldSettings): Promise<unknown>;
  prepare(sessionId: string): Promise<{ job_id: string }>;
  weather(sessionId: string, body: { weather: WeatherSetting; transition_s: number }): Promise<{ command_id: number }>;
  closeRoad(sessionId: string, edgeKey: string): Promise<{ command_id: number }>;
  openRoad(sessionId: string, edgeKey: string): Promise<{ command_id: number }>;
  startFire(sessionId: string, target: WorldTarget): Promise<{ command_id: number }>;
  pause(sessionId: string): Promise<{ command_id: number }>;
  resume(sessionId: string): Promise<{ command_id: number }>;
  stop(sessionId: string): Promise<void>;
  replay(sessionId: string, query: { from_tick?: number; to_tick?: number; kinds?: string[] }): Promise<unknown>;
  replayView(sessionId: string, tick: number): Promise<WorldView>;
};
```

`useWorldView(sessionId)` returns `{ state: 'off' | 'loading' | 'ready' | 'error'; view: WorldView | null; reload(): void }`. It loads the view, subscribes with `useWebSocket({ sessionId, eventTypes: ['fieldops_world.delta', 'fieldops_world.trainer'], onEvent })`, ignores a delta whose `session_id` differs, applies the rest with WS9's pure `applyWorldDelta` (section 5.10.2), reloads on `'resync'` and on a reconnect, and polls the view every 30 seconds as a safety net, as `MapView` polls its pins (`frontend/src/components/COP/MapView.tsx:1145-1150`). `worldPick.ts` is a module-level store keyed by session (`setPickMode`, `onPicked`), so the console card and the layer inside the map talk without a context crossing `MapView`.

**The refetch signal (touched).** `MapView`'s handlers for `placement.created`, `placement.updated` and `placement.removed` (`frontend/src/components/COP/MapView.tsx:799-826`) and for `casualty.moved` and `casualty.updated` (`frontend/src/components/COP/MapView.tsx:845-884`) read the event's data. In a fog session that data may be `{ refetch: 'placements' }` or `{ refetch: 'casualties' }` (section 6.10.5), which today's handlers would silently ignore. So each handler first asks `refetchTargetOf(data)` and, when it answers, runs the same request as the periodic refresh for that list instead of reading the payload. `refetchTargetOf(data: unknown): 'hazards' | 'casualties' | 'placements' | null` is a pure function in `worldLayerModel.ts`, so the client test covers it. `MapView` subscribes to no hazard event today (`frontend/src/components/COP/MapView.tsx:762-782`), so hazards keep arriving by the periodic refresh and the world layer. Nothing else in `MapView` changes; outside a fog session the signal never appears.

### 7.8 What the debug sandbox gives

| Sandbox piece | Reused as |
| --- | --- |
| `drawStudGrid`'s colour ramps (`frontend/src/lib/rts/renderer.ts:209-305`) | The cell palette of `worldPalette.ts` |
| `SpatialEffectsEngine.step`'s order: hazard events, then fire, gas, flood, structure and smoke (`frontend/src/lib/rts/spatialEffects.ts:189-200`) | The order of the server tick (section 6.7.1), without flood |
| `DEFAULT_FIRE_PARAMS` (`frontend/src/lib/rts/fireSimulation.ts:30-59`), the browser's copy of the server's defaults | The values the equivalence test of AC9.9 pins as "today's constants" |
| `computePathThroughExits` (`frontend/src/lib/rts/pathfinding.ts:141-201`) | The idea of routing through exits; the server uses flow fields over the grid instead, because it moves many groups at once |
| `UNIT_CATALOG`'s foot speeds and abilities (`frontend/src/lib/rts/types.ts:29-134`) | A check on the foot speeds of section 5.10.1; the catalogue itself is new, because the sandbox's units are people of seven teams and WS9's are vehicles and crews of thirteen archetypes |
| `RTSEngine`, `DebugRTSSim` | Nothing: the page stays the debug tool it is; its engine is a browser loop with no server state |

Nothing under `frontend/src/lib/rts/` is imported by the server (section 3.8); the reuse is of behaviour and constants, written again in WS9's modules.

### 7.9 Stylesheet and icons

`frontend/src/design/fieldops-world.css (new)` holds `fo-world-chip`, `fo-world-units`, `fo-world-unit-row`, `fo-world-dispatch`, `fo-world-console`, `fo-world-lobby`, `fo-world-replay`, `fo-world-legend` and `fo-world-unreviewed`, built on the existing tokens (`--wr-deep`, `--border`, `--surface`, `--accent`, `--danger`, `--success`) with no new colour token, as the UI sheet found none needed for field ops (`10-ui-spec-sheet.md` section 2.1); the world's map colours, like the map palette of that sheet's section 2.5, are drawing constants in `worldPalette.ts`, not tokens.

Four glyphs are added to `WrIcon`'s paths (`frontend/src/components/UI/WarRoomIcon.tsx:11-94`, touched): `wind`, `rain`, `pause` and `barrier`. Each is drawn in these places only:

| Glyph | Drawn by |
| --- | --- |
| `wind` | `WorldStatusChip`, before the wind arrow and its speed; the "Wind from" and "Wind speed" fields of the console's weather block (`WorldConsole`) |
| `rain` | `WorldStatusChip`'s weather glyph in light rain and heavy rain. A thunderstorm takes the existing `bolt`; clear, cloudy and haze take no glyph, and the chip shows the condition's word instead (`world.weather.condition.*`) |
| `pause` | `WorldConsole`'s "Pause world" button, and `WorldStatusChip` beside the status line while the world is paused; "Resume world" takes the existing `play` |
| `barrier` | `WorldConsole`'s "Close a road" button and each of its closed-road rows, and the legend's "Road closed" entry; `WorldRoadsLayer` itself draws lines, not glyphs |

Existing glyphs cover the rest: `fire`, `truck`, `clock` for last-known positions, `eye-off` for the trainer's device markers, `layers`, `map`, `play`, `bolt`, `alert`, `x` and WS1's archetype glyphs. No emoji appears anywhere (D28).

### 7.10 Copy

| Key | Text |
| --- | --- |
| `world.status.running` | "Live world" |
| `world.status.paused` | "Live world paused" |
| `world.status.catching_up` | "Catching up…" |
| `world.status.fallback` | "Live world stopped. The exercise continues with scripted escalation." |
| `world.status.resumed` | "Live world resumed after {n} seconds." |
| `world.unreviewed` | "Unreviewed model" |
| `world.lastSeen` | "seen {n} min ago" |
| `world.units.title` | "Units" |
| `world.units.none` | "Your agency has no units in this exercise." |
| `world.units.unavailable` | "Units are not available on this server yet." |
| `world.dispatch.confirm` | "Send {unit} to {task} at {place}? About {eta} min." |
| `world.report.button` | "Share report" |
| `world.report.sent` | "Shared with {teams}." |
| `world.console.title` | "Live world" |
| `world.console.stopConfirm` | "Stop the live world? The exercise continues with scripted escalation and the world cannot be restarted for this session." |
| `world.console.spectators` | "Spectators see what all teams can see together. Hidden devices are shown only to you." |
| `world.lobby.ready` | "World ready" |
| `world.lobby.preparing` | "Preparing the world…" |
| `world.lobby.unavailable` | "Not available: {reason}" |
| `world.lobby.dropped` | "{n} units were left out: an agency may have 8 and a session 40." |
| `world.replay.title` | "Live world timeline" |
| `world.unit.eta` | "{n} min" |
| `world.crowd.tooltip` | "{people} people · {state}", with `{state}` from the crowd states below |
| `world.device.marker` | "Hidden device · {state} · only you can see this" |
| `world.device.state.pending` | "not yet found" |
| `world.device.state.detonated` | "detonated" |
| `world.device.state.removed` | "removed by the bomb squad" |
| `world.chip.temperature` | "{t} °C", in whole degrees |
| `world.chip.weatherAlt` | "{condition}, {temperature}, {wind}", with ", PSI {psi}" after the condition in haze; for example "Thunderstorm, 29 °C, wind from the south-west at 8 m/s" |
| `world.wind.from` | "wind from the {direction} at {speed} m/s", the direction being the nearest of the eight compass points below |
| `world.wind.calm` | "no wind", below 0.5 m/s |
| `world.pick.dispatch` | "Click where {unit} should go, or choose a place from the list." |
| `world.pick.road` | "Click the road to close." |
| `world.pick.fire` | "Click inside the main building or an involved building to start a fire there." |
| `world.pick.notBuilding` | "Choose a point inside the main building or an involved building." |
| `world.pick.escape` | "Press Escape to cancel." |
| `world.dispatch.send` | "Send" |
| `world.dispatch.cancel` | "Cancel" |
| `world.recall.confirm` | "Recall {unit}? It stops {task} and returns to {origin}." |
| `world.recall.yes` | "Recall" |
| `world.recall.no` | "Keep working" |
| `world.task.choose` | "Choose a new task for {unit}." |
| `world.task.place` | "Where? Click the map or choose from the list, or keep it where it is." |
| `world.task.here` | "Where it is now" |
| `world.task.confirm` | "Change {unit} from {current} to {task}?" |
| `world.task.yes` | "Change task" |
| `world.task.no` | "Cancel" |
| `world.report.noteLabel` | "Note for the other teams (optional, up to 280 characters)" |
| `world.report.send` | "Share" |
| `world.report.cancel` | "Cancel" |
| `world.console.onTime` | "On time" |
| `world.console.lag` | "{n} s behind" |
| `world.console.level.0` | "Full detail" |
| `world.console.level.1` | "Reduced detail: plumes and team views update less often" |
| `world.console.level.2` | "Low detail: fire, smoke, gas and structure update every 2 seconds" |
| `world.console.stopYes` | "Stop the live world" |
| `world.console.stopNo` | "Keep it running" |
| `world.console.fireYes` | "Start the fire" |
| `world.console.fireNo` | "Cancel" |
| `world.lobby.stepper` | "{kind} units for {agency}, 0 to 8", the stepper's accessible name |
| `world.lobby.facility` | "{name} · {distance}", the distance as "{km} km" to one decimal place from 1 km, else "{m} m" to the nearest 10 m; for example "Alexandra Fire Station · 2.4 km" |
| `world.lobby.stagingTitle` | "Set a staging point" |
| `world.lobby.stagingHelp` | "Click the map where {unit} should wait until it is dispatched. Choose a point on or beside a road." |
| `world.lobby.stagingYes` | "Use this point" |
| `world.lobby.stagingNo` | "Cancel" |
| `world.lobby.weatherLine` | "Weather: {summary} ({source})", the summary worded as `world.chip.weatherAlt` |
| `world.replay.slider` | "Minute of the live world" |
| `world.replay.sliderValue` | "Minute {m} of {total}" |
| `world.replay.empty` | "The live world recorded no events in this session." |
| `world.replay.emptyFilter` | "No events of this kind." |
| `world.counters.summary` | "Live world at {clock}. Fire in {burning} map squares, smoke in {smoke}, {unsafe} unsafe and {collapsed} collapsed. {inside} people inside, {out} out and {trapped} trapped. {hurt} people hurt by smoke, gas, heat or collapse." Read through a visually hidden description of the map, as the site map has one |
| `world.counters.fog` | "These counts are of what your team can see." Added for a team or a spectator in a fog session |

Task labels: "Move", "Observe", "Suppress", "Ventilate", "Rescue", "Shore up", "Decontaminate", "Triage", "Transport", "Cordon", "Direct the crowd", "Close exit", "Open exit", "Close road", "Sweep", "Command post", "Isolate utilities".

Each task's working status and one-line help, in `UNIT_TASKS` order (keys `world.unit.working.<task>` and `world.task.help.<task>`). The help shows under each task in the dispatch and change-task steps (section 7.3):

| Task | Working status | Help |
| --- | --- | --- |
| `move` | "Working: moving into position" | "Go to a place and stay there." |
| `observe` | "Working: observing" | "Stay and watch the area around the unit." |
| `suppress` | "Working: suppressing" | "Put out the nearest fire within the crew's reach." |
| `ventilate` | "Working: ventilating" | "Open an exit or opening to clear smoke faster; fire close to it grows faster." |
| `rescue` | "Working: rescuing" | "Bring trapped people and casualties out to the crew's exit." |
| `shore` | "Working: shoring up" | "Prop up damaged structure so it gets no worse and rescuers can go in." |
| `decon` | "Working: decontaminating" | "Set up a decontamination point; people near it stop taking in gas." |
| `triage` | "Working: triaging" | "Stay with the casualties so your medics can assess and tag them." |
| `transport` | "Working: transporting a patient" | "Take a patient to the nearest suitable hospital." |
| `cordon` | "Working: holding a cordon" | "Hold a ring or a line that keeps the crowd out of a danger area." |
| `direct_crowd` | "Working: directing the crowd" | "Get nearby people moving, to the exit you choose or the nearest open one." |
| `close_exit` | "Working: keeping an exit closed" | "Stop the crowd using an exit." |
| `open_exit` | "Working: keeping an exit open" | "Let the crowd use a closed exit again." |
| `close_road` | "Working: closing a road" | "Close nearby roads to traffic; emergency units still pass." |
| `sweep` | "Working: sweeping" | "Search the chosen inspection point." |
| `command_post` | "Working: running a command post" | "Set up a command post that watches 100 m around it." |
| `isolate_utility` | "Working: isolating utilities" | "Make nearby electrical hazards safe, so they cannot start or feed a fire." |

Crowd states (`world.crowd.state.<state>`): `waiting` "waiting to move"; `moving` "moving to an exit"; `queued` "queuing at an exit"; `outside` "outside, walking to safety"; `mustered` "at the muster point"; `trapped` "trapped"; `held` "held at a cordon".

Weather words: conditions (`world.weather.condition.<condition>`) `clear` "Clear", `cloudy` "Cloudy", `light_rain` "Light rain", `heavy_rain` "Heavy rain", `thunderstorm` "Thunderstorm", `haze` "Haze"; compass points (`world.compass.<point>`) "north", "north-east", "east", "south-east", "south", "south-west", "west" and "north-west"; the weather line's sources (`world.weather.source.<origin>`) `trainer` "set in Setup", `preset` "a Setup preset", `label` "read from Setup's weather", `default` "Singapore's usual weather, as Setup gave none", and `override` "changed for this session" when the lobby set one.

The console's weather fields (`world.weather.field.<field>`), each with its unit: `preset` "Preset"; `condition` "Conditions"; `wind_from` "Wind from (degrees, 0 is north)"; `wind_speed` "Wind speed (m/s)"; `temperature` "Temperature (°C)"; `rain` "Rain (mm an hour)"; `visibility` "Visibility (m)"; `psi` "Haze (PSI)", shown only when the condition is haze.

The legend (`fo-world-legend`, title `world.legend.title` "Map key") lists only the entries of the layers the audience can see (keys `world.legend.<entry>`): `burning` "On fire"; `heating` "Heating up"; `burnt` "Burnt out"; `wet` "Wetted down"; `smoke` "Smoke (darker is thicker)"; `gas` "Gas (darker is stronger)"; `damaged` "Damaged structure"; `unsafe` "Unsafe structure"; `collapsed` "Collapsed"; `plumeSmoke` "Smoke plume"; `plumeToxic` "Toxic gas plume"; `plumeIrritant` "Irritant gas plume"; `roadClosed` "Road closed"; `cordon` "Cordon"; `jam` "Traffic jam"; `slow` "Slow traffic"; `crowd` "People (a bigger circle is more people)"; `trapped` "Trapped people"; `queued` "Queuing at an exit"; `ownUnit` "Your units"; `otherUnit` "Other agencies' units"; `lastSeen` "Last seen here"; `fog` "Not in view (fog of war)", for a team or a spectator only; `device` "Hidden device (only you can see this)", for the trainer only.

The words after "Not available:" (`world.lobby.reason.<code>`), one for each reason the settings route can give (section 6.16):

| Reason | Words |
| --- | --- |
| `not_eligible` | "this scenario has no layout the live world can use" |
| `TABLES_MISSING` | "the live world is not installed on this server yet" |
| `LIBRARY_MISSING` | "the fire and smoke data are not loaded yet" |
| `NOT_ALLOWED_UNREVIEWED` | "the fire and smoke model is still under review, so only admins can run it" |
| `WORLD_TOO_LARGE` | "the main building is too large to model" |
| `MODEL_FAILED` | "the world could not be prepared; try Prepare the world again" |
| `NO_CAPACITY` | "the server is already running as many live worlds as it can" |
| `STARTED_TOO_LATE` | "the world was not ready within 10 minutes of the start" |
| `WORLD_BEHIND` | "the world fell behind and stopped" |
| `ENGINE_ERROR` | "the world stopped after an error" |
| `SESSION_ENDED` | "the session has ended" |
| `TRAINER_STOPPED` | "you stopped the live world" |

The replay list's text for each event kind (`world.event.<kind>`), shown as `{what happened}` in its rows (section 7.6). Units, tasks, teams and places are data; agents read "smoke", "toxic gas", "irritant gas", "heat from the fire", "heat stress" or "the collapse":

| Kind | Text | Kind | Text |
| --- | --- | --- | --- |
| `world_started` | "Live world started" | `crowd_mustered` | "{n} people reached the muster point" |
| `world_paused` | "Live world paused" | `crowd_trapped` | "{n} people trapped" |
| `world_resumed` | "Live world resumed" | `exposure_casualties` | "{n} people hurt by {agent}" |
| `world_stopped` | "Live world stopped" | `unit_dispatched` | "{unit} dispatched: {task}" |
| `world_fallback` | "Live world stopped; scripted escalation took over" | `unit_arrived` | "{unit} arrived" |
| `blast_applied` | "Blast damage" | `unit_task_started` | "{unit} started: {task}" |
| `fire_region_ignited` | "Fire started" | `unit_task_ended` | "{unit} finished: {task}" |
| `fire_region_grew` | "Fire spread" | `unit_recalled` | "{unit} recalled" |
| `fire_region_out` | "Fire out" | `unit_blocked` | "{unit} blocked: {reason}" |
| `wall_breached` | "Fire burnt through a wall" | `unit_out_of_action` | "{unit} out of action" |
| `glazing_failed` | "Windows broke" | `road_closed` | "Road closed" |
| `structure_damaged` | "Structure damaged" | `road_opened` | "Road reopened" |
| `structure_unsafe` | "Structure unsafe" | `road_jammed` | "Traffic jammed" |
| `structure_collapsed` | "Structure collapsed" | `weather_changed` | "Weather changed: {condition}" |
| `plume_started` | "Plume started: {agent}" | `report_shared` | "{team} shared a report" |
| `plume_ended` | "Plume cleared: {agent}" | `command_rejected` | "Order refused: {message}" |
| `crowd_moving` | "{n} people started to leave" | `device_detonated` | "Device detonated" |
| `exit_congested` | "Exit congested" | `trainer_fire_started` | "Fire started by the trainer" |
| `exit_blocked` | "Exit blocked" | | |

The polite announcements (`world.announce.<event>`), sent to the live region of section 7.11 for the people who can see the event: `started` "Live world started."; `paused` "Live world paused."; `resumed` the text of `world.status.resumed`; `catching_up` "Live world catching up."; `fallback` the text of `world.status.fallback`; `stopped`, to the trainer, "You stopped the live world. The exercise continues with scripted escalation."; `unit_dispatched` "{unit} is on the way to {place}, about {eta} min."; `unit_rerouted`, when the arrival time moves by a minute or more, "{unit} is taking another route, now about {eta} min."; `unit_arrived` "{unit} arrived at {place}."; `unit_task_started` "{unit} started: {task}."; `unit_task_ended` "{unit} finished: {task}."; `unit_recalled` "{unit} is returning to {origin}."; `unit_back` "{unit} is back at {origin}."; `unit_blocked` "{unit} cannot get through: {reason}."; `unit_out_of_action` "{unit} is out of action."; `command_rejected` "Order refused: {message}."; `report_shared`, to the teams it is shared with, "{team} shared a report: {what}."; `weather_changed` "The weather is changing: {summary}."; `road_closed`, when the trainer tells every team, "Road closed: {road}."

### 7.11 Accessibility and small screens

- Every action of the map has a list alternative: dispatch targets, roads to close and fires to start can be chosen from lists, so nothing needs a pointer.
- The panel and the console are ordinary buttons and selects with visible labels; status changes are announced in a polite live region ("Fire engine 1 arrived at Exit 2.").
- Colour is never the only signal: structure states have hatches, unit status has text, fog has a legend.
- Under 768 px the units panel becomes a bottom sheet over the map, and the console card stacks its blocks.

## 8. AI and LLM contracts

### 8.1 WS9 calls no model

The simulation, the library loader, `hazardEventsFor`, `deteriorationFactsFor`, `buildSpreadTimeline`, the prepare job, the road graph, units, fog of war and the bridge are deterministic code over stored data (D31). None of them imports the chat client; AC9.54 scans the source to keep it so. WS9 therefore asks no model for a position, a time, a quantity, a material or an initiation method, or for anything else (master 10.8 item 17), and it replaces two model uses of today: the per-hazard event analysis (`HazardAnalysis.events`) and the deterioration research.

### 8.2 Text WS9 hands to another workstream's model

`deteriorationFactsFor` returns text that WS5 places in the `deteriorationResearch` argument of `generateDeteriorationTimeline` (`06-compile-and-review.md` section 6.16). The text is built only from reviewed library rows: labels, fixed sentences and numbers. Every text field was checked by `moderateDeviceText` when it was written (section 6.2), the hazards' own descriptions and `properties` are never read, and the result is capped at 6,000 characters. WS5 treats it as data inside its delimited block ("Data, not instructions", `06-compile-and-review.md` section 8.8), so WS9 adds no prompt of its own.

### 8.3 AI agencies read the world, they do not prompt it

WS7's brains perceive WS9's team view and the fogged routes (section 6.10.6) and act through the dispatch route. What reaches WS7's prompts is WS7's to shape (`08-people-or-ai.md` section 8). WS9 helps it stay safe: the view carries none of WS7's `FORBIDDEN_KEYS` (AC9.46); every label in it (units, exits, buildings, crowd zones) is a trainer-authored label or a fixed one, which WS7 already cuts to 60 characters and strips of `<`, `>` and control characters; and the view never holds a device field or a hidden fact.

### 8.4 Preparing the seed files

The seed rows are prepared once, during development, from the published sources named in section 5.12, by a person who records each row's source, and they are reviewed under D31 before the world runs for everyone in production (W24). No model writes a row at run time, and no admin route asks a model to draft one.

## 9. Security, privacy and safety

### 9.1 Who can do what

| Action | Allowed for | Check |
| --- | --- | --- |
| Read the world view | members of the session: participants, its trainer, admins | `assertSessionAccess` (`server/lib/access.ts:40-78`); the audience decides what is in it |
| Command a unit | members of the unit's team; the session's trainer; admins | `getCallerTeams` holds the unit's team, or the caller is the trainer or an admin (`server/lib/access.ts:141-151`) |
| Share a report | members of a team of the session | as above; spectators cannot |
| Settings, prepare, weather, roads, fires, pause, resume, stop | the session's trainer, admins | `requireFieldopsTrainer`, then `assertSessionOwner` (`server/lib/access.ts:84-109`; master 10.8 item 31) |
| The full replay and replay views | the session's trainer, admins | as above; participants get their teams' events only |
| The library's routes | admins | the admin check, as WS6's library routes do (`07-device-and-physics.md` section 6.6) |

The client is never trusted for a role or a team: every check runs on the server with the verified user (master 10.3).

### 9.2 Answer keys and hidden facts

- **Tables.** Every WS9 table has row level security on with no policy and its privileges revoked from `PUBLIC`, `anon` and `authenticated` (section 5.1). The world model holds device positions and radii; snapshots hold the whole state, hidden fires included; knowledge holds what each team has not seen. Only the service role reads them, and only through the routes of section 6.14.
- **Scenarios.** Nothing of WS9's is written to a column of `scenarios` (master 10.8 item 16). The model reads WS5's physics snapshot through `loadPhysicsSnapshot`, which leaves out the device pool.
- **Devices.** Device positions reach only the trainer's audience as `device_markers`. A team learns of a device only as today's game reveals it: a sweep that finds it, or its detonation.
- **Casualties.** The true colour of an exposure casualty is written to `conditions.triage_color`, which WS0's projection removes for participants (`01-prerequisites.md` section 6.5.2).
- **The scene's read policy.** Today any holder of the anon key can read every `rts_scene_configs` row, planted-device positions included (master risk 14). Fog of war cannot repair that: it is the owner's production gate (`05-layout-step.md` section 9.2), and section 9.7 repeats it as a gate for WS9.

### 9.3 Fog of war is a server-side boundary

Every payload a browser or an AI agency receives in a fog session is filtered on the server: the world's own views, deltas and replays (section 6.10.4), today's hazard and casualty routes and their broadcasts, and, while unit sharing is off, other teams' unit assets (section 6.10.5). The filters are pure functions tested against seeded random states (AC9.46) and run after WS0's projections, never instead of them (master 10.8 items 12 and 28). What stays unfiltered is named in section 6.10.5 with its reason. A browser asking a world route for another session gets today's 404 or 403 from `assertSessionAccess`, so it cannot learn that a world exists.

### 9.4 Safety

- **Effects only.** The library describes buildings, contents, walls, frames, smoke, gas, exposure and weather; no row describes a device, and the seed test checks every text field with `moderateDeviceText` (AC9.55). The words "secondary fire" are used for the trainer's control, never "secondary device".
- **Device data.** The world reads each device's position, floor and role from `CompileDeviceEffect`, its `bands_m`, and from its `estimate` only the central structural and thermal radii (section 6.6.2), and nothing else: no equivalence, charge, fragment, casing, container detail, calculation input or initiation field is read, stored or shown (`07-device-and-physics.md` section 9).
- **No optimisation of harm.** The world computes consequences of what the trainer laid out and what teams do. It never searches over positions or times, never ranks where something would do most harm, and offers no suggestion about placing or timing anything; the trainer's console starts fires only at a point she chooses inside a building.
- **Training values.** Exposure doses and injury shares are planning values for a training exercise, labelled "Unreviewed model" until reviewed (W24); the console and the replay never present them as medical or engineering advice.

### 9.5 Input bounds and abuse

Every body passes a zod schema with explicit caps (section 5.14): a command payload is at most 16 KB, a report note 280 characters, a target inside the road box, at most 40 units and 10 agency overrides. Rate limits are those of section 6.14. Commands are written before they are applied, so a burst cannot outrun the log, and the per-tick command queue is bounded at 200 commands a session; beyond that the route answers 429.

### 9.6 Logging

WS9's log events start with `fieldops_world_` or `fieldops_spread_` (master 10.5) and carry ids, counts, kinds, ticks, durations and status codes only. They never carry a device field, a hazard's description, a report's note, a library row's text, or the position of anything hidden. AC9.53 checks a full run's log lines.

### 9.7 Before production

1. The D31 review of the spread library is recorded for the deployed dataset (W24). Until then production runs worlds only for admins' sessions.
2. The owner has decided on the `rts_scene_configs` read policy (master risk 14): fog of war is pointless while the anon key reads the layout's device positions.
3. Production runs one instance (master section 12), so every socket is served by the process holding the worlds (risk R9.6).
4. The soak of section 11.3 passes on the staging instance with four worlds at the largest size.
5. The security review of this spec's routes closes its items, with WS7's projection check run against WS9's views.

## 10. Flags, rollout and observability

### 10.1 The flag, the settings and the per-session switches

| Control | Where | Default | Effect |
| --- | --- | --- | --- |
| `ENABLE_FIELDOPS_WORLD_SIM` | server environment, read by `readFieldopsWorldFlag` (section 6.13) | on in development, off in production unless set to `true` | Off: no world row is created, every world route answers the bare 404, the four gates are inert, and the session runs today's scripted escalation. The spread library and its routes keep working while `ENABLE_FIELDOPS_V2` is on, because WS5's compile needs them |
| `FIELDOPS_WORLD_MAX_SESSIONS` | server environment | 4 (0 to 8) | Worlds this process hosts. 0 keeps the flag on for the library and turns live worlds off: new worlds end in `NO_CAPACITY` after 120 seconds (section 6.11.3) |
| `FIELDOPS_WORLD_WORKERS` | server environment | 2 (1 to 4) | Worker threads for worlds; the compile-time spread uses its own short-lived worker |
| `FIELDOPS_WORLD_LEASE_SECONDS` | server environment | 30 (15 to 120) | How fast another process takes over a dead holder's worlds |
| `FIELDOPS_WORLD_TICK_BUDGET_MS` | server environment | 250 (50 to 900) | The slow-tick threshold of the back-pressure (section 6.11.8) |
| `FIELDOPS_WORLD_SNAPSHOT_SECONDS` | server environment | 60 (30 to 300) | Snapshot interval: the replay's resolution and the recovery's longest replay |
| Live world, Fog of war, Share unit positions | the lobby card, `fieldops_world_sessions.settings` | on, on, on | Per session, locked at the start (section 7.5) |
| The review gate | `fieldops_spread_reviews` | unreviewed | In production an unreviewed library runs worlds only for admins (W24) |

There is no client flag (W20). The client asks the server and renders nothing on 404 or 409.

### 10.2 Rollout

Each step needs the one before it to have held for the time shown. Development has the flag on from the first commit.

The project has one Supabase database for development, preview and production. So every migration first applies twice without error on a scratch database (a Supabase branch or a local Postgres, never the shared project), and is then applied once, in order, on the shared project, where every environment sees it at the same moment. The steps below switch servers and flags, not databases. Seeding writes to the same shared tables, so it is done once.

| Step | Slices | Where | What is switched | Move on when |
| --- | --- | --- | --- | --- |
| 1 | 1 | the shared project, then staging | Apply 249 once on the shared project after its scratch runs; seed the library once with `POST /api/field-ops/spread-library/seed`; staging's compile runs with it under `ENABLE_FIELDOPS_V2` | Five compiles of the mockup scenario produce fire-spread pins and a facts block; `fieldops_spread_timeline_built` shows each under 60 seconds; the D31 review is requested |
| 2 | 1 | production | Nothing to apply or seed: production reads the same tables | WS5's compile in production logs `fieldops_spread_library_loaded` with the seeded version |
| 3 | 2 | the shared project, then staging | Apply 250 to 252 once, in order, after their scratch runs; on staging `ENABLE_FIELDOPS_WORLD_SIM=true` and `FIELDOPS_WORLD_MAX_SESSIONS=2` | Manual steps M1 to M6 pass; the soak of section 11.3 passes; a week with no `fieldops_world_fallback` other than `TRAINER_STOPPED` and `SESSION_ENDED` |
| 4 | 3 | the shared project, then staging | Apply 253 once after its scratch runs; seed its speed classes with the seed route and `{ tables: ['fieldops_road_speed_classes'] }`; prepare road graphs for the seeded sites | M7 and M8 pass; dispatch to arrival within 10 per cent of the predicted time in five runs |
| 5 | 4 | the shared project, then staging | Apply 254 once after its scratch runs; fog on in test sessions | M10 passes; the AC9.46 corpus passes against staging data; an AI agency plays a fog session to the end |
| 6 | 5 | the shared project, then staging | Apply 255 once after its scratch runs; seed its two tables with `{ tables: ['fieldops_weather_presets', 'fieldops_traffic_profiles'] }` | M11 and M12 pass |
| 7 | all | production | `ENABLE_FIELDOPS_WORLD_SIM=true`, `FIELDOPS_WORLD_MAX_SESSIONS=2`; worlds run for admins only until the review is approved | The gates of section 9.7 hold; two weeks of admin-run sessions with no unexplained fallback |
| 8 | all | production | Review approved for the deployed `dataset_version`; `FIELDOPS_WORLD_MAX_SESSIONS=4` | `fieldops_world_main_lag` shows the main thread's lag under 50 ms at the 95th percentile with four worlds |

### 10.3 Log events

All through the existing `pino` logger, snake case with the `fieldops_` prefix, and carrying only ids, counts, kinds, ticks and durations (master 10.5; section 9.6).

| Event | When | Fields |
| --- | --- | --- |
| `fieldops_spread_library_loaded` | a library is loaded into the cache | `dataset_version`, `version`, `rows`, `review_state`, `ms` |
| `fieldops_spread_library_missing` | 249 is not applied (at most once a minute) | none |
| `fieldops_spread_library_empty` | the tables hold no active row | none |
| `fieldops_spread_library_invalid` | the integrity check fails | `missing_keys` (library keys only), `problems` (count) |
| `fieldops_spread_library_changed` | an admin route writes | `table`, `key`, `actor_id`, `dataset_version` |
| `fieldops_spread_timeline_built` | `buildSpreadTimeline` resolves | `studs_in`, `studs_used`, `hazards`, `events`, `snapshots`, `ms` |
| `fieldops_spread_timeline_failed` | it rejects | `code`, `ms` |
| `fieldops_world_prepare_done` | the prepare job finishes | `session_id`, `model_id`, `cells`, `floors`, `groups`, `units`, `road_nodes`, `ms` |
| `fieldops_world_prepare_failed` | the prepare job fails | `session_id`, `code` |
| `fieldops_world_started` | a world's first tick | `session_id`, `cells`, `units`, `fog`, `late_ticks` |
| `fieldops_world_tick_slow` | a tick over the budget (at most once a minute a world) | `session_id`, `tick`, `ms`, `level` |
| `fieldops_world_degraded` | the degrade level changes | `session_id`, `from`, `to` |
| `fieldops_world_fallback` | a world falls back or is stopped | `session_id`, `reason`, `tick`, `handed_back`, `superseded` |
| `fieldops_world_lease_claimed` | a process takes a world | `session_id`, `worker_id`, `from_tick` |
| `fieldops_world_lease_lost` | a heartbeat answers `lost` | `session_id`, `worker_id` |
| `fieldops_world_recovered` | restore and replay finish | `session_id`, `from_tick`, `to_tick`, `commands`, `ms` |
| `fieldops_world_command_rejected` | a command fails its checks | `session_id`, `kind`, `code` |
| `fieldops_world_bridge_failed` | a bridge write fails (retried once) | `session_id`, `op`, `code` |
| `fieldops_world_stats` | every 60 seconds a world | `session_id`, `tick`, `tick_ms_p50`, `tick_ms_p95`, `lag_s`, `level`, `writes_last_min`, `delta_bytes_last_min`, `burning_cells`, `groups`, `units_moving` |
| `fieldops_world_main_lag` | every 60 seconds a process hosting worlds | `worlds`, `event_loop_p95_ms`, `rss_mb` |
| `fieldops_world_finished` | a world stops | `session_id`, `reason`, `ticks`, `events` |

There is no alerting system today, so during steps 3 to 8 the owner reads the Render log search for `fieldops_world_fallback`, `fieldops_world_main_lag` and `fieldops_spread_library_invalid` each day a session runs.

### 10.4 Rollback

| Scope | Action | Result |
| --- | --- | --- |
| One session | The trainer's **Stop the live world** | The world falls back with `TRAINER_STOPPED`; its hazards are handed back (section 6.12.3) and the session continues with today's escalation |
| One process | `FIELDOPS_WORLD_MAX_SESSIONS=0` and a restart | Hosted worlds are snapshotted and released at shutdown, then fall back with `NO_CAPACITY` 120 seconds later; compile keeps its library |
| The feature | `ENABLE_FIELDOPS_WORLD_SIM=false` and a restart | No world runs; `isWorldActive` is false everywhere, so every hazard, world-owned or not, escalates as today and the routes answer 404 |
| A bad library row | `POST /api/field-ops/spread-library/retire` or `PATCH` the row | The next load uses the corrected rows; worlds already running keep their frozen library (section 6.11.7) |
| The schema | None on the shared project: the set never runs a rollback there. With the flag off nothing reads the world tables, so they stay, additive and unused (D23). The rollback comments at the top of 255 down to 249 are tried, in that order, on a branch database only | Rows the bridge wrote to `scenario_hazards`, `scenario_casualties` and `placed_assets` stay as ordinary rows |

### 10.5 Runbook

| Symptom | Check | Action |
| --- | --- | --- |
| A session shows "Live world stopped" | `fieldops_world_fallback` for the session | `WORLD_BEHIND`: lower `FIELDOPS_WORLD_MAX_SESSIONS`; `ENGINE_ERROR`: keep the log lines and the session id for a bug; `NO_CAPACITY`: raise the cap or wait for a session to end |
| Map, chat or injects feel slow while worlds run | `fieldops_world_main_lag` over 50 ms | Lower the cap to 2; if it persists, set it to 0 and report the stats lines |
| Compile has no fire-spread pins | `fieldops_spread_library_missing`, `_empty` or `_invalid`; `fieldops_spread_timeline_failed` | Apply 249 on the shared project after its scratch runs, seed it, or fix the rows the invalid line names; for repeated `timeout` or `aborted` codes, report the building's stud count |
| A team says it sees nothing | the session's settings and `fieldops_world_stats` | With fog on and no units dispatched, a team sees only what its posts and placed assets cover, which is expected. Turn fog off in the lobby for a training run that needs the full picture |
| A world did not start | `fieldops_world_prepare_failed` and the row's reason | `WORLD_TOO_LARGE`: the building is beyond the grid limits and the session runs today's escalation; `STARTED_TOO_LATE`: prepare earlier from the lobby |

## 11. Tests

Server and shared tests use `node:test` through `tsx`; client tests live in `frontend/tests/` (master 10.6). Tests of `shared/` modules sit in `server/lib/fieldOps/` and import with a `.js` suffix (master 10.7 rule 3). No test calls a model, the network or a real database: stores are in-memory fakes that enforce the rules of section 5, as WS0's `JobStore` fake does (`01-prerequisites.md` section 11.2).

### 11.1 Test files and their cases

| File | Cases (inputs, expected outputs, edge and failure cases) | Criteria |
| --- | --- | --- |
| `server/lib/fieldOps/worldRules.test.ts (new)` | "materials": the seven wall inputs of AC9.11, plus `Gypsum board` to `drywall`, `marble` to `unknown_wall`, a contents `retail shelving` to `contents_retail` and an empty contents text to `contents_generic`. "weather from the label": the four labels at 15:30 and 21:00 give the presets of section 5.12.6, `PSI 180` gives `haze_psi` 180, night visibility after 19:15; `weatherSettingSchema` refuses a wind of 400 degrees, a `haze_psi` with `clear`, and a non-integer `wind_from_deg`. "unit catalogue": AC9.34 over the 13 archetypes and both scope flags. "structure states": 249, 250, 499, 500, 849 and 850 permille land in the four states. "deltas": a delta whose tick is older than the view's gives `'resync'`; a cells patch replaces only its indices; a unit upsert and a removal; an empty delta returns an equal view. "geometry": `cellCentre` and `cellRing` of a 3 m frame round-trip within 0.1 m. "clock": 0 gives `00:00:00` and 3,725 gives `01:02:05` | AC9.11, AC9.34, AC9.48 |
| `server/services/fieldOps/world/spreadLibrary.test.ts (new)` | "null when missing or empty": a fake detector answering false, then empty tables, then the seeded rows (three calls inside a minute log `fieldops_spread_library_missing` once). "integrity": each required key removed in turn gives null and names it; a hazard whose `contents_key` names a retired row; two aliases resolving to two keys; bands out of order. "dataset version": the seed rows shuffled give one version; one number changed gives another; the tables seeded from the files give the files' version. "facts block": AC9.6, including the 60-hazard cap and the null library. "review gate": AC9.12, plus a review for an older version leaving the library `unreviewed`. "seed hygiene": AC9.55 over every seed file, with `buildSpreadLibrary` giving `outcome: 'ok'` and canonical JSON under 262,144 bytes. "contents options parity": the keys and labels of `CONTENTS_MATERIAL_OPTIONS` equal those of the seed's `contents` rows in the constant's order; a seed row added without the constant, or the reverse, fails; each key resolves to itself (AC9.57) | AC9.1, AC9.2, AC9.3, AC9.6, AC9.12, AC9.55, AC9.57 |
| `server/services/fieldOps/world/hazardEvents.test.ts (new)` | Every hazard type at each severity, twice, deep-equal (AC9.4); the timing cases of AC9.5; an unknown type and a missing row give `[]`; a radius above `max_radius_m` is capped; the result has no key beyond the `HazardEvent` fields | AC9.4, AC9.5 |
| `server/services/fieldOps/world/compileSpread.test.ts (new)` | "off the main thread" (AC9.7). "limits" (AC9.8) with a worker stub that sleeps or throws. "runs today's simulation" (AC9.9). "snapshot minutes": `durationMin` 60 gives 0, 1, 3, 5, 10, 15, 20, 30, 45 and 60; 120 adds 75, 90, 105 and 120. "input invalid": `durationMin` 0 or 300, a stud with a non-finite position, or no hazards reject with `input_invalid` before a worker starts | AC9.7, AC9.8, AC9.9 |
| `server/services/environmentalSimService.test.ts (new)` | "unchanged without parameters": the golden fixture (section 11.2) deep-equals and stringifies byte-identically. "parameters": with `EnvSimParams` whose `fallbackWallKey` is `unknown_wall`, a wall of material `''` passes fire after that row's burn-through, where the call without parameters never passes it | AC9.10 |
| `server/routes/fieldOpsSpreadLibrary.test.ts (new)` | An Express app with `createSpreadLibraryRouter(fakes)` on an ephemeral port, called with `fetch`, as WS0 tests its job router (`01-prerequisites.md` section 11.1). The refusals of AC9.13; an admin `PATCH` answers 200 with a new `dataset_version` and writes one change row; `retire` makes the row inactive; a review with a stale `expected_dataset_version` answers 409 `VERSION_MISMATCH`, an incomplete checklist 409 `REVIEW_INCOMPLETE` | AC9.13 |
| `server/services/fieldOps/world/model/buildWorldModel.test.ts (new)` | "every detail" (AC9.14). "grid size" (AC9.15). "crowd": a zone of 300 people with 40 placed by the casualty plan gives 260 people in six groups of at most 50. "floors": a building of five floors models four, from −1 to 2. "no scene": a fake `loadSceneByScenario(ctx, scenarioId)` that throws `SCENARIO_SCENE_NOT_FOUND` makes the session not eligible, and one that throws `LAYOUT_STORE_UNAVAILABLE` fails the inputs stage; the ctx's user is the scenario's creator. "hazard material": a hazard with `material` `fuel_flammable_liquid` gives the floor-0 cells within its radius that contents, and one without a material its type's `contents_key` (AC9.57) | AC9.14, AC9.15, AC9.57 |
| `server/services/fieldOps/world/engine/fire.test.ts (new)` | AC9.16, plus a burnt-out cell never re-ignites and fire never enters a collapsed cell | AC9.16 |
| `server/services/fieldOps/world/engine/smoke.test.ts (new)` | AC9.17, plus smoke rising through a stairwell to the floor above within 60 ticks | AC9.17 |
| `server/services/fieldOps/world/engine/structure.test.ts (new)` | AC9.18, plus no device radius gives no damage, and fire exposure raises damage at the frame's rate | AC9.18 |
| `server/services/fieldOps/world/engine/plumes.test.ts (new)` | AC9.19, plus `maxPlumes` merging the weakest sources | AC9.19 |
| `server/services/fieldOps/world/engine/crowd.test.ts (new)` | AC9.20, plus groups on an upper floor reach the ground floor by a stairwell, and a group reaching its muster point leaves the world | AC9.20 |
| `server/services/fieldOps/world/engine/exposure.test.ts (new)` | AC9.21, plus the `heat_stress` agent at 38 °C in direct sun for walking groups, and a dose that never passes a band giving no casualty | AC9.21 |
| `server/services/fieldOps/world/engine/actions.test.ts (new)` | AC9.22, plus `shore_up` stopping damage and `ventilate` speeding clearance | AC9.22 |
| `server/services/fieldOps/world/engine/determinism.test.ts (new)` | AC9.23, plus a different seed giving a different crowd split, and command order within a tick fixed by command id | AC9.23 |
| `server/services/fieldOps/world/engine/units.test.ts (new)` | "lifecycle" (AC9.37); "access" (AC9.39); "sweep": a bomb-squad crew sweeping the inspection point that anchors a pool entry reveals that device through `performSweep`'s rule and nothing else; "transport": an ambulance takes a red patient to the nearest suitable hospital and back | AC9.37, AC9.39 |
| `server/services/fieldOps/world/engine/weather.test.ts (new)` | AC9.49 for each condition; "transition" (AC9.51) | AC9.49, AC9.51 |
| `server/services/fieldOps/world/roads/roadGraph.test.ts (new)` | AC9.35, plus the largest component kept and a disconnected island dropped | AC9.35 |
| `server/services/fieldOps/world/roads/routing.test.ts (new)` | AC9.36, plus an unreachable target giving null | AC9.36 |
| `server/services/fieldOps/world/roads/traffic.test.ts (new)` | AC9.50 | AC9.50 |
| `server/services/fieldOps/world/fog/visibility.test.ts (new)` | AC9.42 | AC9.42 |
| `server/services/fieldOps/world/fog/views.test.ts (new)` | AC9.43; "no hidden fact" (AC9.46) over 1,000 states from seeds 1 to 1,000 | AC9.43, AC9.46 |
| `server/services/fieldOps/world/bridge/fogFilter.test.ts (new)` | AC9.44; "broadcast redaction" (AC9.45); "same fog for AI" (AC9.47); "placements": with sharing off another team's unit asset is absent | AC9.44, AC9.45, AC9.47 |
| `server/services/fieldOps/world/bridge/worldGates.test.ts (new)` | AC9.28 for each gate, with the world on, off, absent and in fallback. "no reveal while the world runs": with the world active, a hidden `environmental_timeline` child of a hazard that is not world-owned is not revealed when its parent passes its minute, and the generic spawn adds nothing in its place, while a delayed child of any other origin is revealed as today; with no world, both are revealed as today (AC9.56) | AC9.28, AC9.56 |
| `server/services/fieldOps/world/bridge/pinBridge.test.ts (new)` | AC9.29; "units as placed assets" (AC9.38); a write failure retried once and logged `fieldops_world_bridge_failed`. "hand-back retires the timeline's children": against the fake store's `fieldops_world_hand_back`, a fallback, a trainer stop and `NO_CAPACITY` each retire the still-delayed child as AC9.56 says and leave the revealed child and a delayed deterioration child unchanged; a second hand-back changes nothing; a fake deterioration pass afterwards reveals no child of the hazard (AC9.56) | AC9.29, AC9.38, AC9.56 |
| `server/services/fieldOps/world/runtime/worldRuntime.test.ts (new)` | "lease and recovery" (AC9.25); "write budget" (AC9.26); "back-pressure" (AC9.27); "pause" (AC9.32); "eligibility and late start" (AC9.33); "log hygiene" (AC9.53); "capacity": with a cap of 0 a running row whose lease expires falls back with `NO_CAPACITY` after 120 seconds and is handed back | AC9.25 to AC9.27, AC9.32, AC9.33, AC9.53 |
| `server/services/fieldOps/world/perf/worldBudget.test.ts (new)` | AC9.24. The 300 ticks run back to back in a worker, not once a second, so the file takes about 15 seconds | AC9.24 |
| `server/routes/fieldOpsWorld.test.ts (new)` | An Express app with `createFieldOpsWorldRouter(fakes)` on an ephemeral port, called with `fetch`. "flag off" (AC9.30); "trainer console" (AC9.31); "dispatch" (AC9.40); "AI actor" (AC9.41); "replay" (AC9.52); a session the caller does not belong to answers as `assertSessionAccess` does | AC9.30, AC9.31, AC9.40, AC9.41, AC9.52 |
| `server/services/fieldOps/world/staticChecks.test.ts (new)` | AC9.54 by reading every `.ts` file under the folder and the two routers and matching their import specifiers; "no clock or randomness": no file of the engine folder contains `Math.random`, `Date.now` or `performance.now` (R9.5) | AC9.54 |
| `frontend/tests/worldLayerModel.test.ts (new)` | "refetch signal": `refetchTargetOf` gives `'casualties'` for `{ refetch: 'casualties' }`, `'placements'` for `{ refetch: 'placements' }`, and null for a normal casualty or placement payload and for an unknown `refetch` value. "shapes": a view with three burning cells, one plume, two groups and two units (one last-known) gives three cell squares in the burning colour, one polygon, two circles and two markers, the last-known at half opacity; a trainer view has device markers and a team view none; only the active floor's cells are drawn | AC9.45 |

### 11.2 Fixtures

- `server/services/fieldOps/world/__fixtures__/marinaCourtWorld.ts (new)`: the mockup scenario as the model builder's loaders return it, matched to WS5's compile fixture of the same building (`06-compile-and-review.md` section 11): WS4's scene with walls of materials `''`, `Plasterboard`, `concrete` and `glass window`, two stairwells, four exits, six wall points, three hazards and two crowd zones; WS5's physics snapshot with the main device's radii and a pool entry anchored at a wall point; the setup with the label "afternoon thunderstorm" at 15:30 on a weekday; the site area with the primary and two involved buildings; four facilities (two fire stations, a police post and a hospital).
- `server/services/fieldOps/world/__fixtures__/roads.ts (new)`: hand-made road rows (the crossing, the one-way street and the service road of AC9.35) and `gridRoads(n, spacingM)`, a generated street grid of mixed road types for routing and the soak; no row comes from the network.
- `server/services/fieldOps/world/__fixtures__/fakeWorldStore.ts (new)`: an in-memory store with the semantics of 251 and 252: the claim, heartbeat, finish, release and hand-back functions with their lease rules and scopes, a small `scenario_hazards` table for the hand-back, append-only events, snapshots and commands, and a switch to fail the next write.
- `server/services/fieldOps/world/__fixtures__/library.ts (new)`: the seed library built with `buildSpreadLibrary` from the seed files, and helpers that remove a key or change one number.
- `server/services/__fixtures__/envSimGolden.json (new)`: the output of `runEnvironmentalSimulation` for the fixture building with today's analyses, recorded on the baseline before `environmentalSimService.ts` is touched, by running its test with `RECORD_GOLDEN=1` (T9.3).
- `server/services/fieldOps/world/__fixtures__/worldStates.ts (new)`: the seeded generator of random world states and audiences for AC9.46.

### 11.3 Performance and soak

`worldBudget.test.ts` is the per-world budget in `npm test`. The soak is run by hand on staging before rollout step 3 and step 8 (section 10.2), with `scripts/fieldops-world-soak.ts (new)`, which is not in `npm test`: four sessions of the fixture world at the largest size (20,000 cells, 400 groups, 40 units, 24 plumes), each with a scripted dispatch every 10 seconds and a weather change every 5 minutes, for 60 minutes of world time at 1 Hz. It passes when `fieldops_world_main_lag` stays under 50 ms at the 95th percentile, no world falls back, the database receives at most 150 writes a minute a world, the process stays under 1.5 GB resident, and a forced restart at minute 30 recovers every world to the hash it had. The script creates its sessions with a test trainer and removes every row it wrote at the end.

### 11.4 Manual acceptance

1. **M1** With `ENABLE_FIELDOPS_WORLD_SIM` off, start a v2 session: no world layer, console or lobby card; the world routes answer 404; hazards deteriorate as today.
2. **M2** With it on, prepare the world from the lobby: "World ready" appears; start the session: the world clock runs, the blast damages the primary building, fire spreads from the combustible hazard, smoke fills its room and leaks through the door.
3. **M3** Crowd groups leave by the nearest clear exit, avoid a smoke-logged one, queue at a narrow one; exposure casualties appear as pins and in the casualty panel.
4. **M4** As the trainer: change the weather (the plume turns), close a road, start a fire in a building, pause for two minutes (both clocks shown, the world clock still) and resume.
5. **M5** Stop the live world: the message "Live world stopped. The exercise continues with scripted escalation." appears for everyone, and the world's fire pins escalate as today afterwards.
6. **M6** Restart the server during a session: within about 35 seconds the world resumes where its last snapshot was, and "Live world resumed after {n} seconds." appears.
7. **M7** As a fire agency member, dispatch a fire engine from the nearest station to suppress a fire: it drives over the roads with its arrival time, arrives as a placed asset, deploys and puts the fire out; recall it and watch it return.
8. **M8** As a bomb squad member, sweep the inspection point where the hidden device is anchored: the device is found as today's sweep finds it. As medical, send an ambulance to a red patient: it is taken to the hospital.
9. **M9** In the After-Action Review, as the trainer: the world's timeline and the minute slider; as a participant: only the events their team could see.
10. **M10** With two browsers as two teams in a fog session: team A sees a fire its unit observes, team B does not until A shares a report; a last-known marker ages; a spectator sees the union; the trainer sees everything and the hidden device's marker.
11. **M11** Set a thunderstorm: outdoor spread and road speeds drop, plumes shorten, observation ranges shrink; set haze PSI 180: visibility falls and the heat-stress casualties rise on a 34 °C afternoon.
12. **M12** Run the same dispatch with the incident at 08:00 on a weekday and at 02:00: the arrival times differ; close the road on the route: the unit re-routes within 15 seconds.
13. **M13** Let an AI agency (WS7) play a fog session: it dispatches its units through the same routes and perceives only its fogged view.

### 11.5 Additions to the `test` script

Append these files, in this order, to the file list of the `test` script in `package.json` (`package.json:25`). Each task adds its own files as it creates them (section 12).

```text
server/lib/fieldOps/worldRules.test.ts
server/services/fieldOps/world/spreadLibrary.test.ts
server/services/fieldOps/world/hazardEvents.test.ts
server/services/fieldOps/world/compileSpread.test.ts
server/services/environmentalSimService.test.ts
server/routes/fieldOpsSpreadLibrary.test.ts
server/services/fieldOps/world/model/buildWorldModel.test.ts
server/services/fieldOps/world/engine/fire.test.ts
server/services/fieldOps/world/engine/smoke.test.ts
server/services/fieldOps/world/engine/structure.test.ts
server/services/fieldOps/world/engine/plumes.test.ts
server/services/fieldOps/world/engine/crowd.test.ts
server/services/fieldOps/world/engine/exposure.test.ts
server/services/fieldOps/world/engine/actions.test.ts
server/services/fieldOps/world/engine/determinism.test.ts
server/services/fieldOps/world/runtime/worldRuntime.test.ts
server/services/fieldOps/world/bridge/worldGates.test.ts
server/services/fieldOps/world/bridge/pinBridge.test.ts
server/services/fieldOps/world/perf/worldBudget.test.ts
server/routes/fieldOpsWorld.test.ts
server/services/fieldOps/world/staticChecks.test.ts
server/services/fieldOps/world/roads/roadGraph.test.ts
server/services/fieldOps/world/roads/routing.test.ts
server/services/fieldOps/world/engine/units.test.ts
server/services/fieldOps/world/fog/visibility.test.ts
server/services/fieldOps/world/fog/views.test.ts
server/services/fieldOps/world/bridge/fogFilter.test.ts
server/services/fieldOps/world/engine/weather.test.ts
server/services/fieldOps/world/roads/traffic.test.ts
frontend/tests/worldLayerModel.test.ts
```

## 12. Tasks

The tasks follow the slices of section 4.2 (master section 6, build-order item 7). Each slice ends with the flag still able to fall back to today's behaviour, and each task adds its test files to the `test` script of `package.json` as it creates them (section 11.5). A file is marked new where it is first created; later tasks extend it.

**Slice 1: the spread library and the compile-time timeline (WS5 depends on it)**

1. **T9.1 Shared world types and pure rules.**
   - Goal: the vocabulary every other task uses, type-checked by the server and the browser builds.
   - Files: `shared/fieldOps/world.ts (new)`, `shared/fieldOps/worldRules.ts (new)`, `server/lib/fieldOps/worldSchemas.ts (new)`, `server/lib/fieldOps/worldRules.test.ts (new)`, `package.json` (touched).
   - Steps: write the types and constants of section 5.10, including `CONTENTS_MATERIAL_OPTIONS`, which WS4's hazard panel and save check import, and the catalogue of section 5.10.1, with `as const` arrays and no enums (master 10.7 rule 4); write the pure rules of section 5.10.2, `weatherFromLabel` with `BUILTIN_WEATHER_PRESETS`; write the zod schemas of section 5.14; register the test file.
   - Done when: `npm run typecheck` and `npm --prefix frontend run build` pass with the new shared files, and `npm test` runs the new file green.
   - Tests: `worldRules.test.ts`, every case of section 11.1. Commit: 1.
2. **T9.2 Migration 249 and the library's seed files.**
   - Goal: the stored library exists and can be filled from files whose every row names its source (D31).
   - Files: `migrations/249_fieldops_spread_library.sql (new)`; in `server/services/fieldOps/world/data/seed/ (new)`: `spread-materials.json`, `spread-hazards.json`, `spread-exposure.json` and `spread-weather-effects.json`.
   - Steps: write the SQL of section 5.2; write the rows of sections 5.12.1 to 5.12.4 and the weather effects of section 5.12.5, each with `source_ref` and `source_note`, under the file header of section 5.12.
   - Done when: the migration applies twice without error on a scratch database (a Supabase branch or a local Postgres, never the shared project), and its rollback comments run cleanly on a branch database; there, a query as `anon` or `authenticated` on any of the six tables is refused; every seed file passes `seedFileSchema`.
   - Tests: the "seed hygiene" case lands with T9.3. Commit: 1.
3. **T9.3 The loader, `hazardEventsFor` and `deteriorationFactsFor`.**
   - Goal: WS5's two adapters have the functions of master 10.8 item 38, with the signatures its section 15.4 asked for.
   - Files: `server/services/fieldOps/world/spreadLibrary.ts (new)`, `server/services/fieldOps/world/__fixtures__/library.ts (new)`, `server/services/fieldOps/world/spreadLibrary.test.ts (new)`, `server/services/fieldOps/world/hazardEvents.test.ts (new)`, `package.json` (touched).
   - Steps: register the `spreadTablesDetector` with WS0's detectors; write `loadSpreadLibrary` by the seven steps of section 6.2 around the pure `buildSpreadLibrary`; write sections 6.3 and 6.4.
   - Done when: with 249 applied and seeded, `loadSpreadLibrary()` answers a library whose `version` is `fo-spread-1.0.0:` and 16 hex characters; with 249 missing it answers null and logs one `fieldops_spread_library_missing` line a minute.
   - Tests: `spreadLibrary.test.ts`, `hazardEvents.test.ts`. Commit: 1.
4. **T9.4 The flag, the settings and the library's admin routes.**
   - Goal: the owner can seed, correct, retire and review the library; the flag and settings are read once at start.
   - Files: `server/lib/fieldOps/worldSettings.ts (new)`, `server/env.ts` (touched), `server/services/fieldOps/world/spreadLibraryAdmin.ts (new)`, `server/routes/fieldOpsSpreadLibrary.ts (new)`, `server/routes/fieldOpsSpreadLibrary.test.ts (new)`, `server/index.ts` (touched), `package.json` (touched).
   - Steps: section 6.13; the admin writes of section 6.2; the library router of section 6.14 with its factory; mount it in `server/index.ts`.
   - Done when: as an admin, `POST /api/field-ops/spread-library/seed` fills the tables and `GET /api/field-ops/spread-library` shows `review.state` `unreviewed`; as a trainer, both answer 403.
   - Tests: `fieldOpsSpreadLibrary.test.ts`. Commit: 1.
5. **T9.5 The compile-time spread timeline.**
   - Goal: `buildSpreadTimeline` runs today's simulation with stored parameters in a worker thread, inside WS5's budget.
   - Files: `server/services/__fixtures__/envSimGolden.json (new)`, `server/services/environmentalSimService.test.ts (new)`, `server/services/environmentalSimService.ts` (touched), `server/services/fieldOps/world/compileSpread.ts (new)`, `server/services/fieldOps/world/worker/workerPool.ts (new)`, `server/services/fieldOps/world/worker/worldWorker.ts (new)`, `server/services/fieldOps/world/worker/protocol.ts (new)`, `server/services/fieldOps/world/compileSpread.test.ts (new)`, `server/services/fieldOps/world/index.ts (new)`, `package.json` (touched).
   - Steps: first, before `environmentalSimService.ts` changes, write its test and record the golden file with `RECORD_GOLDEN=1` on the baseline; then add `EnvSimParams` as section 6.5 says; then write `compileSpread.ts`, the pool and the worker's spread message (section 6.11.2), with the abort and timeout rules; export from the index (section 6.18).
   - Done when: the golden test passes after the change; the mockup's timeline resolves in under 60 seconds on a development machine while a 10 ms timer on the main thread stays within 50 ms.
   - Tests: `environmentalSimService.test.ts`, `compileSpread.test.ts`. Commit: 2.

**Slice 2: the world and its runtime (falls back to today's escalation)**

6. **T9.6 Migrations 250 to 252.**
   - Goal: the world's model, session rows, lease functions and log exist, readable by the service role only.
   - Files: `migrations/250_fieldops_world_models.sql (new)`, `migrations/251_fieldops_world_sessions.sql (new)`, `migrations/252_fieldops_world_log.sql (new)`.
   - Steps: the SQL of sections 5.3 to 5.5.
   - Done when: the three apply twice in order without error on a scratch database (a Supabase branch or a local Postgres, never the shared project), and their rollback comments run cleanly on a branch database; there, 251 applied without 250 raises its check, an `UPDATE` or `DELETE` on `fieldops_world_events` raises, `fieldops_world_claim` and `fieldops_world_hand_back` called as `authenticated` are refused, and `fieldops_world_hand_back` on a fixture session changes exactly the rows AC9.56 names.
   - Tests: covered through the fake store's rules in T9.10. Commit: 3.
7. **T9.7 The world model and the prepare job.**
   - Goal: every detail of the compiled scenario becomes one stored, hashed `WorldModel` (D36).
   - Files: in `server/services/fieldOps/world/model/ (new)`: `worldModel.ts`, `buildWorldModel.ts`, `worldInputs.ts`, `worldModelStore.ts`, `prepareJob.ts` and `buildWorldModel.test.ts`; `server/services/fieldOps/world/__fixtures__/marinaCourtWorld.ts (new)`; `package.json` (touched).
   - Steps: section 6.6, reading the scene through WS4's `loadSceneByScenario(ctx, scenarioId)` with the job's `SceneCtx` (section 6.6.2) and each hazard's `material`; the job kind with its four stages, the roads stage skipped while 253 is missing.
   - Done when: for a v2 scenario on a development server, "Prepare the world" ends with `fieldops_world_prepare_done` and a model row within the limits of `WORLD_LIMITS`, also when the session's trainer did not create the scenario.
   - Tests: `buildWorldModel.test.ts`, including "hazard material" (AC9.57). Commit: 3.
8. **T9.8 The engine: state, randomness, grid, fire, smoke and gas.**
   - Goal: fire and smoke move through the building by material and wall, deterministically.
   - Files: in `server/services/fieldOps/world/engine/ (new)`: `state.ts`, `rng.ts`, `grid.ts`, `fire.ts`, `smoke.ts`, `fire.test.ts` and `smoke.test.ts`; `package.json` (touched).
   - Steps: sections 6.7.1 to 6.7.3 and the determinism rules of section 6.7.10.
   - Done when: the fire and smoke tests pass, and the same seed gives the same state hash twice.
   - Tests: `fire.test.ts`, `smoke.test.ts`. Commit: 3.
9. **T9.9 The engine: structure, plumes, crowds, exposure, tasks and `stepWorld`.**
   - Goal: the whole world steps within its budget.
   - Files: in `server/services/fieldOps/world/engine/`: `structure.ts`, `plumes.ts`, `crowd.ts`, `exposure.ts`, `actions.ts`, `weather.ts` and `step.ts`, and the tests `structure.test.ts`, `plumes.test.ts`, `crowd.test.ts`, `exposure.test.ts`, `actions.test.ts` and `determinism.test.ts`; `server/services/fieldOps/world/perf/worldBudget.test.ts (new)`; `package.json` (touched).
   - Steps: sections 6.7.4 to 6.7.10; `weather.ts` gives the factors on spread, plumes and exposure and the transitions here, and its road and walking factors in T9.21.
   - Done when: AC9.16 to AC9.24 pass.
   - Tests: the six engine tests and `worldBudget.test.ts`. Commit: 3.
10. **T9.10 Hosting: workers, leases, the tick loop, writes and recovery.**
    - Goal: worlds run off the main thread, survive a restart and fall back cleanly.
    - Files: `server/services/fieldOps/world/worker/worldWorker.ts (new)`, extended with the world messages; in `server/services/fieldOps/world/runtime/ (new)`: `worldRuntime.ts`, `worldStore.ts`, `backPressure.ts` and `worldRuntime.test.ts`; `server/services/fieldOps/world/__fixtures__/fakeWorldStore.ts (new)`; `server/index.ts` (touched); `package.json` (touched).
    - Steps: section 6.11; wire `startWorldRuntime`, `stopWorldRuntime` and the prepare job's import as section 6.18 says.
    - Done when: on a development server a session's world runs at 1 Hz, writes within the budget of section 6.11.6, and after a hard restart resumes from its snapshot within 35 seconds.
    - Tests: `worldRuntime.test.ts`. Commit: 4.
11. **T9.11 The bridge and the four gates.**
    - Goal: today's response layer sees the world as pins, and today's engines step aside only for what the world owns.
    - Files: `server/services/fieldOps/world/bridge/pinBridge.ts (new)`, `server/services/fieldOps/world/bridge/worldGates.ts (new)`, `server/services/hazardDeteriorationService.ts` (touched), `server/services/pinResolutionService.ts` (touched), `server/services/exitFlowService.ts` (touched), `server/services/injectSchedulerService.ts` (touched), `server/services/fieldOps/world/bridge/worldGates.test.ts (new)`, `server/services/fieldOps/world/bridge/pinBridge.test.ts (new)`, `package.json` (touched).
    - Steps: section 6.12, each touched service gaining one guarded line; `handBackWorldPins` calling `fieldops_world_hand_back`.
    - Done when: with the flag off every touched service behaves as today (AC9.28); with a world a fire region appears as one hazard pin and resolves when it is out; and after stopping a world from its console no compiled fire-spread child of the session is revealed or listed (AC9.56).
    - Tests: `worldGates.test.ts`, `pinBridge.test.ts` (AC9.29, AC9.56). Commit: 4.
12. **T9.12 The world routes, the views and the socket events.**
    - Goal: browsers and the trainer receive the world; the trainer controls it.
    - Files: `server/routes/fieldOpsWorld.ts (new)`, `server/services/fieldOps/world/fog/views.ts (new)`, `server/routes/fieldOpsWorld.test.ts (new)`, `server/index.ts` (touched), `package.json` (touched).
    - Steps: the routes of section 6.14 except the unit and report routes; the views with two audiences (the trainer, and everyone else seeing all but devices) until T9.19; the events of section 6.15.
    - Done when: the view route answers for a trainer and a participant, deltas arrive once a second, and weather, fire, pause, resume and stop commands apply at the next tick.
    - Tests: `fieldOpsWorld.test.ts` ("flag off", "trainer console" without roads, "replay"). Commit: 4.
13. **T9.13 The client: layers, status chip, console, lobby card and replay panel.**
    - Goal: the world is visible and controllable in the existing session screens.
    - Files: in `frontend/src/components/FieldOps/World/ (new)`: `FieldOpsWorldLayer.tsx`, `WorldCellsLayer.tsx`, `WorldPlumesLayer.tsx`, `WorldCrowdLayer.tsx`, `WorldStatusChip.tsx`, `WorldConsole.tsx`, `WorldLobbyCard.tsx`, `WorldReplayPanel.tsx`, `worldLayerModel.ts`, `worldPalette.ts`, `useWorldView.ts` and `worldPick.ts`; `frontend/src/lib/fieldOps/worldApi.ts (new)`; `frontend/src/design/fieldops-world.css (new)`; `frontend/src/components/UI/WarRoomIcon.tsx` (touched); `frontend/src/components/COP/MapView.tsx` (touched, the mount only); `frontend/src/pages/SessionView.tsx` (touched); `frontend/src/components/Session/SessionLobby.tsx` (touched); `frontend/src/components/AAR/AARDashboard.tsx` (touched); `frontend/tests/worldLayerModel.test.ts (new)`; `package.json` (touched).
    - Steps: sections 7.1 to 7.11, without the unit, road and fog layers.
    - Done when: M2 to M6 and M9 pass on a development server.
    - Tests: `worldLayerModel.test.ts` ("shapes"). Commit: 4.
14. **T9.14 Static checks.**
    - Goal: no model, network or map service can creep into the world.
    - Files: `server/services/fieldOps/world/staticChecks.test.ts (new)`, `package.json` (touched).
    - Steps: AC9.54's scan; AC9.53's case in `worldRuntime.test.ts`.
    - Done when: both pass; adding an import of the chat client to any world file makes the test fail.
    - Tests: `staticChecks.test.ts`. Commit: 4.

**Slice 3: units (falls back to placing assets by hand)**

15. **T9.15 Migration 253 and the road graph.**
    - Goal: one cached, routable graph per site box, built from the saved roads.
    - Files: `migrations/253_fieldops_world_units.sql (new)`; `road-speed-classes.json` in the seed folder; in `server/services/fieldOps/world/roads/ (new)`: `roadGraph.ts`, `roadGraphStore.ts` and `roadGraph.test.ts`; `server/services/fieldOps/world/__fixtures__/roads.ts (new)`; the prepare job's roads stage; `package.json` (touched).
    - Steps: sections 5.6 and 6.8.3.
    - Done when: preparing a world for a seeded site builds the graph once and reads it from `fieldops_road_graphs` the second time.
    - Tests: `roadGraph.test.ts`. Commit: 5.
16. **T9.16 Routing and units in the engine.**
    - Goal: units travel the roads at the speeds of their road types and do their tasks on arrival.
    - Files: `routing.ts` and `routing.test.ts` in the roads folder; `units.ts` and `units.test.ts` in the engine folder; `package.json` (touched).
    - Steps: sections 6.8.1, 6.8.2 and 6.8.4 to 6.8.6; the unit side of section 6.7.8.
    - Done when: AC9.36, AC9.37 and AC9.39 pass.
    - Tests: `routing.test.ts`, `units.test.ts`. Commit: 5.
17. **T9.17 Dispatch, arrival as placed assets, sweeps and transport.**
    - Goal: teams and AI agencies command units through routes; arrived units count for today's checks.
    - Files: `server/routes/fieldOpsWorld.ts (new)`, extended with the unit and road routes; `server/services/fieldOps/world/bridge/pinBridge.ts (new)`, extended with unit assets and `sweepInspectionPoint`; `server/routes/placements.ts` (touched); `package.json` (touched).
    - Steps: sections 6.8.7 to 6.8.10, and the unit routes and road routes of section 6.14; the 409 `WORLD_UNIT_ASSET` in the placements route's `PATCH` and `DELETE`.
    - Done when: M7 and M8 pass on a development server.
    - Tests: `pinBridge.test.ts` ("units as placed assets"), `fieldOpsWorld.test.ts` ("dispatch", "AI actor", and the road part of "trainer console"). Commit: 5.
18. **T9.18 The units panel, the unit and road layers, and the lobby's unit rows.**
    - Goal: players dispatch from the map; the trainer sets units and starts in the lobby.
    - Files: `WorldUnitPanel.tsx`, `WorldUnitsLayer.tsx` and `WorldRoadsLayer.tsx` in `frontend/src/components/FieldOps/World/`, and the unit rows of `WorldLobbyCard.tsx`.
    - Steps: sections 7.2, 7.3 and 7.5.
    - Done when: M7 passes from the panel alone, and from the lists without a pointer.
    - Tests: `worldLayerModel.test.ts` gains the unit and road shapes. Commit: 5.

**Slice 4: fog of war (falls back to every team seeing the world but the devices)**

19. **T9.19 Migration 254, observation, knowledge and reports.**
    - Goal: each team sees what its units and posts can see, plus what others report.
    - Files: `migrations/254_fieldops_world_visibility.sql (new)`, `server/services/fieldOps/world/engine/visibility.ts (new)`, `server/services/fieldOps/world/fog/views.ts (new)`, extended with the team audiences, `server/services/fieldOps/world/__fixtures__/worldStates.ts (new)`, in `server/services/fieldOps/world/fog/`: `visibility.test.ts` and `views.test.ts`; the report route; `package.json` (touched).
    - Steps: sections 5.7 and 6.10.1 to 6.10.4.
    - Done when: AC9.42, AC9.43 and AC9.46 pass.
    - Tests: `visibility.test.ts`, `views.test.ts`. Commit: 6.
20. **T9.20 Fog on today's routes, broadcasts and map.**
    - Goal: no hidden fact reaches a browser or an AI agency through any channel.
    - Files: `server/services/fieldOps/world/fog/fogFilter.ts (new)`, `server/routes/hazards.ts` (touched), `server/routes/casualties.ts` (touched), `server/routes/placements.ts` (touched), `server/services/websocketService.ts` (touched), `frontend/src/components/COP/MapView.tsx` (touched, the refetch signal), `WorldFogLayer.tsx` in the client folder, `server/services/fieldOps/world/bridge/fogFilter.test.ts (new)`, `package.json` (touched).
    - Steps: sections 6.10.5, 6.10.6 and 7.7.
    - Done when: M10 and M13 pass on a development server.
    - Tests: `fogFilter.test.ts`, `worldLayerModel.test.ts` ("refetch signal"). Commit: 6.

**Slice 5: weather and traffic (falls back to the default weather and free-flow roads)**

21. **T9.21 Migration 255, weather presets and the weather's full effects.**
    - Goal: weather changes spread, plumes, visibility, travel and casualties from stored rows (D35).
    - Files: `migrations/255_fieldops_weather_traffic.sql (new)`; `weather-presets-sg.json` and `traffic-profiles-sg.json` in the seed folder; `server/services/fieldOps/world/weather/weatherData.ts (new)`; `server/services/fieldOps/world/engine/weather.ts (new)`, extended with the road and walking factors; `server/services/fieldOps/world/engine/weather.test.ts (new)`; `package.json` (touched).
    - Steps: sections 5.8, 6.9.1 and 6.9.3.
    - Done when: AC9.49 and AC9.51 pass, and M11 passes.
    - Tests: `weather.test.ts`. Commit: 7.
22. **T9.22 Traffic profiles, closures, cordons and jams.**
    - Goal: travel times follow the hour, the day and the incident.
    - Files: `traffic.ts` and `traffic.test.ts` in the roads folder; `routing.ts` (the traffic factor); `package.json` (touched).
    - Steps: section 6.9.4.
    - Done when: AC9.50 passes, and M12 passes.
    - Tests: `traffic.test.ts`. Commit: 7.
23. **T9.23 Setup's weather and the console's weather form.**
    - Goal: the trainer's words and WS2's stored setting become the world's weather; the trainer can change it live.
    - Files: `server/services/fieldOps/world/model/worldInputs.ts (new)`, extended to read WS2's `weather_setting` when present and `weatherFromLabel` otherwise; `WorldConsole.tsx` and `WorldStatusChip.tsx` in the client folder.
    - Steps: section 6.9.2 and the weather block of section 7.4.
    - Done when: a scenario with WS2's structured weather starts with it; one with only a label starts with the label's preset; the console's presets come from the table.
    - Tests: `buildWorldModel.test.ts` gains "weather source". Commit: 7.

## 13. Commit plan and backtracking

Seven commits, one or two a slice. Before each is pushed, `npm test`, `npm run typecheck`, `npm run lint` and `npm --prefix frontend run build` pass, and its migrations apply twice without error on a scratch database (a Supabase branch or a local Postgres, never the shared project), with their rollback comments tried on a branch database. Only then is each migration applied once, in order, on the shared project, which serves development, preview and production alike (section 10.2). A commit that fails any of them is fixed or reverted before the next one starts. Backing a commit out never runs a rollback on the shared project: its tables are additive, and nothing reads them once the code is reverted or the flag is off (D23).

| Commit | Tasks | Leaves working | Check | Backtracking |
| --- | --- | --- | --- | --- |
| 1. "WS9: the spread library, its seeds and admin routes" | T9.1 to T9.4 | WS5 can call `loadSpreadLibrary`, `hazardEventsFor` and `deteriorationFactsFor`; admins seed and review the library | `GET /api/field-ops/spread-library` as an admin; AC9.1 to AC9.6, AC9.11 to AC9.13, AC9.34, AC9.48, AC9.55 | Revert the commit; 249's tables stay on the shared project, unread. If WS5's code already imports the loader, keep `spreadLibrary.ts` and make `loadSpreadLibrary` answer null at once instead, which WS5 treats as a missing library: no fire-spread pins and an empty facts block (master 10.8 item 38) |
| 2. "WS9: the compile-time spread timeline in a worker" | T9.5 | `buildSpreadTimeline` for WS5; today's simulation unchanged without parameters | The golden test; AC9.7 to AC9.10 | Revert. If WS5 already imports `buildSpreadTimeline`, keep the module and make it reject with `worker_failed` at once instead, which WS5 treats as no fire-spread pins; the golden test proves `environmentalSimService.ts` is back to today's behaviour either way |
| 3. "WS9: the world model and the engine" | T9.6 to T9.9 | A world can be prepared and stepped in tests; nothing runs in a session yet | AC9.14 to AC9.24, AC9.57 | Revert; the tables and functions of 250 to 252 stay on the shared project, unused. If AC9.24 fails, backtrack to section 6.6.3 and lower `WORLD_LIMITS.maxCells` (and AC9.15 with it) before commit 4, rather than loosening the budget |
| 4. "WS9: the runtime, the bridge, the routes and the client" | T9.10 to T9.14 | Live worlds in development sessions, with fallback; the console, lobby card and replay | M1 to M6, M9; AC9.25 to AC9.33 (AC9.31 without its road closure, which passes with commit 5), AC9.52 to AC9.54, AC9.56 | First stop the running worlds from their consoles, so each hands back and retires its fire-spread children; then set `ENABLE_FIELDOPS_WORLD_SIM=false` and revert. World-owned hazards left on session rows carry a property nothing reads any more and escalate as today. If the gates misbehave, backtrack to section 6.12 and narrow them before re-applying |
| 5. "WS9: units over the saved roads" | T9.15 to T9.18 | Dispatch, travel, arrival as placed assets, sweeps, transport | M7, M8; AC9.34 to AC9.41 | Revert; 253's tables stay on the shared project, unused. Unit assets already placed stay as ordinary placements; the placements route's 409 goes with the revert |
| 6. "WS9: fog of war" | T9.19, T9.20 | Team views, last-known markers, reports, the filters on today's routes and broadcasts | M10, M13; AC9.42 to AC9.47 | Turn fog off in the lobby for affected sessions, then revert; 254's tables stay on the shared project, unused. The touched routes and broadcasts return to today's; `MapView`'s refetch check is harmless without the signal. If AC9.46 ever fails on real data, backtrack to section 6.10.4 before re-enabling fog |
| 7. "WS9: weather and traffic" | T9.21 to T9.23 | Stored presets and effects, traffic profiles, closures and jams, Setup's weather | M11, M12; AC9.48 to AC9.51 | Revert; 255's tables stay on the shared project, unused. The world falls back to `BUILTIN_WEATHER_PRESETS` and free-flow speeds (section 5.13) |

Backtracking within a commit: when a task shows that an earlier decision of this spec is wrong (a budget missed, a gate too wide, a seed value implausible in play), the builder stops, changes the decision in this document first (section 2.2 and the section that applies it), adjusts the criteria, and only then the code. The D31 review can change any seed value without a code change, through the admin routes.

## 14. File map

### 14.1 New files (WS9 creates them)

| Path | Purpose | Task |
| --- | --- | --- |
| `shared/fieldOps/world.ts (new)` | Types, constants and limits shared by the server and the browser (section 5.10) | T9.1 |
| `shared/fieldOps/worldRules.ts (new)` | Pure rules: materials, weather from the label, the unit catalogue, deltas, geometry (section 5.10.2) | T9.1 |
| `server/lib/fieldOps/worldSchemas.ts (new)` | The zod schemas (section 5.14) | T9.1 |
| `server/lib/fieldOps/worldSettings.ts (new)` | The flag and settings readers (section 6.13) | T9.4 |
| `server/lib/fieldOps/worldRules.test.ts (new)` | Tests of the two shared modules and the schemas | T9.1 |
| `migrations/249_fieldops_spread_library.sql (new)` | The spread library (section 5.2) | T9.2 |
| `migrations/250_fieldops_world_models.sql (new)` | World models (section 5.3) | T9.6 |
| `migrations/251_fieldops_world_sessions.sql (new)` | World sessions and the lease functions (section 5.4) | T9.6 |
| `migrations/252_fieldops_world_log.sql (new)` | Commands, events, snapshots (section 5.5) | T9.6 |
| `migrations/253_fieldops_world_units.sql (new)` | Speed classes, road graphs, units (section 5.6) | T9.15 |
| `migrations/254_fieldops_world_visibility.sql (new)` | Knowledge and reports (section 5.7) | T9.19 |
| `migrations/255_fieldops_weather_traffic.sql (new)` | Weather presets and traffic profiles (section 5.8) | T9.21 |
| `server/services/fieldOps/world/data/seed/ (new)` | The seven seed files of section 5.12 | T9.2, T9.15, T9.21 |
| `server/services/fieldOps/world/spreadLibrary.ts (new)` | The loader, `hazardEventsFor`, `deteriorationFactsFor` | T9.3 |
| `server/services/fieldOps/world/spreadLibraryAdmin.ts (new)` | Seeding, row edits, retirement, reviews | T9.4 |
| `server/services/fieldOps/world/compileSpread.ts (new)` | `buildSpreadTimeline` | T9.5 |
| `server/services/fieldOps/world/index.ts (new)` | The exports of section 6.18 | T9.5 |
| `server/services/fieldOps/world/worker/ (new)` | `workerPool.ts`, `worldWorker.ts`, `protocol.ts` | T9.5, T9.10 |
| `server/services/fieldOps/world/model/ (new)` | `worldModel.ts`, `buildWorldModel.ts`, `worldInputs.ts`, `worldModelStore.ts`, `prepareJob.ts` | T9.7, T9.23 |
| `server/services/fieldOps/world/engine/ (new)` | `state.ts`, `rng.ts`, `grid.ts`, `fire.ts`, `smoke.ts`, `structure.ts`, `plumes.ts`, `crowd.ts`, `exposure.ts`, `actions.ts`, `units.ts`, `weather.ts`, `visibility.ts`, `step.ts` | T9.8, T9.9, T9.16, T9.19, T9.21 |
| `server/services/fieldOps/world/roads/ (new)` | `roadGraph.ts`, `roadGraphStore.ts`, `routing.ts`, `traffic.ts` | T9.15, T9.16, T9.22 |
| `server/services/fieldOps/world/weather/weatherData.ts (new)` | Presets, profiles and speed classes from the tables | T9.21 |
| `server/services/fieldOps/world/fog/ (new)` | `views.ts`, `fogFilter.ts` | T9.12, T9.19, T9.20 |
| `server/services/fieldOps/world/bridge/ (new)` | `pinBridge.ts`, `worldGates.ts` | T9.11, T9.17 |
| `server/services/fieldOps/world/runtime/ (new)` | `worldRuntime.ts`, `worldStore.ts`, `backPressure.ts` | T9.10 |
| `server/routes/fieldOpsWorld.ts (new)` | The session world's routes | T9.12, T9.17, T9.19 |
| `server/routes/fieldOpsSpreadLibrary.ts (new)` | The library's admin routes | T9.4 |
| The test files of section 11.1 | Under the folders above, `server/routes/`, `server/services/` and `frontend/tests/`, each marked new there | each task |
| `server/services/fieldOps/world/__fixtures__/ (new)` | `marinaCourtWorld.ts`, `roads.ts`, `fakeWorldStore.ts`, `library.ts`, `worldStates.ts` | T9.3, T9.7, T9.10, T9.15, T9.19 |
| `server/services/__fixtures__/envSimGolden.json (new)` | Today's simulation output, recorded on the baseline | T9.5 |
| `scripts/fieldops-world-soak.ts (new)` | The soak of section 11.3, run by hand | T9.10 |
| `frontend/src/components/FieldOps/World/ (new)` | The sixteen client files of section 7.1 | T9.13, T9.18, T9.20, T9.23 |
| `frontend/src/lib/fieldOps/worldApi.ts (new)` | The client API (section 7.7) | T9.13 |
| `frontend/src/design/fieldops-world.css (new)` | The `fo-world-` classes (section 7.9) | T9.13 |

### 14.2 Existing files WS9 touches

| Path | Change | Task |
| --- | --- | --- |
| `server/services/environmentalSimService.ts` | An optional eighth argument `EnvSimParams`; without it the function is exactly today's (section 6.5) | T9.5 |
| `server/env.ts` | `enableFieldopsWorldSim` and the world settings, after WS0's field-ops block (section 6.13) | T9.4 |
| `server/index.ts` | The two routers, the prepare job's import, `startWorldRuntime` and `stopWorldRuntime` (section 6.18) | T9.4, T9.10, T9.12 |
| `server/services/hazardDeteriorationService.ts` | Skip world-owned hazards; do not reveal timeline children while a world runs (section 6.12) | T9.11 |
| `server/services/pinResolutionService.ts` | Skip world-owned hazards (section 6.12) | T9.11 |
| `server/services/exitFlowService.ts` | The world's factor on each exit's rate (section 6.12) | T9.11 |
| `server/services/injectSchedulerService.ts` | `deviceDetonated` after `checkDetonationTimers` detonates (section 6.12) | T9.11 |
| `server/routes/placements.ts` | 409 `WORLD_UNIT_ASSET` on `PATCH` and `DELETE`; the fog filter on the list (sections 6.8.7 and 6.10.5) | T9.17, T9.20 |
| `server/routes/hazards.ts` | The fog filter on the list and detail routes (section 6.10.5) | T9.20 |
| `server/routes/casualties.ts` | The fog filter on the list and detail routes (section 6.10.5) | T9.20 |
| `server/services/websocketService.ts` | `redactForFog` on the room emit of `broadcastToSession`; the internal bus unchanged (section 6.10.5) | T9.20 |
| `frontend/src/components/COP/MapView.tsx` | The world layer's mount; the refetch check in the placement and casualty handlers (section 7.7) | T9.13, T9.20 |
| `frontend/src/pages/SessionView.tsx` | The console card (section 7.4) | T9.13 |
| `frontend/src/components/Session/SessionLobby.tsx` | The lobby card (section 7.5) | T9.13 |
| `frontend/src/components/AAR/AARDashboard.tsx` | The replay panel (section 7.6) | T9.13 |
| `frontend/src/components/UI/WarRoomIcon.tsx` | Four glyphs: `wind`, `rain`, `pause`, `barrier` (section 7.9) | T9.13 |
| `package.json` | The test files of section 11.5 | every task |

Several of these are also touched by other workstreams (`server/env.ts` and `server/index.ts` by WS0, `MapView.tsx` by WS0 and WS4, `SessionView.tsx` and `SessionLobby.tsx` by WS7, `WarRoomIcon.tsx` by WS1). WS9's changes are additive lines next to theirs and land after them in build order (master section 6).

### 14.3 Files of other workstreams WS9 relies on

| Path | Owner | What WS9 uses |
| --- | --- | --- |
| `server/services/fieldOps/jobs/jobRegistry.ts (new)` | WS0 | `registerJobKind` for `fieldops_world_prepare` |
| `server/services/fieldOps/jobs/jobEngine.ts (new)` | WS0 | `WORKER_ID` and the job scope, reused for world leases (W11) |
| `server/lib/schemaFeatures.ts (new)` | WS0 | The cached table detectors for 249 to 255 |
| `server/lib/fieldOps/requireFieldopsFlag.ts (new)` | WS0 | `requireFieldopsFlag` and `requireFieldopsTrainer` |
| `server/lib/participantProjections.ts (new)` | WS0 | The projections WS9's fog filters run after |
| `frontend/src/lib/fieldOps/fieldOpsHttp.ts (new)` | WS0 | `fieldOpsRequest` and `FieldOpsApiError` |
| `shared/fieldOps/vocabulary.ts (new)` | WS1 | `ArchetypeKey` and `ARCHETYPE_KEYS` |
| `shared/fieldOps/actionScope.ts (new)` | WS1 | `actionScopeFor`, for the tasks a unit may do |
| `server/services/fieldOps/site/siteArea.ts (new)` | WS3 | `loadSiteArea`, for the buildings and the road box |
| `server/services/fieldOps/site/facilities.ts (new)` | WS3 | `listFacilitiesNear`, for unit origins and hospitals |
| `server/services/fieldOps/layout/index.ts (new)` | WS4 | `loadSceneByScenario(ctx, scenarioId)`, which answers a `SceneLoadView` |
| `server/services/fieldOps/layout/sceneStore.ts (new)` | WS4 | `SceneCtx`, which the prepare job builds (section 6.6.2) |
| `shared/fieldOps/layout.ts (new)` | WS4 | `SceneLoadView`, `SceneConfigV2` and the optional `SceneHazard.material` |
| `shared/fieldOps/sceneGeometry.ts (new)` | WS4 | `simToLatLng`, for cell geometry |
| `shared/fieldOps/crowd.ts (new)` | WS4 | `crowdGeometryOf` and `toCrowdZoneInputs`, for the crowd groups |
| `shared/fieldOps/compile.ts (new)` | WS5 | `CompileDeviceEffect` |
| `server/services/fieldOps/compile/spreadInputs.ts (new)` | WS5 | `CompileSpreadHazard`, which `SpreadHazardInput` accepts unchanged |
| `server/services/fieldOps/compile/snapshotReaders.ts (new)` | WS5 | `loadPhysicsSnapshot` |
| `shared/fieldOps/deviceModeration.ts (new)` | WS6 | `moderateDeviceText` for every library text field |
| `server/services/fieldOps/bots/projection.ts (new)` | WS7 | `FORBIDDEN_KEYS` in AC9.46, and `ACTOR_REQUESTS`, which gains the world routes (section 15.3) |

WS1's `CountryMatch` and `countryMatch` (`shared/fieldOps/doctrineCountry.ts (new)`, master 10.8 item 37) are the only country-match vocabulary of the set. WS9 needs no doctrine country in version 1, so it imports neither.

## 15. Risks and open questions

### 15.1 Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R9.1 | The world blocks the one Node process that serves every engine and socket (master risk 19) | Worker threads, a 250 ms tick budget, an active set of cells, caps on cells, groups, units and plumes (section 6.17), back-pressure and fallback (section 6.11.8), AC9.24 and the soak of section 11.3 |
| R9.2 | The world and today's engines escalate the same hazard twice, or contradict each other: two games on one map | Four narrow gates keyed on `properties.world_owned` and `isWorldActive`, the hand-back on fallback (section 6.12), AC9.27 and AC9.28 |
| R9.3 | Fog of war leaks a hidden fact through a channel nobody filtered | Every payload route and broadcast is filtered after WS0's projections; the channels left unfiltered are listed with their reasons (section 6.10.5); the 1,000-state corpus of AC9.46; the production gate on master risk 14 (section 9.7) |
| R9.4 | Stored values make fire or smoke implausibly fast or slow in play | Planning values from named sources; the D31 review with its checklist; "Unreviewed model" until then; production limited to admins' sessions (W24); admins correct a row without a deploy |
| R9.5 | A replay or a recovery diverges, so the After-Action Review shows a different story | Integer state, named seeded streams, fixed command order, state hashes in every snapshot (W9, section 6.7.10), AC9.23 and AC9.25; the static check also refuses `Math.random`, `Date.now` and `performance.now` in the engine folder |
| R9.6 | Production runs more than one instance: a world's deltas are emitted by one process while some sockets sit on another | Version 1 requires one instance (master section 12); the lease still keeps one runner; a Socket.IO adapter is later work (section 15.2, question 21) |
| R9.7 | Database writes or storage grow with sessions | At most 150 writes a minute a world (AC9.26), batched events, one snapshot a minute, thinning and 180-day retention (section 6.11.10) |
| R9.8 | The scope is the largest of the set (master risk 22) | Five slices, each falling back to today's behaviour (section 4.2), seven commits with backtracking (section 13) |
| R9.9 | A large primary building exceeds the grid | 4 m and 5 m cells, at most four floors, then `WORLD_TOO_LARGE` and today's escalation, shown in the lobby before the start (AC9.15) |
| R9.10 | The road graph of a 14 km box is slow or heavy to build | Built once per box and data version in the prepare job, in a worker, with node and edge caps, and cached across scenarios (section 6.8.3) |
| R9.11 | Arrived units, as placed assets, trigger today's checks in ways nobody intended (for example resolving a pin on arrival) | The asset-type mapping and `validatePlacement` (section 6.8.7); pin resolution skips world-owned hazards; AC9.38 |
| R9.12 | Trainers or players read the training model as engineering or medical advice | "Unreviewed model" until review; console and replay copy that presents values as an exercise's (section 9.4) |

### 15.2 Open questions

Design 7's six questions (`docs/field-ops-user-journey.html`, `id="c8a-d7"`), numbered as in the journey, each with the default this spec is built on:

11. **How fine is the world?** **Assumed (D32):** 3 m cells inside the primary building, coarsened to 4 m and 5 m when it would need more than 20,000; the trainer's one plan on at most four floors linked by her stairwells; each involved building one compartment; plumes outdoors; crowd groups of at most 50 (W4 to W8). Zone models of the CFAST kind, per-person agents and per-floor plans are later versions.
12. **Which units does each archetype have, how many, and where do they start?** **Assumed (D33):** the catalogue of section 5.10.1 with its default counts, which the trainer may change from 0 to 8 a kind in the lobby (at most 40 a session); each unit starts at the nearest WS3 facility of its kind (`fire_station`, `ambulance_station`, `police`, `hospital`) within the road box, else at an entry point; the trainer may set a staging point; venue staff start on site.
13. **What counts as seeing?** **Assumed (D34):** a team's units and its placed assets, with ranges cut by smoke, walls, weather and darkness, plus the reports other teams share. CCTV (WS3 already stores `surveillance_camera` facilities), drones and sensors are a later version.
14. **Which weather can she choose, and can it change during the session?** **Assumed (D35):** six conditions (clear, cloudy, light rain, heavy rain, thunderstorm, haze) with wind, temperature, rain, visibility and PSI as fields, so heat and wind are set on any condition; Singapore presets; yes, the trainer may change it during play with a transition of up to 10 minutes.
15. **Traffic: time-of-day profiles by road type for Singapore first?** **Assumed (D35):** yes: stored profiles by road group (expressway, arterial, collector, local), day type and hour, read at Setup's "When"; no live feed (D5).
16. **Doctrine coverage: which countries and agencies come first?** **Assumed (D29):** Singapore, Malaysia, Indonesia, the Philippines and Thailand, then the rest of ASEAN. This is WS1's to settle; WS9 needs no doctrine country, and where any spec needs a country match it uses WS1's `CountryMatch` (master 10.8 item 37).

WS9's own questions:

17. **Who reviews the spread library?** **Assumed (D31):** a person with fire-engineering or fire-service experience, as D22 asks for the blast library. Still open: who.
18. **Which wind convention is right?** The map's indicator draws the wind as coming from its angle, while spatial scoring reads the same number as where it blows to (section 3.7). **Assumed (D35):** the meteorological "from" convention is right and the scoring is a defect for its owner; WS9 stores "from" and never writes `environmental_state.wind` (section 6.9.5).
19. **Should walls shield the blast?** WS6's radii are applied by distance. **Assumed (D8):** not in version 1; any shielding model is WS6's to add to its calculator.
20. **Are three plume stability values enough?** **Assumed (D31):** yes for training, subject to the review (section 6.7.5).
21. **Does production stay on one Render instance?** **Added 3 Nov 2026. Verified** in Render's service settings and metrics on 3 Nov 2026: the backend, `blackswansimulations-backend`, runs one instance and ran one throughout the day before. It must stay at one while the flag is on (R9.6).
22. **Does the instance have at least two cores and 2 GB of memory?** **Added 3 Nov 2026. Verified** on the same day: it has 2 GB but only 1 CPU (Render's Standard plan), and already uses about 0.2 CPU and 0.4 GB. So the 2-thread, 4-world budget of section 6.17 does not fit it. Either move the backend to a plan with 2 CPUs before rollout step 3, or run with `FIELDOPS_WORLD_WORKERS=1` and `FIELDOPS_WORLD_MAX_SESSIONS=1` until the soak of section 11.3 passes with more (section 6.17).
23. **Should unit positions be shared with every team by default?** **Assumed (D34):** yes (W18); the trainer can turn sharing off in the lobby.
24. **May production run worlds only for admins until the review is recorded?** **Assumed (D31):** yes (W24), as WS6 gates its calculator under D22.
25. **Should compiled fire-spread pins reach sessions that have no live world?** Answered by master 10.8 item 40: yes, for new-flow scenarios. WS5's session start copies the delayed pins with their parents remapped (`06-compile-and-review.md` section 5.8, AC5.40), so they are the scripted escalation when no world runs. Item 40 also keeps each copy off the session lists until it is revealed: the copy gets `appears_at_minutes` 1,000,000, its minute stays in `spawn_condition.at_minutes`, and the reveal sets the current minute (section 3.1). While a world runs, the gate stops the reveal, so they stay hidden, and the hand-back retires those still waiting (sections 6.12.1 and 6.12.3, AC9.56).
26. **Is 180 days the right retention for world logs and snapshots?** **Assumed (D32):** yes; the last snapshot of each session is kept with the session.

### 15.3 Requests WS9 makes of other specs

| To | Request | Why |
| --- | --- | --- |
| Master plan (`00-master-plan.md`) | List `FIELDOPS_WORLD_MAX_SESSIONS`, `FIELDOPS_WORLD_WORKERS`, `FIELDOPS_WORLD_LEASE_SECONDS`, `FIELDOPS_WORLD_TICK_BUDGET_MS` and `FIELDOPS_WORLD_SNAPSHOT_SECONDS` with their defaults and bounds beside `ENABLE_FIELDOPS_WORLD_SIM` in section 8 | Section 6.13; they are operational switches, `FIELDOPS_WORLD_MAX_SESSIONS=0` above all |
| Master plan (`00-master-plan.md`) | In 10.8 item 38, record the optional `signal` of `buildSpreadTimeline`'s input, the `version` label of `SpreadLibrary` and the pure `buildSpreadLibrary` | Both were asked for by WS5 (its section 15.4); item 38 should stay the one statement of the contract |
| Master plan (`00-master-plan.md`) | In section 12, state that one instance is required while `ENABLE_FIELDOPS_WORLD_SIM` is on; in risk 14's row, add that fog of war depends on closing the scene read policy | R9.6; section 9.7 |
| WS0 (`01-prerequisites.md`) | Include detectors for 249 to 255 (`fieldops_spread_materials`, `fieldops_world_models`, `fieldops_world_sessions`, `fieldops_world_events`, `fieldops_road_graphs`, `fieldops_world_knowledge`, `fieldops_weather_presets`) in the detector list of master 10.8 item 5; leave at least 3 of the 10 shutdown seconds after `stopJobEngine` for `stopWorldRuntime` | Section 5.13; section 6.11.10 |
| WS1 (`02-teams-and-doctrines.md`) | Keep `zone_access`, `can_triage` and `can_sweep` in `ArchetypeActionScope` with their meanings, and add a row to WS9's unit catalogue whenever an archetype is added | `tasksForUnit` and the access rule read them (AC9.34, AC9.39) |
| WS2 (`03-setup-screen.md`) | Store `setup_v2.options.weather_setting: WeatherSetting \| null` beside the label `options.weather`, validated with WS9's `weatherSettingSchema`, and offer the presets of section 5.12.6 next to the label | Master 10.8 item 39; W23. `incident.when` already gives `day` and `time`, which is all WS9 needs |
| WS3 (`04-site-picker.md`) | Keep the facility kinds `fire_station`, `ambulance_station`, `police` and `hospital` stable, with `listFacilitiesNear` returning each facility's kind, name and position; keep the active data version's label readable for the road graph's cache key | Unit origins (section 6.8.2) and the cache (section 6.8.3) |
| WS4 (`05-layout-step.md`) | The hazard `material` is done (05 sections 5.4, 5.7 and 7.7, AC4.30; answered in section 15.5). Still asked: consider an optional `floor` on hazards, walls and crowd zones in a later version; mount WS9's world layer next to `FieldOpsSceneOverlay` in `MapView` | D36; W5; section 7.1 |
| WS5 (`06-compile-and-review.md`) | Settled: 06 already gives no fire-spread pins and a warning for `timeout` and `failed` (its section 6.16, the fallbacks table), WS9's `timeout` backstop and `worker_failed` count as `failed` there, and its 90-second timer gives `timeout` before WS9's `aborted` can arrive, so nothing more is needed. Withdrawn: the pill wording, because under master 10.8 item 40 the pins do reach sessions. Answered: WS9's point that a copied child would be listed at its minute before it is revealed. Master 10.8 item 40 and 06 section 5.8 (AC5.40) now give each copied delayed row `appears_at_minutes` 1,000,000, keep its minute in `spawn_condition.at_minutes`, and have the reveal set `appears_at_minutes` to the current minute (`server/services/hazardDeteriorationService.ts:119-122`); every delayed child compile writes has the `parent_unresolved` trigger. No request remains: WS9's gate and hand-back read each copy's `status` and `properties.spawned_from`, which the copy keeps | Section 3.1; sections 6.12.1 and 6.12.3; AC9.56 |
| WS6 (`07-device-and-physics.md`) | Keep `EffectEstimate.structural[].radius.central` with the four `STRUCTURAL_KEYS` and `thermal.radius.central` stable; allow `moderateDeviceText` for the library's text fields with its `maxLength` option | Section 6.6.2; section 6.2 |
| WS7 (`08-people-or-ai.md`) | Add the world's view, dispatch, recall, task and report routes to `ACTOR_REQUESTS`; add `dispatch_unit` and `share_report` to the closed action set, with `suggestUnitForTask` for the planner; export `FORBIDDEN_KEYS` for AC9.46 | D33 and D34: AI agencies play through the same routes and the same fog (section 6.8.10) |
| WS8 (`09-after-publish.md`) | Expose the revision the start claim pins (`fieldops_session_revisions`) to WS9 when its world row is created; leave a running session's world on the model it started with when a layout re-sync rebuilds hazards; carry `options.weather_setting` in the setup copy | Master 10.8 item 26; sections 6.6 and 6.11.1 |
| UI spec sheet (`10-ui-spec-sheet.md`) | Add WS9's surfaces: the `fo-world-` class rows, the four new glyphs, the world layers' map palette and the copy keys of section 7.10 | D28; the sheet is the set's one source for classes, icons and copy |

### 15.4 Answers to WS5's requests (`06-compile-and-review.md` section 15.4)

| Request | Answer |
| --- | --- |
| Confirm the item 38 signatures as WS5 calls them | Confirmed. `loadSpreadLibrary(): Promise<SpreadLibrary \| null>`; `deteriorationFactsFor(hazards, casualties, library): string` with the hazards as `{ label, hazard_type, properties }` and the casualties as `{ casualty_type, conditions }`; `buildSpreadTimeline({ studs, walls, hazards, library, durationMin, signal? })` with `SimStud[]`, `SimWall[]` and `CompileSpreadHazard[]`, which `SpreadHazardInput & { pos }` accepts unchanged, returning today's `EnvironmentalSnapshot[]` (sections 6.2 and 6.5) |
| Build each hazard's events with `hazardEventsFor`, in simulation seconds, using `blast` and `material` | Confirmed (section 6.3): today's `HazardEvent`, `triggerTimeSec` in simulation seconds at a time scale of 1, the blast's arrival and band from `CompileSpreadHazard.blast`, and the contents behaviour from `material`, which WS4's hazard panel now sets from `CONTENTS_MATERIAL_OPTIONS` (`05-layout-step.md` section 5.4) |
| Snapshot minutes, `signal`, library size and `version`, facts under 6,000 characters | Confirmed. Snapshots at today's minutes (0, 1, 3, 5, 10, 15, 20, 30, 45, 60) and every 15 minutes after 60 up to `durationMin`; the `signal` stops the worker and rejects with `aborted`; the library is capped at 262,144 bytes (about 40 KB seeded); `SpreadLibrary.version` is `fo-spread-1.0.0:` and the dataset version; the facts block is cut to 6,000 characters (sections 6.2, 6.4 and 6.5) |
| An optional `weather?: WeatherSetting` on the timeline | Declined for version 1. The batch simulation keeps fire inside the hazard radii and smoke as a per-stud level, so it has no outdoor fire or plume for weather to change; weather acts in the live world, where the trainer sees fire and plumes move (section 6.5). The pins now reach sessions without a world (master 10.8 item 40), but they would not differ with weather |
| `loadPhysicsSnapshot`, revealing the fire-spread pins, sweeps at inspection points | The world reads the physics through `loadPhysicsSnapshot` (section 6.6.2); while a world runs, children with `properties.spawned_from = 'environmental_timeline'` are not revealed, because the world's own fires replace them, and they stay off the lists because item 40's copy hides them until a reveal (section 6.12.1); the hand-back retires those still waiting (section 6.12.3); a bomb-squad unit sweeping an inspection point finds the pool entry anchored there by `wall_point_id` (section 6.8.8) |

### 15.5 Requests made of WS9 by other specs

| From | Request | Answer |
| --- | --- | --- |
| WS4 (`05-layout-step.md` section 15.4, R4.15) | Export `CONTENTS_MATERIAL_OPTIONS: ReadonlyArray<{ key: string; label: string }>` from `shared/fieldOps/world.ts (new)`: the contents rows of section 5.12.2 in a fixed order, with the labels the trainer sees | Done (section 5.10): the thirteen `contents` rows of section 5.12.2, in that table's order, with its labels. The file imports nothing, so the browser and the server read it before any library is loaded. The seed file and the constant list the same keys and labels, and a parity test keeps them so (AC9.57) |
| WS4 (`05-layout-step.md` sections 5.4, 5.7 and 7.7) | Use the hazard's optional `material` | Used. `hazardEventsFor` takes the material's flame spread and smoke for a hazard's fire event (section 6.3); `prepareSpreadInput` gives its cells that material's growth (section 6.5); the world model gives the floor-0 cells within the hazard's radius that contents (section 6.6.3). With no material, the hazard type's own row decides (AC9.57) |
| WS5 (`06-compile-and-review.md` section 6.16) | Accept the `signal` WS5 now passes, which aborts at its 90-second `SPREAD_TIMELINE_BUDGET_MS` or with its stage | Accepted. On abort the spread thread is terminated within a second and the promise rejects with `aborted` (AC9.8). Because WS5's timer has already given `timeout` by then, and it ignores a late settlement, the rejection only frees the thread. WS9's own 120-second `timeoutMs` stays a backstop for callers without a signal. A timeline waiting for one of the `SPREAD_LIMITS.maxConcurrent` spread threads counts its wait against the same signal (section 6.11.2) |
| WS5 (`06-compile-and-review.md` sections 6.15 and 6.16), for WS8 (`09-after-publish.md` section 6.8) | Serve `rebuildFireSpread`, through which WS8's editor calls `loadSpreadLibrary` and `buildSpreadTimeline` when a published layout or device edit changes the hazards, the interior walls or the main device | Supported with no change to either signature. WS8 is added to their users (section 6.18). The library comes from the same 60-second cache, and every timeline from a published edit runs on its own spread thread, never on one hosting worlds, at most two at a time per process (section 6.11.2), so editor previews cannot slow a live world. A session already running keeps its world model, its cloned rows and its frozen library; an edit reaches only the sessions started after it (section 6.11.7) |

## 16. Definition of done

WS9 is done when every line below holds on staging, and the production lines hold before the flag is turned on there.

1. AC9.1 to AC9.57 pass: each through its test file of section 11.1, all listed in the `test` script (section 11.5), and those with manual steps through M1 to M13 on staging.
2. `npm test`, `npm run typecheck`, `npm run lint` and `npm --prefix frontend run build` pass on the final commit.
3. Migrations 249 to 255 have each applied twice without error on a scratch database (a Supabase branch or a local Postgres, never the shared project), and their rollback comments have run cleanly on a branch database; after those scratch runs, each is applied once, in order, on the shared project; 256 is unused.
4. The seed library is loaded through the admin route; either the D31 review is recorded for the deployed `dataset_version`, or production runs worlds only for admins' sessions and shows "Unreviewed model" (W24).
5. WS5's compile calls `loadSpreadLibrary`, `deteriorationFactsFor` and `buildSpreadTimeline` and no longer asks a model for hazard events or deterioration physics (master 10.8 item 38); legacy callers of `runEnvironmentalSimulation` are byte-identical to the baseline (AC9.10).
6. With `ENABLE_FIELDOPS_WORLD_SIM` off, every session behaves exactly as today (AC9.28, AC9.30, M1); with it on, a world that falls behind or fails hands its hazards back and the session continues with today's escalation (AC9.27, M5).
7. The soak of section 11.3 passes with four worlds at the largest size, and the main thread's lag stays under 50 ms at the 95th percentile.
8. No hidden fact reaches a browser or an AI agency in a fog session (AC9.44 to AC9.47, M10, M13), and the trainer sees everything (AC9.43).
9. No file of the world imports a model client, `fetch` or a map service, and the engine uses no clock or unseeded randomness (AC9.54); every seed row names its source and contains no device content (AC9.55); no log line carries a device field, a description or a note (AC9.53).
10. The log events of section 10.3 appear in the Render logs for a staging session, and the runbook of section 10.5 has been walked through once.
11. The production gates of section 9.7 hold.
12. The requests of section 15.3 are answered by their owners or recorded in their specs, and the master plan lists the world settings in its section 8.
13. Where the build backtracked (section 13), this document was changed first and still matches the code.
