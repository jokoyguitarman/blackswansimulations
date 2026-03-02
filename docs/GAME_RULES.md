# Game rules (core)

Generic rules for how the game system and decisions work. They apply to all scenarios. Scenario-specific content (teams, situations, locations, environmental conditions) lives in [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md) and in the database per scenario.

---

## Decisions

- Players propose decisions; optional approvers can approve or reject. When a decision is executed, it updates session state, is classified (e.g. for type and tags), and is evaluated against gates and environmental checks.
- Decisions can affect: evacuation zones, resource allocations, public sentiment, and (when implemented) environmental state (e.g. marking a route or area as managed).

---

## Gates and checks

- **Approval gate:** Optional; required approvers must approve before execution.
- **Content / anti-gaming gates:** Scenario-defined gates that require specific decisions from specific teams by a certain time; vague or missing decisions can trigger punishment injects or block objective progress.
- **Environmental prerequisite gate:** When a decision involves evacuation or vehicle deployment, the system checks whether relevant routes/corridors are in a managed state. If not, the decision gets a degraded outcome (e.g. delayed convoy inject) and robustness/objective penalty. The decision is not blocked.
- **Location-condition gate:** When a decision references a scenario location (e.g. triage site, evac center), the system checks that location's conditions. If the location is bad (low suitability, negative factors) and not cleared, the same kind of penalty applies. Again, the decision is not blocked.

---

## Injects and consequences

- **Condition-based injects:** Injects fire when conditions to appear are met and conditions to cancel are not. Time is used only as an eligibility bound (earliest time the inject can be considered), not as the trigger.
- **Type A (opportunistic):** External actors exploit an opening; eligibility is time-bound so these do not all fire in the first minutes.
- **Type B (direct consequence):** Outcome follows from team decision + environment; can fire anytime after evaluation (minimal or no eligibility delay).
- **Dynamic consequences:** The AI can generate consequence injects from the current game state, checkpoints, impact matrix, and robustness. Pathway outcomes can be selected by robustness band.
- **No double-hit:** The same consequence (e.g. congestion on a specific exit) is not delivered both as a pathway outcome and as a pre-authored inject; cancel conditions or a single source prevent that.

---

## Environmental state

- **Positive factors:** Routes or areas that are already in a good state (e.g. clear road, low crowd). Represented as managed by default. Players can use them without prior action.
- **Negative factors:** Problems (e.g. congestion, crowded area) that exist until the player addresses them. Represented as active and unmanaged; when the player acts (e.g. coordinate traffic), the factor becomes managed.
- The first layer of decision evaluation asks, in effect: are there external factors (environmental or location-based) that affect this decision and that the player has not addressed? If yes, the decision is penalised or gets a degraded outcome; the decision still executes.

---

## Scoring and objectives

- Robustness is computed per decision and can be capped when environmental or location conditions are bad (e.g. unmanaged traffic, bad site choice).
- Objectives are tracked per session; penalties and bonuses apply from gates, environmental checks, and decision quality. Session score is derived from objective progress and weights.

---

## Reference

- Scenario-specific teams, situations, locations, and environmental conditions: [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md)
- Implementation order: [INJECT_ENGINE_DEVELOPMENT_PLAN.md](INJECT_ENGINE_DEVELOPMENT_PLAN.md)
