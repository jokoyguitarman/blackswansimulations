import { createClient, type Session } from '@supabase/supabase-js';
import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import type { BotPersona } from './types.js';

/**
 * The pooled bot accounts (docs/ai-teammate-bots-plan.md D3/D4).
 *
 * Sixteen real Supabase auth users, created lazily through the Admin API so GoTrue
 * writes every column password sign-in needs. Identity: `username` in
 * user_profiles (`teammate.bot.NN`), flagged `is_bot = true`. A session picks
 * unused slots; the same account may play in different sessions concurrently.
 *
 * Tokens: password sign-in with the service-role client (the same approach the
 * load-test harness uses), cached in memory, refreshed with the refresh token,
 * and re-minted after re-asserting the password if credentials ever drift.
 */

export const BOT_EMAIL_DOMAIN = 'blackswan.internal';
export const BOT_AGENCY = 'AI Teammate';

const P = (
  slot: number,
  fullName: string,
  persona: string,
  gender: BotPersona['gender'],
  ageBracket: BotPersona['ageBracket'],
  religion: BotPersona['religion'],
  race: string,
): BotPersona => ({
  slot,
  email: `teammate-bot-${String(slot).padStart(2, '0')}@${BOT_EMAIL_DOMAIN}`,
  username: `teammate.bot.${String(slot).padStart(2, '0')}`,
  fullName,
  persona,
  gender,
  ageBracket,
  religion,
  race,
});

/**
 * Personas describe working style only. The team lane always comes from the
 * charter the game serves the bot, so any persona can sit on any team.
 */
export const BOT_POOL: readonly BotPersona[] = [
  P(
    1,
    'Nurul Aisyah Rahim',
    'Senior, decisive, writes fast and clean. Twelve years in public affairs.',
    'female',
    '36_50',
    'islam',
    'Malay',
  ),
  P(
    2,
    'Daniel Tan Wei Ming',
    'Two years in, quick on platforms, watches trending threads closely.',
    'male',
    '26_35',
    'christianity',
    'Chinese',
  ),
  P(
    3,
    'Farah Iskandar',
    'Strong instinct for tone; bilingual; thinks about how the community will read it.',
    'female',
    '26_35',
    'islam',
    'Malay',
  ),
  P(
    4,
    'Priya Raman',
    'Methodical, guards against speculation, likes a documented source.',
    'female',
    '36_50',
    'hinduism',
    'Indian',
  ),
  P(
    5,
    'Shahrizal Kamaruddin',
    'Cautious and thorough; insists nothing goes out unverified.',
    'male',
    '51_plus',
    'islam',
    'Malay',
  ),
  P(
    6,
    'Grace Lim Hui Ling',
    'Precise, procedural, comfortable with regulators and paperwork.',
    'female',
    '36_50',
    'buddhism',
    'Chinese',
  ),
  P(
    7,
    'Imran Yusof',
    'Junior but sharp; spots reputational and legal risk in phrasing.',
    'male',
    '18_25',
    'islam',
    'Malay',
  ),
  P(
    8,
    'Devi Krishnan',
    'Owns the audit trail; keeps references and timestamps on everything.',
    'female',
    '36_50',
    'hinduism',
    'Indian',
  ),
  P(
    9,
    'Zainab Mokhtar',
    'Calm senior liaison; manages expectations upward and outward.',
    'female',
    '51_plus',
    'islam',
    'Malay',
  ),
  P(
    10,
    'Alvin Goh',
    'Politically aware; avoids surprises; briefs before he acts.',
    'male',
    '36_50',
    'none',
    'Chinese',
  ),
  P(
    11,
    'Sharifah Nadia',
    'Trusted by community leaders; warm, direct, plain-spoken.',
    'female',
    '26_35',
    'islam',
    'Malay',
  ),
  P(
    12,
    'Rajesh Pillai',
    'Organised secretariat mind; prepares escalations and decision items.',
    'male',
    '36_50',
    'hinduism',
    'Indian',
  ),
  P(
    13,
    'Faizal Rahman',
    'Relationship-first; protects partners and long-term trust.',
    'male',
    '36_50',
    'islam',
    'Malay',
  ),
  P(
    14,
    'Cheryl Ong',
    'Commercially minded; handles nervous corporate partners well.',
    'female',
    '26_35',
    'christianity',
    'Chinese',
  ),
  P(
    15,
    'Siti Nurhaliza Aziz',
    'Reassuring and exact with numbers; protects confidence under pressure.',
    'female',
    '36_50',
    'islam',
    'Malay',
  ),
  P(
    16,
    'Jonathan Lee',
    'Pragmatic closer; handles refund and complaint conversations calmly.',
    'male',
    '26_35',
    'buddhism',
    'Chinese',
  ),
];

export interface BotAccount {
  userId: string;
  persona: BotPersona;
}

const accountBySlot = new Map<number, BotAccount>();
const accountByUserId = new Map<string, BotAccount>();
let poolEnsured: Promise<BotAccount[]> | null = null;

/** Create-or-find every pooled account. Idempotent; runs once per process (retries on failure). */
export function ensurePool(): Promise<BotAccount[]> {
  if (!poolEnsured) {
    poolEnsured = ensurePoolInner().catch((err) => {
      poolEnsured = null;
      throw err;
    });
  }
  return poolEnsured;
}

async function ensurePoolInner(): Promise<BotAccount[]> {
  const { data: existing, error } = await supabaseAdmin
    .from('user_profiles')
    .select('id, username, email')
    .eq('is_bot', true);
  if (error) throw new Error(`Failed to read bot pool: ${error.message}`);

  const byUsername = new Map<string, { id: string }>();
  const byEmail = new Map<string, { id: string }>();
  for (const row of existing ?? []) {
    const r = row as { id: string; username: string | null; email: string | null };
    if (r.username) byUsername.set(r.username, { id: r.id });
    if (r.email) byEmail.set(r.email.toLowerCase(), { id: r.id });
  }

  const accounts: BotAccount[] = [];
  for (const persona of BOT_POOL) {
    let userId =
      byUsername.get(persona.username)?.id ?? byEmail.get(persona.email.toLowerCase())?.id ?? null;
    if (!userId) {
      userId = await createBotUser(persona);
    }
    // Assert the profile shape every boot: role, flag, display name, agency.
    const { error: upErr } = await supabaseAdmin.from('user_profiles').upsert(
      {
        id: userId,
        username: persona.username,
        full_name: persona.fullName,
        role: 'participant',
        agency_name: BOT_AGENCY,
        email: persona.email,
        is_bot: true,
      },
      { onConflict: 'id' },
    );
    if (upErr) {
      logger.warn({ err: upErr, slot: persona.slot }, 'teammates: bot profile upsert failed');
    }
    const account: BotAccount = { userId, persona };
    accounts.push(account);
    accountBySlot.set(persona.slot, account);
    accountByUserId.set(userId, account);
  }
  logger.info({ count: accounts.length }, 'teammates: bot account pool ready');
  return accounts;
}

async function createBotUser(persona: BotPersona): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: persona.email,
    password: env.teammateBotPassword,
    email_confirm: true,
    user_metadata: {
      username: persona.username,
      full_name: persona.fullName,
      agency_name: BOT_AGENCY,
    },
  });
  if (!error && data?.user) return data.user.id;

  // Already registered but the profile was never flagged: find it through the admin list.
  if (error && /already|exists|registered/i.test(error.message)) {
    const found = await findAuthUserByEmail(persona.email);
    if (found) return found;
  }
  throw new Error(`Failed to create bot account ${persona.email}: ${error?.message ?? 'unknown'}`);
}

async function findAuthUserByEmail(email: string): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 500 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 500) return null;
  }
  return null;
}

export async function getPool(): Promise<BotAccount[]> {
  return ensurePool();
}

export async function getAccount(userId: string): Promise<BotAccount | null> {
  await ensurePool();
  return accountByUserId.get(userId) ?? null;
}

export async function isBotUser(userId: string): Promise<boolean> {
  return (await getAccount(userId)) !== null;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface CachedSession {
  session: Session;
  /** epoch ms */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedSession>();
const inflight = new Map<string, Promise<string>>();
/** Refresh when under this much lifetime remains. */
const MIN_TTL_MS = 5 * 60 * 1000;

function authClient() {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

async function signIn(email: string): Promise<Session> {
  let delay = 5_000;
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await authClient().auth.signInWithPassword({
      email,
      password: env.teammateBotPassword,
    });
    if (!error && data.session) return data.session;
    const msg = error?.message ?? 'no session';
    if (/rate limit/i.test(msg) && attempt < 4) {
      logger.warn({ email, delay }, 'teammates: auth rate limited, backing off');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
      continue;
    }
    throw new Error(msg);
  }
}

/** Access token for a pooled bot; mints, refreshes or re-mints as needed. */
export async function getBotToken(userId: string, forceRefresh = false): Promise<string> {
  const cached = tokenCache.get(userId);
  if (!forceRefresh && cached && cached.expiresAt - Date.now() > MIN_TTL_MS) {
    return cached.session.access_token;
  }
  const pending = inflight.get(userId);
  if (pending) return pending;

  const task = (async () => {
    const account = await getAccount(userId);
    if (!account) throw new Error(`Unknown bot user ${userId}`);

    // Prefer a refresh when we hold a refresh token.
    if (cached?.session.refresh_token) {
      const { data, error } = await authClient().auth.refreshSession({
        refresh_token: cached.session.refresh_token,
      });
      if (!error && data.session) {
        remember(userId, data.session);
        return data.session.access_token;
      }
    }

    try {
      const session = await signIn(account.persona.email);
      remember(userId, session);
      return session.access_token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/invalid login|credentials/i.test(msg)) throw err;
      // Password drifted (rotated env, or the account pre-dated this feature): re-assert and retry.
      logger.warn({ userId }, 'teammates: bot password mismatch, re-asserting from env');
      const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        password: env.teammateBotPassword,
      });
      if (upErr) throw new Error(`Could not reset bot password: ${upErr.message}`);
      const session = await signIn(account.persona.email);
      remember(userId, session);
      return session.access_token;
    }
  })();

  inflight.set(userId, task);
  try {
    return await task;
  } finally {
    inflight.delete(userId);
  }
}

function remember(userId: string, session: Session): void {
  tokenCache.set(userId, { session, expiresAt: jwtExpiryMs(session.access_token) });
}

export function forgetToken(userId: string): void {
  tokenCache.delete(userId);
}
