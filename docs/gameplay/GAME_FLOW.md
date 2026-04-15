# Black Swan Simulations — Master Game Flow

## RTS Crisis Management Simulation

### Version 0.1 — Draft

---

## 1. Game Overview

Black Swan Simulations is a real-time strategy (RTS) crisis management training tool. Participants command responder units on a live map while a crowd evacuation simulation runs continuously underneath. The game tests multi-agency coordination, doctrinal compliance, prioritization under pressure, and adaptive decision-making.

The core principle: **the game never blocks a player from acting. It shows them what happens because they acted — or didn't.**

There are no tutorials, no forced sequences, no "you must do X before Y" gates. Teams can deploy, act, and make mistakes freely. The simulation reacts naturally. Consequences emerge from the physics, the crowd behavior, and the inject system. The AAR shows the chain of decisions that led to outcomes.

---

## 2. Scenario Setup

Before the exercise begins, the trainer configures the scenario in the War Room:

- **Building geometry**: Selected from OpenStreetMap. The building outline becomes the simulation polygon. For multi-storey scenarios, each floor is a separate polygon connected by stairwells and elevators.
- **Building population**: Number of pedestrians spawned inside (50-400+, depending on difficulty).
- **Exit configuration**: Which exits exist, which are open at start, which are pre-blocked by debris.
- **Casualty placement**: Location, severity, and observable symptoms of pre-placed casualties.
- **Hazard zones**: Blast radius, fire spread zone, structural damage zone, chemical contamination zone.
- **Inject schedule**: Time-based and condition-triggered injects with their effects.
- **Secondary device**: Location, concealment type, timer or trigger mechanism.
- **Environmental conditions**: Wind direction and speed, weather, time of day.
- **Team composition**: Which teams participate (IC, Police, Evacuation, Medical, Fire/Rescue, Bomb Squad, Media/Comms).
- **Difficulty parameters**: Panic factor, counter-flow percentage, frozen pedestrian count, inject frequency.

---

## 3. Teams and Roles

### 3.1 Team Structure

Each team controls their own units and equipment. No team can move another team's units. Cross-team support requires communication and coordination — you must ask, not take.

| Team               | Primary Mission                                                         | Unit Type                | Key Equipment                                                         |
| ------------------ | ----------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Incident Commander | Coordinate all teams, manage priorities, maintain situational awareness | None (command role)      | Forward Command Post                                                  |
| Police / Cordon    | Scene security, cordon, access control, crowd control, outer perimeter  | Police Officers          | Barriers, Tape Cordon, Road Blocks, Access Control Points             |
| Evacuation         | Crowd flow management, exit control, assembly point, accountability     | Marshals / Floor Wardens | Assembly Point Markers, Directional Signage, Megaphones               |
| Triage / Medical   | Casualty assessment, treatment, transport                               | Medics                   | CCP Tent, Treatment Areas, Ambulance Staging, Body Holding Area       |
| Fire / Rescue      | Structural assessment, search and rescue, breaching, extraction         | Rescue Units             | Structural Props, Breaching Kit, Ladders, Lighting Rigs               |
| Bomb Squad / EOD   | Secondary device sweep, render-safe, hazard assessment                  | EOD Technicians          | EOD Robot, Disruption Devices, Blast Blankets, Exclusion Zone Markers |
| Media / Comms      | Public information, media management, narrative control                 | Liaison Officers         | Media Briefing Point, Press Cordon                                    |

### 3.2 Units

Units are **unlimited**. Teams can deploy as many as they want. The game evaluates whether deployment was **adequate**, **excessive**, or **insufficient** based on outcomes, not counts.

Units spawn at the **Staging Area / RVP** (Rendezvous Point) and must travel to their assigned position at realistic speed. More units deployed means more to manage, more to track, and more potential confusion. The cost of over-deployment is time, attention, and operational clutter — not scarcity.

Each unit has:

- **Position**: Where they are on the map. They move at a defined speed.
- **State**: Deploying (traveling from RVP), Idle, Moving, Executing (performing an ability).
- **Abilities**: Actions the unit can perform (see team reference cards for specifics).
- **Visibility radius**: Fog of war lifts within this radius. The team can see crowd particles and other features near their units.
- **Fatigue**: Units deployed for extended periods (15+ minutes) have reduced effectiveness. Rotation is recommended.

### 3.3 Equipment

Equipment is **unlimited**. Teams can place as many items as they want. The game evaluates proportionality.

Equipment is placed **through units** — select a unit, select an equipment type, click the map. The unit must be at or near the placement location. Placement takes time (varies by equipment type). Once placed, equipment persists in the world independently of the unit that placed it.

Equipment is **physical** in the simulation. Barriers are Matter.js static bodies that block movement. Tents occupy space. Ambulances block road lanes. Placing equipment changes the world.

Equipment can be **destroyed or compromised** by events (secondary device detonation, structural collapse, crowd surge through tape cordon).

Some equipment requires a unit to **operate** (access control points need a stationed officer, CCP tent needs medics present, EOD robot needs an operator). Unstaffed equipment still exists physically but doesn't function.

### 3.4 The IC's Role

With unlimited resources, the IC's job is **prioritization and coordination**, not rationing:

- Designate RVP and Forward Command Post locations
- Communicate priorities to each team ("cordon first, then exits")
- Maintain overall situational awareness from team reports
- Make cross-cutting decisions (authorize building entry, order evacuations, approve assembly point relocations)
- Handle external pressure (political, media) without losing operational focus
- Maintain personnel accountability (know where all units are)

The IC has no units of their own. They operate through communication. Their effectiveness is measured by how well the teams coordinate, not by direct action.

---

## 4. Key Locations

An incident scene has distinct functional locations that should NOT overlap:

### Staging Area / Rendezvous Point (RVP)

Where all incoming units report before deployment. 200-400m from the building, vehicle-accessible, safe from all known threats. Units spawn here in the game. The IC or a staging manager directs units from the RVP to their assignments.

### Forward Command Post (FCP)

Where the IC operates. Outside the inner cordon, with observation of the scene, upwind, near an access control point. In the game, this is the IC's conceptual position — they don't need a physical marker, but placing one demonstrates organizational awareness.

### Inner Cordon

Boundary around the immediate danger zone. Only authorized responders inside. Placed by police as physical barriers and tape. Size based on threat assessment (100m for unknown device, 200-400m for confirmed VBIED). Becomes a physics barrier in the simulation — pedestrians and bystanders cannot pass.

### Outer Cordon

Wider perimeter for traffic, media, and public management. Road blocks and tape. Controls the broader area access.

### Assembly Point

Where evacuated, uninjured civilians gather. Placed by evacuation team. Must be: outside inner cordon, upwind, away from the building, not blocking emergency vehicle access, separate from the CCP. Pedestrians who exit the building route toward this marker.

### Casualty Collection Point (CCP)

Where casualties are triaged, treated, and prepared for transport. Placed by the medical team as a tent. Must be: outside inner cordon, upwind, near vehicle access for ambulances, flat ground, separate from the assembly point. Requires medics stationed to function.

### Ambulance Staging / Loading Point

Where ambulances park, receive patients, and depart for hospitals. Adjacent to CCP with clear road egress. Blocked egress means transport stops.

### Body Holding Area

Where deceased or expectant casualties are placed. Must be screened from public view — not visible from assembly point or media positions. Scoring penalty for improper placement.

---

## 5. Fog of War

The building interior is invisible to all teams at the start of the exercise. Fog of war lifts only within the **visibility radius** of deployed units. This means:

- Teams cannot see the crowd inside until they deploy units near the building
- Casualties are invisible until discovered by a unit entering the building
- Exit blockages are unknown until a unit reaches the exit
- Structural damage inside is invisible until fire/rescue enters and reports

Fog of war is **optional** — the trainer can disable it for easier scenarios. When enabled, it creates authentic information scarcity that forces teams to scout before committing.

Persistent visibility can be created by:

- Fire/Rescue lighting rigs (placed in an area, permanently lifts fog there)
- Units stationed at a position (fog lifts while they're there, returns when they leave)

---

## 6. The Simulation

### 6.1 Crowd Behavior

Each pedestrian is a physics body in the Matter.js engine that:

- Targets the nearest exit by default at spawn
- Moves at 1.4 m/s base speed, modified by panic factor
- Collides with walls, other pedestrians, barriers, and equipment
- Slows in congested areas (visible as amber/red coloring)
- Can be re-targeted to a different exit by marshal redirect, PA announcement, or directional signage
- Can be in special states: frozen (shock, speed 0), counter-flow (moving against evacuation), injured (reduced speed)

### 6.2 Crowd Problems (Without Player Intervention)

| Problem           | Behavior                                     | Consequence                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------------- |
| Nearest-exit bias | 60-80% of crowd converges on 1-2 exits       | Crush at popular exits, empty capacity at others  |
| Counter-flow      | 5-15% of population moves back into building | Friction in corridors, slowed evacuation flow     |
| Freezing          | Shocked individuals stop moving              | Physical obstacles blocking corridors and exits   |
| Herding           | People follow the group, not logic           | Reinforces congestion at already-crowded exits    |
| No redistribution | People don't switch exits when one is jammed | Congestion worsens over time without intervention |

### 6.3 Visual Indicators

| Color | Speed         | Meaning                       |
| ----- | ------------- | ----------------------------- |
| Green | > 0.8 m/s     | Moving freely                 |
| Amber | 0.3 - 0.8 m/s | Congested                     |
| Red   | < 0.3 m/s     | Jammed, crush risk, or frozen |

### 6.4 Multi-Storey

Each floor is a separate simulation polygon. Floors connect through stairwells (narrow, 0.5 m/s movement speed, ~50 persons/minute capacity) and elevators (8-12 persons/trip, 15-30 seconds/floor, can be disabled). Stairwell congestion is visible as queues backing up onto floor corridors. Phased evacuation (one floor at a time) prevents stairwell overload.

---

## 7. Inject System

Injects are scenario events that modify conditions and force teams to adapt. They come from two sources:

### 7.1 Time-Based Injects (Pre-Scheduled by Trainer)

Fire at predetermined times. Teams cannot prevent them — they can only respond.

### 7.2 Crowd-State Triggered Injects (Automatic)

Fire when the simulation reaches specific thresholds (crush duration, counter-flow count, evacuation progress, unmanaged areas). These create organic pressure that responds to how the teams are performing.

### 7.3 Nudge Injects

Fire when expected actions haven't been taken within a reasonable window. They don't block the player — they add pressure. Examples: "Control to IC: what is the status of your response?" when no command has been established; "Civilians reporting crush at main entrance" when congestion exists with no intervention.

### 7.4 Inject State Effects

Injects can modify the simulation state: mark an exit as compromised, change wind direction, disable elevators, trigger structural warnings, spawn new casualties. The teams see the inject narrative and must infer the correct action — the game doesn't tell them what to do.

---

## 8. Phase 0 — Detonation (T+0)

### Trigger

The trainer starts the exercise. The clock begins. The simulation initializes and begins running.

### Initial Inject

> **[FLASH — T+0:00] Explosion reported at [Building Name], [Address]. Reports of multiple casualties. Fire alarm activated. Cause unknown. All teams respond.**

### What Every Player Sees

- The COP map centered on the building
- The building outline (polygon) — a black box, no interior detail
- The inject banner with the flash message
- Their team's unit panel (full pool, nothing deployed)
- The comms/chat panel (empty)
- The clock (0:00 and counting)
- **No crowd visible** — fog of war active
- **No casualty pins** — undiscovered
- **No exit status** — unassessed

### What the Simulation Is Doing (Invisible to Players)

- Pedestrians are already moving toward exits
- Congestion is forming at popular exits
- Frozen pedestrians are blocking corridors
- Counter-flow individuals are moving back into the building
- Casualties are on the ground near the blast seat and Exit 2

### What Each Team Should Do

| Team       | First Action                                                            | Key Decision                                                |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| IC         | Declare command. Designate RVP. Request METHANE report.                 | Where to place RVP. What initial tasking to give each team. |
| Police     | Begin cordon planning. Determine cordon radius.                         | 100m (minimum for unknown device) or wider?                 |
| Evacuation | Identify assembly point location. Prepare scout deployment.             | Where is safe, upwind, outside cordon, vehicle-accessible?  |
| Medical    | Identify CCP location. Prepare to stage ambulances.                     | Where is safe, accessible, separate from assembly point?    |
| Fire       | Stage at RVP. Prepare for entry. Do NOT enter without IC authorization. | Which approach route? Visible fire or smoke?                |
| Bomb Squad | Advise IC on secondary device risk. Begin planning sweep priorities.    | What areas are highest priority for sweep?                  |

### Common Mistakes

| Mistake                                                          | Consequence                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Evacuation rushes all marshals to exits without scout assessment | Marshals arrive at blocked exits, wasted time, no information      |
| No cordon before crowd starts exiting                            | Pedestrians scatter, counter-flow re-entry, bystanders approach    |
| Medical sets up CCP inside inner cordon                          | CCP in danger zone, secondary device risk                          |
| Fire self-deploys into building without authorization            | No structural assessment, secondary device risk, IC loses track    |
| IC doesn't establish command or designate RVP                    | Teams freelance, vehicles congest scene, no coordination structure |
| Bomb squad advice on secondary device ignored                    | Assembly point or CCP placed in unswept area                       |

### Transition to Phase 1

Phase 0 transitions to Phase 1 when the first teams begin deploying units and establishing infrastructure. This is typically within 15-30 seconds of the exercise starting. There is no hard boundary — Phase 0 is the momentary "what just happened?" before action begins.

---

## 9. Phase 1 — Establish Command & Control (T+0 to T+2min)

### Purpose

Establish the organizational structure that everything else depends on. Command, cordon, staging, CCP, assembly point. Structure before action.

### IC Actions

- **Declare command** (T+0:00 to T+0:15): Broadcast to all teams. If no one declares command within 90 seconds, a nudge inject fires.
- **Designate RVP** (T+0:15 to T+0:30): Place marker on the map. All units spawn here. Location matters — too close is dangerous, too far delays response.
- **Request METHANE** (T+0:30 to T+1:00): Structured information request. Most fields are "unknown" at this point. The IC acknowledges what they don't know and assigns teams to find out.
- **Initial tasking** (T+0:30 to T+1:30): Communicate priorities to each team. "Police: cordon. Evacuation: hold for cordon, then scout exits. Medical: CCP. Fire: stage and prepare. EOD: advise on secondary."

### Police Actions

- **Decide cordon radius**: 100m minimum for unknown device. Larger is safer but takes longer and disrupts more.
- **Deploy officers to cordon positions**: Units travel from RVP to cordon line.
- **Place barriers**: Physical barriers become Matter.js static bodies. Tape cordon is faster but high-panic pedestrians push through it.
- **Establish access control points**: Managed openings in the cordon for emergency vehicles and authorized personnel. Requires a stationed officer to function.

### Evacuation Actions

- **Select assembly point location**: Coordinate with police (outside cordon), medical (separate from CCP), and IC. Check wind direction.
- **Place assembly point marker**: Exited pedestrians begin routing toward it. Pedestrians already outside start converging.
- **Deploy 1-2 scouts**: Marshals sent to the nearest exits to assess conditions. Fog lifts on arrival — the first real information about what's happening inside.

### Medical Actions

- **Place CCP tent** (10-second setup): Location is critical. Outside inner cordon, upwind, near vehicle access, separate from assembly point.
- **Stage ambulances**: On a road near the CCP with clear egress route to hospitals.
- **Decide screening approach**: Send a medic to the assembly point for walking wounded screening, or hold all medics at CCP.

### Fire / Rescue Actions

- **Stage at RVP**: Vehicles and personnel ready. Do not enter the building.
- **External assessment**: Position a unit at the building exterior to observe — smoke, structural damage, exit conditions.
- **Communicate readiness to IC**: "Fire staged and ready. Awaiting authorization for entry."

### Bomb Squad Actions

- **Advise IC on secondary device**: "Recommend secondary device sweep of evacuation routes and assembly points before committing large numbers of responders."
- **Plan sweep priorities**: Identify exterior concealment points — bins, planters, vehicles, lockers.

### Cross-Team Coordination Points

| Need                                                     | Teams                        | Failure Consequence                                  |
| -------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Cordon location affects CCP and assembly point placement | Police → Medical, Evacuation | Infrastructure placed inside the danger zone         |
| RVP location for all unit spawning                       | IC → All                     | Units deploy to random locations, vehicle congestion |
| Fire entry authorization                                 | Fire → IC                    | Unauthorized entry, loss of command structure        |
| Secondary device warning                                 | EOD → IC → All               | Teams set up in unswept areas                        |
| Assembly point and CCP must be separate                  | Evacuation → Medical         | Evacuees overrun triage area                         |

### What the Map Shows at End of Phase 1

**Well-coordinated**: RVP placed, cordon in progress, assembly point placed, CCP placed, scouts approaching building, fire staged at RVP, comms active.

**Poorly coordinated**: No RVP, partial cordon, no assembly point, medical running toward building, fire already inside, comms silent.

### Nudge Inject (T+2:00 if structure not established)

> "Control to IC: Multiple 999/911 calls reporting explosion at [building]. Callers describe people running from the building. What is the status of your response?"

---

## 10. Phase 2 — Initial Assessment (T+2min to T+5min)

### Purpose

First units arrive at the building. Fog of war begins lifting. Ground truth replaces assumptions. The teams discover that the situation is worse, different, or more complex than expected.

### What the Simulation Has Been Doing

The crowd has been moving for 2 minutes with zero guidance:

- Exit 1 (main entrance): Dense cluster of 120 pedestrians. 80 have exited. Remaining are red/amber — crush forming.
- Exit 2 (east, near blast): Blocked by debris. 30 pedestrians stuck, milling around the obstruction.
- Exit 3 (south): Light traffic, 15 exited. Clear and fast but underused.
- Exit 4 (west, service): Zero traffic. Civilians don't know it exists.
- Near blast seat: 8-12 frozen pedestrians blocking a corridor.
- Counter-flow: 5-6 pedestrians moving back into the building.

### Discovery Sequence

**Evacuation scouts arrive at exits**: Fog lifts. The team sees congestion at Exit 1, the blocked Exit 2, the underused Exit 3. They now have the core information: the exits are imbalanced and Exit 2 is unusable.

**Fire team external assessment**: Visible structural damage on east side. Exit 2 debris confirmed from outside. No visible fire (scenario-dependent). Fire reports to IC — this is the first real METHANE update.

**Police cordon meets the crowd**: Pedestrians exiting the building reach the cordon. If an assembly point exists, they route there. If not, they accumulate at the barriers.

**Medical sees walking wounded**: Evacuees arriving at the assembly point include people with minor injuries. The medical team must decide whether to screen them or hold for serious casualties.

### First Injects

**T+2:30 — Debris confirmation (time-based)**

> "Security guard who escaped reports: the east emergency exit is completely blocked. Large section of ceiling collapsed across the corridor. At least 3 people trapped under debris."

Confirms Exit 2 unusable. Reveals trapped persons (fire/rescue target). First casualty estimate.

**T+3:00 — Congestion warning (crowd-state triggered, if Exit 1 crush sustained)**

> "Reports from civilians exiting the main entrance: people are being crushed. Several have fallen."

Forces immediate evacuation team response. Crush = injuries from the crowd itself.

**T+3:30 — Public pressure (time-based)**

> "Police switchboard: high volume of 999 calls. Family members converging on [street]. Local media satellite truck spotted."

Pressures police (outer cordon), IC (public information), media/comms team.

### Critical Decisions

**Decision 1 — Redirect the crowd (Evacuation)**

Exit 1 is crushing, Exit 3 is empty. The team must deploy marshals inside to redirect traffic. Options include PA announcement, directional signage, marshal at corridor junction, or temporarily closing Exit 1 to let the crush clear.

Temporarily closing a crushing exit is counterintuitive but correct doctrine: stop inflow, clear the crush, reopen with managed flow.

**Decision 2 — Authorize building entry (IC)**

Fire is requesting entry. The IC weighs structural risk, secondary device risk, trapped persons, and crowd needs. Correct answer: limited entry — small team, ground floor, reconnaissance and immediate life-saving only, withdraw if suspicious item encountered.

**Decision 3 — Begin exterior sweep (IC / Bomb Squad)**

Authorize bomb squad to sweep the assembly point, CCP, approach routes, and exit perimeters. Each check takes time. The sweep runs in parallel with everything else.

**Decision 4 — Walking wounded management (Medical)**

Split resources: screening medic to assembly point for walking wounded, remaining medics at CCP for serious casualties about to arrive from fire/rescue extraction.

### Fire Team Inside (T+3:00 to T+5:00)

The fire team enters and discovers interior conditions. They report back — this is the information that triggers cascading actions across all teams:

- Main corridor to Exit 1: passable but heavily congested, multiple shocked persons blocking flow
- East corridor to Exit 2: collapsed, 3 confirmed casualties
- West corridor to Exits 3 and 4: clear, underused
- Blast seat area: significant damage, casualties visible, structural integrity questionable

This single report triggers: evacuation redirect toward west corridor, medical preparation for incoming casualties, IC decision on east wing risk, bomb squad caution about blast seat area.

### Nudge Inject (T+5:00 if teams haven't adapted)

> "Civilian social media post going viral: shaky video of people being crushed at the main entrance. Caption: 'WHERE ARE THE EMERGENCY SERVICES?' Video has 50,000 views."

---

## 11. Phase 3 — Active Evacuation & Triage (T+5min to T+15min)

### Purpose

The sustained operation. Every team is active simultaneously. The crowd is being managed. Casualties are being extracted. The cordon is holding. Injects keep coming. This phase tests sustained multi-tasking under pressure.

### Evacuation Team

**Continuous monitoring and repositioning**: The crowd's behavior shifts as exits fill and empty. Marshals must be repositioned as congestion points move. Static deployment is not enough — the team must read the simulation and move resources to where problems are forming.

**Exit throughput balancing**: Each exit has different flow. The team monitors exit flow rates and deploys support to exits approaching their limit.

**Counter-flow management**: Counter-flow pedestrians deep inside the building disrupt corridor throughput. Options: marshal intercept, one-way barrier (request police), or accept the disruption.

**Assembly point operations**: 100+ evacuees gathered. Marshal maintains headcount, directs walking wounded to medical screening, prevents people from leaving or re-entering.

### Medical Team

**Casualty surge (T+6:00 to T+12:00)**: Fire/rescue begins extracting casualties. Flow increases from 1 at T+6:00 to 4-5 at T+10:00 to a wave from the blast seat at T+12:00. By T+12:00, the CCP has received 12-15 casualties.

**Triage mechanic**: When a medic interacts with a casualty, observable signs are presented (breathing, pulse, consciousness, visible injuries, mobility, bleeding). The player applies a triage tag (red/yellow/green/black) based on START/SALT protocol. The game evaluates whether the tag matches the casualty's actual severity.

| Triage Error                    | Consequence                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| Red tagged Yellow               | Patient deteriorates from delayed treatment. May become Black. |
| Yellow tagged Red               | Treatment resources wasted on lower-priority patient.          |
| Green tagged Red                | CCP clogged with minor cases.                                  |
| Survivable patient tagged Black | Preventable death. Most severe scoring penalty.                |

**Transport**: Ambulances have limited capacity and each hospital trip takes 10-15 minutes round trip. The medical team prioritizes which patients get transported first. Hospital capacity is finite — Hospital A may fill up, forcing longer trips to Hospital B.

### Fire / Rescue Team

**Search and rescue**: Systematic movement through the building discovering casualties and trapped persons. Walking wounded are directed to exits. Non-ambulatory casualties require a unit to carry them (0.5 m/s).

**Structural assessment**: As the team moves through, they report structural conditions. Compromised areas are flagged so evacuation avoids them.

**Lighting rigs**: Placed at corridor junctions to create persistent visibility. Force multiplier — the evacuation team can monitor flow without deploying a marshal. Limited quantity; placement location matters.

### Police Team

**Cordon maintenance**: Family members, media, and bystanders apply increasing pressure. Access control points need stationed officers. Gaps in the cordon allow breaches.

**Counter-flow prevention**: Evacuees at the assembly point trying to go back for family. Police intercept and redirect, or they breach the cordon.

**Crowd control support**: May be requested at Exit 1 for physical crowd management beyond what marshals can do.

### Bomb Squad

**Systematic exterior sweep** in priority order:

1. Assembly point area (highest civilian concentration)
2. CCP area (high-value medical infrastructure)
3. Approach routes (responders using these)
4. Building exterior around exits
5. Parked vehicles

Each item found requires assessment. Most are innocent (dropped backpack, parked van, municipal bin). Each forces a decision: investigate thoroughly (slow but safe) or mark and move on (fast but risky). Findings are reported to IC who decides whether to alter operations.

### Inject Tempo

Phase 3 has the highest inject density:

| Time    | Inject                                                                                                      | Pressure                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| T+6:00  | "Hospital A at 80% capacity. Can accept 4 more critical patients."                                          | Transport constraints. Medical must plan for Hospital B (further away). |
| T+7:00  | Counter-flow exceeds 8: "Marshal at Exit 3 being overwhelmed by re-entering civilians."                     | Evacuation must physically block re-entry.                              |
| T+8:00  | "Breaking news: [channel] broadcasting live. Reporter claims 'dozens trapped with no rescue effort.'"       | IC attention split between operation and narrative.                     |
| T+9:00  | "Audible cracking in east wing ceiling. Structural engineer estimates 15-20 minutes to potential collapse." | Countdown begins. Everyone in east wing must get out.                   |
| T+11:00 | "Wind shifting. Smoke/dust now moving toward Assembly Point A."                                             | Assembly point must relocate. 130 people moving again.                  |
| T+13:00 | Red patient waiting 8+ min without transport: "Patient deteriorating rapidly. Needs surgical intervention." | Ambulance availability crisis.                                          |

### Communication Load

By Phase 3, the comms channel should be constantly active with structured updates. The game tracks communication metrics: frequency per team, response time to IC requests, structured vs. unstructured messages.

---

## 12. Phase 4 — Complications (T+15min to T+25min)

### Purpose

Break the stability. Test adaptability. Phase 3 established a rhythm — Phase 4 destroys it with cascading crises that arrive simultaneously.

### The Secondary Device (T+15:00)

The defining event. The bomb squad reaches the area around Exit 1 and discovers a confirmed IED in a trash bin, 8 meters from the exit approach path.

> **[FLASH — T+15:00] EOD to IC: Confirmed suspicious device in trash bin, 8 meters northwest of Exit 1. Consistent with secondary IED. Request immediate closure and 100m clearance.**

**Immediate actions required (within 60 seconds):**

| Team       | Action                                                                                           | Why                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| IC         | Broadcast to all. Order Exit 1 closure. Order 100m clearance.                                    | Every second the device is live, people near it are at risk.                    |
| Evacuation | Close Exit 1. Redirect ALL traffic to Exits 3 and 4. Move any evacuees in the 100m blast radius. | Exit 1 was handling 40% of traffic. Losing it creates surge at remaining exits. |
| Police     | Expand cordon around the device. Clear the area. Withdraw officers from near Exit 1.             | The device targets responders.                                                  |
| Medical    | If CCP is within 100m — RELOCATE everything. Patients, equipment, staff.                         | CCP destruction = total loss of treatment capability.                           |
| Fire       | Withdraw any units near Exit 1.                                                                  | No EOD capability. Stay clear.                                                  |
| Bomb Squad | Cordon the device. Begin render-safe with robot.                                                 | This is their moment. Disruption device or continued assessment.                |

**Cascade effect on evacuation**: The 40% of traffic that was using Exit 1 must now use Exits 3 and 4. Corridors to those exits experience a surge. Without immediate marshal redeployment, a new crush forms at exits that were working fine 30 seconds ago.

**If the assembly point is within 100m**: 150 evacuees must relocate. This takes time and marshals — marshals who are now needed inside for the flow disruption.

**If the bomb squad didn't reach Exit 1 in time**: The device detonates at its timer (e.g., T+18:00). 15-25 new casualties among evacuees and responders near Exit 1. Mass panic. The operation resets to chaos.

### Structural Collapse (T+17:00 to T+20:00)

The structural warning from T+9:00 gave a 15-20 minute window. It's closing.

**T+17:00 — Final warning**: "3-5 minutes to progressive collapse. All personnel MUST evacuate east wing."

**T+20:00 — Collapse occurs**: East wing impassable. Any pedestrians or units still inside are casualties or trapped. Dust cloud expands (wind-carried). Panic spike among remaining pedestrians. Stairwells near east wing possibly compromised (multi-storey).

**Accountability crisis**: IC must do immediate roll call. Are all responder units out of the east wing? If a unit is unaccounted for, rescue-within-rescue begins.

### Resource Exhaustion

- **Personnel fatigue**: Units deployed 15+ minutes have reduced effectiveness. Teams should rotate — but rotations require fresh units from RVP and coordination.
- **Ambulance cycle**: First ambulances returning, but casualty surge from secondary device/collapse creates demand spike. Mutual aid should have been requested 10 minutes ago.
- **Cordon pressure**: Family members heard the second explosion (if it occurred). Panic outside the cordon. Media broadcasting. Police access points under physical pressure.

### Multi-Storey Complications

- **Stairwell compromise**: East wing collapse may damage Stairwell A. All upper-floor traffic funnels to Stairwell B — capacity halved.
- **Elevator trap**: Power disruption traps persons between floors. Elevator rescue commits a fire unit for 10-15 minutes.
- **Floor isolation**: Floor 3 may become effectively inaccessible. Ladder deployment from exterior as emergency alternative.

### External Pressure

**T+18:00 — Political**: "Mayor's office demanding briefing for press conference. Wants casualty numbers and 'all clear' timeline."

**T+20:00 — Misinformation**: "Social media claims building has 'completely collapsed' and '200 confirmed dead.' Families at cordon becoming hostile."

These test whether the IC can maintain operational focus while handling external demands. Getting absorbed in politics while the operation drifts is a common real-world failure.

### Phase 4 Prioritization Test

Multiple simultaneous crises. The IC cannot address all of them. The scoring measures whether they prioritized correctly: life-threatening situations first, operational continuity second, media/politics last.

---

## 13. Phase 5 — Resolution & Accountability (T+25min to T+35min)

### Purpose

Systematic completion. The acute crises are over. The test is maintaining discipline and thoroughness when the adrenaline is fading.

### Remaining Population

10-20 pedestrians still inside:

- 3-5 on upper floors, sheltering or moving slowly
- 2-3 trapped under debris in the collapsed east wing
- 2-4 in remote areas no unit has reached
- 1-2 counter-flow individuals deep inside

Each requires dedicated attention — a unit to reach, guide, or extract them. The evacuation is no longer a flow problem. It's a search problem.

### Accountability Process

**Headcount reconciliation**: The evacuation team compiles numbers — at assembly point, at CCP, transported, confirmed deceased, confirmed still inside, unaccounted. The gap between known numbers and total building population is the critical figure.

**Personnel accountability**: IC verifies all responder units are accounted for. Any unit that doesn't check in is assumed in danger. Missing responders trigger search operations that take priority over remaining civilian evacuation.

### Medical Completion

**Re-triage**: Yellow patients who have been waiting 15-20 minutes need reassessment. Some improved (downgrade to green). Some deteriorated (upgrade to red). This is a Phase 5 requirement that gets missed when teams assume their initial triage was final.

**Transport completion**: Remaining red patients need hospital transport. Ambulance availability, hospital capacity, and route clearing all factor in.

**The missed casualty**: A walking wounded evacuee at the assembly point who appeared fine 20 minutes ago collapses — possible internal injuries. Tests whether the medical team maintained monitoring at the assembly point.

### Final Sweep

**Fire / Rescue**: Systematic room-by-room search of accessible areas. Each searched area marked clear. Collapsed sections marked inaccessible (requires USAR — beyond exercise scope). Final structural assessment communicated to IC.

**Bomb Squad**: Interior sweep of accessible building. Re-sweep of relocated assembly point and CCP if applicable. Declaration to IC: "All priority areas swept. No additional devices found."

### Scene Handover

The IC declares "all clear" when:

- All accessible areas searched and cleared (fire)
- No additional explosive devices (bomb squad)
- All known casualties triaged and being treated or transported (medical)
- Building population accounted for (evacuation)
- Scene secure (police)

The IC issues a closing report — a structured summary of the incident: type, response, outcomes, outstanding issues, handover to investigating authority. Whether the IC can deliver an accurate closing summary demonstrates whether they maintained situational awareness throughout.

**Crime scene preservation**: Cordon remains for evidence preservation. Police ensure no unauthorized entry. The exercise doesn't test the investigation phase, but scoring notes whether the team took steps to preserve the scene.

### Demobilization

- Medical: CCP operational until all patients transported or discharged. Final casualty figures to IC.
- Evacuation: Assembly point managed release — evacuees logged out for accountability.
- Fire: Withdraw from building, recover equipment, final structural assessment.
- Police: Outer cordon reduced. Inner cordon maintained for crime scene. Access control shifts to release mode.

### Exercise End

The trainer ends the session. Simulation stops. The screen transitions to the Results / AAR view.

---

## 14. Scoring

### 14.1 Live Scoring (Heat Meter)

The heat meter reflects decision quality in real time. It rises on poor decisions and cools on sound ones.

| Classification       | Heat Weight   | Examples                                                                                        |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| Good                 | Cooldown +0.3 | Correct exit closure after compromise. Proper phased evacuation. Timely re-triage.              |
| Vague                | +1            | Incomplete plan. All resources on one floor, others unmanaged. Unspecific coordination request. |
| Prerequisite failure | +1            | Assembly point placed downwind. CCP inside cordon. No structural assessment before entry.       |
| Contradiction        | +2            | Exit left open after compromise inject. Elevator used during fire scenario.                     |
| No intelligence      | +0.5          | Action taken without information. Deployed without scouting. Request without specifics.         |
| Critical failure     | +3            | Sustained crush without intervention. Compromised exit not closed. Missing responder unit.      |

### 14.2 Resource Proportionality

Scored per team across three bands:

**Adequate**: Deployment matched the situation. Equipment placed was proportional to the problem. Setup time didn't delay critical actions. Minimal idle units.

**Excessive**: Over-deployment. High setup time that delayed other actions. Multiple idle units with nothing to do. Excessive barriers for the perimeter length. Multiple CCP tents for 15 casualties.

**Insufficient**: Under-deployment. Unmanaged exits with congestion. Cordon gaps. No CCP until casualties arrive. Unswept areas that later contained a device.

### 14.3 End-of-Exercise AAR Scoring

| Metric                      | Exemplary                                   | Good                                      | Adequate                                       | Poor                                   | Critical Failure                    |
| --------------------------- | ------------------------------------------- | ----------------------------------------- | ---------------------------------------------- | -------------------------------------- | ----------------------------------- |
| Evacuation completion       | 100% of accessible                          | > 95%                                     | > 85%                                          | > 70%                                  | < 70%                               |
| Time to complete (vs. ASET) | Under 80% of ASET                           | Under ASET                                | At ASET                                        | Over by < 20%                          | Over by > 20%                       |
| Crush events                | 0                                           | 1-2 brief                                 | 3-5 brief                                      | Sustained                              | Fatalities from crush               |
| Casualty outcomes           | All survivable patients survive             | 1 preventable deterioration               | 2-3 deteriorations                             | Preventable deaths                     | Multiple preventable deaths         |
| Triage accuracy             | All tags correct                            | > 90% correct                             | > 80% correct                                  | > 60% correct                          | < 60% correct                       |
| Secondary device response   | Found and rendered safe before timer        | Found with < 3 min to spare               | Found after detonation with minimal casualties | Detonation with significant casualties | Detonation at CCP or assembly point |
| Structural response         | All personnel withdrawn before collapse     | Withdrawn with < 3 min to spare           | Withdrawn but close call                       | Unit caught in collapse                | Unit trapped, rescue required       |
| Command establishment       | < 30s                                       | < 60s                                     | < 90s                                          | < 180s                                 | Never formally established          |
| Personnel accountability    | All accounted at all times                  | All accounted by Phase 5                  | Accounted after roll call delay                | Missing unit found after search        | Missing unit not found              |
| Cross-team coordination     | Regular structured updates, rapid responses | Regular updates, minor delays             | Intermittent communication                     | Sporadic, unstructured                 | Minimal or no coordination          |
| Resource proportionality    | Adequate across all teams                   | Adequate most teams, minor excess/deficit | Mixed                                          | Significant excess or deficit          | Gross mismatch                      |

### 14.4 Communication Metrics

| Metric                          | What It Measures                                              |
| ------------------------------- | ------------------------------------------------------------- |
| Messages per team per phase     | Too few = not reporting. Too many = flooding.                 |
| Response time to IC requests    | IC asks a question — how long until an answer?                |
| METHANE format usage            | Structured reporting vs. unstructured chatter                 |
| Unanswered requests             | IC or team requests that received no response                 |
| Cross-team direct communication | Teams coordinating directly vs. routing everything through IC |

### 14.5 Key Learning Moments

The system identifies the 3-5 most significant decision points and presents them as case studies with:

- What happened
- What the team did (and when)
- What the outcome was
- What a different decision would have produced

These are the core learning artifacts of the exercise.

---

## 15. AAR (After Action Review)

### Timeline Replay

A scrubber plays back the entire exercise. The map shows:

- Crowd movement over time (sped up or real-time)
- Every unit deployment and movement
- Every equipment placement
- Every exit opening/closing
- Every cordon placement
- Every casualty discovery, triage tag, and transport
- Every inject receipt and player response
- Highlighted response times between inject and action

The trainer can pause at any moment to discuss decisions.

### Scoring Dashboard

Per-team and overall scores across all metrics. Heat meter final state. Resource proportionality assessment. Communication metrics summary.

### Per-Team Breakdown

Every action timestamped. Response time to each inject. Resources deployed vs. situation requirements. Doctrinal compliance checks.

### Simulation Replay Data

The full simulation state at every tick is recorded, allowing frame-by-frame analysis of crowd behavior, congestion events, and the impact of player interventions.

---

## 16. Difficulty Scaling

| Parameter                | Easy                               | Medium                         | Hard                                    |
| ------------------------ | ---------------------------------- | ------------------------------ | --------------------------------------- |
| Building                 | Single floor, rectangular, 4 exits | Single floor, L-shape, 3 exits | 3 floors, complex polygon, 2 stairwells |
| Population               | 80                                 | 150                            | 300+                                    |
| Panic factor             | 0.2                                | 0.5                            | 0.8                                     |
| Counter-flow             | 0%                                 | 5%                             | 15%                                     |
| Frozen pedestrians       | 0                                  | 5-10                           | 20+                                     |
| Exits compromised        | 0                                  | 1                              | 2+                                      |
| Secondary device         | None                               | 1 (found early)                | 1 (found late or detonates)             |
| Structural collapse      | None                               | Warning only                   | Full collapse                           |
| Inject frequency         | Every 5 min                        | Every 3 min                    | Every 1-2 min                           |
| Fog of war               | Disabled                           | Partial                        | Full                                    |
| Hospital capacity        | Unlimited                          | Limited                        | Severely limited                        |
| Elevator reliability     | N/A                                | Reliable                       | Intermittent                            |
| Political/media pressure | None                               | Moderate                       | Intense                                 |

---

## 17. Companion Documents

This Game Flow document describes the overall exercise progression. For detailed team-specific mechanics, equipment, abilities, and scoring, see:

- `EVACUATION_TEAM.md` — Crowd flow management, exit control, assembly points
- `POLICE_CORDON_TEAM.md` — Cordon establishment, access control, crowd control
- `TRIAGE_MEDICAL_TEAM.md` — CCP operations, triage protocol, transport management
- `FIRE_RESCUE_TEAM.md` — Structural assessment, search and rescue, breaching
- `BOMB_DISPOSAL_TEAM.md` — Sweep methodology, render-safe, scene photos
- `MEDIA_COMMS_TEAM.md` — Public information, narrative management
- `INCIDENT_COMMANDER.md` — Command, coordination, prioritization
- `SCORING_AND_AAR.md` — Detailed scoring rubrics and AAR structure
- `SCENARIO_SETUP_GUIDE.md` — Trainer guide for building scenarios

---

## 18. Real-World Doctrinal References

- **JESIP (Joint Emergency Services Interoperability Principles)**: Co-locate, communicate, coordinate, jointly understand risk, shared situational awareness
- **NIMS / ICS (National Incident Management System / Incident Command System)**: Command structure, resource management, information flow
- **BS 9999 / BS 7974**: ASET vs. RSET fire safety engineering
- **NFPA 101 (Life Safety Code)**: Exit capacity, means of egress
- **Fruin's Level of Service**: Pedestrian density thresholds (A through F)
- **UK Cabinet Office Emergency Response and Recovery**: Evacuation decision-making in CBRN and MTA scenarios
- **USFA Guidelines on Secondary Explosive Devices**: Search-before-entry, zone management
- **FM 19-10 Chapter 20 (Bomb Threats)**: Two-person team search, four-level room sweep
- **ATF Bomb Search Techniques**: Outside-in, bottom-up, public-to-restricted search order
- **START / SALT Triage Protocols**: Mass casualty triage methodology
- **METHANE Reporting Framework**: Major incident initial report structure
- **ERG IED Safe Stand-Off Distance Tables**: Evacuation distances by device type
