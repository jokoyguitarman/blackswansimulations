import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Test user provisioning for the load-test harness.
 *
 * Creates (or reuses) one trainer account and a pool of player accounts,
 * signs each in to mint real Supabase JWTs, and registers players as
 * session participants. Users are prefixed `loadtest-` and kept between
 * runs so subsequent runs skip creation entirely.
 *
 * Supabase Auth rate-limits password sign-ins (~30 per 5 min per IP), so
 * tokens are cached on disk between runs, and when the limit is hit the
 * remaining spectators borrow already-minted tokens round-robin. Socket
 * load is unaffected: every connection still authenticates and joins
 * individually; only the JWT identity is shared.
 */

const EMAIL_DOMAIN = 'loadtest.example.com';
const PASSWORD = process.env.LOADTEST_PASSWORD ?? 'LoadTest#Harness!2026';
const TRAINER_EMAIL = `loadtest-trainer@${EMAIL_DOMAIN}`;

export interface TestUser {
  userId: string;
  email: string;
  token: string;
}

export interface HarnessUsers {
  trainer: TestUser;
  players: TestUser[];
}

const playerEmail = (i: number): string =>
  `loadtest-player-${String(i).padStart(4, '0')}@${EMAIL_DOMAIN}`;

export function createAdminClient(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const TOKEN_CACHE_PATH = path.join('loadtest', '.token-cache.json');
const TOKEN_MIN_REMAINING_MS = 20 * 60 * 1000;

type TokenCache = Record<string, { userId: string; token: string }>;

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

function loadTokenCache(): TokenCache {
  try {
    const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8')) as TokenCache;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(cache).filter(([, v]) => jwtExpiryMs(v.token) - now > TOKEN_MIN_REMAINING_MS),
    );
  } catch {
    return {};
  }
}

function saveTokenCache(users: TestUser[]): void {
  const cache: TokenCache = {};
  for (const u of users) cache[u.email] = { userId: u.userId, token: u.token };
  fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(cache));
}

interface SignInResult {
  user: TestUser | null;
  rateLimited: boolean;
  errorMessage?: string;
}

async function signIn(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
): Promise<SignInResult> {
  // Fresh client per sign-in: signInWithPassword mutates client-internal auth
  // state, which is unsafe under the concurrency we use for the player pool.
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session || !data.user) {
    const msg = error?.message ?? 'no session returned';
    return { user: null, rateLimited: /rate limit/i.test(msg), errorMessage: msg };
  }
  return {
    user: { userId: data.user.id, email, token: data.session.access_token },
    rateLimited: false,
  };
}

async function signInWithRetry(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  maxWaitMs: number,
): Promise<SignInResult> {
  let waited = 0;
  let delay = 10_000;
  for (;;) {
    const result = await signIn(supabaseUrl, serviceRoleKey, email);
    if (result.user || !result.rateLimited || waited >= maxWaitMs) return result;
    await new Promise((r) => setTimeout(r, delay));
    waited += delay;
    delay = Math.min(delay * 2, 60_000);
  }
}

/**
 * Ensure the auth user exists and mint a token for it. Returns null (instead
 * of throwing) when sign-in is rate-limited, so the caller can fall back to
 * borrowing an already-minted token.
 */
async function ensureUser(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  fullName: string,
  retryWaitMs: number,
): Promise<TestUser | null> {
  const existing = await signIn(supabaseUrl, serviceRoleKey, email);
  if (existing.user) return existing.user;
  if (existing.rateLimited) {
    const retried = await signInWithRetry(supabaseUrl, serviceRoleKey, email, retryWaitMs);
    if (retried.user) return retried.user;
    if (retried.rateLimited) return null;
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName, agency_name: 'Load Test' },
  });
  // "already registered" can happen if a previous run was interrupted between
  // create and profile setup, or under a concurrent race; sign-in below settles it.
  if (error && !/already/i.test(error.message)) {
    throw new Error(`Failed to create user ${email}: ${error.message}`);
  }

  const created = await signInWithRetry(supabaseUrl, serviceRoleKey, email, retryWaitMs);
  if (created.user) return created.user;
  if (created.rateLimited) return null;
  throw new Error(
    `Created user ${email} but could not sign in (${created.errorMessage}). If the user ` +
      `pre-exists with a different password, delete loadtest-* users in Supabase Auth ` +
      `or set LOADTEST_PASSWORD.`,
  );
}

async function promoteToTrainer(admin: SupabaseClient, userId: string): Promise<void> {
  // requireAuth and the websocket middleware read app_metadata.role first;
  // user_profiles.role is the fallback and is also used by RLS/UI joins.
  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { role: 'trainer', agency: 'Load Test' },
  });
  if (metaErr) throw new Error(`Failed to set trainer app_metadata: ${metaErr.message}`);

  const { error: profileErr } = await admin
    .from('user_profiles')
    .update({ role: 'trainer' })
    .eq('id', userId);
  if (profileErr) throw new Error(`Failed to set trainer profile role: ${profileErr.message}`);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function provisionUsers(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceRoleKey: string,
  playerCount: number,
  log: (msg: string) => void,
): Promise<HarnessUsers> {
  log(`Provisioning trainer + ${playerCount} player accounts (reused if they exist)...`);
  const cache = loadTokenCache();
  const cachedCount = Object.keys(cache).length;
  if (cachedCount > 0) log(`  reusing ${cachedCount} cached tokens from a previous run`);

  const trainer =
    cache[TRAINER_EMAIL] !== undefined
      ? { email: TRAINER_EMAIL, ...cache[TRAINER_EMAIL] }
      : await ensureUser(
          admin,
          supabaseUrl,
          serviceRoleKey,
          TRAINER_EMAIL,
          'Load Test Trainer',
          120_000, // the trainer token is indispensable — wait out the rate limit if needed
        );
  if (!trainer) {
    throw new Error('Could not mint a trainer token (Supabase auth rate limit). Retry in ~5 min.');
  }
  await promoteToTrainer(admin, trainer.userId);

  let done = 0;
  let rateLimited = 0;
  let consecutiveRateLimited = 0;
  const players = await mapWithConcurrency(
    Array.from({ length: playerCount }, (_, i) => i + 1),
    4, // gentle on the Supabase auth rate limit
    async (n): Promise<TestUser | null> => {
      const email = playerEmail(n);
      const cached = cache[email];
      // Circuit breaker: once the auth endpoint is clearly rate-limiting us,
      // stop hammering it and let the remaining spectators borrow tokens.
      const user = cached
        ? { email, ...cached }
        : consecutiveRateLimited >= 8
          ? null
          : await ensureUser(
              admin,
              supabaseUrl,
              serviceRoleKey,
              email,
              `Load Test Player ${n}`,
              0, // players don't wait: fall back to token borrowing instead
            );
      done++;
      if (!user) {
        rateLimited++;
        consecutiveRateLimited++;
      } else if (!cached) {
        consecutiveRateLimited = 0;
      }
      if (done % 25 === 0 || done === playerCount)
        log(`  ${done}/${playerCount} players processed`);
      return user;
    },
  );

  const minted = players.filter((p): p is TestUser => p !== null);
  if (minted.length === 0) {
    throw new Error(
      'No player tokens could be minted (Supabase auth rate limit). Retry in ~5 min.',
    );
  }
  if (rateLimited > 0) {
    log(
      `  WARNING: Supabase auth rate limit hit; ${rateLimited} players will borrow tokens ` +
        `from the ${minted.length} minted identities (socket count is unaffected).`,
    );
  }

  // Fill the gaps by borrowing minted identities round-robin.
  const full: TestUser[] = players.map((p, i) => p ?? minted[i % minted.length]);

  saveTokenCache([trainer, ...minted]);
  return { trainer, players: full };
}

export async function registerParticipants(
  admin: SupabaseClient,
  sessionId: string,
  players: TestUser[],
): Promise<void> {
  // Dedupe borrowed identities: the same user id may back several spectators,
  // and Postgres rejects duplicate conflict keys within a single upsert.
  const uniqueIds = [...new Set(players.map((p) => p.userId))];
  const rows = uniqueIds.map((userId) => ({
    session_id: sessionId,
    user_id: userId,
    role: 'participant',
  }));
  // Chunk to stay well under request size limits.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await admin
      .from('session_participants')
      .upsert(chunk, { onConflict: 'session_id,user_id' });
    if (error) throw new Error(`Failed to register participants: ${error.message}`);
  }
}
