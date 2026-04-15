# Black Swan Simulations — RTS Gameplay Mechanics

## Fire / Rescue Team

### Version 0.1 — Draft

---

## 1. Overview

The Fire / Rescue team enters the building, assesses structural conditions, finds and extracts casualties, clears blocked routes, and provides critical intelligence to every other team. They are the eyes inside the building — without them, the interior remains a black box under fog of war.

The fire team operates in the most dangerous environment of any team. They are inside a compromised structure with potential secondary devices, structural instability, fire or smoke, and a panicked crowd. Every minute they spend inside is a calculated risk. The IC authorizes their entry, and the fire team must balance thoroughness (finding every casualty, assessing every corridor) against exposure (the longer they're inside, the higher the risk from collapse, secondary device, or fatigue).

---

## 2. Units

Units are **unlimited**. The game evaluates proportionality.

| Unit            | Speed                           | Abilities                                                                                             |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Rescue Officer  | 1.4 m/s (1.0 m/s when carrying) | Structural Assessment, Search, Extract Casualty, Breach, Deploy Equipment                             |
| Search Dog Team | 1.8 m/s                         | Enhanced Search (larger detection radius for casualties behind walls or under debris), Cannot extract |

Rescue officers are the workhorse unit. They can do everything but move slower when carrying a casualty. Search dog teams move faster and have a wider search radius but cannot extract — they find, a rescue officer must follow up.

---

## 3. Equipment

Equipment is **unlimited**. Placed through units.

| Equipment              | Placed By                            | Time to Place            | Effect                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural Prop        | Rescue officer on location           | 8s                       | Stabilizes a compromised structural section. Prevents the collapse inject from affecting that zone. Buys time for evacuation or extraction in structurally questionable areas.                                                                       |
| Breaching Kit          | Rescue officer at wall               | 10s (single use per kit) | Creates a new exit in a wall segment. A new physics gap appears in the building polygon. Used when existing exits are blocked and an alternative escape route is needed. Powerful but limited by opportunity — breaching the wrong wall wastes time. |
| Ladder                 | Rescue officer at building exterior  | 5s                       | Creates an external exit from an upper floor window or opening. Slow throughput (~5 people/minute) but bypasses compromised stairwells entirely. Requires exterior access and a window/opening at the target floor.                                  |
| Lighting Rig           | Rescue officer inside building       | 3s                       | Illuminates an area. Creates **persistent visibility** in a radius — fog of war is lifted permanently at this location even after the unit moves away. Force multiplier for the evacuation team, who can monitor flow without deploying a marshal.   |
| Thermal Imaging Camera | Rescue officer (carried, not placed) | 0s (passive)             | Increases the unit's casualty detection radius. Can detect heat signatures behind thin walls or under light debris. Not placed — it's a carried tool that enhances the unit.                                                                         |

### Lighting Rig Strategy

The fire team has unlimited lighting rigs but each takes 3 seconds to place. The strategic question is where to put them:

- **Corridor junctions**: The evacuation team can see flow patterns and congestion without deploying a marshal. High value.
- **Near the blast seat**: All teams can see the most dangerous area remotely. Reduces the need for units in the danger zone.
- **Stairwell entrances** (multi-storey): Evacuation team can monitor stairwell queue depth from the floor view.
- **Exit approaches**: Useful for monitoring exit throughput.

Placing a rig at every corner is excessive — it takes time and the team should be searching, not decorating. A few rigs at critical decision points is adequate.

---

## 4. Abilities

### 4.1 Structural Assessment

The fire team is the only team qualified to assess structural integrity. When a rescue officer enters an area, they can assess the structural condition:

| Assessment Result | Meaning                                                      | Effect                                                                            |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Sound             | Area is structurally safe. Normal operations permitted.      | Area cleared for evacuation traffic and other teams.                              |
| Compromised       | Area shows damage but is stable for now. Limited operations. | Recommended: limit personnel, no heavy equipment, monitor for changes.            |
| Dangerous         | Active structural deterioration. Collapse risk.              | Area should be evacuated. Only essential rescue operations with time limits.      |
| Impassable        | Area has collapsed or is inaccessible.                       | No entry. Mark as closed. Casualties inside require USAR (beyond exercise scope). |

Assessments are reported to the IC, who communicates them to the evacuation team. The evacuation team uses this information to route or reroute crowd flow — never send pedestrians through a "dangerous" corridor.

The fire team can also request an **external structural survey** from outside the building before entry. This provides a preliminary assessment of visible damage without risking entry.

### 4.2 Search

Systematic movement through the building to find casualties, trapped persons, and hazards. The search pattern follows doctrine:

- **Primary search**: Rapid sweep of all accessible areas. Move fast, identify casualties and major hazards. Don't stop to extract — mark locations and report. The goal is a complete picture as quickly as possible.
- **Secondary search**: Thorough room-by-room check. Slower, more detailed. Check behind doors, under debris, in concealed spaces. This is where the search dog team excels.

Fog of war lifts as the unit moves through areas. Discovered casualties appear as markers on the map visible to the medical team (if they have visibility) and reported to the IC.

### 4.3 Extract Casualty

When a casualty is discovered who cannot self-evacuate:

- **Ambulatory casualty** (walking wounded): The rescue officer directs them toward the nearest open exit. If a marshal is nearby, the marshal takes over guidance. The rescue officer continues searching.
- **Non-ambulatory casualty** (cannot walk): The rescue officer picks them up. Unit speed drops to 1.0 m/s (or 0.5 m/s on stairs). The officer carries them to the nearest exit, then either to the CCP or hands off to a medic.
- **Trapped casualty** (under debris): Requires extraction work — a timed ability (30-60 seconds depending on debris severity). The officer must stay at the location and perform the extraction before carrying the patient out.

Each extraction ties up a rescue officer for minutes. The trade-off: every officer extracting is an officer not searching. The fire team must decide — push forward to find more casualties, or stop and extract the ones they've found. In a mass casualty scenario, finding 10 casualties quickly and reporting their locations so multiple officers can extract simultaneously is more efficient than one officer doing find-and-extract sequentially.

### 4.4 Breach

Create a new opening in a wall to establish an alternative exit route. The breaching kit is placed against a wall edge on the building polygon, and after 10 seconds of work, a new physics gap appears.

Use cases:

- All normal exits on one side of the building are compromised. Breach a wall on the opposite side.
- A corridor is blocked by debris but breaching a wall bypasses the blockage.
- Upper floor: breach an exterior wall to allow ladder evacuation from a floor with compromised stairwells.

Breaching the wrong wall is a significant waste — the kit takes 10 seconds to use and creates a gap that may not be where the crowd needs it. The fire team should assess where the crowd IS before deciding where to breach.

### 4.5 Ladder Deployment

External evacuation from upper floors. A ladder placed against the building exterior at a window or opening creates a slow but viable exit:

- Throughput: ~5 people per minute (vs. 40-60 per minute for a stairwell)
- Requires a rescue officer at the base to assist
- Only works for ambulatory people — non-ambulatory casualties cannot descend a ladder

Use case: Floor 3 stairwells are both compromised or overloaded. 15 people are trapped on Floor 3. A ladder at an exterior window provides a way out that bypasses the stairwell entirely.

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- Stage at RVP. Do NOT enter the building without IC authorization.
- Identify potential entry points and approach routes
- Prepare for external structural assessment

### Phase 1 — Command & Control (T+0 to T+2min)

- Position a unit at the building exterior for external structural assessment
- Report visible damage to IC: "Structural damage visible on east side. No visible fire. Exit 2 appears obstructed."
- Communicate readiness: "Fire staged and ready. Awaiting authorization for entry."
- Plan entry route — which side of the building, which entry point, initial search direction
- **Do NOT enter without IC authorization** — this is a doctrinal requirement. Freelancing into an unassessed structure with a potential secondary device risks losing responders.

### Phase 2 — Initial Assessment (T+2min to T+5min)

- IC authorizes limited entry (should be a small team for reconnaissance)
- Enter the building. Fog of war lifts along your path.
- Conduct primary search of ground floor main areas
- Discover and report: casualty locations, structural conditions, exit status, corridor conditions, crowd density
- Report METHANE update to IC: "Fire inside. East corridor collapsed. 3 casualties near Exit 2. Main corridor congested. West corridor clear and underused."
- Place lighting rig at main corridor junction
- Begin casualty extraction for immediately accessible patients

### Phase 3 — Active Operations (T+5min to T+15min)

- **Search and rescue in full operation.** Multiple units inside covering different areas.
- Primary search expanding to all accessible areas and upper floors (multi-storey)
- Casualty extraction — prioritize by severity and accessibility
- Structural assessment of each new area entered — report to IC
- Place structural props in compromised areas where personnel must operate
- Place lighting rigs at strategic locations
- Coordinate with evacuation team: "East corridor unsafe for evacuation traffic. West corridor is clear."
- Coordinate with medical team: "3 red casualties coming to CCP from east wing. ETA 4 minutes."
- Monitor structural warnings — if the east wing collapse clock is ticking, track the timeline

### Phase 4 — Complications (T+15min to T+25min)

- **Structural collapse**: Withdraw ALL units from the affected area immediately. Account for every officer. If a unit was in the collapse zone, initiate rescue-for-rescuer protocol.
- **Secondary device**: Withdraw from areas near the device. Report any suspicious items discovered during search.
- **Upper floor rescue**: Deploy ladders if stairwells are compromised. Coordinate with evacuation team for floor-level management.
- **Elevator rescue**: If elevator is trapped, commit a unit for the 10-15 minute rescue procedure.
- **Fatigue management**: Units inside for 15+ minutes should be rotated. Fresh units enter from RVP.

### Phase 5 — Resolution (T+25min to T+35min)

- Conduct secondary search (thorough) of all accessible areas
- Mark searched areas as clear
- Mark collapsed/inaccessible areas — these require USAR, beyond exercise scope
- Recover equipment (lighting rigs, unused structural props)
- Final structural assessment to IC: "All accessible areas searched and cleared. East wing collapsed, inaccessible. Stairwell A compromised. Remainder of building stable but should not be reoccupied without full engineering assessment."
- Support scene handover — building is now a crime scene

---

## 6. Cross-Team Dependencies

| Fire Team Needs                                         | From Which Team | Mechanism                                                                        |
| ------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| Entry authorization                                     | IC              | "IC, fire requests authorization for limited entry."                             |
| Cordon location (for approach route planning)           | Police          | "Police, which ACP should we use for building approach?"                         |
| Secondary device intelligence                           | Bomb Squad      | "EOD, have you swept our approach route?"                                        |
| Crowd condition information (which exits are congested) | Evacuation      | "Evacuation, which exits have the highest traffic? We'll avoid those corridors." |
| CCP location (for casualty delivery)                    | Medical         | "Medical, confirm CCP location for casualty delivery."                           |

| Other Teams Need from Fire              | Mechanism                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Structural assessments for route safety | Fire reports: "Main corridor sound. East wing dangerous."                  |
| Casualty discovery and count            | Fire reports: "3 red, 2 yellow near blast seat. Extracting first red now." |
| Interior visibility (lighting rigs)     | Lighting rigs lift fog of war for all teams at those locations             |
| Breach creating new exits               | Fire breaches a wall, new exit appears on everyone's map                   |
| Personnel status during collapse        | Fire reports: "All units accounted for after east wing collapse."          |

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

| Trigger                                                           | Heat Impact        | Classification                                       |
| ----------------------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| Systematic search with regular reports                            | Cooldown +0.3      | Good                                                 |
| Structural assessment reported before evacuation routing          | Cooldown +0.3      | Good                                                 |
| Entered building without IC authorization                         | +2 (contradiction) | Violated command structure                           |
| Entered building without structural assessment                    | +1 (prereq)        | Skipped safety prerequisite                          |
| Unit caught in structural collapse                                | +3 (rejected)      | Critical failure — ignored warning or over-committed |
| Casualties found but not reported to IC                           | +1 (vague)         | Communication failure                                |
| Extraction prioritized over search (found 1, extracted, missed 5) | +0.5 (no_intel)    | Suboptimal resource use                              |
| Lighting rig placement enables evacuation monitoring              | Cooldown +0.3      | Good                                                 |

### 7.2 Resource Proportionality

**Adequate**: 2-4 rescue officers inside for a medium building. Systematic search pattern covering all accessible areas. Extraction happening in parallel with search. Lighting rigs at 2-3 key points.

**Excessive**: 8+ officers inside a small building. Congestion in corridors from too many rescue personnel. Lighting rigs at every room. All officers extracting casualties while no one is searching further areas.

**Insufficient**: 1 officer trying to search and extract alone. No structural assessment reported. No lighting rigs — interior remains dark for other teams. Upper floors not reached.

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                   | Exemplary                                      | Good                  | Adequate                      | Poor                                 | Critical Failure              |
| ------------------------ | ---------------------------------------------- | --------------------- | ----------------------------- | ------------------------------------ | ----------------------------- |
| Entry protocol           | IC authorized, structural assessed             | IC authorized         | Entered with verbal clearance | Entered without full authorization   | Freelanced into building      |
| Search completion        | 100% accessible area searched                  | > 90%                 | > 75%                         | > 50%                                | < 50%                         |
| Casualty discovery       | All accessible casualties found                | > 90% found           | > 75% found                   | > 50% found                          | Significant casualties missed |
| Extraction efficiency    | Parallel search and extract                    | Minor delays          | Sequential (slow)             | Significant delays                   | Casualties left inside        |
| Structural reporting     | All areas assessed and reported                | Most reported         | Key areas reported            | Sporadic                             | No reporting                  |
| Lighting rig value       | Rigs at high-value points, other teams benefit | Rigs placed usefully  | Some rigs placed              | Minimal                              | No rigs placed                |
| Collapse response        | All personnel withdrawn with time to spare     | Withdrawn, close call | Most withdrawn                | Unit caught, rescued                 | Unit trapped or lost          |
| Personnel safety         | Zero injuries/exposure                         | Minor risk events     | 1-2 close calls               | Unit in danger zone when unnecessary | Responder casualty            |
| Resource proportionality | Adequate                                       | Minor excess/deficit  | Mixed                         | Significant imbalance                | Gross mismatch                |

---

## 8. Difficulty Scaling

| Parameter                                 | Easy                 | Medium                            | Hard                                 |
| ----------------------------------------- | -------------------- | --------------------------------- | ------------------------------------ |
| Building size                             | Small, simple layout | Medium, L/U-shaped                | Large, complex, multi-storey         |
| Structural risk                           | Stable               | 1 area compromised                | Progressive collapse, multiple zones |
| Casualties to find                        | 3-5                  | 8-12                              | 15+ across multiple floors           |
| Trapped casualties (need extraction work) | 0                    | 1-2                               | 4+                                   |
| Visibility inside                         | Good                 | Moderate (some dark areas)        | Poor (smoke, dust, power failure)    |
| Fire/smoke                                | None                 | Localized                         | Spreading                            |
| Stairwell condition                       | Sound                | 1 compromised                     | Both compromised                     |
| Collapse countdown                        | None                 | Warning only (no actual collapse) | Actual collapse with tight timeline  |

---

## 9. Doctrinal References

- **JESIP**: Fire service as primary search and rescue agency in building incidents
- **NIMS / ICS**: Operations section, rescue branch structure
- **UK Fire and Rescue Service Operational Guidance**: Dynamic risk assessment, structural assessment, search methodology
- **USAR (Urban Search and Rescue)**: Systematic search patterns, structural stabilization, casualty extraction
- **CFOA (Chief Fire Officers Association)**: Tactical ventilation, compartment fire behavior, structural collapse indicators
- **ISO 22315**: Mass evacuation — coordination of multi-agency building evacuation

---

_This document covers the Fire / Rescue Team only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
