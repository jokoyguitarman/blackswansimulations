# Multi-Org Coalition Mode — design plan

Status: **proposed**, split into two phases. Only the items under "Already
landed" are built.

Phase 0 delivers most of the requested behaviour without touching inject routing
or player membership. Phase 1 is the expensive part: true per-org storylines and
real fog of war. The split exists because an audit found the original ordering
was wrong — see "Findings that reordered this plan".

## What we want

A social-media crisis where **several organisations** are in play on both sides,
each able to act on its own, whether a human is sitting in that seat or not.

**Antagonist side.** The rival org page, plus any allied rival pages the trainer
adds, are driven by expert bots. They behave like senior media-relations and
crisis-comms operators: they read the live board, find the opening in whatever
the protagonist just published, and turn the story. They exploit silence,
vagueness, contradiction and bad timing. Sharp and ruthless, but inside
professional public-communications conduct — no fabricated evidence, no slurs,
no incitement, no impersonation, no doxxing. Framing is the weapon, not lies.

**Protagonist side.** The primary org stays player-controlled. Ally pages may
have human players assigned, or nobody — in which case an equally capable AI runs
them and goes head to head with the antagonist pages.

**AI-run pages are not free agents.** They follow the injects and storyline for
_their own_ organisation, respect information asymmetry, and coordinate with
humans — passing intel when asked, and never knowing things they were not told.

---

## Findings that reordered this plan

An audit of the runtime turned up three things that change the sequencing.

**1. `author_type = 'official_account'` is role-blind in six services.** Both
protagonist and rival pages write that value, and most readers never check
`role`. Confirmed sites:

| File                           | Line     | Effect                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------- |
| `statementWatchdogService.ts`  | 285, 309 | rival attacks scored as the team's own statements — **fixed** |
| `antagonistEngineService.ts`   | 157      | antagonist rotation polluted by protagonist posts             |
| `ambientContentService.ts`     | 1140     | ambient NPCs pile onto rival posts as if they were ours       |
| `aarSocialMediaService.ts`     | 375      | AAR attribution                                               |
| `socialNotificationService.ts` | 25       | notification targeting                                        |
| `extremistHiveService.ts`      | 626      | hive can target a rival instead of the protagonist            |

Mostly cosmetic at one protagonist plus one rival. A correctness problem at five
or more pages. Wants **one shared role-aware helper**, not six patches.

**2. There is no player↔org membership, and the original plan assumed there was.**
`session_page_controllers` appears in only three files — `socialMedia.ts`,
`socialMessenger.ts`, `orgPageService.ts`. Nothing in scoring, inject routing or
team logic knows which org a player belongs to; a player's identity is _(team)_
and nothing else. So org-scoped inject routing currently has nothing to route to.
And if humans can sit on ally orgs, identity becomes _(org × team)_, which
against a team catalog capped at six does not fit — five orgs each wanting
Communications and Legal is already ten slots.

**3. Determinism versus training value.** If adversaries are LLM-driven, two runs
of the same scenario face different opponents, and the pre/post delta can no
longer be attributed to the trainees. That undermines the core product claim.
There needs to be a mode where the adversary plays the **same** script in both
runs, with the humans as the only variable.

---

## Phase 0 — AI org actors, no routing changes

Cheap, self-contained, delivers the head-to-head dynamic.

1. **Shared role-aware org helper.** One function returning protagonist and
   antagonist handle sets for a session; refactor all six sites above onto it.
2. **Allow `control_mode: 'ai'` on protagonist orgs.** Generation currently
   hard-codes `'player'` for protagonists in both the primary and secondary
   builders in `socialCrisisGeneratorService.ts`.
3. **`allyEngineService`**, mirroring `antagonistEngineService` but filtering
   `role='protagonist'` AND `control_mode='ai'`. Reacts to the live board and the
   shared storyline, stays in lane, rebuts and reframes.
4. **Expert-operator prompts** for both engines: identify the opening, choose a
   frame, pick the channel, time the strike. Weigh unanswered harmful posts, time
   since the protagonist's last official statement, contradictions between prior
   statements, and current `narrative_control` / `escalation_risk`.
5. **Conduct validator on output.** Regenerate on fabricated evidence, slurs,
   incitement, impersonation, doxxing, or claims about named individuals the fact
   sheet does not support. This is the line between a ruthless competitor and
   footage that cannot be shown to anyone.
6. **Human/AI handover.** AI stands down when a page has a human controller.
   Trainer opt-in for it to assist an idle human. Surface AI-run pages in
   `PageAssignmentModal` and allow handover mid-session.
7. **Replayable adversary mode.** Record adversary actions from run one and
   replay them in run two, so pre/post comparisons are honest.

**Tradeoff accepted in Phase 0:** allies share the primary org's fact sheet, so
fog of war between coalition members is limited.

## Phase 1 — per-org storylines and real fog of war

1. **Player↔org membership.** Decide the identity model first: either humans are
   confined to the primary org (cheap, and probably enough), or membership
   becomes _(org, team)_ with the roster implications above. Everything else in
   this phase depends on that answer.
2. **`org_key` on injects.** Add it to `SocialInjectDeliveryConfig` and index it
   on `scenario_injects`. `feedEngineService.routeInject` honours it alongside
   existing team targeting.
3. **Per-org storyline generation.** Loop the generator per org with that org's
   context, or emit org-tagged injects in one pass. Per-org loops cost more
   tokens but keep each storyline coherent.
4. **Per-org fact sheets.** Each org has its own confirmed facts and its own
   blind spots. That asymmetry _is_ the fog of war — today there is exactly one
   `fact_sheet` for the whole scenario.
5. **Per-org intel ledger.** What this org was told, and when. AI prompts built
   only from that ledger. Plus a **knowledge validator** on output: prompt-only
   enforcement leaks, because a model given only org B's intel will still assert
   things about org A confidently.
6. **Cross-org coordination.** Let AI orgs read and write the channels they
   legitimately belong to, so a human can ask an AI ally a question and get an
   answer grounded in that ally's intel — and no more than that.
7. **Per-org scoring.** Org-scoped condition primitives alongside the existing
   session-global ones in `conditionEvaluatorService`. Measure consistency
   _within_ an org, and coalition alignment _across_ orgs as a separate metric —
   never as one merged voice.
8. **Trainer UI.** Five orgs times four gauges is unreadable. Needs an org
   selector, not more gauges.

## Constraints to respect

- **`social_state` must stay additive.** It is one blob in
  `sessions.current_state`, read by the trainer dashboard,
  `conditionEvaluatorService`, the AAR and the consequence triggers. Nest per-org
  state alongside it; never replace the existing keys.
- **Feed volume and cost.** A ten-minute smoke run already produced 473 posts
  from one storyline plus the existing NPC engines. Five storylines plus five AI
  operators multiplies both the feed and the LLM bill, and the feed is already
  hard to read at sixty minutes. Every AI org needs a cadence cap, as
  `antagonistEngineService` already has.

## Adjacent bugs to fix while in here

- `teamScoreService` filters `author_type='player'` but attributes via
  `posted_by_user_id`, which is only populated on `official_account` posts. The
  conditions are mutually exclusive, so **posts contribute nothing to team
  `content_quality`; only emails do.** `playerLedgerService` has the same
  mismatch. This matters more in coalition mode, where working through an org
  page is the normal path.
- `counter_narratives_published` counts only `author_type='player'` top-level
  posts, so counter-narratives published _as a page_ read as zero on the trainer
  dashboard.
- `official_statement_published` is satisfied by any single publisher, so in a
  coalition it reads "done" while other orgs are still silent.

## Unrelated bug worth fixing: abandoned sessions bleed LLM spend

Not coalition work, but found while capturing and confirmed in production code.

`injectSchedulerService` selects its work with no upper bound on elapsed time and
never consults the scenario's `duration_minutes`:

```ts
.eq('status', 'in_progress')
.not('start_time', 'is', null);
```

So any session left at `in_progress` keeps getting a tick every
`INJECT_SCHEDULER_INTERVAL_MS` **forever**, and each tick runs
`runAntagonistEngine`, `runExtremistHive`, `runHiveThreadReplies`,
`runAntagonistThreadReplies` and (when enabled) `runScenarioDirector` — all LLM
calls — plus `computeSocialState`.

A trainer who closes their laptop without pressing "Conclude Session" leaves an
open tap on the OpenAI account, indefinitely. This has already happened once
during development and was only caught by noticing the spend.

Suggested fix: auto-conclude any session whose elapsed time exceeds
`duration_minutes` plus a generous grace (so a deliberately long exercise is not
cut off), set `end_time`, and let the normal AAR path run. A cheaper stopgap is
to have the scheduler skip sessions past that threshold, which stops the spend
but leaves the row open and the trainer dashboard still showing it as live.

## Already landed

- **Content grading was dead.** `contentGraderService` sent `temperature: 0.3`
  to `gpt-5.5`, which accepts only the default and returns 400, so every graded
  response fell through to a flat 50 with feedback "AI grading temporarily
  unavailable". Parameter removed; the failure path now logs the response body.
- **Watchdog conflated rivals with the team.** It read every
  `author_type IN ('official_account','player')` row with no role filter, so
  rival attacks were scored as the team's own statements and penalised the team
  for contradicting itself, which then subtracted from `narrative_control`.
  Rival handles are now excluded, with the scan cursor still advancing past them.
  _Behaviour change to watch:_ rival posts alone no longer trigger a scan, so if
  the team is silent and rivals are loud, transparency/consistency/RDAP stop
  updating rather than updating wrongly. Silence is still punished via
  `sop_publish_overdue` and the T+20/T+35 consequence injects.

## Open questions

1. Does an ally's performance affect the primary org's public trust, and by how
   much?
2. Can the trainer seize an ally page mid-run the way they can seize an
   antagonist page today?
3. How many orgs before the feed becomes unreadable and the cost becomes silly?
4. Should AI orgs on the same side be allowed to contradict each other, as real
   coalitions do, or always hold one line?
5. Phase 1 gate: are humans confined to the primary org, or is _(org × team)_
   membership genuinely needed?
