/**
 * Shared plumbing for the demo capture: Supabase admin access, account
 * provisioning with on-disk token caching, and a thin REST client for the
 * endpoints the admin agent needs.
 */

import 'dotenv/config';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN,
  API_BASE,
  DEMO_PASSWORD,
  PLAYERS_PER_TEAM,
  PLAYER_EMAIL_DOMAIN,
  ROSTER,
  SCENARIO_ID,
  TEAMS,
  playerEmail,
  type PlayerSpec,
} from './config.js';

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? readFrontendAnonKey();

function readFrontendAnonKey(): string {
  // The anon key lives in frontend/.env.local, which is not loaded by dotenv here.
  try {
    const raw = fs.readFileSync(path.join('frontend', '.env.local'), 'utf8');
    const match = raw.match(/^\s*VITE_SUPABASE_ANON_KEY\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  throw new Error('Could not resolve VITE_SUPABASE_ANON_KEY from frontend/.env.local');
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
}

export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Account provisioning
// ---------------------------------------------------------------------------

export interface Agent {
  /** 0 for the admin, 1-25 for players. */
  index: number;
  email: string;
  name: string;
  userId: string;
  /** Full Supabase session, handed to the browser so it skips the login UI. */
  session: Session;
}

const CACHE_PATH = path.join('demo-run', '.session-cache.json');
/** Refresh anything with under 30 minutes left; a run lasts over an hour. */
const MIN_TTL_MS = 30 * 60 * 1000;

type Cache = Record<string, { userId: string; session: Session }>;

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

function loadCache(): Cache {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as Cache;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(raw).filter(
        ([, v]) => jwtExpiryMs(v.session.access_token) - now > MIN_TTL_MS,
      ),
    );
  } catch {
    return {};
  }
}

function saveCache(agents: Agent[]): void {
  const merged: Cache = loadCache();
  for (const a of agents) merged[a.email] = { userId: a.userId, session: a.session };
  writeCache(merged);
}

function writeCache(cache: Cache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Refresh rotates the token, so persist just that field without touching identity. */
function cacheSession(email: string, session: Session): void {
  const cache = loadCache();
  const existing = cache[email];
  cache[email] = { userId: existing?.userId ?? session.user.id, session };
  writeCache(cache);
}

async function signIn(email: string): Promise<Session | null> {
  // Fresh client per sign-in: signInWithPassword mutates client-internal state,
  // which is unsafe at the concurrency we provision with.
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: DEMO_PASSWORD,
  });
  if (error || !data.session) {
    if (error && /rate limit/i.test(error.message)) throw new RateLimited(error.message);
    return null;
  }
  return data.session;
}

class RateLimited extends Error {}

async function ensureAgent(
  email: string,
  name: string,
  index: number,
  role: 'admin' | 'participant',
): Promise<Agent> {
  let session = await withRateLimitBackoff(() => signIn(email));

  if (!session) {
    const { error } = await admin.auth.admin.createUser({
      email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name, agency_name: 'AMP' },
    });
    if (error && !/already/i.test(error.message)) {
      throw new Error(`Failed to create ${email}: ${error.message}`);
    }
    session = await withRateLimitBackoff(() => signIn(email));
    if (!session) throw new Error(`Created ${email} but could not sign in`);
  }

  const userId = session.user.id;

  // The API resolves role from app_metadata first, user_profiles second. Set both.
  if (role === 'admin') {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: { role: 'admin', agency: 'AMP' },
    });
    if (error) throw new Error(`Failed to grant admin to ${email}: ${error.message}`);
  }

  await admin.from('user_profiles').upsert(
    {
      id: userId,
      username: email,
      full_name: name,
      role,
      agency_name: 'AMP',
      email,
    },
    { onConflict: 'id' },
  );

  return { index, email, name, userId, session };
}

async function withRateLimitBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let delay = 15_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimited) || attempt >= 5) throw err;
      process.stdout.write(`    auth rate limited, waiting ${delay / 1000}s...\n`);
      await sleep(delay);
      delay = Math.min(delay * 2, 120_000);
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Cohort {
  adminAgent: Agent;
  players: (Agent & { spec: PlayerSpec })[];
}

/**
 * Provision (or reuse) the admin plus every player on the roster. Sessions are
 * cached on disk because Supabase throttles password sign-ins to roughly 30 per
 * five minutes per IP, and a two-run capture needs 52 of them.
 */
export async function provisionCohort(
  playerCount = ROSTER.length,
  log: (m: string) => void = console.log,
  /** Specific roster indices, for hand-picked cohorts like the hero capture. */
  indices?: number[],
): Promise<Cohort> {
  const cache = loadCache();
  const cachedNames = Object.keys(cache);
  if (cachedNames.length) log(`  reusing ${cachedNames.length} cached sessions`);

  const fromCache = (email: string, name: string, index: number): Agent | null => {
    const hit = cache[email];
    return hit ? { index, email, name, userId: hit.userId, session: hit.session } : null;
  };

  log(`Provisioning admin + ${playerCount} players...`);

  const adminAgent =
    fromCache(ADMIN.email, ADMIN.name, 0) ??
    (await ensureAgent(ADMIN.email, ADMIN.name, 0, 'admin'));
  // Always re-assert the admin role: a cached session predates any role change.
  await admin.auth.admin.updateUserById(adminAgent.userId, {
    app_metadata: { role: 'admin', agency: 'AMP' },
  });
  await admin.from('user_profiles').update({ role: 'admin' }).eq('id', adminAgent.userId);

  const specs = indices
    ? indices
        .map((i) => ROSTER.find((r) => r.index === i))
        .filter((r): r is PlayerSpec => Boolean(r))
    : ROSTER.slice(0, playerCount);
  const players: (Agent & { spec: PlayerSpec })[] = [];

  // Serial with a small pause: provisioning is a one-time cost and staying
  // under the auth rate limit matters more than speed here.
  for (const spec of specs) {
    const email = playerEmail(spec.index);
    const cached = fromCache(email, spec.name, spec.index);
    const agent = cached ?? (await ensureAgent(email, spec.name, spec.index, 'participant'));
    players.push({ ...agent, spec });
    if (!cached) await sleep(400);
    if (players.length % 5 === 0) log(`  ${players.length}/${specs.length} players ready`);
  }

  saveCache([adminAgent, ...players]);
  return { adminAgent, players };
}

/**
 * Accounts that exist only to speak in an NPC's voice.
 *
 * Comments have to ARRIVE on camera, and the only path that broadcasts is
 * POST /api/social/posts — which authors as the signed-in user. So the crowd
 * voices need real accounts whose profile name is the persona's name. On screen
 * this is indistinguishable from seeded NPC content: Fakebook renders no badge
 * for either `player` or `npc_public`, and comment rows show the display name
 * rather than the handle.
 *
 * They never join the session. Posting is not gated on participation, so
 * provisioning is just an auth account and a profile row — no join form, and
 * therefore no exposure to the 10-per-minute join rate limit.
 */
export interface VoiceSpec {
  /** Stable key used by the shot runner, e.g. 'siti'. */
  key: string;
  /** Display name exactly as it should read on screen. */
  name: string;
}

export const voiceEmail = (key: string): string =>
  `demo-voice-${key}@${PLAYER_EMAIL_DOMAIN}`;

export async function provisionVoices(
  specs: VoiceSpec[],
  log: (m: string) => void = console.log,
): Promise<Map<string, Agent>> {
  const cache = loadCache();
  const out = new Map<string, Agent>();
  log(`Provisioning ${specs.length} NPC voices...`);

  for (const [i, spec] of specs.entries()) {
    const email = voiceEmail(spec.key);
    const hit = cache[email];
    const agent = hit
      ? { index: -1 - i, email, name: spec.name, userId: hit.userId, session: hit.session }
      : await ensureAgent(email, spec.name, -1 - i, 'participant');
    out.set(spec.key, agent);
    if (!hit) await sleep(400);
  }

  saveCache([...out.values()]);
  log(`  ${out.size} voices ready`);
  return out;
}

// ---------------------------------------------------------------------------
// Scenario preparation
// ---------------------------------------------------------------------------

/**
 * The scenario ships with team caps summing to 18 (Legal is capped at 2), and
 * /join/register rejects anyone past that sum. Raise every team to the roster
 * size so all 25 players fit.
 */
export async function ensureTeamCapacity(
  perTeam = PLAYERS_PER_TEAM,
  log: (m: string) => void = console.log,
): Promise<void> {
  const { data: teams, error } = await admin
    .from('scenario_teams')
    .select('id, team_name, min_participants, max_participants')
    .eq('scenario_id', SCENARIO_ID);

  if (error) throw new Error(`Could not read scenario_teams: ${error.message}`);
  if (!teams?.length) throw new Error('Scenario has no teams defined');

  const missing = TEAMS.filter((t) => !teams.some((r) => r.team_name === t));
  if (missing.length) throw new Error(`Scenario is missing expected teams: ${missing.join(', ')}`);

  for (const team of teams) {
    if (team.max_participants === perTeam) continue;
    const { error: upErr } = await admin
      .from('scenario_teams')
      .update({ max_participants: perTeam })
      .eq('id', team.id);
    if (upErr) throw new Error(`Failed to raise cap on ${team.team_name}: ${upErr.message}`);
    log(`  ${team.team_name}: max ${team.max_participants} -> ${perTeam}`);
  }

  const total = teams.length * perTeam;
  log(`  capacity now ${total} across ${teams.length} teams`);
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

/** Anything carrying a live Supabase session. Mutated in place on refresh. */
export interface Authed {
  email: string;
  session: Session;
}

/**
 * Exchange the refresh token for a new access token, in place. A full run plus
 * the staggered join window outlasts Supabase's one-hour access token, so this
 * has to work mid-run rather than only at provisioning time.
 */
export async function refreshSession(agent: Authed): Promise<void> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.refreshSession({
    refresh_token: agent.session.refresh_token,
  });
  if (error || !data.session) {
    // Refresh tokens rotate, so a stale cache entry can be unusable. Fall back
    // to a password sign-in, which always works for these demo accounts.
    const fresh = await withRateLimitBackoff(() => signIn(agent.email));
    if (!fresh) throw new Error(`Could not refresh or re-mint session for ${agent.email}`);
    agent.session = fresh;
  } else {
    agent.session = data.session;
  }
  cacheSession(agent.email, agent.session);
}

export async function apiFetch<T = unknown>(
  agent: Authed,
  route: string,
  init: RequestInit = {},
  { allowRefresh = true }: { allowRefresh?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agent.session.access_token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();

  if (res.status === 401 && allowRefresh) {
    await refreshSession(agent);
    return apiFetch<T>(agent, route, init, { allowRefresh: false });
  }

  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${route} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  // Most routes wrap payloads in { data }, a few return the object directly.
  const body = text ? JSON.parse(text) : {};
  return (body?.data ?? body) as T;
}

export interface SessionRow {
  id: string;
  join_token: string;
  status: string;
  sim_mode: string | null;
  start_time: string | null;
}

/** `scenarioId` defaults to the demo scenario; the marketing capture runs a clone. */
export const createSession = (
  agent: Authed,
  instructions: string,
  scenarioId: string = SCENARIO_ID,
): Promise<SessionRow> =>
  apiFetch<SessionRow>(agent, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ scenario_id: scenarioId, trainer_instructions: instructions }),
  });

export const setSessionStatus = (
  agent: Authed,
  sessionId: string,
  status: 'in_progress' | 'completed' | 'cancelled',
): Promise<SessionRow> =>
  apiFetch<SessionRow>(agent, `/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

export interface SocialState {
  sentiment_score?: number;
  public_trust?: number;
  community_safety?: number;
  narrative_control?: number;
  escalation_risk?: number;
}

export const getSocialState = (agent: Authed, sessionId: string): Promise<SocialState> =>
  apiFetch<SocialState>(agent, `/api/social/state/session/${sessionId}`);

export interface OrgPage {
  org_key: string;
  role: string;
  is_primary: boolean;
  display_name: string;
  controllers: string[];
}

export const listOrgPages = (agent: Authed, sessionId: string): Promise<OrgPage[]> =>
  apiFetch<OrgPage[]>(agent, `/api/social/pages/session/${sessionId}`);

/**
 * Without a page controller nobody can post as the organisation, so the
 * "Official statement published" objective can never be met and the compose
 * modal never even offers the "Posting as" toggle. Trainer-only.
 */
export const assignOrgPage = (
  agent: Authed,
  sessionId: string,
  userId: string,
  orgKey: string,
): Promise<unknown> =>
  apiFetch(agent, `/api/social/pages/session/${sessionId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, org_key: orgKey }),
  });

/**
 * Fire an armed inject into a live session.
 *
 * This is the call that makes content ARRIVE on camera. The route runs
 * routeInjectToApp(), which writes the row and then broadcasts, so an already
 * open feed or inbox updates without a reload. A direct database insert does
 * neither and is invisible to a page that is already on screen.
 */
export const publishInject = (
  agent: Authed,
  injectId: string,
  sessionId: string,
): Promise<unknown> =>
  apiFetch(agent, `/api/injects/${injectId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  });

/** Post as the authenticated player — used for live comments in NPC voices. */
export const postComment = (
  agent: Authed,
  sessionId: string,
  replyToPostId: string,
  content: string,
): Promise<unknown> =>
  apiFetch(agent, '/api/social/posts', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      content,
      platform: 'facebook',
      reply_to_post_id: replyToPostId,
    }),
  });

/** Send a Fakebook DM, optionally carrying a shared post card. */
export const sendDM = (
  agent: Authed,
  sessionId: string,
  recipientHandle: string,
  content: string,
  sharedPostId?: string,
): Promise<unknown> =>
  apiFetch(agent, '/api/social/messenger/send', {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      recipient_handle: recipientHandle,
      content,
      platform: 'facebook',
      ...(sharedPostId ? { shared_post_id: sharedPostId } : {}),
    }),
  });

/** Like a post through the API, which broadcasts an engagement_update. */
export const likePost = (agent: Authed, postId: string): Promise<unknown> =>
  apiFetch(agent, `/api/social/posts/${postId}/like`, { method: 'POST' });

/** Waits for the API to be reachable, so the runner can start the servers itself. */
export async function waitForApi(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`API at ${API_BASE} did not come up in time`);
    await sleep(2000);
  }
}
