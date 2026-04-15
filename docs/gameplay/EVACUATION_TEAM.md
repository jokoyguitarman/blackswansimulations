# Black Swan Simulations — RTS Gameplay Mechanics

## Evacuation Team

### Version 0.1 — Draft

---

## 1. Overview

Black Swan Simulations uses a real-time strategy (RTS) model where participants command responder units on a live map while a crowd evacuation simulation runs continuously. The evacuation team manages the movement of civilians from a compromised building to designated safe assembly points. Unlike traditional tabletop exercises where participants describe what they would do, this system requires participants to **execute decisions in real time** against a crowd that behaves autonomously and reacts to both the environment and player interventions.

The crowd does not wait for the player to decide. Every second of deliberation is a second the crowd is at risk.

---

## 2. The Simulation Layer

### 2.1 What the Crowd Does

The evacuation simulation uses a Matter.js physics engine with a social-force-inspired steering model. Each pedestrian is a physics body that:

- Targets the **nearest exit** by default at spawn time
- Moves at a configurable walking speed (default 1.4 m/s) modified by a panic factor
- Collides with walls, other pedestrians, and player-placed barriers
- Slows down in congested areas (visible as amber/red dot coloring)
- Can be re-targeted to a different exit by player actions

### 2.2 What the Crowd Gets Wrong

Without player intervention, the crowd makes predictable mistakes that mirror real human behavior:

| Behavior                  | Real-World Basis                                                     | Simulation Effect                                                                                      |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Nearest-exit bias         | People default to the exit they entered through, not the optimal one | 60-80% of pedestrians converge on 1-2 exits while others remain underused                              |
| Counter-flow              | People re-enter the building for family, belongings, colleagues      | Pedestrians moving against evacuation flow create friction and slow everyone                           |
| Freezing                  | Shock, panic, sensory overload causes people to stop moving          | Frozen pedestrians become physical obstacles in corridors and at exits                                 |
| Crowd herding             | People follow the group rather than assess options independently     | Once a crowd stream forms toward an exit, individuals nearby join it regardless of better alternatives |
| Exit congestion ignorance | People do not redistribute when one exit is jammed                   | Congestion at popular exits worsens over time without intervention                                     |

These behaviors are not bugs — they are the training challenge. The evacuation team's job is to identify and correct each one.

### 2.3 Visual Indicators

Pedestrians are color-coded by speed (in meters per second):

| Color | Speed         | Meaning                       |
| ----- | ------------- | ----------------------------- |
| Green | > 0.8 m/s     | Moving freely                 |
| Amber | 0.3 - 0.8 m/s | Congested, slowed by density  |
| Red   | < 0.3 m/s     | Jammed, crush risk, or frozen |

The evacuation team's goal is to keep as many dots green as possible and eliminate red clusters before they become casualties.

---

## 3. Player Actions

### 3.1 Unit Types Available to Evacuation Team

The evacuation team deploys **Marshal** units. Units are **unlimited** — the team can deploy as many as they want. The game evaluates whether deployment was **adequate**, **excessive**, or **insufficient** based on outcomes and proportionality, not counts. Police units for cordon support must be requested through coordination with the Police team.

Units spawn at the **Staging Area / RVP** and must travel to their assigned position at realistic speed. Over-deploying means more units to track, more to reposition when conditions change, and more time spent managing instead of deciding.

| Unit                              | Speed   | Abilities                           |
| --------------------------------- | ------- | ----------------------------------- |
| Floor Warden / Marshal            | 2.2 m/s | Redirect, Unfreeze, PA Announce     |
| Police (request from Police team) | 2.0 m/s | Cordon, One-Way Barrier, Close Exit |

### 3.1a Equipment

Equipment is **unlimited**. Items are placed through units — select a unit, select equipment, click the map. The unit must be near the placement location. Equipment persists in the world after placement.

| Equipment              | Placed By           | Time to Place | Effect                                                                                                                                          |
| ---------------------- | ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Assembly Point Marker  | Marshal on location | 1s            | Exited pedestrians route toward this point. Visible to all teams.                                                                               |
| Directional Signage    | Marshal on location | 2s            | Pedestrians within 10m re-target toward indicated exit. Persistent — works after marshal leaves. Can become stale if exit is later compromised. |
| Megaphone / PA Speaker | Marshal on location | 1s            | Increases PA announcement radius from 15m to 30m at that position. Persistent.                                                                  |

### 3.2 Exit Management

Exits are the primary control mechanism. The evacuation team can:

**Open an Exit**

- Requires: Marshal unit within 3m of exit location
- Duration: 1 second
- Effect: Creates a gap in the physics wall. Pedestrians can now flow through this opening.
- Use when: Activating emergency exits that aren't part of the building's normal flow, or reopening a previously closed exit after hazard clearance.

**Close an Exit**

- Requires: Marshal or Police unit within 3m of exit location
- Duration: 1 second
- Effect: Seals the exit gap. Pedestrians already targeting this exit will re-route to the next nearest open exit.
- Use when: Exit is compromised (near blast, structural damage, contamination, secondary device suspected nearby). Failure to close a compromised exit is a scoring penalty.

**Assign a Marshal to an Exit**

- Requires: Marshal unit positioned at exit
- Duration: Continuous while marshal is stationed
- Effect: Increases effective exit throughput by 30% (marshal manages flow, prevents bunching). Reduces panic factor for pedestrians within 5m radius.
- Use when: An exit is high-traffic and showing amber/red congestion.

### 3.3 Flow Control

**Place a One-Way Barrier**

- Requires: Police unit (must be requested from Police team)
- Duration: 3 seconds to place
- Effect: Injects a directional barrier into the physics world. Pedestrians can pass in the designated direction but are blocked in the reverse direction.
- Use when: Counter-flow is disrupting an evacuation route. People re-entering the building through an exit being used for outflow.

**Place a Cordon**

- Requires: Police unit
- Duration: 3 seconds to place
- Effect: Injects a static physics barrier blocking all movement in both directions.
- Use when: Blocking access to a hazardous area, preventing crowd from approaching a danger zone, creating controlled lanes.

**PA Announcement (Area Broadcast)**

- Requires: Marshal unit at the broadcast location
- Duration: 1 second
- Effect: All pedestrians within a 15m radius re-target to a specified exit. Does not guarantee compliance — pedestrians with high panic factor may ignore (70% compliance at panic 0, dropping to 40% at panic 1.0).
- Use when: Redirecting crowd away from a compromised exit, distributing load to underused exits, guiding people toward assembly points after exiting.

**Redirect (Continuous Influence)**

- Requires: Marshal unit stationed at a position
- Duration: Continuous while marshal is stationed
- Effect: Pedestrians passing within 5m radius are re-targeted to a specified exit. Works as a persistent waypoint.
- Use when: Creating guided evacuation routes — a marshal at a corridor junction redirecting flow away from a dead end or toward a less-congested path.

### 3.4 Special Interventions

**Unfreeze Shocked Civilians**

- Requires: Marshal unit within 3m of frozen pedestrian cluster
- Duration: 2 seconds per cluster
- Effect: Frozen pedestrians in a 3m radius resume movement toward their target exit.
- Use when: Red (stationary) dots are blocking a corridor or exit approach. These individuals are in shock and need direct human interaction to snap out of it.

**Request Rescue Unit for Non-Ambulatory Person**

- Requires: Coordination with Fire/Rescue team via chat
- Effect: If Fire/Rescue team deploys a unit to the location, the non-ambulatory person is carried to the nearest exit (unit moves at 0.5 m/s while carrying).
- Use when: Mobility-impaired persons, severely injured individuals who cannot self-evacuate. The evacuation team identifies the need; another team provides the capability.

### 3.5 Assembly Point Management

**Place Assembly Point**

- Effect: Pedestrians who exit the building walk toward the nearest assembly point marker. Without an assembly point, exited pedestrians mill around the building perimeter (blocking emergency vehicle access, exposure to hazards).
- Placement guidance: Must be upwind from any chemical/smoke hazard. Must be outside the blast fragmentation zone. Must not block emergency vehicle access routes.

**Move Assembly Point**

- Effect: All pedestrians currently gathered at the old location begin moving to the new location.
- Use when: Wind shift moves contamination toward the assembly point. Secondary device suspected near assembly point. Emergency vehicles need the space.
- Consequence: Moving an assembly point after hundreds have gathered takes time. People in transit are vulnerable. The simulation shows this cost.

**Initiate Headcount**

- Effect: Displays count of pedestrians at the assembly point vs. total building population vs. known evacuated. Identifies the gap (people still inside or unaccounted for).
- Use when: Standard accountability procedure. The evacuation isn't complete until every person is accounted for. A gap triggers search-and-rescue requests.

---

## 4. Inject Integration

Injects are scenario events delivered to the team during the exercise. They modify the simulation state and force the team to adapt their plan.

### 4.1 Time-Based Injects (Pre-Scheduled)

These fire at predetermined times after the exercise starts:

| Time     | Example Inject                                                                                                          | Required Response                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T+0      | "Explosion reported on ground floor, east wing. Multiple casualties. Fire alarm activated."                             | Begin evacuation. Assess exits. Deploy first units.                                                                            |
| T+3 min  | "Security reports: east emergency exit (Exit 2) is blocked by debris."                                                  | Close Exit 2 in the system. Redirect crowd to Exits 1, 3, 4. Deploy marshal to intercept flow toward Exit 2.                   |
| T+5 min  | "Floor warden reports approximately 15 people frozen in the main corridor, not responding to verbal commands."          | Deploy marshal to unfreeze. Identify if the blockage is impeding flow for others behind them.                                  |
| T+8 min  | "Wind direction has changed. Smoke now blowing toward Assembly Point A."                                                | Move Assembly Point A to an upwind location. Redirect the 120 people already gathered there. Accept the 2-3 minute disruption. |
| T+10 min | "Bomb squad has identified a suspicious package near Exit 4. Requesting immediate closure and 100m cordon."             | Close Exit 4. Place cordon. Redistribute remaining crowd to Exits 1 and 3. Communicate with crowd already near Exit 4 via PA.  |
| T+15 min | "IC requesting status: how many still inside? How many at assembly? What's your estimated time to complete evacuation?" | Initiate headcount. Report metrics. Justify decisions if evacuation is behind schedule.                                        |

### 4.2 Crowd-State Triggered Injects

These fire automatically when the simulation reaches specific thresholds:

| Trigger                                                          | Inject Generated                                                                                                    | Pressure Created                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Density at any exit exceeds crush threshold for 30+ seconds      | "Crush warning at [Exit]. Reports of people falling. Possible trampling injuries."                                  | Must immediately act — close exit temporarily, deploy marshals, open alternatives. Every second of crush = potential fatalities. |
| Counter-flow pedestrians exceed 10                               | "Marshal reports loss of control at [Exit]. People forcing their way back into the building."                       | Must deploy barrier or additional marshals to stop counter-flow before it collapses the evacuation route.                        |
| Evacuation progress below 50% at T+10 min                        | "IC to Evacuation Lead: We're behind schedule. What's the hold-up?"                                                 | Forces the team to reassess their strategy. Are exits underused? Are stairwells jammed? Is the phasing wrong?                    |
| A floor has zero units deployed and congestion forming           | "No marshals reported on Floor [N]. Who's managing that floor?"                                                     | Forces resource allocation decisions. You can't be everywhere at once.                                                           |
| Pedestrians accumulating outside building without assembly point | "Police report: large crowd gathering on [Street], blocking emergency vehicle access. Where is the assembly point?" | Must place assembly point and route exited pedestrians there.                                                                    |

### 4.3 Inject State Effects

When an inject fires, it can modify the simulation state through the `inject_state_effects` system:

- An inject marking an exit as compromised sets `exits[exitId].compromised = true` in state — the simulation can then visually flag the exit and begin penalizing the team if pedestrians continue flowing through it.
- A wind-change inject updates `environmental_state.wind.direction_degrees` — affecting which assembly points are safe.
- A "power failure" inject can disable elevators mid-evacuation by toggling `floors[n].elevator_enabled = false`.

The evacuation team does not see the raw state changes — they see the inject narrative and must infer the correct action.

---

## 5. Multi-Storey Operations

### 5.1 Building Model

For scenarios with 2-3 storey buildings, each floor is modeled as a separate polygon with its own pedestrian population. Floors are connected by:

- **Stairwells**: Narrow corridor polygons (width ~1.2m) connecting adjacent floors. Pedestrian speed on stairs is reduced to 0.5 m/s (vs. 1.4 m/s on flat ground). Capacity is approximately 40-60 persons per minute per stairwell.
- **Elevators**: Point connections between floors. Capacity ~8-12 persons per trip. Trip time ~15-30 seconds per floor. Can be enabled or disabled by player decision.

Stairwells and elevators function as **exits** on each floor — pedestrians on Floor 3 target a stairwell entrance, descend to Floor 2, then continue to Floor 1 and out through an exterior exit.

### 5.2 Floor View

The player sees one floor at a time via a floor selector. Each floor canvas shows:

- The floor polygon, walls, and corridors
- Pedestrians on that floor (colored by speed)
- Stairwell entrances (showing queue depth)
- Elevator doors (open/closed/disabled indicator)
- Deployed units on that floor

A **cross-section sidebar** provides a vertical summary of all floors simultaneously:

- Stacked floor diagrams showing pedestrian density per floor
- Stairwell queues visible as vertical lines
- Floor-by-floor evacuation progress (percentage remaining)
- Alerts for any floor with crush-risk conditions

The cross-section allows the player to monitor all floors without switching, while the main canvas provides the detail needed to take action on a specific floor.

### 5.3 Phased Evacuation

Simultaneous evacuation of all floors is the most common mistake. It overloads stairwells and creates dangerous congestion at stairwell entrances on upper floors. Real doctrine calls for **phased evacuation**:

| Phase   | Floors Evacuated                              | Rationale                                                  |
| ------- | --------------------------------------------- | ---------------------------------------------------------- |
| Phase 1 | Floor of incident (Floor 1 in bomb scenario)  | Immediate danger, highest casualties, most structural risk |
| Phase 2 | Floor directly above incident (Floor 2)       | Fire and smoke rise. Structural damage propagates upward.  |
| Phase 3 | Floor directly below incident (if applicable) | Structural damage propagates downward.                     |
| Phase 4 | Remaining floors in sequence                  | Managed flow to prevent stairwell overload                 |

The player controls phasing by choosing when to trigger evacuation on each floor. If Floor 3 is not yet in danger, the player can instruct Floor 3 to **shelter in place** while Floors 1 and 2 evacuate — keeping the stairwells clear for priority populations.

The simulation tests this: if the player triggers all floors simultaneously, stairwell congestion becomes visible within 30-60 seconds as queues back up onto floor corridors. If they phase correctly, stairwell flow remains green/amber.

### 5.4 Stairwell Management

Each stairwell has limited capacity. The player's stairwell decisions include:

| Decision         | Options                                                                | Trade-off                                                                                                        |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Assignment       | Stair A for Floor 3, Stair B for Floor 2                               | Dedicating a stairwell prevents cross-contamination of flows but reduces options if one stairwell is compromised |
| Direction        | Downward only (standard) vs. allowing rescue units upward              | Upward-bound rescue units reduce downward capacity                                                               |
| Closure          | Close a stairwell due to smoke, structural risk                        | Remaining stairwells must absorb all traffic — potential overload                                                |
| Entry management | Control how many people enter the stairwell per minute from each floor | Prevents stairwell from becoming a crush point, but slows floor evacuation                                       |

A marshal deployed at a stairwell entrance manages entry rate and prevents overcrowding on the stairs.

### 5.5 Elevator Decisions

Elevator use after a building incident is a **policy decision** that the player must make based on the scenario type:

| Scenario Type                     | Elevator Doctrine                                                                      | Game Default             |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| Fire / Explosion with fire spread | **Do not use** — fire can compromise shaft, power failure traps occupants              | Disabled                 |
| Bombing without fire              | **May use with caution** — structural integrity and power reliability must be assessed | Enabled, can be disabled |
| Chemical release                  | **Do not use** — HVAC and elevator shafts can channel contaminants between floors      | Disabled                 |

If elevators are enabled, the player can use them for:

- **Mobility-impaired evacuation**: Priority use for people who cannot use stairs
- **Bulk evacuation**: Faster for upper floors but carries risk
- **Rescue team transport**: Getting units to upper floors quickly

The risk: an inject at any point can kill the power. If people are in the elevator when power fails, they are trapped and require a rescue operation — which diverts resources from the main evacuation.

### 5.6 Multi-Storey Injects

| Time     | Inject                                                                                                                                 | Multi-Storey Implication                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T+2 min  | "Fire alarm activated. Sprinklers active on Floor 1."                                                                                  | Floor 1 panic factor increases. Floors 2-3 may not yet be aware unless PA is used.                                                                                      |
| T+4 min  | "Smoke detected in Stairwell A between Floors 1 and 2."                                                                                | Must close Stairwell A. Only Stairwell B available. Capacity halved. All upper-floor traffic funnels to one stairwell.                                                  |
| T+6 min  | "Wheelchair user on Floor 3 unable to use stairs. Requesting assistance."                                                              | Must send rescue unit up Stairwell B (against flow) or use elevator. Either choice has cost.                                                                            |
| T+8 min  | "Power supply unstable. Building management reports possible outage within 5 minutes."                                                 | If elevator is being used, must rush remaining mobility-impaired persons down now, or commit to stairwell extraction.                                                   |
| T+10 min | "Floor 2 marshal reports: people from Floor 3 are forcing their way into Floor 2 corridor, creating gridlock at Stairwell B entrance." | Stairwell entry management is failing. Must deploy additional marshal to Floor 2 stairwell entrance or adjust phasing.                                                  |
| T+14 min | "Structural assessment: Floor 1 ceiling showing signs of failure above east corridor. Recommend no foot traffic in that section."      | Must reroute Floor 1 east-side evacuees. If an exit is on the east side, it may need to be closed despite being structurally sound — the approach route is the problem. |

---

## 6. Information Asymmetry

The evacuation team does **not** have full visibility of the building at the start of the exercise.

### 6.1 What the Evacuation Team Sees

- Building polygon outline and floor plans
- Exit locations (but not their status — compromised or safe)
- Total estimated building population (but not exact distribution)
- Crowd particles **only within line-of-sight of deployed units** (when fog of war is enabled)
- Their own deployed marshals and their status
- Injects directed to their team

### 6.2 What the Evacuation Team Does NOT See

- Casualty locations and triage status (visible to Triage/Medical team)
- Bomb disposal sweep status and secondary device locations (visible to Bomb Squad)
- Outer cordon status and media positions (visible to Police/Media teams)
- Structural assessment details (provided via inject, not continuously visible)
- Other teams' unit positions (unless coordination channel provides updates)

### 6.3 Cross-Team Dependencies

| Evacuation Team Needs                      | From Which Team | Coordination Mechanism                                                             |
| ------------------------------------------ | --------------- | ---------------------------------------------------------------------------------- |
| Cordon placement and one-way barriers      | Police          | Chat request: "Police, need one-way barrier at east corridor junction"             |
| Exit clearance after bomb sweep            | Bomb Squad      | Wait for "area clear" inject before reopening Exit 4                               |
| Casualty extraction from corridor blockage | Fire/Rescue     | Chat request: "Rescue, immobile casualty blocking Floor 2 main corridor"           |
| Medical coverage at assembly point         | Medical/Triage  | Chat request: "Medical, 200+ at Assembly Point B, walking wounded need assessment" |
| Structural assessment before using a route | Fire/Rescue     | Chat request: "Is the north corridor structurally safe for evacuation traffic?"    |

The friction of coordination is intentional. In a real multi-agency response, the evacuation team cannot move another agency's resources. They must communicate, request, and wait — while the clock ticks.

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

The heat meter rises when the evacuation team makes poor decisions and cools when they make sound ones:

| Trigger                                                          | Heat Impact        | Classification                           |
| ---------------------------------------------------------------- | ------------------ | ---------------------------------------- |
| Correct exit closure after compromise inject                     | Cooldown +0.3      | Good                                     |
| Proper phased evacuation sequencing                              | Cooldown +0.3      | Good                                     |
| Exit left open after compromise inject for > 60s                 | +2 (contradiction) | Contradiction with known conditions      |
| Assembly point placed downwind of hazard                         | +1 (prereq)        | Failed to check environmental conditions |
| All marshals deployed to one floor, other floors unmanaged       | +1 (vague)         | Incomplete plan                          |
| Crush event lasting > 30s without intervention                   | +3 (rejected)      | Critical failure to respond              |
| Requested action from another team without specifying what/where | +0.5 (no_intel)    | Vague coordination                       |

### 7.2 Resource Proportionality

The game evaluates whether deployment was proportional to the situation — not by counting units, but by measuring outcomes relative to deployment:

**Adequate**: Deployment matched the situation. Equipment placed was proportional to the problem. Setup time didn't delay critical actions. Minimal idle units.

**Excessive**: Over-deployment. High setup time that delayed other actions. Multiple idle marshals with nothing to do. Signage at every junction when 2-3 key points would suffice. Excessive assembly points for the evacuee count.

**Insufficient**: Under-deployment. Unmanaged exits with congestion. No assembly point until evacuees scatter. No signage despite clear need for redirection. Counter-flow unaddressed.

Proportionality is measured through:

- **Idle unit ratio**: What percentage of deployed units had nothing to do for extended periods
- **Setup vs. action time**: How long the team spent placing equipment vs. actively managing the situation
- **Gap duration**: How long critical functions (exit management, assembly point, corridor guidance) went unfilled
- **Coverage**: Congested exits without a marshal, floors without any unit presence

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                               | Exemplary                                | Good                    | Adequate                            | Poor                      | Critical Failure               |
| ------------------------------------ | ---------------------------------------- | ----------------------- | ----------------------------------- | ------------------------- | ------------------------------ |
| Evacuation completion                | 100%                                     | > 95%                   | > 85%                               | > 70%                     | < 70%                          |
| Time to complete (vs. ASET)          | Under 80% of ASET                        | Under ASET              | At ASET                             | Over ASET by < 20%        | Over ASET by > 20%             |
| Crush events                         | 0                                        | 1-2 brief               | 3-5 brief                           | Sustained crush           | Fatalities from crush          |
| Exit utilization balance             | All exits within 20% of equal load       | Within 40%              | One exit > 60% of total             | One exit > 80%            | Only one exit used             |
| Compromised exit response time       | < 30s                                    | < 60s                   | < 120s                              | < 180s                    | Never closed                   |
| Mobility-impaired extraction         | All extracted before ASET                | All extracted           | Some extracted                      | Attempted but incomplete  | Not addressed                  |
| Assembly point compliance            | Correct placement, headcount initiated   | Correct placement       | Placed but not optimal              | Placed in hazard zone     | Not placed                     |
| Multi-storey phasing (if applicable) | Correct sequence, stairwells managed     | Minor sequencing issues | Simultaneous but managed congestion | Stairwell crush           | No phasing attempted           |
| Cross-team coordination              | Timely, specific requests with follow-up | Timely requests         | Delayed requests                    | Vague or missing requests | No coordination                |
| Resource proportionality             | Adequate                                 | Minor excess or deficit | Mixed coverage                      | Significant imbalance     | Gross over or under-deployment |

### 7.3 Simulation Replay

The AAR includes a **timeline replay** of the crowd simulation with player actions overlaid. Reviewers can:

- Scrub to any point in the exercise
- See exactly when exits were opened/closed
- See when and where marshals were deployed
- Observe crush events and what the player was doing at that moment
- Compare the player's action timeline against the inject timeline to measure response latency

---

## 8. Difficulty Scaling

| Parameter             | Easy                               | Medium                          | Hard                                            |
| --------------------- | ---------------------------------- | ------------------------------- | ----------------------------------------------- |
| Building complexity   | Single floor, rectangular, 4 exits | Single floor, L-shaped, 3 exits | 3 floors, complex polygon, 2 stairwells         |
| Population            | 80                                 | 150                             | 300+                                            |
| Panic factor          | 0.2 (calm)                         | 0.5 (moderate)                  | 0.8 (high panic)                                |
| Exits compromised     | 0 during exercise                  | 1 during exercise               | 2+ during exercise                              |
| Counter-flow          | None                               | 5% of population                | 15% of population                               |
| Frozen pedestrians    | None                               | 5-10                            | 20+                                             |
| Inject frequency      | 1 every 5 min                      | 1 every 3 min                   | 1 every 1-2 min                                 |
| Cross-team dependency | Minimal                            | Moderate                        | Heavy (cordon, triage, bomb sweep all required) |
| Fog of war            | Disabled                           | Partial (limited radius)        | Full (only near units)                          |
| Elevator reliability  | N/A                                | Reliable                        | Intermittent power                              |
| Secondary device      | None                               | One, discovered early           | One, discovered late near active exit           |

---

## 9. Reference: Real-World Evacuation Standards

The gameplay mechanics are grounded in the following standards and doctrines:

- **BS 9999 / BS 7974**: UK fire safety engineering frameworks for Available Safe Egress Time (ASET) vs. Required Safe Egress Time (RSET)
- **NFPA 101 (Life Safety Code)**: Exit capacity calculations, means of egress requirements
- **ISO 23601**: Safety identification — escape and evacuation plan signs
- **JESIP (Joint Emergency Services Interoperability Principles)**: Multi-agency coordination model (co-locate, communicate, coordinate, jointly understand risk, shared situational awareness)
- **NIMS/ICS**: Incident Command System structure for role-based authority and information flow
- **Fruin's Level of Service**: Pedestrian density thresholds (A through F) used for crush risk assessment
- **UK Cabinet Office Emergency Response and Recovery**: Guidance on evacuation decision-making in CBRN and marauding terrorist attack scenarios
- **USFA Guidelines on Secondary Explosive Devices**: Search-before-entry, zone management, exclusion areas
- **FM 19-10 Chapter 20 (Bomb Threats)**: Two-person team search methodology, four-level room sweep, outside-in / bottom-up search order

---

_This document covers the Evacuation Team only. Companion documents for Police/Cordon, Triage/Medical, Fire/Rescue, Bomb Disposal, Media/Communications, and Incident Commander teams will follow the same structure._
