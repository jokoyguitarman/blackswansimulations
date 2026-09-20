# Executive decisions — organic model: handover to the generator agent

**Date:** 2026-09-20 · **From:** runtime agent · **To:** generator agent · **Decided by:** product owner
**Status of this document:** instructions + ownership transfer. Not a shared contract — everything
in here is yours to design and build; §6 lists the runtime surfaces you will build against and
§9 the few things that still need a word with me before you change them.

---

## 0. In one paragraph

The menu-based decision layer (contract §7A / runtime plan §5 — an Executive player picks a
pre-authored option in a "Decisions" app, which arms authored obligations, latent grievances and
eruption templates) was **built, shipped and retired the same day**. The product owner wants
decisions to be **organic**: a CEO decides the way a real CEO does — by writing an email, dropping a
line in TeamChat, taking a call — and the simulation **notices** the decision, lets it **travel
through the organisation** (the people who were told act on it, the people who weren't find out
anyway), and **generates the consequences at runtime** (staff, union, regulators, press, clients
react in character, on realistic delays, in the right country, still reachable and still talk-down-able
through the existing stakeholder reconsideration mechanic). The runtime menu layer has been deleted
(§2). From here on **one agent — you — owns the executive-decision feature end to end: scenario
generation _and_ runtime.** I keep everything else and expose the hooks in §6.

---

## 1. What the product owner asked for (intent, in their words and mine)

> "So instead of announcing it via email, the CEO for example, uses that?" — no. The CEO announces
> it via email. That _is_ the decision.

> Delete the menu based layer. Only one agent does everything else.

The worked example they asked to see (Dyson fixture, adapt to any scenario):

1. **T+22** — CEO (Executive team, `org_dyson_sg`) emails the COO and the Malaysia plant manager
   (an internal stakeholder, `relationship: 'internal'`, `org_key: 'org_dyson_my'`):
   _"Effective immediately we are suspending production at Johor pending the labour audit. Legal to
   confirm notice obligations. Nothing goes out publicly until Comms has a line."_
2. **Detection** — the runtime reads that message and concludes: a decision was taken (not floated),
   type ≈ site suspension / closure, scope = Johor plant, `org_dyson_my`, Malaysia; affected parties
   ≈ Johor workforce, the union branch, MOHR (Malaysia), MOM (Singapore, cross-border scheduling),
   key clients supplied from Johor, the local press; informed so far: COO, plant manager; **not**
   informed: Comms, Legal (mentioned, not addressed), HR, Sales, the union, the ministry.
3. **Internal propagation** — the plant manager (NPC) replies in character within minutes asking
   what to tell the shift leads; HR (NPC or player team) is not told, so at ~T+35 a shift supervisor
   NPC messages the HR/Driver-Relations team: _"Is it true we're being shut? People are asking."_
   Comms learns from the leak, not the CEO. The Sales team gets a client email at ~T+50 asking
   whether Thursday's shipment is affected.
4. **External consequences** — the union secretary's grievance _becomes_ "closure without
   consultation"; a union statement is scheduled for ~T+60; MOHR schedules an inspection notice for
   ~T+90; a labour reporter starts asking at ~T+45. All of these are **stakeholder-authored pending
   injects**, so if Driver Relations reaches the union secretary at T+40 with something that meets
   her (new) criteria, the existing reconsideration judge softens or withdraws the statement — that
   mechanic is unchanged and stays mine.
5. **Snowball** — an unsoftened union statement triggers a press pickup, which triggers the
   Singapore MOM query, which lands in the CEO's inbox at T+110. Depth and budget are capped.
6. **Trainer / AAR** — the trainer sees "Decision detected: suspend Johor production (T+22, CEO) →
   told: COO, plant manager → found out: HR T+35, Comms T+41, union T+58" and the consequence chain
   with what was softened by whom. The AAR Executive section judges the decision by _how it was
   communicated_, not by which option was picked.

Nothing above is a menu. There is no `decision_space[]`, no authored obligations, no authored
latent grievances: the affected set, the derived "should have been told" list, the new grievances,
and the reaction injects are all produced at runtime from the decision text + the stakeholder cast +
the org registry.

---

## 2. State of the codebase you inherit (what I removed, what I kept)

### 2.1 Removed from the runtime (commit "retire menu-based decision layer")

| Surface                                                                                                                                                                                        | Was                                                                                                                   | Now                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `server/services/decisionEngineService.ts`                                                                                                                                                     | menu engine (`getDecisionSpace`, `recordDecision`, `arm`, `broadcastToOrg`, `markObligationsMet`, `lapseObligations`) | **deleted**                                                                                                                         |
| `GET /sessions/:id/decision-space`, `POST /sessions/:id/decisions`, `GET /sessions/:id/decisions`                                                                                              | endpoints                                                                                                             | **deleted**                                                                                                                         |
| `frontend/src/components/SimDevice/DecisionsApp/*`, `/icons/icon-decisions.svg`, mobile route `decisions`, desktop `APP_REGISTRY.decisions`, home tile, `system_alert`+`decision_id` deep link | Decisions app                                                                                                         | **deleted**                                                                                                                         |
| `conditionEvaluatorService` `decision_recorded:<key>` primitive                                                                                                                                | true when recorded                                                                                                    | **removed** — now an unknown key, always `false`                                                                                    |
| `injectSchedulerService` decision context + `lapseObligations` tick                                                                                                                            | —                                                                                                                     | **removed**; a one-per-session `decision_layer_inert` log line remains for scenarios still carrying `decision_recorded:*` templates |
| `sopCheckerService` `triggered_by_decision_key` clocks                                                                                                                                         | clock starts at decision minute                                                                                       | steps carrying it are now **skipped** (inert)                                                                                       |
| `stakeholderReconsiderationService.getEffectiveGrievance`                                                                                                                                      | swapped in `latent_grievances[active_decision_key]` from `stakeholder_state`                                          | reads authored grievance, unless a **registered resolver** overrides (§6.3)                                                         |
| `stakeholderReplyService.handlePlayerMessage` → `markObligationsMet`                                                                                                                           | —                                                                                                                     | **removed**                                                                                                                         |
| `aarSocialMediaService.leadership_decisions`, AAR "Leadership decisions" block, `social_team_executive` instruction                                                                            | menu data                                                                                                             | data removed; instruction now judges executives by the decisions they **communicated** (ledger)                                     |
| `TrainerSimDashboard` "Executive Decisions" card, `api.sessions.decisionSpace/recordDecision/listDecisions`                                                                                    | —                                                                                                                     | **removed**                                                                                                                         |

### 2.2 Kept (yours to reuse, repurpose or drop)

- **Migration 203 objects, untouched and empty:** `session_decisions` (org*key, decision_key, title,
  recorded_by, team_name, scope, rationale, effective_at, recorded_at_minute, recorded_by_trainer;
  `UNIQUE (session_id, org_key, decision_key)`), `stakeholder_state` (session_id, stakeholder_id,
  active_decision_key), `decision_obligations` (decision_id FK, stakeholder_id, by_function,
  description, due_at_minute, status open/met/lapsed, met_by_user_id, met_at). All RLS-enabled
  with **no policies** (service-role only). The shapes fit a \_detected* decision reasonably well
  (`decision_key` = your generated slug, `recorded_by` = the executive, `recorded_by_trainer` =
  trainer override). Reuse, `ALTER`, or `DROP` in your migration — your call; if you drop, do it in
  a new migration, never by editing 203.
- **Vocabulary already in the CHECK constraints (203):** `player_actions.action_type =
'decision_recorded'`; `session_events.event_type ∈ {decision_recorded, obligation_met,
obligation_lapsed}`. Anything else you need (e.g. `decision_detected`, `decision_propagated`,
  `decision_dismissed`) needs a migration re-asserting the CHECK with the full list — copy the list
  from 203, never drop types.
- **Generic cross-inject primitives:** `delivery_config.inject_key` +
  `inject_published:<inject_key>` / `inject_cancelled:<inject_key>` (evaluator +
  `isInjectKeyCondition()` in the contract lib). Fine for chaining second-order reactions.
- **Executive team identity:** `function_key: 'Executive'`, the 🏛️ icon, Executive charters, the
  `social_team_executive` AAR section — unchanged; executives remain players.
- **`registerGrievanceOverrideResolver()`** — new hook, §6.3.
- **Deprecated-but-exported contract schemas** (`DecisionOptionSchema`, `DecisionSpaceSchema`,
  `ChainOfCommandLinkSchema`, `ChainOfCommandSchema`, `LatentGrievance`,
  `Stakeholder.latent_grievances`) — kept **only** because your modules import them
  (`scenarioOrgModel.ts`, `decisionLayerService.ts`, `scenarioValidationService.ts`,
  `multiOrgPipeline.ts`, `socialCrisisWarroom.ts`, `socialCrisisGeneratorService.ts`). When your
  last importer is gone you may delete that block from `server/lib/stakeholderContract.ts` yourself
  (it is marked with a RETIRED banner) — that is the one edit to my contract file you don't need to
  ask about. Keep `latent_grievances` parsing until no persisted scenario still carries it, or
  strip it in your persistence layer; either way the runtime ignores it.

### 2.3 Bugs you should know about (found while removing)

- `arm()` inserted runtime injects with `generation_source: 'decision_eruption'`, which is **not**
  in `scenario_injects_generation_source_check` (last asserted in migration 162). Those inserts
  would have failed with a logged warning. If you add a `generation_source` value, add a migration
  re-asserting the CHECK with the full list (see 114/115/118/145/162 for the pattern).
- Compiled scenarios that still carry `decision_space[]`, `latent_grievances`, eruption templates
  with `decision_recorded:*`, or SOP steps with `triggered_by_decision_key` load and run: the
  templates stay dormant, the steps are skipped. Clean them up in your persistence layer or a data
  migration when convenient.

---

## 3. Ownership after this handover

**You own the executive-decision feature end to end** — generation, persistence, runtime engine,
endpoints, UI, trainer console, AAR data. Specifically you may create, edit and delete:

- New runtime modules under names of your choosing — suggested: `server/services/decisions/`
  (e.g. `decisionDetectionService.ts`, `decisionPropagationService.ts`,
  `decisionConsequenceService.ts`), `server/routes/decisions*.ts` (note: `/api/decisions` is already
  taken by the legacy formal-decision workflow — pick `/api/sessions/:id/exec-decisions` or similar).
- New migrations **205+** (204 is the last one applied). Hand them to the product owner to apply,
  as before.
- New frontend surfaces: a trainer dashboard card (mount point: `TrainerSimDashboard.tsx`, below
  the "Stakeholder Outcomes" row — that is where the removed card sat), AAR blocks, optional
  player-facing UI. Players should **not** get a new "decide" UI; the whole point is they use Mail,
  TeamChat and the phone.
- The generator side you already own: `decisionLayerService.ts`, `scenarioOrgModel.ts`
  (`ExecutiveDecisionSchema`, `ChainOfCommandEdge`), the wizard sections, validation rules
  `MO-DEC-*`, `multiOrgPipeline.ts` decision bits, `socialCrisisWarroom.ts` `decision_layer`
  wiring. Remove or repurpose (§5).

**Touch points in my files** (edit allowed, keep to the hook; tell me in the commit message):

- `server/routes/socialMedia.ts` `POST /emails` — after the email row is inserted (the same place
  `triggerNPCEmailReply` is scheduled) add your `void detect…()` call. It must fire for
  **player-to-player** mail too — that is the main channel executives use — so hook _outside_ the
  `if (!primaryRecipientIsPlayer)` branch.
- `server/routes/channels.ts` `POST /:channelId/messages` — after the message insert (next to the
  `npc_direct` → `onTeamChatMessage` branch) for team-channel and DM messages.
- `server/routes/voice.ts` — if/when call transcripts exist (`voice_recordings` / `voice_calls`);
  optional.
- `server/services/aarSocialMediaService.ts` / `aarSocialSectionService.ts` — add your data under a
  new key (e.g. `executive_decisions`) in `SocialMediaAARData` and the section data; extend the
  `social_executive` / `social_team_executive` instruction strings to reference it. The removed
  `leadership_decisions` shape (title, who, T+, told/not told, obligations met/lapsed, eruptions
  fired/softened) is a decent starting point.
- `frontend/src/components/AAR/SocialAARCharts.tsx` `SingleTeamBlock` — render your block where the
  "Leadership decisions" block used to be (just above the pre-emption block).
- `server/services/injectSchedulerService.ts` — only if you need a per-tick hook; prefer your own
  interval/queue. If you must, add a single `await import()`-guarded call, like the removed
  `lapseObligations` one was.

**Stays mine, call it don't fork it:** `stakeholderService`, `stakeholderReplyService`,
`stakeholderReconsiderationService` (except the resolver you register), `orgRegistryService`,
`scenarioCache`, `channelAccess`, `feedEngineService.routeInjectToApp`, `notificationService`,
`websocketService`, `sopCheckerService.recordPlayerAction`, the TeamChat/Mail/Contacts apps, the
notification pill, migrations 197–204. If a hook you need is missing, ask — I will add it within the
day rather than have two engines diverge.

**Pressure organisations plan** (`docs/pressure-organisations-plan.md`, yours): its §6 assumed the
runtime agent builds the pressure-page engine, and §2.3/§3.3/§5 lean on the menu decision layer
("decision routes the union's eruption to the union page"). Under the one-agent rule I recommend
you own §6 as well and rewrite those lines as "a _detected_ decision's cascade routes the union's
reaction to the union page". That reassignment is the product owner's call — flag it to them; I'm
fine either way.

---

## 4. Target behaviour — what "organic" has to mean

Design freedom is yours; these are the behaviours the product owner described and expects to see.
Treat them as acceptance criteria, not implementation.

### 4.1 Detection: a decision is what an executive _communicates_, not what they click

- **Sources:** emails (any recipient, including player-to-player), TeamChat messages (team
  channels, DMs, NPC DMs), phone calls when transcripts exist, published statements/drafts
  approved by an Executive. Authored by a member of a team whose `function_key === 'Executive'`
  (use `getTeamIdentity` + `resolveTeamFunction`). Consider also detecting decisions taken by
  other teams when the charter allows (a Legal head deciding to sue) — optional, lower priority.
- **Decision vs. deliberation:** _"We are suspending Johor as of now"_ is a decision; _"Should we
  consider suspending Johor?"_ is not; _"Draft a plan to suspend Johor"_ is a directive that may
  become one. Ask the model for `is_decision`, `confidence`, `finality` (`final | conditional |
exploratory`) and only act on final/high-confidence; keep low-confidence candidates and
  re-evaluate as the thread grows (coalesce per author + thread, like `coalesce()` in
  `stakeholderReplyService`).
- **Output of a detection** (persist it — `session_decisions` fits, or your own table): summary
  (one line, player-facing safe), `decision_key` (generated slug, unique per org/session),
  category (open taxonomy — closure/suspension, recall, layoffs, pricing, public position, legal
  action, leadership change, product change, payments/compensation, …; do not gate on it), scope
  (`org_key`, country, site/product/region as text), **affected stakeholder ids** (matched against
  `initial_state.stakeholders[]` by relationship / organisation / `knowledge` / `stance` +
  scenario fact sheet), **informed** (message recipients resolved to players / stakeholders /
  functions), **should-know** (derived: functions and stakeholders who would in reality need to
  hear this before it leaks — Legal, HR, Comms, the union for labour matters, the regulator for
  safety/statutory matters, key clients for supply matters), `detected_at_minute`, source refs
  (`sim_emails.id` / `chat_messages.id`).
- **Trainer override:** trainer can dismiss a false positive (no cascade, or stop an ongoing one)
  and can mark a decision manually (from a message, or free text) — the removed engine had
  `recorded_by_trainer` for exactly this.
- **Never coach the players.** No "decision detected" toast to the executive, no checklist of who
  they should inform. They find out the way real executives do: the consequences arrive.

### 4.2 Internal propagation: the organisation reacts to being told — and to not being told

- **People told** (recipients): NPC internal stakeholders reply in character through
  `handlePlayerMessage` (already handles email/TeamChat/Messenger for stakeholders); their reply
  should reflect the decision (the plant manager asks about shift leads, not about the weather).
  That means the character prompt needs to know about the decision — see §6.3 for the grievance
  override; for non-aggrieved internals, pass the decision as context in your own prompt or ask me
  for a `context` extension on `PlayerMessageCtx`.
- **People not told:** on realistic delays, internal NPCs who _would_ hear (same org, same
  country/site first) initiate contact with the player teams that own them (workbook
  `owning_team`) — a supervisor asks HR, a sales manager asks Sales about the client call they
  just had. Use `sendNPCDirectMessage` / the email insertion path (§6.5) with
  `delivery_config.stakeholder_id` and the stakeholder's own identity fields, and log every
  outbound with `appendConversation({ direction: 'npc' })` so the conversation stays coherent when
  the player replies.
- **Player teams not told:** they learn from those NPC messages and from the feed. Do **not**
  broadcast the decision to the org's members (the removed `broadcastToOrg` did; the product owner
  explicitly did not want an announcement mechanism).
- **Multi-org scoping:** propagation stays inside the deciding org (`org_key`) and its country
  unless a stakeholder is common (`org_key: null`) or the consequence is public (press, feed).
  A PNP decision must not surface in PDRM staff chatter. Use `getOrgMemberUserIds`,
  `getTeamsByFunction(sessionId, fn, orgKey)`, `orgCountry`.

### 4.3 External consequences: generated, delayed, in character, still talk-down-able

- For each affected stakeholder, **generate at runtime** (one LLM call per decision, not per
  stakeholder — return a plan): (a) a new grievance / resolution criteria / hard constraints if the
  decision changes what they care about (register through §6.3 so `decideAndReply` and
  `decideAtFireTime` judge against it), (b) zero or more **pending stakeholder-authored injects** —
  emails, DMs, feed posts, news, page statements — with realistic `trigger_time_minutes` /
  `eligible_after_minutes` by relationship (internal: 5–20 min; clients/partners: 20–60; union:
  30–60; media: 30–90; regulators: 60–120; investors: 60–180), country- and org-stamped per
  contract §4.1, authored per §4.2 (`delivery_config.stakeholder_id`, `author_handle`,
  `author_display_name`, `author_type`).
- Insert them as **runtime injects** (`scenario_injects` with `session_id` set, `ai_generated:
true`, your own `generation_source` value after a CHECK migration) — the scheduler then treats
  them like any stakeholder-authored inject: `applyStakeholderGate` → `decideAtFireTime` runs the
  reconsideration judge at fire time, so a team that reaches the stakeholder first with the right
  content gets `modify | delay | cancel` per persuadability. That is the whole "reach them before
  they act" loop and it needs no new code from you.
- **Derived obligations** (replacing authored `sop_obligations`): for each should-know stakeholder,
  "was this stakeholder contacted by the owning team before their reaction fired?" is answerable
  from the conversation log (`wasContacted`, `getConversationLog`) — no obligation table needed,
  but you may reuse `decision_obligations` if you want due-times on the dashboard. Lapse = the
  reaction fired unsoftened. Penalty: the removed engine used the existing `prereq` heat-meter
  mistake type via `updateTeamHeatMeter`; reuse or define your own.
- **Second order:** a fired reaction may trigger further reactions (union statement → press → MOM
  query). Chain with `inject_published:<inject_key>` on the child injects, cap depth (2–3) and
  per-decision inject budget (≈ 6–10), and reuse the crowd engines for amplification rather than
  generating crowd posts yourself (`triggerNPCReactions`, ambient continuation — both already
  country-scoped via `selectPersonaPool`).

### 4.4 Trainer & AAR

- Dashboard card: detected decisions with the chain (told / found out / reacted / softened by whom,
  each with T+), dismiss/mark controls. Poll like the other cards (`loadStakeholderEvents` is the
  closest pattern).
- `session_events`: emit `decision_recorded` on detection (already allowed), plus your own types
  (migration) for propagation/consequence steps so the trainer timeline and `GET
/sessions/:id/events?event_type=…` show them.
- AAR: feed the Executive section and the executive summary (§3 touch points). Score the
  _communication_ of the decision: timeliness, who was looped in before the leak, whether the
  consequences were pre-empted; not "which option".

### 4.5 Cost, safety, determinism

- One coalesced LLM call per candidate message for detection (cheap model is fine), one planning
  call per confirmed decision, then reuse the existing per-stakeholder reply/judge calls. Add a
  per-session cap like `underSessionCap()` and a feature flag in `server/env.ts` (mine — one-line
  addition, say so in the commit) e.g. `ENABLE_EXECUTIVE_DECISIONS`.
- Hidden fields stay hidden: never return `grievance`, `resolution_criteria`, `persuadability`,
  `hard_constraints`, `knowledge`, `will_not_disclose`, or your generated grievances to any player
  endpoint (`toPlayerVisible()` exists for stakeholders).
- RLS on any new table; service-role writes only; player reads only via your endpoints with
  `assertSessionAccess`.
- The coalition plan's replayable adversary mode wants determinism where possible: persist the plan
  you generate (so a replay re-fires the same injects) rather than re-asking the model.

---

## 5. What changes on the generation side

**Stop emitting** (retired; the runtime ignores them): `initial_state.decision_space[]`,
`initial_state.chain_of_command[]` (unless your propagation engine wants an authored reporting
graph — then it is _your_ private key, not contract surface, and you may keep it),
`stakeholders[].latent_grievances`, `delivery_config.decision_key`, template injects conditioned on
`decision_recorded:*`, SOP steps with `triggered_by_decision_key`, and the corresponding wizard
sections, `MO-DEC-*` validation rules and the "decision layer" review panel.

**Generate instead** (all yours; only the first item touches the shared contract):

1. **A richer internal cast**, because internal propagation needs people to propagate through:
   per protagonist org (and per site/country for multi-office orgs) a handful of `relationship:
'internal'` stakeholders with real roles — plant/site manager, HR head, shift supervisor, union
   liaison, finance controller, EA to the CEO — owned by the right functions, with `knowledge`
   describing what they see day to day. (Contract §3 already allows this; it just needs to be
   deliberate rather than incidental.) The Sigma run had 13 internal ground staff — that is the
   right order of magnitude.
2. **Optional additive stakeholder field** to make detection and affected-set matching precise
   without a taxonomy: e.g. `sensitivities: string[]` — "what kinds of executive decisions this
   person would react to, in plain language" (_"any change to Johor shift patterns or headcount"_,
   _"anything that touches wage compliance or notice periods in Malaysia"_). This is a contract §3
   additive optional field → tell me the name and I add it to `StakeholderSchema` (passthrough
   already preserves it, so you can start emitting immediately; the schema entry is for
   validation and docs).
3. **Executive charters** that describe how leadership is judged in the organic model
   (communicates decisions to the right functions before they leak; scopes and explains; does not
   go public before Comms has a line) — today's action vocabulary (`email_sent`,
   `chat_message_sent`, `draft_approved`) covers it.
4. **Scenario-level hints for your consequence planner**, if useful, as your own `initial_state`
   keys (e.g. `decision_context: { statutory_notice_days, union_recognised, regulators_by_topic }`).
   Private to your engine; no contract change.

**Delete list (yours):** `server/services/decisionLayerService.ts`, `ExecutiveDecisionSchema` /
`ChainOfCommandEdge` in `scenarioOrgModel.ts`, decision bits in `multiOrgPipeline.ts`,
`socialCrisisWarroom.ts` (`runDecisionLayer`, `decision_layer` artifact, `decision_space` /
`chain_of_command` body fields), `scenarioValidationService.ts` `MO-DEC-*` checks and
`latent_grievances` reads, wizard UI in `SocialCrisisWizard.tsx` / `StakeholdersSection.tsx`. Then
remove the RETIRED block from `server/lib/stakeholderContract.ts` (§2.2).

---

## 6. Runtime surfaces you will build against (signatures as of this commit)

### 6.1 Identity & registry — `server/services/orgRegistryService.ts`

```ts
getTeamIdentity(sessionId, userId): Promise<TeamIdentity | null>   // { team_name, function_key, org_key, country }
getTeamIdentityByName(sessionId, teamName): Promise<TeamIdentity | null>
getSessionTeams(sessionId): Promise<SessionTeam[]>                   // identity + member user ids
getTeamsByFunction(sessionId, functionKey, orgKey?): Promise<SessionTeam[]>
getOrgMemberUserIds(sessionId, orgKey): Promise<string[]>
getProtagonistOrgs(scenarioId): Promise<OrgRegistryEntry[]>          // is_primary, country, display_name
orgCountry(scenarioId, orgKey): Promise<string | null>
isMultiOrg(scenarioId): Promise<boolean>
```

`resolveTeamFunction(identity)` from `server/lib/stakeholderContract.ts` gives the function
(`'Executive'` for leadership teams).

### 6.2 Stakeholders — `server/services/stakeholderService.ts` (+ contract lib)

```ts
getStakeholders(scenarioId): Promise<Stakeholder[]>                  // full hidden fields — server only
findById / findByEmail / findByHandle(scenarioId, …): Promise<Stakeholder | null>
getVisibleStakeholders(scenarioId, identity): Promise<Stakeholder[]>
canUserSeeStakeholder(sessionId, userId, stakeholderId): Promise<boolean>
toPlayerVisible(s)                                                     // contract lib — strips hidden fields
isStakeholderVisibleToTeam(s, identity)                                // contract §6 predicate
```

`getSessionScenarioId(sessionId)` and `getScenarioSnapshot(scenarioId)` (description,
`initial_state`, fact sheet) live in `server/lib/scenarioCache.ts`; cache is keyed on
`scenarios.updated_at`, so your per-scenario derived data can use `cachedByScenario(scenarioId,
key, loader)`.

### 6.3 Conversation, replies, reconsideration — `stakeholderReplyService.ts`, `stakeholderReconsiderationService.ts`

```ts
// log — every player↔stakeholder exchange on any channel; direction 'player' | 'npc'
getConversationLog(sessionId, stakeholderId, limit = 40): Promise<ConversationRow[]>
appendConversation({ sessionId, stakeholderId, channel, direction, userId?, identity?, content, refTable?, refId? })
wasContacted(sessionId, stakeholderId): Promise<boolean>

// player → stakeholder: appends, ONE coalesced judge call (reply + verdicts on pending injects)
handlePlayerMessage({ sessionId, stakeholder, channel, userId, content, subject?, refTable, refId }): Promise<ReplyPlan>
recordNpcReply({ sessionId, stakeholderId, channel, content, refTable, refId })   // after you persisted the reply
buildCharacterPrompt(stakeholder, log, scenarioCtx): string
loadScenarioCtx(scenarioId): Promise<ScenarioCtx>

// reconsideration
getPendingInjects(sessionId, stakeholderId): Promise<PendingInject[]>
getEffectiveGrievance(sessionId, stakeholder): Promise<EffectiveGrievance>      // base or override
decideAndReply(ctx): Promise<{ plan: ReplyPlan; verdicts: StoredVerdict[] }>
decideAtFireTime(sessionId, inject): Promise<FireTimeDecision>                  // scheduler calls this

// NEW — the hook for your generated grievances
type GrievanceOverrideResolver = (sessionId, stakeholder) =>
  Promise<{ grievance; resolution_criteria; persuadability; hard_constraints; reason: string } | null>;
registerGrievanceOverrideResolver(resolver | null): void   // call once at boot from your module
```

Register your resolver where your engine is initialised (e.g. from `server/index.ts` boot — a
one-line import of your module; say so in the commit). Return `null` for stakeholders without an
active decision-driven grievance so the authored one applies. `EffectiveGrievance.source` becomes
`override:<reason>` — the judge prompt and the trainer event both carry it.

### 6.4 Injects — insert runtime injects; the scheduler does the rest

Row shape that the scheduler and `routeInjectToApp` understand (this is what the removed `arm()`
wrote, minus the menu fields):

```ts
await supabaseAdmin.from('scenario_injects').insert({
  scenario_id, session_id,                    // session-scoped copy (migration 150)
  type,                                       // 'email' | 'social_post' | 'news' | 'group_chat' | 'phone' | …
  title, content, severity: 'medium', inject_scope: 'universal' | 'team', target_teams: string[] | null,
  trigger_time_minutes: number | null,        // absolute T+; or null + conditions_to_appear
  conditions_to_appear: { all: ['inject_published:<parent_key>'] } | null,
  conditions_to_cancel: null,
  eligible_after_minutes: number | null,
  state_effect: null, requires_response: false,
  delivery_config: {
    stakeholder_id, author_handle, author_display_name, author_type,   // contract §4.2 — makes it stakeholder-authored
    org_key, country,                                                  // contract §4.1 — routing / visibility
    inject_key,                                                        // for children to chain on
    decision_id, // yours — link back to the detected decision
  },
  ai_generated: true,
  generation_source: '<your value — add it to the CHECK first>',
});
```

Stakeholder-authored (`delivery_config.stakeholder_id` present) ⇒ the scheduler's private
`applyStakeholderGate()` runs `decideAtFireTime` instead of the generic AI cancellation gate; `inject_verdicts` and
`stakeholder_verdict` events come for free. `routeInjectToApp(sessionId, inject, io)` in
`feedEngineService.ts` is what publishes; you should not call it yourself — let the scheduler.

### 6.5 Direct NPC → player delivery (for "found out" messages that aren't injects)

- TeamChat DM as a stakeholder: `POST /channels/session/:sessionId/npc-dm` in `routes/channels.ts`
  shows how the `npc_direct` channel per stakeholder×user is found-or-created; then insert into
  `chat_messages` with `sender_id: null`,
  `sender_stakeholder_id`, `sender_display_name` (migration 199), then
  `getWebSocketService().messageSent(channelId, message)` and `createNotificationsForUsers([userId],
{ sessionId, type: 'chat_message', title, message, metadata: { channel_id } })`.
- Email as a stakeholder: insert into `sim_emails` the way `npcEmailReplyService` does (from
  address = stakeholder email, `to_addresses` = player addresses from the session directory);
  the Mail app picks it up via realtime.
- Messenger DM: `sendNPCDirectMessage(...)` in `npcMessengerService.ts`.
- Always `appendConversation({ direction: 'npc', … })` afterwards.

### 6.6 Scoring, events, notifications, sockets

```ts
recordPlayerAction(sessionId, playerId, actionType, targetId, content, metadata = {}, sopStepMatched = null)  // sopCheckerService
updateTeamHeatMeter(...)                                                                                       // heatMeterService
supabaseAdmin.from('session_events').insert({ session_id, event_type, description, actor_id, metadata })     // types must be in the CHECK
createNotification / createNotificationsForUsers(userIds, { sessionId, type, title, message, metadata })       // notificationService; `type` must be in notifications_type_check (migration 172)
getWebSocketService().broadcastToSession(sessionId, event) / emitToUser(userId, event) / messageSent(channelId, message)
GET /api/sessions/:id/events?event_type=a,b&limit=n                                                           // trainer timeline reader
```

### 6.7 Where to hook detection

- `server/routes/socialMedia.ts` → `POST /emails` (email row `email`, `session_id`, `user.id`,
  `to_addresses`, `subject`, `body_text`; note the player-directory resolution
  `resolveAddressesToPlayers` right there for "who was told").
- `server/routes/channels.ts` → `POST /:channelId/messages` (channel row has `type`, `team_name`,
  `stakeholder_id`; member ids via `getChannelMemberIds(channel)` in `server/lib/channelAccess.ts`).
- Drafts approved/published: `routes/socialMedia.ts` drafts endpoints (`draft_approved`,
  `draft_published` player actions) if you want public statements as a source.

---

## 7. Acceptance scenario (run this before calling it done)

Dyson fixture, two orgs (`org_dyson_sg`, `org_dyson_my`), Executive team staffed in SG, Comms /
HR-or-Driver-Relations / Sales / Legal staffed, stakeholders present.

1. CEO emails COO + Johor plant manager: suspension effective immediately, "nothing public until
   Comms has a line". → Within 1 tick a detected decision exists (`decision_recorded` event),
   scope Johor / `org_dyson_my` / Malaysia, informed = {COO, plant manager}, should-know includes
   Comms, HR, Legal, union secretary, MOHR, ≥1 client.
2. Plant manager replies in character within ~2 min asking an operational question.
3. Nobody tells HR. At ~T+35 a supervisor NPC messages the HR/Driver-Relations team; the message
   appears in their TeamChat/Mail with the notification pill; it is logged in
   `stakeholder_conversations`.
4. Union secretary's `getEffectiveGrievance` now returns `source: 'override:…'` with
   consultation-based criteria; a union statement inject is pending for ~T+60, country Malaysia.
   Driver Relations emails her at T+45 meeting the criteria → at fire time the verdict is
   `modify`/`cancel` (persuadability-bound), `stakeholder_verdict` event shows it, the dashboard
   "Stakeholder Outcomes" card lists it, AAR pre-emption credits the team.
5. MOHR inspection notice is pending for ~T+90 with `persuadability: none|low` → at most `modify`
   even if Legal writes; it fires as a modified email to Legal; the Singapore MOM query is chained
   on `inject_published:<mohr_key>` and lands ~T+110.
6. Malaysian feed shows the union/press posts; the Singapore feed does not (country scoping).
7. Trainer card shows the chain; trainer dismisses a deliberately planted false positive
   ("should we consider…" email) and nothing cascades from it.
8. AAR Executive section names the decision, T+22, who was told, that HR/Comms found out by leak,
   what was pre-empted and by whom. `social_executive` summary mentions it.
9. A scenario with no Executive team behaves exactly as today (flag on, no detections, no cost).
10. Cost: ≤ 1 cheap detection call per executive message, ≤ 1 planning call per decision, existing
    per-stakeholder calls otherwise; per-session cap respected.

---

## 8. Open questions for the product owner (please put them to them; I have not)

1. Should **non-executive** teams' decisions be detected too (Legal deciding to sue, Comms deciding
   to go public), or executives only for v1?
2. Should the trainer be able to **inject a decision on the CEO's behalf** when the Executive seat
   is unstaffed (AI CEO) — or is an unstaffed Executive simply "no decisions"?
3. Does a **reversal** ("we are resuming Johor") cancel pending reactions, soften them, or add a
   second wave ("management U-turn")? Real answer is "all three depending on timing"; v1 needs a
   rule.
4. Pressure-organisations plan: reassign its runtime side to you (recommended) or keep with me?

---

## 9. Coordination rules that still apply

- Contract §2–§6 (stakeholders, injects, orgs, visibility predicate) is still shared and still
  needs both agents' acknowledgement to change. Additive optional fields (like `sensitivities`)
  are minor: tell me, I add the schema line same day.
- Everything in this document's scope is yours; you do not need my sign-off for design changes,
  only for edits to files listed as mine beyond the touch points in §3.
- Runtime hooks I add on request go into `docs/stakeholder-runtime-plan.md` as a footnote; your
  design lives wherever you keep it (suggest `docs/executive-decisions-organic-plan.md`).
- Migration numbers: you take 205 onward. Tell the product owner to apply them; they have the
  Supabase MCP wired to the right project (`umnutnosxiypbnzpqszk`).
