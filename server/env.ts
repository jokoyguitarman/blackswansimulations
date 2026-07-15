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
  sessionSecret: resolveSessionSecret(),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Email configuration
  emailEnabled: process.env.EMAIL_ENABLED !== 'false',
  smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  emailFrom: process.env.EMAIL_FROM ?? 'noreply@simulator.local',
  emailFromName: process.env.EMAIL_FROM_NAME ?? 'Simulation Environment',
  // Inject scheduler configuration
  // Auto-injects enabled if: explicitly set to 'true' OR (in production and not explicitly 'false')
  // In development: defaults to false unless ENABLE_AUTO_INJECTS='true'
  // In production: defaults to true unless ENABLE_AUTO_INJECTS='false'
  enableAutoInjects:
    process.env.ENABLE_AUTO_INJECTS === 'true' ||
    (nodeEnv === 'production' && process.env.ENABLE_AUTO_INJECTS !== 'false'),
  // Interval in milliseconds for checking if injects should be published (default: 30 seconds)
  injectSchedulerIntervalMs: Number(process.env.INJECT_SCHEDULER_INTERVAL_MS) || 30000,
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
};
