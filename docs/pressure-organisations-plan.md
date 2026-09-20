# Pressure Organisations — plan & spec sheet

**Status:** proposed (v1, 20 Sep 2026). Not yet scheduled.
**Depends on:** `docs/stakeholder-contacts-contract.md` (v3), `docs/multi-org-coalition-plan.md` (shipped), `docs/stakeholder-runtime-plan.md` (shipped), migrations 177/185/188 (org pages), 197 (team identity), 200–203 (stakeholder runtime + decision layer).
**Ownership:** generator agent owns §5 (model, wizard, generation, validation, editor); runtime agent owns §6 (contract bump, migration, seeding, engine, console, AAR). §4 is the shared contract change and needs sign-off from both before either side builds.

---

## 0. One-paragraph summary

Today a scenario has two kinds of organisation: **protagonists** (the trainer's side, with player teams) and **antagonists** (competitor brands, AI-driven, "opportunistic rival" voice). Real crises are also pressured by actors who are neither: labour unions, regulators and ministries, NGOs, community groups, political figures. These already exist as **stakeholder contacts** (named, contactable, with grievances that fire and can be talked down) and as **feed personas**, and they already react to executive decisions — but they have no **institutional page**: no profile with followers, no timeline of statements, nothing the trainer can seize and speak through. This plan adds a third side, **pressure organisations**, as AI-driven pages whose voice is advocacy or statutory rather than competitive, each anchored to a spokesperson stakeholder so the existing reconsideration mechanic (reach the person, meet their criteria, the statement softens or is withdrawn) carries over to the page. Pages are optional presentation on top of the characters; leaving the section empty changes nothing about who exists or acts.

---

## 1. Why (the Dyson case)

The CEO in Singapore orders the Malaysian factory shut. Within hours: the Malaysian transport/manufacturing union demands consultation; the Ministry of Human Resources announces an inspection and asks for records; a labour-rights NGO calls for a boycott; the Singapore Ministry of Manpower asks about cross-border scheduling; an opposition MP posts. None of these is a competitor. In the current model the trainer has two bad options: create them as "competitors" (they then speak like a rival vacuum brand — wrong register, wrong motives, wrong moves) or leave them page-less (they still email, call and post as individuals, but no institution ever "issues a statement" on the feed, and the trainer cannot seize them).

**Design principle (unchanged from the contract):** _characters are the substance; pages are presentation._ The workforce, the union secretary and the ministry officers are generated from the crisis regardless of pages (evidence in §2.3). Pressure pages add reach, a timeline, a lever, and a trainer console — they never gate whether people exist or act.

---

## 2. Current state (verified against code, 20 Sep 2026)

### 2.1 Sides and pages

- `initial_state.org_page.orgs[]` (`OrgConfig`, `socialCrisisGeneratorService.ts`): `role: 'protagonist' | 'antagonist'`, `control_mode: 'player' | 'ai' | 'trainer'`, `stance?` (antagonists only), `auto_generated?`, `country?`, `city?`.
- Registry `initial_state.orgs[]` (`server/lib/stakeholderContract.ts` `OrgRegistryEntrySchema`): `side: 'protagonist' | 'antagonist'`, `kind: 'company' | 'office' | 'agency' | 'ngo' | 'other'`.
- DB: `sim_org_pages.role CHECK (role IN ('protagonist','antagonist'))`, `control_mode CHECK ('player','ai','trainer')` (migration 188). Seeded per session from `org_page.orgs[]` by `seedOrgPages()` (`ambientContentService.ts`), one row per platform per org.
- Auto-antagonist: when no competitor is named and the Setup checkbox is on, `generateSecondaryOrgPages()` invents exactly one rival brand (`auto_generated: true`).

### 2.2 Antagonist machinery is competitor-shaped

- Page generation prompt: "rival brands that will pressure the primary org; their voice should be competitive and opportunistic"; stance = "how this rival positions itself against the primary (e.g. the safer, more transparent alternative)".
- Runtime `antagonistEngineService.ts`: "You are running a HOSTILE RIVAL brand's social media account… a competitor pressuring…"; moves `quote_dunk | amplify_rumor | concerned_competitor | exploit_silence | call_the_switch | insinuate`; posts as `author_type: 'official_account'`, `posted_by_display_name: 'Antagonist AI'`; NPC pile-on via `triggerNPCReactions`; thread replies push back "hard". Skips `control_mode = 'trainer'` (seized).
- Trainer console `AdversaryConsole.tsx` lists `role === 'antagonist'` pages; seize/release via `POST /api/social/pages/session/:id/seize`.
- `PageAssignmentModal.tsx` refuses to assign antagonist pages to players.

A union or ministry created through this path would be voiced as a rival brand. That is the gap.

### 2.3 What labour and authorities get today without any page (evidence: two-org Sigma Logistics run, 19 Sep 2026)

- Stakeholder contacts: 9 regulators (Singapore MOM work-pass/WSH officers; Malaysia MOHR Labour Standards Enforcement, Johor), 1 union (Transport Workers Union Malaysia, Johor Branch Secretary), 5 community figures, 13 internal ground staff; owned by Legal, Driver Relations, Communications, Fleet Operations as appropriate; 30 of 48 with a grievance and scheduled action; regulators `persuadability none/low` with hard constraints.
- Feed personas: 20 key voices with a labour angle across both countries (worker accounts, wage watchdog, boycott caller, MP, labour reporters).
- Groups: top communities become Facebook groups ("Sigma Logistics drivers and depot workers … Community").
- Decision layer: "Suspend Johor night runs" carried obligations (brief clients / MOHR & MOM / internal contingency plan) and latent grievances on the union secretary, 10 internal staff, community and partner contacts.

So: people, yes; institution, no.

---

## 3. Target experience

### 3.1 Trainer (War Room Setup)

A new section **"Pressure groups & authorities"** under Additional Organisations / Competitors:

- The War Room **proposes** pressure organisations from the crisis text and the organisations' countries (e.g. MOHR Malaysia · regulator · Malaysia; MOM Singapore · regulator · Singapore; a manufacturing union · union · Malaysia; a labour-rights NGO · ngo · Malaysia). Each proposal is a chip with kind, country, and one-line reason; default **on**.
- Trainer can remove any, edit name/kind/country/posture, or add their own (name, kind, country, optional handles, optional "what they want" free text). Cap 6.
- Leaving the section empty (or removing every proposal) is valid and changes nothing about stakeholders or personas.

### 3.2 Build & Review

- Pages generated with an **advocacy/statutory** identity and a 4–8 post pre-crisis history in the right register (a ministry posts advisories and enforcement notices; a union posts member updates and campaigns; an NGO posts reports).
- Each pressure org is **anchored to a spokesperson stakeholder** (existing or newly generated) — the person the team can email or call.
- Review shows pressure orgs grouped by country with their spokesperson, posture, and scheduled statements.

### 3.3 In the session

- Players see the union / ministry pages on the feed and can open their profiles and timelines. They cannot be assigned to them.
- The pages **issue statements** on schedule (T+15..45) and **react** to what players do: a union that gets a direct, factual reply from Driver Relations meeting its criteria posts "we have received assurances… we will hold the company to them" instead of a strike notice; a ministry that receives the records it asked for posts a neutral update instead of an enforcement warning. The mechanic is the existing stakeholder reconsideration flow, applied to page-authored injects through the spokesperson link.
- Executive decisions route eruptions to pages where appropriate: closing the factory without briefing the union produces the _union page's_ statement, not only a personal post.
- Trainer can **seize** a pressure page from the console and post as it, exactly like antagonists.

### 3.4 AAR

- Stakeholder pre-emption credit already covers "team reached the spokesperson before the statement fired"; page statements withdrawn or softened show up there.
- Optional "Pressure timeline" strip: each pressure org's statements with T+ and whether they were softened/withdrawn, and by which team.

---

## 4. Shared contract changes (v3 → v4) — needs both agents' sign-off

### 4.1 Registry (`initial_state.orgs[]`)

- `side`: add `'pressure'`.
- `kind`: add `'union' | 'regulator' | 'ngo' | 'community_group' | 'political'` (keep `company | office | agency | ngo | other`; `agency` remains for protagonist public bodies, `regulator` is the pressure-side authority).
- New optional field `spokesperson_stakeholder_id?: string` — required when `side === 'pressure'`.
- Validation: every `side: 'pressure'` entry has a `country`, a `kind` from the pressure set, and a `spokesperson_stakeholder_id` that resolves to a stakeholder.

### 4.2 Page config (`initial_state.org_page.orgs[]`, `OrgConfig`)

- `role`: add `'pressure'`. `control_mode` default `'ai'`.
- New `posture` (pressure only; replaces `stance`):
  ```ts
  posture: {
    register: 'statutory' | 'advocacy' | 'grassroots' | 'political';
    mandate: string;            // what this body exists to do (1 sentence)
    demands: string[];          // 2–4 concrete demands on the protagonist(s)
    escalation_ladder: string[];// ordered: statement → demand with deadline → action (inspection / strike notice / boycott / fine)
    targets_org_keys: string[]; // protagonist org_keys this body is pressing (non-empty)
    stand_down_signals: string[]; // what visibly satisfies them (mirrors spokesperson resolution_criteria)
  }
  ```
- `spokesperson_stakeholder_id: string` (same value as the registry entry).

### 4.3 Stakeholder (`Stakeholder`)

- New optional `page_org_key?: string` — reverse link; set on the spokesperson. Validation: `orgs[page_org_key].spokesperson_stakeholder_id === stakeholder.id` (MO-PRS-004).

### 4.4 Injects authored _by a page_ (new exception to §4.2 author rule)

- `delivery_config.page_org_key: string` marks a page-authored inject (social post or news-style statement).
- Author fields = **page identity** (`author_handle` = page handle for the platform, `author_display_name` = page name, `author_type: 'official_account'`), not the person — this is the documented exception to MO-INJ-005.
- `delivery_config.stakeholder_id` = the spokesperson, so `getPendingInjects()` / `inject_verdicts` / `enforceVerdict()` apply unchanged: the spokesperson's verdict governs the page's statement.
- `country` = the page organisation's country (existing §4.1 rule, `orgCountryForPage`).
- Minimum trigger T+15 for page statements (institutions are slower than individuals).

### 4.5 Condition/event vocabulary

- New `session_events.event_type`: `pressure_post`, `pressure_reply`, `pressure_stand_down`.
- Optional new condition primitive for templates: `pressure_stand_down:<org_key>` (fires when the page's spokesperson has issued a `cancel`/`modify` verdict on its pending statement) — lets the generator write "relief" beats. Reserved; not required for v1.

### 4.6 Player visibility

- Pressure pages are visible to every player in the page's country scope (same as antagonists). Spokesperson stakeholders keep their normal owning-team visibility; the link `page_org_key` is player-visible (so the contacts sheet can show "speaks for: Transport Workers Union Malaysia").

---

## 5. Generator side (generator agent)

### 5.1 Model (`scenarioOrgModel.ts`)

- `PressureOrgInput { display_name, kind, country, register?, handles?, wants?: string, is_proposed: boolean }`; `NormalisedPressureOrg { org_key, display_name, short_name, kind, country, register, posture?, spokesperson_stakeholder_id? }`.
- `org_key`: `org_pressure_<slug>_<cc>` (never collides with `org_antagonist_*`).
- `validatePressureOrganisations()`: 0–6 entries; name 2–120 unique across all orgs (protagonist, antagonist, pressure); known country; kind ∈ pressure set; register ∈ set. Codes `MO-PRS-001..003` (count / identity / country-kind).
- Registry builder emits `side: 'pressure'` entries with `spokesperson_stakeholder_id`.

### 5.2 Auto-proposal (`suggestPressureOrganisations()`, one AI call, runs in `generate-npcs` after the fact sheet)

Input: crisis text, fact sheet, communities, protagonist orgs with countries. Output 2–6 proposals with `{display_name, kind, country, register, reason, confidence}`. Deterministic guard-rails applied in code:

- At most one `regulator` per country unless the crisis spans two regulated domains (e.g. labour + product safety) — then two.
- `union` only when the crisis text or communities mention workers, staff, drivers, labour, shifts, layoffs, closure, factory, plant, depot, overtime, safety; placed in the country of the affected workforce.
- `ngo` / `community_group` when a community is named in `affected_communities`.
- `political` only when a politician persona exists or the crisis text mentions government/parliament/minister.
- Proposals are returned to the wizard as suggestions, not persisted, until the trainer accepts.

### 5.3 Wizard (`SocialCrisisWizard.tsx`, `OrganisationRosterBuilder.tsx`)

- New section between Additional Organisations and Competitor Pages: proposed chips (kind badge, country, reason tooltip, on by default), "+ Add a pressure group / authority" with name, kind select, country select, register select, optional "what do they want" text, optional handles. Max 6, validation message mirrors server.
- Sent as `pressure_organisations[]` on `generate-storyline`, `generate-convergence`, `generate-org-page`, `compile`. Draft save/resume; legacy drafts default to empty.

### 5.4 Page generation (`generateSecondaryOrgPages` → new `generatePressureOrgPages`)

Prompt per pressure org (batched per country): identity for Facebook + X in the right register; bio; 4–8 pre-crisis posts (advisories, campaigns, reports — never product talk); `posture` (mandate, 2–4 demands aimed at `targets_org_keys`, escalation ladder of 3–4 rungs, stand-down signals). Register guidance:

- `statutory` (regulator/ministry): formal, procedural, cites law and process, never speculates, never amplifies rumour, escalates to inspection / notice / penalty.
- `advocacy` (union/NGO): members-first, cites specific harms, demands consultation and remedies, escalates to notice of industrial action / campaign / boycott; amplifies worker posts.
- `grassroots` (community group): local, emotional but factual, organises meetings/petitions.
- `political`: positions against the company but within the country's political register; questions to ministers, calls for inquiries.

### 5.5 Spokesperson (stakeholder generation)

For each pressure org, ensure exactly one stakeholder with `page_org_key = org_key`:

- Reuse when generation already produced a fitting contact for that body (match on `organisation` name + relationship); else generate one (`generatePressureSpokesperson()`).
- `relationship`: union → `union`; regulator → `regulator`; ngo/community_group → `community`; political → `other`.
- `owning_team` by kind and roster: regulator → `Legal` if present else `Communications`; union → the team whose charter covers workforce/HR/driver/employee relations if present, else `Communications`; ngo/community/political → `Communications`. `org_key` = the targeted protagonist org when `targets_org_keys.length === 1`, else `null` (common).
- `persuadability`: regulator `none|low` with a statutory hard constraint; union `low|medium` with "must inform members"; ngo/community `medium`; political `low`.
- `resolution_criteria` = the page's `stand_down_signals` (kept identical so page and person agree).

### 5.6 Statements and templates

- Scheduled: 1–2 page-authored injects per pressure org (`delivery_config.page_org_key`, `stakeholder_id` = spokesperson, author = page), first at T+15..30 (statement), second at T+35..50 (rung 2 of the ladder), `inject_scope: 'universal'`, `country` = page country.
- Decision layer (`decisionLayerService.ts`): when a decision affects a pressure org's target, the eruption for the spokesperson's latent grievance is routed to the **page** (`page_org_key`) instead of the personal handle; HQ follow-up and spillover unchanged.
- Cross-org: pressure statements are legitimate gate content for intel dependencies ("ministry notice" as the negative gate) — allowed but not required.

### 5.7 Validation (`scenarioValidationService.ts`)

| Code       | Rule                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| MO-PRS-001 | 0–6 pressure orgs; names unique across every side                                                                                |
| MO-PRS-002 | pressure `kind` ∈ set; `register` ∈ set; `country` known                                                                         |
| MO-PRS-003 | `posture.targets_org_keys` non-empty and all protagonist keys                                                                    |
| MO-PRS-004 | `spokesperson_stakeholder_id` resolves; that stakeholder has `page_org_key` = this org; relationship consistent with kind        |
| MO-PRS-005 | every page-authored inject has `stakeholder_id` = the page's spokesperson and author fields = the page identity for its platform |
| MO-PRS-006 | page-authored injects trigger ≥ T+15                                                                                             |
| MO-PRS-007 | `org_page.orgs[]` pressure entries have `role: 'pressure'`, `control_mode: 'ai'`, a `country`, and match the registry            |
| MO-PRS-008 | spokesperson `resolution_criteria` equals `posture.stand_down_signals` (order-insensitive)                                       |

### 5.8 Editor (`SocialScenarioEditor.tsx`, `StakeholdersSection.tsx`)

- Organisations card shows a "Pressure groups & authorities" group with kind/country/register and the spokesperson name (link to the contact).
- Editable: display name, posture fields, spokesperson (select among stakeholders of the matching relationship; server re-links `page_org_key`), handles, follower count.
- Stakeholder card shows "speaks for: <page>" badge; deleting a spokesperson is refused while a page references it (409) unless a replacement is chosen.
- Page-authored injects show a `page` tag and are edited like other injects; renaming the page propagates author fields (same mechanism as stakeholder rename).

### 5.9 Endpoints

- `POST /generate-npcs` returns `pressure_suggestions[]` (no persistence).
- All generate/compile bodies accept `pressure_organisations[]` (zod). Validation before AI and before credit, as today.
- Editor: `PATCH /api/scenarios/:id/pressure-orgs/:orgKey` (posture, spokesperson, identity), reusing the guard from `scenarioStakeholders.ts`.

---

## 6. Runtime side (runtime agent)

### 6.1 Migration 204 (`204_pressure_orgs.sql`)

- `sim_org_pages.role` CHECK → `('protagonist','antagonist','pressure')`.
- `sim_org_pages` add `spokesperson_stakeholder_id TEXT`, `register TEXT`, `kind TEXT`.
- `session_events.event_type` add `pressure_post`, `pressure_reply`, `pressure_stand_down`.

### 6.2 Seeding

- `seedOrgPages()` carries `role: 'pressure'`, `control_mode`, `spokesperson_stakeholder_id`, `register`, `kind`; branded history seeds as today.

### 6.3 Pressure engine (`pressureEngineService.ts`, sibling of the antagonist engine)

- Selection: `role = 'pressure' AND control_mode = 'ai'`; cadence lower than rivals (one move per page per 8–12 sim minutes, scaled by escalation state).
- State per page: current rung on `escalation_ladder`, last move, `stand_down` flag.
- Progress signals read before each move: spokesperson's latest `inject_verdicts` (keep/modify/delay/cancel), whether the targeted org published an official statement (`statementWatchdog` / drafts), whether the spokesperson was contacted (email/DM/call events), recorded decisions affecting the targets.
- Moves by register: `statement | demand_with_deadline | escalate_rung | acknowledge_progress | stand_down | correct_record` (regulators may "correct the record" against misinformation — they never amplify rumour; unions may `amplify_member_post`).
- Prompt framing: "You are the official account of <body> (<kind>, <country>). Your mandate: … Your demands: … You are pressing <targets>. Write in a <register> register. Never sell, never mock, never speculate beyond the facts you cite."
- Posts as `author_type: 'official_account'`, `posted_by_display_name: 'Pressure AI'`, `country` from `orgCountryForPage`; emits `pressure_post`.
- Thread replies: engage by name, institutional tone; no "push back hard" heuristic.
- Stand-down: when the spokesperson's effective verdict is `cancel` (or `modify` with softened content), the engine posts an `acknowledge_progress`/`stand_down` move once and emits `pressure_stand_down`; scheduled page statements already pass through `enforceVerdict()` because they carry `stakeholder_id`.

### 6.4 Inject scheduler

- Page-authored injects (`delivery_config.page_org_key`) render with the page identity for the inject's platform (look up `sim_org_pages` by `org_key` + platform), `country` scoping as today, verdict enforcement via `stakeholder_id` as today.

### 6.5 Trainer console

- `AdversaryConsole.tsx`: second group "Pressure groups & authorities" listing `role === 'pressure'` pages; seize/release and post-as-page reuse the existing endpoint. Seized pages skip the engine (same `control_mode = 'trainer'` rule).

### 6.6 Players

- `PageAssignmentModal.tsx`: exclude `role !== 'protagonist'` (already true for antagonists; make the filter positive).
- Contacts sheet: spokesperson row shows "speaks for: <page>" (`page_org_key`).
- Optional (P3): DMs to a pressure page route to the spokesperson's reply engine.

### 6.7 Scoring & AAR

- No new scoring dimension. Stakeholder pre-emption already credits teams whose contact led to a `modify`/`cancel` verdict; page statements inherit this through the spokesperson link.
- AAR executive summary: mention pressure stand-downs alongside stakeholder pre-emption. Optional "Pressure timeline" section (statements per page with T+, rung, verdict, credited team).

---

## 7. Phasing

| Phase | Owner     | Scope                                                                                                  | Exit criterion                                                                                                                         |
| ----- | --------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | both      | Contract v4 diff (§4) agreed; codes reserved                                                           | Both agents sign the diff in the contract doc                                                                                          |
| P1    | generator | §5.1–5.7: model, proposal call, wizard section, page + spokesperson generation, statements, validation | Dyson fixture compiles with 3 pressure orgs; offline checks green; runtime can read the shapes (their schema tests pass)               |
| P2    | runtime   | §6.1–6.5: migration 204, seeding, pressure engine, scheduler rendering, console                        | Live session: union page posts statement at T+20; contacting the spokesperson with the criteria produces stand-down; trainer can seize |
| P3    | generator | §5.8–5.9 editor + endpoints                                                                            | Trainer can re-link a spokesperson and edit demands post-compile                                                                       |
| P4    | runtime   | §6.6–6.7 contacts-sheet badge, AAR strip, DM routing                                                   | AAR shows pressure stand-downs credited to teams                                                                                       |

P1 and P2 can run in parallel after P0; P1 output is inert at runtime until P2 (pages seed with role `pressure` only after 204; before that, compile refuses pressure orgs with a clear message, mirroring the migration-197 guard).

---

## 8. Acceptance checklist

Offline (`scripts/verify-multi-org-model.ts` extension):

- Proposal guard-rails: labour crisis → union proposed in the workforce's country; non-labour crisis → no union; one regulator per country by default.
- Validation: each MO-PRS code has a negative case; a stakeholder deletion that orphans a page is refused.

Live generation (`scripts/e2e-multi-org-generate.ts --pressure`), Dyson fixture (Singapore HQ company + Malaysia factory office; Executive at HQ):

- ≥2 pressure orgs generated with posture; each has a spokesperson with matching criteria; page-authored statements ≥ T+15 with page identity + spokesperson id; decision "close_factory" routes the union's eruption to the union page.
- Single-org regression: zero pressure orgs → payload identical in shape to today (no `side: 'pressure'`, no `page_org_key`).

HTTP (`scripts/e2e-multi-org-routes.ts`):

- Invalid pressure org → 400 MO-PRS-\* before AI and before credit.
- With migration 204: compile persists `sim_org_pages` rows on session start with `role = 'pressure'`; without it: compile refuses with a named-migration message.

Runtime (runtime agent's harness):

- Engine posts in register; regulator never posts a rumour; union amplifies a worker post; stand-down after a satisfying reply; seized page skipped by the engine.

---

## 9. Open questions

1. Should a pressure org be allowed to target **antagonist** orgs (e.g. the regulator also inspects the competitor)? v1: protagonists only.
2. Media outlets: keep as personas + stakeholders (today) or allow `kind: 'media_outlet'` pages? v1: keep as personas; newsrooms already have the News app.
3. Should the trainer be able to set a pressure page to `control_mode: 'player'` for red-team exercises (a player plays the union)? Cheap to allow later; v1 no.
4. Cost: each pressure org adds ~1 page-generation call (batched per country) and at most 1 spokesperson call. Cap 6 keeps the build under +3 minutes.

---

## 10. Appendix — worked example (Dyson-style fixture)

Registry entry:

```json
{
  "org_key": "org_pressure_mtuc_my",
  "display_name": "Manufacturing Workers Union Malaysia",
  "short_name": "MWUM",
  "country": "Malaysia",
  "kind": "union",
  "side": "pressure",
  "spokesperson_stakeholder_id": "stk_mwum_rahimah_bakar"
}
```

Page config (`org_page.orgs[]`):

```json
{
  "org_key": "org_pressure_mtuc_my",
  "display_name": "Manufacturing Workers Union Malaysia",
  "role": "pressure",
  "control_mode": "ai",
  "country": "Malaysia",
  "city": "Johor Bahru",
  "facebook": {
    "page_name": "MWUM — Johor",
    "page_handle": "@MWUMJohor",
    "page_bio": "Voice of manufacturing workers in Johor.",
    "follower_count": 48000
  },
  "x_twitter": {
    "page_name": "MWUM Johor",
    "page_handle": "@mwum_johor",
    "page_bio": "Manufacturing Workers Union Malaysia, Johor branch.",
    "follower_count": 21000
  },
  "posture": {
    "register": "advocacy",
    "mandate": "Protect the jobs, pay and safety of manufacturing workers in Johor.",
    "demands": [
      "Immediate consultation with the union before any closure decision is finalised",
      "Full disclosure of the closure timeline and severance terms",
      "Written guarantee of statutory retrenchment benefits"
    ],
    "escalation_ladder": [
      "Public statement demanding consultation",
      "Notice of picket at the plant gate with 48-hour deadline",
      "Notice of industrial action filed with the Department of Industrial Relations"
    ],
    "targets_org_keys": ["org_dyson_my", "primary"],
    "stand_down_signals": [
      "Direct meeting request from management within 24 hours",
      "Written closure timeline and severance terms shared with the union",
      "Named management contact for members' questions"
    ]
  },
  "spokesperson_stakeholder_id": "stk_mwum_rahimah_bakar"
}
```

Spokesperson stakeholder (excerpt):

```json
{
  "id": "stk_mwum_rahimah_bakar",
  "name": "Rahimah Bakar",
  "title": "Branch Secretary",
  "organisation": "Manufacturing Workers Union Malaysia — Johor",
  "relationship": "union",
  "owning_team": "Employee Relations",
  "org_key": "org_dyson_my",
  "page_org_key": "org_pressure_mtuc_my",
  "email": "rahimah.bakar@mwum.sim",
  "handle": "@rahimahb_mwum",
  "note": "Represents plant workers; prefers written commitments and a named contact.",
  "grievance": "Learned of the closure from members' WhatsApp groups; no consultation, no timeline, no severance detail.",
  "resolution_criteria": [
    "Direct meeting request from management within 24 hours",
    "Written closure timeline and severance terms shared with the union",
    "Named management contact for members' questions"
  ],
  "persuadability": "low",
  "hard_constraints": ["Must inform members of any development within the hour"]
}
```

Page-authored statement inject:

```json
{
  "trigger_time_minutes": 20,
  "type": "social_post",
  "title": "MWUM statement on the plant closure",
  "severity": "high",
  "inject_scope": "universal",
  "target_teams": [],
  "content": "MWUM Johor demands immediate consultation on the reported closure of the Senai plant. Our members learned of this from social media, not from management. We expect a written timeline and severance terms within 48 hours.",
  "delivery_config": {
    "app": "social_feed",
    "platform": "facebook",
    "page_org_key": "org_pressure_mtuc_my",
    "stakeholder_id": "stk_mwum_rahimah_bakar",
    "author_handle": "@MWUMJohor",
    "author_display_name": "MWUM — Johor",
    "author_type": "official_account",
    "country": "Malaysia"
  }
}
```

If Employee Relations emails Rahimah before T+20 with a meeting request, the timeline and a named contact, the runtime's reconsideration judge records a `modify` (low persuadability: `cancel` is not allowed; the statement fires softened) and the pressure engine posts an `acknowledge_progress` move; the AAR credits Employee Relations under stakeholder pre-emption.
