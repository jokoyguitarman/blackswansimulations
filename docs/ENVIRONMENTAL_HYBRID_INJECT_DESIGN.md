# Environmental & Hybrid Inject System — Design Overview

This document captures two interconnected game design ideas:

1. **Environmental State Layer** — ambient real-world conditions (traffic, crowd density, terrain) that exist independently of player decisions and silently penalise teams who ignore them before taking consequential actions.
2. **Hybrid Inject Engine** — a replacement for purely time-based inject scheduling, combining a dynamic AI consequence engine with a "lying-in-wait" pool of pre-authored injects that fire only when the game world reaches the right conditions (the perfect storm).

---

## Diagram 1 — Overall System Architecture

How the two new systems connect to the existing game loop.

```mermaid
flowchart TD
    subgraph session [Session Start]
        ScenarioLoad[Scenario Loads] --> EnvLoad[Load env seed choose random variant from DB]
        EnvLoad --> EnvState[Environmental State in session_state JSONB]
    end

    subgraph envLoop [Environmental Simulation Loop - every 5 min]
        EnvState --> TimeSimulator[Time-Based Congestion Simulator]
        TimeSimulator --> EnvState
    end

    subgraph decisionFlow [Player Decision Flow]
        PlayerDecision[Player proposes decision] --> ApprovalGate[Approval Gate]
        ApprovalGate --> EnvGate[Environmental Prerequisite Gate]
        EnvState --> EnvGate
        EnvGate --> Execution[Decision Executed]
    end

    subgraph hybridEngine [Hybrid Inject Engine - every 5 min]
        Execution --> AIEngine[Dynamic AI Consequence Engine]
        EnvState --> AIEngine
        Checkpoints[Checkpoints + Impact Matrix] --> AIEngine
        RobustnessScore[Robustness Score] --> AIEngine
        AIEngine --> GeneratedInject[Generated Inject fires]

        LyingInWaitPool[Lying-in-Wait Pool] --> ConditionChecker[Condition Checker]
        EnvState --> ConditionChecker
        RobustnessScore --> ConditionChecker
        ObjectiveProgress[Objective Progress] --> ConditionChecker
        ConditionChecker --> |"threshold met + cooldown clear"| PriorityQueue[Priority Queue]
        PriorityQueue --> DormantInject[Authored Inject fires]
    end

    subgraph scoring [Scoring Impact]
        Execution --> RobustnessScore
        EnvGate --> |"unmanaged state at decision time"| RobustnessPenalty[Robustness Penalty Applied]
        RobustnessPenalty --> RobustnessScore
    end
```

---

## Diagram 2 — Environmental Prerequisite Gate

What happens when a player sends evacuation orders or emergency vehicles without managing traffic first. The gate does not hard-block the action — it determines whether the outcome is full effectiveness or degraded effectiveness.

```mermaid
flowchart TD
    Action[Player submits evacuation or vehicle deployment decision]
    Action --> GateCheck{Environmental Prerequisite Gate}

    GateCheck --> |"road segments in corridor managed?"| Cleared{Gate Cleared?}

    Cleared --> |"YES - traffic was addressed"| FullEffect[Decision proceeds at full effectiveness]
    Cleared --> |"NO - traffic was ignored"| Degraded[Decision proceeds with degraded outcome]

    FullEffect --> NormalInject["FIELD UPDATE: Convoy proceeding without obstruction. ETA 14 min."]
    Degraded --> DegradedInject["FIELD UPDATE: Severe gridlock on Nicoll Highway. ETA extended from 12 to 47 min."]
    Degraded --> RobustnessPenalty[Robustness score reduced]
    Degraded --> ObjectivePenalty[Evacuation objective penalised]

    RobustnessPenalty --> FutureInjects[Affects what AI generates next]
```

---

## Diagram 3 — Hybrid Inject Engine Detail

The two categories of injects and their distinct trigger logic. Category 1 is generated dynamically by AI from the live game state. Category 2 is pre-authored by scenario designers and sits dormant until the world reaches the right conditions.

```mermaid
flowchart LR
    subgraph cat1 [Category 1 - Dynamic AI Consequences]
        GameStateSnap[Live Game State Snapshot]
        ImpactMatrix[Impact Matrix]
        Gates[Checkpoint + Gate Results]
        Robustness[Robustness Score]

        GameStateSnap & ImpactMatrix & Gates & Robustness --> AIEngine[AI Consequence Engine]
        AIEngine --> |"constructs narrative from state"| GeneratedInject[Generated Inject]
    end

    subgraph cat2 [Category 2 - Lying in Wait]
        AuthoredPool[Pre-Authored Inject Pool]
        AuthoredPool --> ConditionsManifest["Conditions Manifest (multi-factor)"]
        LiveState[Live Game State] --> Scheduler[Inject Scheduler - 5 min cycle]
        ConditionsManifest --> Scheduler
        Scheduler --> |"N of M conditions met"| Eligible[Inject becomes Eligible]
        Eligible --> PriorityQueue[Priority Queue]
        PriorityQueue --> |"cooldown window clear"| Fired[Inject fires]
    end
```

---

## Diagram 4 — Perfect Storm Conditions for Key Authored Injects

The multi-factor conditions that unlock each of the three critical "patience-testing" injects. A threshold model (N of M) is used so that a single technicality does not permanently block a contextually correct inject.

```mermaid
flowchart TD
    subgraph journalist [Journalist Ambush Inject]
        J1[No media management decision made]
        J2[No perimeter establishment decision made]
        J3[Crowd density above 0.6 threshold]
        J4[Prior social media rumour inject has fired]
        J1 & J2 & J3 & J4 --> JCheck{"3 of 4 conditions met?"}
        JCheck --> |YES| JFire[Journalist Ambush inject fires]
    end

    subgraph voicenote [Fake Social Media Voice Note Inject]
        V1[No official public statement issued by PIO]
        V2[Public communications channel inactive]
        V3[Civilian panic or rumour inject already fired]
        V1 & V2 & V3 --> VCheck{"2 of 3 conditions met?"}
        VCheck --> |YES| VFire[Misinformation voice note inject fires]
    end

    subgraph triage [Triage Area Photography Inject]
        T1[Triage zone established as incident location]
        T2[No patient privacy or access control decision made]
        T3[No triage perimeter security decision made]
        T4[Crowd density in triage zone elevated]
        T1 & T2 & T3 & T4 --> TCheck{"3 of 4 conditions met?"}
        TCheck --> |YES| TFire[Photography in triage area inject fires]
    end
```

---

## Diagram 5 — Traffic State Lifecycle

How environmental state is loaded at session start (from a chosen pre-authored variant) and, optionally, evolves over simulated time — and how each state affects gate outcomes.

```mermaid
stateDiagram-v2
    [*] --> Seeded : Session starts, load chosen env variant from DB

    Seeded --> Baseline : Initial state from chosen pre-authored variant

    Baseline --> Congested : Time simulator escalates congestion
    Congested --> Baseline : Time simulator eases congestion naturally

    Baseline --> Managed : Player makes traffic management decision
    Congested --> Managed : Player makes traffic management decision

    Managed --> GateCleared : Environmental Prerequisite Gate passes
    Baseline --> GateCleared : Environmental Prerequisite Gate passes
    Congested --> GateFailed : Environmental Prerequisite Gate fails

    GateCleared --> FullEffectOutcome : Normal inject + full robustness
    GateFailed --> DegradedOutcome : Degraded inject + robustness penalty
```

---

## Key Design Principles

**Environmental state is ambient, not reactive.** Traffic congestion evolves on its own timeline regardless of player actions. It is the player's responsibility to notice and manage it — the game does not prompt them to do so.

**Gates degrade, they do not block.** Failing an environmental prerequisite gate never prevents an action from being taken. It determines which version of reality follows from that action. Players can always act; they just live with the consequences of acting without preparation.

**Authored injects are timed by context, not by clock.** The "perfect storm" model means that scenario designers write the most instructionally rich injects once, with intent, and the engine surfaces them at the moment they will have the greatest training impact — when the game world has organically created the conditions for them.

**AI handles the mechanical; humans handle the human.** Dynamic AI consequences cover cause-and-effect logic (delays, resource depletion, cascade incidents). Pre-authored injects cover human behavioural dynamics (journalists, misinformation, public panic) that require crafted narrative to land correctly.

**Priority queuing prevents cascade overload.** If multiple lying-in-wait injects become eligible simultaneously, the one with the most conditions met fires first. A cooldown window prevents the next eligible inject from firing immediately after, preserving the instructional weight of each individual event.

---

## Implementation

For a step-by-step implementation plan (database, environmental state service, condition evaluator, inject engine, environmental gate, map, scenario data, cleanup), see [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md). Per-step specifics live in [roadmap/](roadmap/).
