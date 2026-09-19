# AWS Bedrock Migration: Context, Decisions, and Work Plan

Status: planning complete, implementation not started.
Last verified against `master` on 2026-09-19 (call-site counts below are from that revision).

This document is the hand-off brief for whoever (human or agent) implements the
move of all AI inference from OpenAI / xAI direct APIs to AWS. Read it in full
before touching code. Sections 1 to 3 are context and decisions; sections 4
onward are the actionable plan.

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

---

## 3. Capability map: today vs target

| Capability | Today | Sites | AWS target | Auth | Notes |
|---|---|---|---|---|---|
| Chat / JSON | OpenAI chat completions (`gpt-4o-mini`, `gpt-4`, `gpt-5.1`, `gpt-5.2`, `gpt-5.5`) | 81 | Bedrock `bedrock-runtime` `/openai/v1/chat/completions`; Luna for fast tier, Terra for standard tier | Bedrock API key | Same request/response shape as OpenAI |
| Vision | same, with `image_url` content | 5 (subset of the 81) | Same endpoint, GPT-5.6 accepts image input | Bedrock API key | Verify `detail: 'high'` is accepted or ignored |
| Web search | `gpt-4o-search-preview` via chat completions | 6 | Either `bedrock-mantle` Responses API + `web_search` tool, or remove live search (see 7.6) | Bedrock API key | Chat completions -> Responses API is a real rewrite |
| Image generation | `gpt-image-2` via `/v1/images/generations` | 4 | Bedrock `InvokeModel`, Stability Stable Image (e.g. `stability.stable-image-core-v1:1`) | IAM (AWS SDK) | Different payload; re-tune prompts; text-in-image weaker |
| Speech-to-text | `whisper-1` via `/v1/audio/transcriptions` | 2 | Amazon Transcribe (not Bedrock) | IAM (AWS SDK) | Async/streaming, not single POST; needs org opt-out |
| Video | xAI `grok-imagine-video` | 1 | Bedrock `StartAsyncInvoke`, Luma Ray2, or feature-flag off | IAM (AWS SDK) | 5/9 s clips, us-west-2 only, S3 output; lowest priority |

Frontend never calls a provider directly. No frontend changes.

---

## 4. Current code inventory (from `master`, 2026-09-19)

Counts: `rg -o "api\.openai\.com/v1/[a-z/]+" server --no-filename | sort | uniq -c`

- 81 x `https://api.openai.com/v1/chat/completions`
- 4 x `https://api.openai.com/v1/images/generations`
- 2 x `https://api.openai.com/v1/audio/transcriptions`
- 1 x `https://api.x.ai/v1/videos/generations` (+ poll)
- 42 files under `server/` contain a provider URL.
- No AI SDK, no AWS SDK, no shared client. Every call is a hand-written `fetch`.

Hardcoded model strings (`rg -o "model: ['\"][a-z0-9.\-]+['\"]" server`):
`gpt-4o-mini` x37, `gpt-5.2` x15, `gpt-5.1` x9, `gpt-4` x3, `gpt-5.5` x1,
`gpt-image-2` x4, `grok-imagine-video` x1, plus `SEARCH_MODEL =
'gpt-4o-search-preview'` used at 5 call sites in
`server/services/warroomResearchService.ts` (L226, L564, L965, L1486, L1616)
and 1 in `server/routes/scenarios.ts` (L2535). Total web-search sites: 6.

Key handling:
- `server/env.ts` L44-45: `openAiApiKey: process.env.OPENAI_API_KEY`,
  `xaiApiKey: process.env.XAI_API_KEY`.
- `server/routes/scenarios.ts` reads `process.env.OPENAI_API_KEY` directly in 6
  places (bypassing `env`). Must be replaced.
- Most services take `openAiApiKey: string` as a parameter and build the fetch
  themselves.

Existing partial wrappers (use as the seed for the shared client):
- `server/services/blueprint/llmClient.ts` -> `openAiJson()`: retries on
  429/5xx, tolerant JSON extraction (`parseJsonLoose`), `max_completion_tokens`,
  `response_format: json_object`. Used by blueprint extraction and scenario
  director only.
- `server/services/warroomAiService.ts` ~L1862 `callOpenAi<T>()`: file-local
  helper used by ~25 War Room generation phases in the same file.
- Duplicated file-local `callAI()` helpers in: `antagonistEngineService.ts`,
  `extremistHiveService.ts`, `ambientContentService.ts`,
  `socialCrisisGeneratorService.ts`, `chatSurveillanceService.ts`,
  `statementWatchdogService.ts`.

Call sites by area (line numbers approximate; re-grep before editing):

Routes
- `server/routes/ai.ts` L115 STT `whisper-1`
- `server/routes/voice.ts` L134 STT `whisper-1`
- `server/routes/scenarios.ts` L2528 search (`retry-custom-facts`); L2716,
  L2795, L2874 chat `gpt-4o-mini` (patient/hazard/crowd enrichment)

Core
- `server/services/aiService.ts` 12 sites, `gpt-4o-mini`, JSON mode
  (scenario gen, decision classification, escalation pathways, sentiment,
  objective evaluation, inject-from-decision)
- `server/services/blueprint/llmClient.ts` (wrapper), `blueprintConfig.ts`
  (`BLUEPRINT_TEXT_MODEL = 'gpt-5.2'`)

War Room (field ops)
- `server/services/warroomAiService.ts` `callOpenAi` (`gpt-5.1`, JSON)
- `server/services/warroomPromptParser.ts` L251 `gpt-4o-mini`
- `server/services/warroomResearchService.ts`: SEARCH sites at L226
  (`researchArea`), L564 (`researchStandardsPerTeam`), L965
  (`fetchSimilarCasesFromInternet`), L1486 (`researchTeamWorkflows`), L1616
  (`researchCrowdDynamics`); `gpt-5.1` plain-chat sites at L326, L395, L454
  (structured extractors), L697 (`researchForbiddenActionsPerTeam`), L1367
  (`mapStandardsToTeams`), L1754 (`researchDeteriorationPhysics`; its doc
  comment mentions the search model but the call uses `gpt-5.1`)

Social crisis
- `socialCrisisAiService.ts` L70; `socialCrisisGeneratorService.ts` L325
  (`callAI`); `antagonistEngineService.ts` L34; `extremistHiveService.ts` L82;
  `ambientContentService.ts` L504, L1283; `feedEngineService.ts` L300;
  `npcMessengerService.ts` L140, L370; `npcEmailReplyService.ts` L319;
  `npcReactionService.ts` L216; `chatSurveillanceService.ts` L311 (chat),
  L350 (IMAGE `gpt-image-2`); `statementWatchdogService.ts` L435;
  `contentDisputeService.ts` L125; `contentGraderService.ts` L227 (`gpt-5.5`);
  `mediaGenerationService.ts` L96 (IMAGE), L178 + L232 (xAI VIDEO)
  -- all chat sites `gpt-5.2`, JSON mode

Decision / environment / hospital / insider (`gpt-4o-mini`, JSON)
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

RTS / vision (`gpt-5.1`)
- `rtsVisionService.ts` L69 (vision)
- `rtsCasualtyService.ts` L83, L140 (IMAGE `gpt-image-2`), L229 (vision)
- `rtsSceneEnrichmentService.ts` L284, L412, L978 (vision), L545 (text)

Demo / AAR
- `demoAIAgentService.ts` L262, L1840, L5207, L5748 (`gpt-4o-mini`)
- `demoScriptGeneratorService.ts` L46 (`gpt-4o-mini`)
- `aarAiService.ts` L212, L321 (`gpt-4`)
- `aarSectionService.ts` L467 (`gpt-4`)
- `aarSocialSectionService.ts` L688 (`gpt-5.2`)

Indirect callers that only gate on `env.openAiApiKey` and pass it down (no
fetch of their own): `pathwayOutcomesService.ts`, `injectSchedulerService.ts`,
`injectTriggerService.ts`, `aiInjectSchedulerService.ts`,
`gateEvaluationService.ts`, `objectiveEvaluationService.ts`,
`demoActionDispatcher.ts`, `blueprint/scenarioDirectorService.ts`,
`blueprint/blueprintExtractionService.ts`, routes `warroom.ts`, `insider.ts`,
`hospital.ts`, `decisions.ts`, `sessions.ts`, `debug.ts`, `aar.ts`.

Tests: none cover any LLM call. `blueprintMerge.test.ts`,
`blueprintTypes.test.ts`, `directorLogic.test.ts`, `extremistDoctrine.test.ts`
are pure logic.

---

## 5. Design decisions (already made; do not re-open without reason)

1. **Provider switch by env, not by branch.** `AI_PROVIDER=openai|bedrock`,
   default `openai`. The refactor merges to `master` with production behaviour
   unchanged; cutover is flipping the variable on the production backend;
   rollback is flipping it back. No redeploy needed for either.
2. **One shared chat client, tier-based.** Generalise
   `server/services/blueprint/llmClient.ts`. Callers pass a tier
   (`fast` | `standard` | `vision` | `search`), never a model name. Model IDs
   per tier come from env. Keep its retry/backoff and tolerant JSON parsing
   and apply them everywhere (many current sites `JSON.parse` the raw content
   directly).
3. **Tier mapping.** `gpt-4o-mini`, `gpt-4` -> `fast`. `gpt-5.1`, `gpt-5.2`,
   `gpt-5.5` -> `standard`. Vision sites -> `vision` (same model as standard
   unless configured otherwise). `gpt-4o-search-preview` -> `search`.
   Bedrock defaults: fast = `us.openai.gpt-5.6-luna`, standard/vision =
   `us.openai.gpt-5.6-terra`. Do NOT default everything to Sol; it is ~10x
   the cost of Luna and not needed for these tasks.
4. **`response_format: json_object` stays** in requests. OpenAI's Bedrock guide
   lists structured outputs as supported. Verify with one request early
   (section 8). Tolerant parsing is the insurance.
5. **Non-text capabilities go through the AWS SDK**, not the OpenAI-compatible
   path: `@aws-sdk/client-bedrock-runtime` for images (and video if kept),
   `@aws-sdk/client-transcribe` for STT. IAM credentials via standard AWS env
   vars / role.
6. **Web search: prefer removing the live-search dependency** over porting to
   the Responses API (section 7.6). The similar-cases mechanic is
   database-first already; seed the library instead of searching live.
7. **Video is last and optional.** One call site; feature-flag off is
   acceptable.
8. **Testing uses a full duplicate staging stack** (section 9): separate
   Supabase project, separate Render service, separate Vercel project. Do not
   point a second backend at the production database (see 9.1 for why).

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
AI_MODEL_SEARCH=openai.gpt-5.6-terra      # only if search is ported to bedrock-mantle Responses API
AI_SEARCH_BASE_URL=https://bedrock-mantle.us-east-1.api.aws/openai/v1

# Non-text (AWS SDK, IAM). Standard AWS credential chain.
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AI_IMAGE_MODEL_ID=stability.stable-image-core-v1:1
AI_VIDEO_ENABLED=false
AI_VIDEO_MODEL_ID=luma.ray-v2:0
AI_VIDEO_S3_BUCKET=
AI_VIDEO_REGION=us-west-2

# Research behaviour (section 7.6)
RESEARCH_LIVE_SEARCH=true     # false = library/model-memory only, no search calls

# Existing, retained until cutover is complete, then removed
OPENAI_API_KEY=
XAI_API_KEY=
```

When `AI_PROVIDER=openai`, the shared client must produce byte-identical
requests to today's (URL `https://api.openai.com/v1/chat/completions`, Bearer
`OPENAI_API_KEY`, current model names). Tier -> OpenAI model map for that mode:
fast = `gpt-4o-mini`, standard = `gpt-5.2` (accept that `gpt-5.1`/`gpt-5.5`/
`gpt-4` sites collapse onto it, or keep a per-call `modelOverride` for exact
parity during the comparison run), vision = `gpt-5.1`, search =
`gpt-4o-search-preview`.

Remove the unused `OPENAI_MODEL` from `docs/ENV_TEMPLATE.md` (no code reads
it).

---

## 7. Work plan

Each step is a separate commit / reviewable unit. Steps 1-3 are the first PR.

### 7.1 Env plumbing
- Extend `server/env.ts` with the variables above. Validate: if
  `AI_PROVIDER=bedrock` then `AI_API_KEY` and `AI_BASE_URL` are required.
- Replace the 6 direct `process.env.OPENAI_API_KEY` reads in
  `server/routes/scenarios.ts` with the shared client (they should not need a
  key at all once migrated).

### 7.2 Shared chat client
- New module, e.g. `server/services/ai/chatClient.ts` (or promote
  `blueprint/llmClient.ts`). API sketch:

```ts
export type AiTier = 'fast' | 'standard' | 'vision' | 'search';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }
export interface ChatOptions {
  tier: AiTier;
  messages: ChatMessage[];
  json?: boolean;                 // adds response_format json_object
  maxTokens?: number;             // maps to max_completion_tokens
  temperature?: number;
  modelOverride?: string;         // escape hatch during migration only
  retry?: { attempts?: number };
  label?: string;                 // for logs
}
export async function chat(opts: ChatOptions): Promise<{ content: string; raw: unknown } | null>;
export async function chatJson<T>(opts: ChatOptions): Promise<T | null>;  // tolerant parse
```

- Resolve URL / key / model from env by `AI_PROVIDER` and tier.
- Keep `parseJsonLoose` and `repairTruncatedJson` (currently in
  `warroomAiService.ts` L1826) reachable from the client.
- Retry 429/5xx with backoff; never throw to callers that currently expect
  `null` on failure.
- Log provider, tier, model, latency, and token usage per call (no prompt
  content in logs).

### 7.3 Migrate chat + vision sites (86)
- Replace every `fetch('https://api.openai.com/v1/chat/completions', ...)`
  with `chat()` / `chatJson()`. Remove the `openAiApiKey` parameters threaded
  through service signatures where they become unused, or leave them as
  no-ops for a smaller diff and clean up in a follow-up.
- Delete the six duplicated `callAI` helpers and `warroomAiService.callOpenAi`
  in favour of the shared client (or make them thin wrappers first).
- Vision sites: keep OpenAI content-part shape
  (`{ type: 'image_url', image_url: { url, detail } }`); Bedrock's
  OpenAI-compatible path accepts it.
- Gating: sites that currently check `if (!env.openAiApiKey) return null`
  should check a provider-agnostic `env.aiEnabled` instead.

### 7.4 Images (4 sites)
- Add `@aws-sdk/client-bedrock-runtime`.
- New `server/services/ai/imageClient.ts` with `generateImage({ prompt,
  aspectRatio, seed? }) -> { base64 }`, switching on `AI_PROVIDER`
  (`openai` keeps today's `/images/generations` call).
- Sites: `chatSurveillanceService.generateNewsGraphic` (L350),
  `mediaGenerationService.generatePostImage` (L96),
  `rtsCasualtyService` L83 and L140.
- Map `size` -> `aspect_ratio`; drop `quality`. Callers expecting a URL
  (`response_format: 'url'`) must accept base64 (or upload to storage and
  return that URL, which is what should happen anyway).
- Re-tune the four prompts and eyeball output; news graphics with overlaid
  text are the weakest case on Stability.

### 7.5 Speech-to-text (2 sites)
- Add `@aws-sdk/client-transcribe` (or `client-transcribe-streaming`).
- New `server/services/ai/transcribeClient.ts`, switching on `AI_PROVIDER`.
- Sites: `server/routes/ai.ts` L115, `server/routes/voice.ts` L134. Both
  receive a multipart audio file and return text. Transcribe batch jobs need
  the audio in S3 and are asynchronous (seconds); streaming Transcribe avoids
  S3 but changes the request flow. Pick streaming for the voice-input UX.
- Prerequisite outside code: AWS Organizations AI services opt-out policy.

### 7.6 Web search (6 sites) -- decision required before implementation
Option A (recommended): remove the live-search dependency.
- `warroomResearchService.researchSimilarCases` is already cache-first on the
  `research_cases` table and only searches when < 2 cached matches. Gate the
  internet fallback behind `RESEARCH_LIVE_SEARCH`. Pre-seed `research_cases`
  with human-vetted incident records (the structured schema is in the prompt
  at ~L900-955). Also stop persisting model-generated cases when the flag is
  off so the vetted library is not polluted.
- `researchStandardsPerTeam`, `researchTeamWorkflows`,
  `researchCrowdDynamics`, `researchArea`: switch to `standard` tier plain
  chat. These are general professional knowledge; loss is small.
  `researchArea` already has OSM/geocode data alongside it.
  (`researchDeteriorationPhysics` and `researchForbiddenActionsPerTeam`
  already use plain `gpt-5.1` chat; they just move to the `standard` tier.)
- `routes/scenarios.ts` `retry-custom-facts`: trainer-supplied text, does not
  need search; switch to `standard` tier.
- Reword prompts from "use ONLY real documented incidents" to "draw on
  well-documented incidents you are confident about; mark uncertain figures
  approximate; return an empty list rather than guess".
- Add a cheap "realism critic" pass (fast tier, JSON verdict) on the core
  narrative and inject list in `warroomAiService` to catch implausible chains
  when precedents are absent. Existing hard guardrails
  (`THREAT_HAZARD_RULES`, threat-profile FORBIDDEN block, `MAX_VICTIM_PINS`,
  `VALID_INJECT_TYPES`, `validatePinTopology`) remain and do not depend on
  research.

Option B: port the 6 sites to the `bedrock-mantle` Responses API with the
server-side `web_search` tool. Different request/response shape
(`input`/`output` instead of `messages`/`choices`). Keeps live grounding,
keeps an external search dependency (queries, not documents, leave AWS via the
tool). If chosen, strip the raw trainer prompt from the search query in
`fetchSimilarCasesFromInternet` and send only scenario type, weapon class,
setting tags.

### 7.7 Video (1 site)
- `mediaGenerationService.generateVideo` (L178 start, L232 poll). Either
  `AI_VIDEO_ENABLED=false` short-circuit returning null (callers already
  tolerate absence), or implement `StartAsyncInvoke` -> poll
  `GetAsyncInvoke` -> read clip from S3 with Luma Ray2 in us-west-2.

### 7.8 Cleanup after cutover
- Remove `openai` branches from the clients, `OPENAI_API_KEY`, `XAI_API_KEY`,
  `test-grok-video.mjs`.
- Update `docs/ENV_TEMPLATE.md`, `docs/TECH_STACK.md`, `docs/ARCHITECTURE.md`.

### 7.9 Recommended alongside (not blocking)
- Field-ops document upload: extend the blueprint pipeline
  (`blueprint/blueprintExtractionService.ts`, `ScenarioBlueprint`) that
  currently only feeds the social crisis War Room, so trainers can ground
  field-ops scenarios in their own threat assessments / SOPs. Hook points:
  `warroomAiService.generateTeamsAndCore`, hazards, casualties, inject prompts
  (mirror `buildStorylineGuidance` etc. in `socialCrisisGeneratorService.ts`).

---

## 8. Verification checklist

Early smoke checks (one request each, before migrating 80 sites):
1. Bedrock chat completions with `response_format: { type: 'json_object' }`
   returns valid JSON on Luna and Terra.
2. Vision request with `image_url` (+ `detail: 'high'`) succeeds on Terra.
3. `max_completion_tokens` accepted (not `max_tokens`).
4. Model IDs resolve: `us.openai.gpt-5.6-luna`, `us.openai.gpt-5.6-terra`
   in the chosen region. IAM identity has `bedrock:InvokeModel` on the
   inference profile AND on `arn:aws:bedrock:<region>:<acct>:project/default`.

After migration, `AI_PROVIDER=openai` regression (must be behaviour-neutral):
5. `npm run lint`, `npm run build`, `npm test` pass.
6. Generate one field-ops War Room scenario and one social crisis scenario on
   the branch with `AI_PROVIDER=openai`; confirm output is comparable to
   `master` (same model names hit; check logs).

Bedrock comparison (staging stack, section 9):
7. Same two scenario prompts with `AI_PROVIDER=bedrock`. Compare side by side:
   core narrative, team list, hazard count/types (must respect
   `THREAT_HAZARD_RULES`), casualty totals, victim triage mix, inject stream
   (types, timing, count), NPC replies, content grader verdicts, AAR summary.
8. Play a short session end to end: decisions classified, gates evaluated,
   injects fire, surveillance/watchdog react, AAR generates.
9. Voice input transcribes; NPC post image generates; (video if enabled).
10. Check CloudTrail shows Bedrock calls from the staging identity only;
    check Bedrock spend in Cost Explorer is in the expected range for the run.

Cutover:
11. Merge to `master` with `AI_PROVIDER=openai` (no behaviour change).
12. Set `AI_PROVIDER=bedrock` + Bedrock vars on the production backend. Watch
    logs for the first sessions. Rollback = set `AI_PROVIDER=openai`.
13. After a stable period, remove OpenAI/xAI keys from production and do 7.8.

---

## 9. Test environment (decided: full duplicate staging stack)

Deployment topology today: Vercel serves `frontend/dist` plus a thin serverless
bridge in `api/index.ts` (subset of routes, no WebSockets). The real backend
`server/index.ts` runs on Render (or similar) because it needs WebSockets. ALL
AI calls live in `server/`, so a Vercel-only staging project would test almost
nothing; the staging backend is what matters.

### 9.1 Why not share the production database
`server/index.ts` unconditionally starts four background workers on boot:
inject scheduler (`ENABLE_AUTO_INJECTS`-gated), AI inject scheduler, chat
surveillance, statement watchdog (the last two are NOT env-gated). A second
backend on the same Supabase would double-fire injects and NPC reactions on
live sessions, write test rows into production tables, and pollute the shared
`research_cases` cache with Bedrock-generated cases. Do not do it.

### 9.2 Staging stack
- Supabase: new project; apply `migrations/` in order; seed a few scenarios.
  (Supabase branching is an alternative if the plan supports it.)
- Render: new service from this repo on the feature branch. Env: staging
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`,
  `CLIENT_URL=<staging vercel url>`, `AI_PROVIDER=bedrock`, all Bedrock/AWS
  vars from section 6, `EMAIL_ENABLED=false`, no Stripe keys (billing routes
  return 503, fine), `NODE_ENV=production`.
- Vercel: new project from this repo on the same branch. Env:
  `VITE_API_URL=<staging render url>`, staging `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`.
- AWS: dedicated staging IAM user + Bedrock API key so spend and CloudTrail
  are separable and revocable.
- Production: add `AI_PROVIDER=openai` explicitly now so the flip is visible.

### 9.3 AWS account configuration (required for the client claim, not code)
- Bedrock account `data_retention_mode = none`
  (`PUT https://bedrock.<region>.amazonaws.com/data-retention`), enforced by
  SCP denying `bedrock:PutAccountDataRetention` unless mode is `none`.
- AWS Organizations AI services opt-out policy, `default: optOut` (covers
  Transcribe and any other AWS AI service).
- Model access enabled for the OpenAI GPT-5.6 models, Stability image model,
  Luma (if video) in the chosen regions.
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
xAI" as applicable.

---

## 12. Open decisions for the implementer to confirm with the owner

1. Web search: Option A (remove live search, seed library) or Option B (port
   to `bedrock-mantle` Responses API)? Recommendation: A.
2. Video: implement on Luma Ray2 or feature-flag off? Recommendation: off
   first, revisit.
3. Regions acceptable to clients (drives `bedrock-runtime` vs
   `bedrock-mantle`, and whether Luma/us-west-2 is allowed).
4. Whether `openai` mode needs exact per-site model parity (`modelOverride`)
   for the comparison run, or tier collapse is acceptable.
5. Whether to remove `openAiApiKey` parameters from service signatures in the
   first PR (bigger diff, cleaner) or leave as no-ops (smaller diff, follow-up
   cleanup).
