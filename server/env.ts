import 'dotenv/config';

const required = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const validatePort = (port: number): number => {
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${port}. Must be between 1 and 65535.`);
  }
  return port;
};

const nodeEnv = process.env.NODE_ENV ?? 'development';

// ---------- AI provider switch (docs/AWS_BEDROCK_MIGRATION_v2.md §6) ----------
// `openai` reproduces today's requests exactly; `bedrock` routes every chat call to the
// OpenAI-compatible Bedrock endpoint. Cutover and rollback are this one variable.
type AiProvider = 'openai' | 'bedrock';
const aiProvider: AiProvider = process.env.AI_PROVIDER === 'bedrock' ? 'bedrock' : 'openai';
const aiApiKey = process.env.AI_API_KEY;
const aiBaseUrl = process.env.AI_BASE_URL;
if (aiProvider === 'bedrock' && (!aiApiKey || !aiBaseUrl)) {
  throw new Error('AI_PROVIDER=bedrock requires AI_API_KEY and AI_BASE_URL');
}
type AiTemperaturePolicy = 'auto' | 'pass' | 'strip';
const aiTemperaturePolicy: AiTemperaturePolicy =
  process.env.AI_TEMPERATURE_POLICY === 'pass' || process.env.AI_TEMPERATURE_POLICY === 'strip'
    ? process.env.AI_TEMPERATURE_POLICY
    : 'auto';

const DEV_SESSION_SECRET = 'dev-secret-change-in-production';

const resolveSessionSecret = (): string => {
  if (nodeEnv === 'production') {
    return required(process.env.SESSION_SECRET, 'SESSION_SECRET');
  }
  const secret = process.env.SESSION_SECRET ?? DEV_SESSION_SECRET;
  // Defense-in-depth: if we're clearly running on a hosting platform but NODE_ENV
  // wasn't set to 'production', still refuse to boot with the insecure dev default.
  const onDeployPlatform = Boolean(process.env.VERCEL || process.env.RENDER);
  if (onDeployPlatform && secret === DEV_SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set to a strong value on deployed environments');
  }
  return secret;
};

export const env = {
  nodeEnv,
  port: validatePort(Number(process.env.PORT ?? 3001)),
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:3000',
  supabaseUrl: required(process.env.SUPABASE_URL, 'SUPABASE_URL'),
  supabaseServiceRoleKey: required(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY',
  ),
  openAiApiKey: process.env.OPENAI_API_KEY,
  xaiApiKey: process.env.XAI_API_KEY,
  // ---------- AI provider (shared chat client, server/services/ai) ----------
  aiProvider,
  aiApiKey,
  aiBaseUrl,
  // True when the ACTIVE provider has a key. Feature gates check this, never a
  // provider-specific key, so removing OPENAI_API_KEY after cutover cannot silently
  // switch features off.
  aiEnabled: aiProvider === 'bedrock' ? Boolean(aiApiKey) : Boolean(process.env.OPENAI_API_KEY),
  // Tier -> model on Bedrock. In openai mode the tiers resolve to today's model names
  // (see server/services/ai/chatCore.ts OPENAI_TIER_MODELS).
  aiModelFast: process.env.AI_MODEL_FAST ?? 'us.openai.gpt-5.6-luna',
  aiModelStandard: process.env.AI_MODEL_STANDARD ?? 'us.openai.gpt-5.6-terra',
  aiModelVision: process.env.AI_MODEL_VISION ?? 'us.openai.gpt-5.6-terra',
  // Per-request abort. Long generation phases pass their own timeoutMs.
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS) || 180_000,
  // auto = drop `temperature` for models known to reject it (gpt-5.5 returned 400 on it,
  // see contentGraderService history); pass = always send; strip = never send.
  aiTemperaturePolicy,
  // Floor applied to fast-tier completion budgets under Bedrock if the smoke checks show
  // reasoning tokens eat the tiny (30-150 token) ceilings some classifiers use.
  aiFastMinCompletionTokens: Number(process.env.AI_FAST_MIN_COMPLETION_TOKENS) || 0,
  sessionSecret: resolveSessionSecret(),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Email configuration
  emailEnabled: process.env.EMAIL_ENABLED !== 'false',
  smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  emailFrom: process.env.EMAIL_FROM ?? 'kenneth@prophyion.com',
  emailFromName: process.env.EMAIL_FROM_NAME ?? 'Prophyion',
  // Where scoping-call enquiries from the public marketing pages are sent. Falls
  // back to the address already published on those pages as the manual route.
  enquiryNotifyEmail: process.env.ENQUIRY_NOTIFY_EMAIL ?? 'kenneth@prophyion.com',
  // Origin of the marketing site, allowed through CORS so the enquiry form can post.
  marketingUrl: process.env.MARKETING_URL,
  // ---------- Background engines master switch ----------
  // The process boots six loops that act on every active session in the database: inject
  // scheduler, AI inject scheduler, chat surveillance, statement watchdog, generator engines
  // (pressure orgs / organic decisions) and the AI teammate bot reconciler. Exactly one process
  // may run them per database. On 20 Sep 2026 a developer server started for a "visual check"
  // ran them against production for 38 minutes and every inject fired twice
  // (docs/session-bugfix-spec-2026-09-20.md §2). Semantics: ON in production unless
  // RUN_BACKGROUND_ENGINES=false; OFF everywhere else unless RUN_BACKGROUND_ENGINES=true.
  runBackgroundEngines:
    process.env.RUN_BACKGROUND_ENGINES === 'true' ||
    (nodeEnv === 'production' && process.env.RUN_BACKGROUND_ENGINES !== 'false'),
  // Inject scheduler configuration
  // Auto-injects enabled if: explicitly set to 'true' OR (in production and not explicitly 'false')
  // In development: defaults to false unless ENABLE_AUTO_INJECTS='true'
  // In production: defaults to true unless ENABLE_AUTO_INJECTS='false'
  enableAutoInjects:
    process.env.ENABLE_AUTO_INJECTS === 'true' ||
    (nodeEnv === 'production' && process.env.ENABLE_AUTO_INJECTS !== 'false'),
  // Interval in milliseconds for checking if injects should be published (default: 30 seconds)
  injectSchedulerIntervalMs: Number(process.env.INJECT_SCHEDULER_INTERVAL_MS) || 30000,
  // Stakeholder engine (in-character replies + inject reconsideration from stakeholder records,
  // docs/stakeholder-contacts-contract.md). ON by default; set ENABLE_STAKEHOLDER_ENGINE=false to
  // fall back to the legacy NPC reply paths and skip verdict calls.
  enableStakeholderEngine: process.env.ENABLE_STAKEHOLDER_ENGINE !== 'false',
  // Organic executive decisions + pressure organisations engines
  // (docs/executive-decisions-organic-plan.md §9). ON by default; ENABLE_EXECUTIVE_DECISIONS=false
  // disables detection hooks, the cascade planner and the pressure engine ticker.
  enableExecutiveDecisions: process.env.ENABLE_EXECUTIVE_DECISIONS !== 'false',
  // AAR report format: legacy (single summary + insights) or sections (per-section data + AI analysis). Default legacy for safe revert.
  aarReportFormat:
    process.env.AAR_REPORT_FORMAT === 'sections' ? 'sections' : ('legacy' as 'legacy' | 'sections'),
  // Document-driven scenario blueprint feature. Default OFF: when disabled the
  // social-crisis War Room behaves exactly as before (raw document text only).
  enableDocumentBlueprint: process.env.ENABLE_DOCUMENT_BLUEPRINT === 'true',
  // Prefer Singapore-scoped OSM data stored in Supabase over live Overpass calls.
  // Falls back to Overpass automatically when cache tables are empty or disabled.
  enableLocalOsmSingapore: process.env.ENABLE_LOCAL_OSM_SINGAPORE === 'true',
  // Runtime Scenario Director (Phase 5). Same semantics as enableAutoInjects:
  // ON in production unless explicitly disabled, OFF in dev unless turned on.
  // It is further guarded at runtime (needs a usable blueprint + social_media
  // session + cadence gate), so this only activates where a blueprint exists.
  enableScenarioDirector:
    process.env.ENABLE_SCENARIO_DIRECTOR === 'true' ||
    (nodeEnv === 'production' && process.env.ENABLE_SCENARIO_DIRECTOR !== 'false'),
  // ---------- AI teammate bots (docs/ai-teammate-bots-plan.md) ----------
  // Lobby-native AI players for social_media sessions. ON in development, OFF in
  // production unless ENABLE_TEAMMATE_BOTS=true. When off: routes 404, lobby card
  // hidden, reconciler idle — data is untouched.
  enableTeammateBots:
    process.env.ENABLE_TEAMMATE_BOTS === 'true' ||
    (nodeEnv !== 'production' && process.env.ENABLE_TEAMMATE_BOTS !== 'false'),
  // Shared password for the pooled bot accounts (asserted at boot via the Admin API).
  teammateBotPassword: process.env.TEAMMATE_BOT_PASSWORD ?? 'TeammateBot#NoLogin!2026',
  teammateBotsMaxPerSession: Number(process.env.TEAMMATE_BOTS_MAX_PER_SESSION ?? 8),
  teammateBotsMaxLlmPerHour: Number(process.env.TEAMMATE_BOTS_MAX_LLM_PER_HOUR ?? 400),
  // Optional exact-model overrides for the bots. Unset (the default) means the shared
  // client's `fast` / `standard` tier, which in openai mode is gpt-4o-mini / gpt-5.2 --
  // identical to the previous hardcoded defaults.
  teammateBotsModelFast: process.env.TEAMMATE_BOTS_MODEL_FAST || undefined,
  teammateBotsModelStrong: process.env.TEAMMATE_BOTS_MODEL_STRONG || undefined,
  // Per-phase behaviour flags (backtracking guide §17). All ON by default.
  teammateBotsPlanner: process.env.TEAMMATE_BOTS_PLANNER !== 'off',
  teammateBotsCoordination: process.env.TEAMMATE_BOTS_COORDINATION !== 'off',
  teammateBotsReactive: process.env.TEAMMATE_BOTS_REACTIVE !== 'off',
  teammateBotsCritique: process.env.TEAMMATE_BOTS_CRITIQUE !== 'off',
  // Use the game's own grader as the critic (inflates scores vs humans; off by default).
  teammateBotsPregrade: process.env.TEAMMATE_BOTS_PREGRADE === 'true',
  // Base URL the bot runtime uses to call this API. Defaults to loopback on the listening port.
  teammateBotsApiBase: process.env.TEAMMATE_BOTS_API_BASE,
  // ---------- Stripe payment portal ----------
  // All optional: without a secret key the app boots normally and billing
  // endpoints return 503. Webhook secret comes from `stripe listen` in dev
  // and from the dashboard webhook endpoint in production.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  // Fixed engagement fee invoiced to the trainer's client, in SGD.
  invoiceAmountSgd: Number(process.env.INVOICE_AMOUNT_SGD ?? 10000),
  // Trainer's share of a paid invoice, released after the AAR (percent).
  trainerSharePercent: Number(process.env.TRAINER_SHARE_PERCENT ?? 30),
  // Credits granted per paid invoice. 2 session credits = pre- and
  // post-training games on the same scenario.
  scenarioCreditsPerInvoice: Number(process.env.SCENARIO_CREDITS_PER_INVOICE ?? 1),
  sessionCreditsPerInvoice: Number(process.env.SESSION_CREDITS_PER_INVOICE ?? 2),
};
