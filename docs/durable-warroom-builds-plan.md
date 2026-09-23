# Durable War Room builds — design & build plan

**Owner:** generator agent (wizard, generation routes, persistence).
**Status:** v1 plan, 2026-09-22 — awaiting review. Nothing implemented yet beyond the 21 Sep
hardening (heartbeats, 15-minute poll ceiling, fast-fail on lost jobs, retry/back-off), which
this plan supersedes rather than removes.
**Companion:** the explainer canvas `warroom-build-failure-explainer.canvas.tsx` (chat artefact);
`docs/AWS_BEDROCK_MIGRATION_v2.md` §7 for the shared AI client that Phase 4 keys off.

---

## 0. Why (evidence, not theory)

The corporate-crisis build (Characters → Storyline → Convergence → Pages → Compile) is conducted
by the **browser tab**. The tab starts each stage, downloads the result, and posts it back as the
input of the next. Between stages nothing generated is saved anywhere except React state; the
server keeps job results in a `Map` in process memory.

The 21 Sep 2026 failure, reconstructed from the Render log, Render metrics and the deploy list:

| UTC      | Event                                                                                             | Source                  |
| -------- | ------------------------------------------------------------------------------------------------- | ----------------------- |
| 01:48:13 | Characters job starts on container `tvrgm`                                                        | server log              |
| 01:52:57 | Push `8d9f9b4` triggers a Render deploy                                                           | `list_deploys`          |
| 01:54:05 | Characters completes (219 SG + 213 MY personas) after 5 min 52 s — 8 s inside the old 6-min clock | server log              |
| 01:54:17 | Storyline stage starts on `tvrgm` (NDJSON stream)                                                 | server log              |
| 01:54:30 | Deploy goes live; new container `xr2cw`                                                           | `list_deploys`, metrics |
| 01:55:11 | Last healthy storyline call logged on `tvrgm`                                                     | server log              |
| ~01:55   | `tvrgm` retired (last memory sample); the open stream and the in-memory jobs die with it          | metrics                 |

Server RAM during the build: **158–170 MB of 2,147 MB (7.5%)**; CPU **< 2%** of one core. The
machine was never the constraint. The earlier attempt that reported "NPC generation timed out"
had deploy swaps at 01:40 and 01:45 in its window — same mechanism, different symptom (job lost →
404 → the old client waited out its clock).

Three failure modes, one root cause — **build state lives in two volatile places** (tab memory
and server process memory):

| #   | Mode                                                  | 21 Sep status                        | Fixed by |
| --- | ----------------------------------------------------- | ------------------------------------ | -------- |
| 1   | Client give-up clock shorter than a two-country build | Fixed (15 min) — but a clock remains | Phase 2  |
| 2   | Deploy / restart drops in-memory job and open stream  | **Proven cause.** Fast-fail only     | Phase 3  |
| 3   | Cloudflare 100 s idle cut on long NDJSON responses    | Standing risk; heartbeat added       | Phase 2  |
| —   | Tab closed / discarded / laptop asleep / navigation   | Unfixed — whole build lost           | Phase 1  |

---

## 1. Today, precisely (what the code does)

**Client** — `frontend/src/pages/SocialCrisisWizard.tsx`

- `generateAll()` (≈L1584) chains `generateNPCs()` → `generateStoryline()` → `generateConvergence()`
  → `generateOrgPage()`, threading results by argument because React state is not updated mid-chain,
  then `saveDraftState(7)` and `setStep(7)`.
- `generateNPCs` (≈L1016): `POST /api/warroom/social-crisis/generate-npcs` → `job_id`; polls
  `…/generate-npcs/status/:jobId` 300 × 3 s; 404 after the third poll = `JOB_LOST_MESSAGE`.
- `generateStoryline` (≈L1118): `POST …/generate-storyline`, reads NDJSON; merges `persona_twins`
  into the crowd, maps returned `pressure_organisations` (org_key, spokesperson) onto the drafts by
  display name, stores charters / stakeholders / stakeholder_injects / orgs / sop_steps /
  decision_context. Stream end without `complete` = `STREAM_DROPPED_MESSAGE`.
- `generateConvergence` (≈L1310): `POST …/generate-convergence` with
  `team_storylines = { ...teamStorylines, Shared: storylineInjects }` → job; polls 180 × 3 s;
  merges `intel_injects` into the holder teams' storylines; stores shared injects, gates,
  narrative, objectives, dimension labels.
- `generateOrgPage` (≈L1460): `POST …/generate-org-page`, NDJSON; stores `org_page`, `orgs`;
  replaces page-authored `stakeholder_injects` (by `delivery_config.page_org_key`) with
  `pressure_injects`; merges `persona_twins`.
- `compileScenario` (≈L1623): `POST …/compile` with the whole assembled payload (~1 MB) → job →
  poll.
- `buildDraftInput()` (≈L642) serialises **Setup inputs and every generated artefact** into
  `warroom_wizard_drafts.input`. `saveDraftState()` is called on step transitions only: leaving
  Setup (nothing generated yet) and after `done`. So the draft row holds either _no_ generated
  output or _all_ of it — never a partial build.
- Resume (≈L753): loads `input`, restores state, `setStep(current_step)`. A draft saved at step 2
  resumes to Building with no generation running (the "Build the scenario" button restarts from
  scratch).

**Server** — `server/routes/socialCrisisWarroom.ts`

- `aiJobs: Map<jobId, {status,data,error,startedAt}>` (≈L286), swept after 30 min. Used by
  `/generate-npcs`, `/generate-convergence`, `/compile`; read by `/job-status/:jobId`.
- NDJSON routes `/generate-storyline`, `/generate-storylines`, `/research`, `/generate-org-page`,
  `/extract-blueprint` hold one response open for the stage; `beginNdjson()` (≈L269) now writes a
  heartbeat every 15 s.
- Stage logic lives in `server/services/multiOrgPipeline.ts` — `runNpcsPipeline`,
  `runStorylinePipeline(…, write)`, `runOrgPagePipeline`, `buildCompileArtifacts` — plus the
  single-org legacy functions in `socialCrisisGeneratorService.ts` (`generateNPCsAndFactSheet`,
  `generateUnifiedStoryline`, `generateAllTeamStorylines`, `generateConvergenceLayer`,
  `generateIntelDependencies`, `generateStrategyWindows`).
- Credits: `scenarioCreditGate` (has ≥1 scenario credit) on every generation route; the credit is
  **consumed at `/compile` only** (`consumeCredit`, refunded on failure).
- Shutdown (`server/index.ts` ≈L281): stops schedulers, closes HTTP/WS, force-exits after 10 s.
  Nothing about builds.

**Drafts** — `server/routes/warroom.ts` ≈L462–634: `GET/POST /api/warroom/wizard/drafts`,
`GET/PATCH /api/warroom/wizard/drafts/:id`. Table `warroom_wizard_drafts` (migration 160):
`input JSONB`, `current_step`, `status`, field-ops step columns, `scenario_id`, `error`.

---

## 2. Goals and non-goals

**Goals**

- G1 A build survives: tab close, tab discard, navigation, laptop sleep, network drop, Cloudflare
  idle cut, **backend deploy or crash**. Worst case after any of these: the stage in flight is
  re-run; nothing finished is lost.
- G2 A trainer can start a build, leave, and come back on any device; the Building step shows
  live progress for a build it did not start.
- G3 Review & compile reopens from the saved draft without regenerating; compile reads the
  payload from the server, not from a 1 MB browser upload.
- G4 A failed stage retries **alone** from persisted upstream state.
- G5 Builds cannot starve live sessions (concurrency cap) and are observable (per-stage log).
- G6 Legacy drafts (generated output inside `input`) keep loading.

**Non-goals (v1)**

- Field-ops wizard (`/api/warroom/generate`, `/wizard/drafts/:id/geocode-validate` etc.) — its
  outputs are already persisted per step in dedicated columns; not in scope.
- Replacing the AI provider, changing prompts, or altering what the stages generate.
- A second Render service. Optional in Phase 4, only if measurements call for it.

---

## 3. Design

### 3.1 Data model — migration 209

```sql
-- 209_warroom_durable_builds.sql
ALTER TABLE warroom_wizard_drafts
  ADD COLUMN IF NOT EXISTS generated   JSONB DEFAULT NULL,   -- stage outputs, raw, keyed by stage
  ADD COLUMN IF NOT EXISTS build_state JSONB DEFAULT NULL;   -- orchestration state (below)

CREATE INDEX IF NOT EXISTS idx_warroom_wizard_drafts_build_status
  ON warroom_wizard_drafts ((build_state->>'status'))
  WHERE build_state IS NOT NULL;
```

`input` goes back to meaning **Setup inputs only**. Generated output moves to `generated`; the
wizard stops serialising personas/injects into `input` (drops the row from ~1 MB to a few KB and
removes the double source of truth). Old drafts are read by a loader that prefers `generated` and
falls back to the generated keys inside `input` (G6).

**`build_state`** (one object; every write replaces it whole, guarded by `build_id`):

```ts
interface BuildState {
  build_id: string; // uuid per attempt; CAS token for every UPDATE
  status: 'queued' | 'running' | 'interrupted' | 'failed' | 'done' | 'cancelled';
  stage: BuildStage | null; // stage in flight
  stages: Record<
    BuildStage,
    {
      status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
      attempts: number;
      started_at?: string;
      finished_at?: string;
      ms?: number;
      error?: string; // describeGenerationFailure() text
    }
  >;
  log: Array<{ t: string; stage: BuildStage; message: string }>; // capped at 200, newest kept
  instance: string; // process.env.RENDER_INSTANCE_ID ?? hostname:pid
  heartbeat_at: string; // refreshed every 30 s while running
  started_at: string;
  finished_at?: string;
  error?: string; // build-level (last failed stage's error)
  requested_by: string; // user id
  mode: 'multi_org' | 'single_org'; // which pipeline family runs
}
type BuildStage = 'characters' | 'storyline' | 'convergence' | 'pages' | 'compile';
```

**`generated`** — raw stage outputs, no merging:

```ts
interface Generated {
  characters?: { personas; fact_sheet; communities; countries?; per_country_counts?; footprint? };
  storyline?: {
    injects;
    team_storylines;
    team_charters;
    stakeholders;
    stakeholder_injects;
    persona_twins;
    orgs;
    sop_steps;
    decision_context;
    pressure_organisations;
  };
  convergence?: {
    shared_injects;
    convergence_gates;
    narrative;
    objectives;
    dimension_labels;
    intel_injects;
  };
  pages?: { org_page; orgs; pressure_injects; persona_twins };
  compile?: { scenario_id; title; inject_count };
}
```

The inter-stage glue the wizard performs today (twins into crowd, intel injects into team
storylines, pressure statements replacing page-authored stakeholder injects, pressure org_key /
spokesperson mapping, `Shared` key for convergence input) becomes **one pure function**
`assembleReviewState(input, generated): ReviewState` in `server/services/warroomBuild/assemble.ts`,
used by the stage runners (to build the next stage's input), by `GET …/review`, and by compile.
It is unit-tested; the wizard no longer contains merge logic.

### 3.2 Orchestrator — `server/services/warroomBuild/`

| File              | Role                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildTypes.ts`   | `BuildState`, `Generated`, `BuildStage`, `STAGE_ORDER`, `ReviewState`                                                                                                                          |
| `buildCore.ts`    | **Pure**: `newBuildState()`, `nextStage(state)`, `markStage*()`, `appendLog()`, `classifyRecovery()`, `legacyGeneratedFromInput()`                                                             |
| `assemble.ts`     | **Pure**: `assembleReviewState()`, `stageInput(stage, input, generated)`                                                                                                                       |
| `buildStore.ts`   | Supabase IO: `loadDraft`, `casUpdateBuildState(draftId, buildId, patch)`, `writeStageOutput(draftId, buildId, stage, output, state)` (one UPDATE touching both columns), `listRunningBuilds()` |
| `stageRunners.ts` | One async function per stage wrapping the existing pipeline/generator functions; each takes `(stageInput, log)` and returns raw output. Multi-org and single-org families selected by `mode`.  |
| `buildService.ts` | `startBuild()`, `resumeBuild()`, `runBuild()` loop, semaphore, heartbeat, `cancelBuild()`, `recoverOnBoot()`, `interruptOnShutdown()`                                                          |

**`runBuild(draftId, buildId)` loop**

1. Load draft; verify `build_state.build_id === buildId` (else stop — superseded).
2. `stage = nextStage(state)` — first stage not `done`. If none → `status: 'done'`.
3. CAS-update: `stage.status='running'`, `attempts+1`, `state.stage`, `heartbeat_at`.
4. Start heartbeat timer (30 s) → CAS-update `heartbeat_at` only.
5. `output = await stageRunners[stage](stageInput(stage, input, generated), log)` — `log` appends
   to `state.log` and flushes at most every 2 s (progress lines the wizard shows).
6. `writeStageOutput(...)` — `generated[stage] = output`, stage `done`, `ms`, in one UPDATE.
7. Loop. On throw: stage `failed` with `describeGenerationFailure(err, stage)`, build `failed`,
   stop. **Nothing already persisted is touched.**

Compile is stage 5 of the same loop: it consumes the scenario credit (existing `consumeCredit` /
`refundCredit` semantics, refund on failure) and calls a `compileFromReviewState(review, user)`
extracted from today's `/compile` handler body (≈L1047–1301) — the route keeps working by calling
the same function. Compile is **not** auto-run after `pages`; the trainer still presses Compile
on Review (product decision: review before spending the credit). `POST …/build` with
`{ stages: ['compile'] }` runs it.

**Concurrency**: `MAX_CONCURRENT_BUILDS` (env, default 2) process-wide semaphore; extra builds sit
in `status: 'queued'` and are picked up FIFO. One in-flight build per draft, enforced by the CAS
predicate (`build_state->>'status' NOT IN ('running','queued')` unless `force`). This is the G5
guard: a live session's AI calls never compete with more than two builds' worth of generation
on this instance.

### 3.3 Routes — `server/routes/warroomBuild.ts`, mounted at `/api/warroom/wizard/drafts/:id`

| Method | Path            | Body / query                              | Behaviour                                                                                                                                                                                                                                                                                 |
| ------ | --------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/build`        | `{ stages?: BuildStage[]; force?: bool }` | Owner/admin + `scenarioCreditGate`. Validates organisations (`resolveOrganisations`) **before** creating a build. Creates `build_state` (or resumes an `interrupted`/`failed` one from its first non-done stage), returns `{ build_id, status }`. 409 if a build is running and `!force`. |
| GET    | `/build`        | `?since=<log index>`                      | `{ build_state (log tail from since), generated_summary: { personas, injects, contacts, pages } }`. Cheap; polled every 3 s.                                                                                                                                                              |
| POST   | `/build/cancel` | —                                         | CAS → `cancelled`; the loop notices at its next step boundary (an in-flight AI call is not aborted in v1).                                                                                                                                                                                |
| GET    | `/review`       | —                                         | `assembleReviewState(input, generated)` — exactly what the Review step renders and what compile will use.                                                                                                                                                                                 |

Existing `/api/warroom/social-crisis/generate-*` and `/compile` routes stay for one release: the
wizard is their only UI caller, but `scripts/e2e-multi-org-generate.ts` / `e2e-multi-org-routes.ts`
drive them directly, and they are the fallback path while migration 209 is unapplied (§6). They go
once the E2E scripts target `/build`.

### 3.4 Restart safety

- **Boot** (`server/index.ts`, guarded by `env.runBackgroundEngines` like the other engines):
  `recoverOnBoot()` → for each draft with `build_state.status IN ('running','queued')`:
  `classifyRecovery(state, now, thisInstance)` → `interrupted` if `instance !== this` or
  `heartbeat_at` older than 90 s. Interrupted builds are **resumed automatically** (default
  `WARROOM_BUILD_AUTO_RESUME=true`), so a deploy costs one stage's duration and no human action.
  Log `warroom_build_recovered { draft_id, build_id, stage }`.
- **SIGTERM** (`shutdown()` in `server/index.ts`, touch point: one call): `interruptOnShutdown()`
  CAS-marks this instance's running builds `interrupted` **before** the 10 s grace window so the
  incoming instance's boot recovery picks them up within seconds of going live.
- **Crash / OOM** (no SIGTERM): covered by the stale-heartbeat rule at next boot.
- **Two instances briefly alive during a deploy** (Render zero-downtime): the retiring one marks
  `interrupted`; the new one resumes; the CAS on `build_id` guarantees only one writer even if the
  retiring loop is mid-`writeStageOutput` — its UPDATE's `WHERE build_state->>'build_id' = …`
  fails once the resume has issued a new `build_id`, and it stops.

### 3.5 Wizard changes — `SocialCrisisWizard.tsx`

- `generateAll()` → `POST …/build`, then a `useBuildStatus(draftId)` hook polling `GET …/build`
  every 3 s while `status ∈ {queued, running}`; **no give-up clock** — the server owns failure.
  Maps `build_state` → existing `buildStage`, `buildError`, `step3Progress` (from `log`),
  `loadingByKey`. New visible states: `queued` ("waiting for another build to finish"),
  `interrupted` ("the server restarted — resuming"), `cancelled`.
- Delete the client stage functions' orchestration and NDJSON readers (`generateNPCs`,
  `generateStoryline`, `generateConvergence`, `generateOrgPage`, the poll loops, `JOB_LOST_MESSAGE`,
  `STREAM_DROPPED_MESSAGE`). Keep `/footprint`, uploads, blueprint extraction (Setup-time, short).
- Resume: `GET /wizard/drafts/:id` now includes `build_state` and `generated` summary. If a build
  is running → Building step with live status (G2). If `done` and step 7 → Review from
  `GET …/review` (G3). "Build the scenario" on a resumed draft → `POST …/build` (true resume: only
  non-done stages run). Per-stage "Retry this stage" → `POST …/build { stages: [stage] }`.
- `buildDraftInput()` shrinks to Setup inputs. `saveDraftState()` still PATCHes `input` on Setup
  edits; a Setup edit after a build **invalidates** `generated` (server clears it and resets
  `build_state` when `input` changes materially — hash of the generation-relevant keys).
- Review step reads from `GET …/review`; Compile → `POST …/build { stages: ['compile'] }` and polls.
- Legacy drafts: the server's `legacyGeneratedFromInput()` lifts generated keys out of `input`
  when `generated` is null, so old Review-stage drafts open unchanged (G6).

### 3.6 Observability

Structured logs: `warroom_build_started | stage_started | stage_finished (ms) | stage_failed |
interrupted | recovered | done | cancelled` with `{ draft_id, build_id, stage, instance }`.
`GET …/build` exposes the same log tail to the trainer. A build older than 45 min in `running` with
a fresh heartbeat is logged as `warroom_build_slow` (not failed).

### 3.7 Phase 4 — quota and capacity isolation (after measurement)

- `OPENAI_API_KEY_GENERATION` (a second OpenAI project) — `chatClient` selects it for generator
  sites (`socialCrisis*`, `stakeholder*`, `pressureOrg*`, `castCompleteness`, `footprint`,
  `orgPage*`); after the Bedrock cutover the same switch selects a separate inference profile.
  Builds and live sessions then cannot 429 each other.
- `MAX_CONCURRENT_BUILDS` tuned from `npm run loadtest` with 10 simulated sessions on staging.
- Optional Render **Background Worker** running the same codebase with
  `WARROOM_BUILD_WORKER=true` (claims `queued` builds; the web instance only enqueues). Only if the
  web instance's event loop or memory shows pressure under load — 21 Sep metrics say it does not.

---

## 4. Unit tests (node:test, added to the `test` script)

`server/services/warroomBuild/buildCore.test.ts` — pure

| #   | Test                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `nextStage` returns stages in order, skips `done`, returns `null` when all done                                                                                  |
| C2  | `nextStage` with `stages: ['compile']` request runs only compile when 1–4 are done; 409-equivalent error if an upstream stage is not done                        |
| C3  | `markStageRunning` increments `attempts`, sets `started_at`, `state.stage`; does not mutate the input                                                            |
| C4  | `markStageFailed` records `error`, sets build `failed`, leaves other stages untouched                                                                            |
| C5  | `appendLog` caps at 200 entries keeping the newest                                                                                                               |
| C6  | `classifyRecovery`: running + heartbeat 30 s old + same instance → `leave`; heartbeat 120 s → `interrupt`; other instance → `interrupt`; `queued` → `requeue`    |
| C7  | `legacyGeneratedFromInput` lifts personas / fact_sheet / injects / charters / narrative … from an old `input` and returns `null` when none present               |
| C8  | `invalidatesGenerated(prevInput, nextInput)` true for crisis text / organisations / roster / pressure changes, false for `brand_logo_url` or `uploaded_doc_name` |

`server/services/warroomBuild/assemble.test.ts` — pure

| #   | Test                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Persona twins from storyline and pages join the crowd once (dedupe by `handle`)                                                                   |
| A2  | `intel_injects` are appended to the holder team's storyline; unknown team keys create the bucket                                                  |
| A3  | Pressure `pressure_injects` replace page-authored stakeholder injects (`delivery_config.page_org_key`) and leave others                           |
| A4  | Pressure org drafts gain `org_key` / `spokesperson_stakeholder_id` by case-insensitive display-name match; unmatched drafts unchanged             |
| A5  | Convergence stage input carries `team_storylines` plus `Shared: storyline.injects` only when injects exist                                        |
| A6  | Compile input equals what the wizard posts today for the multi-org fixture in `scripts/e2e-multi-org-generate.ts` (golden comparison, key by key) |
| A7  | Missing `pages` → review state has `org_page: null`, no throw (pages are optional today)                                                          |

`server/services/warroomBuild/buildService.test.ts` — fake store + fake stage runners

| #   | Test                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Happy path: five runners called in order with `stageInput` outputs; store receives one `writeStageOutput` per stage; final `status: 'done'`               |
| S2  | Storyline runner throws → characters output persisted, storyline `failed` with `describeGenerationFailure` text, convergence/pages never called           |
| S3  | `resumeBuild` after S2 calls storyline, convergence, pages only; characters `attempts` unchanged                                                          |
| S4  | CAS conflict (store reports 0 rows) → loop stops without further writes                                                                                   |
| S5  | Semaphore: third concurrent build stays `queued`; starts when one finishes                                                                                |
| S6  | `interruptOnShutdown` marks only this instance's running builds `interrupted`                                                                             |
| S7  | `recoverOnBoot` with auto-resume resumes interrupted builds and requeues queued ones; leaves a fresh-heartbeat build owned by another live instance alone |
| S8  | Heartbeat updates `heartbeat_at` at least once during a runner that takes > 30 s (fake timers)                                                            |
| S9  | Compile stage: credit consumed before, refunded on throw, `scenario_id` persisted on success                                                              |
| S10 | Cancel between stages → `cancelled`, next runner not called                                                                                               |

`server/routes/warroomBuild.test.ts` — route-level with a stubbed service (supertest-style via the
existing `validate` middleware): 403 non-trainer, 402 no credit, 400 bad organisations before any
state is written, 409 running build without `force`, 200 shapes.

**Live verification script** `scripts/e2e-warroom-build.ts` (against a local server sharing the
dev database, `RUN_BACKGROUND_ENGINES=false` except build recovery): create draft → `POST /build`
→ wait for `characters: done` → send `SIGTERM` to the local server → restart → assert the build
resumes at storyline, reaches `done`, and `POST /build {stages:['compile']}` yields a scenario id;
then load the scenario through `GET /api/scenarios/:id?include=summary` and compare counts with
`generated_summary`. Also: open the draft in a second "client" mid-build and assert `GET /build`
shows the same `build_id`.

---

## 5. Acceptance (manual, production-like)

| #   | Scenario                                                                             | Expected                                                                        |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| P1  | Start a two-country build, close the tab at Storyline, reopen the draft 10 min later | Building step shows Convergence/Pages in progress or Review ready               |
| P2  | Start a build, push a commit to `master` while Characters runs                       | Build shows `interrupted` for < 1 min, then resumes at Characters; done         |
| P3  | Storyline fails on a 429 burst                                                       | Stage `failed` with the rate-limit text; "Retry this stage" runs only Storyline |
| P4  | Two trainers build at once, a third starts                                           | Third shows `queued`, starts when one finishes                                  |
| P5  | Reopen the `Kestrel Aurora` (oil-spill) Review-stage draft from 20 Sep               | Review renders from legacy `input`; compile succeeds                            |
| P6  | Edit the crisis brief on a built draft                                               | Generated output cleared, Build required again; logo change does not clear      |
| P7  | Laptop asleep for 20 min mid-build                                                   | On wake the wizard polls once and shows the current state                       |
| P8  | Compile with 0 scenario credits                                                      | 402 before any state change; nothing generated is lost                          |

---

## 6. Rollout

1. Migration 209 (hand to the runtime agent / user to apply). The server detects missing columns
   (PostgREST `42703`) and logs `warroom_durable_builds_unavailable`; the wizard then falls back to
   the current client orchestration — so the code can ship before the migration.
2. Feature flag `WARROOM_SERVER_BUILDS` (server env; default **on**). No new config endpoint: the
   wizard simply calls `POST …/build` first; a `501 { code: 'DURABLE_BUILDS_UNAVAILABLE' }` (flag off
   or columns missing) makes it fall back to the client orchestration for that build.
3. Ship Phase 1+2+3 together (they are one code path); keep legacy routes one release.
4. Measure with `npm run loadtest` (10 sessions) + one build on staging; decide Phase 4.

---

## 7. Effort & commit plan

| Slice                                                                               | Effort |
| ----------------------------------------------------------------------------------- | ------ |
| 209 migration; `buildTypes`, `buildCore`, `assemble` + tests C1–C8, A1–A7           | ½ day  |
| `buildStore`, `stageRunners`, `buildService` + tests S1–S10; compile extraction     | 1 day  |
| Routes + route tests; boot/SIGTERM touch points in `server/index.ts`                | ½ day  |
| Wizard: `useBuildStatus`, Building/Review from server state, legacy loader, cleanup | 1 day  |
| E2E script, acceptance P1–P8 on staging, docs delivery record                       | ½ day  |

Commits, in order: `warroom-build: core + assemble (pure) + tests` → `warroom-build: store,
runners, service, compile extraction + tests` → `warroom-build: routes + boot/shutdown recovery`
→ `wizard: server-side builds (poll, resume, review from draft), legacy drafts` → `e2e + docs`.
Touch points outside my files: `server/index.ts` (two calls, marked in the commit message).

---

## 8. Open questions (defaults in bold)

1. Auto-resume interrupted builds on boot — **yes**; the alternative is a "Resume build" button.
2. Auto-run compile after Pages — **no**; trainer reviews first (credit is spent at compile).
3. Keep `/generate-*` routes one release as the fallback path and for the E2E scripts — **yes**.
4. Phase 4 second OpenAI project — needs a key from you; not blocking Phases 1–3.
