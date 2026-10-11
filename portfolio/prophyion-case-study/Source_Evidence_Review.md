# Prophyion – Source Evidence Review (PRIVATE)

Internal document. Not for the client. It contains repo paths, function names and
details about real incidents that must not appear in client material.

Method: read-only inspection of the repository at branch base `master`
(1,008 commits, 231 migrations). No application code or configuration was modified.
No production data was touched and no paid LLM call was made. `npm test` was run with
placeholder environment variables: 283 tests, all passing.

Status vocabulary: **Implemented** (works end to end in code), **Partial** (code exists
but incomplete, unused, or narrow), **Experimental** (flag-gated or off by default in
production), **Planned** (documented intent only), **Not found** (searched, absent).

---

## 1. System overview (Part 1)

### 1.1 Stack (verified from `package.json`, `server/env.ts`, docs)

| Layer           | Evidence                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend        | React 19, Vite 7, TypeScript, Tailwind (`frontend/`)                                                                                                                   |
| Backend         | Node.js + Express 4 (`server/`), Socket.IO realtime, Zod validation, pino logging                                                                                      |
| Data            | Supabase: Postgres, Auth, Storage, RLS. 231 SQL migrations in `migrations/`                                                                                            |
| LLM             | One shared client: `server/services/ai/chatClient.ts` + `chatCore.ts`                                                                                                  |
| Providers       | `AI_PROVIDER` = `openai` (default) or `bedrock`                                                                                                                        |
| Models          | OpenAI tiers: fast `gpt-4o-mini`, standard `gpt-5.2`, vision `gpt-5.1`. Bedrock defaults: `us.openai.gpt-5.6-luna` (fast), `us.openai.gpt-5.6-terra` (standard/vision) |
| Client features | Structured JSON output (`chatJson`), hourly budget, serial queue, retries, per-label stats, token-usage logging                                                        |

The model names above come from defaults in code. The deployed configuration was not
inspected, so do not state which models production actually uses.

### 1.2 Three kinds of AI participant

1. **Stakeholders**: named characters with hidden persona fields, stored in
   `scenarios.initial_state.stakeholders`.
   Schema: `StakeholderSchema` in `server/lib/stakeholderContract.ts`.
2. **Crowd personas** (social-feed NPCs): stored in `scenarios.initial_state.npc_personas`.
   Fields include handle, name, type (`npc_public`/`media`/`politician`/`influencer`),
   personality, bias, follower_count, backstory, posting_pattern, specific_claims, tier, country.
   A `fact_sheet` sits beside them. "Persona twins" mirror stakeholders into personas so the
   same character can appear in the feed.
3. **AI teammate bots** (`server/services/teammates/*`): LLM "players" that join a human team.

### 1.3 Feature table

Visual column: Y = captured, N = not capturable, P = captured indirectly.

| #   | Feature                                                  | What it does                                                                                                                                        | Key files / functions                                                                                                                                        | Status                                                              | Visual                                        |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Stakeholder persona definition                           | Hidden character sheet: personality, stance, knowledge[], will_not_disclose[], grievance, resolution_criteria[], persuadability, hard_constraints[] | `server/lib/stakeholderContract.ts` (`StakeholderSchema`); editor `StakeholdersSection.tsx`                                                                  | Implemented                                                         | Y (S2)                                        |
| 2   | Crowd persona definition                                 | Per-handle persona: type, bias, backstory, posting pattern, tier, country                                                                           | `initial_state.npc_personas`; `socialCrisisGeneratorService.ts`; `SocialScenarioEditor.tsx`                                                                  | Implemented                                                         | Y (S2b)                                       |
| 3   | Stakeholder replies (email, team chat, messenger, phone) | Player message -> coalesced judge call -> reply plan, verdict and side effects                                                                      | `stakeholderReplyService.ts` (`handlePlayerMessage` l.377, `recordNpcReply`, `resolvePlayerRef`); `stakeholderReconsiderationService.ts` (`callJudge` l.397) | Implemented                                                         | P                                             |
| 4   | Stakeholder memory                                       | One conversation log per (session, stakeholder) across channels                                                                                     | `migrations/200_stakeholder_conversations.sql`; `getConversationLog` (l.44, limit 40), `appendConversation` (l.120)                                          | Implemented, session-scoped                                         | P (S3 shows thread continuity, not the table) |
| 5   | Feed NPC pile-on                                         | Reaction to a post by multiple personas, one batched LLM call, staggered delivery                                                                   | `npcReactionService.ts` (`triggerNPCReactions` l.23)                                                                                                         | Implemented                                                         | Y (S4)                                        |
| 6   | Feed NPC thread context                                  | Parent post plus up to 10 sibling replies rebuilt from `social_posts` on each reaction                                                              | `npcReactionService.ts`                                                                                                                                      | Implemented                                                         | Y (S3)                                        |
| 7   | NPC-to-NPC thread simulator                              | On a tick, picks active threads and continues them in character (existing participant 70%, new commenter 30%)                                       | `ambientContentService.ts` (commit `927d248`)                                                                                                                | Implemented                                                         | N (needs live tick)                           |
| 8   | Inject replies by NPCs                                   | Scenario injects spawn NPC replies                                                                                                                  | `feedEngineService.ts` (`spawnNPCReplies`)                                                                                                                   | Implemented                                                         | N                                             |
| 9   | NPC DMs / DM replies                                     | NPCs message players and answer DMs                                                                                                                 | `npcMessengerService.ts` (`triggerNPCMessages`, `triggerNPCDMReply`)                                                                                         | Implemented                                                         | N                                             |
| 10  | Antagonist engine                                        | Hostile account behaviour, escalates with `escalation_risk`                                                                                         | `antagonistEngineService.ts` (`runAntagonistEngine`)                                                                                                         | Implemented (flag-gated)                                            | N                                             |
| 11  | Extremist hive                                           | Opportunistic extremist posts, thread-exploitation replies, faction personas from the blueprint                                                     | `extremistHiveService.ts`; commits `bf328eb`, `79e3f70`                                                                                                      | Experimental (flag-gated)                                           | N                                             |
| 12  | Scenario director                                        | Blueprint-driven director invoked by the scheduler                                                                                                  | `blueprint/scenarioDirectorService.ts`; `ENABLE_SCENARIO_DIRECTOR` (on in production unless disabled)                                                        | Experimental                                                        | N                                             |
| 13  | Inject scheduler                                         | 30 s tick, only for `in_progress` sessions                                                                                                          | `injectSchedulerService.ts`                                                                                                                                  | Implemented                                                         | P (S6a)                                       |
| 14  | Condition-driven injects                                 | `conditions_to_appear` evaluated against state (e.g. `sentiment_below_30`)                                                                          | `conditionEvaluatorService.ts`; route `GET /social/orchestration/session/:id`                                                                                | Implemented                                                         | Y (S6a)                                       |
| 15  | Pressure engine / executive decisions                    | Separate 60 s ticker                                                                                                                                | `engineTicker.ts`, `pressureEngineService.ts`; `ENABLE_EXECUTIVE_DECISIONS` (default on)                                                                     | Implemented                                                         | N                                             |
| 16  | Responder selection                                      | Deterministic seeded stable-hash selection with a cap                                                                                               | `server/lib/stakeholderRecipients.ts` (`pickResponders` l.68); test `stakeholderRecipients.test.ts`                                                          | Implemented                                                         | N                                             |
| 17  | Statement watchdog                                       | LLM scan of player public statements for contradictions and risks                                                                                   | `statementWatchdogService.ts` (commit `2ad641b`)                                                                                                             | Implemented                                                         | P (graded replies S5b)                        |
| 18  | Content grader                                           | LLM grading of player posts (`sop_compliance_score`)                                                                                                | `contentGraderService.ts`                                                                                                                                    | Implemented                                                         | Y (S5b)                                       |
| 19  | AI teammate bots                                         | Perceive -> triage -> decide -> execute -> remember -> sleep loop; intellect slider; blackboard                                                     | `teammates/{bot,brain,perception,memory,intellect,llmQueue,executor}.ts`; routes `teammateBots.ts`; commit `5ffaeac`                                         | Experimental (off in production unless `ENABLE_TEAMMATE_BOTS=true`) | Y (S6b)                                       |
| 20  | Trainer nudge / pause of bots                            | `POST /:userId/nudge` plus pause/resume                                                                                                             | `routes/teammateBots.ts` l.175; `TeammateConsole.tsx`                                                                                                        | Experimental                                                        | Y (S6b)                                       |
| 21  | Session-global sentiment state                           | See section 4                                                                                                                                       | `socialStateUpdaterService.ts` (`computeSocialState` l.122)                                                                                                  | Implemented                                                         | Y (S5a)                                       |
| 22  | Post-weighted sentiment + snapshots                      | See section 4                                                                                                                                       | `sentimentSimService.ts`                                                                                                                                     | Implemented (one function partial)                                  | P                                             |
| 23  | Consequence injects                                      | Threshold crossings -> LLM-written inject                                                                                                           | `evaluateConsequenceTriggers` (l.747); `ambientContentService.ts` `generateConsequenceInject` (l.1328)                                                       | Implemented                                                         | Y (S5c)                                       |
| 24  | Team scoring and AAR                                     | 45% content AI grades, 30% expected tasks, 15% role_fit, 10% collaboration                                                                          | `teamScoreService.ts`, `aarSocialMediaService.ts`, `playerLedgerService.ts`                                                                                  | Implemented                                                         | N                                             |
| 25  | Team heat meter                                          | Measures decision quality, not public opinion                                                                                                       | `heatMeterService.ts`                                                                                                                                        | Implemented                                                         | N                                             |
| 26  | Realtime                                                 | Socket.IO broadcast of `social_state.updated` and others                                                                                            | `socialStateUpdaterService.ts` l.733                                                                                                                         | Implemented                                                         | N                                             |
| 27  | Logging / observability                                  | pino logs; per-label LLM stats; token usage logged; no usage table                                                                                  | `chatClient.ts`, `chatCore.ts`                                                                                                                               | Partial                                                             | N                                             |
| 28  | `stakeholder_state` table                                | Defined in `migrations/203_decision_layer.sql`, no TypeScript caller                                                                                | migration only                                                                                                                                               | Partial (schema only)                                               | N                                             |
| 29  | `registerStakeholderContextProvider`                     | Hook to inject extra context into stakeholder prompts, no production caller                                                                         | `stakeholderReplyService.ts` l.192                                                                                                                           | Partial (unused)                                                    | N                                             |
| 30  | Simulation speed control                                 | Pause/status exist; no speed multiplier                                                                                                             | session status routes                                                                                                                                        | Not found (speed)                                                   | N                                             |

### 1.4 Orchestration summary

Hub-and-spoke, server-driven. There is **no** autonomous agent-to-agent turn-taking and
no NPC message bus.

- `injectSchedulerService` tick (30 s, `in_progress` sessions only): refresh social state,
  publish due injects, engagement tick (`engagementAlgorithmService.runEngagementTick`),
  ambient posts and NPC thread simulation, antagonist, extremist hive, scenario director.
- `engineTicker`: separate 60 s pressure engine.
- Event-driven: `POST /api/social/posts` and thread replies call `triggerNPCReactions`.
- Player DMs and stakeholder messages go through `npcMessengerService` /
  `stakeholderReplyService`.

---

## 2. Personality and memory (Part 2)

### 2.1 Identity and persistence

- Stakeholder and persona definitions live in scenario JSON in Postgres, so they persist and
  are reused by every session of that scenario.
- The Zod contract (`StakeholderSchema`) validates hidden fields on save.
- Runtime identity of NPCs inside a session: commit `927d248` introduced a session-level NPC
  identity registry so handles and personalities stay consistent across threads.

### 2.2 Memory

| Memory                             | Where                                                                            | Scope                                        | Notes                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Stakeholder conversation log       | `stakeholder_conversations` (migration 200)                                      | One per (session, stakeholder), all channels | Read with limit 40; the judge sees the last 20 lines (`callJudge`) |
| Feed thread context                | rebuilt from `social_posts`                                                      | One thread                                   | Parent plus up to 10 sibling replies                               |
| Teammate bot memory                | in-process `BotMemory`, rebuilt from the DB on restart (`perception.seedMemory`) | One session                                  | Not persisted as its own store                                     |
| Bot commitments / prior statements | teammate prompts: "YOUR PRIOR OFFICIAL STATEMENTS (never contradict these)"      | One session                                  |                                                                    |

Retrieval is a recency window. There is no semantic or embedding retrieval. There is **no**
cross-session or cross-scenario memory, and no per-persona memory table for feed NPCs.

Detail worth knowing: `buildCharacterPrompt` accepts the log (`_log`) but does not use it.
History is added in the judge prompt instead. Do not describe the character prompt as
containing history.

### 2.3 Contradictory context and consistency guards (all implemented unless noted)

- `buildCharacterPrompt`: includes confirmed facts and a "do not contradict" rule.
- `enforceVerdict` (`stakeholderReconsiderationService.ts` l.261): deterministic server-side
  check of the LLM verdict (persuadability gating, hard constraints, criteria threshold).
  The LLM proposes; code decides.
- `scrubPlaceholders` (l.369): removes `[Name]`-style placeholders.
- `PlayerRef`/`resolvePlayerRef`: the NPC is told who is writing.
- `noteLeaks()` (`stakeholderGenerationService.ts` l.440): at scenario-generation time, rejects
  a public contacts note that leaks the grievance or inject titles. Not a runtime guard.
- Reply coalescing: one judge call per stakeholder per 45 s.
- Per-sender caps: 6 per 10 minutes; session ceiling of 60 for bots only.
- Statement watchdog: LLM scan for contradictions in the player's own statements.
- Teammate prompts: prior official statements and commitment tracking.

### 2.4 Drift safeguards and evolution

- No numeric drift scorer, no embedding comparison, no hallucination detector.
- "Evolution": stakeholder state changes only through verdicts (resolved/not) inside a
  session. Personas do not change between sessions. `stakeholder_state` (schema only) was
  presumably intended for richer evolution but is unused.

### 2.5 Tests

Relevant passing tests: `stakeholderContract`, `stakeholderRecipients` (`pickResponders`),
`identity`, `extremistDoctrine`, `pressureEngine`, `teammates/intellect`, `teammates/triage`,
`chatCore`, decision cores.
**Not covered by tests:** `enforceVerdict`, `scrubPlaceholders`, `buildCharacterPrompt`,
`triggerNPCReactions`, sentiment formulas. Do not say these are tested.

### 2.6 Documented fix (the only supported incident)

Source: `docs/session-bugfix-spec-2026-09-20.md` sections 9 to 11; commit `2059028`
(2026-09-21).

- Symptom: NPC emails opened with "Hi [Name]" or an initials-style salutation, and an internal
  NPC argued instead of carrying out an executive's instruction.
- Cause (per the spec): NPCs were never told who was writing, and there was no chain-of-command rule.
- Fix: `req.user.displayName` from `user_profiles`; `server/lib/identity.ts`
  (`displayNameOf`, `handleFor`, `firstNameOf`, unit-tested); sender passed into the judge
  prompt; placeholder scrubbing; an internal-staff rule; rate-limit changes so bots do not
  starve humans.
- **Private:** the spec names a real client run and real people. The client PDF uses only a
  generic one-line description. Do not name the client, run or people anywhere public.
- Caveat: I verified the commit and spec text. I did not re-run the original failure.

---

## 3. Multi-agent interaction (Part 3)

| Question                    | Finding                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What triggers NPC activity? | Player post/reply (`POST /api/social/posts`), 30 s tick, injects, DMs, stakeholder messages, official-statement scrutiny                                                                                   |
| Human vs agent responders   | A human player can be the only "agent-facing" party. Bots (experimental) can fill human roles. Stakeholders only ever respond to players (or bots)                                                         |
| Who responds?               | Feed: per-persona probabilistic gates by type/bias/format, country pool. Stakeholders: `pickResponders` (deterministic, seeded, capped)                                                                    |
| Multiple NPCs per event     | Yes. Caps: 6 top-level post, 5 reply, 8 official page. One batched `chatJson` call; delivery staggered with `setTimeout` 3 to 30 s. Reaction types: attack, cover, support, neutral, position (competitor) |
| Context                     | Thread context from the DB, persona record, fact sheet, official-statement grades                                                                                                                          |
| Influence between agents    | Indirect only: shared `social_state`, stored posts that later prompts read. NPC-to-NPC replies come from the server's thread simulator, not from agents addressing each other                              |
| Conversation state          | Stored in DB (`social_posts`, `stakeholder_conversations`); not held in agent memory                                                                                                                       |
| Autonomous turn-taking      | **Not implemented.** Do not claim it                                                                                                                                                                       |

---

## 4. Sentiment mechanics (Part 4)

Not scientifically validated. It is training-simulation logic.

### 4.1 `social_state` (primary meters)

- Scope: **one session-global object**, `sessions.current_state.social_state`. No per-NPC,
  per-organisation or per-audience meters.
- Computed by `computeSocialState` (`socialStateUpdaterService.ts` l.122): deterministic,
  recomputed every tick from posts, player actions and flags.
- Dimensions: `public_trust`, `community_safety` (labelled "Stakeholder Confidence" in the UI),
  `narrative_control`, `escalation_risk`.
- Composite: `0.2*trust + 0.2*safety + 0.4*narrative_control + 0.2*(100 - escalation)`;
  x1.1 if strategic_ratio > 0.4 and actions > 5; x0.85 if strategic_ratio < 0.2 and actions > 5;
  clamped 0 to 100.
- Hybrid inputs: `contentGraderService` (`sop_compliance_score`), `statementWatchdogService`
  (`crisis_standards`: transparency, consistency, posture, victim-centring). These are LLM
  outputs feeding a deterministic formula.
- Persist and broadcast: `social_state.updated` over Socket.IO.
- Visualisation: `TrainerSimDashboard` (trainer only). Players do not see the meters.

### 4.2 Causes and feedback

- Causes: scored posts, misinformation handling, official statement timing and quality,
  strategic vs reactive action ratio.
- Feedback into the simulation: `evaluateConsequenceTriggers` (threshold crossings) ->
  `generateConsequenceInject` (LLM-written text) ; `conditionEvaluatorService` injects
  (`sentiment_below_30` etc.); `escalation_risk` drives antagonist, pressure and hive cadence.

### 4.3 `sentimentSimService.computeSessionSentiment`

Separate post-weighted score: baseline 65; hateful +5 x (virality/100); responded -2;
supportive +3; negative +2; misinformation +3 (flagged -1.5). Snapshots in
`sentiment_snapshots`, used for AAR charts. `applySentimentImpact` (l.104) ignores its
`impact` argument: **Partial**.

### 4.4 Others

- `heatMeterService`: team heat meter measures decision quality, not public opinion.
- `media_state.public_sentiment` (1 to 10) exists for the field-ops module.
- Trainer help text in `TrainerSimDashboard` is partly outdated against the composite formula.

### 4.5 How effectiveness is measured

Only by (a) the team score and AAR, (b) time-to-first-response and time-to-official-statement
shown on the dashboard, and (c) graded player statements. There is no study, calibration or
comparison to real audiences. Do not use "accurate", "validated" or "predictive".

---

## 5. Screenshots (Part 5): provenance and honesty

**Important:** the sandbox had no database, Docker, Supabase project or LLM keys. The
real application therefore could not run end to end.

Method used:

1. The **unmodified** frontend ran under Vite (`localhost:3002`).
2. A local Node stub (`_build/stub-server.mjs`) answered the app's `/api/*`, `/auth/v1/user`
   and `/rest/v1/*` calls with **synthetic fixtures** (`_build/fixtures.mjs`).
3. Playwright + Chrome captured 2x PNGs (`_build/capture.mjs`).

So the UI, layout, labels and component behaviour are real. The data is not: NPC reply
text, handles, counts, gauge values and series are **authored fixtures**, not live LLM output.
The gauge composite is computed with a function that reproduces the real formula
(`comp()` in fixtures). Every client-facing caption says "fictional / authored / no live LLM
call". Names are invented (Northgate Dairy Co-op, Mara Vance, etc.; user "Jordan Ellis").

| Req | File (in `screenshots/`)                                                                                                 | What it shows                                                                 | Caveat                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| S1  | `01_simulated_social_environment.png`                                                                                    | Z feed in the desktop shell                                                   | Fixture posts                                            |
| S2  | `02_npc_persona_configuration.png`, `02b_crowd_personas.png`                                                             | Hidden-character editor; crowd personas section                               | Real editor, fixture persona                             |
| S3  | `03_conversation_context_thread.png`                                                                                     | Thread continuity: NPC -> player -> NPC                                       | Replies authored. Shows continuity, not the memory table |
| S4  | `04_multiple_npcs_respond_to_one_event.png`                                                                              | Official statement with five persona replies                                  | Replies authored; real engine not run                    |
| S5  | `05a_sentiment_gauges.png`, `05b_graded_player_responses.png`, `05c_consequence_log.png`, `05d_stakeholder_outcomes.png` | Gauges with sparklines, graded replies, consequence log, stakeholder outcomes | Scripted five-state series                               |
| S6  | `06a_state_driven_orchestration.png`, `06b_ai_teammate_console.png`                                                      | Orchestration panel; AI teammate console                                      | Fixture bots                                             |

**Not capturable honestly:**

- The `stakeholder_conversations` memory log has **no UI**. S3 shows thread continuity only.
  The PDF explains memory through the architecture diagram and says so.
- A live multi-NPC run (real LLM calls, real timing) was not captured. It needs keys and
  budget approval.
- Scenario director, hive, antagonist and pressure engine outputs were not captured.
- A full scheduler tick with real data was not run.

Screenshot folder name: `screenshots/` (lowercase, as in Part 5). The deliverable list
spelled it `Screenshots/`. One folder only, to avoid a case-collision on macOS/Windows.

---

## 6. Claims excluded from the client PDF (insufficient evidence)

- Cross-session / long-term memory; vector or embedding retrieval.
- Personality-drift detection or scoring; hallucination detection.
- Autonomous agent-to-agent negotiation or turn-taking.
- Per-NPC or per-audience sentiment; "accurate/validated" sentiment.
- Dollar-cost or per-match cost tracking (only token logging and an hourly budget exist).
- Coaching lessons, negotiation games, competitive scoring, coached-vs-uncoached comparison.
- Unit-test coverage of the persona guards.
- Anything from `stakeholder_state`, `registerStakeholderContextProvider`, `applySentimentImpact`.
- Production model names, user counts, client names, or any real run.
- Sole authorship. The git history has one dominant author (996 of ~1,006 commits) plus
  a few from two other names. The "CTO" role claim comes from you, not from the repo.

## 7. Brand reference

`docs/brand/index.html`: selected mark "J - Promotion cut", navy plus amber, Inter and
JetBrains Mono. The PDF uses the "on dark" logo from `docs/brand/logos/j-promotion-cut/`,
navy surfaces, teal accent for evidence, amber for partial/experimental, dashed light blue for
proposals.

## 8. Reproducing the captures and PDF

```
cd portfolio/prophyion-case-study/_build
STATE_SERIES=1 node stub-server.mjs &                 # port 3001
(cd ../../../frontend && VITE_SUPABASE_URL=http://127.0.0.1:3001 \
  VITE_SUPABASE_ANON_KEY=local-stub-anon-key npx vite --port 3002 --host 127.0.0.1 &)
node capture.mjs 01 02 02b 03 04 05 06                # screenshots
node render-pdf.mjs && python3 inspect-pdf.py         # PDF + QA PNGs
```

`_build/` contains no secrets (the anon key and JWT are dummies). It is a working folder and
is not part of the client deliverables.
