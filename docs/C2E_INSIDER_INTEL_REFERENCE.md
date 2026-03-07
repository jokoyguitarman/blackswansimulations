# C2E Insider Intel Reference

This document defines, for the C2E Bombing at Community Event scenario, the intel categories and detailed facts the Insider can provide—**only when asked**—so teams decide their own actions rather than receive pre-defined plans. Use it when implementing granular Insider responses and seeding `insider_knowledge`.

---

## 1. Design principles

- **Intel only when asked:** Every detail is available only when a player asks for it specifically. No combined dumps unless the user explicitly asks for "full layout", "all details", or "everything about the site".
- **Teams decide:** The Insider provides **environmental and operational facts**; teams use them to **decide** (evacuation plan, where to establish triage/holding, what to say publicly).
- **No prescription:** The Insider must **not** give pre-defined "triage zones", "the evacuation plan", or "the statement to issue"—only the raw intel needed to make those decisions.
- **Awareness and cleverness:** Whether teams ask for the right intel is part of the exercise. AAR can report what was asked and what was not (e.g. via `session_insider_qa`).

---

## 2. Shared / neutral intel (all teams)

These categories are available to any team when they ask the right question. Return only the slice that matches the question.

| Category                                         | When to return                                                                                                   | What to store/return                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Map**                                          | Only when asked for "the map", "vicinity map", "layout plan", "show me the map"                                  | `vicinity_map_url`, `layout_image_url` (URLs only; no narrative). Existing behaviour in `insiderService.ts`.                                                                 |
| **Blast / event**                                | When asked about blast site, detonation, epicentre, ground zero, event location                                  | Single detonation; location (e.g. central seating at hard court); approximate debris radius; timing. No prescription of response.                                            |
| **Evacuee count / headcount**                    | When asked about crowd size, evacuees, how many people, headcount                                                | Single number (e.g. ~1000).                                                                                                                                                  |
| **Exits and flow**                               | When asked about exits, flow rate, egress, evacuation routes, bottlenecks                                        | List of exits: id, label, flow_per_min, status (open/congested/blocked). No recommendation of which to use.                                                                  |
| **Vicinity – hospitals**                         | When asked about hospitals, medical facilities, healthcare, how many hospitals                                   | From `osm_vicinity.hospitals` or seeded: name, lat, lng, address.                                                                                                            |
| **Vicinity – police**                            | When asked about police, outposts, stations, law enforcement locations                                           | From `osm_vicinity.police`: name, lat, lng, address.                                                                                                                         |
| **Vicinity – CCTV**                              | When asked about CCTV, cameras, surveillance, footage                                                            | From `osm_vicinity.cctv_or_surveillance`: location, lat, lng. Or "No public CCTV data" if none.                                                                              |
| **Vicinity – routes**                            | When asked about routes, emergency routes, roads, access                                                         | From `osm_vicinity.emergency_routes`: description, highway_type, one_way.                                                                                                    |
| **Crowd density / population around blast site** | When asked about crowd density, population around the area, people around the blast site, surrounds of the blast | From `custom_facts` topic `crowd_density_blast_surrounds`: per-zone density and concentration; relevant for second-device planning (where people still are, where to clear). |

**Implementation note:** Existing `insiderService.ts` categories are `map`, `hospitals`, `police`, `cctv`, `routes`, `layout`. Extend `layout` into sub-categories (evacuees, exits, blast_site, ground_zero_cordon, etc.) so each is returned only when the question matches—no single "layout" dump for every layout-related question.

---

## 3. Evacuation team

**Deliverable they decide:** Evacuation plan (which exits, sequence, flow, ground zero/cordon, assembly areas, coordination with triage and media).

**Insider must NOT:** Give "the evacuation plan" or "recommended exits"; only the facts needed to design one.

### Categories and details

| Category                  | Purpose                                   | Example details to store/return                                                                                          |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **exits_flow**            | Which exits exist, capacity, status       | id, label, flow_per_min, status (open/congested/blocked); bottlenecks (e.g. West exit congested).                        |
| **ground_zero_cordon**    | Where blast is, what is cordoned          | Epicentre description; inner cordon extent (e.g. 20 m); no-entry rule; safe distance for assembly.                       |
| **evacuee_count**         | Scale of crowd                            | Approximate headcount (e.g. 1000).                                                                                       |
| **access_for_responders** | Where emergency services can enter        | Vehicle access points; ambulance pickup areas; routes from main roads (so Evac can coordinate handover).                 |
| **assembly_potential**    | Where crowds could be held before release | Flat areas, capacity potential, cover—e.g. "North side: level, ~200 capacity potential, covered". Not "Assembly area A". |
| **routes_vicinity**       | Roads/corridors for evacuation flow       | Emergency routes (OSM or seeded), one-way, key corridors. Shared with shared intel.                                      |

**Storage:** `exits_flow`, `ground_zero_cordon`, `evacuee_count` can live in `layout_ground_truth`; `assembly_potential` and `access_for_responders` as structured descriptors or `custom_facts` topics. Classifier maps questions like "exits", "flow", "ground zero", "cordon", "where can emergency services access", "assembly area" to the right category.

---

## 4. Triage / medical team

**Deliverable they decide:** Where to establish triage and holding areas; how to prioritise casualties; how to coordinate with evacuation and ambulance pickup.

**Insider must NOT:** Give "triage zone A/B" or "the triage areas"; only the environmental facts needed to **site** and run triage/holding.

### Categories and details

| Category                | Purpose                                       | Example details                                                                              |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **space_terrain**       | Where could we put casualties / hold evacuees | Flat/level areas; size (~m² or capacity potential); cover/shelter; surface (concrete/grass). |
| **access_egress**       | Stretcher routes, vehicle/ambulance access    | Vehicle access points; stretcher/trolley routes; ambulance pickup points; bottlenecks.       |
| **safety_hazards**      | Safe siting                                   | Distance from cordon; secondary hazards (collapse, vehicles); wind/smoke direction.          |
| **utilities_resources** | What is available to run a holding area       | Water taps; power/lighting; buildings (e.g. community club first aid room); shelter.         |
| **proximity_flow**      | Links to exits and flow                       | Distance to each exit; flow rates; so they can align triage with casualty outflow.           |

**Storage:** Store as `site_areas` (or structured `custom_facts`) with **descriptors only**—no field named "triage" or "holding". Classifier: "space for casualty staging", "flat area", "shelter", "ambulance access", "safe from blast", "water", "power", etc.

---

## 5. Media team

**Deliverable they decide:** First public statement; what to say about the incident; how to address misinformation; when to speak; what to defer.

**Insider must NOT:** Give "the statement to issue" or "recommended messaging"; only verified facts and information-environment details so Media can decide wording and timing.

### Categories and details

| Category                                 | Purpose                                      | Example details                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **verified_facts_incident**              | What is confirmed about the incident         | Single detonation; location (community event, hard court); approximate time; what is **not** yet confirmed (e.g. casualty count, perpetrator).                  |
| **verified_facts_casualties_evacuation** | What can be said about casualties/evacuation | E.g. "evacuation in progress"; "casualty figures not yet confirmed"; "no official casualty count yet". No operational detail that would compromise Evac/Triage. |
| **information_environment**              | What is circulating (for counter-messaging)  | Known false claims (e.g. "second bomb", "Malay attacker"); platforms/sources; that journalists are on site or requesting comment.                               |
| **sensitivities**                        | Context for wording                          | Community event; multi-ethnic attendance; risk of ethnic/religious tension; avoid naming unconfirmed perpetrator ethnicity.                                     |
| **official_sources**                     | Who can speak                                | C2E as coordinating body; that emergency services are delayed; no "spokesperson script".                                                                        |

**Storage:** `custom_facts` with topics e.g. `verified_incident`, `verified_casualties_evacuation`, `information_environment`, `sensitivities`, `official_sources`, or a dedicated `media_intel` structure. Classifier: "verified facts", "what can we say", "misinformation", "known false claims", "sensitivities", "who speaks".

---

## 6. Coordination / security-relevant intel

C2E has no separate "security" team; the evacuation brief includes "Watch for suspicious individuals and coordinate." Security-relevant intel is **shared**:

- **CCTV / surveillance:** Coverage (which areas, blind spots)—when asked; supports "where can we look for suspicious behaviour".
- **Police / outposts:** Nearby police, names, locations—when asked; supports "who to report to" and "safe access".
- **Exit choke points / congestion:** Which exits are congested or high-risk for secondary attack—already under `exits_flow`; can be emphasised when the question is security-focused.

**Insider must NOT:** Give a "security plan"—only facts (CCTV, police, exit status) so the team can decide how to respond to suspicious-individual injects.

---

## 7. Implementation checklist (for later)

When building Insider updates and seeding C2E:

- **Insider categories:** Extend `server/services/insiderService.ts` with layout sub-categories and new categories (`space_terrain`, `access_egress`, `safety_hazards`, `utilities_resources`, `proximity_flow`; `verified_facts_*`, `information_environment`, `sensitivities`, `official_sources`) and map question phrases to them.
- **Schema / storage:** Extend `insider_knowledge` (e.g. in migration 059 or a new migration and `demo/seed_c2e_gates_and_insider.sql`) with `site_areas` (or equivalent) and `custom_facts` topics as in this doc; remove or repurpose pre-defined "triage zones" into environmental descriptors only.
- **Seeding:** Populate the C2E scenario’s `insider_knowledge` with the detailed layout (exits, flow, blast/cordon, assembly potential, access, space/terrain, safety, utilities, proximity) and media intel (verified facts, information environment, sensitivities) per this reference.
- **Reference:** `docs/SCENARIO_VICINITY_MAP_AND_LAYOUT.md` (§9–11) for map/Insider behaviour and layout ground truth for AI judgement.

---

## 8. Question phrase table (classifier reference)

Use this table to tune the Insider classifier (regexes or keywords) so each question type maps to the correct category. Only one slice is returned per question.

| Example question                                                              | Category                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Show me the map / Give me the vicinity map / Layout plan                      | `map`                                                                                                         |
| How many evacuees? / Headcount / Crowd size                                   | `evacuee_count` (or layout sub-category)                                                                      |
| Where are the exits? / Flow rate at North exit? / Egress / Bottlenecks        | `exits_flow`                                                                                                  |
| Where is ground zero? / Blast site / Cordon / Epicentre                       | `ground_zero_cordon` / `blast_site`                                                                           |
| Where can emergency services access? / Ambulance pickup?                      | `access_for_responders`                                                                                       |
| Where can we hold evacuees? / Assembly area capacity?                         | `assembly_potential`                                                                                          |
| Possible emergency routes? / Roads for evacuation?                            | `routes` / `routes_vicinity`                                                                                  |
| Where is there space for casualty staging? / Flat area for triage? / Shelter? | `space_terrain`                                                                                               |
| Where can ambulances access? / Stretcher routes?                              | `access_egress`                                                                                               |
| Safe from the blast? / Hazards? / Wind direction?                             | `safety_hazards`                                                                                              |
| Water / power / lighting for holding area?                                    | `utilities_resources`                                                                                         |
| Distance to exits? / Flow for casualty outflow?                               | `proximity_flow`                                                                                              |
| How many hospitals? / Medical facilities?                                     | `hospitals`                                                                                                   |
| Police outposts? / Stations?                                                  | `police`                                                                                                      |
| CCTV coverage? / Cameras? / Surveillance?                                     | `cctv`                                                                                                        |
| What are the verified facts? / What can we say about the incident?            | `verified_facts_incident`                                                                                     |
| What can we say about casualties? / Evacuation status?                        | `verified_facts_casualties_evacuation`                                                                        |
| What misinformation is circulating? / Known false claims?                     | `information_environment`                                                                                     |
| Sensitivities we should avoid? / Wording context?                             | `sensitivities`                                                                                               |
| Who is the official spokesperson? / Who can speak?                            | `official_sources`                                                                                            |
| Full layout / All details / Everything about the site                         | Return combined layout slice (evacuees + exits + zones/areas) only when explicitly asked for "all" or "full". |

---

**Document version:** 1.0  
**Scenario:** C2E Bombing at Community Event  
**Use with:** `insider_knowledge` schema, `server/services/insiderService.ts`, C2E seeds and migrations.
