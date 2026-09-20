# War Room redesign — implementation spec

**Status:** approved design (Situation Map, variation C) → implementation. This document is the record of what changes, where, and why. Update it in the same commit as any deviation.

**Design sources (HTML studies, all in `docs/design/warroom/`):**

| Study                                             | App surface it drives                                                                                                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warroom-entry.html`                              | `frontend/src/pages/WarRoom.tsx` — mode choice, resume ledger, field-ops step shell (Incident, Teams; Scene editor / Location / Research / Compile inherit the shell)                                                                                           |
| `variation-c-situation-map.html`                  | `frontend/src/pages/SocialCrisisWizard.tsx` — Setup step (brief + footprint radar, lanes for organisations / pressure groups / rivals, CTA bar); Build and Review steps inherit the shell. Also the poster card and its in-place expansion                      |
| `scenario-library.html`                           | `frontend/src/pages/Scenarios.tsx` — page frame: illustrated header + nav + counts, sticky toolbar, live rail, poster grid, empty states                                                                                                                        |
| `scenario-detail.html`                            | `frontend/src/components/Scenario/SocialScenarioEditor.tsx` (corporate crisis detail/edit) and `ScenarioDetailView.tsx` (field ops detail) — sticky bar, hero, section index, collapsible sections, cast grouping + search, injects by phase with origin badges |
| `shared.css`, `icons.svg`, `art/`, `library.html` | tokens, primitives, icon set, illustration library (already converted to `frontend/public/marketing/library/*.webp`)                                                                                                                                            |

## 0. Ground rules

1. **Restyle around the logic, never through it.** Every handler, state variable, API call, validation and draft-save path in the four components stays. JSX chrome (containers, headings, chips, buttons' classes) changes; component boundaries and props do not, except the additive ones listed here.
2. **Tokens already match.** `shared.css` was written against the app's CSS variables (`--brand #1E3A5F`, `--accent #D97706`, `--deep #0E1A2B`, `--surface`, `--surface-2`, `--ink`, `--muted`, `--border`, `--border-strong`, `--success`, `--danger`; Tailwind exposes them as `bg-surface`, `text-ink`, `border-border`, `bg-deep`, etc.). No new colour tokens. Family colours from the study (`--f-crisis`, `--f-org`, `--f-ai`, `--f-pressure`, `--f-rival`, `--f-intel`) become CSS variables in `warroom.css`.
3. **Tailwind for layout, one CSS file for design primitives** that Tailwind can't express cleanly (art bands with layered gradients, glass, monogram gradients, reveal/pulse animations, `<details>` chevron rotation, `color-mix` tints). Class names are prefixed `wr-` to avoid collisions with `military-*` and marketing classes.
4. **No emojis in the redesigned surfaces.** Icons come from one React sprite component (§1.2). Existing emoji in untouched components stay.
5. **Illustrations** are the 50 WebP scenes already in `frontend/public/marketing/library/` (`NN-name.webp` 1280px, `NN-name-sm.webp` 720px). Cards use `-sm`, heroes use full size. Selection is deterministic per scenario (§1.3) so a card keeps its art across reloads.
6. **Accessibility:** collapsibles are native `<details>/<summary>`; every icon-only button has `aria-label`; the country code badge has `title`; focus rings use the existing `--brand` ring; `prefers-reduced-motion` disables reveal/pulse (already in `shared.css`, carried over).
7. **Responsive:** three breakpoints as in the studies — ≥1100px full layout, 760–1100px two columns / stacked lanes, <760px single column, sticky toolbar wraps.
8. **Server changes are additive only** (one query-string option on an existing GET, one optional field on a modal). No migrations.

## 1. Foundation (new files)

### 1.1 `frontend/src/design/warroom.css` (new) — imported once in `frontend/src/main.tsx` after `style.css`

Ported from `docs/design/warroom/shared.css`, prefixed. Primitives and what uses them:

| Class                                                                                 | Purpose                                                                                                          | Used by                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `.wr-artband`, `.wr-artband > img.wr-art`, `.wr-artband.center`                       | deep-navy band with an illustration behind two gradients (horizontal fade + amber radial glow)                   | heroes (WarRoom, wizard, library), poster bands, lane heads, live rail |
| `.wr-glass`                                                                           | translucent panel on dark (radar, ledger, KPI tiles, brief)                                                      | hero right columns                                                     |
| `.wr-eyebrow`                                                                         | mono uppercase amber kicker                                                                                      | every hero                                                             |
| `.wr-tile`, `.wr-tile.soft`                                                           | gradient icon tile in a family colour via `--g`                                                                  | section headers, incident groups, team cards                           |
| `.wr-mono`, `.wr-mono.ai/.pr/.rv/.plain`                                              | monogram avatar (org / person initials)                                                                          | org cards, cast rows, peek panels                                      |
| `.wr-cc`, `.wr-cc.light`                                                              | country code badge                                                                                               | everywhere a country is shown                                          |
| `.wr-btn` + `.accent/.ghost/.sm/.lg/.icon`                                            | button family used inside the redesigned surfaces (existing `military-button` remains for untouched screens)     | all                                                                    |
| `.wr-field`                                                                           | input/textarea/select skin                                                                                       | wizard, toolbar search                                                 |
| `.wr-steps > span(.on/.done/.ghost)`                                                  | pill stepper                                                                                                     | WarRoom, wizard heroes                                                 |
| `.wr-lane`, `.wr-lanehead`, `.wr-vignette`                                            | illustrated lane head + card grid                                                                                | wizard Setup                                                           |
| `.wr-poster*`, `.wr-kpis`, `.wr-cast .o(.hq/.ai/.pr/.rv)`, `.wr-lock(.locked/.draft)` | scenario card                                                                                                    | library, wizard library strip                                          |
| `.wr-poster.expanded`, `.wr-peek`                                                     | in-place expanded card with three peek panels                                                                    | library                                                                |
| `.wr-ledger`, `.wr-draft`, `.wr-draft .prog`                                          | resume ledger rows                                                                                               | WarRoom hero                                                           |
| `.wr-path(.on)`                                                                       | path cards (mode choice)                                                                                         | WarRoom step 0                                                         |
| `.wr-grp`, `.wr-inc(.on/.soon)`                                                       | incident groups and rows                                                                                         | WarRoom step 1                                                         |
| `.wr-sec`, `.wr-grp-fold`, `.wr-sub`                                                  | `<details>` sections: summary grid (tile · title+count · peek chips · chevron), nested group and sub-group folds | detail views                                                           |
| `.wr-ch(.fb/.z/.mail/.news/.chat/.call)`                                              | origin badges, sim palette (`#1877F2`, `#16181C`, `#2563EB`, `#DC2626`, `#16A34A`, `#475569`)                    | inject rows everywhere                                                 |
| `.wr-p(.rel/.live/.pure/.roster/.group/.speaks/.key)`                                 | relationship / state pills on cast rows                                                                          | detail cast                                                            |
| `.wr-reveal`, `.wr-livedot`, `.wr-lift`                                               | motion                                                                                                           | cards, live indicators                                                 |

### 1.2 `frontend/src/components/UI/WarRoomIcon.tsx` (new)

`<WrIcon name="building" size={14} className />` renders an inline `<svg>` from a `paths` map (stroke 1.75, round caps, `currentColor`). Names (from `icons.svg` + `warroom-entry.html`): `building office megaphone scale tie truck handshake users landmark fist leaf community podium swords radar doc image lock unlock check alert plus x sparkle clock phone map arrow arrow-l edit play eye eye-off bolt trash save layers target list chevron search mail news feed call chat copy expand collapse shield hazard pin flag cal card dash grid bomb car vest mall gun knife bio skull siren plane medic fire`. Also exports `TEAM_ICON: Record<string, IconName>` (Communications→megaphone, Legal→scale, Executive→tie, Shareholder Engagement→handshake, Stakeholder Engagement→users, Procurement/Sales legacy → same, default→users) and `INCIDENT_ICON` for `INCIDENT_TYPES` ids.

### 1.3 `frontend/src/lib/scenarioArt.ts` (new)

```ts
export const ART_LIBRARY: Array<{ key: string; file: string; tags: string[] }>; // 50 entries, tags e.g. ['labour','depot'], ['press'], ['hospital'], ['cyber'], ['field','evacuation']
export function artFor(
  s: { id: string; category: string; title: string; description?: string },
  size: 'sm' | 'full' = 'sm',
): string;
```

Deterministic: score tags against title+description keywords (labour/union/strike → union-hall/depot-night/factory-floor; hospital/clinic → hospital-corridor/clinic-waiting; data/breach/cyber → data-breach; market/bank → trading-floor; bomb/IED/evacuation → evacuation/command-post/responders/searchlight; port/logistics → container-port/border-bridge; airport → airport-gate; press/media → newsroom/press-conference/headline-storm; default corporate → war-room/executive-window/pile-on; default field → command-post/responders), then pick within the matched set by `hash(id) % n`. Field ops never gets a corporate-only scene and vice versa. Returns `/marketing/library/NN-name[-sm].webp`.

### 1.4 `frontend/src/components/UI/OriginBadge.tsx` (new)

`originOf(inject)` → `'fb'|'z'|'mail'|'news'|'chat'|'call'` from `delivery_config.app ?? inject.type` and `delivery_config.platform` (`social_feed` + `facebook` → fb; `social_feed` otherwise → z; `email` → mail; `news` → news; `group_chat`/`team_chat` → chat; `phone_call` → call). `<OriginBadge inject size="sm|md" />` renders the `.wr-ch` badge with icon + label (`Fakebook`, `Z`, `Mail`, `News`, `Chat`, `Call`). Same mapping the existing `InjectCard` in `SocialScenarioEditor.tsx` (lines ~1220–1245) uses for its coloured pill; that pill is replaced by this component.

### 1.5 `frontend/src/components/UI/Collapsible.tsx` (new)

```tsx
<WrSection id title count icon family subtitle peek={ReactNode} defaultOpen>   // top-level <details class="wr-sec">
<WrGroup title count hint defaultOpen>                                        // <details class="wr-grp-fold">
<WrSub title count hint defaultOpen>                                          // <details class="wr-sub">
```

Plus `useSectionIndex(ids)` returning `expandAll()/collapseAll()` (sets `open` on all `details` under a root ref) used by the side index.

## 2. Server (additive)

### 2.1 `server/routes/scenarios.ts` — `GET /api/scenarios` (line 160)

Add `?include=summary`. When present, after the existing query, run three grouped queries for the returned ids and attach `summary` per row:

```ts
summary: {
  teams: number; // count(scenario_teams where scenario_id)
  injects: number; // count(scenario_injects where scenario_id)
  contacts: number; // (initial_state.stakeholders ?? []).length  — computed from the row already selected
  crowd: number; // (initial_state.npc_personas ?? []).length
  orgs: Array<{
    org_key: string;
    name: string;
    country: string | null;
    side: 'protagonist' | 'antagonist' | 'pressure';
    operation?: 'players' | 'ai';
    is_primary?: boolean;
  }>; // from initial_state.orgs (registry), max 6, primary first
  live_session_id: string | null; // sessions where scenario_id and status in ('in_progress','paused'), first
  sessions_run: number; // count(sessions where scenario_id and status = 'completed')
  last_session_at: string | null; // max(sessions.start_time) for the scenario
}
```

Three round-trips total (teams, injects, sessions) using `.in('scenario_id', ids)` and aggregating in memory; no per-scenario queries. Errors in the summary step log a warning and return rows without `summary` (the page degrades to counts it can compute client-side). Without `include=summary` the response is byte-identical to today.

### 2.2 `frontend/src/lib/api.ts`

- `scenarios.list(opts?: { include?: 'summary' })` → appends the query string. Type `ScenarioSummary` exported.
- No other API changes.

### 2.3 `frontend/src/components/Forms/CreateSessionModal.tsx` + `frontend/src/pages/Sessions.tsx`

- `CreateSessionModal` gets optional prop `initialScenarioId?: string`; `formData.scenario_id` initialises from it (line 19).
- `Sessions.tsx` reads `?create=<scenarioId>` from `useSearchParams`; when present opens the modal with `initialScenarioId` and strips the param on close. This is what the card's **Launch** button targets: `navigate('/sessions?create=' + id)`.

## 3. Surface A — Scenario library (`frontend/src/pages/Scenarios.tsx`, 413 lines)

**Keep:** `Scenario` interface (extended with `summary?: ScenarioSummary`), `useRoleVisibility`, `loadScenarios` (now `api.scenarios.list({ include: 'summary' })`), `handleViewScenario`, `handleDeleteScenario` + `deleting`, `search`/`typeFilter` state and the `filteredScenarios` memo (extended), the `ScenarioDetailView` mount (lines 344–350), the participant brief modal (352–410, restyled only), the loading skeleton (92–114, reshaped to poster skeletons).

**New state:** `statusFilter: 'all'|'active'|'draft'|'live'|'locked'`, `sort: 'compiled'|'run'|'sessions'|'az'`, `view: 'cards'|'list'`, `expandedId: string|null`, `sessionCredits: number|null` (from `api.billing.getCredits()` once, trainers only; failures → `null` → lock state shows "Editable" only when `live_session_id` is null).

**Derived:** `lockState(s)`: `live_session_id` → `locked-live`; `sessionCredits === 0` → `locked-credits`; `!is_active` → `draft`; else `editable`. `liveScenarios = scenarios.filter(s => s.summary?.live_session_id)`. Counts for the segment/chips come from the unfiltered list.

**Structure (replaces lines 116–342):**

```
<div class="min-h-screen">
  <header class="wr-artband wr-hero">                 // art: 40-timeline-wall.webp
    top: <BrandMark/> "Black Swan · trainer|participant" — nav pills (Dashboard, Scenarios[here], Sessions, Clients & billing, War Room[cta, trainers]) — replaces lines 120–156
    grid: eyebrow "Scenario library" · h1 "{n} scenarios, ready to run" · lead — stats glass tiles: corporate, field ops, live now, session credits (trainers)
  </header>
  <main class="max-w-[1380px] mx-auto px-7 -mt-4">
    <LibraryToolbar/>                                  // sticky; search (existing `search`), type segment with counts (existing `typeFilter`), status chips, sort select, view toggle, "{shown} of {total} shown"
    {liveScenarios.length > 0 && <LiveRail/>}          // one row per live scenario: band (art-sm, LIVE dot, T+mm from summary.last_session_at), title, meta, team chips (from summary.orgs[0]?.teams? — v1: teams count only), actions Open session → navigate(`/sessions/${live_session_id}`), Preview → handleViewScenario
    <section> "All scenarios · {shown}" · sort caption
      view==='cards' ? <div class="wr-posters"> {filtered.map(<ScenarioPoster/>)} </div> : <ScenarioListTable/>
    </section>
    empty states: no scenarios (keep copy from lines 297–317) · no matches (319–341) — both restyled with wr-tile icon and the two actions
  </main>
  {detailScenarioId && <ScenarioDetailView .../>}      // unchanged
  {selectedScenario && !isTrainer && <ParticipantBrief/>} // unchanged logic, wr classes
</div>
```

**`ScenarioPoster` (new component in the same file):** band = `wr-artband center` with `artFor(s)`, mode chip (phone/map icon + "Corporate crisis"/"Field operations"), status chip (Active ✓ / Draft / LIVE · T+mm), title (2-line clamp), description (2-line clamp). Body = cast chips from `summary.orgs` (HQ / AI / pressure / rival colours, country cc), KPIs (corporate: teams · contacts · injects · min; field: teams · hazards? (not in summary → show objectives) · injects · min), meta line (compiled date = `created_at`; `sessions_run`). Footer = lock label + actions: trainer: Preview (→ `handleViewScenario`), Edit (same target; disabled+tooltip when locked), Launch (→ `/sessions?create=id`; when live → "Open session"), Delete (trash icon, existing handler, `confirm`); participant: single "View brief". Click on band/body → `setExpandedId(id)` (trainers) or brief (participants).

**`ScenarioPosterExpanded`:** rendered in place of the poster when `expandedId === id`; spans the grid (`wr-poster expanded`). Left: band with full description, cast chips, KPIs, "Open full scenario" (→ `handleViewScenario`), Edit / Launch. Right: three peek panels — **Cast** (first 8 of `initial_state.stakeholders` grouped by org: name, title, pure/live flag, "speaks for" when `page_org_key`), **Injects** (first 8 by `trigger_time_minutes` from a lazy `api.scenarios.getInjects(id)` fetched on expand, each with `<OriginBadge/>`; loading skeleton meanwhile), **Pages & teams** (from `initial_state.orgs` + `api.scenarios.getTeams(id)` lazily). Each panel footer links to the full view. Escape / clicking the collapse button closes. Only one card expanded at a time.

**List view (`view==='list'`):** compact table — art thumb 56×32, title, type, orgs, teams, injects, min, lock, actions. Same handlers.

**Sorting:** `compiled` = `created_at` desc (default), `run` = `summary.last_session_at` desc, `sessions` = `summary.sessions_run` desc, `az` = title.

## 4. Surface B — War Room entry + field-ops shell (`frontend/src/pages/WarRoom.tsx`, 983 lines)

**Keep every state and handler:** `simMode`, `incidentType`, `customIncidentText`, `teams` + `updateTeam/removeTeam/addTeamFromInventory/showAddTeam`, `rtsSceneId/sceneConfig/weaponType`, `geoResult/geoLoading/geoError`, `researchResults`, `scenarioId`, `wizardDraftId`, `existingDrafts/showDraftPicker`, `saveDraftState`, resume effects (lines ~215–321), `goBack/goNext` (492–512), `canGoBack/canGoNext/stepValid`, the access-denied and zero-credit screens (440–474, restyled with wr classes only), `INCIDENT_TYPES/INCIDENT_GROUPS/TEAM_INVENTORY` data.

**Structure (replaces the render from line 514):**

```
<div class="min-h-screen bg-bg">
  <header class="wr-artband wr-hero">                       // art by step: 0→21-command-post, 1→20-evacuation, 2→22-responders, 3→44-map-table, 5→11-border-bridge, 6→09-newsroom, 7→13-debrief
    top: <BrandMark/> "War Room · {step 0 ? 'new scenario' : 'Field operations'}" — <Stepper/> — credits (scenario credits from existing `scenarioCredits`)
    grid: eyebrow "War Room · step {n}" / "Field operations · step {i} of 6" · h1 per step (0 "What are you training for?", 1 "What kind of incident?", 2 "Who responds?", 3 "Lay out the scene", 5 "Check the location", 6 "Research & doctrine", 7 "Compile") · lead (existing step copy from lines 646–647, 690–693, 774–777, 906–910, 922–927, 936–940)
          right column: step 0 → <ResumeLedger/> (when showDraftPicker && existingDrafts.length) ; steps ≥1 → <ScenarioSoFar/> brief (incident label, teams count, location from geoResult, scene saved?)
  </header>
  <main class="wr-wrap"> <section class="wr-map">
     step 0 → <PathCards/>           // two `.wr-path` articles; click sets simMode (existing); selected ring; per-card "Start …" also calls goNext()
     step 1 → <IncidentGroups/>      // four `.wr-grp` containers from INCIDENT_GROUPS, rows `.wr-inc` (icon from INCIDENT_ICON, label, one-line hint map, `.soon` when !enabled with title "Available soon"), selected `.on`; custom text box (existing input, lines 750–768) inside a dashed `.wr-custom`
     step 2 → <TeamCards/>           // `.wr-team` card per team: tile icon (TEAM_ICON fallback users), name, description input (existing updateTeam), Players min–max inputs (existing), Investigative toggle (existing), remove ×; `.wr-add` dashed card opens the existing inventory list (showAddTeam) as a popover
     step 3 → SceneEditor unchanged (full-bleed inside .wr-map with p-0)
     step 5 → LocationValidationStep unchanged
     step 6 → ResearchStep unchanged
     step 7 → CompileStep unchanged
  </section>
  <footer class="wr-ctabar sticky bottom-3">                 // replaces lines 946–981: Back (ghost), hint "Step n of N · {selection summary}", Save draft (ghost, calls saveDraftState(step)), primary: step 0 → "Continue" (disabled until simMode; corporate → navigate('/warroom/social-crisis') via existing goNext), step 1 → "Suggest teams", 2 → "Lay out the scene", 3 → "Check location", 5 → "Run research", 6 → "Compile", 7 → scenarioId ? "View scenarios" : hint
  </main>
</div>
```

**`Stepper`:** `VISIBLE_STEPS` pills; step 0 shows "1 Choose a path · 2 … · 3 …" ghosts until `simMode` is chosen; corporate chosen → pills preview "Setup · Build · Review & compile"; field chosen → the six field steps. Past steps get `.done` with check.

**`ResumeLedger`:** groups `existingDrafts` into In progress (`status==='draft'` and no `scenario_id`) and Compiled; row tile by `input.sim_mode`; progress bar = `current_step` index / total; labels from `STEP_LABELS`; Resume / Re-compile use the existing click logic (lines 614–622); Dismiss → `setShowDraftPicker(false)`. **Discard ×** is _not_ in v1 (no delete endpoint for drafts) — noted as follow-up.

## 5. Surface C — Corporate crisis wizard (`frontend/src/pages/SocialCrisisWizard.tsx`, 3242 lines)

**Keep everything from line 1 to 1766** (state, effects, `detectFootprint`, uploads, roster/org/pressure/competitor handlers, `generate*`, `compileScenario`, `goBack/goNext/canProceed`, `VISIBLE_STEPS`, `STEP_LABELS`, `renderBlueprintReview` 2265–2520, `renderBuilding` 2522–2590, `renderStep7` 2595–3180 bodies).

**Replace:**

- `progressBar` (1769–1807) → `<Stepper/>` inside the hero top bar (same `VISIBLE_STEPS`/`currentStepIndex`).
- Outer render (3184–3241) → hero + `.wr-wrap > .wr-map` + `.wr-ctabar`. The back-to-War-Room button becomes the brandmark's "War Room" link; "Universal Mode" caption is dropped.
- `renderStep1` (1811–2261) → new layout, **same inputs and handlers**:

```
hero (art 44-map-table.webp)
  left: eyebrow "Scenario setup · step 1 of 3" · h1 "What happened?" · lead (existing copy 1814–1818)
        <textarea> (existing `context`/`setContext`, SCENARIO_PLACEHOLDER, min-50 counter) as `.wr-field` on dark
        attach row: [Attach a document] (existing drop zone + fileInputRef + uploaded state 1840–1905, collapsed into a chip when uploaded)  [Brand logo] (existing upload 1964–2023, thumb when set)
  right: <FootprintRadar/> glass — from `footprint` state: Countries chips (role), Signals chips, Proposed chips (accepted = `.on`, removed = `.off` strike-through; clicking toggles via the existing proposal accept/remove handlers), notice line (`footprintNotice`), Re-detect button → detectFootprint(); loading state text (2099–2103); before any footprint: the explanatory copy (2106–2111)
.wr-map
  lane "Organisations" (vignette 01-war-room-sm; count "{1+extra} of 6 · {teams} teams"; [Add organisation] = existing add button 2072–2081, disabled at 6)
     cards: HQ node — org name input (1911–1917), country (CountrySelect), city, type (1927–1962), teams RosterBuilder (2040) rendered as chips row + inline editor toggle (RosterBuilder is unchanged; it opens under the chips when "Edit teams" is pressed); extra orgs → existing <OrganisationCard/> (2057–2068) each wrapped in a `.wr-node` frame (AI-operated toggle and proposed_reason are already in OrganisationCard); dashed add node
     rosterError line (2082–2084)
  lane "Pressure groups" (vignette 16-protest-lobby-sm; count "{n} of 6"; icon buttons for the five kinds = existing add buttons 2141–2157)
     cards: existing <PressureOrgCard/> (2130–2137) wrapped in `.wr-node`; dashed "Pressure group — or accept a proposal from the radar"; validation line (2158–2162)
  lane "Rival pages" (vignette 31-headline-storm-sm; count; existing competitor inputs 2175–2208 become the dashed add card's inline form)
     cards: `competitorEntries` (2222–2239) as `.wr-node` rival cards with remove; auto-antagonist checkbox (2241–2248) as a toggle row in the lane head
  .wr-ctabar: "{orgs} organisations · {teams} teams · {countries} countries · {pressure} pressure · {rivals} rival" — Back (→ War Room) — Save draft (existing draft save) — "Build the scenario →" (existing goNext, disabled by !canProceed; existing ready hint 2252–2259 folded into the bar's hint)
```

- `renderBuilding` and `renderStep7`/`renderBlueprintReview` keep their bodies; they render inside `.wr-map` under the hero with art `29-clock-pressure.webp` (Build) and `13-debrief.webp` (Review). Their `military-border` inner panels become `.wr-node` panels (class swap only).

## 6. Surface D — Scenario detail

### 6.1 Corporate crisis: `frontend/src/components/Scenario/SocialScenarioEditor.tsx` (2380 lines)

**Keep:** all section components and their save logic (`OverviewSection`, `OrganisationsSection`, `StakeholdersSection` import, `PersonasSection`, `FactSheetSection`, `OrgPagesSection`, `InjectsSection`, `TeamsSection`, `ObjectivesSection`, `ResearchGuidelinesSection`), `editability` fetch and `locked`, `saveInitialState`, `InjectForm`, `PersonaForm`, `StringListEditor`, `SaveStatus`.

**Change the frame (lines 249–381):**

```
<div class="fixed inset-0 bg-ink/40 backdrop-blur-md z-50 overflow-y-auto">   // full-height sheet instead of a 4xl card
  <div class="wr-detail max-w-[1380px] mx-auto my-4 rounded-2xl overflow-hidden bg-surface">
    <div class="wr-bar sticky top-0">  ← Scenarios (onClose) · title · lock pill (Editable / Locked — session live / Locked — no credits, from `editability`) · Clone (hidden until an endpoint exists) · Launch session (→ /sessions?create=id)
    <header class="wr-artband wr-hero">  art via artFor(scen) full · eyebrow "Corporate crisis · compiled {created_at} · {duration} min" · h1 title · description · cast chips (initial_state.orgs) · meta (validation passed if initial_state.validation?.ok, "Executive decisions: organic" if a team has function Executive, last session) · KPI glass tiles: teams, contacts, crowd, injects, countries
    <div class="wr-wrap grid [240px 1fr]">
      <nav class="wr-toc sticky">  links to each section id with counts · Expand all / Collapse all (useSectionIndex)
      <main>  each existing section rendered inside <WrSection id title count icon family subtitle peek defaultOpen>:
        overview (open) · orgs (5 · protagonist/pressure/rival peek) · teams · cast (open) · crowd (PersonasSection) · injects (open) · pressure (OrgPagesSection filtered to side==='pressure' — the mandate/ladder copy lives in the page's `posture`) · facts · sop (initial_state.sop_definitions, read-only list) · objectives · research guidelines
        lock banner (290–315) moves under the bar as a slim strip only when locked
```

- `SectionCard` (133–148) becomes a thin wrapper over `WrSection` so all sections fold without touching their internals.
- `InjectsSection` (1115–1209): keep sort/expand/add logic; render rows grouped by phase (`Math.floor(t/15)*15` → "T+0–15 · opening" etc., plus "Conditional" for `trigger_time_minutes == null`) inside `WrGroup`s; row = `InjectCard` restyled: T+ chip · `<OriginBadge/>` · title/author→team · right tags (stakeholder, page statement, rival, country cc, decision/dormant) — the coloured platform pill at 1237–1245 is replaced by the badge, other tags (1257–1290) stay. Add an **Origin** filter segment above the groups (client-side, counts per origin). "Show N more" is not needed — all rows render, the fold does the work.
- `StakeholdersSection.tsx` (`frontend/src/components/Scenario/StakeholdersSection.tsx`, 760 lines): keep CRUD, drafts, `filterOrg`. Change the list render (≈ lines 650–760): group by `org_key` (registry name + country) → `relationship` (Internal, Clients & partners, Media, Regulators, Union, Community, Investors & board, Suppliers…, then "Workforce roster" for `tier==='roster'`, "Distribution list" for `kind==='group'`) using `WrGroup`/`WrSub`; roster and list folded by default; row = monogram · name + pills (relationship, pure/live concern with first inject T+, speaks-for, roster, list·members) · title · org · owned by · email; existing edit/delete controls on the right. Add search input + segment (All / Principals / Live concern / Roster / Lists / Spokespersons) — matching opens the groups. The existing org filter chips (662) are replaced by the group headers (same `filterOrg` state drives which org groups are open).

### 6.2 Field operations: `frontend/src/components/Scenario/ScenarioDetailView.tsx` (4486 lines)

**Keep:** all data loading (352–381), tab bodies (Overview, Teams, Injects, Map Pins, Env Truths, Routes, Standards, Research), `MapPinsTab` and everything from line 1580 on.

**Change:** the frame (431–500): same `wr-bar` + `wr-artband` hero as 6.1 (art via `artFor`, KPIs: teams, injects, hazards, casualties, min); the tab strip (482–496) becomes the left `wr-toc` (same `activeTab` state — index links set the tab; not collapsibles, because the Map Pins tab needs full width and Leaflet must stay mounted only when visible). Inject lists (753–819) get `<OriginBadge/>` for injects whose `delivery_config.app` is set; field-ops injects without an app show a neutral `type` chip. The emoji tile at 437–442 is replaced by `WrIcon map`.

## 7. Files touched — summary

| File                                                        | Kind           | Change                                                                           |
| ----------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `frontend/src/design/warroom.css`                           | new            | primitives (§1.1)                                                                |
| `frontend/src/main.tsx`                                     | edit           | `import './design/warroom.css'`                                                  |
| `frontend/src/components/UI/WarRoomIcon.tsx`                | new            | icon sprite + TEAM_ICON/INCIDENT_ICON                                            |
| `frontend/src/components/UI/OriginBadge.tsx`                | new            | origin mapping + badge                                                           |
| `frontend/src/components/UI/Collapsible.tsx`                | new            | WrSection/WrGroup/WrSub + useSectionIndex                                        |
| `frontend/src/lib/scenarioArt.ts`                           | new            | deterministic art picker                                                         |
| `frontend/src/lib/api.ts`                                   | edit           | `scenarios.list({ include })`, `ScenarioSummary` type                            |
| `server/routes/scenarios.ts`                                | edit           | `?include=summary` on GET `/` (§2.1)                                             |
| `frontend/src/pages/Scenarios.tsx`                          | rewrite render | §3 (logic preserved)                                                             |
| `frontend/src/components/Forms/CreateSessionModal.tsx`      | edit           | `initialScenarioId` prop                                                         |
| `frontend/src/pages/Sessions.tsx`                           | edit           | `?create=` opens modal preselected                                               |
| `frontend/src/pages/WarRoom.tsx`                            | rewrite render | §4 (logic preserved)                                                             |
| `frontend/src/pages/SocialCrisisWizard.tsx`                 | edit render    | §5: `progressBar`, outer render, `renderStep1`; class swaps in Build/Review      |
| `frontend/src/components/Scenario/SocialScenarioEditor.tsx` | edit           | frame, `SectionCard`→`WrSection`, `InjectsSection` grouping + `InjectCard` badge |
| `frontend/src/components/Scenario/StakeholdersSection.tsx`  | edit           | grouped list + search (CRUD untouched)                                           |
| `frontend/src/components/Scenario/ScenarioDetailView.tsx`   | edit           | frame + index nav + inject badges                                                |
| `docs/design/warroom/IMPLEMENTATION_SPEC.md`                | this file      | kept current                                                                     |

Not touched: `OrganisationRosterBuilder.tsx` (its cards are wrapped, not edited), `BrandMark.tsx` (reused as-is), any runtime/sim component, any migration.

## 8. Verification

Per slice, before commit:

1. `npm run typecheck` (frontend + server), `npm run lint`, `npm run build` (frontend) — zero new errors.
2. Dev server smoke in the browser (trainer account):
   - **Library:** header counts match list; type segment + status chips + search compose; sort changes order; live rail shows only in-progress/paused; card art stable across reload; expand-in-place loads injects with badges; Open full → detail; Launch → Sessions modal preselected; Delete still confirms and removes; participant login sees brief modal only.
   - **War Room:** path selection → Continue routes corporate to `/warroom/social-crisis`, field to Incident; resume ledger Resume/Re-compile behave as before; Incident selection + custom text persists in draft; Teams add/remove/min/max/investigative persist; steps 3/5/6/7 render their components unchanged inside the shell; zero-credit and access-denied screens still gate.
   - **Wizard Setup:** textarea min-50 gating; document upload/remove; logo upload/remove; HQ fields; roster editing (voice designation, custom team); add/remove extra org (AI toggle); footprint detect/re-detect populates radar, proposals toggle; pressure org add/edit/remove + validation; competitor add/remove + auto-antagonist; Build → generation progress; Review → compile → library. Resume from a draft restores every field.
   - **Detail (corporate):** lock banner states; every section saves as before (spot-check overview title, a persona, a fact, an inject time, a team charter, an objective); injects grouped by phase with origin badges and filter; cast grouped, roster folded, search narrows; expand/collapse all.
   - **Detail (field):** tabs via index; Map Pins interactive; badges on injects with an app.
3. Existing scripts: `scripts/e2e-scenario-edit-verify.ts` (edit lock + edits) and `scripts/e2e-multi-org-routes.ts` still pass against a local server — they exercise the endpoints the redesigned views call.
4. Reduced-motion check (`prefers-reduced-motion: reduce` in devtools) — no animations.
5. Widths 1440 / 1024 / 390.

## 9. Commit plan (each independently revertable)

1. `design: foundation — warroom.css, WrIcon, OriginBadge, Collapsible, scenarioArt`
2. `api: GET /api/scenarios?include=summary; CreateSessionModal initialScenarioId; Sessions ?create=`
3. `library: Situation Map page frame, poster cards with art, live rail, in-place expansion, list view`
4. `warroom: entry paths, resume ledger, field-ops shell (incident groups, team cards), CTA bar`
5. `wizard: corporate crisis Setup as brief + footprint radar + lanes; Build/Review in the shell`
6. `detail: corporate editor frame + folding sections, cast grouping + search, injects by phase with origin badges; field detail frame`
7. `docs: spec delivery record`

Push to `master` after each green slice (Render deploys from master; the frontend build is part of the deploy, so a slice that fails `build` never ships).

## 10. Risks and how they're contained

- **Regressing a handler while moving JSX.** Mitigation: move blocks verbatim, change only `className`s and wrappers; the smoke list in §8 is the acceptance test; e2e scripts cover the server side.
- **`initial_state` shape variance** across old scenarios (no `orgs`, no `stakeholders`, legacy team names). Mitigation: every read is guarded (`?? []`), cast chips fall back to the scenario's `country`, KPIs hide when zero, legacy names map through `TEAM_ICON` fallback.
- **Summary query cost** on trainers with many scenarios (97 today). Three `IN (...)` queries; if the list grows past ~500 ids, chunk the `IN` lists. Not needed now.
- **Leaflet in field detail** must not be mounted inside a closed `<details>` (size 0). Hence tabs, not collapsibles, for field ops.
- **Sticky toolbar + hero negative margin** on very short viewports — toolbar `top` uses `0.6rem` and the hero has no sticky children.

## 11. Out of scope (noted for follow-up)

- Discarding wizard drafts from the ledger (needs `DELETE /api/warroom/wizard-drafts/:id`).
- Clone scenario (no endpoint).
- Field-ops Scene editor / Location / Research / Compile step _bodies_ (they inherit the shell only).
- Trainer dashboard, Sessions page, AAR — untouched by this redesign.
- A read-only "Preview" mode distinct from the editor; today Preview and Edit both open the editor, which enforces the lock.

## 12. Delivery record

All slices landed on `master` on 2026-09-20. Frontend `tsc` + `vite build`, server `tsc`, and eslint were green before each push; each surface was smoke-tested in the browser against the dev stack (`PORT=3001` backend, Vite on 3002) with the trainer account's real library (97 scenarios).

| Slice                | Commit    | Notes                                                                                                                                                                                                                               |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1+2 Foundation + API | `58361cc` | `warroom.css`, `WarRoomIcon.tsx`, `OriginBadge.tsx`, `Collapsible.tsx`, `scenarioArt.ts`; `GET /api/scenarios?include=summary`; `CreateSessionModal.initialScenarioId`; `Sessions ?create=`.                                        |
| 3 Library            | `d3f399b` | `Scenarios.tsx` rewritten around the preserved logic.                                                                                                                                                                               |
| 4 War Room entry     | `f34df92` | render from `if (!isTrainer)` down replaced; everything above untouched.                                                                                                                                                            |
| 5 Wizard Setup       | `04ef28c` | `progressBar` + `renderStep1` + outer render replaced; `renderBuilding` / `renderBlueprintReview` / `renderStep7` bodies kept (their duplicate `<h2>` headings removed, `military-border` → `wr-node`).                             |
| 6 Detail             | `ed4095d` | `SocialScenarioEditor` frame + `SectionCard`→`WrSection`; `InjectsSection` phases + origin filter; `InjectCard` → `wr-inj` row with `OriginBadge`; `StakeholdersSection` grouped cast + search; `ScenarioDetailView` frame + index. |

**Deviations from the spec (and why):**

1. **`frontend/src/lib/api.ts` was not edited.** Another agent had the file open with uncommitted work, so the library calls live in a new module `frontend/src/lib/scenarioLibraryApi.ts` (same auth + base-URL conventions). §2.2 as written is superseded by this.
2. **Inject counts are per-scenario HEAD requests, not one grouped `IN` query.** The grouped select returned 0 for most cards in the live check: PostgREST caps responses at 1000 rows and 97 scenarios × ~150 template injects exceeds it. `injectCountsFor()` counts each scenario with `select('id', { count: 'exact', head: true })` in batches of 12, filtered to `session_id IS NULL`, cached in-process for 60 s and invalidated on inject create/delete. Teams and sessions keep the grouped query with an explicit `.limit(5000)`.
3. **Clone shipped.** §11 said no endpoint existed; `POST /api/scenarios/:id/clone` does. `cloneScenario()` was added to the library API and a Clone button to the corporate detail bar (confirms, clones, closes; the library reloads on close).
4. **Team card KPIs on field-ops posters show objectives, not hazards** — hazard counts are not in the list summary (they need `scenario_hazards`); the field detail hero shows real hazard / casualty counts from its own loads.
5. **Cast grouping was verified by typecheck and code review only.** No scenario in the account has `initial_state.stakeholders` (the E2E multi-org scenarios were cleaned up), so the browser check exercised the empty path; the grouping mirrors the previous list's data flow (`list` → `org_key` → `relationship`).
6. **Stepper on the War Room entry** shows the path's steps as ghosts once a path is chosen (the study had "…" placeholders only before choosing).
7. **Wizard "Next" label** reads _Detect footprint & continue_ until the footprint has run for the current text, then _Build the scenario_ — matching the existing two-click behaviour in `goNext`.

**Still open (unchanged from §11):** draft discard from the ledger; a read-only Preview distinct from the editor; the field-ops Scene editor / Location / Research / Compile step bodies; Dashboard, Sessions and AAR pages.
