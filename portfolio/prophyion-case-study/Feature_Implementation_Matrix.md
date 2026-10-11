# Feature Implementation Matrix (PRIVATE)

Maps the client's requirements to what Prophyion proves today and what would be new.
Status: **Implemented**, **Partial**, **Experimental**, **Planned**, **Not found**, and
**Proposed** (new work, nothing exists in the repo).
"Demonstrable" = can honestly be shown to the client.

## A. What Prophyion implements

| Capability                                                 | Status                               | Key files / functions                                                                      | Demonstrable                                          |
| ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Hidden persona definition per stakeholder                  | Implemented                          | `server/lib/stakeholderContract.ts` `StakeholderSchema`; `StakeholdersSection.tsx`         | Yes: S2                                               |
| Crowd personas (type, bias, backstory, tier)               | Implemented                          | `initial_state.npc_personas`; `SocialScenarioEditor.tsx`                                   | Yes: S2b                                              |
| Per-stakeholder conversation memory (cross-channel)        | Implemented (session scope)          | `migrations/200_stakeholder_conversations.sql`; `getConversationLog`, `appendConversation` | Partly: no UI; explained by diagram and S3 continuity |
| Judge call sees last 20 lines of the log                   | Implemented                          | `stakeholderReconsiderationService.ts` `callJudge`                                         | No (code only)                                        |
| Feed thread context (parent + up to 10 siblings)           | Implemented                          | `npcReactionService.ts`                                                                    | Yes: S3                                               |
| Multi-NPC reaction to one post                             | Implemented                          | `npcReactionService.ts` `triggerNPCReactions`                                              | Yes: S4 (authored replies)                            |
| Reaction types attack/cover/support/neutral/position       | Implemented                          | `npcReactionService.ts`                                                                    | Described, not shown by type                          |
| Seeded deterministic responder selection                   | Implemented, tested                  | `server/lib/stakeholderRecipients.ts` `pickResponders`                                     | No (logic)                                            |
| NPC-to-NPC thread simulator                                | Implemented                          | `ambientContentService.ts` (commit `927d248`)                                              | No                                                    |
| NPC identity registry                                      | Implemented                          | `ambientContentService.ts`                                                                 | No                                                    |
| Server-side verdict enforcement                            | Implemented, **untested**            | `enforceVerdict`                                                                           | No (logic)                                            |
| Placeholder scrubbing, sender identity in prompts          | Implemented (identity helper tested) | `scrubPlaceholders`; `server/lib/identity.ts`                                              | No                                                    |
| Reply coalescing and per-sender caps                       | Implemented                          | `stakeholderReplyService.ts` (45 s window, caps)                                           | No                                                    |
| Statement watchdog (contradictions in player statements)   | Implemented                          | `statementWatchdogService.ts`                                                              | Partly: S5b                                           |
| Content grader                                             | Implemented                          | `contentGraderService.ts`                                                                  | Yes: S5b                                              |
| Deterministic session sentiment (4 dimensions + composite) | Implemented                          | `socialStateUpdaterService.ts` `computeSocialState`                                        | Yes: S5a                                              |
| Sentiment history sparklines                               | Implemented                          | `social_state` series; `MetricSparkline.tsx`                                               | Yes: S5a (scripted series)                            |
| Consequence injects from threshold crossings               | Implemented                          | `evaluateConsequenceTriggers`, `generateConsequenceInject`                                 | Yes: S5c                                              |
| Condition-driven inject orchestration                      | Implemented                          | `conditionEvaluatorService.ts`; `GET /social/orchestration/session/:id`                    | Yes: S6a                                              |
| Scheduler tick (30 s)                                      | Implemented                          | `injectSchedulerService.ts`                                                                | No (timing)                                           |
| Pressure engine / executive decisions (60 s)               | Implemented                          | `engineTicker.ts`, `pressureEngineService.ts`                                              | No                                                    |
| Antagonist engine                                          | Implemented, flag-gated              | `antagonistEngineService.ts`                                                               | No                                                    |
| Extremist hive                                             | Experimental                         | `extremistHiveService.ts`                                                                  | No                                                    |
| Scenario director                                          | Experimental                         | `blueprint/scenarioDirectorService.ts`                                                     | No                                                    |
| AI teammate bots with intellect slider                     | Experimental                         | `server/services/teammates/*`                                                              | Yes: S6b                                              |
| Trainer pause / nudge of bots                              | Experimental                         | `routes/teammateBots.ts`                                                                   | Yes: S6b                                              |
| LLM hourly budget and per-session bot cap                  | Implemented                          | `chatClient.ts`; `server/env.ts` (`TEAMMATE_BOTS_MAX_LLM_PER_HOUR`=400)                    | Yes: S6b badge                                        |
| Provider abstraction OpenAI / Bedrock                      | Implemented                          | `chatClient.ts`, `chatCore.ts`                                                             | No                                                    |
| Token-usage logging per call site                          | Partial (logs only)                  | `chatClient.ts`                                                                            | No                                                    |
| Team score and after-action review                         | Implemented                          | `teamScoreService.ts`, `aarSocialMediaService.ts`                                          | No                                                    |
| Post-weighted sentiment snapshots                          | Implemented                          | `sentimentSimService.ts` `computeSessionSentiment`                                         | No                                                    |
| `applySentimentImpact`                                     | Partial (ignores `impact`)           | `sentimentSimService.ts` l.104                                                             | No                                                    |
| `stakeholder_state` table                                  | Partial (schema only)                | `migrations/203_decision_layer.sql`                                                        | No                                                    |
| `registerStakeholderContextProvider`                       | Partial (no caller)                  | `stakeholderReplyService.ts` l.192                                                         | No                                                    |
| Cross-session memory                                       | Not found                            | n/a                                                                                        | No                                                    |
| Embedding / vector retrieval                               | Not found                            | n/a                                                                                        | No                                                    |
| Personality-drift scoring                                  | Not found                            | n/a                                                                                        | No                                                    |
| Per-NPC sentiment                                          | Not found                            | n/a                                                                                        | No                                                    |
| Dollar-cost tracking / usage table                         | Not found                            | n/a                                                                                        | No                                                    |
| Simulation speed multiplier                                | Not found                            | n/a                                                                                        | No                                                    |
| Autonomous agent-to-agent turn-taking                      | Not found                            | n/a                                                                                        | No                                                    |

## B. Client requirements vs Prophyion

| Client requirement                            | Closest Prophyion evidence                                                                                     | Gap                                                          | Marked in PDF as                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 8 to 10 agents, separate personalities        | Persona definitions; up to 8 NPC replies per event; up to 8 bots per session (`TEAMMATE_BOTS_MAX_PER_SESSION`) | No trait-profile model beyond free text and constraint lists | A: Implemented. B: new personas                       |
| Human coach per agent                         | Trainer can nudge AI teammates (experimental)                                                                  | No coach role, no coach-agent link                           | A: Partial. B: coach accounts                         |
| 5 stored coaching lessons per agent           | none                                                                                                           | Entire feature                                               | B only (stated: no coaching-lesson model)             |
| Persistent memory                             | Session-scoped stakeholder log                                                                                 | Cross-match persistence, memory-rules, change history        | A: Implemented (session). B: cross-match              |
| 2-agent duels with hidden priorities          | Hidden `will_not_disclose`, criteria, hard constraints enforced server-side                                    | Agent-vs-agent; priority payoffs; offer protocol             | A: Partial. B: duel engine                            |
| 5-agent group negotiations                    | Multi-NPC reactions, server-orchestrated                                                                       | Agent turn-taking; offers between agents                     | A: Partial. B: two options                            |
| Deterministic scoring independent of LLM      | Sentiment composite and verdict enforcement are rules; LLM graders are inputs                                  | Offer-based payoff scoring                                   | A: Implemented (with LLM inputs noted). B: rules-only |
| Complete transcripts, memory changes, history | Stored logs, session events, AAR                                                                               | Immutable match transcripts; memory diffs                    | A: Implemented. B: diffs                              |
| Coached vs uncoached comparison               | none                                                                                                           | Entire feature                                               | A: "Not in Prophyion"                                 |
| API usage and match cost tracking             | Token logging; hourly budget                                                                                   | Ledger; cost; per-match attribution                          | A: Partial. B: ledger                                 |

## C. Proposed components (nothing exists)

| Component                                                  | Status   |
| ---------------------------------------------------------- | -------- |
| Agent Personality + Five-Lesson Memory                     | Proposed |
| Conversation / Negotiation Engine                          | Proposed |
| Deterministic Rules and Scoring                            | Proposed |
| Match History and Behavioral Analysis                      | Proposed |
| Approach 1: deterministic round-robin                      | Proposed |
| Approach 2: intent-driven turn-taking with a floor manager | Proposed |

Suggested framing for the client (matches PDF): round-robin as the reproducible scored
baseline; floor manager as an experimental mode. The only Prophyion precedent is seeded,
capped responder selection (`pickResponders`), which is not turn-taking.
