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
  sessionSecret:
    nodeEnv === 'production'
      ? required(process.env.SESSION_SECRET, 'SESSION_SECRET')
      : (process.env.SESSION_SECRET ?? 'dev-secret-change-in-production'),
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
};
