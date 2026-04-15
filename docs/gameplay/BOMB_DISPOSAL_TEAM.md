# Black Swan Simulations — RTS Gameplay Mechanics

## Bomb Squad / EOD Team

### Version 0.1 — Draft

---

## 1. Overview

The Bomb Squad / EOD (Explosive Ordnance Disposal) team is the smallest, most specialized team in the exercise. They have a single critical mission: find and neutralize secondary explosive devices before they detonate. Everything else — evacuating the crowd, treating casualties, managing the cordon — is someone else's job. The bomb squad's job is to prevent the next explosion.

The bomb squad operates differently from every other team. They are methodical where others are urgent. They are slow where others are fast. Their robot moves at 0.3 m/s. Their render-safe procedures take minutes. But the consequences of their work are disproportionate — finding a secondary device before it detonates can save 20-30 lives. Missing it can wipe out the CCP, the assembly point, or the responders at an exit.

The bomb squad's most important contribution in Phase 0-1 is not physical — it's **advisory**. Their warning to the IC about secondary device risk should shape how every other team operates.

---

## 2. Units

Units are **unlimited** but the bomb squad should exercise restraint — over-deploying EOD technicians means more people in proximity to potential devices.

| Unit                                 | Speed                        | Abilities                                                                                        |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| EOD Technician                       | 0.8 m/s (in protective gear) | Visual Sweep, Investigate Item, Deploy Robot, Render Safe, Advise IC, Mark Exclusion Zone        |
| EOD Robot (deployed from technician) | 0.3 m/s                      | Remote Visual Inspection, Camera Feed (triggers scene photo), Remote Disruption, Approach Device |

The robot is controlled by the EOD technician remotely. When the robot is deployed, the technician stays at a safe distance and operates it. If the technician is reassigned or moves away, the robot stops.

---

## 3. Equipment

Equipment is **unlimited**. Placed through units.

| Equipment             | Placed By                 | Time to Place               | Effect                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exclusion Zone Marker | EOD tech on location      | 1s                          | Marks a radius around a suspicious item (configurable, default 100m). All other units receive a warning when entering this zone. Does not physically block — it's an advisory marker. Other teams should respect it, but the game doesn't force them to. |
| Disruption Device     | EOD tech or robot at item | 1s to place, 5s to activate | Renders a confirmed device safe through controlled disruption (water jet or similar). Single use per device. Must be positioned precisely — the robot places it.                                                                                         |
| Blast Blanket         | EOD tech at item          | 3s                          | Placed over a suspected device to reduce fragmentation if it detonates while awaiting render-safe. Does NOT neutralize — it mitigates. Buys time while the robot is deployed or the disruption device is prepared.                                       |
| "All Clear" Marker    | EOD tech on location      | 1s                          | Marks an area or item as checked and cleared. Visible to all teams. Indicates that the bomb squad has swept this location and found no threat.                                                                                                           |

---

## 4. Abilities

### 4.1 Visual Sweep

The foundational bomb squad activity. An EOD technician moves through an area conducting a systematic visual inspection for items that are out of place, suspicious, or consistent with a concealed device.

**Exterior sweep** follows priority order:

1. Assembly point area (highest civilian concentration)
2. CCP area (medical infrastructure and personnel)
3. Responder approach routes (paths other teams are using)
4. Building exterior around active exits
5. Parked vehicles near the building
6. Street furniture (bins, planters, benches, utility boxes)

**Interior sweep** (when authorized, after fire team declares an area structurally safe):

1. Corridors being used for evacuation
2. Areas near the blast seat (secondary device may be placed to target investigators)
3. Public access areas (restrooms, lobbies, stairwells)

Each area scanned takes 30-60 seconds. The technician visually inspects concealment points: bins, under benches, behind planters, inside parked vehicles (exterior only — peering through windows), under utility boxes.

### 4.2 Investigate Item

When the visual sweep identifies something suspicious, the technician investigates. This is where the **scene photo mechanic** activates.

The bomb squad does NOT walk up to a suspicious item. They deploy the robot.

**Investigation sequence:**

1. **Flag the item**: The technician marks it on the map and reports to the IC. "EOD: suspicious backpack on bench near Assembly Point A. Deploying robot for inspection."

2. **Deploy robot**: The robot travels from the technician's position to the item. At 0.3 m/s, this takes time — 30 meters takes 100 seconds. During this time, the IC should be considering whether to move people away from the area.

3. **Robot camera feed**: When the robot reaches the item, a **scene photo / inspection panel** opens. The player sees a photograph or detailed view of the item and its surroundings. They must assess:
   - Is this consistent with an explosive device? (wires, phone attached, unusual weight, chemical smell indicators)
   - Is this likely benign? (shopping bag with groceries visible, clearly marked delivery package)
   - What's the concealment context? (hidden behind a bin, placed under a bench, inside a locked container)

4. **Assessment decision**: The player chooses:

| Assessment                                  | Meaning                                               | Action                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Not suspicious — clear                      | Item is benign. Mark as cleared. Move on.             | Place "All Clear" marker. Resume sweep.                                                                |
| Suspicious — cordon and investigate further | Item may be a device but confirmation needed.         | Place exclusion zone marker. Request IC to clear the area. Continue robot inspection with more detail. |
| Confirmed IED — render safe                 | Item is positively identified as an explosive device. | Cordon. Evacuate the radius. Begin render-safe procedure.                                              |

If the player clears an item that is actually a device — it detonates later. If the player calls everything suspicious, the operation grinds to a halt while every backpack gets a 100m cordon.

### 4.3 Render Safe

When a device is confirmed, the bomb squad neutralizes it. Options:

**Remote disruption** (preferred):

- The robot places the disruption device against the IED
- 5-second activation
- Device is neutralized without human approach
- Safest option
- Takes 3-5 minutes total (robot travel + positioning + activation)

**Manual approach in bomb suit** (if robot cannot reach or disruption device cannot be placed remotely):

- EOD technician approaches in protective gear
- Very slow (0.5 m/s in full bomb suit)
- Higher risk — the technician is within the blast radius
- Used only when remote methods have failed
- Takes 5-10 minutes

**Controlled detonation** (if device is too complex for disruption):

- Evacuate a wider area (200m+)
- Detonate the device in place using a controlled charge
- Safe for personnel but causes additional damage, noise, and panic
- The crowd sim reacts — panic spike for all pedestrians within hearing range
- Used as last resort

### 4.4 Advise IC

The bomb squad's advisory role is as important as their physical one. Key advisories:

- **Phase 0**: "IC, EOD advises: assume secondary device until proven otherwise. Recommend secondary device sweep of evacuation routes and assembly points before large-scale deployment."
- **During sweep**: "IC, EOD has cleared the assembly point area. Moving to CCP perimeter."
- **Item found**: "IC, suspicious item near Exit 1. Recommend closing Exit 1 and 100m clearance until assessed."
- **Device confirmed**: "IC, confirmed IED at [location]. Request immediate evacuation of 100m radius. Beginning render-safe procedure. ETA to all-clear: [X] minutes."
- **All clear**: "IC, all priority areas swept and cleared. No additional devices found."

If the bomb squad doesn't communicate, the IC and other teams don't know where is safe and where isn't. The advisory function is scored.

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- **Advise IC on secondary device risk** — the most important Phase 0 action for any team
- Begin planning sweep priorities based on the map: where are exits, where will assembly points likely be placed, where are vehicles parked, where is street furniture
- Do NOT deploy to the building — wait for authorization

### Phase 1 — Command & Control (T+0 to T+2min)

- Request IC authorization for exterior sweep
- Prioritize sweep plan: assembly point area first (once placed), then CCP area, then approach routes
- Deploy first technician toward the assembly point area (or await its placement)
- Continue advising IC: "EOD recommends all teams be aware of secondary device risk when selecting locations for CCP and assembly point."

### Phase 2 — Initial Assessment (T+2min to T+5min)

- Begin exterior sweep of assembly point area
- Sweep CCP area
- Report cleared areas: "Assembly point area clear. CCP area clear."
- Begin sweeping approach routes and exit perimeters
- Flag any suspicious items — do not investigate alone, deploy robot

### Phase 3 — Active Operations (T+5min to T+15min)

- Continue systematic exterior sweep
- Investigate flagged items (robot deployment, scene photo assessment)
- Clear items and place "All Clear" markers
- Report sweep progress to IC regularly
- **Reach Exit 1 perimeter by T+14:00** — the secondary device timer in many scenarios is T+18:00. Finding it before T+15:00 gives time to render safe. Finding it after T+16:00 may not.
- Communicate findings: "EOD: abandoned backpack near bench — investigating. Parked van near Exit 1 — requesting police run plates."

### Phase 4 — Complications (T+15min to T+25min)

- **Secondary device discovered**: Execute render-safe procedure. Communicate timeline to IC. Maintain exclusion zone until all-clear.
- **Secondary device detonated** (if not found in time): Respond to the aftermath. There may be additional devices — the first secondary doesn't mean there isn't a third. Resume sweep.
- **Interior sweep**: Once fire team declares interior areas structurally safe, enter the building to sweep evacuation corridors and the blast seat area for additional devices.
- Advise IC on any new sweep requirements after cordon adjustment or facility relocation.

### Phase 5 — Resolution (T+25min to T+35min)

- Complete interior sweep of accessible areas
- Re-sweep any relocated assembly point or CCP areas
- Provide formal all-clear to IC: "All priority areas swept. No additional devices found."
- Support crime scene handover — the blast seat is evidence, the secondary device (rendered safe) is evidence
- Document: device type, location, concealment method, render-safe method used

---

## 6. The Scene Photo / Inspection Mechanic

When the bomb squad robot reaches a suspicious item, the player sees a detailed view. In the prototype, this is a **card-based assessment panel**. In the full version, this uses **Google Street View** with trainer-placed pins or **trainer-uploaded photos** of the actual exercise location.

**The assessment panel shows:**

- Photo or description of the item and its surroundings
- Context clues: item placement, concealment method, proximity to crowds
- Observable features: wires visible, phone attached, weight/bulk inconsistent with stated contents, chemical indicators

**The player must decide:**

- Is this a threat or benign?
- If suspicious, what's the approach? (robot further inspection, cordon and disrupt, or controlled detonation)
- What's the impact on the operation if they cordon this area?

**Scoring checks:**

- Did the player correctly identify the real device among decoys?
- Did the player waste excessive time on benign items?
- Did the player use the robot (correct) or walk up manually (incorrect unless robot unavailable)?
- Did the player communicate findings to the IC promptly?

---

## 7. Cross-Team Dependencies

| Bomb Squad Needs                                       | From Which Team     | Mechanism                                                     |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------- |
| Authorization to deploy and sweep                      | IC                  | "IC, EOD requests authorization for exterior sweep."          |
| Assembly point and CCP locations (to prioritize sweep) | Evacuation, Medical | "Where are people gathering? We need to sweep there first."   |
| Vehicle registration check                             | Police              | "Police, can you run plates on the white van near Exit 1?"    |
| Structural clearance for interior sweep                | Fire/Rescue         | "Fire, is the main corridor structurally safe for EOD entry?" |
| Area clearance when device found                       | IC → All teams      | IC orders all teams to clear the exclusion zone.              |

| Other Teams Need from Bomb Squad    | Mechanism                                                   |
| ----------------------------------- | ----------------------------------------------------------- |
| Secondary device advisory (Phase 0) | EOD advises IC, IC communicates to all                      |
| Cleared areas confirmation          | "All Clear" markers on map. "Assembly point area is clear." |
| Device found — area evacuation      | EOD reports, IC orders clearance                            |
| Render-safe timeline                | "ETA to all-clear: 5 minutes."                              |
| Final all-clear declaration         | "All priority areas swept. No additional devices."          |

---

## 8. Scoring

### 8.1 Live Scoring (Heat Meter)

| Trigger                                                        | Heat Impact        | Classification                      |
| -------------------------------------------------------------- | ------------------ | ----------------------------------- |
| Secondary device advisory issued in Phase 0-1                  | Cooldown +0.3      | Good                                |
| Systematic sweep in correct priority order                     | Cooldown +0.3      | Good                                |
| Device found and rendered safe before timer                    | Cooldown +0.3      | Good                                |
| Failed to advise IC on secondary device risk                   | +2 (contradiction) | Missed critical advisory role       |
| Manual approach to suspicious item without robot               | +2 (contradiction) | Violated safety doctrine            |
| Device missed — detonation occurs                              | +3 (rejected)      | Critical failure                    |
| Excessive false positives (3+ items cordoned that were benign) | +1 (vague)         | Over-cautious, disrupted operations |
| Cleared a real device as benign                                | +3 (rejected)      | Critical assessment failure         |
| Sweep progress not communicated to IC                          | +0.5 (no_intel)    | Communication failure               |

### 8.2 Resource Proportionality

**Adequate**: 1-2 technicians conducting a systematic sweep. Robot deployed for suspicious items. Methodical but not slow. Priority areas covered before the secondary device timer.

**Excessive**: 4+ technicians sweeping every square meter. Every benign item gets a full robot investigation. Multiple exclusion zones disrupting operations for items that were clearly not threats.

**Insufficient**: No sweep conducted. Or sweep started but didn't cover priority areas in time. Or found the device but spent too long on benign items first.

### 8.3 End-of-Exercise Scoring (AAR)

| Metric                    | Exemplary                              | Good                    | Adequate                             | Poor                                          | Critical Failure              |
| ------------------------- | -------------------------------------- | ----------------------- | ------------------------------------ | --------------------------------------------- | ----------------------------- |
| Secondary device advisory | Issued at T+0, shaped IC decisions     | Issued in Phase 1       | Issued in Phase 2                    | Late or vague                                 | Never issued                  |
| Sweep completion          | All priority areas before device timer | Most priority areas     | Key areas covered                    | Partial coverage                              | Minimal sweep                 |
| Device discovery          | Found with time to render safe         | Found with tight margin | Found after detonation window (luck) | Missed initially, found after detonation      | Never found                   |
| Render-safe execution     | Remote disruption, no personnel risk   | Remote with minor delay | Manual approach required             | Controlled detonation                         | Failed render-safe            |
| Assessment accuracy       | All items correctly classified         | 1 false positive        | 2-3 false positives                  | Multiple false positives, operation disrupted | Real device cleared as benign |
| Robot usage               | Robot used for all approaches          | Robot used for most     | Robot used for confirmed items only  | Manual approaches common                      | No robot deployed             |
| Communication             | Regular updates, all findings reported | Most findings reported  | Key findings reported                | Sporadic                                      | Minimal communication         |
| Resource proportionality  | Adequate                               | Minor excess/deficit    | Mixed                                | Significant imbalance                         | Gross mismatch                |

---

## 9. Difficulty Scaling

| Parameter               | Easy            | Medium                                  | Hard                                                  |
| ----------------------- | --------------- | --------------------------------------- | ----------------------------------------------------- |
| Secondary device        | None            | 1 (clear concealment, obvious features) | 1 (well-concealed, ambiguous features)                |
| Device timer            | N/A             | 20 min (generous)                       | 15 min (tight)                                        |
| Decoy items             | 0               | 2-3                                     | 5+                                                    |
| Sweep area size         | Small perimeter | Medium                                  | Large with many concealment points                    |
| Interior sweep required | No              | Optional                                | Yes (after fire clears structure)                     |
| Device complexity       | N/A             | Standard (robot disruption works)       | Complex (may need controlled detonation)              |
| Multiple devices        | No              | No                                      | Yes (after first is rendered safe, second discovered) |

---

## 10. Doctrinal References

- **USFA Guidelines on Secondary Explosive Devices**: Search-before-entry, anticipate secondary device at every suspicious incident
- **FM 19-10 Chapter 20 (Bomb Threats)**: Two-person team search methodology, four-level room sweep, outside-in / bottom-up search order
- **ATF Bomb Search Techniques**: Systematic area sweep, concealment point identification
- **OSHA Secondary Explosive Device Guide**: Zone management, exclusion areas, responder safety
- **ERG IED Safe Stand-Off Distance Tables**: Evacuation distances by device size
- **NIST/DOJ Guide for Explosion and Bombing Scene Investigation**: Post-blast evidence preservation
- **UK MOD EOD Procedures**: Render-safe methodology, robot employment, manual approach protocols

---

_This document covers the Bomb Squad / EOD Team only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
