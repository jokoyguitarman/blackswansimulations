# In-simulation performance — apps open fast, messages send instantly

**Owner:** unassigned (touches `server/routes/{socialMedia,socialMessenger}.ts`,
`server/services/{sopCheckerService,statementWatchdogService}.ts`,
`frontend/src/components/SimDevice/*`, `frontend/src/hooks/useRealtime.ts`,
`frontend/src/components/Chat/ChatInterface.tsx`, plus migrations for §1.1a and §7a).
**Status:** v1 plan, 2026-09-22; revised 2026-09-23 and 2026-09-24. **Stage 1 shipped 2026-09-24**
(commit `40b9e8a`, migrations 213–214); see "Stage 1 — shipped" below. The 2026-09-24 revision adds §0.15–§0.20 (capacity, what fills the
database, and queries that read finished exercises' data) and a new **§7a / Phase 8**, which is how
to avoid a Supabase compute upgrade.
**Goal:** a device app opens with content in well under 200 ms warm, with no multi-second cold
stall; a sent message or post appears on screen in the same frame the user hits send.
**Companion:** `docs/app-load-performance-plan.md` covers pre-simulation load (scenario/session
cards, bundle, auth). §3 of this plan (compression) and §6 (per-request auth cost) **overlap with
that document** — do not implement twice.
**Measured against:** production Supabase project `umnutnosxiypbnzpqszk` (PostgreSQL 17.6). Whole
database 1,764 MB on a server with roughly 1 GB of RAM (inferred, §0.15); overall cache hit rate
99.94%. `social_posts` = 220,372 rows / 212 MB across 103 sessions; busiest session = 54,865
posts; `notifications` = 89,259 rows / 59 MB; `chat_messages` = 40,814 rows / 15 MB;
`sim_emails` = 1,529 rows / 4 MB.

---

## Stage 1 — shipped 2026-09-24

**The feed stall had a simpler root cause than §1.0 assumed.** `social_posts.country` had **no
planner statistics**: migration 202 added the column on 2026-09-20, after the table's last
auto-analyze (2026-08-31), and the 18,818 changes since then were below the 10% auto-analyze
threshold. With no statistics the planner guessed 286 rows for `country IS NULL` on the busiest
session (actual 54,865, 190× off) and picked the BitmapOr + Sort plan. A manual
`ANALYZE social_posts` (null fraction now 0.997) switched it to the ordered
`idx_social_posts_virality` walk, with the country filter still applied:

| Feed query, busiest session, country filter applied | Before     | After `ANALYZE` |
| --------------------------------------------------- | ---------- | --------------- |
| `limit 50`                                          | 1,067 ms   | 68 ms           |
| `select *`, `limit 1000` (the app's page size)      | 6.8 s §0.1 | 39 ms           |

`chat_messages` had two columns in the same state and was analyzed too; no other table has columns
without statistics. **Run `ANALYZE <table>` after any migration that adds a column queries filter
on.** §1.0 (visibility in SQL, keyset pagination) is still worth doing, but no longer urgent.

| Plan item    | What shipped                                                                                                                                                                                                                                  | Measured                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| §1.2         | Country filter skipped when the session has no country-scoped posts. The check is cached (a yes for good, a no for 30 s) and ordered by `country` so it stays on `idx_social_posts_country`; unordered, the planner scanned the table (1.4 s) | check: 2.3 ms                                                                               |
| §1.1a        | Migration 214 drops `idx_social_posts_algorithm_sort`                                                                                                                                                                                         | −25 MB; algorithm feed 4.7 ms on `idx_social_posts_virality`                                |
| §7a.1        | `idx_social_posts_session_created`                                                                                                                                                                                                            | watchdog oldest-100: 765 → 12.7 ms, discarded rows 104,364 → 1,095; chronological feed 4 ms |
| §7a.2        | `idx_social_posts_original_post` (partial)                                                                                                                                                                                                    | 16 kB                                                                                       |
| §7a.3        | `idx_session_events_session_type_created`                                                                                                                                                                                                     | type lookup, busiest session: 1,903 → 2.5 ms                                                |
| §5.1 + §9a.2 | Notification polls 15 s → 60 s safety net in both feed apps; the socket reconnects forever (1–30 s backoff with jitter) and fetches a fresh token on every attempt                                                                            | —                                                                                           |
| §0.13        | `useRealtime` and `ChatInterface` logging is dev-only                                                                                                                                                                                         | —                                                                                           |
| Waits        | 800 ms and 1,000 ms waits after posting removed (SocialFeedApp, OrgPageView); the player's own reply appears from the POST response; the mount double fetch is gone                                                                           | —                                                                                           |

**Deviation from §7a.1 and §7a.3:** the single-column `idx_social_posts_session_id` and
`idx_session_events_session` were **kept**. Deduplication holds them at 3.0 MB and 3.5 MB against
8.7 MB and 18 MB for the composites, and they remain the planner's choice for session-only lookups
(150,385 and 108,506 scans). Dropping them would move those lookups onto indexes 3–5× larger for a
negligible write saving.

**Residual risk:** socket.io does not retry a connection the server's auth middleware rejected. The
per-attempt token makes that rare (it now needs a signed-out user), but a manual reconnect on
`connect_error` would close it completely.

**Still open:** §1.0 feed function and §1.3 page size (Q2); §7a.5 archive (Q6, Q10); optimistic
send (§2); `recordPlayerAction` (Q5); watchdog scheduling (Q8); `days_ago` clamp (Q9); HomeScreen
badge over realtime (§5.1).

---

## 0. Why (evidence, not theory)

### 0.1 Opening a feed reads 30,706 rows to return 1,000

`GET /api/social/posts/session/:sessionId`, as the client calls it today
(`platform=x_twitter&limit=1000`), measured on the busiest session:

| Variant                                        | Execution time | Buffers                          | Plan                                      |
| ---------------------------------------------- | -------------- | -------------------------------- | ----------------------------------------- |
| As written, **cold cache**                     | **6,811 ms**   | 7,456 (7,357 **read from disk**) | BitmapOr → Bitmap Heap Scan → top-N sort  |
| As written, warm cache                         | 88 ms          | 7,456 (all cached)               | same                                      |
| Identical query **without the country filter** | 168 ms         | **2,670**, stops early           | Index Scan on `idx_social_posts_virality` |
| As written, `limit=50` (warm)                  | 78 ms          | 7,456 — **unchanged**            | same bitmap path                          |

The `.or('country.is.null,country.eq.<scope>')` added at `socialMedia.ts` L141 forces a `BitmapOr`
across `idx_social_posts_country`, which discards the purpose-built
`idx_social_posts_virality (session_id, virality_score DESC)`. Postgres must then materialise
**30,706 rows over 7,400 heap blocks**, discard 24,159 by filter, and top-N sort the remainder.

Two compounding details:

- **The planner is wrong by 94×.** It estimates `rows=325`; reality is 30,706. The `OR` destroys
  its selectivity estimate, so every downstream cost is mis-planned.
- **The LIMIT does not help.** Compare rows 1 and 4 of the table: dropping `limit` from 1000 to 50
  leaves buffer count _identical_ at 7,456, because the sort cannot begin until every matching row
  is in hand. **Pagination alone does not fix this.** This is the single most important nuance in
  this document.

I also tested rewriting the predicate as `coalesce(country,'~any~') IN ('~any~','Singapore')`:
**89 ms warm, 7,450 buffers, same Bitmap Heap Scan.** The rewrite does _not_ help, because the
planner still cannot push a non-equality country condition into an ordered index walk.

### 0.2 The predicate that costs 40× filters almost nothing

| Measure                                         | Value                      |
| ----------------------------------------------- | -------------------------- |
| Posts with a non-null `country`                 | **629 of 220,372 (0.29%)** |
| Sessions containing any country-scoped post     | **4 of 103**               |
| In the busiest session: `country IS NULL`       | 54,865 rows                |
| In the busiest session: `country = 'Singapore'` | **0 rows**                 |

So in the session that takes 6.8 s to open, the country predicate excludes **nothing at all**. It
exists for a multi-country feature (`resolveCountryScope`, L43–62, returns `getUserCountry()` for
players) that 96% of sessions never use.

### 0.3 The payload is ~1.4 MB per feed open, uncompressed

`limit=1000` is hard-coded client-side in three places:

| Caller                | Line | Request                                       |
| --------------------- | ---- | --------------------------------------------- |
| `SocialFeedApp.tsx`   | 376  | `?platform=x_twitter&limit=1000`              |
| `FacebookFeedApp.tsx` | 339  | `?platform=facebook&limit=1000`               |
| `OrgPageView.tsx`     | 136  | `?limit=500&sort=chronological&author_type=…` |

The server default is `limit = 50` (`socialMedia.ts` L120) — the client overrides it 20×. At an
average 1,399 bytes per row that is ~1.4 MB per feed open, and 1,000 React nodes to render. There
is still **no compression middleware** on the server (same gap as `app-load-performance-plan.md`
§0.4), so it crosses the wire raw.

### 0.4 Row shape is already lean — do NOT bother with projections here

Unlike `scenarios` / `sessions`, `social_posts` has no fat JSONB column. Largest contributors per
row: `content` 220 B, the uuid/timestamp columns ~34–38 B each, `content_flags` 22 B. Total ~1,399 B.

**The lever here is row count, not column count.** Explicitly out of scope: narrowing `select('*')`
on this endpoint. It would buy almost nothing.

### 0.5 A serial fifth query with a 1,000-element `IN` list

`socialMedia.ts` L160–173 correctly batches four queries into one `Promise.all`. Then L226–229 runs
a **fifth query afterwards, serially**:

```
supabaseAdmin.from('social_post_likes').select('post_id, reaction_type').in('post_id', postIds)
```

With `limit=1000`, `postIds` holds up to 1,000 UUIDs — roughly a **37 kB URL** to PostgREST. That
is both an avoidable serial round trip and a real risk of hitting URL-length limits.

### 0.6 Sending a Messenger DM shows the user nothing for three round trips

`FacebookMessengerView.handleSend` (L266–301):

```
setNewMessage('');                                  // input clears immediately
const res = await fetch(POST /api/social/messenger/send);   // round trip 1 — user sees nothing
if (res.ok) { fetchMessages(selectedThread); fetchThreads(); }  // round trips 2 and 3
```

There is **no optimistic message**. The typed text vanishes and nothing replaces it until the POST
plus a refetch complete. Worse, the server **already broadcasts** `messenger.received` over the
WebSocket (`socialMessenger.ts` L247–251), and this component already subscribes via
`useWebSocket` — so both refetches re-fetch what is about to arrive anyway.

`openThread` (L340–343) and `goBack` (L345–348) both call `setMessages([])`, blanking the thread
while it reloads.

### 0.7 The pattern is inconsistent, not uniformly missing

| Surface                                 | Optimistic?                                    | Realtime?                  | Feels      |
| --------------------------------------- | ---------------------------------------------- | -------------------------- | ---------- |
| TeamChat (`ChatInterface.tsx`)          | **Yes** — temp-id insert + reconciliation      | Supabase Realtime          | Instant    |
| Post flag (`SocialFeedApp` L814–835)    | **Yes** — with rollback on error               | n/a                        | Instant    |
| Post / reply (`SocialFeedApp` L609–661) | No — waits for POST, then inserts server's row | WebSocket                  | Laggy      |
| Messenger DM (`FacebookMessengerView`)  | **No**                                         | WebSocket (unused on send) | Laggy      |
| Org-page comment (`OrgPageView`)        | **No** — `setTimeout(loadPage, 1000)`          | None                       | Very laggy |

The good pattern already exists in the codebase twice. It simply has not been applied to the
send paths that matter most.

### 0.8 Roughly a second of deliberate, hard-coded lag per interaction

| File                | Line               | Delay                                                          |
| ------------------- | ------------------ | -------------------------------------------------------------- |
| `SocialFeedApp.tsx` | 656                | `setTimeout(() => openThread(...), 800)` after posting a reply |
| `OrgPageView.tsx`   | 204                | `setTimeout(loadPage, 1000)` after commenting                  |
| `OrgPageView.tsx`   | 245                | `setTimeout(() => openComments(...), 800)`                     |
| `ShareMenu.tsx`     | 100, 125, 143, 197 | `setTimeout(onClose, 1200)` ×4                                 |

These are pure waiting — presumably inserted to let the server settle before a refetch. With
optimistic updates they become unnecessary.

### 0.9 Serial server work before a send responds

A DM send pays, in order:

1. `requireAuth` — `supabaseAdmin.auth.getUser(token)` (outbound HTTP) **then** a `user_profiles`
   select. Two network round trips on every request. (See `app-load-performance-plan.md` §0.7 —
   fix once, benefits both.)
2. `getControlledOrgPage` query, when sending as a page (L171).
3. Existing-thread lookup (L182–190).
4. Shared-post lookup, when forwarding (L196–200).
5. The insert (L224–240).
6. WebSocket broadcast (L247).
7. **`await recordPlayerAction(...)` (L253)** — which is itself _two_ more queries:
   `getPlayerTeamName()` then an insert (`sopCheckerService.ts` L119–146).
8. Respond 201 (L290).

Step 7 is pure telemetry the client never reads. It has no reason to be on the critical path.

### 0.10 What is already correct — do NOT "fix" these

- **All expensive AI work is properly fire-and-forget.** Post grading (`socialMedia.ts` L513),
  media generation (L633), NPC DM replies (`socialMessenger.ts` L255–288), NPC email replies
  (L1372) all use `void (async () => …)`.
- **The 3–10 s NPC reply delay** (`socialMessenger.ts` L279) is deliberate realism, not latency.
- **`social_post_likes` / `social_post_flags`** are queried per-player without a session filter,
  which looks alarming, but the tables hold **140 and 147 rows total**. Harmless. Do not spend
  time here.
- Engagement counts already stream over WebSocket (`social_posts.engagement_update`).

### 0.11 Polling stacked on top of working realtime

| Component             | Interval     | What it polls              | Already has realtime? |
| --------------------- | ------------ | -------------------------- | --------------------- |
| `TrainerSimDashboard` | 12 s (L1347) | `loadAll()` — everything   | Yes                   |
| `TeammateConsole`     | 10 s         | teammate state             | No                    |
| `SocialFeedApp`       | 15 s (L436)  | notifications, `limit=100` | **Yes**               |
| `FacebookFeedApp`     | 15 s (L433)  | notifications, `limit=100` | **Yes**               |
| `HomeScreen`          | 15 s (L227)  | badge counts, `limit=100`  | **No**                |
| `AdversaryConsole`    | 15 s         | adversary state            | No                    |
| `ZDesktopLayout`      | 15 s         | trending / suggested       | No                    |
| `WordApp/useDrafts`   | 15 s         | draft list                 | No                    |

`notifications` is 89,259 rows / 59 MB and is polled at `limit=100` every 15 s **per player, per
open app** — plus `DeviceShell` L207 (`limit=50`) and two more one-shot fetches in each feed app.

### 0.12 Nothing caches across app switches, and one app double-fetches

Every device app remounts on navigation and refetches cold. There is no cache layer (same finding
as `app-load-performance-plan.md` §0.12).

`SocialFeedApp` is worse: L390–402 calls `loadPosts()` on mount, and L404–406 is a _second_ effect
that calls `loadPosts()` again whenever `location.pathname` includes `/social`. Navigating into the
app can therefore fire the 6.8 s query **twice**.

### 0.13 Console logging on the realtime hot path

| File                 | `console.*` calls | Guarded by `import.meta.env.DEV` |
| -------------------- | ----------------- | -------------------------------- |
| `ChatInterface.tsx`  | **67**            | 1                                |
| `useRealtime.ts`     | **15**            | **0**                            |
| `websocketClient.ts` | 9                 | 1                                |

`useRealtime` logs on every subscription status change **and every INSERT event**, with object
payloads. `ChatInterface` logs several times per message received. In a busy session this is real
main-thread cost, and DevTools retains every logged object.

### 0.14 Apps with no realtime at all

`HomeScreen`, `OrgPageView`, `GroupChatApp`, `ZDesktopLayout`, `DesktopShell`,
`FacebookEventsView`, `FacebookGroupsView`, `WordApp`, `SheetsApp`, `NotificationCenter`,
`PlayerActivityPanel`. These are either polling or entirely static until remount.

`EmailApp.loadEmails` (L282–291) fetches **all** session emails with no limit at all. `sim_emails`
is only 1,529 rows today so it is not yet a problem, but it is unbounded by construction.

### 0.15 Capacity: the server is not short of memory yet (added 2026-09-24)

The question behind this section: do we need a bigger Supabase compute size? Measured answer:
**not yet.**

| Measure                    | Value      | Meaning                                                                                                                 |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `shared_buffers`           | 256 MB     | Postgres's own page cache                                                                                               |
| `effective_cache_size`     | 768 MB     | Normally set to ~75% of RAM, so the server has **roughly 1 GB** (inferred; the Supabase dashboard shows the exact size) |
| Whole database             | 1,764 MB   | Does not all fit in memory at once                                                                                      |
| **Overall cache hit rate** | **99.94%** | 1,725,322,171 page hits vs 984,370 disk reads since stats began. Supabase's healthy threshold is >99%                   |

Per table (sorted by pages read from disk):

| Table                        | Table hit rate | Index hit rate | Pages read from disk |
| ---------------------------- | -------------- | -------------- | -------------------- |
| `session_events`             | 99.57%         | 99.69%         | **389,754**          |
| `social_posts`               | 99.91%         | 99.87%         | 215,943              |
| `session_escalation_factors` | 93.88%         | 98.84%         | 52,384               |
| `post_engagement_log`        | 96.81%         | 99.87%         | 26,465               |
| `notifications`              | 99.72%         | 99.81%         | 18,458               |
| `scenario_state_history`     | 94.68%         | 99.62%         | 3,738                |

An average hides spikes: the 6.8 s cold feed open in §0.1 is real. But the server as a whole is
coping, and the work in this plan shrinks the working set further. **Decision rule:** upgrade only
if the cache hit rate in Supabase's database report falls below 99%, not before (§7a.0).

### 0.16 What actually fills the database (added 2026-09-24)

`social_posts` is not the largest table. The per-exercise history tables are, and **every row
checked in every one of them belongs to an exercise that has already ended**:

| Table                        | Size   | Rows from finished exercises |
| ---------------------------- | ------ | ---------------------------- |
| `scenario_state_history`     | 319 MB | 40,379 of 40,379             |
| `social_posts`               | 212 MB | 220,372 of 220,372           |
| `session_escalation_factors` | 167 MB | 56,437 of 56,437             |
| `session_events`             | 151 MB | 327,093 of 327,093           |
| `session_pathway_outcomes`   | 116 MB | 20,797 of 20,797             |
| `post_engagement_log`        | 51 MB  | 254,915 of 254,915           |

- `scenario_state_history` stores a full `state_snapshot` (**~16.9 KB average**) on every state
  change (`scenarioStateService.ts` L138) plus a completion snapshot (L557). It is read in exactly
  one place, the after-action review (`aar.ts` L779).
- **Growth**, in posts per month: April 26 · May 10,433 · June 66,477 · July 81,275 ·
  August 58,661 · September 3,500 (to the 24th). Heavy months add roughly 60–80 MB to
  `social_posts` alone (estimated from ~0.96 KB per post, indexes included).
- **Old and new posts share disk pages.** The busiest session's 54,865 posts sit on 7,400 of the
  table's 17,138 pages, and **those same pages also hold 25,062 posts from other sessions (31%)**.
  Reading one session therefore drags in other sessions' rows. Archiving (§7a.5) removes that.
- Static reference data is also large (`osm_sg_roads` 150 MB, `osm_sg_buildings` 140 MB), but it
  is only read by map features and is not part of this problem.

### 0.17 Queries that read every finished exercise to find the current one (added 2026-09-24)

`pg_stat_statements` shows which queries touch the most pages. The worst on `social_posts` is the
statement watchdog loading "all prior player statements, oldest first"
(`statementWatchdogService.ts` L306–312):

```ts
.from('social_posts')
.select('content, created_at, author_handle, author_type')
.eq('session_id', sessionId)
.in('author_type', ['official_account', 'player'])
.order('created_at', { ascending: true })
.limit(100);
```

**2,800 calls, averaging 26,348 pages per call.** Replayed:

| Session                    | Plan                                            | Rows read and discarded | Pages                        | Time       |
| -------------------------- | ----------------------------------------------- | ----------------------- | ---------------------------- | ---------- |
| Newest (401 posts)         | BitmapAnd on session + author type              | —                       | 52                           | 5 ms       |
| **Busiest (54,865 posts)** | **Index Scan on `idx_social_posts_created_at`** | **104,364**             | **85,545** (5,175 from disk) | **576 ms** |

For a large session, Postgres walks the **table-wide** `created_at` index from the oldest post ever
written, discarding every other session's posts until it has found 100 matches. So the query reads
finished exercises' data to answer a question about the current one, and **it gets slower with
every exercise added**, because the history in front of the current exercise keeps growing. There
is no `(session_id, created_at)` index for it to use instead.

About 20 other places fetch `social_posts` or `session_events` oldest-first (`aar.ts` ×5,
`aarSocialMediaService` ×2, `aarSocialSectionService` ×2, `aiInjectSchedulerService`,
`ambientContentService`, `injectTriggerService`, `playerLedgerService`, `socialStateUpdaterService`,
plus reply lookups). The reply lookups are fine, because `idx_social_posts_reply_to` narrows them to
one post. The others share the watchdog's shape and should be re-checked after §7a.1 lands.

### 0.18 Why "only rows since the session started" is not a safe fix for posts (added 2026-09-24)

Adding a start-time condition to the watchdog query measures well: **10.7 ms and 1,261 pages
instead of 576 ms and 85,545.** That shows the size of the prize, but it would change results:

| Table            | Rows dated before their own session was created       | Author types                                             | How far back      |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| `social_posts`   | **2,681 across 82 sessions**                          | 2,458 `official_account`, 171 `npc_public`, 52 other NPC | up to **30 days** |
| `session_events` | **0** (72 created before `start_time`, in 3 sessions) | —                                                        | —                 |

The backdating is deliberate. `ambientContentService.ts` L402–425 seeds each organisation's
"branded history" at `startTime - days_ago × 24 h`, with `days_ago` of 1–30 supplied by the
generator prompts (`socialCrisisGeneratorService.ts` L1958, L2099; `pressureOrgGenerationService.ts`
L130). The watchdog reads `official_account` posts, so a start-time bound would **silently hide the
seeded page history from it.** Note also that `days_ago` is not clamped in code
(`Number(post.days_ago) || 7`), so a generator could exceed 30 days.

**Conclusion:** fix posts with an index (§7a.1), not a time bound. For `session_events`, a bound on
the session's `created_at` is safe (no event predates its session), but the composite index in
§7a.3 makes it unnecessary.

### 0.19 The events table sweeps every session's events of a type (added 2026-09-24)

`session_events` is the table read most from disk (389,754 pages, §0.15). It has only
single-column indexes, `(session_id)` and `(event_type)`, while its heaviest queries filter on
**both**:

| Query shape (from `pg_stat_statements`)                                  | Calls         | Pages per call |
| ------------------------------------------------------------------------ | ------------- | -------------- |
| `session_id = ? and event_type = ? and metadata->>? ilike ?` (+ a count) | 16,125        | 2,915          |
| `session_id = ? and event_type = ?`                                      | 32,610        | 767            |
| `session_id = ? and event_type = ?`, ordered by `created_at`             | 3,586 + 3,584 | ~1,700         |

The planner answers these with a BitmapAnd of the two indexes. The `event_type` half spans every
session ever: replayed on the busiest session, it pulled **70,767** entries of one event type from
all sessions to intersect with that session's 84,807 events.

### 0.20 Deleting a post scans the whole posts table (added 2026-09-24)

`social_posts.original_post_id` (the link from a repost to its original) is a foreign key
(`social_posts_original_post_id_fkey`) with **no index**. On every post deletion, Postgres must check
whether any repost points at it, and without an index it scans the table to do so.

| Statement                                     | Calls | Mean time  | Pages per call |
| --------------------------------------------- | ----- | ---------- | -------------- |
| `DELETE FROM social_posts WHERE id = ANY($1)` | 28    | **902 ms** | **169,157**    |

This is very likely also where the table's 1,416 recorded full scans come from. The other
foreign-key columns involved are already indexed: `reply_to_post_id`,
`social_post_likes.post_id`, `social_post_flags.post_id`, and `post_engagement_log.post_id`.
**This must be fixed before any archive job (§7a.5), which deletes in bulk.**

---

## 1. Phase 1 — The feed query (the whole ballgame)

**Revised twice. Read §1.0 first — it supersedes the structure of §1.1–§1.3.**

### 1.0 The answer is one database function, and it is measured

Three separate investigations converged on the same conclusion: the feed endpoint should become a
single Postgres function called over RPC. Doing the visibility filter in SQL **and** dropping the
country predicate, measured against the busiest session (54,865 posts):

| Variant                                                  | Time        | Buffers   | Plan                  |
| -------------------------------------------------------- | ----------- | --------- | --------------------- |
| Today, cold                                              | 6,811 ms    | 7,456     | BitmapOr → Sort       |
| Today, warm                                              | 88 ms       | 7,456     | BitmapOr → Sort       |
| **Visibility in SQL + no country predicate, `limit=50`** | **30.1 ms** | **1,203** | `Index Scan`, no Sort |
| Same, with case-insensitive race match (§1.0c)           | **4.8 ms**  | **1,203** | `Index Scan`, no Sort |

Returning 50 rows that are **all genuinely visible to the player** — 1,080 removed by filter, early
stop. No new index. `idx_social_posts_virality` does the work.

**What one function resolves, that five separate patches did not:**

| Problem                        | Why the function fixes it                                               |
| ------------------------------ | ----------------------------------------------------------------------- |
| §0.1 / §0.2 bad plan           | We control the SQL; no PostgREST `.or()` to confuse the planner         |
| §1.3a visibility after `LIMIT` | Filter is part of the `WHERE`, so `LIMIT` applies to visible rows       |
| §1.3a wrong `count`            | `count` is computed over the filtered set                               |
| §0.5 the 1,000-UUID `IN` list  | Reactions join inside SQL; no URL list at all                           |
| §1.3b unstable pagination      | Keyset / snapshot ranking is trivial inside a function, awkward outside |
| 5 serial round trips           | One call                                                                |

#### 1.0a The visibility rule is expressible in plain SQL

The JavaScript at L204–221 looks generic — arbitrary keys, arrays, nested matching. The **data is
far simpler**, which is what makes this tractable:

| Column                | Declared as                            | Actual shape in production                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------ |
| `target_player_ids`   | `uuid[]` (native array, **not** jsonb) | plain `= any(...)` works                               |
| `target_demographics` | `jsonb`                                | only ever one key, `race`; **3,653 strings, 0 arrays** |

```sql
-- mirrors socialMedia.ts L204-221, with the §1.0c casing fix applied
is_surfaced_to_session
or (target_player_ids is not null and :uid = any(target_player_ids))
or (target_player_ids is null and target_demographics is null)
or (target_player_ids is null and target_demographics is not null
    and lower(target_demographics->>'race') = lower(:player_race))
```

Preserve the remaining JS semantics exactly: staff bypass the filter entirely; a player with **no**
`demographics` row sees everything; an **empty** `target_player_ids` array hides the post from
everyone but staff (JS treats `[]` as truthy, then `[].includes()` is false — `= any('{}')` matches
that).

#### 1.0b Keyset pagination, decided

Offset pagination is unusable here (§1.3b) because `virality_score` is rewritten every 30 s. Inside
the function, pass the last-seen `(virality_score, id)` and continue from there:

```sql
and (:after_score is null or (p.virality_score, p.id) < (:after_score, :after_id))
order by p.virality_score desc, p.id desc
```

This needs `id` as a tiebreaker in the `ORDER BY` for a total order. Note that makes the sort
`(virality_score DESC, id DESC)` while `idx_social_posts_virality` is `(session_id,
virality_score DESC)` — **verify during implementation** that the planner still does an ordered walk
rather than re-sorting. If it does not, the tiebreaker may need to move into the index, which is the
one scenario where a migration comes back into scope.

#### 1.0c Demographic matching becomes case-insensitive — quantified

Per review decision this is fixed in the same change rather than deferred. The impact is small
enough to make that safe:

| Measure                        | Value                   |
| ------------------------------ | ----------------------- |
| Distinct target races          | 20 (18 when lowercased) |
| Players affected by the fix    | **4 of 155**            |
| Total post-views newly visible | **15**                  |
| Worst single player            | gains 10 posts          |

Every target race already matches _some_ player case-sensitively, so nothing is currently orphaned
wholesale — the bug bites individual players whose race was recorded as `Chinese` against posts
targeting `chinese`. Performance cost of `lower()` on both sides: **none** (4.8 ms vs 30.1 ms, same
plan, same 1,203 buffers — it is an inline filter on rows already being examined).

**This is a deliberate behaviour change.** Slightly more content becomes visible to a handful of
players. Call it out in the release note rather than letting it look like a regression.

#### 1.0d Keep the country predicate available, just not always applied

The function should accept an optional country scope and apply it **only when non-null**. §1.2
remains correct: `resolveCountryScope` should return `null` when the session has no country-scoped
posts, which is 99 of 103 sessions.

**Still unresolved for the 4 country-using sessions.** They genuinely need the predicate and would
keep the bad plan. Inside a function you have options unavailable to PostgREST — split into two
`UNION ALL` branches with equality predicates, or `country is null or country = :scope` written so
the planner can still walk the index. **Test against one of those 4 sessions before declaring done.**

### 1.1 (superseded) The right index already exists — the planner just isn't choosing it

**Retained for the evidence. §1.0 is the plan; no new index is needed.**

**Revised 2026-09-23 after further measurement. An earlier draft of this plan proposed adding a new
composite index. That was wrong, and adding it is no longer recommended.** The evidence:

Forcing an ordered walk on the **existing** `idx_social_posts_virality (session_id, virality_score
DESC)`, with the country predicate left in place and applied inline:

```sql
set local enable_bitmapscan = off; set local enable_sort = off;
-- (same feed query as §0.1)
```

| Plan                                                   | Time        | Buffers            | Sort node |
| ------------------------------------------------------ | ----------- | ------------------ | --------- |
| Bitmap path (what runs today), cold                    | 6,811 ms    | 7,456 (7,357 read) | Yes       |
| Bitmap path, warm                                      | 88 ms       | 7,456              | Yes       |
| **Ordered walk on the existing index, country inline** | **81.7 ms** | **2,669 + 109**    | **None**  |

The index walk removes only 1,741 rows by filter and stops at 1,000. **No new index is needed.**

**So what is actually broken?** The planner's row estimate. It predicts `rows=325`; reality is
30,706 — a 94× underestimate caused by the `country IS NULL OR country = ?` predicate defeating
selectivity estimation. With a cost model that badly wrong, it picks the bitmap path.

I confirmed the planner is genuinely confused rather than merely unlucky: disabling only
`enable_bitmapscan` makes it choose `idx_social_posts_platform` and filter 94,132 rows —
**5,557 ms, worse than today.** It will not find the good plan on its own.

**Therefore the primary fix is §1.2, not an index.** Removing the `OR` when the session has no
country-scoped content lets the planner correctly pick the ordered walk with no hints at all
(measured: 168 ms, 2,670 buffers). §1.2 is promoted from "belt-and-braces" to **the fix**.

#### 1.1a Index hygiene (separate from the fix, do not conflate)

While measuring, `pg_stat_user_indexes` turned up real waste on this table. `social_posts` carries
**16 indexes — 78 MB of index against 134 MB of heap (58%)**:

| Index                                | Scans  | Size      | Verdict                                 |
| ------------------------------------ | ------ | --------- | --------------------------------------- |
| `idx_social_posts_target_player_ids` | **0**  | 872 kB    | Dead — but see below                    |
| `idx_social_posts_surfaced`          | **0**  | 16 kB     | Dead — but see below                    |
| `idx_social_posts_shared_article`    | **0**  | 16 kB     | Dead, droppable                         |
| `idx_social_posts_algorithm_sort`    | 14,404 | **25 MB** | Redundant — see below                   |
| `idx_social_posts_virality`          | 16,842 | 17 MB     | **Keep — this is the one that matters** |

- `idx_social_posts_virality (session_id, virality_score DESC)` is a strict **prefix** of
  `idx_social_posts_algorithm_sort (session_id, virality_score DESC, created_at DESC)`. Only one
  query in the codebase orders by `virality_score` (`socialMedia.ts` L155) and it does **not** use
  `created_at` as a tiebreaker, so the longer index's third column earns nothing. Dropping
  `idx_social_posts_algorithm_sort` reclaims 25 MB.
- **Why this matters beyond disk:** `engagementAlgorithmService` L330–360 rewrites
  `virality_score` for every top-level post from the last 45 minutes, one `UPDATE` at a time, every
  30 s (`env.injectSchedulerIntervalMs`). Every one of those updates must maintain _both_ virality
  indexes. Dropping one halves that write cost.
- **Do not drop the two zero-scan targeting indexes yet.** `idx_social_posts_surfaced` and
  `idx_social_posts_target_player_ids` exist for exactly the visibility predicate that §1.3a moves
  into SQL. They are unused _because_ that filter currently runs in JavaScript. Fix §1.3a first,
  then re-check their scan counts.

Treat 1.1a as a **separate, reviewed migration** from the query fix, so a regression in either can
be reverted independently.

### 1.2 Drop the country predicate when the session does not use it

Independent of the index, and a useful belt-and-braces: `resolveCountryScope` should return `null`
when the session has no country-scoped posts, which removes the `.or()` entirely for 99 of 103
sessions. Cache the answer per session (the existing `injectCountCache` / `scenarioCache` patterns
apply) so this does not add a query per request.

**Acceptance:** multi-country sessions still scope correctly; single-country sessions issue a query
with no `.or()` clause at all.

### 1.3a BLOCKER — the visibility filter must move into SQL _before_ anything is paginated

**Status: RESOLVED by §1.0a**, which gives the exact SQL and confirms it performs (30.1 ms,
1,203 buffers). The analysis below is retained because it is the reason §1.0 exists.

**§1.3 must not ship without §1.0. Doing so would introduce a user-visible bug.**

`socialMedia.ts` applies the `LIMIT` in SQL at L158, then filters the returned rows **in JavaScript**
at L204–221 on `is_surfaced_to_session`, `target_player_ids` and `target_demographics`.

Measured on the busiest session (`platform=x_twitter`, not removed):

| Measure                                        | Value           |
| ---------------------------------------------- | --------------- |
| Candidate posts                                | 30,706          |
| `is_surfaced_to_session`                       | **0**           |
| Has `target_player_ids`                        | 1,160           |
| Has `target_demographics`                      | 368             |
| **Would be filtered out for a typical player** | **1,528 (≈5%)** |

Consequences of filtering after the limit:

- **At `limit=1000`** roughly 50 rows silently disappear per request. Nobody notices.
- **At `limit=50`** each page loses 2–3 rows, so **pages come back different sizes** and infinite
  scroll stutters or appears to skip content.
- **`count` is the pre-filter count** (it comes from the `{ count: 'exact' }` on the paginated
  query, before `filteredData`). Any "are there more pages" or `totalPages` logic built on it is
  **wrong by construction**.
- A player whose page happens to be mostly targeted content could receive a near-empty page while
  plenty of visible content exists further down.

**Required before §1.3:** express the visibility rule as SQL so the `LIMIT` applies to _visible_
rows. Roughly `is_surfaced_to_session or target_player_ids @> [user] or (targeting is null) or
<demographic match>`, with trainers/admins bypassing it. The demographic match is the awkward part —
it compares a JSONB object against the player's `demographics`, so it may need a SQL helper function
or a precomputed visibility column.

**Bonus:** this is what makes `idx_social_posts_surfaced` and the GIN
`idx_social_posts_target_player_ids` useful. Both currently show **zero scans** precisely because
the filter runs in JavaScript (see §1.1a).

**Also note:** the client currently ignores `count` entirely (no pagination exists today), so this
is greenfield work, not an adjustment.

### 1.3b Sorting by a column the engine constantly rewrites makes pagination unstable

**Status: RESOLVED by §1.0b** — keyset pagination on `(virality_score, id)` inside the function.
One implementation check remains: confirm the planner still walks the index with `id` added as a
tiebreaker. The analysis below is retained as the rationale.

`virality_score` is rewritten every 30 s for every post from the last 45 minutes (§1.1a). Offset
pagination over a volatile sort key means **a post can move between page 1 and page 2 while the
player scrolls**, producing duplicates or skipped items.

The existing `frozenOrder` / `pendingCount` mechanism (`SocialFeedApp` L355–369) freezes the order
against _new arrivals_ — it does **not** protect against _reordering of rows already fetched_.

Options: keyset pagination on a stable key (`created_at`, or `(virality_score, id)` captured at
first page load), or freeze a ranking snapshot server-side for the duration of a scroll session.
**Decide this before building infinite scroll**, because it determines the API shape.

### 1.3 Bring the page size back to something sane

**Do not start this until §1.3a and §1.3b are resolved.**

Change the three callers in §0.3 from 1000/500 to **50**, matching the server default, and add
infinite scroll or a "load older" control.

- Sequencing note: the feed already has a `frozenOrder` / `pendingCount` mechanism
  (`SocialFeedApp` L355–369) for holding scroll position while new posts arrive. Pagination must
  cooperate with it rather than fight it — read that code before changing the fetch.
- With `limit=50` the §0.5 `IN` list drops from 1,000 UUIDs to 50, which removes that fragility as
  a side effect.
- **Expected:** ~1.4 MB → ~70 kB per open; 1,000 React nodes → 50.

**Acceptance:** feed opens showing the same top-ranked posts; scrolling loads more without
duplicates or reordering; the "new posts" pill still behaves.

### 1.4 Fold the fifth query into the batch

Move the L226–229 reactions query into the existing `Promise.all` at L160–173. It depends on
`postIds`, which is derived from the posts result — so either accept it as a second batch, or
restructure to fetch reactions by `session_id` instead of by a 1,000-element post-id list.
Fetching by session is the cleaner fix and removes the dependency entirely.

### 1.5 Remove the double fetch

Reconcile the two effects at `SocialFeedApp` L390–402 and L404–406 so opening the app fetches once.

---

## 2. Phase 2 — Make sending feel instantaneous

The goal is that the message appears in the same frame as the keypress. The pattern to copy already
exists in `ChatInterface.tsx` (temp-id insert, then reconcile by real id on the realtime event).

### 2.1 Optimistic send for Messenger

Rewrite `FacebookMessengerView.handleSend` (L266–301) to:

1. Insert a temp message into state immediately (`temp-<uuid>`, `pending: true`).
2. POST in the background.
3. Reconcile on the `messenger.received` WebSocket event, replacing the temp row by id.
4. On failure, mark the temp row failed with a retry affordance — do **not** silently drop it (the
   current `catch {}` swallows errors entirely).
5. **Delete both `fetchMessages()` and `fetchThreads()` from the success path.** The WebSocket
   broadcast at `socialMessenger.ts` L247 already delivers the message. Keep a thread-list update
   only for the last-message preview, and derive it locally rather than refetching.

Also remove the `setMessages([])` blanking in `openThread` and `goBack` — keep the previous
messages visible until the new ones land.

### 2.2 Optimistic post, reply, and comment

Same treatment for `SocialFeedApp.handlePost` (L609–661) and `OrgPageView`'s compose and comment
paths. `handlePost` currently waits for the POST and then inserts the server's returned row; it
should insert locally first and reconcile.

Note the existing dedup guard at L636–639 (`prev.some(p => p.id === createdPost.id)`) — the
optimistic path needs the same protection against the WebSocket event arriving first.

### 2.3 Delete the hard-coded delays

All of §0.8. With optimistic updates and realtime reconciliation they have nothing to wait for.
Verify each one individually: some may be masking a genuine ordering bug, in which case fix the
ordering rather than restoring the delay.

### 2.4 Reference: what "good" looks like

`ChatInterface.tsx`'s reconciliation is correct but **very** convoluted — content-matching against
three separate refs plus a timeout fallback (L378–539). When applying the pattern elsewhere, do
**not** copy it verbatim. Reconcile on a client-generated id echoed back by the server, which makes
matching exact and lets all the content-comparison logic disappear. Consider retrofitting
`ChatInterface` afterwards as a follow-up.

---

## 3. Phase 3 — Compression

Identical to `app-load-performance-plan.md` §2.1 — **implement once, in that plan.** Recorded here
only because it also multiplies every gain in this document.

Note the interaction: `socialCrisisWarroom.ts` L270–273 and `warroom.ts` L389–390 stream NDJSON and
must be excluded from compression.

---

## 4. Phase 4 — Trim serial work off the send path

### 4.1 Stop awaiting telemetry

`socialMessenger.ts` L253: change `await recordPlayerAction(...)` to fire-and-forget, matching how
the NPC reply directly below it is already handled. Same audit across the other send handlers —
grep for `await recordPlayerAction` and assess each.

Caveat: fire-and-forget means a failed insert is invisible. `recordPlayerAction` already logs its
own errors (`sopCheckerService.ts` L143), so this is acceptable, but confirm nothing downstream
(AAR scoring, SOP checking) assumes the row exists before the response returns.

### 4.2 Collapse the lookups

The thread lookup (L182–190), org-page lookup (L171) and shared-post lookup (L196–200) are
independent of each other and can run in one `Promise.all`.

### 4.3 Per-request auth cost

`requireAuth`'s two round trips are the largest fixed cost on every action in a session. Fixed by
`app-load-performance-plan.md` §4 — **implement there.** Note it is worth more in-simulation than
pre-simulation, because a session fires many small requests.

---

## 5. Phase 5 — Polling and realtime hygiene

### 5.1 Drop polls that duplicate realtime

`SocialFeedApp` and `FacebookFeedApp` already receive `notification.created` over WebSocket and
increment their counters from it (L600–605). The 15 s `limit=100` notification poll is redundant —
remove it, keeping one fetch on mount to establish the baseline count.

`TrainerSimDashboard`'s 12 s `loadAll()` should become event-driven, or at minimum reload only the
panels whose events fired.

### 5.2 Add realtime where there is none

`HomeScreen` badge counts are the most visible gap (§0.14) — the player sees a stale badge for up
to 15 s. It can subscribe to the same `notification.created` event the feed apps already use and
drop its poll entirely.

### 5.3 Bound `EmailApp`

Give `loadEmails` an explicit limit with pagination before `sim_emails` grows.

---

## 6. Phase 6 — Cache across app switches

Device apps remount on every navigation. Applying the same stale-while-revalidate approach as
`app-load-performance-plan.md` §8.1 — render last-known content instantly, revalidate behind it —
is what turns "app opens fast" into "app opens instantly" on the second visit.

Scope per `(sessionId, appId)` and clear on session exit. Realtime events must write into the cache,
not just component state, or a cached open will show stale content until revalidation lands.

---

## 7. Phase 7 — Logging hygiene

Gate or delete the §0.13 logging. `useRealtime.ts` (15 calls, 0 guards) is the priority since it
fires per event. `ChatInterface.tsx`'s 67 calls should be reduced to a handful behind
`import.meta.env.DEV`.

Cheap, zero-risk, and measurable on a busy session's main-thread profile.

---

## 7a. Phase 8 — Stop reading finished exercises' data, instead of upgrading compute (added 2026-09-24)

This phase answers "can we avoid a bigger Supabase plan?" **Yes, for now.** Memory is not short
overall (§0.15). The waste comes from specific queries that read finished exercises' data (§0.17,
§0.19, §0.20). Fix those first, and archive finished exercises when convenient.

### 7a.0 Capacity decision

- **No compute upgrade now.** Cache hit rate is 99.94% against a >99% healthy threshold.
- Monitor it in Supabase's database report, or directly:

  ```sql
  select round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) as cache_hit_pct
  from pg_stat_database where datname = current_database();
  ```

- **Upgrade trigger:** the hit rate stays below 99%, or cold feed opens are still slow after §1.0
  and §7a.1–§7a.3 have landed.
- The counters behind that query have never been reset, so it reports a **lifetime** average. To
  see recent behaviour, save `blks_hit` and `blks_read` weekly and compute the rate over the
  difference. Do not use `pg_stat_reset()` for this, because autovacuum relies on the same
  statistics (§9a.7).

### 7a.1 Index `social_posts (session_id, created_at)`, replacing `idx_social_posts_session_id`

```sql
create index concurrently if not exists idx_social_posts_session_created
  on public.social_posts (session_id, created_at);

-- only after confirming the planner uses the new index where it used the old one:
drop index concurrently if exists idx_social_posts_session_id;
```

- **Why:** it gives "this session's posts in time order" a direct path, so the watchdog (and the
  other oldest-first queries in §0.17) stop walking the table-wide `created_at` index through every
  finished exercise. Unlike a start-time bound, it still finds the seeded branded history (§0.18).
- **Net index count unchanged.** The composite index has the same leading column, so it serves
  every query the single-column `(session_id)` index serves today (150,384 scans). Together with
  §1.1a, `social_posts` goes from 16 indexes to 15.
- **Expected plan** for the §0.17 query on the busiest session: `Index Scan using
idx_social_posts_session_created`, reading that session's rows in time order until 100
  `official_account`/`player` posts are found. Because the seeded official history is the oldest
  content, that should stop almost immediately.
- **Unvalidated.** Confirm with `EXPLAIN (ANALYZE, BUFFERS)` on a Supabase branch, or after a
  `CONCURRENTLY` build in a quiet window. **Acceptance:** `idx_social_posts_created_at` is gone from
  the plan, discarded rows are in the low thousands at most (not 104,364), and the query takes under
  ~15 ms.
- `CREATE/DROP INDEX CONCURRENTLY` cannot run inside a transaction, so the migration must not be
  wrapped in one.
- **That means it cannot go through the normal migration path as written** (added 2026-09-24).
  Supabase's migration tooling applies each file inside a transaction, and pasting a
  multi-statement file into the SQL editor runs it as one implicit transaction too. No migration in
  this repo has ever actually run `CONCURRENTLY` (migration 108 only mentions it in a comment).
  There are two workable routes:
  - Run each `CONCURRENTLY` statement **on its own**: one statement per SQL-editor run, or via
    `psql`.
  - When no exercise is running, use a **plain `CREATE INDEX`** instead. It works in the normal
    runner and blocks writes to that one table only for the seconds the build takes.
- **A failed `CONCURRENTLY` build leaves an invalid index** that still slows every write but is never
  used. Before retrying, check `select indexrelid::regclass from pg_index where not indisvalid;` and
  drop anything it lists.

### 7a.2 Index `original_post_id` — prerequisite for archiving

```sql
create index concurrently if not exists idx_social_posts_original_post
  on public.social_posts (original_post_id)
  where original_post_id is not null;
```

- Partial, so only reposts get an entry: tiny, and close to free on insert. The foreign-key check
  (`original_post_id = $1`) can use a partial index, because equality implies not-null.
- **Expected effect:** post deletions stop scanning the whole table (902 ms and 169,157 pages each
  today, §0.20), and the 1,416 recorded full scans very likely stop too.
- **Acceptance:** `explain select 1 from social_posts where original_post_id = '<any id>'` shows an
  index scan on the new index. That test uses a literal value, while Postgres runs the real
  foreign-key check as a parameterised query internally, so the definitive test is a real `DELETE`
  on a Supabase branch, timed before and after. Only 10 posts are reposts today, so the index is
  tiny.
- **Same migration caveat as §7a.1:** `CONCURRENTLY` cannot run through the normal migration path.
  Run the statement on its own, or use a plain `CREATE INDEX` when no exercise is running; with only
  10 entries, the build takes well under a second.

### 7a.3 Index `session_events (session_id, event_type, created_at)`, replacing `idx_session_events_session`

```sql
create index concurrently if not exists idx_session_events_session_type_created
  on public.session_events (session_id, event_type, created_at);

drop index concurrently if exists idx_session_events_session;
```

- Serves `session_id = ? and event_type = ?` directly, plus its ordered variants, instead of
  intersecting with a table-wide `event_type` bitmap (§0.19).
- The `metadata->>? ilike ?` query still filters JSON in memory, but only over one session's events
  of one type.
- **Keep `idx_session_events_type`** until its scan count shows nothing filters on event type alone.
- Net index count unchanged.
- **Acceptance:** on the busiest session, the plan uses the new index and no
  `idx_session_events_type` bitmap.
- **Same migration caveat as §7a.1:** run each `CONCURRENTLY` statement on its own, not through the
  normal migration path, or use a plain `CREATE INDEX` when no exercise is running. Check for an
  invalid index before retrying a failed build.

### 7a.4 Code-only interim, if migrations have to wait

- **`session_events`:** queries can safely add `created_at >= <session created_at>`, because no
  event predates its session (§0.18).
- **`social_posts`: do not bound by session start or creation** (§0.18). If an interim is
  unavoidable, bound at `session.created_at - interval '31 days'`, **and** clamp `days_ago` to 1–30
  in `ambientContentService.ts` L402 so the assumption cannot be broken. This is a weaker win than
  §7a.1, because a 31-day window can still include other exercises from that month.

### 7a.5 Archive finished exercises

Move each finished exercise's rows out of the live tables, so the live tables only ever hold
running or recent exercises.

**Tables (all of them, not just posts):** `social_posts`, `social_post_likes`,
`social_post_flags`, `post_engagement_log`, `scenario_state_history`, `session_events`,
`session_escalation_factors`, `session_pathway_outcomes`. Give each an archive twin with the same
columns. Index the twins only on `session_id` plus whatever the after-action review filters on;
they do not need the live tables' 16 indexes.

**Lock the archive tables down in the same migration that creates them, before any data is copied**
(added 2026-09-24). Measured on this project, every new table created in `public` automatically
grants the `anon` and `authenticated` roles `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`. The anon
key ships in the frontend bundle, and `CREATE TABLE ... (LIKE ...)` does **not** copy row-level
security. The live tables are safe only because each has RLS enabled (most with zero policies,
which means deny-all). A naively created archive twin would therefore expose every archived post,
message and state snapshot to anyone with the public key, for reading and for writing. Required:

```sql
create schema if not exists archive;            -- not in the API's exposed schemas
create table archive.social_posts (like public.social_posts including defaults);
alter table archive.social_posts enable row level security;   -- deny-all; service role bypasses
revoke all on archive.social_posts from anon, authenticated;
-- repeat for each archive table
```

Any view that combines live and archive rows must be created `with (security_invoker = true)`.
A plain view runs with its owner's rights and bypasses RLS, so it would expose the **live** tables
to the anon key as well.

**The job, per finished exercise, one transaction, off-hours:**

1. Copy the exercise's likes, flags and engagement log rows to the archive.
2. Copy its posts, state snapshots, events, escalation factors and pathway outcomes.
3. Delete those rows from the live tables.
4. Set `sessions.archived_at` (new column) and commit. Either everything moves or nothing does.

- **Order is what makes it safe.** Likes, flags and the engagement log are `ON DELETE CASCADE` from
  `social_posts`. Deleting posts before copying them silently destroys after-action data for good.
  In the order above, the cascade only removes rows that have already been copied.
- **Prerequisite: §7a.2.** Without it, every deleted post scans the whole table.
- **Readers of finished exercises are far more than the obvious ones** (corrected 2026-09-24). An
  earlier draft listed five readers: `aarSocialMediaService`, `aarSocialSectionService`,
  `teamScoreService`, the review-mode feed and `aar.ts` L779. But **any API route that takes a
  session id can be pointed at a finished exercise**, whether by review mode, the trainer dashboard
  or an old link. `session_events` alone is read in **35 server files**, including routes such as
  `events.ts`, `sessions.ts`, `decisions.ts`, `injects.ts`, `insider.ts` and `socialMedia.ts`. After
  archiving, every reader that was not repointed silently returns an empty exercise. Choose one of:
  - **(a) Repoint every reader** to a live-plus-archive view (created `security_invoker`, see
    above). Most thorough, and the largest change.
  - **(b) Restore on open.** When someone opens an archived exercise, move its rows back into the
    live tables first. No reader changes at all; that first open takes a few seconds.
  - **(c) Archive only after the review window closes**, and make the after-action review the only
    supported view of an archived exercise.

  **Recommendation: (b), or (c) if the product can accept old exercises becoming AAR-only.**

- **Checked and fine:** no reply and no repost crosses exercises (0 and 0; only 10 reposts exist in
  total), so archiving one exercise at a time cannot break the self-referencing foreign keys.
- **Disk goes up before it comes down.** Copy-then-delete means both copies exist until the space is
  reclaimed. The first full run needs roughly **1.2 GB of extra headroom**, the combined size of the
  per-exercise tables. Check disk usage in the Supabase dashboard first: disk growth is billed, and
  may not shrink back on its own.
- **Deleting rows does not give the space back.** The live tables keep their size on disk, as mostly
  empty pages, and their indexes stay bloated. New inserts reuse the space, but full-table scans
  still read it. Reclaim it once after the first run with **`pg_repack`** (available here, version
  1.5.2, not yet installed). It works mostly online, but needs free disk about the size of the table
  while it runs. The alternative, `VACUUM FULL`, locks the table and is only acceptable with no
  exercise running.
- **Large exercises mean large transactions.** One transaction for the 54,865-post exercise holds
  locks and writes a large burst of change log. Instead, move one table at a time and make the job
  resumable with a state on the session (`copying → copied → deleting → archived`), so a failure
  midway can be re-run safely.
- **Realtime sees the deletes.** `session_events` is in the `supabase_realtime` publication, so a
  mass delete is a burst of change events that Realtime has to process. If the job runs during an
  exercise, that can delay chat and incident updates, so run it off-hours. Separately: nothing
  subscribes to `session_events` (no frontend reference, no server subscription), so removing it
  from the publication would stop Realtime processing every event insert for nobody. Confirm that
  first, then treat it as a free win.
- **Scheduling:** `pg_cron` (1.6.4) is available, so the job can run nightly inside the database as a
  function, rather than from the app server.
- **Grace period** before archiving (keep recently finished exercises live for review) is a product
  decision (§10).
- **Partitioning was considered and rejected.** Postgres requires the partition key in the primary
  key, so all five foreign keys pointing at `social_posts` would have to become composite keys. That
  is only worth it at millions of rows.
- **Expected benefit.** Each exercise's posts stop sharing disk pages with other exercises' rows
  (25,062 of them on the busiest session's pages today, §0.16). Live indexes stay small, inserts touch
  fewer pages, and planner estimates stop being skewed by one 54,865-post session. It also removes the
  "reads every finished exercise" failure mode at the source, as a backstop to §7a.1.

### 7a.6 Shrink the largest table at the source (product question)

`scenario_state_history` is 319 MB because it stores a full ~17 KB snapshot on every state change,
and only the after-action review reads it (§0.16). If periodic checkpoints, or storing only what
changed, serve the review, the table shrinks without any archiving. Decide with whoever owns the
after-action review.

---

## 8. Sequencing and expected effect

| Phase     | Work                                                        | Effort | Effect                                                                                                                                              |
| --------- | ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0       | **Feed as one Postgres function** (§1.0a–d)                 | M      | **Largest.** 6,811 ms → **4.8 ms** measured. Fixes the visibility bug, the `count` bug, the 1,000-UUID URL and 5 round trips at once. No migration. |
| 1.3       | `limit=1000` → 50 + keyset scroll                           | M      | 1.4 MB → ~70 kB; 20× less render work. Unblocked by 1.0.                                                                                            |
| 1.1a      | Drop redundant `idx_social_posts_algorithm_sort`            | S      | Reclaims 25 MB; halves virality write churn. Independent.                                                                                           |
| 1.5       | Remove the double fetch                                     | XS     | Halves feed-open work on navigation                                                                                                                 |
| 3         | Compression (_in the other plan_)                           | S      | ~10× on every payload here                                                                                                                          |
| 2.1–2.2   | Optimistic send + drop redundant refetches                  | M      | **Send feels instant.** 3 round trips → 0 perceived                                                                                                 |
| 2.3       | Delete hard-coded delays                                    | XS     | ~1 s off each interaction                                                                                                                           |
| 4         | Trim serial send work                                       | S      | Faster server ack                                                                                                                                   |
| 5         | Polling/realtime hygiene                                    | M      | Less background load, fresher badges                                                                                                                |
| 6         | Cache across app switches                                   | M      | Second open is instant                                                                                                                              |
| 7         | Logging hygiene                                             | XS     | Main-thread relief in busy sessions                                                                                                                 |
| 8 · §7a.1 | `social_posts (session_id, created_at)` index               | S      | Watchdog stops reading every finished exercise (576 ms today); keeps seeded history                                                                 |
| 8 · §7a.2 | `original_post_id` partial index                            | XS     | Post deletes stop scanning the table (902 ms each today). **Required before §7a.5**                                                                 |
| 8 · §7a.3 | `session_events (session_id, event_type, created_at)` index | S      | The top disk reader stops sweeping every session's events of a type                                                                                 |
| 8 · §7a.5 | Archive finished exercises                                  | L      | Live tables stay small; each exercise's rows stop sharing pages with others. Has four prerequisites (below)                                         |
| 8 · §7a.0 | No compute upgrade; monitor the hit rate                    | XS     | Upgrade only if the cache hit rate falls below 99%                                                                                                  |

Phases 2, 4, 5 and 7 are independent and can land in any order. Phase 6 is most valuable last.
**§1.3 is gated on §1.0** — shipping a smaller page size without the SQL visibility filter
introduces a visible bug (§1.3a).

**Phase 8 ordering:** §7a.1–§7a.3 are independent index migrations and can ship together. None of
Phase 8 depends on Phases 1–7. **§7a.5 (archiving) has four prerequisites**, all in §7a.5:

1. **§7a.2 shipped first**, otherwise every deleted post scans the whole table.
2. **The archive tables are locked down in the migration that creates them:** a non-exposed schema,
   row-level security on, anon and authenticated grants revoked, and any combined view created
   `security_invoker`.
3. **The reader strategy is decided** (§10, question 10). Restore-on-open is recommended, so that
   archived exercises don't go blank on the screens that still read the live tables.
4. **About 1.2 GB of disk headroom is confirmed** in the Supabase dashboard, and a `pg_repack` is
   scheduled for after the first run.

**If only one thing gets done: §1.0.** One database function, no migration, no new index, and it
takes the feed from 6,811 ms to a measured 4.8 ms while fixing two correctness bugs on the way.
**The best value for background load is §7a.1–§7a.3:** three index migrations that stop live
exercises from reading finished exercises' data, which is what makes a compute upgrade unnecessary
for now.

**Still open for the 4 country-using sessions** (§1.0d) — they genuinely need the predicate and
would keep the bad plan. Resolve inside the function before declaring the feed fixed.

---

## 9. Verification

Capture a baseline first, so improvements are provable:

- `EXPLAIN (ANALYZE, BUFFERS)` on the §0.1 query for the busiest session
  (`cd31d4fa-bc45-444a-98ff-b313923d622d`), both cold and warm. Use
  `DISCARD ALL` / a fresh connection, or compare `read=` vs `hit=` in the buffer line, to
  distinguish the two — the cold number is the one users feel.
- `curl -w '%{size_download} %{time_total}'` on the feed endpoint at `limit=1000` and `limit=50`,
  with and without `Accept-Encoding: gzip`.
- A DevTools performance trace of: opening the Z app, sending a DM, posting a reply. Record
  time-to-first-post, and keypress→message-visible latency.
- Main-thread profile of a 2-minute window in a live session with realtime active, before and after
  Phase 7.
- **For Phase 8:** record the cache hit rate (§7a.0 query; baseline 99.94%) and the
  `pg_stat_statements` pages per call for the queries in §0.17, §0.19 and §0.20 (baselines: watchdog
  26,348, post delete 169,157, `session_events` shapes 767–2,915). Run
  `select pg_stat_statements_reset();` right after deploying, so the next numbers reflect only the
  new code and indexes. That call clears only the query statistics. It is **not** the same as
  `pg_stat_reset()`, which must not be used, because it also clears the table statistics that
  autovacuum relies on (§9a.7).

**Regression surface:** both feeds (ranking order, the "new posts" pill, scroll restoration,
engagement counts, flag/report/repost/share), threads and replies, Messenger (send, compose,
thread switching, unread counts, page-context sending), org pages, email, TeamChat (must not
regress — it is the reference implementation), the trainer dashboard, and multi-country sessions
specifically for the §1.2 change.

`npm run lint`, `npm run typecheck`, `npm test` green; frontend `tsc && vite build` passes.

---

## 9a. Drawbacks and second-order effects (added 2026-09-23)

A deliberate review of what each change breaks, slows down, or makes riskier. Four items here were
serious enough to change the plan above; the rest are things to watch.

### 9a.1 Changes that alter the plan — all now have concrete mitigations

| #   | Risk                                                                           | Severity    | Concrete fix                                                                  | Status                  |
| --- | ------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------- | ----------------------- |
| 1   | Pagination breaks visibility filtering; `count` is pre-filter                  | **Blocker** | Visibility predicate in SQL inside the RPC function — §1.0a, measured 30.1 ms | **Resolved**            |
| 2   | Proposed new index would add write amplification to the hottest write path     | **High**    | No new index needed; existing `idx_social_posts_virality` suffices — §1.0     | **Resolved**            |
| 3   | Pagination over a volatile sort key reorders rows mid-scroll                   | **High**    | Keyset pagination on `(virality_score, id)` inside the function — §1.0b       | **Resolved**, one check |
| 4   | Dropping the notification poll → permanent staleness after 5 failed reconnects | Medium      | `reconnectionAttempts: Infinity` + backoff + slow safety poll — §9a.2         | **Resolved**            |
| 5   | Optimistic send duplicate/ghost-message races                                  | Medium      | Client-generated `uuid` echoed by the server — §9a.4                          | **Resolved**            |
| 6   | Compression breaks NDJSON streaming                                            | Medium      | `filter` keyed on the `no-transform` header they already set — §9a.5          | **Resolved**            |

### 9a.2 Removing polls has a failure mode the polls currently mask

`websocketClient.ts` is configured with **`reconnectionAttempts: 5`**. After five failed reconnects
it stops trying, permanently. Today the 15 s poll hides this — a player whose socket dropped still
gets fresh badges and counts.

If §5.1 removes the poll and relies on the WebSocket alone, one network blip leaves that player
**permanently stale with no recovery path short of a manual reload** — during a live exercise.

**Amendment to §5.1 — do both, they are cheap.** In `websocketClient.ts`:

```js
reconnection: true,
reconnectionAttempts: Infinity,   // was 5 — the cliff
reconnectionDelay: 1000,
reconnectionDelayMax: 30000,      // back off instead of hammering
randomizationFactor: 0.5,
```

Then keep a **slow** safety-net poll at 60–120 s rather than deleting it — still a 4–8× reduction
from 15 s, and it covers the case where the socket is "connected" but the server has stopped
broadcasting. Surface `isConnected` in the device chrome so a stuck player can see why nothing is
arriving.

### 9a.3 `recordPlayerAction` fire-and-forget (§4.1)

Making it non-blocking is safe _provided_ nothing in the same request chain reads `player_actions`
back. It is consumed by AAR and SOP scoring, which run much later. `recordPlayerAction` already logs
its own errors (`sopCheckerService.ts` L143), so failures stay visible.

**Residual risk:** a request that succeeds while its telemetry insert fails becomes invisible to
after-action review. Acceptable for DM sends; **re-check before applying the same change to
decision or inject actions**, where the audit trail is the product.

### 9a.4 Optimistic send introduces duplicate-render races (§2.1, §2.2)

Adding a local temp row while a WebSocket broadcast of the same message is in flight is exactly the
race `ChatInterface` fights with content-string matching across three refs plus a timeout
(L378–539). Repeating that approach in three more places would triple the surface area for
duplicate or ghost messages.

**Mitigation — verified viable.** All four message tables take a client-supplied id:

| Table                 | `id` type | Default              |
| --------------------- | --------- | -------------------- |
| `social_posts`        | `uuid`    | `uuid_generate_v4()` |
| `sim_direct_messages` | `uuid`    | `uuid_generate_v4()` |
| `chat_messages`       | `uuid`    | `uuid_generate_v4()` |
| `sim_emails`          | `uuid`    | `uuid_generate_v4()` |

A column default only applies when the column is **omitted**, so the client can generate its own
`crypto.randomUUID()`, send it as `id`, and the server inserts it verbatim. Reconciliation becomes
`m.id === payload.id` and the entire class of race disappears — along with the ~160 lines of
content-string matching in `ChatInterface` L378–539.

Server-side, validate the supplied id is a well-formed uuid and rely on the primary-key constraint
to reject replays; do not trust it for anything else.

**If for some reason the server cannot echo a client id, do not proceed with optimistic send** —
duplicate-message bugs are worse than the latency they would fix.

Note `handlePost` already has a partial guard at `SocialFeedApp` L636–639
(`prev.some(p => p.id === createdPost.id)`); the optimistic path needs the equivalent.

### 9a.5 Compression (§3) touches more than the NDJSON routes

- **NDJSON war-room builds** (`socialCrisisWarroom.ts` L270–277, `warroom.ts` L389–395) use
  `res.write` + `res.flushHeaders()`. Compression buffers by default, which would stall stage-by-stage
  progress.
- **`tileProxy`** returns `image/png` buffers (L28–32). Re-compressing already-compressed images
  burns CPU for no gain.
- **`Content-Length` disappears**, replaced by chunked encoding. I found no client reading that
  header, but grep before shipping.

**Mitigation — no route list to maintain.** The streaming routes already set
`Cache-Control: no-transform` (`socialCrisisWarroom.ts` L272), which is precisely the HTTP header
that means "do not compress me". Key the filter off it:

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

`warroom.ts` L389–395 does **not** currently set `no-transform` — add it there so the filter covers
both, rather than hard-coding paths.

### 9a.6 Things that will limit these fixes, which the plan does not address

- **`runEngagementTick` is itself an over-fetch.** It does `select('*')` over a 45-minute window,
  then issues one `UPDATE` per post serially, every 30 s (`engagementAlgorithmService` L132–139,
  L359–361). On a busy session that is hundreds of round trips per tick, competing for the same
  database and buffer cache the feed fix is trying to exploit. Probably the largest remaining
  background-load problem after this plan lands.
- **Cache pressure is structural, but not urgent.** The feed fix takes the feed from 7,456 buffers
  to ~1,203, a constant-factor win. The per-exercise tables keep every finished exercise forever
  (§0.16), so cold behaviour will keep degrading until §7a.5 archives them. Today's 99.94% hit rate
  (§0.15) means this is a scheduled job, not an emergency.

### 9a.7 Risks in Phase 8 (added 2026-09-24)

- **A time bound on posts would hide seeded content.** This is why §7a.1 is an index and not a
  `created_at >=` condition (§0.18). Anyone adding time bounds to `social_posts` queries later must
  account for branded history backdated up to 30 days.
- **Index migrations on live tables.** All three use `CONCURRENTLY`, so writes are not blocked, but
  each build reads the whole table. Run them off-hours. Each replaces an existing index, so write
  cost per insert stays about the same (§7a.1, §7a.3), or rises negligibly (§7a.2, a small partial
  index).
- **Dropping the replaced indexes too early.** Drop `idx_social_posts_session_id` and
  `idx_session_events_session` only after `EXPLAIN` confirms the new composites are chosen, and keep
  the `DROP` in a separate migration so it can be reverted independently.
- **The archive job is a data-moving operation.** Its failure modes are the cascade order (§7a.5),
  readers that still point at the live tables, and long transactions on large exercises. Rehearse it
  on a Supabase branch against the 54,865-post exercise before running it on production.
- **Added 2026-09-24, after checking the fixes against the live project:**
  - **Security:** archive tables are exposed to the public anon key unless RLS is enabled and grants
    are revoked when they are created. A plain live-plus-archive view also exposes the _live_ tables
    (§7a.5).
  - **Blank exercises:** far more code reads finished exercises than the obvious AAR services, so
    archiving without restore-on-open (or repointing) empties them from every other screen (§7a.5).
  - **Migrations:** `CONCURRENTLY` cannot run through the normal migration path, and a failed build
    leaves an invalid index behind (§7a.1).
  - **Disk:** the first archive run needs about 1.2 GB of temporary headroom, and space only comes
    back after a `pg_repack` (§7a.5).
  - **IO budget:** index builds, the first archive run and a repack each read whole tables. Smaller
    Supabase compute sizes have limited disk throughput, so run them off-hours and watch the Disk IO
    metric in the dashboard while they run.
  - **The capacity number itself:** the 99.94% hit rate is a lifetime average (statistics have never
    been reset), dominated by months of history, so recent behaviour could be worse. **Do not** call
    `pg_stat_reset()` to get a fresh window, because autovacuum relies on those counters. Instead,
    snapshot `blks_hit` and `blks_read` weekly and compare the differences.

## 10. Open questions for review

1. §7a.1–§7a.3 — validate the three new indexes on a **Supabase branch**, or build them
   `CONCURRENTLY` on production during a quiet window? A branch is safer but costs a little. (The
   feed itself no longer needs a new index; see §1.0.)
2. §1.3 — is 50 the right page size for a crisis feed, or does the exercise design depend on
   players seeing a large wall of posts at once? This is a product question, not a technical one,
   and it determines whether infinite scroll is acceptable.
3. §1.2 — is the country-scoping feature still live, or is it vestigial? 4 of 103 sessions used it.
   If vestigial, removing the predicate outright is simpler than making it conditional.
4. §2.4 — retrofit `ChatInterface`'s reconciliation to client-generated ids as part of this work, or
   leave it and only use the cleaner pattern for new call sites?
5. §4.1 — does anything downstream (AAR, SOP checking) rely on `player_actions` being written
   before the send response returns?
6. **Decided 2026-09-24: archive, do not partition** (§7a.5). Remaining decision: how long a
   finished exercise stays in the live tables before the archive job moves it (for example, one
   week for trainer review)?
7. §7a.6 — does the after-action review need a full ~17 KB state snapshot on **every** change, or
   would periodic checkpoints do? This decides whether the largest table (319 MB) can shrink at the
   source.
8. The statement watchdog (§0.17) takes the **oldest** 100 `official_account`/`player` posts as
   "all prior statements". With up to 30 days of seeded branded history, once a session passes 100
   such posts the watchdog may never see newer player statements. Intended, or should it take the
   newest 100? Taking the newest would also make the query cheap without any index, since recent
   posts sit at the end of the `created_at` index.
9. Should `days_ago` be clamped to 1–30 in `ambientContentService.ts` L402? Today it is taken from
   generator output unchecked (`Number(post.days_ago) || 7`), and any future time-bounded query on
   posts depends on that window (§0.18).
10. §7a.5 — which way should archived exercises be read? **(a)** repoint every reader to a
    live-plus-archive view, **(b)** restore an exercise to the live tables when someone opens it, or
    **(c)** archive only after the review window closes and make the after-action review the only
    supported view. **(b) is recommended**, because no code that reads the data has to change. This
    decision is needed before the archive job is built, because it determines whether any of the
    35 `session_events` readers must change.
