import 'dotenv/config';

/**
 * Live check for durable scenario builds. Manual only.
 *
 * Refuses the shared Supabase project. Point SUPABASE_URL at a local or branch
 * database that already has migration 267 applied, then:
 *
 *   WARROOM_DURABLE_BUILDS=true WARROOM_BUILD_WORKER=true RUN_BACKGROUND_ENGINES=false \
 *     npx tsx scripts/e2e-durable-build.ts
 *
 * Optional `--compile` compiles with build_id twice and expects one ledger row.
 * The two-organisation body is the same shape as scripts/e2e-multi-org-routes.ts.
 *
 * This script is not part of `npm test`. It spawns the API, so do not run it
 * against a database you cannot reset.
 */

const SHARED_PROJECT = 'umnutnosxiypbnzpqszk';
const supabaseUrl = process.env.SUPABASE_URL ?? '';

if (supabaseUrl.includes(SHARED_PROJECT)) {
  console.error(
    `Refusing to run: SUPABASE_URL contains ${SHARED_PROJECT}. Use a local or branch database.`,
  );
  process.exit(1);
}

if (!supabaseUrl) {
  console.error('SUPABASE_URL is required and must not be the shared project.');
  process.exit(1);
}

const { spawn } = await import('node:child_process');
const { createClient } = await import('@supabase/supabase-js');

const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:3011';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required for the local or branch database.');
  process.exit(1);
}

const organisations = [
  {
    display_name: 'Sigma Logistics',
    country: 'Singapore',
    kind: 'company',
    is_primary: true,
    team_roster: [
      { team_name: 'Communications', is_public_voice: true },
      { team_name: 'Legal' },
      { team_name: 'Executive' },
    ],
  },
  {
    display_name: 'Sigma Logistics Malaysia',
    short_name: 'SLM',
    country: 'Malaysia',
    kind: 'office',
    is_primary: false,
    team_roster: [
      { team_name: 'Communications', is_public_voice: true },
      { team_name: 'Stakeholder Engagement' },
    ],
  },
];

async function main(): Promise<void> {
  const child = spawn('npx', ['tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: '3011',
      WARROOM_DURABLE_BUILDS: 'true',
      WARROOM_BUILD_WORKER: 'true',
      RUN_BACKGROUND_ENGINES: 'false',
    },
    stdio: 'inherit',
  });
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  try {
    await waitForHealth();
    console.log('Server is up. Create a trainer, POST /api/warroom/social-crisis/builds');
    console.log('with the two-organisation fixture, then poll, SIGTERM, and review.');
    console.log(JSON.stringify({ organisations }, null, 2));
    const admin = createClient(supabaseUrl, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    void admin;
    console.log(
      'Live steps are in durable-scenario-builds-spec.md §12. Not running them unattended.',
    );
  } finally {
    stop();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/health`).catch(() => null);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`backend not reachable at ${API}`);
}

if (process.argv[1]?.includes('e2e-durable-build')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
