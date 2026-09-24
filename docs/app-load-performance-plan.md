# App load performance — cards on screen fast

**Owner:** unassigned (touches `server/routes/{scenarios,sessions}.ts`, `server/middleware/auth.ts`,
`server/index.ts`, `frontend/src/main.tsx`, `frontend/vite.config.ts`).
**Status:** v1 plan, 2026-09-22. **Stage 1 shipped 2026-09-24** (commit `40b9e8a`, migrations
213–214); see "Stage 1 — shipped" below. Phases 3, 5 and 7 are not implemented.
**Goal:** scenario cards and session cards appear effectively instantly on a warm visit, and in
roughly one round trip on a cold visit.
**Measured against:** production Supabase project `umnutnosxiypbnzpqszk`, 99 scenarios,
265 sessions, 33,071 `scenario_injects` rows. All numbers below are measured, not estimated.

---

## Stage 1 — shipped 2026-09-24

| Plan item               | What shipped                                                                                                  | Measured                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| §2.1 compression        | `compression()` after CORS; NDJSON streams opt out with `Cache-Control: no-transform` (added in `warroom.ts`) | `Vary: Accept-Encoding` on live responses                                |
| §2.2 slim scenario list | card columns plus `country:initial_state->>country`                                                           | 13 MB → 128 kB for 100 rows, before gzip                                 |
| §2.3 slim sessions list | explicit columns and the `participants:` alias                                                                | 8.2 MB → 13.6 kB for 20 rows; participant chip and tile now populated    |
| §2.4 cast               | option (a): the server sends `summary.cast` (first 3 organisations × 4 people)                                | expanded card renders the same groups                                    |
| §3.1 dashboard stats    | `GET /api/dashboard/stats` backed by `dashboard_stats()`                                                      | matches direct counts; active count no longer limited to the first 50    |
| §7.1–7.2 library counts | partial index plus `scenario_library_counts()` (teams, template injects, crowd); 60 s cache removed           | 29 ms warm for all 100 scenarios, replacing up to 9 waves of 12 requests |
| §9 polish               | reveal stagger 60 → 20 ms with the cap 8 → 4; the three remaining images lazy-load                            | —                                                                        |
| §11a.6 guardrail        | ESLint blocks `select('*')` on `sessions`/`scenarios`; three explained opt-outs (detail routes, clone)        | —                                                                        |
| Sessions page           | participants no longer wait for `processInvitations` before the list loads                                    | —                                                                        |

**Held for a decision:** Phase 3 in-process JWT verification needs `SUPABASE_JWT_SECRET` in Render
(or asymmetric signing keys; the JWKS endpoint is still empty). Optimistic auth render stays out,
per §11a.

**Not started:** Phase 5 code splitting (§11a risks first), Phase 7 client cache, hero preload.

---

## 0. Why (evidence, not theory)

The database is **not** the bottleneck. Every query on the card path runs in well under a
millisecond:

| Query                                   | Execution time | Plan                              |
| --------------------------------------- | -------------- | --------------------------------- |
| Trainer session list (20 rows, ordered) | **0.399 ms**   | Seq scan + top-N heapsort         |
| Full scenario list (99 rows, ordered)   | **0.390 ms**   | Seq scan + quicksort              |
| Single scenario template-inject count   | **0.235 ms**   | Index scan `idx_injects_scenario` |

The bottleneck is that **the API ships 100–900× more bytes than the cards draw**, uncompressed,
behind a single 2.77 MB JavaScript bundle, after two serial round trips of dead waiting.

### 0.1 Three JSONB columns nobody on the card path reads

| Column                        | Avg / row  | Total over table   | Actually read by                                                                        |
| ----------------------------- | ---------- | ------------------ | --------------------------------------------------------------------------------------- |
| `scenarios.insider_knowledge` | **87 KB**  | 8,454 kB           | `ScenarioDetailView`, `TrainerEnvironmentalTruths`, `WarRoomLegacy` — detail views only |
| `sessions.current_state`      | **209 KB** | 4,092 kB / 20 rows | Live session runtime only                                                               |
| `scenarios.initial_state`     | **44 KB**  | 4,308 kB           | Library needs `.country`; `ExpandedPoster` needs `.stakeholders`                        |

Verified unused on the card path: `grep insider_knowledge frontend/src` returns only the three
detail-view files above. `sessions.current_state` appears nowhere in `pages/Sessions.tsx`.

### 0.2 What that costs per endpoint

| Endpoint                             | Returns today | Card fields need | Ratio     |
| ------------------------------------ | ------------- | ---------------- | --------- |
| `GET /api/scenarios?include=summary` | **13 MB**     | **129 kB**       | **~100×** |
| `GET /api/sessions?page=1&limit=20`  | **8.2 MB**    | **9.3 kB**       | **~900×** |
| `GET /api/sessions?page=1&limit=50`  | **14 MB**     | ~23 kB           | **~600×** |

### 0.3 The worst offender is the landing route

`/` redirects to `/dashboard` (`main.tsx` L247). `TrainerDashboard` (L30) fires **both** lists:

```
Promise.allSettled([api.scenarios.list(), api.sessions.list(1, 50)])
```

That is **13 MB + 14 MB = ~27 MB** downloaded and `JSON.parse`d to compute **four integers**:
`scenarios.length`, `count` (already returned as a scalar by the API), a count of
`status === 'in_progress'`, and a set-size of participant user ids. This is the single largest
waste in the codebase and it is on the first screen after login.

### 0.4 No compression anywhere

There is no `compression` middleware in `server/index.ts`, and no equivalent in `frontend/vercel.json`
(which only serves static assets). Every JSON response above crosses the wire raw. JSON of this
shape compresses roughly 10×.

### 0.5 One bundle, no splitting

`frontend/dist/assets/index-BLbc8yUn.js` is **2.77 MB raw / 767 kB gzipped**. There is **not a
single `React.lazy` in the entire frontend** (0 matches), and only 5 dynamic `import()` calls, none
route-level. `main.tsx` statically imports all 19 pages plus every `SimDevice` component, so the
login screen downloads and parses:

| Pulled in eagerly               | Size                       | Needed for a card?                  |
| ------------------------------- | -------------------------- | ----------------------------------- |
| `leaflet`                       | 1,431 kB                   | No (29 importers, all map surfaces) |
| `matter-js`                     | 807 kB                     | No (`DebugRTSSim` only)             |
| `@tiptap` + `prosemirror-model` | 716 kB                     | No (3 importers, editors)           |
| `socket.io-client`              | 416 kB                     | No (live session only)              |
| `DebugRTSSim.tsx`               | 219 kB source, 4,932 lines | No                                  |
| `SocialCrisisWizard.tsx`        | 163 kB source              | No                                  |
| `SessionView.tsx`               | 126 kB source              | No                                  |
| `WarRoomLegacy.tsx`             | 120 kB source              | No                                  |

`vite.config.ts` also has no `manualChunks`, so every deploy invalidates vendor code along with
app code.

### 0.6 A serial waterfall gates the first card request

Nothing fetches cards until all of this completes in order:

1. Download + parse 767 kB gzipped bundle.
2. `supabase.auth.getSession()` — `AuthContext.tsx` L40.
3. `await fetch('/api/profile')` — `resolveSessionUser()`, `AuthContext.tsx` L124.
4. `setLoading(false)` → `ProtectedRoute` stops returning the "Authenticating" screen (`main.tsx` L50).
5. Page mounts, `useEffect` runs, list request is finally issued.

That is **two full round trips before the card request leaves the browser**. `Sessions.tsx` adds a
third for participants: `initialize()` (L55) `await`s `api.sessions.processInvitations()` _before_
`loadSessions()`.

### 0.7 Every API request pays two more round trips server-side

`server/middleware/auth.ts` `requireAuth`:

- L38 `await supabaseAdmin.auth.getUser(token)` — an outbound HTTP call to Supabase Auth.
- L52 a separate `user_profiles` select.

Serial, uncached, on **every single authenticated request**. The JWT is signed; verifying it
in-process is microseconds.

### 0.8 The library makes 99 count requests per load

`injectCountsFor` (`scenarios.ts` L168–198) issues one PostgREST HEAD count per scenario with
`BATCH = 12`. 99 scenarios → **9 sequential waves** of network calls, recurring whenever the 60 s
`injectCountCache` expires. The per-row query is fast (0.235 ms); the cost is entirely round trips.

### 0.9 One genuinely missing index

The single grouped query that would replace those 99 calls is currently slow:

```
select scenario_id, count(*) from scenario_injects where session_id is null group by scenario_id
→ 373.9 ms, Seq Scan, "Rows Removed by Filter: 25915"
```

`idx_scenario_injects_session_id` is partial on `WHERE session_id IS NOT NULL` — the exact inverse
of what the template-inject count needs. There is no index serving `session_id IS NULL`.

### 0.10 Latent bug: the participants join is dead weight

`sessions.ts` L85 selects `session_participants(*, user:user_profiles(*))`, so the JSON key is
`session_participants`. But `pages/Sessions.tsx` L29 declares `participants?` and L203 reads
`s.participants`, and `TrainerDashboard` L46 reads `s.participants`. **No aliasing happens on the
list endpoint** (the single-session endpoint at L1217 does alias it correctly).

Consequence: `s.participants` is always `undefined`, so the participant chip never renders, the
"participants" tile on Sessions is always 0, and the dashboard participants stat is always null —
while the app pays to transfer the full participants join plus a nested `user_profiles(*)` per
participant. Fixing the alias is both a payload win and a bug fix.

### 0.11 Perceived speed

`warroom.css` L377: `.wr-reveal { animation: wr-fadeUp .5s both; animation-delay: calc(var(--i,0) * 60ms) }`
with `--i` capped at `Math.min(index, 8)` (`Scenarios.tsx` L854). The last visible card finishes
appearing **~980 ms after the data already arrived**.

Artwork is already in good shape and needs no work: card thumbnails are 30–50 kB WebP and the main
poster grid uses `loading="lazy"`. Three stragglers lack it (`Scenarios.tsx` L507, L611, L1007).

### 0.12 No client-side caching

No react-query, SWR, or `sessionStorage` layer for these lists. Dashboard → Scenarios → Sessions →
Scenarios refetches everything from scratch, so the shimmer skeleton shows on every visit even when
nothing changed.

---

## 1. Field inventory (what the cards actually need)

Established by reading every usage site. This is the contract the slim projections must satisfy.

### 1.1 Scenario library card — `pages/Scenarios.tsx`

| Field              | Used at                                                        |
| ------------------ | -------------------------------------------------------------- |
| `id`               | keys, `artFor`, launch / detail routing                        |
| `title`            | L514, L618, L865; search L217; sort `az` L229                  |
| `description`      | L866; search L218; `artFor` tag matching                       |
| `category`         | `isSocial` L34; search L219                                    |
| `difficulty`       | participant brief modal L769                                   |
| `duration_minutes` | L523, L636, L110/L116, L740                                    |
| `objectives`       | `.length` only (L114, L875) + brief modal list L780            |
| `is_active`        | `lockState` L171, counts L191, filters L207, `StatusChip` L820 |
| `created_at`       | `fmtDate` L621/L872; sort `compiled` L225                      |
| `country`          | `CastChips` L70; search L221                                   |
| `summary.*`        | server-computed, already narrow                                |

**Trap:** there is **no `country` column on `scenarios`**. The 22 real columns are `id, title,
description, category, difficulty, duration_minutes, objectives, initial_state, created_by,
is_active, created_at, updated_at, briefing, role_specific_briefs, center_lat, center_lng,
vicinity_radius_meters, vicinity_map_url, layout_image_url, insider_knowledge, sweep_device_pool,
blueprint`. `LibraryScenario.country` (scenarioLibraryApi.ts L54) is declared but always
`undefined` today, and `CastChips` silently falls back to `initial_state.country`. The slim
projection **must** derive it: `country:initial_state->>country`.

**The one real blocker:** `ExpandedPoster` (L975–978) reads `s.initial_state.stakeholders` to build
cast groups. This is the only card-path consumer of `initial_state` beyond `country`, and it only
runs when a trainer expands a card. It must move to a peek call — the pattern already exists
(`getScenarioInjectsPeek`, `getScenarioTeamsPeek`, both fired on expand at L965–966).

Not needed by the list: `briefing`, `role_specific_briefs`, `insider_knowledge`, `blueprint`,
`sweep_device_pool`, `center_lat`, `center_lng`, `vicinity_radius_meters`, `vicinity_map_url`,
`layout_image_url`, `created_by`, `updated_at`, and the rest of `initial_state`.

### 1.2 Session card — `pages/Sessions.tsx` L13–37

Needs: `id`, `status`, `scenario_id`, `trainer_id`, `start_time`, `end_time`, `join_token`,
`scenarios.{title,category,difficulty}`, `trainer.full_name`, and `participants[].user_id`
(length + unique-id set only; `role` and `user` are declared but never read).

Not needed: `current_state` and every other `sessions` column, the remaining ~19 `scenarios`
columns, and both full `user_profiles(*)` expansions.

### 1.3 Create-session modal — `CreateSessionModal.tsx` L14–21

`CreateSessionScenario` needs `id`, `title`, `category`, `description`, `duration_minutes`,
`is_active` — a strict subset of §1.1. The slim `/api/scenarios` projection covers it with no
modal changes.

### 1.4 Detail views are already safe

`ScenarioDetailView` takes only a `scenarioId` prop and fetches the full row itself via
`api.scenarios.get(scenarioId)` (L359). Slimming the list cannot break it. The participant brief
modal reuses the list object but only reads fields in §1.1.

### 1.5 Non-frontend consumers

`loadtest/session.ts` only POSTs `/api/sessions` and PATCHes `/api/sessions/:id`; it never consumes
either list. No external consumer constrains the response shape.

---

## 2. Phase 1 — Wire weight (biggest win, lowest risk)

Target: the two card endpoints drop from megabytes to tens of kilobytes.

### 2.1 Enable compression

- Add `compression` to `package.json` and `app.use(compression())` in `server/index.ts`, mounted
  **before** the routers (after `helmet`/`cors`, around L154).
- Exclude the NDJSON streaming routes. `socialCrisisWarroom.ts` L270–273 and `warroom.ts` L389–390
  hold long-lived chunked responses; `compression` buffers, which would break incremental delivery.
  Those routes already set `Cache-Control: no-transform` — use a `filter` that honours it, or skip
  when `Content-Type` is `application/x-ndjson`.
- **Acceptance:** `curl -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}'` on both list
  endpoints shows roughly a 10× reduction; NDJSON war-room builds still stream incrementally.

### 2.2 Slim `GET /api/scenarios`

In `server/routes/scenarios.ts` L207, replace `.select('*')` with an explicit projection:

```
id, title, description, category, difficulty, duration_minutes, objectives,
is_active, created_at, country:initial_state->>country
```

- Keep the `include=summary` block (L229–308) unchanged; it already reads `initial_state` off the
  row to count stakeholders/personas/orgs. **It will break when the column is dropped from the
  projection** — see §2.4. Resolve that in the same commit.
- **Expected:** 13 MB → ~129 kB before compression.
- **Acceptance:** library renders identically (titles, descriptions, KPIs, cast chips, lock states,
  all four sort orders, search including country); create-session modal still lists scenarios.

### 2.3 Slim `GET /api/sessions`

In `server/routes/sessions.ts` L84–87, replace the select string with:

```
id, status, scenario_id, trainer_id, start_time, end_time, join_token, created_at,
scenarios(title, category, difficulty),
trainer:user_profiles!sessions_trainer_id_fkey(full_name),
participants:session_participants(user_id)
```

- The `participants:` alias fixes §0.10 in passing. Verify the participant chip and the
  participants tile start showing real numbers — they are currently dead.
- Keep `{ count: 'exact' }`.
- **Expected:** 8.2 MB → ~9.3 kB for 20 rows.
- **Acceptance:** all three groups (Live / Scheduled / Completed) render; status chips, elapsed
  timers, trainer names, difficulty, and the four header tiles are correct; participant counts now
  non-zero where participants exist.

### 2.4 Move `initial_state.stakeholders` off the list

Two options — decide before implementing:

- **(a) Extend `summary`.** The `include=summary` block already has the row's `initial_state` in
  hand server-side. Add a trimmed `summary.cast` array (org_key, name, title, tier, kind) capped at
  what `ExpandedPoster` renders (3 org groups). Keeps one round trip; grows the list slightly.
- **(b) New peek endpoint** `GET /api/scenarios/:id/stakeholders-peek`, fetched on expand alongside
  the existing two peeks. Keeps the list minimal; adds a request on expand only.

Recommendation: **(a)**, because the summary aggregation already has the data and `ExpandedPoster`
would otherwise show an empty cast for a beat. Re-measure after — if `summary.cast` pushes the list
past ~300 kB, switch to (b).

- **Acceptance:** expanding a trainer card shows the same cast groups as today.

### 2.5 Rollback

Each of 2.1–2.3 is an independent, revertible commit. Reverting a select string restores the old
shape exactly; no schema or client type changes are required for 2.2/2.3 beyond §2.4.

---

## 3. Phase 2 — Stop the dashboard from downloading the world

### 3.1 Add `GET /api/dashboard/stats`

Returns exactly what `TrainerDashboard` renders:

```json
{ "scenarios": 0, "activeSessions": 0, "totalSessions": 0, "participants": 0 }
```

- Implement as four `head: true, count: 'exact'` counts plus one distinct-participant count,
  respecting the same visibility rules as the list routes (admin sees all; trainer scoped to
  `trainer_id` / `created_by`).
- Replace the `Promise.allSettled([api.scenarios.list(), api.sessions.list(1, 50)])` at
  `TrainerDashboard.tsx` L30 with the single call.
- **Expected:** ~27 MB → well under 1 kB on the landing route.
- **Acceptance:** all four tiles show the same numbers as today, except `participants`, which
  currently renders as null and should now be correct (§0.10).

### 3.2 Check `AgencyDashboard` too

`Dashboard.tsx` L131 renders `AgencyDashboard` for non-trainers. Audit it for the same pattern
before assuming the trainer path is the only offender.

---

## 4. Phase 3 — Per-request auth latency

### 4.1 Verify the JWT in-process

`requireAuth` L38 replaces an outbound HTTP call with local signature verification.

**Verified prerequisite:** `https://umnutnosxiypbnzpqszk.supabase.co/auth/v1/.well-known/jwks.json`
currently returns `{"keys":[]}`. The project is still on the **legacy shared HS256 secret**, and
`server/env.ts` has no JWT secret variable (only `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, L55–59). So one of these must happen first:

- **(a) Legacy HS256.** Add `SUPABASE_JWT_SECRET` to `server/env.ts` and Render, then
  `jwt.verify(token, secret, { algorithms: ['HS256'] })`. `jsonwebtoken` is already a dependency.
  Fastest path; the secret is long-lived and cannot be rotated without a redeploy.
- **(b) Migrate to asymmetric keys.** Create a signing key in the Supabase dashboard, which
  populates the JWKS endpoint, then verify with a cached JWKS fetch and `RS256`/`ES256`. Supabase's
  recommended direction and rotatable without redeploy; more setup, and existing tokens must age out.

Recommendation: **(b)** if the migration is painless on this project, otherwise **(a)**. This is a
security-relevant change — verification must be strict (algorithm allow-list, `aud`, `exp`, issuer)
and must fail closed. Worth a Security Review pass on the diff.

### 4.2 Cache the profile lookup

L52's `user_profiles` select is a primary-key hit per request. Add a small in-process TTL cache
(30–60 s) keyed by user id, mirroring the existing `injectCountCache` pattern. Must be invalidated
on profile update (`routes/profile.ts`) so role changes take effect promptly.

Note this cache is per-container and Render may run several; a short TTL keeps divergence bounded.

- **Acceptance:** no behavioural change; 401s still returned for expired/garbage tokens; a role
  change takes effect within the TTL. Measure server-side handler time before/after.

---

## 5. Phase 4 — Unblock the render waterfall

### 5.1 Don't block the first paint on `/api/profile`

`AuthContext` currently withholds `loading = false` until `resolveSessionUser()` returns
(§0.6 steps 3–4). Render optimistically from the JWT instead: `mapSupabaseUser(session.user)`
already produces a `SessionUser` synchronously, and `/api/profile` only refines `role`, `agency`,
and `displayName`.

**Constraint — do not weaken the security posture.** The comment at `AuthContext.tsx` L94–99 is
explicit that role must not come from client-editable `user_metadata`, and defaults to
least-privilege `participant`. So:

- Flip `loading` false as soon as the session is known, and let `user.role` start at the
  least-privileged value, refining when the profile lands.
- `ProtectedRoute`'s `roles` check (L67) must therefore treat "profile not yet resolved" as
  _not yet authorised_ rather than denying outright, or trainer-only pages will bounce to
  `/dashboard` on reload. Add a distinct `roleResolved` flag rather than overloading `loading`.
- Authorization remains server-side regardless; this only affects what the UI paints.

This one needs care — it is the highest-risk item in the plan. If it looks hairy in review, the
cheaper alternative is to keep the gate but make `/api/profile` fast via Phase 3, which already
removes most of its cost.

### 5.2 Don't serialise `processInvitations()` ahead of the cards

`Sessions.tsx` L55–71: fire `api.sessions.processInvitations()` without `await` (or in parallel via
`Promise.all`) so `loadSessions()` starts immediately. It is described in-code as "just a
convenience feature" that fails silently, so it has no business gating the list. Refresh the list
afterwards only if it reports that it changed something.

### 5.3 Warm the request earlier

Optional, once Phase 3 lands: kick off the list fetch from the route module rather than waiting for
the child `useEffect`, so it overlaps with auth resolution instead of following it.

---

## 6. Phase 5 — Bundle

### 6.1 Route-level code splitting

Convert the page imports in `main.tsx` L5–36 to `React.lazy` + a single `<Suspense>` boundary.
Priority order by weight: `DebugRTSSim`, `SocialCrisisWizard`, `SessionView`, `WarRoomLegacy`,
`DebugEvacuationSim`, `DebugBuildingStuds`, `WarRoom`, then the `SimDevice` tree.

Keep eager: `Login`, `SignUp`, `Dashboard`, `Scenarios`, `Sessions` — the cheap, hot pages. Splitting
those would add a round trip to the very screens we are trying to speed up.

Use the existing `ProtectedRoute` loading treatment as the Suspense fallback so there is no new
visual state, and verify `ErrorBoundary` still catches lazy-chunk load failures (it will not by
default — a failed dynamic import rejects; add a retry or a friendly reload prompt).

### 6.2 Vendor chunking

Add `build.rollupOptions.output.manualChunks` to `vite.config.ts` splitting at least `react`/
`react-dom`/`react-router-dom`, `leaflet`+`react-leaflet`, `@tiptap`+`prosemirror`, `matter-js`,
and `socket.io-client`. This both removes them from the critical path (once 6.1 lands they are only
reachable from lazy routes) and stops app-code deploys from invalidating vendor cache.

### 6.3 Measure it properly

Add `rollup-plugin-visualizer` as a dev dependency and record a before/after treemap. Target for
the card pages: well under 200 kB gzipped on the critical path, down from 767 kB.

- **Acceptance:** every route still loads; `/scenarios` and `/sessions` critical-path JS is a
  fraction of today's; no eager `leaflet`/`matter-js`/`tiptap` in the entry chunk.

---

## 7. Phase 6 — Inject counts in one round trip

### 7.1 Add the missing partial index

New migration `migrations/212_scenario_injects_template_index.sql` (next in sequence after
`211_enquiries_acknowledged_at.sql`):

```sql
create index if not exists idx_scenario_injects_template
  on public.scenario_injects (scenario_id)
  where session_id is null;
```

Use `CREATE INDEX CONCURRENTLY` when applying to production if the table is being written to
(33,071 rows / 23 MB — brief, but concurrency is free insurance).

### 7.2 Collapse 99 requests into 1

Replace `injectCountsFor` (L168–198) with a single grouped aggregate exposed as a Postgres function
(an RPC sidesteps the PostgREST 1000-row cap that the current comment at L161–164 correctly
identifies):

```sql
create or replace function public.scenario_template_inject_counts(ids uuid[])
returns table (scenario_id uuid, n bigint)
language sql stable as $$
  select scenario_id, count(*) from public.scenario_injects
  where session_id is null and scenario_id = any(ids)
  group by scenario_id
$$;
```

- Keep the 60 s `injectCountCache` in front of it.
- **Expected:** 9 serial network waves → 1; and with 7.1 the aggregate stops being a 374 ms seq scan.
- **Acceptance:** inject counts on every card match today's values exactly; re-run the grouped
  `EXPLAIN` and confirm an index-only or bitmap path instead of `Seq Scan`.

### 7.3 Explicitly out of scope

`sessions.trainer_id`, `sessions.created_at`, and `session_participants.user_id` are unindexed, but
at 265 rows the planner does a seq scan in 0.4 ms and an index would not help. Revisit when
`sessions` reaches five figures. **Do not add these now** — they are write-path cost for no read
benefit.

---

## 8. Phase 7 — Make repeat visits instant

### 8.1 Stale-while-revalidate for the two lists

The goal in the request — "cards appear almost instantaneously" — is only fully achievable on
repeat visits with a cache. Render last-known cards immediately, revalidate in the background,
swap when fresh data lands.

Two options:

- **(a) Hand-rolled**, ~40 lines: a module-level `Map` plus `sessionStorage` for cross-reload
  persistence, wrapped around `listScenariosWithSummary()` and `api.sessions.list()`. No new
  dependency, fits the existing `lib/` conventions.
- **(b) TanStack Query.** Better long-term (dedupe, retries, invalidation, devtools) but a new
  dependency and a provider in `main.tsx`, and it wants adopting consistently rather than in two
  places.

Recommendation: **(a)** now, scoped to these two lists, since Phases 1–3 should already make cold
fetches small. Revisit (b) only if caching spreads.

Cache keys must include the user id and role, and must be cleared on `signOut` — otherwise one
user's cards can flash on another's screen on a shared machine. Mutations (create session, delete
scenario, start session) must invalidate.

### 8.2 Skeletons that match

Both loading states already shimmer (`Sessions.tsx` L298, `Scenarios.tsx` L306). With 8.1 they
should only appear on a true cold start.

---

## 9. Phase 8 — Perceived speed polish

- Drop or shorten the `.wr-reveal` stagger (`warroom.css` L377–380): either remove
  `animation-delay` entirely, or cut to `~20 ms` and cap `--i` at 4. Currently the last card lands
  ~980 ms after the data. Keep the `prefers-reduced-motion` block at L3104 intact.
- Add `loading="lazy"` to the three stragglers: `Scenarios.tsx` L507, L611, L1007.
- Preload the above-the-fold hero: `SHELL_ART.*` images are the full-size variants (up to 164 kB).
  Add `<link rel="preload" as="image">` for the hero, or switch the hero to the `-sm` variant where
  the render size allows.
- Consider `fetchpriority="high"` on the hero and explicit `width`/`height` on card art to remove
  layout shift.

---

## 10. Sequencing and expected effect

| Phase | Work                               | Effort | Effect on time-to-cards                        |
| ----- | ---------------------------------- | ------ | ---------------------------------------------- |
| 1     | Compression + slim both selects    | S      | **Largest.** MB → tens of kB per list          |
| 2     | Dashboard stats endpoint           | S      | Landing route stops moving ~27 MB              |
| 3     | Local JWT verify + profile cache   | M      | Removes 2 round trips from _every_ request     |
| 4     | Unblock the auth/profile waterfall | M-L    | Removes 1–2 round trips before the first fetch |
| 5     | Code splitting + vendor chunks     | M      | Fixes the cold first load (767 kB → <200 kB)   |
| 6     | Index + grouped inject counts      | S      | 9 network waves → 1; kills a 374 ms scan       |
| 7     | Stale-while-revalidate cache       | M      | Makes _repeat_ visits instant                  |
| 8     | Reveal stagger + image polish      | XS     | ~1 s off _perceived_ time, no data change      |

Phases 1, 2, 6, and 8 are independent and safe to land in any order. Phase 3 should precede
Phase 4 (a fast `/api/profile` makes the waterfall change less urgent and less risky). Phase 5 is
independent of everything else. Phase 7 is most valuable last, once payloads are already small.

If only one thing gets done: **Phase 1**. Two lines of `select` and one `app.use`.

---

## 11. Verification

**Before starting**, capture a baseline so the wins are provable rather than asserted:

- `curl -s -o /dev/null -w '%{size_download} %{time_total}\n'` against `/api/scenarios?include=summary`
  and `/api/sessions?page=1&limit=20`, with and without `Accept-Encoding: gzip`, authenticated as a
  trainer.
- `Get-ChildItem frontend/dist/assets` sizes plus the gzipped entry-chunk size.
- Chrome DevTools performance trace of a cold `/dashboard`, `/scenarios`, `/sessions` load:
  record time-to-first-card, total transferred, and `JSON.parse` time on the main thread.

Re-run all three after each phase and record the numbers in this document.

**Regression surface to exercise after Phase 1–2:** scenario library (all filters, all four sorts,
search by title/description/category/org/country, card + list views, expand, delete, launch),
create-session modal, sessions page (all three groups, status filter, search, start session, open
lobby, view AAR), trainer dashboard tiles, participant (non-trainer) views of both pages, and the
trainer scenario detail view including the `insider_knowledge` doctrine editor.

`npm run lint`, `npm run typecheck`, and `npm test` must stay green; the frontend build must pass
`tsc && vite build`.

---

## 11a. Drawbacks and second-order effects (added 2026-09-23)

A deliberate review of what each change breaks, slows down, or makes riskier.

### 11a.1 Code splitting (§6) introduces a whole-app crash mode that cannot happen today

`frontend/src/components/ErrorBoundary.tsx` is a **single top-level boundary**. When it catches
anything it replaces the entire application with a full-screen "Something went wrong" and a manual
Reload button. There are no per-route boundaries.

With one bundle, a chunk cannot fail _after_ load — once the app is running, all code is in memory.
Code splitting changes that in two ways:

- **Flaky network on a lazy route** → the dynamic `import()` rejects → the global boundary fires →
  the player loses the whole screen, mid-exercise.
- **Deploying while someone has the app open** → their loaded entry chunk references the _old_
  hashed chunk filenames. If those assets are gone, navigating to any lazy route 404s into the same
  full-screen error. For a trainer running a live session this is severe.

**Mitigation — Vite has a purpose-built hook for the deploy case.** It fires `vite:preloadError`
when a dynamic import fails, which is exactly the stale-chunk scenario:

```js
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault(); // stop it reaching the global ErrorBoundary
  window.location.reload(); // fetch the current index + chunk manifest
});
```

Register it in `main.tsx` **before** `createRoot`. That converts "trainer loses the whole screen
mid-exercise" into "the page reloads". Guard against a reload loop (e.g. a `sessionStorage` flag so
it only self-reloads once per session).

**Also amend §6.1:** add per-route `Suspense` **and** per-route error boundaries with a retry action,
rather than relying on the single global one, so a genuinely broken route does not take down the app
shell. Separately, confirm Vercel retains previous build assets across deploys — if it does not, that
alone is reason to defer splitting.

An earlier draft of §6.1 said the `ErrorBoundary` "will not catch" lazy-chunk failures. That was
wrong: it _does_ catch them, and the catching is the problem.

### 11a.2 The profile cache (§4.2) collides with a live role-change flow

`routes/profile.ts` L85 can change `role`, and there is a `become-trainer` endpoint. With a 30–60 s
cache keyed by user id, a freshly upgraded trainer keeps participant-level UI until the TTL expires.

This is **confusing, not dangerous** — the staleness is toward _less_ privilege, and authorization
stays server-side. But the cache is **per-container**, and Render may run several, so invalidating on
the container that handled the `PATCH` does nothing for the others.

**Better mitigation — skip the cache entirely.** Put the role in Supabase `app_metadata`, which
travels _inside the signed JWT_ and is server-controlled (users cannot edit it). `AuthContext.tsx`
L94–99 already documents this as safe but unused:

> `app_metadata.role` is server-controlled and safe to honor if present, but it is currently unused,
> so the backend profile is the source of truth.

With the role in the token, `requireAuth` needs **zero** database lookups once §4.1's local
verification lands — no cache, no TTL, no multi-container divergence, and one fewer round trip than
even the cached version.

Requirements:

- Write `app_metadata.role` via `auth.admin.updateUserById` wherever the role changes
  (`routes/profile.ts` L85 and the `become-trainer` route).
- Call `supabase.auth.refreshSession()` client-side afterwards, or the change waits for token expiry.
- Keep the `user_profiles` read as a fallback for tokens issued before the migration, and for
  `full_name` / `agency_name` if those are not worth putting in the token.

If that is more change than wanted now, the TTL cache remains acceptable — keep it at 30 s and
invalidate on both mutation routes.

### 11a.3 Compression (§2.1) touches binary and streaming paths

- **NDJSON war-room builds** (`socialCrisisWarroom.ts` L270–277, `warroom.ts` L389–395) use
  `res.write` + `res.flushHeaders()`. Compression buffers, which would stall stage-by-stage progress.
- **`tileProxy`** returns `image/png` buffers (L28–32); re-compressing them wastes CPU.
- **`Content-Length` is replaced by chunked encoding.** No client currently reads it; grep before
  shipping.

**Mitigation — no route list to maintain.** The streaming routes already set
`Cache-Control: no-transform` (`socialCrisisWarroom.ts` L272) — the standard HTTP header meaning
"do not compress me". Key the filter off it:

```js
app.use(
  compression({
    filter: (req, res) => {
      const cc = res.getHeader('Cache-Control');
      if (typeof cc === 'string' && cc.includes('no-transform')) return false;
      return compression.filter(req, res); // also skips images via `compressible`
    },
  }),
);
```

`warroom.ts` L389–395 does **not** set `no-transform` today — add it there so the filter covers both
streaming routes without hard-coding paths.

### 11a.4 Slimming the selects — consumer audit came back clean

I re-checked for consumers that would break, and found none beyond those already listed in §1:

- No server-side code consumes either list endpoint.
- `loadtest/session.ts` only POSTs and PATCHes sessions; it never reads the list.
- No script in `scripts/` or `demo_scripts/` consumes them.
- `ScenarioDetailView` refetches the full row by id (§1.4), so detail editing is unaffected.
- `engagementAlgorithmService` reads `scenarios.initial_state` **directly** server-side, not via the
  list endpoint, so the background engines are unaffected.

The one genuine dependency remains `ExpandedPoster`'s use of `initial_state.stakeholders` (§2.4).

### 11a.5 Optimistic auth render (§5.1) — the highest-risk item, restated

Flipping `loading` early without a separate `roleResolved` flag will bounce trainers off
role-gated pages on reload, because `ProtectedRoute`'s `roles` check (main.tsx L67) would run
against the least-privilege default. This is called out in §5.1; it is repeated here because it is
the single change most likely to cause a visible regression, and §4 (fast `/api/profile`) removes
most of its value. **Consider dropping §5.1 entirely** and keeping the gate.

### 11a.6 What these fixes do not address

- **`select('*')` will keep re-introducing this problem, unless something stops it.** Slimming two
  endpoints fixes two endpoints; every new query is one `select('*')` away from the same bug.
  **Revised 2026-09-24: moving the columns to side tables is not needed.** Postgres already stores
  large values out of line (TOAST): the `sessions` table's main storage is 128 kB with 7,016 kB held
  separately, and `scenarios` is 168 kB with 6,224 kB separate. A query that does not name those
  columns never reads them, so a side table would change almost nothing physically, while touching
  the 42 files that use `current_state` and the 24 that use `insider_knowledge`. The fix is a
  guardrail instead:
  1. Replace the remaining `select('*')` calls on these tables (seven in `server/routes/scenarios.ts`,
     plus the `scenarios(*)` embed in `sessions.ts` §2.3) with explicit column lists, keeping
     deliberate exceptions like the scenario detail endpoint.
  2. Add an ESLint `no-restricted-syntax` rule rejecting `.from('sessions' | 'scenarios').select('*')`.
     The pre-commit hook already runs ESLint on `server/` with `--max-warnings=0`, so a new offender
     cannot be committed.
- **The dashboard stats endpoint (§3.1) adds five count queries.** At current table sizes those are
  sub-millisecond, but they run on every dashboard load. If `sessions` grows to five figures,
  revisit with a cached or materialised counter.

## 12. Open questions for review

1. §2.4 — extend `summary` with a trimmed cast, or add a third peek endpoint?
2. §4.1 — migrate this project to asymmetric Supabase JWT keys, or add the legacy HS256 secret as
   an env var? Affects rotation story and setup cost.
3. §5.1 — is the optimistic-auth render worth its risk, or is a fast `/api/profile` (Phase 3) good
   enough? This is the one item that touches the authorization UI path.
4. §8.1 — hand-rolled cache now, or adopt TanStack Query properly?
5. Is the `limit=50` on the dashboard's session call (now removed by §3.1) relied on anywhere else,
   or was it purely for the stats?
6. **Answered 2026-09-24: no side tables.** Postgres already keeps these columns out of line, so the
   guardrail in §11a.6 (explicit columns plus a lint rule) gets the same benefit without a
   migration. The related growth problem, finished exercises accumulating in the live tables, is
   handled by the archive job in `simulation-runtime-performance-plan.md` §7a.5.
