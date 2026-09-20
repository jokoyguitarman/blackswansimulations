# Executive decisions — organic model: design & build plan

**Owner:** generator agent (end to end: generation + runtime + UI + AAR data), per
`docs/executive-decisions-organic-handover.md` (2026-09-20).
**Status:** v1 plan reviewed 2026-09-20; **P0–P6 implemented and pushed to `master` the same day**
(commits 72838b6 … see §11). Migration 205 written, **not yet applied** — hand to the runtime agent;
everything degrades gracefully until then (§9).
**Companion:** `docs/pressure-organisations-plan.md` (its runtime side is now also mine, §0 there).

---

## 0. What "organic" means here (one paragraph)

Nobody clicks a decision. An executive writes an email, a TeamChat line, or takes a call; the
runtime **detects** that a decision was taken (not merely floated), works out **who was told and
who should have been**, lets the news **travel** through the organisation on realistic delays with
provenance (told → relay → leak → public), and **generates the consequences at runtime** as
stakeholder-authored pending injects that the existing reconsideration judge can still soften or
withdraw when a team reaches the right person first. Everything downstream carries a
`decision_id`, so the trainer sees the cascade live and the AAR judges _how the decision was
communicated_. No coaching mid-session; the lesson arrives as consequences.

---

## 1. Answers to the handover's open questions (§8) — decided for v1

| #   | Question                                         | v1 decision                                                                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Detect non-executive teams' decisions?           | **Executives only**, plus a narrow allowance for **Legal deciding to litigate/file** and **Communications deciding to publish a position** when the author's charter allows (detector receives the author's function; planner treats these as `category: legal_action` / `public_position`). No other functions.                                                                                                                 | Keeps false positives low; the two exceptions are the realistic non-CEO decisions that cascade. |
| 2   | Trainer injects a decision for an unstaffed CEO? | **Yes** — `POST /exec-decisions/manual` with free text (recorded_by_trainer = true), same detector/planner path. Unstaffed Executive with no trainer input = no decisions.                                                                                                                                                                                                                                                       | Enables single-team trainings (SG Comms only) where the trainer plays HQ.                       |
| 3   | Reversal ("we are resuming Johor")               | **Rule by timing.** Detected as a decision whose `reverses_decision_id` matches an open decision. Pending (unfired) reactions of the original: `cancel` if the reversal lands ≤ 15 sim-min after the original and before any public artefact fired; otherwise `modify` (softened, "management U-turn" tone). Fired reactions stay. A reversal after a public artefact **adds one second-wave item**: a "U-turn" press/feed beat. | Matches the handover's "all three depending on timing" with one deterministic rule.             |
| 4   | Pressure-organisations runtime side → me?        | **Yes.** §6 of that plan is mine; its decision references become "a detected decision's cascade routes the union's reaction to the union page".                                                                                                                                                                                                                                                                                  | One engine family (antagonist / pressure / cascade) in one owner.                               |
| 5   | Live union participants                          | **NPC-only in v1.** Live union teams are a follow-on that needs the visibility predicate touched (contract §6, both agents).                                                                                                                                                                                                                                                                                                     | Handover recommendation; no contract §6 change now.                                             |

---

## 2. Scope and phases

| Phase                                                                     | Content                                                                                                                                                                                                                              | Depends on    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| **P0** Retire                                                             | Remove generator menu-layer emission (decision_space, chain_of_command, latent_grievances, `decision_key` templates, MO-DEC rules, wizard/editor decision UI, `decisionLayerService.ts`), remove RETIRED block from the contract lib | —             |
| **P1** Contract v3.2 (additive)                                           | Stakeholder `kind/members/tier/site_key/sensitivities`; registry `side: 'pressure'`, pressure kinds, `spokesperson_stakeholder_id`; `page_org_key` on stakeholders and injects; `posture` on pages; new event types (migration 205)  | P0            |
| **P2** Cast completeness (generator)                                      | Carriers per org **and per site**, roster tier, distribution lists, `sensitivities`, notification SOP steps, `MO-CAST-*` validation                                                                                                  | P1            |
| **P3** Footprint inference + pressure orgs + AI-operated orgs (generator) | One inference call → proposals (countries/roles, implied orgs, pressure orgs); wizard proposals; pressure page generation + spokesperson; AI-operated protagonist flag                                                               | P1, P2        |
| **P4** Runtime engines A                                                  | Migration 205; seeding of pressure/AI-operated pages; **pressure engine**; AdversaryConsole group; PageAssignmentModal filter                                                                                                        | P1            |
| **P5** Runtime engines B — organic decisions                              | Detection hooks (mail, chat, drafts), detector, planner, knowledge/provenance, consequence injects, grievance override resolver, ledger, trainer card + endpoints, AAR data                                                          | P1, P2 (cast) |
| **P6** Tests & verification                                               | Unit tests (node test runner) for every pure module; offline model checks; live E2E (Dyson fixture); HTTP smoke; build; push                                                                                                         | all           |

Everything ships behind `ENABLE_EXECUTIVE_DECISIONS` (default **on**; set `false` to disable) and
degrades gracefully when migration 205 is not yet applied (§9).

---

## 3. Data model

### 3.1 Contract v3.2 additive fields (my edit to `server/lib/stakeholderContract.ts`, flagged in the commit; runtime agent to acknowledge)

```ts
// Stakeholder (§3) — additive, optional
kind?: 'person' | 'group';          // 'group' = distribution list; mail to it reaches members
members?: string[];                 // stakeholder ids; required when kind === 'group'
tier?: 'principal' | 'roster';      // roster = lightweight, sampled replies, no own injects
site_key?: string;                  // grouping within an org (plant / depot / branch)
sensitivities?: string[];           // plain-language: what executive decisions this person reacts to
page_org_key?: string;              // spokesperson of a pressure page (reverse link)

// OrgRegistryEntry (§5.1)
side: 'protagonist' | 'antagonist' | 'pressure'
kind: … | 'union' | 'regulator' | 'ngo' | 'community_group' | 'political'
spokesperson_stakeholder_id?: string   // required when side === 'pressure'
operation?: 'players' | 'ai'           // protagonist orgs only; default 'players'
sites?: Array<{ site_key: string; name: string; country: string; city?: string }>

// Inject delivery_config (§4)
page_org_key?: string      // page-authored: author fields = page identity; stakeholder_id = spokesperson
decision_id?: string       // cascade linkage
parent_inject_key?: string // second-order chaining (with inject_key / inject_published:*)
```

### 3.2 Runtime tables (migration 205 — `205_pressure_and_organic_decisions.sql`)

- `sim_org_pages.role` CHECK → `('protagonist','antagonist','pressure')`; add `spokesperson_stakeholder_id TEXT`, `register TEXT`, `kind TEXT`, `operation TEXT`.
- `session_decisions` (reuse 203): add `detail JSONB NOT NULL DEFAULT '{}'` (summary, category, scope, affected/informed/should_know ids, sources, confidence, finality, reverses_decision_id, plan nodes) and `status TEXT DEFAULT 'active'` (`active | dismissed | reversed`).
- New `decision_knowledge (id, session_id, decision_id → session_decisions, actor_kind, actor_id, state, learned_from, learned_via, at_minute, ref_table, ref_id, created_at)` with `UNIQUE (session_id, decision_id, actor_kind, actor_id)` (latest state wins; transitions also emitted as `decision_events`).
- New `decision_events (id, session_id, decision_id, parent_id, kind, actor_kind, actor_id, at_minute, ref_table, ref_id, summary, created_at)`.
- `session_events.event_type` += `decision_detected, decision_propagated, decision_dismissed, decision_reversed, pressure_post, pressure_reply, pressure_stand_down` (full list re-asserted).
- RLS enabled, no policies (service-role only). `scenario_injects.generation_source` stays as-is: cascade injects use the existing `'decision_response'` value (already in the CHECK), so no CHECK migration is needed for them.

---

## 4. Generation (P2–P3)

### 4.1 Cast completeness — the carrier rule (`castCompletenessService.ts`)

After stakeholders are generated for an org (and per **site**: each registry `sites[]` entry, default one site per org = its city/country), ensure these carriers exist, generating any that are missing with one AI call per org (fallback: deterministic synthetic contacts):

| Carrier                                                                                                                       | relationship                                      | owning function (fallback)                               | tier       |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- | ---------- |
| Site leader (plant/depot/branch manager)                                                                                      | internal                                          | Operations-like custom team → Executive → Communications | principal  |
| Site HR counterpart                                                                                                           | internal                                          | HR-like custom team → Stakeholder Engagement             | principal  |
| Workforce representative (union branch leader / shop steward / staff council chair) — whenever the crisis has a labour signal | union (or internal for staff council)             | HR-like → Stakeholder Engagement                         | principal  |
| Workforce roster (8–14 per site)                                                                                              | internal                                          | same as HR counterpart                                   | **roster** |
| Distribution list "<Site> — all staff"                                                                                        | internal, `kind: 'group'`, `members` = roster ids | same                                                     | principal  |
| Local labour/business reporter                                                                                                | media, country = site country                     | Communications                                           | principal  |
| Relevant regulator(s) for the site's country                                                                                  | regulator, persuadability none/low                | Legal                                                    | principal  |
| Executive shadow: EA to the CEO, one board contact                                                                            | internal / investor                               | Executive (if present) → Shareholder Engagement          | principal  |

Roster entries: name, role, shift, tenure, `site_key`, email, one-line `personality`, empty knowledge/will_not_disclose, `grievance: ''`, no injects. Every stakeholder gets `sensitivities[]` (2–3 lines) from the same call. Notification SOP steps are appended to `sop.steps` for the HR-like function: `notify_workforce_representatives` (before employees), `notify_affected_employees` (coverage via list or individually), `brief_site_leadership`, each with `time_limit_minutes`.

**Validation `MO-CAST-*` (persist-time):** 001 site leader per site; 002 HR counterpart per site; 003 workforce rep when labour signal; 004 roster ≥ 6 per site with a distribution list whose members all resolve to same-org roster ids; 005 reporter per site country; 006 regulator per site country; 007 roster entries author no injects; 008 group `owning_team` = majority owner of members.

### 4.2 Footprint inference (`crisisFootprintService.ts`, one AI call in `generate-npcs`)

Input: crisis text, primary org + country. Output (validated + guard-railed in code):

```ts
{ countries: [{ name, role: 'decision_centre' | 'incident_location' | 'spillover_market' | 'regulatory' }],
  implied_organisations: [{ display_name, kind, country, city?, reason, suggested_roster: string[] }],  // protagonist-side entities e.g. "Dyson Malaysia"
  pressure_organisations: [{ display_name, kind, country, register, reason }],
  labour_signal: boolean, product_safety_signal: boolean }
```

Guard-rails: countries must be known; ≤ 3 implied orgs; one regulator per country by default; union only with `labour_signal`; nothing persisted — returned as `footprint` for the wizard to show as pre-ticked proposals ("We detected Malaysia as the incident location. Add Dyson Malaysia (office) operated by AI?"). Accepting an implied org adds an `OrganisationDraft` with `operation: 'ai'` and the suggested roster; accepting a pressure org adds a `PressureOrgDraft`.

**Visibility rule for countries without human players:** when a country appears in the footprint but hosts no protagonist org with `operation: 'players'`, its crowd is generated but its content is emitted **unscoped** (`country` omitted → visible everywhere) — spillover, so the Singapore-only class still sees the Malaysian protest footage.

### 4.3 Pressure organisations (generator half — see the pressure plan §5; unchanged except)

- `posture` generated per register; spokesperson ensured (reuses the carrier rule's workforce rep / regulator when the kinds match).
- Page-authored statements: `delivery_config.page_org_key` + spokesperson `stakeholder_id`; author fields = page identity; T+15 minimum.
- The cascade (P5) may route a detected decision's union/regulator reaction to the page instead of a personal handle.

### 4.4 AI-operated protagonist organisations

- Wizard: per additional organisation a toggle "Operated by AI (no players will join)". Registry `operation: 'ai'`; page `control_mode: 'ai'`.
- Runtime: at session start, any protagonist org with **zero assigned players** across its teams is flagged `operation: 'ai'` for the session (trainer notice event). Its page is run by the pressure engine in an **`aligned`** register (speaks for the office, follows HQ's line when one exists, otherwise issues a cautious local holding statement — _ahead of HQ_, which is the training beat). Its carriers answer HQ through the existing stakeholder reply engine. Its teams are unstaffed → unscored (already handled).

---

## 5. Runtime — pressure engine (P4)

`server/services/pressureEngineService.ts`, ticked from **its own interval** started in `server/index.ts` (one-line boot import; injectScheduler untouched):

- every 60 s: for each `in_progress` social session, load pages `role IN ('pressure') OR (role='protagonist' AND operation='ai')` with `control_mode = 'ai'`; per page compute `progress` (spokesperson contacted? latest verdict? HQ statement published? relevant decision detected?) and current rung; choose a move by register (`statement | demand_with_deadline | escalate_rung | acknowledge_progress | stand_down | correct_record | aligned_holding_statement`); cadence 8–12 sim-minutes per page (escalates faster when ignored, slower when engaged).
- Posts as `author_type: 'official_account'`, `posted_by_display_name: 'Pressure AI'` (or `'Office AI'`), country via `orgCountryForPage`; emits `pressure_post`; `stand_down` emits `pressure_stand_down` once.
- Skips `control_mode = 'trainer'` (seized). Trainer seize/release reuses the existing endpoint.

---

## 6. Runtime — organic decisions (P5)

Modules under `server/services/decisions/`:

### 6.1 `decisionDetectionService.ts`

- **Hooks (touch points, flagged in commits):** `POST /social/emails` after insert (outside the NPC branch — fires for player-to-player mail); `POST /channels/:channelId/messages` after insert (team, direct, npc_direct); drafts approved/published by an Executive (optional, v1 included for `draft_published`).
- **Eligibility:** author's `TeamIdentity` via `getTeamIdentity`; function `Executive` → eligible; `Legal`/`Communications` → eligible only for their allowed categories. Cheap pre-filter: message ≥ 40 chars and contains a decision verb pattern (`we are|we will|effective|suspend|close|halt|recall|terminate|approve|announce|resume|lay off|withdraw|file|sue`) **or** replies in a thread that already holds a candidate.
- **Coalescing:** per (session, author, thread/channel) 20 s window like `coalesce()`; one detection call per window.
- **LLM output (validated):** `{ is_decision, confidence 0–1, finality: 'final'|'conditional'|'exploratory', summary, category, scope: { org_key?, country?, site?, subject }, affected_stakeholder_ids[] (from a compact cast list we pass: id, name, title, organisation, relationship, org_key, sensitivities), should_know_functions[], should_know_stakeholder_ids[], reverses: 'none'|'<decision_key>' }`.
- **Act only when** `is_decision && finality === 'final' && confidence ≥ 0.7`. Below that: store as candidate (in-memory per thread) and re-evaluate on the next message in the thread.
- **Informed set:** email `to/cc` → players (session directory) → their team identities/functions; stakeholder addresses → stakeholder ids (`findByEmail`); chat → channel member ids → functions; `npc_direct` → that stakeholder.
- **Persist:** `session_decisions` row (`decision_key` slug unique per org, `recorded_by` = author, `team_name`, `scope`, `rationale` = summary, `recorded_at_minute`, `detail` JSON when column exists) + `player_actions` `decision_recorded` via `recordPlayerAction` + `session_events` `decision_detected` (fallback `decision_recorded`).
- **Trainer:** `POST /api/sessions/:id/exec-decisions/manual` (free text or from a message id) and `POST …/:decisionId/dismiss` (stop cascade: cancel pending cascade injects via `inject_cancelled` semantics = set `conditions_to_cancel` satisfied → simplest: mark rows cancelled through the existing cancellation path; v1: delete unfired cascade injects for that decision + status `dismissed`).

### 6.2 `decisionPlannerService.ts` (one LLM call per confirmed decision)

Input: decision, cast (principals + groups; roster summarised per site), registry, fact sheet, sop steps, country map, leakiness (`initial_state.decision_context.leakiness` default 0.5), and **the notice content** if a formal notification has already been detected. Output: a **plan** (persisted in `detail.plan`) of nodes:

```ts
{ id, kind: 'reaction'|'relay'|'public', actor_kind: 'stakeholder'|'group'|'page'|'crowd', actor_id,
  channel: 'email'|'chat_dm'|'social_post'|'news'|'page_statement'|'phone',
  trigger_time_minutes | conditions_to_appear (inject_published:<parent inject_key>),
  parent_node_id?, content: { title, body }, grievance_override?: { grievance, resolution_criteria[], persuadability, hard_constraints[] },
  target_teams?: string[], org_key, country }
```

Code enforces: delay bands by relationship (internal 5–20, client/partner 20–60, union 30–60, media 30–90, regulator 60–120, investor 60–180) **relative to the detection minute**; budget ≤ 8 nodes/decision, depth ≤ 3; scope stays within the deciding org's country unless the actor is common or the node is public; regulators `persuadability none|low`; every `reaction` node is written as a **runtime inject** (§6.4 of the handover) with `generation_source: 'decision_response'`, `delivery_config.decision_id`, `inject_key`, `parent_inject_key`, stakeholder author fields (or page identity when routed to a pressure page). `relay` nodes become knowledge transitions + direct NPC messages (§6.3). Determinism: the plan is persisted; re-planning happens only on new player input affecting it (formal notice detected, reversal, spokesperson satisfied) and only for **unfired** nodes.

### 6.3 `decisionKnowledgeService.ts` — spread with provenance

States `unaware → rumour → informed → officially_notified` per actor with `learned_from`, `learned_via ∈ direct_message | internal_relay | grievance_relay | public_exposure | formal_notice`, `at_minute`. Transitions:

- **direct message** (hook): recipients of the executive's message → `informed`; recipients of an HR-like team's notice → `officially_notified`; `kind: 'group'` recipient → all `members` at that minute (R1 workaround: use `to_addresses`, not the conversation log).
- **internal relay** (tick): site leader → supervisors/roster with probability scaled by leakiness and elapsed minutes; produces a "found out" NPC message to the owning team (§6.5 delivery) — e.g. supervisor to HR.
- **grievance relay** (tick): roster → workforce rep → reporter → regulator, on the plan's delays, each leaving an interceptable artefact (an inject).
- **public exposure**: when a cascade inject with app social_feed/news fires (`inject_published:*` event), every actor in that country not yet informed → `informed`; crowd amplification delegated to `triggerNPCReactions` (already country-scoped).
  Persistence: `decision_knowledge` when the table exists; otherwise in-memory per session (loud log once).

### 6.4 Grievance override resolver

Registered once at boot: `registerGrievanceOverrideResolver(async (sessionId, stakeholder) => …)` returns the latest active plan node's `grievance_override` for that stakeholder (across decisions, newest wins) with `reason: 'decision:<decision_key>'`; `null` otherwise. This is what makes `decideAndReply` / `decideAtFireTime` judge the union secretary against "closure without consultation" instead of the authored grievance.

### 6.5 Delivery of "found out" messages (non-inject relays)

- TeamChat DM as the stakeholder: find-or-create the `npc_direct` channel per stakeholder×user (same query as `POST /channels/session/:sessionId/npc-dm`), insert `chat_messages` with `sender_id: null, sender_stakeholder_id, sender_display_name`, `getWebSocketService().messageSent`, `createNotificationsForUsers(type: 'chat_message')`, then `appendConversation({ direction: 'npc' })`.
- Email as the stakeholder: insert `sim_emails` (`direction: 'inbound'`, from = stakeholder email/name, `to_addresses` = the owning team's player addresses from the session directory, `recipient_user_ids`), then `appendConversation`.
  Recipients = players of the stakeholder's owning team (`getTeamsByFunction(sessionId, owning_team, org_key)`); if none, the relay still updates knowledge (the AI org case) and is logged.

### 6.6 Formal notification detection & SOP grading

A message from an HR-like team (function matches `sop.steps[].owner_function` we generate, else `Stakeholder Engagement`) to a workforce rep / roster / group / site HR after a decision → `formal_notice` transitions + `recordPlayerAction(..., 'email_sent'|'dm_sent', …, step_id)` for the matching SOP step; content graded via `gradePlayerContent(..., { post_format: 'text' })`; planner re-run for unfired union/press nodes with `notice: { order_ok, before_leak, tone_grade, coverage }` → softer/later or unchanged.

### 6.7 Trainer surfaces

- `GET /api/sessions/:id/exec-decisions` → decisions with cascade tree (from `decision_events` + knowledge + inject/verdict joins), trainer/admin only.
- `POST …/manual`, `POST …/:decisionId/dismiss`.
- `TrainerSimDashboard.tsx`: card "Executive decisions" under Stakeholder Outcomes; polls like `loadStakeholderEvents`.

### 6.8 AAR

- `SocialMediaAARData.executive_decisions[]`: `{ decision_id, summary, category, at_minute, decided_by, org_key, informed: [...], found_out: [{ actor, via, at_minute }], notice: {...}|null, reactions: [{ actor, channel, planned_minute, fired_minute|null, verdict|null, credited_team|null, quoted_player_message|null }], public_effect: { posts, articles }, dismissed }`.
- Section data: `social_executive` and `social_team_executive` get `executive_decisions`; instructions extended (they already reference "the decisions they communicated"). `SocialAARCharts.tsx SingleTeamBlock`: cascade block where "Leadership decisions" used to be.

---

## 7. Unit tests (node test runner, `npm test`)

Files are pure-function tests; no DB or network. Added to `package.json` `test`.

| File                                                  | Covers                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/services/scenarioOrgModel.test.ts`            | pressure org validation (`MO-PRS-001..003`), org keys (`org_pressure_<slug>_<cc>`), registry with pressure entries + `operation`, legacy preset aliases, composed names                                                                                                                                                     |
| `server/services/castCompleteness.test.ts`            | carrier gap detection per site; roster/distribution-list synthesis (members resolve, owning team = majority); `MO-CAST-*` positive + each negative                                                                                                                                                                          |
| `server/services/crisisFootprint.test.ts`             | guard-rails: unknown countries dropped, ≤ 3 implied orgs, union only with labour signal, one regulator per country; Dyson text → Malaysia incident_location / Singapore decision_centre (fixture, no AI)                                                                                                                    |
| `server/services/pressureEngine.test.ts`              | move selection: ignored → escalate; contacted+criteria met → acknowledge/stand_down once; regulator never `amplify`; seized page skipped; aligned register produces holding statement when HQ silent                                                                                                                        |
| `server/services/decisions/decisionDetection.test.ts` | eligibility (Executive / Legal-litigation / Comms-position / others rejected); pre-filter regex; finality/confidence gate; informed-set resolution from `to/cc` + directory + stakeholder emails; reversal linking; slug uniqueness                                                                                         |
| `server/services/decisions/decisionPlanner.test.ts`   | delay bands by relationship clamp; budget ≤ 8, depth ≤ 3; scope rule (no cross-org leakage unless common/public); inject row shape (author fields from stakeholder; page routing → page identity + spokesperson id; `generation_source: 'decision_response'`); reversal rule (≤ 15 min → cancel, else modify + U-turn beat) |
| `server/services/decisions/decisionKnowledge.test.ts` | state monotonicity (`officially_notified` never downgraded), group expansion to members at the same minute, provenance fields, public exposure marks whole country, in-memory fallback parity with persisted path                                                                                                           |
| `server/services/scenarioValidation.test.ts`          | page-authored injects pass with page identity (exception to MO-INJ-005) and fail with wrong page handle; roster entries with injects fail `MO-CAST-007`; legacy `latent_grievances` ignored                                                                                                                                 |

Existing: `scripts/verify-multi-org-model.ts` (extended), `scripts/e2e-multi-org-generate.ts` (`--dyson` fixture: two orgs, footprint, pressure orgs, cast rule), `scripts/e2e-multi-org-routes.ts` (pressure org 400s; compile persists pressure pages when 205 applied), plus a new `scripts/e2e-exec-decisions.ts`: starts a session on the Dyson fixture, sends the CEO email through the real endpoint, asserts the `session_decisions` row, knowledge states, pending cascade injects, and the trainer endpoint tree (acceptance §7 items 1–4, 7).

---

## 8. Acceptance (from the handover §7/§10.6, mapped to phases)

1–3, 7, 8, 9, 10 → P5 + P6 E2E. 4 (union override + verdict) → P5 §6.4 + existing judge. 5 (MOHR chain) → planner second-order. 6 (country scoping) → contract §4.1 + footprint rule. 11 (distribution list) → P2 + §6.3. 12 (notice before/after) → §6.6 re-plan. 13 (roster post + reporter deadline) → planner nodes. 14 (provenance) → §6.3. 15 (tone grade) → §6.6.

---

## 9. Degradation & safety

- `ENABLE_EXECUTIVE_DECISIONS=false` → no hooks fire, no cost.
- Migration 205 missing: boot probe detects; pressure pages are **not seeded** (loud error, engine idle); `session_decisions.detail` absent → detail kept in memory per session; `decision_knowledge`/`decision_events` absent → in-memory; new `session_events` types fall back to `decision_recorded` / `antagonist_post` with `metadata.kind`. Every fallback logs once per boot with the migration name.
- Per-session caps: ≤ 1 detection call per coalesced executive message, ≤ 1 plan call per decision, ≤ 6 decisions per session, ≤ 8 cascade injects per decision; pressure engine ≤ 1 call per page per tick.
- Hidden fields never leave the server: trainer endpoints return summaries and quoted **player** messages only; player endpoints get nothing new.
- No player-facing "decision detected" UI, no broadcast to the org.

---

## 11. Delivery record (2026-09-20)

| Slice                                                                                        | Commit      | Verification                                                                      |
| -------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| P0 retire + P1 contract v3.2 + migration 205 + P2 cast completeness                          | `72838b6`   | `npm test`, `scripts/verify-multi-org-model.ts` 58/58                             |
| P3 footprint + pressure orgs (generator) + AI-operated offices + wizard/editor               | `908de94`   | frontend `tsc` + eslint                                                           |
| P4 pressure engine + engine ticker + seeding + console                                       | `f5d842f`   | server `tsc` + eslint                                                             |
| P5 organic decision engine (detection, planner, knowledge, cascade, trainer card, AAR)       | `1849dd5`   | server + frontend `tsc` + eslint                                                  |
| P6 unit tests (8 files, 67 new tests)                                                        | `825d800`   | `npm test` 120/120                                                                |
| Live E2E (`scripts/e2e-multi-org-generate.ts`, Sigma SG + SLM MY AI-operated + MOHR + union) | this commit | 52/52 checks, 572 s, contract §9 validation on 202 timed / 15 conditional injects |

**Open for the runtime agent:** apply `migrations/205_pressure_and_organic_decisions.sql`;
acknowledge contract v3.2 (§13 of the contract); runtime gaps R1–R3 (handover §10.5) — the engine
builds against the workarounds noted there (recipients from `to_addresses`, one mail per carrier,
found-out messages carry the decision summary in the body).

**Not yet exercised live:** a full session run of the detection → cascade path (needs a live
session with an Executive player); unit tests cover every pure rule, and the IO layer degrades to
in-memory state pre-205. `scripts/e2e-exec-decisions.ts` (plan §7) is the follow-on.

## 10. Self-review notes (2026-09-20)

- Reuses `session_decisions` instead of a new ledger head; `detail JSONB` avoids widening 203's columns. ✔
- Cascade injects use the existing `'decision_response'` generation_source → no CHECK migration, no repeat of the `decision_eruption` bug. ✔
- Detection fires on player-to-player mail because the hook sits outside the `primaryRecipientIsPlayer` branch. ✔
- Page-authored statements need no scheduler change: author fields are complete on the row; verdicts flow through `stakeholder_id`. ✔
- Runtime files edited only at touch points (email route, chat route, `env.ts` flag, `index.ts` boot import, AAR data, dashboard card, `SocialAARCharts` block, `seedOrgPages`, `AdversaryConsole`, `PageAssignmentModal`) — each flagged in its commit message. `injectSchedulerService.ts` and `sessions.ts` are not touched (the runtime agent has uncommitted work there).
- Risk: the planner's quality depends on the cast; hence P2 before P5 and `MO-CAST-*` as a hard rule.
