# C2E Sector Standards (ICS / WHO / ICRC-UNOCHA)

These sector standards are used to calibrate **robustness**, **environmental consistency**, and **relevance/detail** in decision evaluation for the C2E Bombing at Community Event scenario. Decisions that specify ratios, capacities, protocols, or procedures aligned with these standards are scored more favourably; vague or absent specifications are penalised.

| Team       | Standard Metric                        | Guideline/Requirement                         | Source/Reference                            |
| ---------- | -------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Evacuation | Marshal-to-Evacuee Ratio               | 1 marshal per 10–20 evacuees                  | Incident Command System (ICS)               |
|            | Predefined Routes/Traffic Flow         | Preplanned, clear, congestion-managed routes  | ICS Evacuation Planning                     |
|            | Assembly Area Capacity                 | 125% of expected evacuees                     | ICS Assembly Area Guidelines                |
| Triage     | Triage Staff-to-Critical Patient Ratio | 1 triage personnel per 5 critical patients    | WHO Mass Casualty Incident (MCI) Guidelines |
|            | Triage Protocols (e.g., START)         | Use START (Simple Triage and Rapid Treatment) | WHO/START Protocols                         |
|            | Triage Zone Capacity                   | Triage zone handles ~50 patients at once      | WHO MCI Setup Standards                     |
|            | Hospital Communication Lines           | Real-time comms with nearby hospitals         | WHO MCI Coordination Guidelines             |
| Media      | Media Spokesperson                     | One designated spokesperson                   | ICRC/UNOCHA Media Guidelines                |
|            | Media Zone Setup                       | Safe zone for media briefings                 | ICRC/UNOCHA Standard Media Protocols        |
|            | Media Briefing Frequency               | Coordinated updates every 1–2 hours           | UNOCHA Crisis Media Framework               |

The same standards are stored in the scenario’s `insider_knowledge.sector_standards` (text summary) and, for escalation context, `insider_knowledge.baseline_escalation_factors` (risks that reference these standards). See [GAME_SPECIFICS_AND_LOCATIONS.md](GAME_SPECIFICS_AND_LOCATIONS.md) for how they affect scoring.
