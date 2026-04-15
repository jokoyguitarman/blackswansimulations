# Black Swan Simulations — RTS Gameplay Mechanics

## Media / Communications Team

### Version 0.1 — Draft

---

## 1. Overview

The Media / Communications team manages public information, press relations, social media monitoring, family liaison, and inter-agency messaging. They don't move bodies, place barriers, or defuse bombs — they manage the **information environment**.

In a real incident, the information environment can be as volatile as the physical one. Uninformed media broadcast speculation. Social media spreads panic faster than blast waves. Family members descend on the scene demanding answers. Mis-statements become front-page corrections. The media team's job is to control the narrative — not through censorship, but through proactive, accurate, and timely communication.

The media team's gameplay is fundamentally different from the other teams. They don't interact with the physics simulation directly. Their "units" don't walk through the building. Instead, they operate on the **information layer**: drafting statements, monitoring feeds, briefing reporters, and managing the family reception center.

---

## 2. Units

Units are **unlimited**. The game evaluates proportionality.

| Unit                         | Speed   | Abilities                                                                                                                                 |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Press Officer                | 2.0 m/s | Draft Statement, Deliver Briefing, Media Escort, Social Media Monitor                                                                     |
| Family Liaison Officer (FLO) | 2.0 m/s | Staff Family Reception Centre, Provide Updates to Families, Coordinate with Medical for Casualty Status, Manage Missing Persons Inquiries |

Press officers manage the outward-facing communication. Family liaison officers manage the inward-facing human element — the families.

---

## 3. Equipment / Infrastructure

| Equipment                       | Placed By                                       | Time to Place | Effect                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media Briefing Point            | Press officer on location                       | 3s            | Designated location for press briefings. Should be near the media holding point, with a controlled backdrop that does NOT show the inner cordon, CCP, body holding area, or active operations.                                        |
| Family Reception Centre (FRC)   | FLO on location                                 | 10s           | Designated location where families come for information about missing persons. Must be separated from the scene, the media, and the body holding area. Requires at least 1 FLO to operate. Has a capacity limit — may need expansion. |
| Social Media Monitoring Station | Press officer (virtual — no physical placement) | 5s            | Activates social media monitoring feed. The player can see simulated social media posts about the incident — rumours, eyewitness reports, panic posts, misinformation. Not physically on the map.                                     |

### Family Reception Centre Location Requirements

The FRC is emotionally the most sensitive location in the exercise. Placement must be:

- **Away from the scene** — families should not see body bags, triage, or the blast damage
- **Away from media** — reporters approaching distressed families creates incidents
- **With transport access** — families arrive by car, taxi, or on foot
- **Separate from the assembly point** — survivors and families in the same space creates confusion and overwhelm
- **With privacy** — not in an open public area

If the FRC is placed poorly:

- Adjacent to CCP → families see triage operations, interfere with treatment
- Adjacent to media → reporters film grieving families, public outrage
- Not placed at all → families go to the cordon, police team is overwhelmed managing them
- Adjacent to body holding area → families see deceased being moved, mass distress

---

## 4. Abilities

### 4.1 Draft Statement

The media team writes and issues public statements at key moments. The game presents a **statement drafting interface** where the player selects:

1. **What to communicate** (from a menu of available information):
   - Incident confirmed at [location]
   - Area is being evacuated
   - Cordon established — avoid the area
   - Casualty count: [X] injured being treated
   - Family information hotline: [number]
   - Assembly point location for survivors
   - Road closures in effect
   - All-clear declaration

2. **Tone** (from options):
   - Factual/neutral
   - Reassuring
   - Urgent

3. **Channel** (where to issue):
   - Press release (to media at briefing point)
   - Social media post (official accounts)
   - PA broadcast (public address at the scene if available)

**Scoring checks:**

- **Timeliness**: First statement should be issued within 5 minutes. Silence breeds speculation.
- **Accuracy**: Only confirmed information should be in statements. Stating "no secondary device" before EOD sweep is complete is incorrect. Stating a casualty count before medical has confirmed is premature.
- **Completeness**: Key public safety information (avoid the area, cordon in place, family info) should be in the first statement.
- **No speculation**: Cause, attribution, device type — these should not be in public statements until confirmed by investigating authority.

### 4.2 Deliver Briefing

A press officer at the media briefing point delivers a live briefing to assembled media. In the game, this is a timed event — the player selects what to include and the briefing is delivered.

Briefings should happen at regular intervals (every 15-20 minutes for a fast-moving incident) or when significant new information is available.

**Briefing content risks:**

- Revealing sensitive operational information (secondary device locations, undercover positions)
- Speculating on cause or perpetrator
- Providing inaccurate casualty counts
- Revealing victim identities before family notification
- Showing emotion or editorial comment that undermines official messaging

### 4.3 Media Escort

A press officer can escort a media team to a controlled location for approved filming/photography. The escort ensures:

- Media stays on the approved route
- No filming of casualties, body holding area, or sensitive operations
- Access is limited and timed

Allowing **controlled media access** is a positive action — it gives the media what they need (footage, photos) without compromising operations. Denying all access pushes media to find their own way in, which is worse.

### 4.4 Social Media Monitor

When the social media monitoring station is active, the player sees a feed of simulated social media posts. These posts reflect what is happening in the simulation:

| Post Type      | Trigger                                            | Content Example                                                                         |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Eyewitness     | Evacuees at assembly point                         | "Just escaped from the building. Explosion on ground floor. People injured everywhere." |
| Rumour         | No official statement issued within 5 min          | "Hearing it was a gas explosion?? Or maybe terrorist attack??"                          |
| Panic          | Secondary device detonation or structural collapse | "SECOND BOMB JUST WENT OFF. GET AWAY FROM THE AREA."                                    |
| Misinformation | Social media decay (over time)                     | "Source says 50+ dead" (actual: 3)                                                      |
| Family         | No FRC established                                 | "My daughter was in the mall. I can't reach her. Does ANYONE know anything??"           |
| Criticism      | Poor media management                              | "Police won't tell us ANYTHING. Just standing behind tape."                             |
| Positive       | Good comms                                         | "Official update just posted. Area evacuated. Families should call [number]."           |

The media team can respond to social media posts by issuing corrective statements. They cannot delete posts (obviously). Misinformation left uncorrected escalates — the rumour becomes "fact" in public discourse. The social media feed informs the AAR about how well the information environment was managed.

### 4.5 Family Liaison

FLOs at the Family Reception Centre handle:

- **Registration**: Families register the name and description of missing persons
- **Cross-reference**: FLOs compare the missing persons list with the medical team's casualty list and the evacuation team's assembly point roster
- **Updates**: As matches are found, FLOs provide updates to families — "Your daughter is at the assembly point, uninjured" or "Your son is being treated at hospital, a transport has taken him to Hospital A"
- **Death notification**: If a casualty is confirmed deceased, the FLO manages the notification process. This is the most sensitive action in the exercise. In the game, it's handled through a scripted interaction.

**Scoring checks:**

- Was the FRC established and staffed?
- Were family inquiries cross-referenced with casualty and evacuee data?
- Were families kept informed, or left without information for long periods?
- Was the FRC separated from media and operational areas?

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- Begin drafting initial holding statement: "Incident confirmed at [location]. Emergency services responding. More information to follow."
- Activate social media monitoring
- Identify FRC location (away from scene, media, operations)

### Phase 1 — Command & Control (T+0 to T+2min)

- Issue first public statement — even a holding statement ("We are aware of an incident at [location]. Emergency services are on scene. Avoid the area.") is better than silence.
- Set up media briefing point near the media holding point (coordinate with police)
- Deploy FLO to begin FRC setup
- Begin monitoring social media for emerging narratives

### Phase 2 — Initial Assessment (T+2min to T+5min)

- Issue updated statement with confirmed information: "An explosion has occurred at [location]. The area is being evacuated. A cordon is in place. Avoid the area. Families should call [number]."
- FRC open — begin registering family inquiries
- Monitor social media — correct early misinformation if possible
- Coordinate with IC: "What can I confirm publicly? Cordon size? Evacuation in progress?"

### Phase 3 — Active Operations (T+5min to T+15min)

- Regular updates: "Emergency services are treating injured at the scene. [X] ambulances on scene. Families should call [number] or come to [FRC location]."
- Manage media at briefing point — consider first live briefing at T+10:00
- Cross-reference family inquiries with casualty data from medical team and assembly point data from evacuation team
- Monitor social media — rumours about casualty counts, cause, additional threats may be circulating. Issue corrections.
- **DO NOT**: Confirm death toll, speculate on cause, name victims, or reveal secondary device information.

### Phase 4 — Complications (T+15min to T+25min)

- **Secondary device/collapse**: Issue immediate update. "A further incident has occurred. The cordon is being extended. All persons should move further from the area."
- Social media will spike with panic posts. Issue calming, factual updates rapidly.
- Family inquiries will surge. FRC may be overwhelmed. Deploy additional FLOs.
- If FRC is in the new cordon zone or affected area, RELOCATE.
- Manage media — they will attempt to get closer for footage. Coordinate with police.
- Consider whether media escort is now appropriate to provide controlled access.

### Phase 5 — Resolution (T+25min to T+35min)

- Prepare comprehensive press briefing: confirmed casualty numbers (from medical), cordon status (from police), building status (from fire), all-clear status (from EOD)
- Final social media update: "The incident at [location] is being resolved. [X] persons treated. The area remains cordoned. Families have been contacted through the reception centre."
- FRC: Ensure all registered families have received updates. Any unresolved missing persons should be escalated.
- Prepare for AAR — gather all statements issued, timeline of communications, social media monitoring summary
- Coordinate with IC on agreed public messaging for the resolution phase

---

## 6. Cross-Team Dependencies

| Media Team Needs                                 | From Which Team   | Mechanism                                                              |
| ------------------------------------------------ | ----------------- | ---------------------------------------------------------------------- |
| Confirmed information for statements             | IC                | "IC, what can I confirm publicly? Casualty count? Cause?"              |
| Casualty data for family cross-reference         | Medical           | "Medical, can you confirm whether [name] is at CCP?"                   |
| Assembly point roster for family cross-reference | Evacuation        | "Evacuation, is [name] registered at the assembly point?"              |
| Media holding point location                     | Police            | Police designates and manages the media holding point                  |
| All-clear for public messaging                   | Bomb Squad via IC | "IC, has EOD declared all-clear? Can I include that in the statement?" |

| Other Teams Need from Media                                   | Mechanism                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Public messaging to reduce bystander convergence              | "Avoid the area" messaging reduces people approaching the cordon                                |
| Family management (keeps families away from operational area) | FRC absorbs family pressure that would otherwise hit the cordon                                 |
| Social media intelligence                                     | "IC, social media reports a second explosion — can you confirm?" (may be a rumour, may be real) |
| Official messaging alignment                                  | All teams should know what has been said publicly to avoid contradictions                       |

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

| Trigger                                         | Heat Impact        | Classification              |
| ----------------------------------------------- | ------------------ | --------------------------- |
| First statement issued within 5 minutes         | Cooldown +0.3      | Good                        |
| FRC established and staffed                     | Cooldown +0.3      | Good                        |
| Social media misinformation corrected           | Cooldown +0.3      | Good                        |
| No public statement by T+8:00                   | +2 (contradiction) | Information vacuum          |
| Statement contains unconfirmed speculation      | +2 (contradiction) | Public messaging error      |
| Victim named before family notification         | +3 (rejected)      | Critical protocol violation |
| FRC not established — families at cordon        | +1 (prereq)        | Missing infrastructure      |
| Media in inner cordon filming operations        | +1 (vague)         | Media management failure    |
| Social media rumour uncorrected for 10+ minutes | +0.5 (no_intel)    | Monitoring gap              |

### 7.2 Resource Proportionality

**Adequate**: 1-2 press officers managing briefings and statements. 1-2 FLOs at the FRC. Social media monitored. Statements timely and accurate. Regular briefings.

**Excessive**: 5+ press officers for a single media holding point. Over-frequent statements that overwhelm the audience. FRC over-staffed with nothing to do.

**Insufficient**: No press officer — no statements issued. No FLO — no family management. Social media unmonitored — rumours spiral. Media unmanaged — filming casualties.

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                         | Exemplary                                    | Good                            | Adequate             | Poor                        | Critical Failure                 |
| ------------------------------ | -------------------------------------------- | ------------------------------- | -------------------- | --------------------------- | -------------------------------- |
| First statement timing         | < 3 min                                      | < 5 min                         | < 8 min              | < 15 min                    | Never issued                     |
| Statement accuracy             | 100% confirmed facts                         | Minor imprecision               | 1 unconfirmed detail | Multiple unconfirmed claims | Public speculation or false info |
| Briefing regularity            | Every 10-15 min + after major events         | Every 15-20 min                 | 2-3 briefings total  | 1 briefing                  | No briefings                     |
| FRC establishment              | < 5 min, well located                        | < 8 min                         | < 12 min             | > 15 min                    | Not established                  |
| Family information             | All inquiries resolved                       | > 90% resolved                  | > 75% resolved       | > 50% resolved              | Families uninformed              |
| Social media management        | Rumours corrected within 5 min               | Within 10 min                   | Within 15 min        | Sporadic correction         | Unmonitored                      |
| Media access management        | Controlled escort offered                    | Media at briefing point managed | Media contained      | Media at scene edges        | Media inside cordon              |
| Victim identification protocol | No names released before family notification | Minor timing issue              | 1 breach, corrected  | Multiple breaches           | Names broadcast publicly         |
| Resource proportionality       | Adequate                                     | Minor excess/deficit            | Mixed                | Significant imbalance       | Gross mismatch                   |

---

## 8. Difficulty Scaling

| Parameter              | Easy               | Medium                         | Hard                                                               |
| ---------------------- | ------------------ | ------------------------------ | ------------------------------------------------------------------ |
| Media outlets present  | 1                  | 2-3                            | 5+ with TV cameras                                                 |
| Social media volume    | Low                | Moderate                       | High, with viral misinformation                                    |
| Family inquiries       | 3-5                | 8-12                           | 20+                                                                |
| Information ambiguity  | Clear-cut incident | Some ambiguity                 | Highly ambiguous (terrorism vs. accident, evolving)                |
| Political/VIP pressure | None               | Local official requesting info | National media, political statements, pressure for premature blame |
| Media behaviour        | Cooperative        | Persistent                     | Aggressive, attempting cordon breach, drone use                    |
| Time pressure          | Relaxed            | Moderate                       | Fast-moving, multiple developments                                 |

---

## 9. Doctrinal References

- **JESIP**: Joint communication strategy, agreed messaging
- **UK Cabinet Office**: Crisis communication guidance, COBR communication protocols
- **NIMS / ICS**: Public Information Officer (PIO) role, Joint Information Center (JIC)
- **College of Policing**: Family liaison, victim identification, media management at major incidents
- **WHO Risk Communication Framework**: Crisis communication principles — be first, be right, be credible
- **FEMA Crisis Communication Guidance**: Social media monitoring, public information release protocols
- **Disaster Victim Identification (DVI) Interpol Standards**: Protocol for victim naming and family notification

---

_This document covers the Media / Communications Team only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
