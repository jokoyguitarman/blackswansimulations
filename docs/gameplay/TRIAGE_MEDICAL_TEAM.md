# Black Swan Simulations — RTS Gameplay Mechanics

## Triage / Medical Team

### Version 0.1 — Draft

---

## 1. Overview

The Triage / Medical team manages casualty assessment, treatment, and transport. They set up and operate the Casualty Collection Point (CCP), apply triage tags using the START protocol, stabilize critical patients, and coordinate ambulance transport to hospitals.

The medical team's challenge is not finding casualties — that's the fire/rescue team's job. The medical team's challenge is **managing the flow of casualties through a system with finite throughput.** Triage is fast (30 seconds per patient). Treatment takes time. Ambulances are slow. Hospitals fill up. The decisions about who gets treated first and who gets transported first are the decisions that determine who lives and who dies.

---

## 2. Units

Units are **unlimited**. The game evaluates proportionality based on outcomes, not counts.

| Unit      | Speed   | Abilities                                                                                                                                                              |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medic     | 1.2 m/s | Triage (assess and tag), Treat (stabilize), Load (prepare for transport), Re-triage (reassess waiting patients), Screen (walking wounded assessment at assembly point) |
| Paramedic | 1.4 m/s | All Medic abilities + Advanced Treatment (can stabilize red patients for longer), Field Triage (can triage outside CCP in the field)                                   |

Medics operate primarily at the CCP. Paramedics are more mobile and can do field assessment, but their main value is at the CCP for advanced treatment of critical patients.

---

## 3. Equipment

Equipment is **unlimited**. Placed through units.

| Equipment                            | Placed By                            | Time to Place | Effect                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CCP Tent (Casualty Collection Point) | Medic on location                    | 10s           | Designates the primary casualty processing location. Casualties are brought here for triage, treatment, and transport preparation. Has a base capacity of 15 casualties. Requires medics stationed to function — unstaffed CCP holds patients without treating them. |
| Treatment Area                       | Medic adjacent to CCP                | 5s            | Expands CCP capacity by 10 casualties. Can place multiple. Each treatment area can handle patients of any triage category.                                                                                                                                           |
| Ambulance Staging Point              | Medic at vehicle-accessible location | 3s            | Designates where ambulances park, receive patients, and depart. Must have clear road egress for departure to hospital. Adjacent to CCP for efficient loading. Determines transport capacity.                                                                         |
| Minor Injuries Area                  | Medic on location                    | 3s            | Separate area for green-tagged (walking wounded) patients. Keeps them out of the CCP so treatment space isn't consumed by non-critical cases. Can be near the assembly point.                                                                                        |
| Body Holding Area                    | Medic on location                    | 5s            | Where deceased or expectant (black-tagged) casualties are placed. Frees CCP capacity for survivable patients. Placement is sensitive — must NOT be visible from the assembly point, media holding point, or public areas. Scoring penalty for improper placement.    |

### CCP Location Requirements

The CCP tent is the most critical piece of medical infrastructure. Placement must be:

- **Outside the inner cordon** — safe from blast effects and secondary devices
- **Upwind** — not exposed to smoke, dust, or chemical contamination
- **On flat, accessible ground** — stretchers, equipment, and staff need space to work
- **Near vehicle access** — ambulances must reach it and depart without obstruction
- **Separate from the assembly point** — 150+ frightened evacuees cannot be milling around where medics are treating critical patients. Family members will interfere. The environment must be controlled.
- **Not visible to media** — active triage and treatment of critical casualties should not be broadcast

If the CCP is placed poorly, consequences emerge naturally:

- CCP inside the cordon → hit by secondary device
- CCP downwind → smoke/dust exposure to patients and staff
- CCP next to assembly point → evacuees overrun the treatment area
- CCP with no road access → ambulances can't reach it, transport fails
- CCP visible to media → graphic footage broadcast, public panic

---

## 4. Abilities

### 4.1 Triage (START Protocol)

The core medical mechanic. When a medic interacts with a casualty at the CCP (or a paramedic in the field), a **triage assessment panel** appears showing observable signs:

| Observable Sign  | Examples                                                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| Breathing        | Present and normal / Rapid and shallow / Absent / Irregular                         |
| Pulse            | Strong / Rapid and weak / Absent / Thready                                          |
| Consciousness    | Alert / Responds to voice / Responds to pain / Unresponsive                         |
| Visible injuries | Penetrating wound to chest / Compound fracture / Burns / Lacerations / Crush injury |
| Mobility         | Walking / Cannot walk / Immobile                                                    |
| Bleeding         | None visible / Controlled / Uncontrolled arterial / Oozing                          |

The player assigns a triage tag:

| Tag                  | Color  | Criteria                                                                                                                       | Action                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Immediate            | Red    | Life-threatening but survivable with immediate intervention. Breathing problems, uncontrolled bleeding, altered consciousness. | Priority treatment and transport.                |
| Delayed              | Yellow | Serious injuries but can wait 1-4 hours. Fractures, controlled bleeding, burns without airway compromise.                      | Treatment area, monitor for deterioration.       |
| Minor                | Green  | Walking wounded. Can wait hours. Cuts, bruises, minor burns, psychological distress.                                           | Minor injuries area. Self-care with supervision. |
| Expectant / Deceased | Black  | Non-survivable injuries or already dead. No breathing and no pulse after airway repositioning, massive unsurvivable trauma.    | Body holding area.                               |

**The game evaluates triage accuracy.** Each casualty has a "true" severity set by the scenario. The player's tag is compared:

| Error                             | Consequence in Simulation                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red patient tagged Yellow         | Patient deteriorates in the treatment area. May become Black (death from delayed treatment). Scoring: preventable death.                                                  |
| Yellow patient tagged Red         | Treatment resources consumed by lower-priority patient. A genuine Red patient waits longer.                                                                               |
| Green patient tagged Red          | CCP overwhelmed with minor cases. Red patients can't get treatment space.                                                                                                 |
| Survivable patient tagged Black   | Preventable death. The most severe scoring penalty in the game.                                                                                                           |
| Non-survivable patient tagged Red | Treatment resources wasted. Other survivable patients don't get treated. Emotionally and ethically correct in isolation, but operationally wrong in mass casualty triage. |

**Triage speed matters.** The START protocol is designed for 30 seconds per patient maximum. If the medical team spends 2 minutes per triage, the queue grows faster than they can process it. The game tracks triage time per patient.

### 4.2 Treat (Stabilize)

After triage, red-tagged patients need treatment to prevent deterioration. Treatment is a timed ability — a medic stationed at the patient performs stabilization.

- **Red patient treatment**: 3-5 minutes to stabilize. Stops the deterioration clock. Patient remains Red but is stable for transport.
- **Yellow patient treatment**: 2-3 minutes. May improve patient's condition. Prevents upgrade to Red.
- **Green patient treatment**: 1 minute. Wound cleaning, bandaging. Can be done at minor injuries area.

A medic who is treating a patient **cannot triage or treat other patients simultaneously.** This is the resource tension: each treatment ties up a medic for minutes.

### 4.3 Transport

Once a patient is treated (or immediately for critical patients), they need hospital transport.

**Loading**: A medic loads the patient into an ambulance at the ambulance staging point. Takes 1-2 minutes.

**Transit**: The ambulance departs for the designated hospital. Transit time depends on distance (configurable, typically 10-15 minutes round trip to the nearest hospital, 20-25 minutes to a further hospital).

**Hospital capacity**: Each hospital has a finite capacity for critical patients. Hospital A (nearest) might accept 4-6 critical patients before being full. Overflow patients must go to Hospital B (further).

**Ambulance return**: After delivering a patient, the ambulance returns empty. This cycle time is the bottleneck. With 2 ambulances and a 12-minute round trip, the team can transport 1 patient every 6 minutes. If they have 6 red patients, the last one waits 30+ minutes.

**Mutual aid**: The team can request additional ambulances from the IC. Mutual aid ambulances arrive from outside the exercise area with a significant delay (15-20 minutes). The decision to request must be made early — by the time you realize you need more ambulances, it's too late for them to arrive in time.

### 4.4 Re-Triage

Patients waiting for treatment or transport can deteriorate (or improve). Re-triage is a Phase 5 requirement but should happen throughout:

- Yellow patients waiting more than 15 minutes should be reassessed. Some may have deteriorated to Red.
- Green patients at the minor injuries area should be monitored. Internal injuries can present as Green initially and deteriorate to Yellow or Red 20-30 minutes later.
- Red patients who received treatment should be reassessed before transport to confirm priority.

The game tracks whether re-triage was performed. Failure to re-triage is a scoring gap — a Yellow patient who deteriorated to Red without being noticed is a preventable adverse outcome.

### 4.5 Screen (Walking Wounded at Assembly Point)

A medic deployed to the assembly point screens arriving evacuees for injuries that need CCP treatment. Most evacuees are uninjured. Some have minor injuries manageable on-site. A few have injuries that appear minor but are actually serious (internal bleeding, delayed concussion symptoms).

The screening medic identifies who needs to go to the CCP and who can stay at the assembly point. Without screening, serious walking wounded are missed until they collapse.

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- Identify CCP location (outside cordon, upwind, near vehicle access, separate from assembly point)
- Identify ambulance staging location (road-accessible, near CCP, clear egress)
- Coordinate with IC on locations

### Phase 1 — Command & Control (T+0 to T+2min)

- Place CCP tent (10s setup — start early)
- Place ambulance staging
- Deploy medics to CCP (minimum 2 to begin operations)
- Consider sending 1 screening medic to the assembly point
- Coordinate with police: "Ambulance route through ACP [X] on [street]. Keep it clear."
- Coordinate with evacuation: "CCP is at [location]. Walking wounded from assembly point should be directed here only if serious."

### Phase 2 — Initial Assessment (T+2min to T+5min)

- CCP operational, waiting for casualties
- Screening medic at assembly point identifies first walking wounded
- Prepare for incoming casualties — fire team has entered the building and will begin extraction soon
- Place minor injuries area near assembly point if walking wounded volume is high
- Alert ambulances for potential first transport

### Phase 3 — Active Operations (T+5min to T+15min)

- **Casualty surge begins** (T+6:00 to T+12:00). 12-15 casualties arrive over 6-7 minutes.
- Triage rapidly — 30 seconds per patient maximum
- Allocate treatment areas — red patients get immediate treatment
- Begin ambulance loading for most critical patients
- Manage CCP capacity — if treatment areas fill, place more or prioritize
- Place body holding area when the first black-tagged patient is identified (discreetly, screened from view)
- Track hospital capacity — Hospital A fills up, must switch to Hospital B
- Request mutual aid ambulances early if casualty count exceeds transport capacity
- Monitor assembly point for delayed presentations (collapsing walking wounded)
- Re-triage yellow patients who have been waiting 10+ minutes

### Phase 4 — Complications (T+15min to T+25min)

- **Secondary device**: If CCP is in blast radius, RELOCATE. Move all patients, equipment, staff. If CCP is safe, prepare for a new wave of casualties (15-25 from the secondary blast).
- **Structural collapse**: Prepare for additional casualties — possible responder casualties if units were inside.
- **Transport crisis**: Hospital A may be full. Hospital B is further. Ambulance round-trip time increases. Patients at CCP wait longer. Stabilization becomes critical.
- **Mutual aid**: If not requested earlier, request now. Accept the delay.
- **Re-triage urgency**: Yellow patients who've waited 15+ minutes are at risk. Red patients who were stabilized may need re-assessment.

### Phase 5 — Resolution (T+25min to T+35min)

- Casualty flow has stopped. Focus shifts to completing treatment and transport.
- Re-triage ALL remaining patients (yellow and green)
- Transport remaining red patients
- Discharge green patients from minor injuries area with advice
- Provide IC with final casualty figures: [X] red, [Y] yellow, [Z] green, [W] black, [V] transported, [U] discharged
- Monitor assembly point for late-presenting casualties (the person who seemed fine 25 minutes ago and suddenly collapses)
- Prepare CCP for handover/demobilization once all patients are cleared

---

## 6. Cross-Team Dependencies

| Medical Team Needs                                | From Which Team | Mechanism                                                  |
| ------------------------------------------------- | --------------- | ---------------------------------------------------------- |
| Casualties delivered to CCP                       | Fire/Rescue     | Fire extracts from building, carries to CCP                |
| Cordon location (to place CCP outside)            | Police          | Police broadcasts cordon radius                            |
| Assembly point location (to place CCP separately) | Evacuation      | Coordinate: "Where is your assembly point?"                |
| Ambulance route kept clear                        | Police          | Police manages ACP and road access                         |
| Building entry authorization (for field triage)   | IC              | Paramedic requests entry for field assessment              |
| Casualty location information                     | Fire/Rescue     | "Fire, how many casualties and where? We need to prepare." |

| Other Teams Need from Medical                | Mechanism                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Casualty status for IC situational awareness | Medical reports: "[X] red, [Y] yellow at CCP. First transport departing."               |
| Walking wounded assessment at assembly point | Screening medic identifies evacuees needing CCP treatment                               |
| Hospital capacity information for IC         | Medical reports: "Hospital A full. Diverting to Hospital B. Transport times increased." |
| Casualty count for accountability            | Medical provides total casualty figures to IC                                           |

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

| Trigger                                                        | Heat Impact        | Classification                  |
| -------------------------------------------------------------- | ------------------ | ------------------------------- |
| CCP placed correctly and operational within 3 minutes          | Cooldown +0.3      | Good                            |
| Triage completed within 30s per patient                        | Cooldown +0.3      | Good                            |
| Red patient waiting > 5 min for treatment without intervention | +2 (contradiction) | Treatment delay                 |
| CCP placed inside inner cordon                                 | +2 (contradiction) | Contradicts safety doctrine     |
| CCP placed downwind of hazard                                  | +1 (prereq)        | Failed environmental check      |
| No CCP placed by T+5:00                                        | +3 (rejected)      | Critical infrastructure failure |
| Survivable patient tagged Black                                | +3 (rejected)      | Most severe triage error        |
| Body holding area visible from assembly point                  | +1 (vague)         | Inappropriate placement         |
| No re-triage of waiting patients after 15 min                  | +1 (vague)         | Monitoring gap                  |
| Mutual aid not requested when transport capacity exceeded      | +0.5 (no_intel)    | Failed to anticipate            |

### 7.2 Resource Proportionality

**Adequate**: CCP sized for the casualty volume. Medics deployed in proportion — enough for rapid triage and treatment, not so many that most are idle. Ambulance staging placed with working egress. Screening medic at assembly point.

**Excessive**: Multiple CCP tents for 15 casualties. 8 medics at CCP when 3-4 can handle the volume. 4 ambulance staging points when 1 suffices. Setup time delayed triage because the team was placing infrastructure instead of treating patients.

**Insufficient**: No CCP until casualties arrive. Single medic trying to triage, treat, and load simultaneously. No ambulance staging — ambulances parked randomly. No screening at assembly point — walking wounded missed.

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                    | Exemplary                                       | Good                                     | Adequate                          | Poor                  | Critical Failure                 |
| ------------------------- | ----------------------------------------------- | ---------------------------------------- | --------------------------------- | --------------------- | -------------------------------- |
| CCP establishment time    | < 2 min                                         | < 3 min                                  | < 5 min                           | < 8 min               | After first casualty arrives     |
| CCP placement             | All criteria met                                | Minor issue (slightly close to assembly) | 1 criteria missed                 | 2+ criteria missed    | Inside cordon or in hazard zone  |
| Triage accuracy           | 100% correct                                    | > 90%                                    | > 80%                             | > 60%                 | < 60% or survivable tagged Black |
| Triage speed              | < 30s average                                   | < 45s                                    | < 60s                             | < 90s                 | > 90s or significant delays      |
| Red patient outcomes      | All survive                                     | 1 deterioration, 0 preventable deaths    | 1-2 deteriorations                | 1 preventable death   | Multiple preventable deaths      |
| Transport efficiency      | First transport < 10 min from first red patient | < 15 min                                 | < 20 min                          | > 20 min              | No transport completed           |
| Re-triage performed       | All waiting patients reassessed                 | Most reassessed                          | Some reassessed                   | Minimal               | No re-triage                     |
| Walking wounded screening | Screening medic deployed, captures all          | Screening deployed, minor misses         | Screening late                    | No screening          | Collapsed patient at assembly    |
| Body holding area         | Placed discreetly, correct                      | Placed, minor visibility                 | Placed but visible to evacuees    | Visible to media      | Not placed (bodies at CCP)       |
| Mutual aid timing         | Requested before need exceeded capacity         | Requested when need became clear         | Requested after capacity exceeded | Requested very late   | Never requested                  |
| Resource proportionality  | Adequate                                        | Minor excess/deficit                     | Mixed                             | Significant imbalance | Gross mismatch                   |

---

## 8. Difficulty Scaling

| Parameter                            | Easy                    | Medium                      | Hard                                       |
| ------------------------------------ | ----------------------- | --------------------------- | ------------------------------------------ |
| Total casualties                     | 5-8                     | 12-18                       | 25+                                        |
| Red (critical) casualties            | 1-2                     | 3-5                         | 8+                                         |
| Casualty arrival rate                | Spread over 15 min      | Surge over 5-7 min          | Multiple surges                            |
| Hospital capacity                    | Unlimited               | Limited (Hospital A: 6 max) | Severely limited (Hospital A: 3, B: 4)     |
| Ambulance count                      | 3                       | 2                           | 1 (must request mutual aid)                |
| Ambulance round-trip time            | 8 min                   | 12 min                      | 15-20 min                                  |
| Walking wounded with hidden injuries | 0                       | 1-2                         | 3-5                                        |
| CCP relocation required              | No                      | No                          | Yes (secondary device or wind shift)       |
| Triage complexity                    | Clear-cut presentations | Some ambiguous cases        | Multiple ambiguous, deteriorating patients |

---

## 9. Doctrinal References

- **START Triage Protocol (Simple Triage and Rapid Treatment)**: 30-second mass casualty triage methodology
- **SALT Triage (Sort, Assess, Lifesaving interventions, Treatment/Transport)**: Advanced triage alternative
- **JESIP**: Medical coordination within multi-agency response
- **NIMS / ICS**: Medical branch structure, transport coordination
- **MIMMS (Major Incident Medical Management and Support)**: UK framework for medical response to major incidents — CCP setup, triage sieve, treatment and transport priorities
- **NHS England Mass Casualty Framework**: Hospital surge capacity, mutual aid, patient distribution
- **WHO Mass Casualty Management**: International standards for field triage and CCP operations

---

_This document covers the Triage / Medical Team only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
