# Black Swan Simulations — RTS Gameplay Mechanics

## Police / Cordon Team

### Version 0.1 — Draft

---

## 1. Overview

The Police / Cordon team is responsible for scene security, perimeter control, access management, and crowd control outside the building. Their actions create the physical framework within which all other teams operate. Without a cordon, the scene is uncontrolled — bystanders walk in, evacuees scatter, media converges, and counter-flow individuals re-enter the building.

The cordon is not a line on a map. It is a **physics barrier** in the simulation. Once placed, it changes how every pedestrian, bystander, and vehicle interacts with the scene. The police team's decisions about where, when, and how to establish the cordon have cascading effects on every other team's ability to operate.

---

## 2. Units

Units are **unlimited**. The team can deploy as many police officers as they want. The game evaluates whether deployment was **adequate**, **excessive**, or **insufficient** based on outcomes and proportionality.

Units spawn at the **Staging Area / RVP** and travel to their assigned position at realistic speed.

| Unit           | Speed   | Abilities                                                                                                                                                            |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Police Officer | 2.0 m/s | Cordon (place barrier), Access Control (manage entry point), Crowd Control (manage crowd pressure), Redirect (turn people around), Close Exit (seal a building exit) |

---

## 3. Equipment

Equipment is **unlimited**. Items are placed through units — select a unit, select equipment, click the map. Equipment persists in the world after placement.

| Equipment            | Placed By             | Time to Place  | Effect in Simulation                                                                                                                                                                                |
| -------------------- | --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard Barrier         | Officer on location   | 3s per section | Matter.js static body — blocks all pedestrian and vehicle movement. Immovable. The crowd cannot push through.                                                                                       |
| Tape Cordon          | Officer on location   | 1s per span    | Visual boundary line. Pedestrians with low panic respect it and turn back. High-panic pedestrians push through it. Faster to deploy than hard barriers but unreliable under pressure.               |
| Road Block           | Officer on road       | 5s             | Blocks vehicle access on a road segment. Prevents unauthorized vehicles from entering the area. Does not block pedestrians.                                                                         |
| Access Control Point | Officer at cordon gap | 2s             | Creates a managed opening in the cordon. Only authorized personnel (responder units) pass through. Requires a stationed officer to function — unstaffed ACPs are open gaps.                         |
| Outer Cordon Marker  | Officer on location   | 1s             | Marks the wider perimeter for traffic and public management. Visual indicator only — does not create a physics barrier.                                                                             |
| Media Holding Point  | Officer on location   | 1s             | Designated area where media are directed. Visible to all teams. Placement should provide a camera-safe vantage point that does NOT show casualties, the body holding area, or sensitive operations. |

### Hard Barrier vs. Tape Cordon

This distinction is a training point. Tape is fast and cheap — a single officer can run a cordon line in seconds. But tape only works when the crowd is calm. When panic rises (secondary device detonation, structural collapse announcement), people push through tape. Hard barriers hold regardless of crowd state but take 3x longer to place and create rigid lines that can't be adjusted easily.

A good cordon strategy uses both: hard barriers at critical choke points (access roads, main pedestrian approaches) and tape for the gaps between, with the understanding that tape sections may fail under pressure and will need reinforcement.

---

## 4. Abilities

### 4.1 Establish Cordon

The core police action. The officer places barrier or tape segments to create a continuous perimeter around the danger zone.

**Inner Cordon**

- Purpose: Keep public and non-essential personnel out of the immediate danger area. Only authorized responders inside.
- Size: Based on threat assessment. 100m minimum for unknown explosive device. 200-400m for confirmed VBIED.
- Physics: Barriers are static bodies. Pedestrians who exit the building and reach the cordon are stopped. If an assembly point exists outside the cordon, they route there. If not, they accumulate at the barrier.

**Outer Cordon**

- Purpose: Control road access, media positioning, bystander management. Prevent traffic from blocking emergency vehicle routes.
- Size: Wider than the inner cordon. Encompasses road junctions and major access routes.
- Physics: Road blocks stop vehicles. Tape/markers indicate the boundary for pedestrians but may not physically stop determined individuals.

**Cordon sizing decision**: The team must choose the radius without knowing the full threat. An unknown device in a building warrants 100m minimum. If later intelligence suggests a VBIED or larger device, the cordon must be expanded — which means moving barriers that are already placed and relocating anything inside the new perimeter (assembly points, CCP, etc.). Under-sizing and then expanding is more disruptive than over-sizing from the start, but over-sizing delays establishment and makes the restricted area enormous.

| Device Type              | Recommended Evacuation Distance               |
| ------------------------ | --------------------------------------------- |
| Briefcase / backpack IED | 100m                                          |
| Car bomb                 | 200m                                          |
| Van / SUV bomb           | 300m                                          |
| Truck bomb               | 400m+                                         |
| Unknown                  | 100m minimum, expand as intelligence develops |

### 4.2 Access Control

Once the cordon is established, the team must manage who gets through.

- **Access Control Points (ACPs)**: Gaps in the cordon with a stationed officer. The officer checks authorization before allowing passage.
- **Who gets through**: Emergency vehicles (ambulances, fire trucks), authorized responder units, casualty transport from CCP to ambulance staging. NOT: public, media, family members, bystanders.
- **Staffing requirement**: An ACP without a stationed officer is just a gap. If the team deploys too many ACPs without enough officers to staff them, they've created cordon breaches instead of controlled entry points.

### 4.3 Crowd Control

As evacuees accumulate at the assembly point and family members gather outside the outer cordon, the police team manages crowd pressure.

**At the assembly point approach**: Directing evacuees from the cordon to the assembly point. Without police direction, evacuees may scatter along the cordon line instead of routing to the assembly point.

**At the outer cordon**: Family members, media, and bystanders pressing against the outer perimeter. Officers redirect them, provide information, and maintain the line. If insufficient officers are at pressure points, people find gaps and breach the cordon.

**Counter-flow prevention**: Evacuees at the assembly point who decide to go back for family members. They approach the cordon from the outside, trying to get back in. Officers intercept and redirect them. If no officer is present, they climb over tape or walk around barriers.

### 4.4 Crowd Control at Building Exits

The evacuation team may request police support at building exits where crowd pressure exceeds what marshals can manage. Police officers have physical crowd control capabilities:

- Place hard barriers to create flow lanes at exit approaches
- Create one-way barriers (directional physics bodies — movement allowed in one direction only)
- Physically restrict entry rate to prevent crush

### 4.5 Close Exit

Police officers can close a building exit — sealing the physics gap in the wall. Used when:

- The exit is near a confirmed or suspected device
- The exit approach is structurally compromised
- The evacuation team requests it for flow management

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- Determine cordon radius based on available information (unknown device = 100m minimum)
- Begin planning barrier placement and ACP locations
- Coordinate with IC on cordon size and positioning

### Phase 1 — Command & Control (T+0 to T+2min)

- Deploy officers to cordon positions
- Place barriers and tape along the inner cordon perimeter
- Establish 2-3 ACPs at key approach routes (main road, pedestrian approach, emergency vehicle route)
- Staff each ACP with an officer
- Coordinate with evacuation team: "Cordon at [radius]. Assembly point should be outside this line."
- Coordinate with medical team: "Ambulance route through ACP 2 on [street]."
- Begin planning outer cordon (road blocks on approach roads)

### Phase 2 — Initial Assessment (T+2min to T+5min)

- Complete inner cordon establishment
- Begin outer cordon (road blocks, traffic management)
- First evacuees reaching the cordon — direct them toward assembly point
- Monitor cordon integrity — are there gaps? Is tape holding?
- Report cordon status to IC

### Phase 3 — Active Operations (T+5min to T+15min)

- Maintain cordon integrity under increasing pressure
- Manage access control — ambulances, responder units, media (deny)
- Handle counter-flow attempts (evacuees trying to re-enter)
- Support evacuation team at exits if requested (one-way barriers, flow lanes)
- Manage outer cordon: family members arriving, media positioning
- Place media holding point if media arrives
- Provide officers for evidence preservation corridor if requested

### Phase 4 — Complications (T+15min to T+25min)

- **Secondary device discovered/detonated**: Expand cordon around the device. 100m clearance. Withdraw officers from the blast radius. Reinforce barriers if existing cordon is too close.
- **Structural collapse**: Adjust cordon if debris field extends beyond current perimeter. Dust cloud may require cordon expansion on the downwind side.
- **Family/media pressure spike**: After secondary blast or collapse, external crowd becomes frantic. Officers at outer cordon face physical pressure. Reinforcement may be needed.
- **Cordon adjustment**: If assembly point or CCP relocates, cordon may need new ACPs or barrier repositioning.

### Phase 5 — Resolution (T+25min to T+35min)

- Maintain inner cordon for crime scene preservation
- Shift ACP function from "who gets in" to "who gets out" (controlled release of evacuees)
- Facilitate evacuee release through a logging point for witness statements
- Support controlled demobilization of other teams' equipment
- Maintain outer cordon until IC declares all-clear
- Handover scene security to investigating authority

---

## 6. Cross-Team Dependencies

| Police Needs                                            | From Which Team | Mechanism                                                                |
| ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| Cordon size guidance                                    | IC / Bomb Squad | "EOD, what's your recommended standoff?"                                 |
| Assembly point location (to ensure it's outside cordon) | Evacuation      | "Evacuation, cordon is at 100m. Confirm your assembly point is outside." |
| Ambulance route clearance                               | Medical         | "Medical, ambulances should use ACP 2 on [street]. Confirm."             |
| Exit management support requests                        | Evacuation      | "Police, we need a one-way barrier at Exit 3 to prevent re-entry."       |
| Secondary device intelligence                           | Bomb Squad      | "EOD, any areas we should expand the cordon around?"                     |

| Other Teams Need from Police                         | Mechanism                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Cordon location (so they place CCP/assembly outside) | Police broadcasts cordon radius and ACP locations             |
| Access for ambulances and responder vehicles         | ACP management — police must keep ambulance routes clear      |
| One-way barriers at exits                            | Evacuation team requests, police deploys                      |
| Media management                                     | Police directs media to holding point, prevents cordon breach |
| Evidence preservation                                | Police maintains inner cordon after operational phase         |

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

| Trigger                                                               | Heat Impact        | Classification                        |
| --------------------------------------------------------------------- | ------------------ | ------------------------------------- |
| Cordon established within 2 minutes, appropriate radius               | Cooldown +0.3      | Good                                  |
| ACPs staffed and functioning                                          | Cooldown +0.3      | Good                                  |
| Cordon breach by bystander/media (gap in perimeter)                   | +2 (contradiction) | Perimeter failure                     |
| Cordon radius too small for actual threat (bomb squad advises larger) | +1 (prereq)        | Failed to assess threat               |
| ACP unstaffed — open gap in cordon                                    | +1 (vague)         | Incomplete deployment                 |
| No cordon at T+3:00                                                   | +3 (rejected)      | Critical failure — scene uncontrolled |
| Media or family member reaches inner cordon area                      | +0.5 (no_intel)    | Outer cordon gap                      |
| Counter-flow individual breaches cordon to re-enter building          | +1 (prereq)        | Cordon management failure             |

### 7.2 Resource Proportionality

**Adequate**: Cordon established with appropriate barriers for the perimeter length. ACPs at key approaches, each staffed. Setup time under 3 minutes. Cordon holds under pressure.

**Excessive**: 20+ barrier sections for a perimeter that needs 8-10. 6+ ACPs when 2-3 suffice. Setup time exceeds 8 minutes because of over-construction. Officers stationed at barriers with no traffic or pressure.

**Insufficient**: Tape-only cordon that fails when crowd panics. 1 ACP for a multi-approach scene. Gaps in perimeter exploited by bystanders. No outer cordon, media on scene unmanaged.

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                                   | Exemplary                                             | Good                          | Adequate                     | Poor                                | Critical Failure                  |
| ---------------------------------------- | ----------------------------------------------------- | ----------------------------- | ---------------------------- | ----------------------------------- | --------------------------------- |
| Cordon establishment time                | < 90s                                                 | < 2 min                       | < 3 min                      | < 5 min                             | Never fully established           |
| Cordon radius appropriateness            | Matches threat, adjusted with intel                   | Appropriate initial size      | Slightly under/over          | Significantly inappropriate         | No cordon or wildly wrong         |
| Cordon integrity                         | Zero breaches                                         | 1-2 minor (quickly addressed) | 3-5 minor                    | Sustained breaches                  | Cordon failed, scene uncontrolled |
| ACP management                           | All staffed, flow managed                             | Minor delays                  | Unstaffed periods            | Frequent unstaffed ACPs             | No access control                 |
| Counter-flow prevention                  | Zero re-entries                                       | 1-2 intercepted               | 3-5, some unintercepted      | Multiple unmanaged re-entries       | No counter-flow management        |
| Media management                         | Media directed to holding point, no sensitive footage | Media managed, minor breach   | Media near scene but managed | Media filming casualties/operations | Media inside inner cordon         |
| Cordon adjustment after secondary device | Expanded within 60s                                   | Expanded within 2 min         | Expanded within 5 min        | Slow expansion, people at risk      | No expansion                      |
| Crime scene preservation                 | Inner cordon maintained, scene secured                | Minor gaps in handover        | Delayed preservation         | Contaminated scene                  | No preservation attempt           |
| Resource proportionality                 | Adequate                                              | Minor excess/deficit          | Mixed                        | Significant imbalance               | Gross mismatch                    |

---

## 8. Difficulty Scaling

| Parameter                           | Easy | Medium                   | Hard                                       |
| ----------------------------------- | ---- | ------------------------ | ------------------------------------------ |
| Approach routes to manage           | 2    | 3-4                      | 6+                                         |
| Counter-flow pressure               | None | Moderate (5-10 attempts) | Heavy (20+ attempts, physical pressure)    |
| Media presence                      | None | 1 outlet, manageable     | Multiple outlets, aggressive, drones       |
| Family member pressure              | None | Moderate                 | Intense (physical confrontation at cordon) |
| Secondary device (cordon expansion) | None | 1 expansion              | Multiple expansions                        |
| Bystander convergence               | None | Low                      | High (social media draws crowds)           |
| Cordon adjustment required          | None | 1 (wind shift or device) | Multiple (wind, device, collapse debris)   |

---

## 9. Doctrinal References

- **JESIP**: Joint Emergency Services Interoperability Principles — cordon establishment as foundational to multi-agency response
- **NIMS / ICS**: Perimeter and scene security as first operational priority
- **ERG IED Safe Stand-Off Distance Tables**: Evacuation distances by device type
- **UK Cabinet Office**: Cordon sizing guidance for CBRN and MTA scenarios
- **USFA Secondary Device Guidelines**: Search-before-entry, zone management
- **College of Policing Authorised Professional Practice**: Scene management, cordons, access control

---

_This document covers the Police / Cordon Team only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
