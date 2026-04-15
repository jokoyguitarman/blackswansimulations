# Black Swan Simulations — RTS Gameplay Mechanics

## Incident Commander (IC)

### Version 0.1 — Draft

---

## 1. Overview

The Incident Commander is the player who sees everything and controls nothing directly. The IC does not place barriers, tag casualties, enter the building, or defuse bombs. The IC **decides**, **authorizes**, **coordinates**, and **prioritizes**. Every other team acts. The IC ensures those actions are coherent, timely, and aligned with a strategy.

In ICS/JESIP doctrine, the IC is the single point of command authority at the scene. They receive reports from all teams, make decisions about resource allocation and operational priorities, authorize high-risk actions (building entry, cordon adjustment, controlled detonation), and maintain the common operating picture that keeps everyone working toward the same goal instead of optimizing individually.

The IC's gameplay is the most cognitively demanding. They must:

- Track multiple concurrent operations across 5-6 teams
- Make decisions with incomplete information
- Prioritize competing demands (police wants resources for cordon, medical wants ambulance routes, bomb squad wants an area cleared)
- Anticipate developments (secondary device, structural collapse, weather change)
- Maintain communication discipline — the right information to the right team at the right time

The IC has **no units on the map** in the traditional sense. Their "unit" is the Forward Command Post (FCP), which is a fixed location where they operate.

---

## 2. The Forward Command Post (FCP)

The IC's first physical action is placing the FCP — the nerve center of the response.

| Infrastructure             | Time to Place | Effect                                                                                                                                                                                                       |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forward Command Post (FCP) | 5s            | Establishes command location. All team reports route here. The IC's map view centers here. Enables the command radio channel. Must be placed within line-of-sight of the scene but outside the inner cordon. |

### FCP Location Requirements

- **Outside the inner cordon** — the IC must not be in the danger zone
- **Line-of-sight to the scene** — the IC should be able to see (or be near) the operational area
- **On the approach route** — arriving resources should pass or be directed past the FCP
- **Near the staging area / RVP** — the IC needs to see what's arriving and direct deployment
- **Away from the media** — the IC should not be filmed during sensitive decision-making
- **Upwind** — not exposed to smoke, dust, or chemical drift

If the FCP is placed poorly:

- Inside the cordon → IC is in the danger zone, may need to relocate urgently
- Too far from the scene → IC has poor situational awareness, relies entirely on radio
- Adjacent to media → operational decisions are overheard/filmed
- Downwind → IC is affected by hazards
- Not placed at all → no command structure, each team operates independently

---

## 3. IC Abilities

The IC's "abilities" are decisions, authorizations, and communications — not physical actions.

### 3.1 Authorize Actions

The IC is the gatekeeper for high-risk actions. Teams request, the IC decides.

| Action Requiring Authorization   | Requesting Team     | IC Must Consider                                                             |
| -------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| Building entry for search/rescue | Fire/Rescue         | Has structural assessment been done? Is there secondary device risk?         |
| Cordon size and location         | Police              | What's the threat assessment? What's the recommended standoff?               |
| CCP location approval            | Medical             | Is the location safe, accessible, and separated from the crowd?              |
| Controlled detonation            | Bomb Squad          | What's the blast radius? Who needs to be moved? What's the alternative?      |
| Media statement content          | Media/Comms         | Is this confirmed? Is anything sensitive being released?                     |
| Cordon expansion/reduction       | Police + Bomb Squad | Has the threat changed? What's inside the current cordon that needs to move? |
| Mutual aid request               | Medical / any team  | Is current capacity insufficient? What's the ETA for mutual aid?             |

**The IC does not need to authorize every action.** Routine team operations (medic triaging at CCP, marshal redirecting at exit, officer patrolling cordon) proceed without IC approval. The IC authorizes **escalations** and **high-impact decisions**.

**If the IC fails to authorize a requested action**, the requesting team can either:

- Wait (correct, but the situation may deteriorate)
- Proceed without authorization (incorrect per doctrine — scored as a breakdown in command structure, but the game allows it)

### 3.2 Prioritize Resources

When multiple teams need the same thing (or when competing priorities arise), the IC decides:

- **Ambulance routing**: Medical says "send ambulances through ACP 2." Police says "ACP 2 is overwhelmed, use ACP 3." The IC decides.
- **Area clearance for EOD**: Bomb squad says "clear 100m around the bench." Evacuation says "that's our assembly point." The IC decides whether to move the assembly point or accept the risk.
- **Building re-entry timing**: Fire wants to send more search teams. IC must balance search progress against structural risk and potential secondary device.

### 3.3 Issue METHANE Report

The IC's primary situational awareness tool. METHANE is the standard major incident reporting format:

| Letter | Meaning                     | IC Responsibility                                                                                     |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| M      | Major incident declared     | IC formally declares. Without this, multi-agency coordination doesn't activate.                       |
| E      | Exact location              | Confirm and broadcast the incident location.                                                          |
| T      | Type of incident            | Explosion, structural collapse, CBRN, etc. Based on initial reports.                                  |
| H      | Hazards                     | Secondary device risk, structural instability, fire/smoke, chemical. Updated as information develops. |
| A      | Access                      | Best approach routes. Which roads are open? Where should responding units come from?                  |
| N      | Number of casualties        | Best estimate. Updated as medical and fire report.                                                    |
| E      | Emergency services required | What's needed? More ambulances? USAR? Hazmat? Mutual aid from neighboring jurisdictions?              |

The IC should issue the first METHANE at declaration (Phase 0-1) and update it as information arrives.

### 3.4 Manage Communications

The IC is the hub of all inter-team communication. In the game, communications are simulated through a **radio channel system**:

| Channel          | Purpose                  | Who Uses                                                 |
| ---------------- | ------------------------ | -------------------------------------------------------- |
| Command          | IC ↔ all team leaders    | Strategic decisions, authorizations, situational updates |
| Fire / Rescue    | Fire team internal       | Search reports, extraction status, structural updates    |
| Police / Cordon  | Police team internal     | Cordon status, access control, crowd management          |
| Medical / Triage | Medical team internal    | Casualty counts, transport status, CCP operations        |
| Bomb Squad       | EOD team internal + IC   | Sweep progress, device reports, render-safe status       |
| Media / Comms    | Media team internal + IC | Statement drafts, social media alerts, family updates    |

The IC can listen to any channel and communicate on Command. In practice, the IC relies on **team leaders reporting in** rather than monitoring every channel.

**Communication discipline scoring**: The game tracks whether the IC:

- Acknowledged incoming reports
- Provided timely responses to authorization requests
- Issued situational updates to all teams when conditions changed
- Maintained a communication log (automatic in the game, but the IC must "brief" all teams on major changes)

### 3.5 Declare Major Incident

A formal action that activates multi-agency coordination protocols. Until the IC declares a major incident:

- Mutual aid is not automatically dispatched
- COBR/EOC is not notified
- Multi-agency coordination does not formally begin

The IC should declare within the first 2 minutes based on the scene. Delayed declaration means delayed reinforcements and delayed coordination.

### 3.6 Request Mutual Aid

The IC can request additional resources from outside the exercise area:

- Additional ambulances (15-20 minute arrival)
- Additional police units (10-15 minute arrival)
- USAR teams (30+ minutes)
- Hazmat teams (20+ minutes)
- Additional fire appliances (15 minutes)

Mutual aid is unlimited but has arrival delays. Requesting early means help arrives when needed. Requesting late means waiting while the situation deteriorates.

---

## 4. The IC's View

The IC has the **broadest information view** of any player but not the **deepest**. The IC sees:

- The full map with all team positions (subject to fog of war for building interiors)
- Cordon lines and equipment placed by all teams
- Casualty markers (from fire team reports)
- CCP status (from medical reports)
- Evacuee flow (from evacuation team reports and lighting rigs)
- Social media feed (from media team monitoring)
- A live event log of all communications and reports

The IC does NOT see:

- Building interior details (until fire team enters and reports or places lighting rigs)
- Individual casualty triage status (only aggregate from medical: "3 red, 4 yellow, 6 green")
- Bomb squad robot camera feed (only reports: "investigating suspicious item")

The IC's challenge is that they see **summaries**, not details. They must ask the right questions to get the information they need.

---

## 5. Phase-by-Phase Responsibilities

### Phase 0 — Detonation (T+0)

- **Declare major incident** — the single most important Phase 0 action
- Assess initial reports: what happened, where, initial casualty estimate
- **Issue initial METHANE report** — even with incomplete information
- Identify FCP location
- Begin mental planning: cordon strategy, CCP placement, evacuation routes

### Phase 1 — Command & Control (T+0 to T+2min)

- Place FCP
- Authorize police cordon establishment — confirm radius and location
- Authorize fire team for external structural assessment (NOT entry yet)
- Confirm CCP and assembly point locations with medical and evacuation teams
- Ensure bomb squad has issued secondary device advisory
- Issue first METHANE to higher authority / off-scene coordination
- Establish communication discipline: "All teams, IC is at FCP. Report status on Command channel."

### Phase 2 — Initial Assessment (T+2min to T+5min)

- Receive structural assessment from fire team
- **Authorize building entry** — a critical decision. Based on structural assessment and bomb squad advisory.
- Receive cordon status from police
- Confirm CCP is operational (medical)
- Confirm assembly point is operational (evacuation)
- Update METHANE with new information (hazards, access, casualty estimate)
- Monitor bomb squad sweep progress
- Make resource allocation decisions if teams are competing for the same space

### Phase 3 — Active Operations (T+5min to T+15min)

- **This is the highest cognitive load phase.** Multiple teams reporting simultaneously.
- Monitor fire team search progress — how much of the building is covered?
- Track medical team throughput — are casualties being triaged and transported efficiently?
- Evaluate evacuation flow — are people getting out? Are exits congested?
- Track bomb squad sweep — what areas are cleared? What areas remain?
- Track police cordon integrity — any breaches? Counter-flow issues?
- Handle inter-team conflicts: "Medical wants ambulances through ACP 2, Police says it's overwhelmed — IC decides"
- Authorize escalations as needed (additional building entry teams, mutual aid requests)
- Ensure media team is issuing statements — if no statement by T+8:00, prompt them
- Monitor the heat meter — are decisions accumulating negative impact?
- Update METHANE at T+10:00 with comprehensive information

### Phase 4 — Complications (T+15min to T+25min)

- **React to injects** — secondary device, structural collapse, weather change, VIP pressure
- Make rapid decisions under pressure:
  - Secondary device found → authorize bomb squad procedure, order area clearance, relocate affected infrastructure, notify all teams
  - Structural collapse → order fire team withdrawal, account for all personnel, reassess evacuation routes, update METHANE
  - Secondary detonation → mass casualty surge, expand cordon, request mutual aid if not already done
- Communicate changes to ALL teams — not just the affected one. A cordon expansion affects police, but also medical (CCP may be in the new zone), evacuation (assembly point may need to move), and media (new statement needed).
- Re-prioritize: the plan from Phase 1 may no longer be valid. Adapt.

### Phase 5 — Resolution (T+25min to T+35min)

- Collect final reports from all teams:
  - Fire: areas searched, casualties found, structural status
  - Medical: casualty numbers by category, transport status, hospital capacity
  - Police: cordon status, media managed, evidence preservation
  - Bomb Squad: areas swept, devices found/neutralized, all-clear status
  - Evacuation: evacuees accounted, assembly point status
  - Media: statements issued, family inquiries resolved
- Issue final METHANE to higher authority
- Authorize controlled demobilization
- Ensure scene handover to investigating authority (crime scene preservation)
- Prepare for AAR — the IC is the primary reviewer

---

## 6. Decision Framework

The IC's decisions can be categorized:

### Time-Critical Decisions (must be made within 30 seconds)

- Declare major incident (Phase 0)
- Authorize withdrawal during structural collapse
- Expand cordon after secondary device discovery

### Important Decisions (should be made within 2 minutes)

- Cordon radius and location
- CCP and assembly point locations
- Building entry authorization
- Mutual aid request
- Controlled detonation authorization

### Ongoing Decisions (continuous assessment)

- Resource reallocation between teams
- METHANE updates
- Communication management
- Statement approval

### The IC's Dilemma Pattern

Most IC decisions follow a pattern: **competing goods**. There is no "wrong" option — only trade-offs.

| Decision                 | Option A                             | Option B                                            | Trade-off                      |
| ------------------------ | ------------------------------------ | --------------------------------------------------- | ------------------------------ |
| Building entry timing    | Enter early → find casualties faster | Wait for structural assessment → safer              | Speed vs. safety               |
| Cordon size              | Large cordon → safer                 | Small cordon → faster to establish, less disruption | Safety vs. speed               |
| Mutual aid request       | Request early → help arrives sooner  | Wait → may not need it                              | Preparedness vs. over-reaction |
| Assembly point near exit | Close → evacuees don't scatter       | Far → safer from secondary device                   | Convenience vs. safety         |
| Controlled detonation    | Detonate → device neutralized        | Wait for disruption → quieter, less panic           | Certainty vs. calm             |

The game does not punish choosing either option. It punishes **not choosing** — indecision is the IC's worst failure.

---

## 7. Scoring

### 7.1 Live Scoring (Heat Meter)

| Trigger                                                               | Heat Impact        | Classification             |
| --------------------------------------------------------------------- | ------------------ | -------------------------- |
| Major incident declared within 2 minutes                              | Cooldown +0.3      | Good                       |
| METHANE issued and updated                                            | Cooldown +0.3      | Good                       |
| FCP established, communications active                                | Cooldown +0.3      | Good                       |
| Authorization requests responded to within 60 seconds                 | Cooldown +0.3      | Good                       |
| Major incident not declared by T+3:00                                 | +2 (contradiction) | Delayed command structure  |
| Authorization request unanswered for 3+ minutes                       | +2 (contradiction) | Command bottleneck         |
| No METHANE issued                                                     | +1 (prereq)        | Missing situational report |
| FCP not established                                                   | +1 (prereq)        | No command location        |
| Team operating without coordination (no IC communication for 5+ min)  | +1 (vague)         | Communication breakdown    |
| IC decision contradicts established plan without communicating change | +1 (vague)         | Inconsistent command       |

### 7.2 IC-Specific Scoring: Decision Quality

Unlike other teams, the IC is scored on the **quality of decisions**, not the speed of physical actions.

| Decision Quality Factor | Description                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Timeliness              | Was the decision made within a reasonable window? Delayed decisions have consequences that accumulate. |
| Information basis       | Did the IC seek relevant information before deciding? Or decide blindly?                               |
| Communication           | Was the decision communicated to all affected teams?                                                   |
| Adaptability            | When conditions changed, did the IC update the plan?                                                   |
| Prioritization          | Did the IC address the most critical issue first?                                                      |
| Delegation              | Did the IC delegate effectively, or try to micromanage every team?                                     |

### 7.3 End-of-Exercise Scoring (AAR)

| Metric                      | Exemplary                               | Good                         | Adequate                | Poor                             | Critical Failure        |
| --------------------------- | --------------------------------------- | ---------------------------- | ----------------------- | -------------------------------- | ----------------------- |
| Major incident declaration  | < 1 min                                 | < 2 min                      | < 3 min                 | < 5 min                          | Never declared          |
| METHANE reports             | Initial + 2 updates                     | Initial + 1 update           | Initial only            | Late initial                     | Never issued            |
| FCP establishment           | < 2 min, well placed                    | < 3 min                      | < 5 min                 | > 5 min                          | Not established         |
| Authorization response time | < 30s average                           | < 60s                        | < 90s                   | < 3 min                          | Requests ignored        |
| Cross-team coordination     | All teams aligned, conflicts resolved   | Minor misalignment           | Some coordination gaps  | Teams operating independently    | No coordination         |
| Situational awareness       | IC has accurate picture throughout      | Minor gaps                   | Some blind spots        | Significant gaps                 | IC out of touch         |
| Complication response       | Immediate, coordinated, effective       | Quick response, minor gaps   | Response within 2 min   | Delayed, disjointed              | No response             |
| Resource management         | Effective allocation throughout         | Minor sub-optimal allocation | Some resource conflicts | Significant misallocation        | No resource management  |
| Communication discipline    | Clear, consistent, acknowledged         | Mostly clear                 | Some confusion          | Frequent miscommunication        | Communication breakdown |
| Adaptability                | Plan updated effectively at each change | Most changes addressed       | Some adaptation         | Rigid adherence to original plan | No adaptation           |

---

## 8. Difficulty Scaling

| Parameter                     | Easy                    | Medium                    | Hard                                                             |
| ----------------------------- | ----------------------- | ------------------------- | ---------------------------------------------------------------- |
| Number of teams to manage     | 3-4                     | 5-6                       | 6+ with sub-teams                                                |
| Concurrent operations         | 2-3                     | 4-5                       | 6+                                                               |
| Injects requiring IC decision | 1-2                     | 3-5                       | 6+ including contradictory                                       |
| Information quality           | Clear, complete reports | Some ambiguity            | Contradictory reports, incomplete info                           |
| Inter-team conflicts          | None                    | 1-2                       | Frequent, requiring mediation                                    |
| Time pressure                 | Relaxed                 | Moderate                  | Intense (fast-developing situation)                              |
| External pressure             | None                    | Local authority inquiries | National media, political pressure, multiple stakeholder demands |
| Mutual aid complexity         | Not needed              | 1-2 requests              | Multiple requests with competing priorities                      |

---

## 9. The IC's Unique Position

The IC is the only player who:

- Sees the full heat meter and understands the scoring implications
- Has authority to override team decisions (at the cost of team autonomy)
- Can request mutual aid from off-scene
- Is responsible for the overall outcome, not just one function

The IC is also the only player who can "do nothing" — and sometimes, doing nothing is the right call. If teams are operating well, the IC's job is to monitor and stay ready, not to micromanage. Over-intervention is scored as negatively as under-intervention.

**The best IC performance looks boring from the outside**: steady communication, timely decisions, no drama. The worst IC performance is either frantic micromanagement or absent silence.

---

## 10. Doctrinal References

- **JESIP**: Joint Decision Model (JDM), shared situational awareness, joint working
- **ICS (Incident Command System)**: Unified command, span of control, management by objectives
- **NIMS (National Incident Management System)**: Command and management, preparedness, resource management
- **UK Cabinet Office**: Emergency Response and Recovery guidance, COBR activation criteria
- **College of Policing**: Major incident initial response, scene management
- **METHANE Reporting Format**: Standard major incident reporting used by UK emergency services and adopted internationally
- **ISO 22320**: Emergency management — requirements for incident response

---

_This document covers the Incident Commander role only. See `GAME_FLOW.md` for the master phase-by-phase game flow and companion team documents for other teams._
