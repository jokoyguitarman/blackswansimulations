# Stakeholder Contacts — generation ↔ runtime contract

Version 3.2 — 2026-09-20 — **status: accepted by both agents. v3.2 is the ADDITIVE set the
generator agent was authorised to apply for the organic executive-decision model and pressure
organisations (handover §9 / §10.2, product owner 2026-09-20); acknowledged by the runtime agent
2026-09-20 (migrations 205 and 206 applied; runtime readers listed under v3.2 in §13)** (changes in
§13). §7A (menu-based decision layer) is RETIRED; the organic model is specified in
`docs/executive-decisions-organic-plan.md`. Runtime delivery order lives in
`docs/stakeholder-runtime-plan.md`.

Two agents work in parallel on this feature:

- **Generator agent** — scenario generation and persistence (`socialCrisisGeneratorService.ts`,
  `socialCrisisPersistenceService.ts`, related war-room/blueprint services, `routes/scenarios.ts`
  generation endpoints). Produces the data described here.
- **Runtime agent** — everything that consumes it during a session: inject scheduler, NPC reply
  engines (email / TeamChat / Messenger), TeamChat, the contacts workbook app, Mail autocomplete,
  scoring hooks, trainer views.

This document is the only thing the two sides need to agree on. Anything not listed under
"Shared surface" is one side's private business and may change without notice.

---

## 1. What the feature is

1. Scenarios gain **developed stakeholder characters**: named clients, suppliers, regulators,
   partners, journalists, internal managers, community figures. Each has contact details, an
   affiliation (which office / HQ of the organisation they relate to), a relationship to exactly
   one response team, and — usually — one or more **scheduled injects that fire on their behalf**
   (a client posts a public complaint at T+25, a regulator emails a notice at T+40, a journalist
   publishes at T+30).
2. If a player contacts a stakeholder **before** their inject fires — email, TeamChat, Messenger,
   phone — the stakeholder reads the whole exchange and decides whether the inject still stands:
   keep, modify, delay, or cancel. The verdict depends on whether the player actually addressed
   the stakeholder's grievance, not on being asked nicely.
3. Every player gets a **read-only contacts workbook** (Excel clone, sibling of the Docs/Word
   clone) preloaded on phone and desktop. It lists the stakeholders that belong to the player's
   team at the player's office, one sheet per relationship type (Clients, Suppliers, …).
4. The ambient NPC crowd (`npc_personas`) grows to **200 per country** to make room; those are not
   stakeholders unless also listed in the stakeholders block.

Confirmed product decisions (not up for re-litigation in this iteration):

- Contacts owned by a department are visible **only to that department**, and only to the
  department at the **same office**. No cross-team browsing.
- Persuadability is bounded per character; some characters cannot be talked out of their inject.
- The workbook is **read-only** in this iteration.

---

## 2. Shared surface

Everything that crosses the boundary:

| Surface                                                                                                                                                                                                                                                                                                                                        | Written by            | Read by                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------- |
| `scenarios.initial_state.stakeholders` (new array)                                                                                                                                                                                                                                                                                             | generator             | runtime                               |
| `scenario_injects.delivery_config.stakeholder_id` (new key)                                                                                                                                                                                                                                                                                    | generator             | runtime                               |
| `scenario_injects.delivery_config.org_key` / `.country` (new keys, §4.1)                                                                                                                                                                                                                                                                       | generator             | runtime                               |
| `scenarios.initial_state.orgs[]` (new array — canonical organisation registry, §5.1)                                                                                                                                                                                                                                                           | generator             | runtime                               |
| `scenarios.initial_state.countries[]` (new optional array, §5.1)                                                                                                                                                                                                                                                                               | generator             | runtime                               |
| `scenario_teams.org_key`, `scenario_teams.function_key` (new nullable columns, §5.2)                                                                                                                                                                                                                                                           | generator             | runtime                               |
| `initial_state.org_page.orgs[].country / city` (optional; must agree with `orgs[]`)                                                                                                                                                                                                                                                            | generator             | runtime                               |
| `initial_state.npc_personas[].country` (new optional field, §5.3)                                                                                                                                                                                                                                                                              | generator             | runtime                               |
| **Retired (§7A, 2026-09-20):** `initial_state.decision_space[]`, `initial_state.chain_of_command[]`, `stakeholders[].latent_grievances`, `delivery_config.decision_key`, primitive `decision_recorded:*` — the runtime no longer reads them (still parsed/preserved so compiled scenarios load). Generator to stop emitting; see handover doc. | generator (to remove) | nobody                                |
| **Kept (generic):** `delivery_config.inject_key`, condition primitives `inject_published:<inject_key>` / `inject_cancelled:<inject_key>` — any inject may depend on another having fired or been cancelled                                                                                                                                     | generator             | runtime (`conditionEvaluatorService`) |

Every new field is optional. A scenario compiled without any of them runs exactly as it does today.

Plus one shared code file, `server/lib/stakeholderContract.ts`, containing the TypeScript types,
the zod schema, the relationship → sheet-label map and the visibility predicate below. **The
runtime agent creates this file in its first commit after sign-off**; the generator agent imports
it for validation at persistence time. Until it lands, code against the shapes in this document.

---

## 3. `initial_state.stakeholders[]`

```ts
export type StakeholderRelationship =
  | 'client'
  | 'supplier'
  | 'regulator'
  | 'partner'
  | 'internal' // colleagues inside the organisation (duty managers, ops leads, HR, …)
  | 'media'
  | 'community'
  | 'investor'
  | 'union'
  | 'other';

export type Persuadability = 'none' | 'low' | 'medium' | 'high';

export interface Stakeholder {
  // ─── Identity (player-visible) ───────────────────────────────────────────
  /** Stable slug, unique within the scenario. Referenced by injects. e.g. "stk_meridian_logistics_jtan" */
  id: string;
  name: string; // "Jasmine Tan"
  title: string; // "Head of Procurement"
  organisation: string; // "Meridian Logistics Pte Ltd" — for internal staff, the org's own name
  relationship: StakeholderRelationship;
  /** The team FUNCTION that owns this relationship — "Communications", "Legal", … — matched against
   *  `scenario_teams.function_key` (falling back to exact `team_name` for teams without one).
   *  Never a composed per-org name like "Communications — PNP"; use `org_key` for that. */
  owning_team: string;
  /** Organisation this stakeholder relates to: an `initial_state.orgs[].org_key`.
   *  null = COMMON stakeholder — visible to the owning function's team in every organisation,
   *  as ONE identity (one email, one handle, one shared conversation memory).
   *  Also the value for every stakeholder in a single-org scenario. */
  org_key: string | null;

  // ─── Contact details (player-visible) ────────────────────────────────────
  /** Lowercase, unique across stakeholders. MUST equal `from_address` on every email inject
   *  authored by this stakeholder. Fictional TLD convention: `<local>@<orgslug>.sim`. */
  email: string;
  /** Free-form display string, e.g. "+65 6123 4567". MUST equal `from_address` on every
   *  phone_call inject authored by this stakeholder. */
  phone: string | null;
  /** `@handle`, /^@[a-z0-9_]{3,30}$/, unique across stakeholders, npc_personas and org pages.
   *  Used for TeamChat / Messenger identity. Include an org or role fragment to avoid colliding
   *  with player handles, which are derived as `@firstname_lastname`. e.g. "@jtan_meridian" */
  handle: string;
  /** One or two sentences the player is allowed to see in the workbook's Notes column.
   *  Relationship context only — never the grievance or the scheduled inject. e.g.
   *  "Key account, ~18% of regional revenue. Contract renewal due Q4." */
  note: string;
  avatar_url?: string;

  // ─── Character (HIDDEN — never sent to player clients) ───────────────────
  personality: string; // register, temperament, how they write
  /** Current posture toward the organisation in this crisis. */
  stance: string;
  /** Facts this person holds and will share if asked. May quote `fact_sheet` entries. */
  knowledge: string[];
  /** Things they will not disclose or do, regardless of how they are asked. */
  will_not_disclose: string[];

  // ─── Reconsideration model (HIDDEN) ──────────────────────────────────────
  /** Why their scheduled inject(s) exist — the concern or need driving them. Empty string if
   *  this stakeholder has no scheduled injects (pure contact). */
  grievance: string;
  /** Concrete, checkable things a player exchange must contain or achieve before this
   *  stakeholder would drop or soften the inject. 1–4 items. Empty if `grievance` is empty. */
  resolution_criteria: string[];
  persuadability: Persuadability;
  /** Constraints the judge must respect even when criteria are met (statutory duty, editorial
   *  independence, board instruction, …). Usually paired with persuadability 'none' or 'low'. */
  hard_constraints: string[];

  // ─── RETIRED with the menu-based decision layer (§7A, 2026-09-20). Still parsed so compiled
  //     scenarios load; the runtime ignores it. Generator: stop emitting. ──
  /** @deprecated */
  latent_grievances?: Record<
    string /* decision_key */,
    {
      grievance: string;
      resolution_criteria: string[];
      persuadability: Persuadability;
      hard_constraints: string[];
      eruption_inject_keys: string[];
    }
  >;
}
```

### 3.1 Persuadability → allowed verdicts

The runtime's judge may only return outcomes from this table. The generator chooses the level;
this table is what it means.

| `persuadability` | Allowed outcomes for each pending inject | `cancel` requires                                                                                    |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `none`           | keep · modify                            | — (never cancels; wording may acknowledge the exchange, e.g. "despite assurances from the company…") |
| `low`            | keep · modify · delay (≤ 15 min)         | — (never cancels)                                                                                    |
| `medium`         | keep · modify · delay · cancel           | **all** `resolution_criteria` met                                                                    |
| `high`           | keep · modify · delay · cancel           | **most** `resolution_criteria` met                                                                   |

`hard_constraints` are always respected regardless of level. A player message that only asks
the stakeholder to hold off, with no substance, never satisfies a criterion.

### 3.2 Generation rules

1. `owning_team` must equal some team's `function_key`, or — for teams with no `function_key` —
   its exact `team_name`, within the same scenario. When `org_key` is set, at least one team
   with that `org_key` must match; when null, at least one team in the scenario must match.
2. `org_key`, when set, must match an `initial_state.orgs[].org_key` whose `side` is
   `protagonist`. A stakeholder relevant to every organisation is emitted **once** with
   `org_key: null` — never duplicated per org with suffixed ids/emails/handles.
3. `id`, `email`, `handle` are each unique across the array. `handle` is also unique against
   `npc_personas[].handle` and every org page handle.
4. A stakeholder who authors any `social_post` inject, or who is expected to react on the feed,
   **must also have an `npc_personas` entry with the identical `handle`**. The persona carries the
   public-facing personality the ambient engines already read; the stakeholder record carries the
   relationship, contacts and reconsideration model. Stakeholders who only email / call / chat
   need no persona.
5. Every team × office that exists in the scenario should have contacts. Guidance: 6–20 per team
   per office, covering at least the relationship types that team's charter references
   (Sales → clients; Procurement → suppliers / partners; Legal → regulators / counsel;
   Communications → media / community). Keep it readable — the workbook is a spreadsheet, not a
   CRM.
6. **Include contacts with no scheduled inject** (`grievance: ''`). If everyone in the sheet is
   about to detonate, the sheet becomes a cheat sheet.
7. `note` is player-visible. It must not reveal the grievance, the inject or its timing.
8. Internal stakeholders (`relationship: 'internal'`) follow the existing sender-realism rule:
   ground-level operational staff, never C-suite.

---

## 4. Injects authored by a stakeholder

Add `stakeholder_id` to `delivery_config` and keep the author fields in exact agreement with the
stakeholder record:

```ts
interface SocialInjectDeliveryConfig {
  // existing fields unchanged …
  /** `Stakeholder.id` of the character this inject is issued by. Present on every inject a
   *  stakeholder authors — social post, email, phone call, news article. */
  stakeholder_id?: string;
  /** Organisation this inject is FOR (delivery scope) — an `initial_state.orgs[].org_key`.
   *  See §4.1. Absent = all organisations. */
  org_key?: string;
  /** Country whose feed / news this content belongs in — an `initial_state.orgs[].country` value.
   *  See §4.1. Absent = every country. */
  country?: string;
  /** Stable cross-reference key for this inject, so other injects can depend on it via
   *  `inject_published:<inject_key>` / `inject_cancelled:<inject_key>` (generic, kept). */
  inject_key?: string;
  /** @deprecated Retired with the menu-based decision layer (§7A). Preserved verbatim, unread. */
  decision_key?: string;
}
```

### 4.1 Scoping keys — what the runtime does with them

| `app`                               | `org_key`                                                                                                                                             | `country`                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`, `phone_call`, `group_chat` | Delivered only to players whose team's `scenario_teams.org_key` equals it (intersected with existing `target_teams` / `stakeholder_team` routing).    | Informational only.                                                                                                                                  |
| `social_feed`, `news`               | Informational (which organisation the content concerns; used by scoring/AAR attribution). Does **not** restrict visibility — public posts are public. | Post/article appears only in the feeds and News app of players whose organisation's `country` equals it. Absent → everyone. Trainers see everything. |

Consistency: when both are set, the org named by `org_key` must be located in `country`.
NPC-generated follow-ons (reactions, replies, hive threads) inherit the `country` of the post they
attach to. Posts originated by an **org page itself** — antagonist pages driven by the AI engine,
ally pages, player-published page posts — are stamped with that page's org `country` from the
registry (`org_page.orgs[].org_key → orgs[].country`). Existing injects without these keys behave
exactly as today.

### 4.2 Author fields

| Inject `app`  | Must equal the stakeholder's …                                                      |
| ------------- | ----------------------------------------------------------------------------------- |
| `social_feed` | `author_handle` = `handle`; `author_display_name` = `name`                          |
| `email`       | `from_address` = `email`; `from_name` = `name`; `stakeholder_team` = `owning_team`  |
| `phone_call`  | `from_address` = `phone`; `from_name` = `name`                                      |
| `news`        | `outlet_name` = `organisation`; if also posted socially, `author_handle` = `handle` |

Rules:

1. **Trigger window.** Any inject carrying `stakeholder_id` and a `trigger_time_minutes` must
   have `trigger_time_minutes >= 10`. Players need time to find the contact and act; an inject at
   T+2 cannot be pre-empted and defeats the mechanic. Condition-driven injects are exempt.
2. Stakeholder-authored **emails** are `inject_scope: 'team_specific'` with **explicit composed
   `target_teams`** — every team whose `resolveTeamFunction` equals `owning_team` (and whose
   `org_key` matches, or all such teams for a common stakeholder). `stakeholder_team` is still
   set to the function name (§4.2) but is **informational**: the generator never relies on it for
   routing, because today's runtime resolves it by exact `team_name` and falls back to
   session-wide delivery when nothing matches. The runtime additionally resolves it via
   `function_key` (§7 item 9) as belt-and-braces. Social posts and news are universal as today.
3. A stakeholder may author several injects (email at T+15, public post at T+30 if unresolved).
   Each is judged separately at its own fire time.
4. `stakeholder_id` values that resolve to nothing are a generation bug. Runtime logs a warning,
   treats the inject as ordinary (no reconsideration) and still fires it — nothing is silently
   dropped.

---

## 5. Organisations, offices and countries

"Organisation" covers every case: one company; a multinational's offices/HQs, each as its own
org; or several agencies in one scenario (AFP, NBI, PNP, PDRM). One registry describes them all.

### 5.1 `initial_state.orgs[]` — canonical organisation registry

```ts
export interface OrgRegistryEntry {
  org_key: string; // stable slug, unique in the scenario: "org_pnp_ph", "sg_hq"
  display_name: string; // "Philippine National Police"
  short_name?: string; // "PNP"
  country: string; // display name, used as the country identity everywhere: "Philippines"
  city?: string;
  kind?: 'company' | 'office' | 'agency' | 'ngo' | 'other';
  side: 'protagonist' | 'antagonist'; // players are only ever assigned to protagonist orgs
  is_primary?: boolean; // exactly one protagonist entry
}

export interface CountryEntry {
  name: string; // must equal an `orgs[].country` value
  code?: string; // ISO 3166-1 alpha-2, e.g. "PH"
  timezone?: string;
  languages?: string[];
}
```

- `initial_state.orgs[]` is **the** source of truth for which organisations exist and where.
- `initial_state.countries[]` is optional metadata. When absent, runtime derives the country list
  from `orgs[].country`. When present, every `orgs[].country` must appear in it.
- `org_page.orgs[]` (social pages) is unchanged in shape but, when both exist, each page's
  `org_key` **must** reference an `orgs[]` entry. An org may have no page (war-room scenarios).
- Backward compatibility: when `orgs[]` is absent, runtime derives a registry from
  `org_page.orgs[]` (protagonist/antagonist → `side`); when that is absent too, one implicit org.
- `country` is compared by exact string equality wherever it appears (`orgs[]`, `countries[]`,
  `delivery_config.country`, `npc_personas[].country`). Pick one spelling and use it everywhere.

### 5.2 Team columns

```sql
ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS org_key TEXT;       -- which org this team belongs to; null = all / single-org
ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS function_key TEXT;  -- what kind of team it is; null = custom team
```

- `org_key` references `initial_state.orgs[].org_key` (protagonist).
- `function_key` is the team's function independent of naming: one of the catalog names
  (`Communications`, `Procurement`, `Sales`, `Legal`) for catalog-derived teams, or a stable slug
  chosen by the generator for a recurring custom function (`Investigations`, `Operations`, …).
  A team named "Communications — PNP" has `function_key: "Communications"`, `org_key: "org_pnp_ph"`.
- The existing `UNIQUE(scenario_id, team_name)` stays. Same function in several orgs → distinct
  `team_name`s (composition style is the generator's call), same `function_key`.
- Runtime resolves everything about a team through one rule:

```ts
export function resolveTeamFunction(team: {
  team_name: string;
  function_key: string | null;
}): string {
  return team.function_key ?? team.team_name;
}
```

Catalog lookup, the team icon, AAR sections, charter fallback and stakeholder matching all use
`resolveTeamFunction(team)` instead of `team_name`. `session_teams` is unchanged — a player's
org and function are resolved as `session_teams.team_name → scenario_teams.{org_key, function_key}`.

The generator agent owns both migrations and writes both columns in its persistence services
(`socialCrisisPersistenceService.ts`, `warroomPersistenceService.ts`).

### 5.3 `npc_personas[].country`

Optional. Ambient engines pick reacting/replying personas from the same country as the post they
are reacting to; personas with no `country` are global. Content a persona originates (ambient
posts, DMs) is stamped with the persona's country. A persona linked to a stakeholder (§3.2 rule 4)
must carry the country of that stakeholder's org (or none, for common stakeholders).

Single-org, single-country scenarios: no `orgs[]` needed, `org_key`/`function_key`/`country` all
null. Behaviour identical to today.

---

## 6. Visibility predicate (runtime-enforced, defined here so both sides agree)

```ts
export function isStakeholderVisibleToTeam(
  s: Stakeholder,
  team: { team_name: string; function_key: string | null; org_key: string | null },
): boolean {
  // 1. Function match: owning_team names a function; exact team_name also accepted so custom
  //    teams without a function_key, and v1-style data, keep working.
  const functionMatch =
    s.owning_team === resolveTeamFunction(team) || s.owning_team === team.team_name;
  if (!functionMatch) return false;
  // 2. Org match: null on either side means "all organisations".
  if (s.org_key === null || team.org_key === null) return true;
  return s.org_key === team.org_key;
}
```

Worked through the kidnapping scenario: Maria Santos (family spokesperson) is emitted once as
`{ owning_team: "Communications", org_key: null }`. "Communications — AFP", "— NBI" and "— PNP"
all have `function_key: "Communications"`, so all three see her — one email, one handle, one
conversation memory. If PNP emails her and NBI chats with her, she knows about both; each reply
still lands only with the player who wrote to her (existing private-correspondence behaviour).
A PNP-only informant is `{ owning_team: "Investigations", org_key: "org_pnp_ph" }` and is invisible
to NBI even though NBI also has an Investigations team.

Applied identically to: the workbook, TeamChat search, Mail autocomplete. Trainers see everything.
Hidden fields (§3 "HIDDEN") are stripped before any player-facing response.

Workbook sheets are **derived**, not authored: one sheet per distinct `relationship` among the
visible stakeholders, in this order and with these labels —

| relationship | sheet      |
| ------------ | ---------- |
| client       | Clients    |
| supplier     | Suppliers  |
| partner      | Partners   |
| regulator    | Regulators |
| internal     | Internal   |
| media        | Media      |
| community    | Community  |
| investor     | Investors  |
| union        | Unions     |
| other        | Other      |

Columns: Name · Title · Organisation · Email · Phone · Chat · Notes. The generator does not emit
workbook definitions.

---

## 7. Runtime guarantees (what the generator agent can rely on)

1. Scenarios with **no** `stakeholders` block keep working. Runtime falls back to today's
   behaviour (inbound email senders + key personas for autocomplete; no workbook; generic
   cancellation gate).
2. Malformed records are skipped with a logged warning; they never crash a session.
3. Reconsideration runs only for injects whose `stakeholder_id` resolves and whose stakeholder has
   been contacted by a player in this session. Everything else follows the existing gates.
4. Verdicts are recorded as session events (`inject_cancelled`, `inject_modified`,
   `inject_delayed`) with the stakeholder id, the reason and the team credited, and surface to the
   trainer and the AAR.
5. Reply engines (email, TeamChat, Messenger) build the character from the stakeholder record
   first, falling back to persona / improvisation only when no record exists — so a supplier
   sounds like the same person on every channel.
6. Mail autocomplete stops listing "key personas" wholesale once a `stakeholders` block exists
   (200 personas would flood it): it lists players, visible stakeholders, and previous senders.
7. A common stakeholder (`org_key: null`) is one identity across organisations: one conversation
   log, one reconsideration verdict per pending inject, credit to whichever team(s) actually
   addressed the criteria.
8. **Scoping keys are honoured** (§4.1, §5): `delivery_config.org_key` restricts email / phone /
   group-chat delivery to that org's members; `delivery_config.country` restricts feed and News
   visibility to that country's players; `npc_personas[].country` restricts the reacting-persona
   pool; `function_key` drives catalog lookup, team icon, AAR sections and charter fallback via
   `resolveTeamFunction`. Until each reader ships, the corresponding key is inert — never harmful.
   Delivery order of readers is in the runtime plan, not this contract.
9. `delivery_config.stakeholder_team` resolution: exact `team_name` match first; when that yields
   no members, teams whose `resolveTeamFunction` equals the value (restricted to the inject's
   `org_key` when set); only then the existing session-wide fallback.
10. **Cache invalidation.** Every runtime cache of scenario-derived data (`stakeholders`,
    `orgs[]`, `countries[]`, team identities) is keyed on `(scenario_id, scenarios.updated_at)`.
    The existing `update_scenarios_updated_at` trigger bumps that column on every write, so
    post-compile edits to `initial_state` between sessions are picked up by the next session with
    no signalling from the generator.
11. **Dormancy of retired / unknown surface.** Unknown `initial_state` keys are ignored; unknown
    `delivery_config` keys are preserved verbatim; `stakeholders[].latent_grievances` is still
    parsed but unread; unknown condition primitives evaluate to `false` (existing behaviour in
    `conditionEvaluatorService`). `decision_recorded:*` is now an unknown primitive: templates
    conditioned on it never fire, and the runtime logs `decision_layer_inert` once per session so a
    silent scenario is explainable. SOP steps carrying `triggered_by_decision_key` are skipped.
    Nothing leaks, nothing fires.

---

## 7A. Decision layer — RETIRED (menu-based surface, 2026-09-20)

**Status: retired by the product owner on 2026-09-20, the same day it shipped.** The menu-based
model — executives choosing from a pre-authored `decision_space[]` in a Decisions app, with
authored obligations, latent grievances and eruption templates armed on `decision_recorded:<key>` —
was judged too scripted. It is replaced by the **organic model**: executives decide by
communicating (an email, a chat message, a call), the runtime detects the decision from what they
wrote, and the consequences are generated at runtime and propagate through the organisation's
people and out to stakeholders. Specification, integration points and ownership transfer:
**`docs/executive-decisions-organic-handover.md`** — the generator agent owns that feature end to
end (generation _and_ runtime).

What remains true after the retirement:

- **Executives as players stay.** `function_key: "Executive"` teams, their charters, the 🏛️ icon,
  the `social_team_executive` AAR section and `Executive` in `resolveTeamFunction` are unchanged.
- **Runtime removed:** `decisionEngineService.ts`, `GET /sessions/:id/decision-space`,
  `POST/GET /sessions/:id/decisions`, the Decisions app (mobile + desktop), the `decision_recorded:*`
  primitive, latent-grievance swapping, obligation tracking (`markObligationsMet` /
  `lapseObligations`), `triggered_by_decision_key` SOP clocks, the dashboard "Executive Decisions"
  card and the AAR `leadership_decisions` block.
- **Kept as generic runtime surface:** `delivery_config.inject_key` with `inject_published:*` /
  `inject_cancelled:*`; the `decision_recorded` value in `player_actions.action_type` and the
  `decision_recorded` / `obligation_met` / `obligation_lapsed` `session_events` types (migration 203);
  a `registerGrievanceOverrideResolver()` hook in `stakeholderReconsiderationService` for a runtime
  engine to replace a stakeholder's active grievance.
- **Database (migration 203) untouched:** `session_decisions`, `stakeholder_state`,
  `decision_obligations` exist and are empty. Dropping or reusing them is the new owner's call.
- **Generator must stop emitting** `decision_space[]`, `chain_of_command[]`,
  `stakeholders[].latent_grievances`, `delivery_config.decision_key`, injects conditioned on
  `decision_recorded:*`, and SOP steps with `triggered_by_decision_key`. The Zod schemas
  (`DecisionOptionSchema`, `DecisionSpaceSchema`, `ChainOfCommandLinkSchema`, `ChainOfCommandSchema`)
  stay exported from `server/lib/stakeholderContract.ts` as `@deprecated` only until the last
  generator-side importer is gone.

The original text is preserved below for reference; nothing in it is normative any more.

<details>
<summary>Original §7A (historical)</summary>

```ts
// initial_state.decision_space[]
export interface DecisionOption {
  decision_key: string; // stable slug, unique in the scenario
  title: string;
  description: string;
  decidable_by_org_keys: string[]; // protagonist orgs whose Executive team may record it
  affected_org_keys: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  sop_obligations: Array<{
    description: string;
    owed_to_stakeholder_ids: string[]; // stakeholders[].id
    by_function: string; // function_key that owes it
    window_minutes: number; // from decision time
  }>;
  eruption_inject_keys: string[]; // template injects armed when the decision is recorded
  spillover_inject_keys: string[]; // per-country templates conditioned on inject_published:<key>
}

// initial_state.chain_of_command[]
export interface ChainOfCommandLink {
  org_key: string;
  from_function: string;
  to: string[] /* function_keys */;
}

// stakeholders[].latent_grievances — §3 (dormant until decision_recorded:<decision_key>)

// Template injects: trigger_time_minutes: null; delivery_config.inject_key (stable id) and
// delivery_config.decision_key; conditions_to_appear using the reserved primitives:
//   'decision_recorded:<decision_key>'   'inject_published:<inject_key>'   'inject_cancelled:<inject_key>'
// eligible_after_minutes on eruptions is set by the runtime at arm time (decision time + obligation window).
```

Executive charters use today's action vocabulary (`email_sent`, `chat_message_sent`,
`draft_approved`, `fact_checked`) so leadership scoring works without runtime changes.

Runtime work (committed, runtime plan §5): (a) a `decision_recorded` player action (new
`player_actions.action_type`, runtime migration) with a private org broadcast; (b) on
`decision_recorded:<key>`, instantiate the decision's eruption templates as pending runtime
injects and swap affected stakeholders' active grievance/criteria to `latent_grievances[key]` so
the reconsideration engine judges them unchanged; (c) the three condition primitives, fed from the
published/cancelled sets the scheduler already tracks; (d) `sopCheckerService` support for
decision-triggered steps and obligation windows (`stakeholder_contacted` from the conversation
log); (e) dashboard decision log + obligation status and an AAR "Leadership decisions" section
using `chain_of_command`.

</details>

---

## 8. Ownership boundaries

To avoid merge conflicts, each side stays inside its files.

**Generator agent**

- `server/services/socialCrisisGeneratorService.ts`, `warroomAiService.ts` and related blueprint
  services — stakeholder generation, persona cap and `country` tagging, `orgs[]` / `countries[]`,
  inject author linkage and `org_key` / `country` stamping, `OrgConfig.country/city`.
- `server/services/socialCrisisPersistenceService.ts`, `warroomPersistenceService.ts` — write
  `stakeholders`, `orgs[]`, team `org_key` / `function_key`; validate with `stakeholderContract.ts`.
- `routes/scenarios.ts` generation paths and `routes/socialCrisisWarroom.ts` (authoring API) as
  needed.
- New `server/services/scenarioOrgModel.ts` — generator-owned helpers (`composeTeamName`, org
  registry builders). Imports from `stakeholderContract.ts`; never the reverse.
- Authoring UI: `frontend/src/pages/WarRoom.tsx`, `frontend/src/pages/SocialCrisisWizard.tsx`,
  `frontend/src/components/Scenario/SocialScenarioEditor.tsx` and their child components.
- Migrations: `scenario_teams.org_key`, `scenario_teams.function_key`.
- Generator-side catalog lookups (e.g. `adaptTeamCharters`) switch to `resolveTeamFunction`
  within the generator's own files.

**Runtime agent**

- `server/lib/stakeholderContract.ts` (shared types/schema/predicates — created first).
- `server/services/injectSchedulerService.ts`, `socialCrisisAiService.ts` — reconsideration hook.
- `server/services/npcEmailReplyService.ts`, `npcMessengerService.ts`, new
  `stakeholderService.ts` / `stakeholderReconsiderationService.ts`.
- `server/services/teamCharterService.ts` — runtime lookups via `resolveTeamFunction`.
- `server/services/feedEngineService.ts` and the ambient/NPC engines — `org_key` / `country`
  readers, persona pool by country.
- `server/routes/channels.ts`, contacts / feed / news endpoints in `routes/socialMedia.ts`.
- All frontend work (TeamChat, workbook app, Mail autocomplete, notification pill, feed/News
  country filtering, lobby/dashboard org grouping).
- Runtime migrations: stakeholder conversation log, inject verdicts, chat channel changes,
  `social_posts.country` / `sim_news_articles.country`.

**Read-only for both**: the semantics in §3–§6, this document.

Neither side edits the other's files. If something in the other side's area needs to change, ask.

**Fixtures the generator agent provides for runtime E2E** (compiled scenarios in the shared DB):
the multi-org kidnapping scenario (PDRM / AFP / NBI / PNP, two countries, common + org-specific
stakeholders, tagged injects and personas) and the Dyson decision-layer scenario (Executive team,
decision space, latent grievances, templates). Migration 197 lands before either.

---

## 9. Acceptance checklist for a generated scenario

The generator agent's validation should assert all of these before persisting:

- [ ] Every `stakeholders[].owning_team` equals some team's `resolveTeamFunction(team)`; when the
      stakeholder has an `org_key`, at least one matching team has that `org_key`.
- [ ] Every non-null `stakeholders[].org_key` ∈ protagonist `initial_state.orgs[].org_key`.
- [ ] No stakeholder is duplicated per org (same person, suffixed ids) — common ones are emitted
      once with `org_key: null`.
- [ ] `initial_state.orgs[]` present whenever more than one organisation exists; exactly one
      protagonist `is_primary`; every `org_page.orgs[].org_key` (if any) references it; every
      `orgs[].country` ∈ `countries[]` when that list is present.
- [ ] Every `scenario_teams.org_key` ∈ protagonist `orgs[].org_key`; catalog-derived teams carry
      the catalog name in `function_key`.
- [ ] Every `delivery_config.org_key` ∈ `orgs[].org_key`; every `delivery_config.country` and
      `npc_personas[].country` ∈ the country set; when an inject has both, the org is in that country.
- [ ] `id`, `email`, `handle` unique across stakeholders; `handle` unique against personas and org pages.
- [ ] Every `delivery_config.stakeholder_id` resolves to a stakeholder.
- [ ] Author fields on stakeholder injects match the record per §4.
- [ ] Every stakeholder with a `social_feed` inject has an `npc_personas` entry with the same `handle`.
- [ ] Every time-based stakeholder inject has `trigger_time_minutes >= 10`.
- [ ] Every stakeholder with `grievance !== ''` has ≥ 1 `resolution_criteria`; every stakeholder
      with `grievance === ''` has none and authors no injects.
- [ ] `note` contains no reference to the grievance, the inject, or its timing.
- [ ] Each team × office present in the scenario has ≥ 1 visible stakeholder, and at least one
      visible stakeholder with no scheduled inject.

---

## 10. Worked example

```jsonc
// initial_state.stakeholders (two of many)
[
  {
    "id": "stk_meridian_logistics_jtan",
    "name": "Jasmine Tan",
    "title": "Head of Procurement",
    "organisation": "Meridian Logistics Pte Ltd",
    "relationship": "client",
    "owning_team": "Sales",
    "org_key": "sg_hq",
    "email": "jasmine.tan@meridianlogistics.sim",
    "phone": "+65 6123 4567",
    "handle": "@jtan_meridian",
    "note": "Key account, ~18% of regional revenue. Contract renewal due Q4.",
    "personality": "Direct, commercially minded, dislikes vagueness. Short emails, no pleasantries.",
    "stance": "Alarmed by the recall reports; considering pausing orders and saying so publicly.",
    "knowledge": [
      "Meridian has 3 containers of the affected batch in transit.",
      "Their own customers are already asking questions.",
    ],
    "will_not_disclose": ["Meridian's alternative supplier negotiations."],
    "grievance": "Has had no direct contact from the organisation since the story broke and does not know whether her in-transit stock is affected.",
    "resolution_criteria": [
      "Told plainly whether batch 2207-B is in the affected range.",
      "Given a named contact and a time for the next update.",
      "Offered a concrete option for the in-transit stock (hold, return, or test).",
    ],
    "persuadability": "medium",
    "hard_constraints": [],
  },
  {
    "id": "stk_sfa_compliance_desk",
    "name": "Compliance Desk, Food Standards Authority",
    "title": "Duty Officer",
    "organisation": "Food Standards Authority",
    "relationship": "regulator",
    "owning_team": "Legal",
    "org_key": null,
    "email": "compliance.desk@fsa.gov.sim",
    "phone": "+65 6800 1000",
    "handle": "@fsa_compliance",
    "note": "Statutory notices are issued from this desk. Response SLA 24h.",
    "personality": "Formal, procedural, cites regulation numbers.",
    "stance": "Neutral; following process.",
    "knowledge": ["A formal notice is mandatory once a recall affects >500 units."],
    "will_not_disclose": ["Whether other companies are under review."],
    "grievance": "Statutory duty to issue a notice requiring a written incident report within 48h.",
    "resolution_criteria": ["Organisation has proactively filed a preliminary incident report."],
    "persuadability": "none",
    "hard_constraints": ["The notice must be issued regardless; only its tone may change."],
  },
]
```

```jsonc
// two of Jasmine Tan's injects
{
  "trigger_time_minutes": 15, "type": "email_inbound", "inject_scope": "team_specific", "target_teams": ["Sales"],
  "title": "Meridian Logistics: are our containers affected?",
  "content": "Subject: Batch 2207-B — urgent\n\nWe have three containers in transit …",
  "delivery_config": {
    "app": "email", "stakeholder_id": "stk_meridian_logistics_jtan",
    "from_name": "Jasmine Tan", "from_address": "jasmine.tan@meridianlogistics.sim",
    "email_category": "general", "priority": "high", "stakeholder_team": "Sales"
  }
},
{
  "trigger_time_minutes": 32, "type": "social_post", "inject_scope": "universal", "target_teams": [],
  "title": "Meridian Logistics pauses orders publicly",
  "content": "After 30+ minutes of silence from @OrgOfficial we are pausing all orders until we get answers. Our customers deserve better. #recall",
  "delivery_config": {
    "app": "social_feed", "platform": "x_twitter", "stakeholder_id": "stk_meridian_logistics_jtan",
    "author_handle": "@jtan_meridian", "author_display_name": "Jasmine Tan", "author_type": "npc_public"
  }
}
```

In this example the scenario has one organisation (`orgs[]` with a single `sg_hq` entry, or none
at all), so `owning_team: "Sales"` matches the team named "Sales" whether or not it carries a
`function_key`. In a multi-agency scenario the same records work unchanged: the FSA desk
(`org_key: null`) is visible to every organisation's Legal team, Jasmine (`org_key: "sg_hq"`)
only to the Singapore HQ's Sales team.

A Sales player who opens the workbook at T+5, emails Jasmine with the batch status, a named
contact and a hold-or-test option satisfies all three criteria; at T+15 the email inject is
cancelled (she already has her answer) and at T+32 the public post is cancelled or modified into
something like "Appreciate the quick clarity from @OrgOfficial on our stock — holding for test
results." The FSA notice at whatever time it is scheduled fires regardless; if Legal filed a
preliminary report first, its tone softens.

---

## 11. Deferred — noted, not built in this iteration

- Cross-team visibility of contacts with an "owned by <team>" label (currently: none; other teams'
  stakeholders are reachable only if a teammate passes the details on, which reinforces the
  cross-team information duty in the charters).
- Editable workbook: player notes column, player-added contacts, team-shared edits, export.
- Stakeholders who proactively reach out (they already do via injects; a dynamic "cold call"
  engine is out of scope).
- `(org × team)` player identity and per-office scoring — see `multi-org-coalition-plan.md`.
- Live phone conversations with stakeholders (current phone calls are scripted one-way).

---

## 12. Change control

Bump the version at the top for any change to §2–§6. Additive optional fields are minor; renames,
removals or semantic changes to the visibility predicate or the persuadability table require both
agents to acknowledge before either merges.

## 13. Changelog

**v3.2 (2026-09-20)** — additive fields for the organic executive-decision model and pressure
organisations (applied by the generator agent per handover §9; `server/lib/stakeholderContract.ts`
is the source of truth, all fields optional, `passthrough` preserved):

- `stakeholders[]`: `kind: 'person' | 'group'` (a group is a distribution list; mail to it reaches
  `members[]`), `tier: 'principal' | 'roster'` (roster = lightweight workforce entry: sampled
  replies, never authors injects — `MO-CAST-007`), `site_key`, `sensitivities: string[]`
  (plain-language: which executive decisions this person reacts to), `page_org_key` (reverse link
  from a pressure page's spokesperson to `orgs[].org_key`).
- `orgs[]`: `side` gains `'pressure'`; `kind` gains `union | regulator | community_group |
political` (`ngo` already existed); `spokesperson_stakeholder_id` (required when
  `side === 'pressure'`); `operation: 'players' | 'ai'` on protagonists (AI-operated office: page
  run by the pressure engine in the `aligned` register, carriers answer as characters, teams
  unstaffed → unscored); `sites[]` (`site_key`, `name`, `country`, `city`).
- `org_page.orgs[]`: `role` gains `'pressure'` (always `control_mode: 'ai'` unless trainer-seized;
  `normalizeOrgPages` enforces it); `posture` (`register: statutory | advocacy | grassroots |
political | aligned`, `mandate`, `demands[]`, `escalation_ladder[]`, `targets_org_keys[]`,
  `stand_down_signals[]`); `spokesperson_stakeholder_id`; `kind`; `operation`.
- `delivery_config`: `page_org_key` — **page-authored inject**: author fields carry the PAGE
  identity (`author_handle` = page handle, `author_type: 'official_account'`), `stakeholder_id` is
  the spokesperson and governs reconsideration (exception to §4.2, validated as `MO-PRS-005`,
  never before T+15 — `MO-PRS-006`); `decision_id` (runtime cascade linkage);
  `parent_inject_key` (second-order chaining with the generic `inject_published:*`).
- `sop_definitions.steps[]`: `owner_function`, `trigger: 'decision_notification'`,
  `must_precede[]` on the cast-generated notification steps (graded when a formal notice is
  detected).
- Runtime tables (migration 205): `sim_org_pages.role` CHECK widened + `spokesperson_stakeholder_id
/ register / kind / operation`; `session_decisions.detail JSONB / status`; `decision_knowledge`;
  `decision_events`; `session_events.event_type` += `decision_detected, decision_propagated,
decision_dismissed, decision_reversed, pressure_post, pressure_reply, pressure_stand_down`.
  Every reader degrades to the pre-205 shape with a one-time loud log (organic plan §9).
- Runtime touch points edited by the generator agent (handover §3): email send route, chat
  message route, `seedOrgPages`, `groupOrgPages`, `index.ts` boot/mount, `env.ts` flag, AAR data,
  trainer dashboard card, `AdversaryConsole`, `PageAssignmentModal`. `injectSchedulerService.ts`
  and `sessions.ts` untouched.
- **Runtime acknowledgement (runtime agent, 2026-09-20).** Migration 205 applied and verified.
  Readers: `PLAYER_VISIBLE_FIELDS` += `kind, members, tier, site_key, page_org_key`
  (`sensitivities` is character data and stays HIDDEN — covered by the projection test);
  `delivery_config.page_org_key` needs no feed-engine reader because `routeToSocialFeed` already
  publishes under the author fields, which MO-PRS-005 requires to be the page identity — the post
  lands on the page timeline via handle + `official_account`; `getProtagonistOrgs()` keeps
  filtering `side === 'protagonist'`, so pressure orgs never gain player teams by accident.
  Handover §10.5 gaps closed: **R1** `triggerNPCEmailReply` resolves every recipient
  (`resolveStakeholderRecipients`, groups expanded to `members`), logs all of them as contacted
  (`appendPlayerMessage`), and answers from a bounded sample (`pickResponders`: ≤ 3 replies,
  principals first, ≤ 2 stable-sampled roster voices, staggered); a group primary never answers.
  **R2** workbook: `tier: 'roster'` rows get a **Roster** sheet (site column); `kind: 'group'`
  rows are badged "(distribution list · N members)"; Mail autocomplete carries `kind`,
  `member_count`, `tier`. **R3** `PlayerMessageCtx.context` + `registerStakeholderContextProvider()`
  (merged by `resolveContext`, appended to the character prompt for both live replies and the
  fire-time judge); roster-tier prompt line added.
- **Migration 206** (runtime agent): `scenario_injects.generation_source` CHECK re-asserted with
  four values the server already wrote but the constraint rejected (`stakeholder_modified`,
  `decision_consequence`, `sentiment_negative`, `transport_outcome`). Rule stands: a new
  `generation_source` needs a migration.

**v3.1 (2026-09-20)** — product owner retires the menu-based decision layer.

- §7A retired; replaced by the organic executive-decision model, specified and owned end to end
  by the generator agent in `docs/executive-decisions-organic-handover.md`.
- Runtime menu layer removed (engine, endpoints, Decisions app, `decision_recorded:*` primitive,
  latent-grievance swap, obligations, dashboard card, AAR block). §7 item 11 now describes the
  dormancy of the retired surface.
- `delivery_config.inject_key` + `inject_published:*` / `inject_cancelled:*` promoted from
  "reserved" to generic kept surface (§2, §4). `decision_key`, `latent_grievances`,
  `decision_space[]`, `chain_of_command[]` marked deprecated; generator to stop emitting.
- New runtime hook `registerGrievanceOverrideResolver()` (no default registration).

**v3 (2026-09-20)** — generator agent's dead-end audit.

- Cache invalidation guarantee keyed on `scenarios.updated_at` (§7 item 10).
- `stakeholder_team` demoted to informational; stakeholder emails use explicit composed
  `target_teams`; runtime resolves `stakeholder_team` via `function_key` as fallback (§4 rule 2,
  §7 item 9).
- Org-page-originated posts (antagonist / ally / player page posts) stamped with the page org's
  country (§4.1).
- Decision layer added as additive surface with dormancy guarantee (§7A, §7 item 11,
  `latent_grievances`, `inject_key` / `decision_key`). Approved by the product owner the same
  day as an optional product mode; runtime side committed as plan workstream 5.
- Fixtures recorded (§8).

**v2 (2026-09-20)** — response to the generator agent's amendment.

- `owning_team` now names a team **function**, matched via new `scenario_teams.function_key`
  (`resolveTeamFunction` = `function_key ?? team_name`). Fixes common stakeholders in multi-org
  scenarios with composed team names. The per-org duplication workaround is withdrawn: emit
  common stakeholders once with `org_key: null`.
- `initial_state.orgs[]` added as the canonical organisation registry (war-room scenarios have no
  `org_page`); `org_page.orgs[]` must reference it when both exist. Optional `countries[]`.
- `delivery_config.org_key` / `.country` defined with delivery semantics (§4.1).
- `npc_personas[].country` defined (§5.3).
- Runtime commits to the readers (§7 item 8); ownership extended accordingly (§8).
- Checklist and example updated.

**v1 (2026-09-20)** — initial draft.
