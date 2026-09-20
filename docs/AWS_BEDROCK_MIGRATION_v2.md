# AWS Bedrock Migration: Context, Decisions, and Work Plan (v2)

Status: PR 1 (text chat, 83/83 sites) implemented and verified in openai
mode; committed as ten reviewable commits on
`feat/aws-bedrock-pr1-shared-ai-client` (branched from `master` `876594b`).
PRs 2-3 (images, STT, video) not started. See section 11a.

Revision history

- v1 -- `docs/AWS_BEDROCK_MIGRATION.md`, verified against `master` on
  2026-09-19. Kept unchanged for historical reference.
- v2.0 -- 2026-09-20 morning, verified against the
  `cursor/aws-bedrock-migration-plan-34f7` working tree at HEAD `379eb12` plus
  uncommitted stakeholder / decision-layer work.
- v2.1 -- 2026-09-20 evening, verified against HEAD `cf41f0c`, clean tree.
  Between v2.0 and v2.1 about 45 commits landed (~100 server files, +20k
  lines): AI teammate bots, organic executive decisions, pressure engine,
  crisis footprint, War Room redesign. Section 0.1 lists what that changed for
  this plan.
- v2.2 -- 2026-09-21, same code baseline (`cf41f0c`). Recorded the owner's
  decision that AI research is not needed in field ops either.
- v2.3 -- 2026-09-21, later the same night. Owner clarified: the field-ops
  research retirement is **decided but deferred** -- replace it later with an
  internally curated knowledge pack (standards, forbidden actions, site
  requirements, hazard physics, demographics, injury types) and do not touch
  field-ops behaviour now. The migration proceeds for every AI call
  regardless. Consequence: the six web-search sites are converted to
  `standard`-tier plain chat (no live search) because
  `gpt-4o-search-preview` does not exist on Bedrock; the rest of the research
  pipeline migrates like any other site. Section 0.0 and 7.6.
- **v2.4 (this document) -- 2026-09-21, implementation session 2.** No
  decision changes. Section 11a now records PR 1 as code-complete: all 83
  chat sites on the shared client, all chat gates on `env.aiEnabled`,
  typecheck / build / 173 unit tests green, live smoke test in openai mode.

This document is the hand-off brief for whoever (human or agent) implements the
move of all AI inference from OpenAI / xAI direct APIs to AWS. Read it in full
before touching code. Section 0 lists what changed since v1; sections 1 to 3
are context and decisions; sections 4 onward are the actionable plan. Line
numbers are from `cf41f0c`; re-grep before editing.

---

## 0. Changes from v1

### 0.0 Decision recorded in v2.2 (2026-09-21): research is retired in both modules

- **Social crisis: already done.** The wizard's "Best Practices research"
  (`researchGeneralBestPractices`) and "Sentiment / similar incidents
  research" (`researchPublicSentiment`) steps were removed in `5513736`; the
  runtime consumers (content grader, cancellation gate, SOP builder) now read
  the built-in `RESPONSE_STANDARDS` (`server/config/responseStandards.ts`) via
  `initial_state.research_guidelines`. One leftover: `POST /research` in
  `routes/socialCrisisWarroom.ts` L822-870 (`getOrResearchTeamDoctrines` ->
  `researchBestPractices`, `socialCrisisGeneratorService.ts` L1670) has no
  caller in `frontend/src/lib/api.ts`. Dead code; delete in 7.6.
- **Field ops: decided, not yet done.** `warroomResearchService.ts` is still
  fully wired: the compile pipeline in `warroomService.ts` calls
  `researchSimilarCases` + `researchCrowdDynamics` (L391-415), `researchArea`
  (L509), `researchStandardsPerTeam` + `researchForbiddenActionsPerTeam`
  (L811-830), `researchTeamWorkflows` (L836) and
  `researchDeteriorationPhysics` (L1538) unconditionally; the current wizard
  (`frontend/src/pages/WarRoom.tsx` L1234-1238) still renders `ResearchStep`
  (step 6 of 7), which calls `/wizard/drafts/:id/research-doctrines`
  (`routes/warroom.ts` L772-1048); `researchDeteriorationPhysics` is also
  called from `routes/warroom.ts` L1312 and `routes/scenarios.ts` L2313; and
  `retry-custom-facts` (`routes/scenarios.ts` L2684) uses the search model.
  There is no flag that turns any of it off. The owner's decision (v2.2) is
  to retire it, following the social-crisis precedent, and (v2.3) to replace
  it with an **internally curated field-ops knowledge pack** -- standards and
  doctrines, forbidden actions, site requirements, hazard physics,
  demographics, injury types -- written into `insider_knowledge` at compile
  with zero AI calls. **Timing: deferred.** Field-ops behaviour is not
  changed by this migration. Consequences for this plan:
  - Web search is **not ported and not gated**: `AI_MODEL_SEARCH`,
    `AI_SEARCH_BASE_URL`, `RESEARCH_LIVE_SEARCH`, the `search` tier and
    `bedrock-mantle` are not needed. Instead the six search-model sites are
    **converted to `standard`-tier plain chat** as part of the migration
    (7.6). The research functions keep running and keep producing the same
    shapes; they lose live internet grounding, nothing else.
  - The 7.3 migration count stays at **83**. The 11 sites in
    `warroomResearchService.ts` and `retry-custom-facts` migrate like every
    other site; they are deleted only when the retirement lands.
  - When the retirement does land, removal is technically safe: every
    compile-time research call already has a `.catch(() => empty)` fallback,
    and the play-time consumers degrade gracefully when the data is absent
    (`decisionEvaluationOrchestrator.ts` L863-886 falls back to
    `UNIVERSAL_FORBIDDEN_ACTIONS` and no sector standards;
    `aiInjectSchedulerService.ts` L688-702 and `insiderService.ts` L907 omit
    the doctrine block). The full blueprint, corrected after a code walk on
    2026-09-21, is in 7.6.

### 0.1 New in v2.1 (evening re-audit, HEAD `cf41f0c`)

1. **Chat completion call sites: 82 -> 83; files: 43 -> 44.** The new site
   is `server/services/teammates/llmQueue.ts` (`post`, L179), the LLM path
   for the AI teammate bots (`docs/ai-teammate-bots-plan.md`). It is a third
   partial client (after `blueprint/llmClient.ts` and
   `warroomAiService.callOpenAi`) with semantics the shared client must
   preserve: one global sequential queue with an 800 ms inter-call pause, a
   per-session hourly budget (`TEAMMATE_BOTS_MAX_LLM_PER_HOUR`, default 400),
   a 45 s abort timeout, `llmStats` counters exposed to the bots route, and
   `fast` | `strong` tiers whose model IDs come from env
   (`TEAMMATE_BOTS_MODEL_FAST=gpt-4o-mini`,
   `TEAMMATE_BOTS_MODEL_STRONG=gpt-5.2`, `env.ts` L101-102).
2. **First use of strict `json_schema`.** `llmQueue.callJson` sends
   `response_format: { type: 'json_schema', json_schema: { name, strict: true,
schema } }` (L142-145) and, if the request fails, retries once with
   `json_object` and the schema inlined in the system prompt (L150-161). v2.0
   said `json_schema` was unused; that is retracted. New smoke check (8.5).
3. **The `temperature` risk is no longer hypothetical.** Commit `44e26d7`
   removed `temperature: 0.3` from `contentGraderService.ts` because
   `gpt-5.5` returned HTTP 400 for any non-default temperature, and every
   grade silently landed on `defaultGrade`. That is exactly the failure mode
   v2.0 predicted for GPT-5.6 on Bedrock, observed on OpenAI first. The
   shared client's temperature policy (7.2) is now a requirement, not a
   precaution: ~70 request bodies still send `temperature`.
4. **Two more boot workers drive AI calls on timers** (`server/index.ts`
   L90, L94), six in total:
   - `engineTicker.startGeneratorEngines()` -- every 60 s, for every
     in-progress `social_media` session, runs the pressure engine and the
     organic decision tick (`engineTicker.ts` L17, L67-68). Gated by
     `ENABLE_EXECUTIVE_DECISIONS`, **ON by default in every environment
     including production** (`env.ts` L73). Reaches
     `npcReactionService`, `callSocialCrisisAI` and `contentGraderService`.
   - `teammateBotService.startReconciler()` -- every 60 s, rebuilds bot
     runtime for in-progress sessions (`teammateBotService.ts` L29, L80-82).
     Gated by `ENABLE_TEAMMATE_BOTS`, ON in dev, OFF in production unless set
     (`env.ts` L94-96).
     This matters for staging isolation (9.1), for Bedrock quotas and cost
     (7.3), and for the comparison run (8.13).
5. **New AI consumers that add no fetch but add load and prompts**:
   `crisisFootprintService.ts` L2, `decisions/decisionDetectionService.ts`
   L9, `decisions/decisionPlannerService.ts` L8,
   `decisions/decisionCascadeService.ts` L14 all call
   `callSocialCrisisAI` (= `socialCrisisGeneratorService.callAI`, exported at
   L449); `decisionCascadeService.ts` L22 also calls `gradePlayerContent`;
   `pressureEngineService.ts` L5 calls `triggerNPCReactions`;
   `stakeholderReplyService.ts` L16 calls `decideAndReply`
   (`stakeholderReconsiderationService.callJudge`). Their prompts run on
   whatever model the underlying site uses and must be part of the
   side-by-side comparison (8.13).
6. **Gating grew**: ~88 -> **~91** `openAiApiKey` truthiness checks in **50**
   files (new: `teammates/brain.ts` L300, `teammates/llmQueue.ts` L127,
   `pressureEngineService.ts` L158). The identifier now appears ~499 times in
   67 files. `brain.ts` L300 also records the fallback reason string
   `'no OPENAI_API_KEY'`, which is provider-named.
7. **Request-shape counts**: `max_tokens` 51 (unchanged),
   `max_completion_tokens` 31 -> **32**, `temperature` ~70 (contentGrader's
   removed, none in `llmQueue`), abort timeouts 1 -> **2**
   (`socialCrisisGeneratorService.ts` L414 at 240 s, `llmQueue.ts` L186 at
   45 s).
8. **Model IDs in env for the first time** (`TEAMMATE_BOTS_MODEL_FAST` /
   `_STRONG`, documented in `docs/ENV_TEMPLATE.md` L52-53). Under Bedrock
   these must either be set to Bedrock model IDs or, better, default to the
   tier models (`AI_MODEL_FAST` / `AI_MODEL_STANDARD`). Section 6 and open
   decision #10.
9. Line numbers moved again in `routes/scenarios.ts` (direct env reads now
   L1931, L2259, L2534, L2827, L2906, L2990) and in the social-crisis
   services; everything else is where v2.0 said.
10. `npm test` now runs 17 test files (decision cores, pressure engine,
    footprint, org model, validation, bot intellect and triage). All pure
    logic; still no LLM coverage.
11. New cross-references: `docs/ai-teammate-bots-plan.md` (D11 and section
    11 for the LLM budget; the architecture diagram at L78 names OpenAI),
    `docs/executive-decisions-organic-plan.md` (sections 5-6, 9),
    `docs/pressure-organisations-plan.md`.

### 0.2 Changes from v1 (carried from v2.0)

Inventory drift:

- Chat completion call sites: 81 (v1) -> 82 (v2.0) -> 83 (v2.1).
  `stakeholderReconsiderationService.ts` (`callJudge`, `gpt-5.2`, raw
  `JSON.parse`, gates on `env.openAiApiKey`) is now committed.
- `warroomAiService.callOpenAi` call sites: ~25 -> 29 (multi-org and
  stakeholder generation phases). Still one helper.
- Correction: v1 listed `chatSurveillanceService.ts` and
  `statementWatchdogService.ts` among the "duplicated `callAI` helpers". They
  are inline fetches inside methods, not named helpers. Same work.

Gaps v1 did not cover (all folded into sections 4, 7, 8, 12 below):

1. **Request-shape risk on a reasoning-class model.** 51 sites send
   `max_tokens` (fast tier + search), 32 send `max_completion_tokens`; ~70
   request bodies set a non-default `temperature`; no site sets
   `reasoning_effort`; several fast-tier completion ceilings are 30-150
   tokens. Now confirmed for `temperature` by `44e26d7` (0.1 item 3).
2. **Vision inputs are all remote HTTPS URLs** (Supabase Storage). No site
   inlines base64. The Bedrock OpenAI-compatible path must be verified to
   fetch remote `image_url`; fallback is download-and-inline in the client.
3. **STT sites are not multipart uploads.** `routes/ai.ts` receives a raw
   `audio/webm;codecs=opus` body from the browser recorder; `routes/voice.ts`
   is a post-call batch loop over recordings already in Supabase Storage.
   Transcribe streaming accepts only PCM / OGG-Opus / FLAC, so WebM/Opus
   needs demuxing or a recorder change; Transcribe batch accepts WebM
   directly but needs S3 + an async job. v1's "pick streaming" is revised per
   site (7.5).
4. **Gating is a larger surface than one bullet** (0.1 item 6 for current
   numbers).
5. **The Vercel bridge (`api/index.ts`) mounts AI-reaching routers** and
   imports `server/env.ts`. Unchanged since v2.0 (no `api/` commits). It is
   probably dormant in production, but the 7.1 env validation must not make
   it throw on cold start, and this must be confirmed (section 9.0).
6. Minor: a frontend string names OpenAI to end users; the untracked
   `demo-run/` tooling calls OpenAI directly (including TTS) and breaks when
   `OPENAI_API_KEY` is removed.

---

## 1. Why we are doing this

Corporate clients run crisis-team training through this app. Their scenario
prompts, uploaded documents, participant messages, public statements, and voice
input all pass through LLM calls. Today every one of those calls goes to
`api.openai.com` (and one to `api.x.ai`).

Goal: be able to state to clients, truthfully and contractually, that

> All AI processing runs on AWS inside our account boundary. Inputs and outputs
> are not used to train any model and are not shared with any model provider.

Amazon Bedrock makes that statement true for text, vision, web search, image and
video. Amazon Transcribe (not Bedrock) covers speech-to-text once an AWS
Organizations opt-out policy is set. Details in section 3.

Not a goal: self-hosting open-weight models. That was evaluated and deferred;
notes are in section 10 in case it is revisited.

---

## 2. What Bedrock is and is not (verified against AWS docs, Sept 2026)

- Bedrock is a managed, multi-tenant AWS service. It is not "our own server",
  it is AWS-hosted inference inside the AWS trust boundary, like S3 or RDS.
- Model providers (OpenAI, Anthropic, Stability, Luma, ...) have no access to
  the Bedrock deployment accounts, logs, prompts or completions.
- AWS commits, service-wide, that inputs/outputs are never used to train
  foundation models and never shared with model providers. Provider content
  sharing is not supported on Bedrock at all today (the old
  `provider_data_share` retention mode is legacy and does nothing).
- Data retention is controlled by an account/project setting
  (`data_retention_mode`): `none` (zero retention), `default` (AWS may retain
  for abuse detection, still not shared with providers), `aws_review` (AWS
  staff may review, required by a few models). We will use `none`, enforced by
  SCP. Some models require `aws_review` and simply show as unavailable under
  `none`, which is the desired fail-safe.
- OpenAI models on Bedrock (as of Sept 2026): GPT-5.6 Sol (frontier, most
  expensive), GPT-5.6 Terra (balanced), GPT-5.6 Luna (fast/cheap), GPT-5.4,
  GPT-5.5, and open-weight `gpt-oss-20b` / `gpt-oss-120b`. All GPT-5.6 tiers
  accept text + image input, return text, support JSON/structured output,
  function calling, streaming. None generate images or audio.
- OpenAI image models (`gpt-image-*`), Whisper, and the Responses API
  `image_generation` tool are NOT on Bedrock.
- Two endpoints, both take a Bedrock API key as `Authorization: Bearer`:
  - `https://bedrock-runtime.<region>.amazonaws.com/openai/v1/...`
    (recommended; GPT models only via cross-region profiles
    `us.openai.gpt-5.6-*` / `global.openai.gpt-5.6-*`; no in-region for GPT).
  - `https://bedrock-mantle.<region>.api.aws/openai/v1/...`
    (in-region GPT in us-east-1 / us-east-2; the ONLY endpoint with the
    server-side `web_search` tool, via the Responses API).
- Amazon Transcribe DEFAULTS to using voice inputs for service improvement.
  Must opt out via AWS Organizations AI services opt-out policy
  (`"default": {"opt_out_policy": {"@@assign": "optOut"}}`). Bedrock needs no
  such opt-out.
- Do not build on Amazon Nova Canvas or Nova Reel: both reach end-of-life on
  2026-09-30. Image: Stability Stable Image family. Video: Luma Ray2
  (`luma.ray-v2:0`, us-west-2 only, async, output to S3).
- Not yet verified (section 8 smoke checks): whether the GPT-5.6 tiers accept
  non-default `temperature` (OpenAI's own `gpt-5.5` does not, see 0.1 item
  3), whether they consume reasoning tokens inside `max_completion_tokens` by
  default, whether strict `json_schema` is honoured on the OpenAI-compatible
  path, and whether that path fetches remote `image_url` values.
- Quotas: Bedrock enforces per-model, per-region requests-per-minute and
  tokens-per-minute service quotas on the account. The bots and the engine
  ticker (0.1 item 4) add periodic load on top of interactive use; check and
  raise quotas before the staging run (7.3, 8.14).

---

## 3. Capability map: today vs target

| Capability       | Today                                                                             | Sites                | AWS target                                                                                                                                         | Auth            | Notes                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat / JSON      | OpenAI chat completions (`gpt-4o-mini`, `gpt-4`, `gpt-5.1`, `gpt-5.2`, `gpt-5.5`) | 83                   | Bedrock `bedrock-runtime` `/openai/v1/chat/completions`; Luna for fast tier, Terra for standard tier                                               | Bedrock API key | Same request/response shape as OpenAI. 51 sites send `max_tokens`, 32 send `max_completion_tokens`; ~70 set `temperature`; 1 uses strict `json_schema`. Client normalises (7.2).           |
| Vision           | same, with `image_url` content                                                    | 5 (subset of the 83) | Same endpoint, GPT-5.6 accepts image input                                                                                                         | Bedrock API key | All 5 pass remote HTTPS URLs (Supabase Storage); 3 add `detail: 'high'`. Verify remote fetch or inline base64.                                                                             |
| Web search       | `gpt-4o-search-preview` via chat completions                                      | 6                    | **Converted to `standard`-tier plain chat** (no live search) as part of the migration; field-ops research retirement is decided but deferred (7.6) | Bedrock API key | The search model does not exist on Bedrock and live search would leave the AWS boundary. No `bedrock-mantle`, no `search` tier. Same functions, same output shapes, no internet grounding. |
| Image generation | `gpt-image-2` via `/v1/images/generations`                                        | 4                    | Bedrock `InvokeModel`, Stability Stable Image (e.g. `stability.stable-image-core-v1:1`)                                                            | IAM (AWS SDK)   | Different payload; re-tune prompts; text-in-image weaker. 2 sites read `data[0].url`, 2 read `b64_json`.                                                                                   |
| Speech-to-text   | `whisper-1` via `/v1/audio/transcriptions`                                        | 2                    | Amazon Transcribe (not Bedrock)                                                                                                                    | IAM (AWS SDK)   | Not multipart: one raw WebM/Opus body (live), one batch over stored recordings. Streaming needs PCM/OGG-Opus/FLAC; batch accepts WebM but needs S3. Needs org opt-out.                     |
| Video            | xAI `grok-imagine-video`                                                          | 1                    | Bedrock `StartAsyncInvoke`, Luma Ray2, or feature-flag off                                                                                         | IAM (AWS SDK)   | 5/9 s clips, us-west-2 only, S3 output; lowest priority                                                                                                                                    |

Frontend never calls a provider directly. The only frontend change that may
be needed is the voice recorder format if streaming Transcribe is chosen
(7.5), plus one user-facing string that names OpenAI (7.8).

---

## 4. Current code inventory (HEAD `cf41f0c`, 2026-09-20 evening)

Counts: `rg -o "api\.(openai|x)\.(com|ai)/v1/[a-zA-Z/_\-]+" server --no-filename | sort | uniq -c`
(the xAI video site builds its URL from a `XAI_BASE` constant and is counted
separately).

- 83 x `https://api.openai.com/v1/chat/completions`
- 4 x `https://api.openai.com/v1/images/generations`
- 2 x `https://api.openai.com/v1/audio/transcriptions`
- 1 x `https://api.x.ai/v1/videos/generations` (+ poll), via `XAI_BASE`
  (`mediaGenerationService.ts` L28)
- 44 files under `server/` contain a provider URL.
- No AI SDK, no AWS SDK, no shared client. Every call is a hand-written
  `fetch`. `package.json` has neither `openai` nor `@aws-sdk/*` (unchanged
  since v1; only Playwright dev dependencies and test entries were added).

### 4.1 Request shapes actually in use (drives 7.2)

- Completion ceiling: **51** sites send `max_tokens` (every `gpt-4o-mini`,
  `gpt-4` and `gpt-4o-search-preview` site), **32** send
  `max_completion_tokens` (every `gpt-5.x` site, `llmClient`, `llmQueue`).
  51 + 32 = 83.
- `temperature`: ~70 request bodies set it explicitly (0 to 0.95), plus
  `blueprint/llmClient.ts`, which always sends it (default 0.2). Sites that
  do not: `warroomAiService.callOpenAi`, `contentGraderService` (removed in
  `44e26d7` after `gpt-5.5` returned 400 on `temperature: 0.3`),
  `stakeholderReconsiderationService`, `teammates/llmQueue`, and the four
  `callAI` helpers (the second, non-helper site in `ambientContentService`,
  L1357, does set it).
- Evidence of model behaviour: `gpt-5.1` / `gpt-5.2` sites send
  `temperature` today and work (e.g. `npcMessengerService.ts` L140-186:
  `gpt-5.2`, `temperature: 0.85`); `gpt-5.5` rejects it. Assume GPT-5.6
  behaves like 5.5 until smoke check 8.3 says otherwise.
- Very small fast-tier ceilings (at risk if the target model reasons inside
  the budget): `insiderService.ts` L220 (`max_tokens: 30`),
  `incidentDecisionGradingService.ts` L98 and L156 (`50`),
  `decisionEvaluationAiService.ts` L120 (`120`), L61 and L179 (`150`),
  `aiService.ts` L1577 (`150`), `hospitalCapacityService.ts` L68 (`150`).
- Structured output: `response_format: { type: 'json_object' }` is sent by
  most chat sites. **One site uses strict `json_schema`**
  (`teammates/llmQueue.ts` L142-145) with an automatic `json_object`
  fallback (L150-161). The 11 sites in `warroomResearchService.ts` send no
  `response_format` and parse loosely themselves.
- Not used anywhere: `reasoning_effort`, `stream`, `tools` / `tool_choice`,
  `seed`, `logprobs`, `top_p`, `frequency_penalty` / `presence_penalty`,
  `stop`, `role: 'developer'` / `'tool'` messages, `web_search_options`.
  `n: 1` appears only on the 4 image sites. The chat surface to port is
  plain messages + json_object (+ one json_schema) + ceiling + temperature.
- Roughly 55 sites `JSON.parse` the raw `choices[0].message.content` with no
  fence stripping or repair (including `stakeholderReconsiderationService.ts`
  L427 and `llmQueue.ts` L168). Only `llmClient.parseJsonLoose` and
  `warroomAiService.repairTruncatedJson` are tolerant.
- Timeouts: two AI fetches abort on a timer --
  `socialCrisisGeneratorService.callAI` (`AbortSignal.timeout(240_000)`,
  L414) and `llmQueue.post` (`AbortSignal.timeout(45_000)`, L186). No other
  AI fetch aborts.
- Rate limiting / budgets: only `llmQueue.ts` has any (global sequential
  queue, 800 ms pause, per-session hourly budget, L14-74). Everything else
  fires concurrently and relies on OpenAI's 429 handling (which only
  `llmClient` retries).
- Token usage is not logged anywhere (`usage.prompt_tokens` etc. never read).
- Vision: `rtsSceneEnrichmentService.ts` L244, L389, L951
  (`{ type: 'image_url', image_url: { url: photoUrl, detail: 'high' } }`),
  `rtsVisionService.ts` L52 and `rtsCasualtyService.ts` L219 (`url` only).
  Every URL is a remote HTTPS URL (Supabase Storage / caller-supplied). No
  `data:image/...` inputs exist server-side.
- Images: `rtsCasualtyService.ts` L93-95 and L150-152 send
  `size: '1792x1024' | '1024x1024'`, `quality: 'standard'`,
  `response_format: 'url'` and read `data[0].url` (L109);
  `chatSurveillanceService.ts` L360-361 and `mediaGenerationService.ts` L107
  send `size: '1024x1024'`, `quality: 'medium'` and read `b64_json` (L376-377
  and L128-129).

### 4.2 Model selection

Literal strings (`rg -o "model: ['\"][a-z0-9.\-]+['\"]" server`) plus
constants and env:

- `gpt-4o-mini` x37 literal, plus via constants: `demoAIAgentService.ts`
  `AI_MODEL` (L112; used L1847, L5214, L5755), `demoScriptGeneratorService.ts`
  `AI_MODEL` (L10; used L53), `decisionEvaluationOrchestrator.ts` `EVAL_MODEL`
  (L95; used L111); and via env: `env.teammateBotsModelFast`
  (`TEAMMATE_BOTS_MODEL_FAST`, default `gpt-4o-mini`, `env.ts` L101, used
  `llmQueue.ts` L132).
- `gpt-5.2` x16 literal, plus `BLUEPRINT_TEXT_MODEL`
  (`blueprint/blueprintConfig.ts` L11) used by `llmClient` and
  `scenarioDirectorService.ts` L189; and via env: `env.teammateBotsModelStrong`
  (`TEAMMATE_BOTS_MODEL_STRONG`, default `gpt-5.2`, `env.ts` L102).
- `gpt-5.1` x9 literal, plus `rtsSceneEnrichmentService.ts` `AI_MODEL` (L11;
  used L288, L416, L549, L982).
- `gpt-4` x3, `gpt-5.5` x1, `gpt-image-2` x4, `grok-imagine-video` x1.
- `SEARCH_MODEL = 'gpt-4o-search-preview'` at `warroomResearchService.ts` L13,
  used at L226, L564, L965, L1486, L1616; and at `routes/scenarios.ts` L2648,
  used at L2691. Total web-search sites: 6.
- The bots already think in tiers (`'fast' | 'strong'`, `llmQueue.ts` L104;
  chosen in `brain.ts` L303, forced `strong` for the critique pass L376).
  `strong` maps to the plan's `standard`.

### 4.3 Key handling and gating

- `server/env.ts` L44-45: `openAiApiKey: process.env.OPENAI_API_KEY`,
  `xaiApiKey: process.env.XAI_API_KEY`. No `AI_PROVIDER` or AWS variables
  exist yet. Feature flags that gate AI-driven behaviour:
  `enableAutoInjects` (L61-63), `enableStakeholderEngine` (L69),
  `enableExecutiveDecisions` (L73), `enableScenarioDirector` (L87-89),
  `enableTeammateBots` (L94-96).
- `server/routes/scenarios.ts` reads `process.env.OPENAI_API_KEY` directly in
  6 places (L1931, L2259, L2534, L2827, L2906, L2990), bypassing `env`. Must
  be replaced.
- Most services take `openAiApiKey: string` as a parameter and build the fetch
  themselves. The identifier `openAiApiKey` appears ~499 times across 67
  files (`warroomAiService.ts` alone: 100; `aiService.ts`: 35;
  `warroomService.ts` and `warroomResearchService.ts`: 26 each;
  `decisionEvaluationOrchestrator.ts`: 25; `routes/warroom.ts`: 21).
- ~91 truthiness checks (`if (!env.openAiApiKey)`, `if (openAiApiKey)`, ...)
  across ~50 files gate AI features on the OpenAI key. These include every
  boot worker and engine: `injectSchedulerService.ts` L67,
  `aiInjectSchedulerService.ts` L266 (and L653, L932-990, L1254),
  `chatSurveillanceService.ts` L134 (and L309, L346),
  `statementWatchdogService.ts` L200 (and L480), `pressureEngineService.ts`
  L158, `teammates/llmQueue.ts` L127, `teammates/brain.ts` L300 (which also
  stores the reason string `'no OPENAI_API_KEY'`). Every one must move to a
  provider-agnostic `env.aiEnabled`, or removing `OPENAI_API_KEY` after
  cutover silently disables the feature.

### 4.4 Existing partial wrappers (seed for the shared client)

- `server/services/blueprint/llmClient.ts` -> `openAiJson()` (L56; fetch
  L71): retries on 429/5xx, tolerant JSON extraction (`parseJsonLoose`, L34),
  `max_completion_tokens`, `response_format: json_object`, always sends
  `temperature`. Used by blueprint extraction and scenario director only.
- `server/services/warroomAiService.ts` `callOpenAi<T>()` (L1862; fetch
  L1871; `gpt-5.1` L1878): file-local helper used by 29 War Room generation
  phases in the same file. `repairTruncatedJson` at L1826.
- **`server/services/teammates/llmQueue.ts` -> `callJson<T>()`** (L126; fetch
  in `post`, L179): global sequential queue + inter-call pause, per-session
  hourly budget with `budgetStatus` / `forgetBudget` (L76-96, consumed by
  `teammateBotService.ts` L16), tier -> env model, strict `json_schema` with
  `json_object` fallback, 45 s timeout, `llmStats`. The budget and queue are
  product behaviour (bots plan D11) and must survive consolidation.
- Duplicated file-local `callAI()` helpers in `antagonistEngineService.ts`
  L26, `extremistHiveService.ts` L74, `ambientContentService.ts` L511,
  `socialCrisisGeneratorService.ts` L402 (exported as `callSocialCrisisAI`
  at L449 and now the AI path for footprint inference, decision detection,
  planning and cascade).
- `chatSurveillanceService.ts` (L311, L350) and `statementWatchdogService.ts`
  (L482) have inline fetches, not named helpers.

### 4.5 Call sites by area (fetch lines; re-grep before editing)

Routes

- `server/routes/ai.ts` L115 STT `whisper-1`. Handler `POST /transcribe`
  (L88-113) takes a raw `audio/*` body (`express.raw`, 10 MB limit), wraps it
  in `FormData`, `language: 'en'`. Live voice-input UX.
- `server/routes/voice.ts` L134 STT `whisper-1`. Loop (L113-157) downloads
  each recording from the `voice-recordings` Supabase bucket, transcribes,
  writes `voice_recordings.transcript`. Post-call batch.
- `server/routes/scenarios.ts` L2684 search (`retry-custom-facts`,
  `SEARCH_MODEL` L2648/L2691, `max_tokens: 5000`); L2872, L2951, L3030 chat
  `gpt-4o-mini` (patient/hazard/crowd enrichment).

Core

- `server/services/aiService.ts` 12 sites, `gpt-4o-mini`, JSON mode: L89,
  L231, L443, L612, L720, L857, L1001, L1187, L1415, L1549, L1703, L2414
  (scenario gen, decision classification, escalation pathways, sentiment,
  objective evaluation, inject-from-decision)
- `server/services/blueprint/llmClient.ts` L71 (wrapper), `blueprintConfig.ts`
  (`BLUEPRINT_TEXT_MODEL = 'gpt-5.2'`)

War Room (field ops)

- `server/services/warroomAiService.ts` `callOpenAi` L1871 (`gpt-5.1`, JSON),
  29 phases including multi-org / stakeholder generation
- `server/services/warroomPromptParser.ts` L251 `gpt-4o-mini`
- `server/services/warroomResearchService.ts` (model lines; several fetches
  span two lines): SEARCH sites at L226 (`researchArea`), L564
  (`researchStandardsPerTeam`), L965 (`fetchSimilarCasesFromInternet`), L1486
  (`researchTeamWorkflows`), L1616 (`researchCrowdDynamics`); `gpt-5.1`
  plain-chat sites at L326, L395, L454 (structured extractors), L697
  (`researchForbiddenActionsPerTeam`), L1367 (`mapStandardsToTeams`), L1754
  (`researchDeteriorationPhysics`; its doc comment at L1678 mentions the
  search model but the call uses `gpt-5.1`). None send `response_format`.

Social crisis (all chat sites `gpt-5.2`, JSON mode, unless noted)

- `socialCrisisAiService.ts` L70; `socialCrisisGeneratorService.ts` L410
  (`callAI` L402 / `callSocialCrisisAI` L449; abort timeout L414);
  `antagonistEngineService.ts` L34; `extremistHiveService.ts` L82;
  `ambientContentService.ts` L568, L1357; `feedEngineService.ts` L338;
  `npcMessengerService.ts` L140, L447; `npcEmailReplyService.ts` L502;
  `npcReactionService.ts` L231; `chatSurveillanceService.ts` L311 (chat),
  L350 (IMAGE `gpt-image-2`); `statementWatchdogService.ts` L482;
  `contentDisputeService.ts` L125; `contentGraderService.ts` L227 (`gpt-5.5`,
  no temperature since `44e26d7`); `mediaGenerationService.ts` L96 (IMAGE),
  L178 + L232 (xAI VIDEO); `aarSocialSectionService.ts` L840
- `stakeholderReconsiderationService.ts` `callJudge` (gate L347; fetch L404;
  `gpt-5.2` L408; `max_completion_tokens: 1800` L413; raw `JSON.parse`
  L427). In-character stakeholder reply + inject verdict judge
  (`docs/stakeholder-runtime-plan.md`); also the grievance resolver used by
  the decision cascade (`decisionCascadeService.ts` L20).

AI teammate bots (`docs/ai-teammate-bots-plan.md`) -- new in v2.1

- `teammates/llmQueue.ts` `post` L179 (`callJson` L126). Models from
  `env.teammateBotsModelFast` / `Strong` (L132). Callers: `teammates/brain.ts`
  (tier choice L303, critique pass L345-376, deterministic fallback when no
  key L300). `teammates/apiClient.ts` L42 calls this server's own REST API
  on loopback (`TEAMMATE_BOTS_API_BASE`) as the bot user; it is not a
  provider call.
- Load: bots plan section 11 estimates ~2 LLM calls per bot-minute at
  intellect 80 with critique (4 bots ≈ 5-6 calls/min), capped at 400 per
  session per hour.

Generator-owned runtime engines -- new in v2.1 (no fetch of their own)

- `engineTicker.ts` (60 s tick, L17) -> `pressureEngineService.runPressureEngine`
  (-> `npcReactionService.triggerNPCReactions`, gate L158) and
  `decisions/decisionCascadeService.runDecisionTick` (-> `callSocialCrisisAI`,
  `gradePlayerContent`, stakeholder reply/judge).
- `decisions/decisionDetectionService.ts` and `decisionPlannerService.ts`
  -> `callSocialCrisisAI` (detection hooks fire on player content).
- `crisisFootprintService.ts` -> `callSocialCrisisAI` (wizard-time
  inference).
- `pressureOrgGenerationService.ts`, `stakeholderGenerationService.ts`,
  `multiOrgPipeline.ts` -> `warroomAiService.callOpenAi` phases.

Decision / environment / hospital / insider (`gpt-4o-mini`, JSON) -- unchanged

- `decisionEvaluationAiService.ts` L48, L107, L166, L273, L405
- `decisionEvaluationOrchestrator.ts` L104
- `decisionCasualtyEffectsService.ts` L155
- `incidentDecisionGradingService.ts` L78, L132
- `heatMeterService.ts` L230, L551, L695
- `scenarioStateService.ts` L307
- `stateEffectManagementService.ts` L118
- `environmentalConditionManagementService.ts` L190
- `environmentalConsistencyService.ts` L1074
- `transportOutcomeService.ts` L32, L162
- `hospitalCapacityService.ts` L56
- `insiderService.ts` L185, L977

RTS / vision (`gpt-5.1`) -- unchanged

- `rtsVisionService.ts` L69 (vision)
- `rtsCasualtyService.ts` L83, L140 (IMAGE `gpt-image-2`), L229 (vision)
- `rtsSceneEnrichmentService.ts` L284, L412, L978 (vision), L545 (text)

Demo / AAR

- `demoAIAgentService.ts` L262, L1840, L5207, L5748 (`gpt-4o-mini`)
- `demoScriptGeneratorService.ts` L46 (`gpt-4o-mini`)
- `aarAiService.ts` L212, L321 (`gpt-4`)
- `aarSectionService.ts` L467 (`gpt-4`)
- `aarSocialSectionService.ts` L840 (`gpt-5.2`)

Indirect callers that only gate on `env.openAiApiKey` and pass it down (no
fetch of their own): `pathwayOutcomesService.ts`, `injectSchedulerService.ts`,
`injectTriggerService.ts`, `aiInjectSchedulerService.ts`,
`gateEvaluationService.ts`, `objectiveEvaluationService.ts`,
`objectiveTrackingService.ts`, `environmentalPrerequisiteService.ts`,
`demoActionDispatcher.ts`, `blueprint/scenarioDirectorService.ts`,
`blueprint/blueprintExtractionService.ts`, `stakeholderReplyService.ts`
(L283), `pressureEngineService.ts` (L158), `teammates/brain.ts` (L300),
routes `warroom.ts`, `insider.ts`, `hospital.ts`, `decisions.ts`,
`sessions.ts`, `debug.ts`, `aar.ts`. New routes `execDecisions.ts`,
`teammateBots.ts`, `scenarioStakeholders.ts` make no provider calls.

### 4.6 Provider references outside `server/`

- `api/index.ts` (Vercel serverless bridge) imports `server/env.ts` (L12) and
  mounts `scenariosRouter` (L72), `sessionsRouter` (L73), `decisionsRouter`
  (L75), `aarRouter` (L80) and `aiRouter` (L81), all of which reach AI call
  sites. It does not start the background workers. Unchanged since v2.0. See
  9.0.
- `frontend/src/components/Forms/CreateScenarioForm.tsx` L133 shows the user
  "Failed to generate scenario. Please check your OpenAI API key
  configuration." Cosmetic; contradicts the section 11 statement.
- `frontend/src/hooks/useVoiceInput.ts` L35-37 and `useCallRecorder.ts`
  L20-22 record `audio/webm;codecs=opus` (fallback `audio/webm`) and POST the
  raw blob with that `Content-Type`. Relevant to 7.5.
- `frontend/src/lib/api.ts` L9: `VITE_API_URL || ''`; when empty, requests go
  same-origin (i.e. to the Vercel bridge).
- `demo-run/` (untracked marketing / demo tooling, not shipped): direct OpenAI
  calls in `brain.ts` L416 (chat), `netcheck.ts` L36 and `watchdog.ts` L129
  (`/v1/models` probes), `walkthrough.ts` L118 (TTS `/v1/audio/speech`, a
  capability the product itself does not use). These break when
  `OPENAI_API_KEY` is removed in 7.8. (`demo-run/config.ts` is also the seed
  for the bot personas, per bots plan D4.)
- `test-grok-video.mjs` (repo root) hits `api.x.ai` directly.
- `docs/ENV_TEMPLATE.md` L16-17 documents `OPENAI_API_KEY` and an unused
  `OPENAI_MODEL=gpt-4o` (no code reads it); L52-53 document
  `TEAMMATE_BOTS_MODEL_FAST` / `_STRONG`.
- `docs/ai-teammate-bots-plan.md` L78 (architecture diagram) and D11 name
  OpenAI as the provider; update wording after cutover.

Tests: `npm test` runs 17 files (blueprint merge/types/director logic,
extremist doctrine, stakeholder contract and recipients, decision
detection/planner/knowledge cores, cast completeness, crisis footprint,
pressure engine, scenario org model, scenario validation, pressure org
generation, bot intellect and triage). All pure logic; none cover any LLM
call.

---

## 5. Design decisions (already made; do not re-open without reason)

1. **Provider switch by env, not by branch.** `AI_PROVIDER=openai|bedrock`,
   default `openai`. The refactor merges to `master` with production behaviour
   unchanged; cutover is flipping the variable on the production backend;
   rollback is flipping it back. No code redeploy needed for either (Render
   does restart the process when env vars change; see 9.2).
2. **One shared chat client, tier-based.** Generalise
   `server/services/blueprint/llmClient.ts`. Callers pass a tier
   (`fast` | `standard` | `vision` | `search`), never a model name. Model IDs
   per tier come from env. Keep its retry/backoff and tolerant JSON parsing
   and apply them everywhere (roughly 55 current sites `JSON.parse` the raw
   content directly). Support both `json_object` and strict `json_schema`
   (with `llmQueue`'s fallback behaviour) so the bots can move onto it.
3. **Tier mapping.** `gpt-4o-mini`, `gpt-4` -> `fast`. `gpt-5.1`, `gpt-5.2`,
   `gpt-5.5` -> `standard`. The bots' `strong` -> `standard`. Vision sites ->
   `vision` (same model as standard unless configured otherwise).
   `gpt-4o-search-preview` -> `standard` as plain chat, no web search (7.6;
   the sites are deleted only when the deferred retirement lands). Bedrock
   defaults: fast =
   `us.openai.gpt-5.6-luna`, standard/vision = `us.openai.gpt-5.6-terra`. Do
   NOT default everything to Sol; it is ~10x the cost of Luna and not needed
   for these tasks.
4. **`response_format: json_object` stays** in requests. OpenAI's Bedrock guide
   lists structured outputs as supported. Verify with one request early
   (section 8). Tolerant parsing is the insurance.
5. **Non-text capabilities go through the AWS SDK**, not the OpenAI-compatible
   path: `@aws-sdk/client-bedrock-runtime` for images (and video if kept),
   `@aws-sdk/client-transcribe` / `client-transcribe-streaming` for STT. IAM
   credentials via standard AWS env vars / role.
6. **Web search: dropped, not ported.** The six search-model sites become
   `standard`-tier plain chat in the migration (7.6). Field-ops research
   itself is **retired later** (decided 2026-09-21, deferred): replaced by an
   internal knowledge pack the way social crisis replaced its research with
   `RESPONSE_STANDARDS` in `5513736`. No Responses API port, no
   `bedrock-mantle`, no live-search flag, no field-ops behaviour change in
   this migration beyond the loss of internet grounding.
7. **Video is last and optional.** One call site; feature-flag off is
   acceptable.
8. **Testing uses a full duplicate staging stack** (section 9): separate
   Supabase project, separate Render service, separate Vercel project. Do not
   point a second backend at the production database (see 9.1 for why).
9. **Request-shape normalisation lives in the shared client, not at call
   sites.** The client always emits `max_completion_tokens`, applies the
   provider's `temperature` policy (now evidence-based: `44e26d7`), enforces a
   minimum completion floor and no-reasoning mode for the fast tier under
   Bedrock if the smoke checks show reasoning tokens eat the budget, and sets
   a timeout. Call sites pass intent (`maxTokens`, `temperature`), never
   provider syntax.
10. **New AI features land on the shared client.** Anything merged after the
    client exists must not add another raw
    `fetch('https://api.openai.com/...')`. Since v2.0 one more did
    (`llmQueue.ts`); it is the first migration target in 7.3.
11. **Budgets and serialisation are client features** (new in v2.1).
    `llmQueue`'s per-caller hourly budget and sequential queue move into (or
    wrap) the shared client as optional per-call `budgetKey` / `serialize`
    options, so the bots keep their cost cap and other high-frequency callers
    (engine ticker, NPC reactions) can opt in under Bedrock quotas.

---

## 6. Environment variables

Add to `server/env.ts` (and document in `docs/ENV_TEMPLATE.md`):

```env
# Provider switch. openai keeps current behaviour exactly.
AI_PROVIDER=openai            # openai | bedrock

# Bedrock (used when AI_PROVIDER=bedrock)
AI_REGION=us-east-1
AI_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1
AI_API_KEY=                   # Bedrock API key (Bearer). Long-term key from Bedrock console.
AI_MODEL_FAST=us.openai.gpt-5.6-luna
AI_MODEL_STANDARD=us.openai.gpt-5.6-terra
AI_MODEL_VISION=us.openai.gpt-5.6-terra
# (v2.2) AI_MODEL_SEARCH and AI_SEARCH_BASE_URL are no longer needed: web search is
# removed, not ported (7.6). Listed for history only.

# Shared client behaviour (both providers; optional, shown with defaults)
AI_TIMEOUT_MS=120000          # per-request abort; long generation phases may override per call
AI_FAST_MIN_COMPLETION_TOKENS=0   # raise (e.g. 256) if smoke check 8.4 shows reasoning eats tiny budgets
AI_TEMPERATURE_POLICY=auto    # auto | pass | strip. auto = strip for models known to reject (gpt-5.5, and
                              # GPT-5.6 if 8.3 fails), pass otherwise

# Per-feature model overrides (optional). If unset, resolve to the tier model above.
TEAMMATE_BOTS_MODEL_FAST=     # existing var; today defaults to gpt-4o-mini -> should default to AI_MODEL_FAST
TEAMMATE_BOTS_MODEL_STRONG=   # existing var; today defaults to gpt-5.2     -> should default to AI_MODEL_STANDARD

# Non-text (AWS SDK, IAM). Standard AWS credential chain.
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AI_IMAGE_MODEL_ID=stability.stable-image-core-v1:1
AI_STT_MODE=batch             # batch | streaming (see 7.5)
AI_STT_S3_BUCKET=             # required for batch mode
AI_VIDEO_ENABLED=false
AI_VIDEO_MODEL_ID=luma.ray-v2:0
AI_VIDEO_S3_BUCKET=
AI_VIDEO_REGION=us-west-2

# (v2.2) RESEARCH_LIVE_SEARCH is no longer needed: field-ops research is retired outright (7.6),
# so there is nothing to gate.

# Existing, retained until cutover is complete, then removed
OPENAI_API_KEY=
XAI_API_KEY=
```

Derived in `env.ts`: `aiEnabled` = (`AI_PROVIDER=openai` and `OPENAI_API_KEY`
set) or (`AI_PROVIDER=bedrock` and `AI_API_KEY` set). All ~91 gating checks
(4.3) switch to it. The existing feature flags (`enableAutoInjects`,
`enableStakeholderEngine`, `enableExecutiveDecisions`,
`enableScenarioDirector`, `enableTeammateBots`) stay as they are; they gate
_whether_ a feature runs, `aiEnabled` gates _whether it may call a model_.

When `AI_PROVIDER=openai`, the shared client must produce byte-identical
requests to today's (URL `https://api.openai.com/v1/chat/completions`, Bearer
`OPENAI_API_KEY`, current model names, and the same ceiling key the site uses
today if exact parity is wanted for the comparison run). Tier -> OpenAI model
map for that mode: fast = `gpt-4o-mini`, standard = `gpt-5.2` (accept that
`gpt-5.1`/`gpt-5.5`/`gpt-4` sites collapse onto it, or keep a per-call
`modelOverride` for exact parity during the comparison run), vision =
`gpt-5.1`. (No `search` entry: the search sites are removed in 7.6, not
migrated.)

Remove the unused `OPENAI_MODEL` from `docs/ENV_TEMPLATE.md` (no code reads
it).

---

## 7. Work plan

Each step is a separate commit / reviewable unit. Steps 1-3 are the first PR.

### 7.1 Env plumbing

- Extend `server/env.ts` with the variables above and the derived
  `aiEnabled`. Validate: if `AI_PROVIDER=bedrock` then `AI_API_KEY` and
  `AI_BASE_URL` are required.
- Make `teammateBotsModelFast` / `teammateBotsModelStrong` default to the
  tier models instead of hardcoded OpenAI names (`env.ts` L101-102).
- `api/index.ts` imports `server/env.ts` at module load. The validation must
  only throw when `AI_PROVIDER=bedrock` is actually set, so a Vercel project
  without the Bedrock variables keeps cold-starting (section 9.0).
- Replace the 6 direct `process.env.OPENAI_API_KEY` reads in
  `server/routes/scenarios.ts` (L1931, L2259, L2534, L2827, L2906, L2990)
  with the shared client (they should not need a key at all once migrated).

### 7.2 Shared chat client

- New module, e.g. `server/services/ai/chatClient.ts` (or promote
  `blueprint/llmClient.ts`). API sketch:

```ts
export type AiTier = 'fast' | 'standard' | 'vision'; // 'search' dropped in v2.2 (7.6)
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}
export interface ChatOptions {
  tier: AiTier;
  messages: ChatMessage[];
  json?: boolean | { schemaName: string; schema: Record<string, unknown> }; // json_object, or strict json_schema with json_object fallback
  maxTokens?: number; // always emitted as max_completion_tokens
  temperature?: number; // subject to AI_TEMPERATURE_POLICY
  timeoutMs?: number; // default AI_TIMEOUT_MS
  budgetKey?: string; // optional per-key hourly budget (bots: sessionId)
  serialize?: boolean; // optional: run through the global sequential queue
  modelOverride?: string; // escape hatch during migration only
  retry?: { attempts?: number };
  label?: string; // for logs and stats
}
export async function chat(opts: ChatOptions): Promise<{ content: string; raw: unknown } | null>;
export async function chatJson<T>(opts: ChatOptions): Promise<T | null>; // tolerant parse
export function stats(label?: string): {
  calls: number;
  failures: number;
  budgetDenied: number;
  lastError: string | null;
};
export function budgetStatus(key: string): { used: number; limit: number; resetsInMs: number };
```

- Resolve URL / key / model from env by `AI_PROVIDER` and tier.
- Normalise the ceiling: always send `max_completion_tokens`. 51 sites
  currently send `max_tokens`; they pass `maxTokens` and stop caring.
- `temperature` policy (`AI_TEMPERATURE_POLICY`): `auto` strips it for models
  known to reject it -- `gpt-5.5` today (`44e26d7`) and GPT-5.6 if smoke
  check 8.3 fails -- and logs once per model. A rejected parameter must never
  again surface as a silent `null` / default-grade at 70 call sites.
- Fast-tier floor: if smoke check 8.4 shows GPT-5.6 Luna spends reasoning
  tokens inside the budget, apply `AI_FAST_MIN_COMPLETION_TOKENS` (or the
  provider's no-reasoning setting) under `bedrock`. The 30-150 token sites in
  4.1 are the canaries.
- Structured output: `json: true` -> `json_object`; `json: { schemaName,
schema }` -> strict `json_schema`, and on a 4xx retry once with
  `json_object` + schema inlined in the system prompt (port `llmQueue.ts`
  L150-161 verbatim). Smoke check 8.5 decides whether Bedrock ever gets the
  `json_schema` variant or goes straight to the fallback.
- Vision: keep OpenAI content-part shape. If smoke check 8.2 shows remote
  `image_url` is not fetched by Bedrock, the client downloads the URL
  (Supabase Storage, same trust boundary) and inlines a `data:` URL. Callers
  do not change.
- Timeout via `AbortSignal.timeout(timeoutMs)`; treat abort like a 5xx for
  retry purposes. Today only two sites have any timeout.
- Budget + queue: port `llmQueue.ts` L14-96 (sequential drain with pause,
  per-key hourly window, `budgetStatus`, `forgetBudget`) as opt-in
  `budgetKey` / `serialize`. The bots route keeps reading `budgetStatus`.
- Keep `parseJsonLoose` and `repairTruncatedJson` (currently in
  `warroomAiService.ts` L1826) reachable from the client.
- Retry 429/5xx with backoff; never throw to callers that currently expect
  `null` on failure.
- Log provider, tier, model, latency, and token usage per call (no prompt
  content in logs). Nothing reads `usage` today; add it here once. Keep
  per-label counters so `llmStats` consumers keep working.

### 7.3 Migrate chat + vision sites (83, of which 5 are vision)

- Replace every `fetch('https://api.openai.com/v1/chat/completions', ...)`
  with `chat()` / `chatJson()`. Order: `teammates/llmQueue.ts` first (it is
  the only site with budget/queue/json_schema semantics, so it proves the
  client's feature set; make `callJson` a thin wrapper), then
  `stakeholderReconsiderationService.callJudge`, then the four `callAI`
  helpers (which now carry the footprint, decision and pressure engines), then
  `warroomAiService.callOpenAi`, then the long tail.
- Remove the `openAiApiKey` parameters threaded through service signatures
  where they become unused, or leave them as no-ops for a smaller diff and
  clean up in a follow-up. Sizing for that decision (section 12, #5): ~499
  occurrences in 67 files; `warroomAiService.ts` (100), `aiService.ts` (35),
  `warroomService.ts` (26), `warroomResearchService.ts` (26),
  `decisionEvaluationOrchestrator.ts` (25), `routes/warroom.ts` (21) carry
  most of it.
- Delete the four duplicated `callAI` helpers and `warroomAiService.callOpenAi`
  in favour of the shared client (or make them thin wrappers first; the 29
  `callOpenAi` phases and the many `callSocialCrisisAI` importers make the
  wrapper route attractive).
- Vision sites: keep OpenAI content-part shape
  (`{ type: 'image_url', image_url: { url, detail } }`); the client handles
  remote-vs-inline (7.2).
- Gating: switch all ~91 `openAiApiKey` truthiness checks (4.3) to
  `env.aiEnabled`, and rename the `'no OPENAI_API_KEY'` fallback reason in
  `teammates/brain.ts` L300 to something provider-neutral. Grep
  `openAiApiKey` after the migration; the count must be zero outside `env.ts`
  and the client.
- Re-tune, do not just port, the 8 tiny-ceiling sites in 4.1 if 8.4 shows a
  problem.
- Load profile and quotas (new in v2.1): the engine ticker runs every 60 s
  per in-progress social session, bots add up to 400 calls/session/hour, and
  detection hooks fire on player content. Before the staging run, look up the
  Bedrock RPM/TPM quotas for `gpt-5.6-luna` / `-terra` in the chosen region
  and request increases if a realistic session (8.13) would exceed them.
  Consider `serialize: true` for the ticker-driven callers.

### 7.4 Images (4 sites)

- Add `@aws-sdk/client-bedrock-runtime`.
- New `server/services/ai/imageClient.ts` with `generateImage({ prompt,
aspectRatio, seed? }) -> { base64 }`, switching on `AI_PROVIDER`
  (`openai` keeps today's `/images/generations` call).
- Sites: `chatSurveillanceService.generateNewsGraphic` (L350),
  `mediaGenerationService.generatePostImage` (L96),
  `rtsCasualtyService` L83 and L140.
- Map `size` -> `aspect_ratio`; drop `quality` (`'standard'` and `'medium'`
  today). `rtsCasualtyService` asks for `response_format: 'url'` and reads
  `data[0].url` (L109); it must accept base64 (or upload to storage and
  return that URL, which is what should happen anyway). The other two already
  read `b64_json`.
- Re-tune the four prompts and eyeball output; news graphics with overlaid
  text are the weakest case on Stability.

### 7.5 Speech-to-text (2 sites)

The two sites have different shapes and should be treated separately:

- `server/routes/ai.ts` `POST /ai/transcribe` (fetch L115): live voice input.
  Receives one raw body, `audio/webm;codecs=opus` from `useVoiceInput.ts`
  (fallback `audio/webm`; `wav`/`mp4` accepted but not produced by the
  current recorder), up to 10 MB, `language: 'en'`. Latency-sensitive.
- `server/routes/voice.ts` (fetch L134): post-call batch. Downloads each
  recording from the `voice-recordings` Supabase bucket and writes
  `voice_recordings.transcript`. Already asynchronous; latency irrelevant.

Amazon Transcribe constraints that drive the choice:

- Batch (`StartTranscriptionJob`) accepts WebM, WAV, MP4 and others directly,
  but the audio must be in S3 and the job is asynchronous (typically seconds
  for short clips). Flow: put object -> start job -> poll -> read transcript
  -> delete object. Zero frontend change.
- Streaming (`StartStreamTranscription`) accepts only PCM, OGG-Opus and FLAC.
  A WebM/Opus blob must be demuxed to Opus packets (or transcoded to PCM)
  server-side, or the recorder must be changed to produce WAV/PCM, which is a
  frontend change. Lower latency; no S3.

Plan:

- New `server/services/ai/transcribeClient.ts`, switching on `AI_PROVIDER`
  and `AI_STT_MODE`. `openai` keeps today's Whisper call.
- `voice.ts`: batch mode. The audio is already stored; copy to S3 (or grant
  Transcribe access to a mirror bucket), run the job, delete.
- `ai.ts`: default to batch as well for the first cut (adds a few seconds to
  the voice-input round trip; measure it on staging). If that is unacceptable
  for the UX, implement streaming with a server-side WebM->Opus demux, or
  change `useVoiceInput.ts` to record 16 kHz PCM/WAV, and accept the
  frontend change. Decision recorded in section 12, #6.
- Prerequisite outside code: AWS Organizations AI services opt-out policy.
- `language: 'en'` maps to `LanguageCode: 'en-US'` (or enable language
  identification if non-English sessions are expected).

### 7.6 Web-search sites now; field-ops research retirement later

**Now (part of the migration, own commit before or inside PR 1):** convert
the six `gpt-4o-search-preview` sites to `standard`-tier plain chat.

- Sites: `warroomResearchService.ts` `researchArea` (model line L226),
  `researchStandardsPerTeam` (L564), `fetchSimilarCasesFromInternet` (L965),
  `researchTeamWorkflows` (L1486), `researchCrowdDynamics` (L1616);
  `routes/scenarios.ts` `retry-custom-facts` (L2691).
- Change: `tier: 'standard'`, `maxTokens` instead of `max_tokens: 10000`,
  no `response_format` change (these parse loosely today), keep the existing
  `.catch` fallbacks. Reword "use ONLY real documented incidents / real
  sources" to "draw on well-documented incidents and standards you are
  confident about; mark uncertain figures approximate; return an empty list
  rather than guess". `retry-custom-facts` also drops the
  `scenario_research_usage` join and the `research_archive` block only when
  the retirement lands; for now it keeps them and just changes model.
- This is a deliberate behaviour change (no live grounding), so it is its
  own commit with its own before/after scenario comparison; the
  `AI_PROVIDER=openai` regression baseline (8.9-8.11) is taken _after_ it.
- The `research_cases` cache keeps being written by `researchSimilarCases`;
  `RESEARCH_LIVE_SEARCH` is not introduced.

**Later (decided 2026-09-21, deferred; no field-ops behaviour change in this
migration):** retire the research pipeline and replace its outputs with an
internally curated **field-ops knowledge pack** -- per team preset:
standards/doctrines, forbidden actions, site requirements; per scenario type
/ weapon class: hazard physics and deterioration references, crowd and
demographic profiles, injury-type distributions -- written into
`insider_knowledge` (and the generation prompts) at compile with zero AI
calls. The former Options A (gate + seed library) and B (Responses API port)
are withdrawn. Everything below is the blueprint for that later work, kept
current so it can start without another audit.

What `warroomResearchService.ts` contains, by kind:

- **Web-search dossiers** (`SEARCH_MODEL`, 5 sites): `researchArea` (L157,
  2000-5000-word venue dossier), `researchStandardsPerTeam` (L488, per-team
  standards + `site_requirements`), `fetchSimilarCasesFromInternet` inside
  `researchSimilarCases` (L799, cache-first on `research_cases`),
  `researchTeamWorkflows` (L1440), `researchCrowdDynamics` (L1535). Plus the
  6th search site outside the file: `retry-custom-facts` in
  `routes/scenarios.ts` L2684.
- **Model-knowledge extractors** (`gpt-5.1`, 6 sites, no search): the three
  structured extractors that post-process the area dossier
  (`extractAreaResearchStructured` L253, `inferHazardMaterialContext` L350,
  `extractSensitiveInfrastructureStructured` L418), `mapStandardsToTeams`
  (L1329, needs the standards findings as input), and two that stand alone:
  `researchForbiddenActionsPerTeam` (L641) and `researchDeteriorationPhysics`
  (L1681).
- **Pure helpers** (`*ToPromptBlock`, `findCachedResearchCases`,
  `persistResearchCases`, `linkResearchToScenario`, `extractSettingTags`).

Who consumes the output:

- Generation time: `warroomService.ts` (69 references) and
  `warroomAiService.ts` (72) feed similar cases, crowd dynamics, area
  dossier, standards, doctrines, forbidden actions and workflows into the
  scenario-generation prompts; `routes/warroom.ts` (38) runs the wizard's
  research step and passes results to compile.
- Play time, via `scenarios.insider_knowledge`: `team_doctrines` is read by
  `decisionEvaluationOrchestrator.ts` L863 (decision grading),
  `aiInjectSchedulerService.ts` L688 and L1137, `insiderService.ts` L907,
  `environmentalConsistencyService.ts` L748, `demoScriptGeneratorService.ts`
  L200, `demoAIAgentService.ts` L2624; `forbidden_actions` by
  `decisionEvaluationOrchestrator.ts` L878; `site_requirements` by
  `insiderService.ts` L57 and placement. **All of these already handle absence**:
  grading falls back to `UNIVERSAL_FORBIDDEN_ACTIONS` and an empty
  `sectorStandards`; the others skip the block.
- UI: `frontend/src/pages/WarRoom.tsx` step 6 (`ResearchStep`, L1234-1238;
  `STEP_LABELS` L22; gating on `researchResults` L496-497, L842),
  `LocationValidationStep.tsx` L220 ("Area Research Summary"),
  `CompileStep.tsx` L42/L113 copy, scenario detail via `GET
/scenarios/:id/research` (`routes/scenarios.ts` L574,
  `api.getScenarioResearch` L689), and the still-routed `WarRoomLegacy.tsx`
  (`main.tsx` L15).

Corrections from the 2026-09-21 code walk (they change the blueprint):

- The wizard's "Research" step (`WarRoom.tsx` step 6, `ResearchStep.tsx`,
  route `POST /wizard/drafts/:id/research-doctrines`, `routes/warroom.ts`
  L772-1053) is **not only research**. The same route runs
  `stageTeamsAndNarrative` (teams + core narrative -> `phase1_preview`,
  which the compile route hard-requires at L1090) and the trainer-scene
  auto-enrichment (`enrichScene`, persisted to
  `rts_scene_configs.enrichment_result` for the scene canvas). So the step
  is **kept and renamed** (e.g. "Preview"), and only
  `stageResearchDoctrines` + the area dossier + the research UI sections
  ("Per-Team Doctrines & Standards" with workflows, "General Standards &
  References", "Area Research Summary") are replaced. The doctrines panel can
  stay as a read-only view of the knowledge pack.
- The compile route reads `draft.doctrines` / `draft.validated_doctrines`
  (`routes/warroom.ts` L1101-1116); with the pack it computes standards from
  the constant instead, and the trainer-edit flow (`validated_doctrines`,
  `api.wizardDraftPatch`) is retired with it.
- The team presets to key the pack on are `TEAM_INVENTORY` in `WarRoom.tsx`
  L67-106: Bomb Squad / EOD, Medical Triage, Hazards / Fire / Rescue,
  Evacuation, Media & Communications, Pursuit & Investigation, Incident
  Command, Police / Security. `resolveTeamDoctrines`
  (`environmentalConsistencyService.ts` L22-50, duplicated in
  `aiInjectSchedulerService.ts` L22) matches exact -> normalised -> substring,
  so the pack should carry alias keywords and be written under the
  scenario's actual team names at compile.
- Output shapes the pack must produce: `StandardsFinding { domain, source,
key_points[], decision_thresholds?, site_requirements? }`,
  `ForbiddenAction { action, why, exception }`, `SiteRequirement`
  (`warroomResearchService.ts` L108-151, L635-639).
- `generateDeteriorationTimeline` (`warroomAiService.ts` L7376) takes the
  physics pre-pass as a plain string; when the pre-pass goes, the pack's
  physics references replace that string at its three call sites
  (`warroomService.ts` L1538-1580, `routes/warroom.ts` L1308-1360,
  `routes/scenarios.ts` L2264-2333).
- `retry-custom-facts` (`routes/scenarios.ts` L2523-2733) regenerates
  `insider_knowledge.custom_facts` (normally produced by generation phase 4c,
  `warroomAiService.ts` L5513-5601); it should survive as a plain chat call,
  minus the `scenario_research_usage` join and `research_archive` block.
- `WarRoomLegacy.tsx` (routed at `/warroom-legacy`, `main.tsx` L149; nothing
  links to it) calls the research API in three places (L600, L726, L2662)
  and renders editable doctrines + workflows (L1721-1870). Adapt or delete
  with the retirement.
- The scenario detail view has a "Research" tab (`ScenarioDetailView.tsx`
  L266, L1392-1399) fed by `GET /scenarios/:id/research` and
  `api.getScenarioResearch` (L689); it goes with the `research_cases` reads.

Removal, in order (when the retirement is scheduled):

1. Author the knowledge pack (`server/config/fieldOpsKnowledge.ts` or
   similar): per preset standards/forbidden/site requirements; per scenario
   type / weapon class physics, crowd/demographic and injury-type references;
   plus a resolver from any team name to a preset via aliases.
2. Wizard: rename step 6 to Preview; strip the research sections and the
   area summary; keep teams/narrative/enrichment; rename the route and
   `api.wizardDraftResearchDoctrines`; delete the non-draft
   `/wizard/research-doctrines` route (L1204) and `api.wizardResearchDoctrines`
   (unused by the current wizard); remove `LocationValidationStep`'s "Area
   Research Summary" and `CompileStep`'s research copy.
3. Compile pipeline, `warroomService.ts`: remove the calls at L391-415, L509,
   L811-830, L836, L1538-1580; feed the pack into `researchContext`
   (`standards_findings`, `team_doctrines`, `forbidden_actions`; the
   persistence at `warroomAiService.ts` L8555-8577 and `warroomService.ts`
   L1521-1531 then works unchanged); remove `similar_cases` /
   `crowd_dynamics` / area fields and their prompt blocks in
   `warroomAiService.ts` (`buildResearchContextBlock` L960-1035 and the
   per-phase blocks at L2013-2019, L3467-3469, L3573-3576, L4050-4052,
   L4069, L4100-4103, L4681-4683, L4708, L4864-4866, L4885, L5811, L5951,
   L6083, L6249, the archive at L8585-8598 and the workflow call at
   L8610-8624); remove the `research_cases` persistence at L1708-1728.
4. `routes/scenarios.ts`: `retry-custom-facts` loses its research inputs;
   the three `research_cases(...)` reads at L2209, L2564, L2768 and
   `GET /:id/research` (L574) are dropped, with the detail view's Research
   tab and `api.getScenarioResearch`.
5. `warroomResearchService.ts`: delete the 5 search functions, the dossier
   extractors, `mapStandardsToTeams`, `researchForbiddenActionsPerTeam`,
   `researchDeteriorationPhysics`, the cache helpers and `SEARCH_MODEL`;
   keep the interfaces and `*ToPromptBlock` helpers (play-time consumers
   import them: `decisionEvaluationOrchestrator.ts` L29-34,
   `aiInjectSchedulerService.ts` L692, L1141, `environmentalConsistencyService.ts`
   L752, `insiderService.ts` L57-60).
6. Social crisis leftover: delete `POST /research` in
   `routes/socialCrisisWarroom.ts` L822-870, `researchBestPractices`
   (`socialCrisisGeneratorService.ts` L1670) and `doctrineCacheService.ts` if
   nothing else imports it.
7. `WarRoomLegacy.tsx`: adapt the three call sites or delete the page and
   its route. Keep or drop the `research_cases` table (no migration needed to
   keep it).

Scope: **(iii) chosen** (2026-09-21) and broadened from "standards" to the
knowledge pack described above. (i) and (ii) are recorded for history only:
(i) retire everything with grading on universal rules; (ii) keep
`researchForbiddenActionsPerTeam` and `researchDeteriorationPhysics` as
plain generation calls.

Existing hard guardrails (`THREAT_HAZARD_RULES`, threat-profile FORBIDDEN
block, `MAX_VICTIM_PINS`, `VALID_INJECT_TYPES`, `validatePinTopology`) do not
depend on research and are unaffected. Reword any generation prompt that
says "use ONLY real documented incidents" to "draw on well-documented
incidents you are confident about; mark uncertain figures approximate".

### 7.7 Video (1 site)

- `mediaGenerationService.generateVideo` (L178 start, L232 poll; `XAI_BASE`
  L28; gated on `env.xaiApiKey` L166). Either `AI_VIDEO_ENABLED=false`
  short-circuit returning null (callers already tolerate absence), or
  implement `StartAsyncInvoke` -> poll `GetAsyncInvoke` -> read clip from S3
  with Luma Ray2 in us-west-2.

### 7.8 Cleanup after cutover

- Remove `openai` branches from the clients, `OPENAI_API_KEY`, `XAI_API_KEY`,
  `test-grok-video.mjs`.
- Replace the user-facing string at
  `frontend/src/components/Forms/CreateScenarioForm.tsx` L133 with
  provider-neutral wording.
- Decide what to do with `demo-run/` tooling (untracked): give it its own
  key handling or point it at the shared client; it is not covered by the
  client claim but will stop working.
- Update `docs/ENV_TEMPLATE.md` (drop `OPENAI_MODEL`, document section 6,
  re-describe `TEAMMATE_BOTS_MODEL_*` as overrides), `docs/TECH_STACK.md`,
  `docs/ARCHITECTURE.md`, and the provider wording in
  `docs/ai-teammate-bots-plan.md` (L78 diagram, D11).

### 7.9 Recommended alongside (not blocking)

- Field-ops document upload: extend the blueprint pipeline
  (`blueprint/blueprintExtractionService.ts`, `ScenarioBlueprint`) that
  currently only feeds the social crisis War Room, so trainers can ground
  field-ops scenarios in their own threat assessments / SOPs. Hook points:
  `warroomAiService.generateTeamsAndCore`, hazards, casualties, inject prompts
  (mirror `buildStorylineGuidance` etc. in `socialCrisisGeneratorService.ts`).

---

## 8. Verification checklist

Early smoke checks (one request each, before migrating 83 sites). Items 3-5
and 7 decide client behaviour in 7.2:

1. Bedrock chat completions with `response_format: { type: 'json_object' }`
   returns valid JSON on Luna and Terra.
2. Vision request with `image_url` pointing at a **remote HTTPS URL** (a real
   Supabase Storage object, not a `data:` URL), with and without
   `detail: 'high'`, succeeds on Terra. If it fails, the client inlines.
3. `temperature: 0.2` and `temperature: 0.85` accepted on Luna and Terra
   (that is what the sites send). Expect rejection, given `gpt-5.5` already
   rejects on OpenAI (`44e26d7`). If rejected, `AI_TEMPERATURE_POLICY=auto`
   strips it under `bedrock`.
4. A fast-tier JSON request with `max_completion_tokens: 30` (copy
   `insiderService.ts` L220's prompt) returns usable content on Luna. If the
   content is empty or truncated because reasoning consumed the budget, set
   the no-reasoning option or `AI_FAST_MIN_COMPLETION_TOKENS` and re-test.
5. Strict `json_schema` (copy one of the bots' schemas from
   `teammates/brain.ts`) is honoured on Luna and Terra. If
   not, the client goes straight to the `json_object` + inlined-schema
   fallback under `bedrock`.
6. `max_tokens` is rejected or ignored (confirms the normalisation in 7.2 is
   required, not optional); `max_completion_tokens` accepted.
7. Model IDs resolve: `us.openai.gpt-5.6-luna`, `us.openai.gpt-5.6-terra`
   in the chosen region. IAM identity has `bedrock:InvokeModel` on the
   inference profile AND on `arn:aws:bedrock:<region>:<acct>:project/default`.
   Note the account's RPM/TPM quotas for both models.
8. Error shape: a deliberate 4xx/429 from Bedrock carries an HTTP status the
   retry logic keys on (it retries on status, not on OpenAI's error body).

After migration, `AI_PROVIDER=openai` regression (must be behaviour-neutral): 9. `npm run lint`, `npm run build`, `npm test` pass (17 test files). 10. `rg openAiApiKey server` returns hits only in `env.ts` and the client;
`rg "api\.openai\.com" server` returns hits only in the client;
`rg OPENAI_API_KEY server` returns hits only in `env.ts`. 11. Generate one field-ops War Room scenario and one multi-org social crisis
scenario on the branch with `AI_PROVIDER=openai`; confirm output is
comparable to `master` (same model names hit; check logs). Include a
session with bots enabled so `llmQueue`'s budget accounting is exercised
through the client.

Bedrock comparison (staging stack, section 9): 12. Same two scenario prompts with `AI_PROVIDER=bedrock`. Compare side by
side: core narrative, team list, hazard count/types (must respect
`THREAT_HAZARD_RULES`), casualty totals, victim triage mix, inject stream
(types, timing, count), crisis footprint, pressure organisations and
AI-operated offices, stakeholder roster, NPC replies, stakeholder judge
verdicts (`callJudge`), content grader verdicts, AAR summary. 13. Play a short multi-org social session end to end with
`ENABLE_TEAMMATE_BOTS=true` and `ENABLE_EXECUTIVE_DECISIONS=true`:
decisions detected and cascaded, pressure engine posts, bots act within
budget (`GET /api/sessions/:id/bots` returns the per-session LLM
`budget` used/limit via `budgetStatus`), gates evaluated,
injects fire, surveillance/watchdog react, stakeholder replies arrive, AAR
generates. Watch for 429s in the logs; this is the quota test. 14. Voice input transcribes (measure round-trip if batch mode); post-call
recordings transcribe; NPC post image generates; (video if enabled). 15. Check CloudTrail shows Bedrock and Transcribe calls from the staging
identity only; check spend in Cost Explorer is in the expected range for
the run (bots and the ticker make cost per session-hour the useful unit).

Cutover: 16. Confirm the production Vercel project sets `VITE_API_URL` to the Render
backend (9.0) so no AI traffic reaches `api/index.ts`. 17. Merge to `master` with `AI_PROVIDER=openai` (no behaviour change). 18. Set `AI_PROVIDER=bedrock` + Bedrock vars on the production backend in a
quiet window (Render restarts the process). Watch logs for the first
sessions. Rollback = set `AI_PROVIDER=openai`. 19. After a stable period, remove OpenAI/xAI keys from production and do 7.8.

---

## 9. Test environment (decided: full duplicate staging stack)

Deployment topology today: Vercel serves `frontend/dist` plus a thin serverless
bridge in `api/index.ts` (subset of routes, no WebSockets). The real backend
`server/index.ts` runs on Render (or similar) because it needs WebSockets. ALL
AI calls live in `server/`, so a Vercel-only staging project would test almost
nothing; the staging backend is what matters.

### 9.0 The Vercel bridge is not AI-free

`api/index.ts` mounts `/api/scenarios`, `/api/sessions`, `/api/decisions`,
`/api/aar` and `/api/ai` (L72-81), i.e. scenario generation, decision
classification, AAR and Whisper STT can execute inside a Vercel function if
traffic reaches it. `vercel.json` has no `/api/(.*)` rewrite to the function,
and `frontend/src/lib/api.ts` uses same-origin only when `VITE_API_URL` is
empty, so in practice the bridge is dormant when the Vercel project sets
`VITE_API_URL` to Render. Confirm that (checklist 16). Consequences:

- Do not set `AI_PROVIDER=bedrock` on the Vercel project unless it also has
  the Bedrock variables, or the 7.1 validation will throw on cold start.
- If the bridge is ever meant to serve AI routes, it needs the same AWS/Bedrock
  env as Render, the AWS SDK adds cold-start weight, and streaming Transcribe
  is a poor fit for a short-lived function (another reason 7.5 defaults to
  batch).
- Simplest hardening: drop the AI-reaching routers from `api/index.ts` so the
  bridge cannot become an accidental second inference path.

### 9.1 Why not share the production database

`server/index.ts` unconditionally starts **six** background workers on boot:

- inject scheduler (L73-74; `enableAutoInjects`-gated at
  `injectSchedulerService.ts` L230),
- AI inject scheduler (L77-78; no enable flag, key-gated),
- chat surveillance (L81-82; no enable flag, key-gated at L134),
- statement watchdog (L85-86; no enable flag, key-gated at L200),
- generator engines ticker (L90; `enableExecutiveDecisions`, **ON by default
  everywhere**; every 60 s runs the pressure engine and decision tick for
  every in-progress social session),
- teammate bot reconciler (L94; `enableTeammateBots`, OFF in production by
  default; every 60 s rebuilds bot runtimes and lets bots act as players).

A second backend on the same Supabase would double-fire injects, NPC
reactions, pressure posts and decision cascades on live sessions, have two
bot runtimes acting for the same accounts, write test rows into production
tables, and pollute the shared `research_cases` cache with Bedrock-generated
cases. Do not do it.

### 9.2 Staging stack

- Supabase: new project; apply `migrations/` in order (through 207 on this
  branch; `207_teammate_bots.sql` creates the bot account pool, bots plan
  D4); seed a few scenarios. (Supabase branching is an alternative if the plan supports
  it.)
- Render: new service from this repo on the feature branch. Env: staging
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`,
  `CLIENT_URL=<staging vercel url>`, `AI_PROVIDER=bedrock`, all Bedrock/AWS
  vars from section 6, `ENABLE_TEAMMATE_BOTS=true` (so the bots path is
  exercised under Bedrock), `TEAMMATE_BOT_PASSWORD` set to a staging value,
  `EMAIL_ENABLED=false`, no Stripe keys (billing routes return 503, fine),
  `NODE_ENV=production`. Render restarts the process whenever env vars are
  saved; that is also what the production flip looks like.
- Vercel: new project from this repo on the same branch. Env:
  `VITE_API_URL=<staging render url>`, staging `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`. Do not set `AI_PROVIDER` here.
- AWS: dedicated staging IAM user + Bedrock API key so spend and CloudTrail
  are separable and revocable. S3 bucket for Transcribe batch input (and Luma
  output if video is enabled), with a short lifecycle rule. Optionally
  restrict the IAM policy to Render's static outbound IPs (`aws:SourceIp`).
- Production: add `AI_PROVIDER=openai` explicitly now so the flip is visible.

### 9.3 AWS account configuration (required for the client claim, not code)

- Bedrock account `data_retention_mode = none`
  (`PUT https://bedrock.<region>.amazonaws.com/data-retention`), enforced by
  SCP denying `bedrock:PutAccountDataRetention` unless mode is `none`.
- AWS Organizations AI services opt-out policy, `default: optOut` (covers
  Transcribe and any other AWS AI service).
- Model access enabled for the OpenAI GPT-5.6 models, Stability image model,
  Luma (if video) in the chosen regions. Service quota increases for
  `gpt-5.6-luna` / `-terra` RPM/TPM sized to 8.13.
- Region decision: GPT on `bedrock-runtime` is cross-region (`us.` profile
  routes within US regions); in-region GPT is only on `bedrock-mantle` in
  us-east-1/us-east-2; Luma is us-west-2 only. Confirm what clients accept.
- PrivateLink VPC endpoint for Bedrock only if/when the backend runs inside
  AWS. On Render it is TLS over the public internet to AWS (contractually
  fine, weaker residency story).

---

## 10. Deferred: self-hosting open-weight models

Evaluated as an alternative for clients who refuse any third-party inference.
Feasible; same code abstraction applies (vLLM exposes an OpenAI-compatible
`/v1/chat/completions`, so only `AI_BASE_URL` and model names change).
Candidate models (Sept 2026): text fast tier Qwen3.8-27B (Apache 2.0, has
vision) or gpt-oss-20b; standard tier gpt-oss-120b (1x 80 GB GPU) or DeepSeek
V4 Flash (multi-GPU); images Qwen-Image 3.0 (Apache 2.0, best text rendering)
or FLUX.2 (check commercial licence); STT faster-whisper large-v3 or
Qwen3-ASR-1.7B; video Wan 2.2. Web search would still need an external search
backend (SearXNG or a search API). Costs: quality gap vs GPT-5.6 on long
multi-constraint prompts, GPU hardware (roughly one 80 GB + one 40-48 GB + one
24 GB class GPU minimum), and owning inference ops. Revisit only if a client
requires it.

---

## 11. Client-facing statement (target wording after cutover)

> Model inference is performed via Amazon Bedrock and Amazon Transcribe within
> [Company]'s AWS account. Per AWS Service Terms, customer inputs and outputs
> are not shared with model providers and are not used to train foundation
> models. [Company] configures Bedrock for zero data retention
> (`data_retention_mode: none`), enforced by organisation policy, has opted
> out of AWS AI service improvement programmes organisation-wide, and uses
> [in-region / US-geo] inference in [region(s)].

Until every capability in section 3 is migrated, carve out honestly: "text
processing runs on AWS; image / speech / video generation still use OpenAI /
xAI" as applicable. Also fix the UI string in 7.8 before making the statement;
a user-visible "check your OpenAI API key" undercuts it. The AI teammate bots
are covered by the same statement once `llmQueue` is on the shared client:
they are server-side inference on the same provider, acting through the
product's own API.

---

## 11a. Implementation log (PR 1 code-complete, 2026-09-21)

State at the end of the second implementation session (branch
`feat/aws-bedrock-pr1-shared-ai-client` off `master` `876594b`; the older
`cursor/aws-bedrock-migration-plan-34f7` branch only carried the v1 plan and
is fully merged). `AI_PROVIDER` still defaults to `openai`, so production
behaviour is unchanged except where noted under "Behaviour changes in openai
mode" below:

Done

- 7.1 `server/env.ts`: `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`,
  `AI_MODEL_FAST/STANDARD/VISION`, `AI_TIMEOUT_MS`, `AI_TEMPERATURE_POLICY`,
  `AI_FAST_MIN_COMPLETION_TOKENS`, derived `aiEnabled`; boot validation only
  when `AI_PROVIDER=bedrock`; `TEAMMATE_BOTS_MODEL_*` now optional overrides.
- 7.2 Shared client: `server/services/ai/chatCore.ts` (pure rules: tier ->
  model, ceiling key incl. openai-mode `max_tokens` parity for gpt-4\*,
  Bedrock fast-tier floor, temperature policy with the gpt-5.5 / GPT-5.6 deny
  list, json_object / strict json_schema + inlined-schema fallback, tolerant
  JSON parse + truncation repair, hourly budgets, serial queue) and
  `server/services/ai/chatClient.ts` (env binding, retry 429/5xx, timeout,
  budget/serialize, per-label stats, usage logging, `AiCallError`,
  `throwOnError`, `growOnTruncation`). 13 unit tests in
  `chatCore.test.ts`, registered in `npm test` (173 tests green).
- 7.3 Migrated **83 of 83** chat sites (`rg "api.openai.com/v1/chat/completions" server`
  outside `server/services/ai/` returns nothing). Every site keeps its
  pre-migration model in openai mode (`openaiModel` parity for gpt-5.1 /
  gpt-5.5 / gpt-4) and its error semantics (null-fallback vs throw). Session 1
  (53 sites):
  `blueprint/llmClient.ts`, `warroomAiService.callOpenAi` (29 phases),
  the four `callAI` helpers (antagonist, extremist hive, ambient, social
  crisis generator), `teammates/llmQueue.ts` (budget/queue/json_schema now
  from the client), `aiService.ts` (12), `decisionEvaluationAiService.ts`
  (5), `decisionEvaluationOrchestrator.ts`, `decisionCasualtyEffectsService.ts`,
  `incidentDecisionGradingService.ts` (2), `heatMeterService.ts` (3),
  `scenarioStateService.ts`, `stateEffectManagementService.ts`,
  `environmentalConditionManagementService.ts`,
  `environmentalConsistencyService.ts`, `transportOutcomeService.ts` (2),
  `hospitalCapacityService.ts`, `insiderService.ts` (2),
  `socialCrisisAiService.ts`, `feedEngineService.ts`,
  `contentDisputeService.ts`, `npcMessengerService.ts` (2),
  `npcReactionService.ts`, `npcEmailReplyService.ts`,
  `chatSurveillanceService.ts` (chat), `statementWatchdogService.ts`,
  `contentGraderService.ts`, `aarSocialSectionService.ts`,
  `ambientContentService.ts` (second site),
  `stakeholderReconsiderationService.ts`.
  Session 2 (the remaining 30):
  `warroomResearchService.ts` (11, via a local `researchText()` helper on the
  `standard` tier: the 5 former `gpt-4o-search-preview` sites -- area dossier,
  per-team standards, similar cases, team workflows, crowd dynamics -- run as
  plain chat per 7.6; the 6 gpt-5.1 sites keep `openaiModel: 'gpt-5.1'`; the
  local `fetchWithRetry` helper and `SEARCH_MODEL` constant are gone, retries
  now come from the client), `routes/scenarios.ts` (4: `retry-custom-facts`
  -> standard tier plain chat, the 3 pin-enrichment helpers -> fast tier with
  `json: false` to keep the prompts byte-identical; the six direct
  `process.env.OPENAI_API_KEY` reads are gone), `rtsSceneEnrichmentService.ts`
  (4 via `enrichmentText()`: hazard / casualty / fire-calibration on
  `tier: 'vision'`, synthesis on `standard`, all `openaiModel: 'gpt-5.1'`),
  `rtsVisionService.ts` and `rtsCasualtyService.ts` (`tier: 'vision'`; the
  loose content-part arrays are now typed with the client's `ContentPart`),
  `demoAIAgentService.ts` (4, fast tier; the classifier keeps `json: false`),
  `aarAiService.ts` (2, `openaiModel: 'gpt-4'`, the summary's
  status-to-message mapping preserved via `AiCallError.status`),
  `aarSectionService.ts` (gpt-4 parity, `throwOnError`),
  `demoScriptGeneratorService.ts`, `warroomPromptParser.ts`.
- Gating: **every chat gate is now `env.aiEnabled`** -- 57 `env.openAiApiKey`
  conditions across 25 route/service files plus the seven parameter-based
  gates that would otherwise have silently disabled features in bedrock mode
  (`objectiveEvaluationService`, `hospitalCapacityService`,
  `aiService.computePublicSentiment`, `environmentalConsistencyService`,
  `warroomAiService` casualty placement, `decisionEvaluationOrchestrator`,
  `gateEvaluationService` x2). Threaded `openAiApiKey` parameters are kept as
  `_openAiApiKey` no-ops (decision #5); callers pass `env.openAiApiKey ?? ''`.
  `eslint.config.mjs` gained `argsIgnorePattern: '^_'` for that. The
  user-facing "OpenAI API key not configured" strings on chat routes now read
  "AI provider not configured". Gates that deliberately stay on
  `env.openAiApiKey` / `env.xaiApiKey` until PRs 2-3: `routes/ai.ts
/transcribe`, `routes/voice.ts` (Whisper), `mediaGenerationService.ts`
  (gpt-image-2 / xAI), `chatSurveillanceService.generateNewsGraphic`.
- 8.9-8.11 verification (openai mode): `tsc --noEmit` clean;
  `npm run build:server` clean; `npm test` 173/173; `npm run lint` reports
  only the two pre-existing unused-variable errors in
  `participantScoreService.ts` (L25, L133). Server boots with no import-time
  errors (`server/index.ts`, 40 s). Live smoke through the client against the
  real API: fast tier JSON (`gpt-4o-mini`), standard with `openaiModel:
'gpt-5.1'` + `temperature: 0.2`, standard default (`gpt-5.2`) +
  `temperature: 0.7` -- all `finish_reason: stop`, 0 failures. The
  two-scenario War Room comparison run is still to do; it needs a trainer
  session and ~20 min of generation time.

Behaviour changes in openai mode (intentional, from 7.6)

- The six former web-search sites (five in `warroomResearchService.ts`, one
  in `routes/scenarios.ts retry-custom-facts`) now run on `gpt-5.2` without
  live search. Output shapes and prompts are unchanged; the "cite real
  incidents / documents" instructions are now answered from model knowledge.

Commit split of PR 1 (each commit typechecks on its own; `AI_PROVIDER=openai`
behaviour is unchanged after every commit except no. 5)

1. Provider switch + shared client: `env.ts`, `server/services/ai/*`, unit
   tests, `package.json` test script, eslint `argsIgnorePattern`.
2. Existing wrappers onto the client: `blueprint/llmClient`,
   `warroomAiService.callOpenAi`, the four `callAI` helpers,
   `teammates/llmQueue` + `brain`.
3. Decision engine, environment, insider and hospital sites (13 files).
4. Social crisis, NPC, surveillance, grader and stakeholder sites (11 files).
5. War Room research + `routes/scenarios.ts` -- carries the 7.6 behaviour
   change (six search sites -> standard-tier plain chat).
6. RTS vision sites (`rtsSceneEnrichment`, `rtsVision`, `rtsCasualty`).
7. Demo agents, script generator, AAR summary/insights/sections, prompt
   parser.
8. Route gates -> `env.aiEnabled` (STT/image gates stay on provider keys).
9. Worker and service gates -> `env.aiEnabled`, including the seven
   parameter-based gates.
10. This plan (v2.4) and the visual explainer.

Not started: 7.4 images, 7.5 STT, 7.7 video (AWS SDK paths), 7.8 cleanup,
8.11 two-scenario comparison, and the decision-#5 follow-up (dropping the
`_openAiApiKey` parameters).

## 12. Open decisions for the implementer to confirm with the owner

1. ~~Web search: Option A or Option B?~~ **Decided 2026-09-21: neither.**
   The six search sites become `standard`-tier plain chat in the migration;
   field-ops research is retired later (7.6, #13).
2. Video: implement on Luma Ray2 or feature-flag off? Recommendation: off
   first, revisit.
3. Regions acceptable to clients (drives `bedrock-runtime` vs
   `bedrock-mantle`, and whether Luma/us-west-2 is allowed).
4. Whether `openai` mode needs exact per-site model parity (`modelOverride`)
   for the comparison run, or tier collapse is acceptable.
5. Whether to remove `openAiApiKey` parameters from service signatures in the
   first PR or leave as no-ops. Sizing (v2.1): ~499 occurrences in 67 files,
   concentrated in six files (7.3). Recommendation: no-ops in the first PR,
   removal as a mechanical follow-up once `AI_PROVIDER=openai` regression
   (8.9-8.11) is green.
6. STT for live voice input (`routes/ai.ts`): accept batch-mode latency (no
   frontend change), or go streaming and pay for it with a server-side
   WebM->Opus demux or a recorder change to PCM/WAV? Recommendation: batch
   first, measure on staging (8.14), then decide.
7. `temperature` policy when a model rejects it: strip silently
   (`AI_TEMPERATURE_POLICY=auto`, behaviour drift on ~70 sites, mostly toward
   more variance) or surface as a config error? Recommendation: auto, log
   once per model; revisit the few `temperature: 0` classification sites
   (`warroomResearchService.ts` L1370, `demoAIAgentService.ts` L270) if
   outputs become unstable. `44e26d7` already made this choice for the grader.
8. Whether to remove the AI-reaching routers from `api/index.ts` as part of
   this work (9.0) or leave the bridge as is.
9. Whether `demo-run/` tooling should be adapted or left to break when the
   OpenAI key is removed (it is untracked and not part of the product).
10. `TEAMMATE_BOTS_MODEL_FAST` / `_STRONG`: keep as optional per-feature
    overrides that default to the tier models (recommended), or delete them
    and have the bots use tiers only.
11. Strict `json_schema` under Bedrock: use it when 8.5 passes, or always use
    the `json_object` + inlined-schema fallback for simplicity?
    Recommendation: follow 8.5; the fallback already exists.
12. Whether the engine ticker and NPC-reaction callers should be serialised
    (`serialize: true`) under Bedrock to stay inside quotas, or whether quota
    increases are preferred. Decide after 8.13.
13. Field-ops research retirement: **scope decided 2026-09-21 -- (iii),
    broadened to an internal knowledge pack** (standards, forbidden actions,
    site requirements, hazard physics, demographics, injury types).
    **Timing: deferred by the owner; not part of this migration.** Still to
    decide when it is scheduled: delete or keep `WarRoomLegacy.tsx`; drop or
    keep the `research_cases` table and the detail view's Research tab.
