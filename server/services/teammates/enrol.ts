import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { getWebSocketService } from '../websocketService.js';
import { ensureTeamChannels } from '../channelService.js';
import { invalidatePlayerTeamCache, teamIsPublicVoice } from '../teamCharterService.js';
import { isBoothJoinToken } from '../../lib/boothLink.js';
import { getPool, type BotAccount } from './accounts.js';

/**
 * Enrolment: putting a pooled bot account into a session as an ordinary
 * participant (docs/ai-teammate-bots-plan.md D5, §6.1).
 *
 * Writes exactly what routes/join.ts and routes/teams.ts write for a human —
 * session_participants (role 'participant'), session_teams, demographics, ready
 * flag — then triggers the same follow-ups (team channels, team cache).
 */

export type EnrolError =
  | { code: 'disabled'; message: string }
  | { code: 'not_found'; message: string }
  | { code: 'not_social'; message: string }
  | { code: 'finished'; message: string }
  | { code: 'unknown_team'; message: string }
  | { code: 'cap'; message: string }
  | { code: 'team_full'; message: string }
  | { code: 'pool_exhausted'; message: string }
  | { code: 'db'; message: string };

export interface SessionBotRow {
  user_id: string;
  display_name: string;
  team_name: string | null;
  is_ready: boolean;
  slot: number | null;
}

interface SessionRow {
  id: string;
  trainer_id: string | null;
  scenario_id: string | null;
  sim_mode: string | null;
  status: string;
  join_token: string | null;
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('id, trainer_id, scenario_id, sim_mode, status, join_token')
    .eq('id', sessionId)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/** Bot participants of a session, with team and display name. */
export async function listSessionBots(sessionId: string): Promise<SessionBotRow[]> {
  const [{ data: participants }, { data: teams }, pool] = await Promise.all([
    supabaseAdmin
      .from('session_participants')
      .select('user_id, is_ready, user:user_profiles!inner(full_name, is_bot)')
      .eq('session_id', sessionId)
      .eq('user.is_bot', true),
    supabaseAdmin.from('session_teams').select('user_id, team_name').eq('session_id', sessionId),
    getPool().catch(() => [] as BotAccount[]),
  ]);
  const teamByUser = new Map<string, string>();
  for (const t of teams ?? []) {
    const r = t as { user_id: string; team_name: string };
    if (!teamByUser.has(r.user_id)) teamByUser.set(r.user_id, r.team_name);
  }
  const slotByUser = new Map(pool.map((a) => [a.userId, a.persona.slot]));
  return (participants ?? []).map((p) => {
    const row = p as {
      user_id: string;
      is_ready: boolean | null;
      user: { full_name: string } | Array<{ full_name: string }> | null;
    };
    const user = Array.isArray(row.user) ? row.user[0] : row.user;
    return {
      user_id: row.user_id,
      display_name: user?.full_name ?? 'AI Teammate',
      team_name: teamByUser.get(row.user_id) ?? null,
      is_ready: Boolean(row.is_ready),
      slot: slotByUser.get(row.user_id) ?? null,
    };
  });
}

export async function addBot(
  sessionId: string,
  teamName: string,
  trainerId: string,
): Promise<
  { ok: true; bot: SessionBotRow; account: BotAccount } | { ok: false; error: EnrolError }
> {
  if (!env.enableTeammateBots) {
    return { ok: false, error: { code: 'disabled', message: 'AI teammates are disabled' } };
  }
  const session = await loadSession(sessionId);
  if (!session) return { ok: false, error: { code: 'not_found', message: 'Session not found' } };
  if (session.sim_mode !== 'social_media') {
    return {
      ok: false,
      error: {
        code: 'not_social',
        message: 'AI teammates are only available in social media crisis sessions',
      },
    };
  }
  if (session.status === 'completed' || session.status === 'cancelled') {
    return { ok: false, error: { code: 'finished', message: 'This session has ended' } };
  }

  // Team must exist in the scenario (closed set — same rule as routes/teams.ts).
  let teamCap: number | null = null;
  if (session.scenario_id) {
    const { data: teamDef } = await supabaseAdmin
      .from('scenario_teams')
      .select('team_name, max_participants')
      .eq('scenario_id', session.scenario_id)
      .eq('team_name', teamName)
      .maybeSingle();
    if (!teamDef) {
      return {
        ok: false,
        error: { code: 'unknown_team', message: 'Unknown team for this scenario' },
      };
    }
    teamCap = (teamDef as { max_participants: number | null }).max_participants ?? null;
  }

  const [existingBots, { count: teamCount }] = await Promise.all([
    listSessionBots(sessionId),
    supabaseAdmin
      .from('session_teams')
      .select('user_id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('team_name', teamName),
  ]);
  if (existingBots.length >= env.teammateBotsMaxPerSession) {
    return {
      ok: false,
      error: {
        code: 'cap',
        message: `At most ${env.teammateBotsMaxPerSession} AI teammates per session`,
      },
    };
  }
  if (teamCap !== null && teamCount !== null && teamCount >= teamCap) {
    return {
      ok: false,
      error: {
        code: 'team_full',
        message: `${teamName} is at its cap of ${teamCap}. Raise max participants in the scenario to add more.`,
      },
    };
  }

  // Pick a free pool account: not already in this session; prefer ones idle everywhere.
  const pool = await getPool();
  const inSession = new Set(existingBots.map((b) => b.user_id));
  const { data: busyRows } = await supabaseAdmin
    .from('session_participants')
    .select('user_id, session:sessions!inner(status)')
    .in(
      'user_id',
      pool.map((a) => a.userId),
    )
    .eq('session.status', 'in_progress');
  const busy = new Set((busyRows ?? []).map((r) => (r as { user_id: string }).user_id));
  const free = pool.filter((a) => !inSession.has(a.userId));
  const account = free.find((a) => !busy.has(a.userId)) ?? free[0];
  if (!account) {
    return {
      ok: false,
      error: { code: 'pool_exhausted', message: 'No free AI teammate accounts' },
    };
  }

  const persona = account.persona;
  const { error: pErr } = await supabaseAdmin.from('session_participants').upsert(
    {
      session_id: sessionId,
      user_id: account.userId,
      role: 'participant',
      is_ready: true,
      joined_lobby_at: new Date().toISOString(),
      demographics: {
        age_bracket: persona.ageBracket,
        gender: persona.gender,
        religion: persona.religion,
        race: persona.race,
      },
    },
    { onConflict: 'session_id,user_id' },
  );
  if (pErr) {
    logger.error({ err: pErr, sessionId }, 'teammates: participant insert failed');
    return { ok: false, error: { code: 'db', message: 'Failed to add AI teammate' } };
  }

  // One team per player in social sessions: move semantics.
  await supabaseAdmin
    .from('session_teams')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', account.userId)
    .neq('team_name', teamName);
  const { error: tErr } = await supabaseAdmin.from('session_teams').upsert(
    {
      session_id: sessionId,
      user_id: account.userId,
      team_name: teamName,
      assigned_by: trainerId,
    },
    { onConflict: 'session_id,user_id,team_name' },
  );
  if (tErr) {
    logger.error({ err: tErr, sessionId }, 'teammates: team assignment failed');
    return { ok: false, error: { code: 'db', message: 'Failed to assign AI teammate to team' } };
  }
  invalidatePlayerTeamCache(sessionId, account.userId);
  await ensureTeamChannels(sessionId, session.trainer_id ?? trainerId);
  await broadcastReadyStatus(sessionId);

  logger.info({ sessionId, botUserId: account.userId, teamName }, 'teammates: bot enrolled');
  return {
    ok: true,
    account,
    bot: {
      user_id: account.userId,
      display_name: persona.fullName,
      team_name: teamName,
      is_ready: true,
      slot: persona.slot,
    },
  };
}

export async function removeBot(
  sessionId: string,
  botUserId: string,
): Promise<{ ok: true } | { ok: false; error: EnrolError }> {
  const bots = await listSessionBots(sessionId);
  if (!bots.some((b) => b.user_id === botUserId)) {
    return {
      ok: false,
      error: { code: 'not_found', message: 'That AI teammate is not in this session' },
    };
  }
  // session_teams / session_page_controllers cascade from the participant row.
  await supabaseAdmin
    .from('session_page_controllers')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', botUserId);
  await supabaseAdmin
    .from('session_teams')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', botUserId);
  const { error } = await supabaseAdmin
    .from('session_participants')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', botUserId);
  if (error) {
    logger.error({ err: error, sessionId, botUserId }, 'teammates: participant delete failed');
    return { ok: false, error: { code: 'db', message: 'Failed to remove AI teammate' } };
  }
  invalidatePlayerTeamCache(sessionId, botUserId);
  await broadcastReadyStatus(sessionId);
  logger.info({ sessionId, botUserId }, 'teammates: bot removed');
  return { ok: true };
}

/**
 * Give an organisation's page to a bot on that organisation's own public-voice team when no bot holds
 * it. Outside booth worlds this covers the primary page only and never touches a page a human holds.
 * In booth worlds every player-run organisation's page gets a bot, alongside any visitor holding it,
 * so the world keeps its voices when visitors walk away.
 */
export async function ensurePageHolder(sessionId: string): Promise<void> {
  try {
    const session = await loadSession(sessionId);
    if (!session?.scenario_id) return;
    const [{ data: pages }, { data: controllers }, bots, { data: teamRows }] = await Promise.all([
      supabaseAdmin
        .from('sim_org_pages')
        .select('org_key, role, is_primary, control_mode')
        .eq('session_id', sessionId),
      supabaseAdmin
        .from('session_page_controllers')
        .select('user_id, org_key')
        .eq('session_id', sessionId),
      listSessionBots(sessionId),
      supabaseAdmin
        .from('scenario_teams')
        .select('team_name, function_key, org_key, charter')
        .eq('scenario_id', session.scenario_id),
    ]);
    const protagonist = (pages ?? []).filter(
      (p) => String((p as { role?: string }).role ?? 'protagonist') === 'protagonist',
    ) as Array<{ org_key: string; is_primary?: boolean | null; control_mode?: string | null }>;
    const primary = protagonist.find((p) => p.is_primary) ?? protagonist[0];
    if (!primary) return;

    const booth = isBoothJoinToken(session.join_token);
    const orgKeys = booth
      ? [
          primary.org_key,
          ...new Set(
            protagonist
              .filter((p) => p.control_mode !== 'ai' && p.org_key !== primary.org_key)
              .map((p) => p.org_key),
          ),
        ]
      : [primary.org_key];

    const teams = (teamRows ?? []) as Array<{
      team_name: string;
      function_key?: string | null;
      org_key?: string | null;
      charter?: Record<string, unknown> | null;
    }>;
    const orgOfTeam = new Map(teams.map((t) => [t.team_name, t.org_key ?? primary.org_key]));
    const voiceTeams = new Set(teams.filter((t) => teamIsPublicVoice(t)).map((t) => t.team_name));
    const rows = (controllers ?? []) as Array<{ user_id: string; org_key: string }>;
    const botIds = new Set(bots.map((b) => b.user_id));
    const holding = new Set(rows.map((c) => c.user_id));

    for (const orgKey of orgKeys) {
      const holders = rows.filter((c) => c.org_key === orgKey);
      if (holders.some((c) => botIds.has(c.user_id))) continue;
      if (holders.length > 0 && !booth) continue;
      const free = bots.filter(
        (b): b is SessionBotRow & { team_name: string } =>
          !!b.team_name && orgOfTeam.get(b.team_name) === orgKey && !holding.has(b.user_id),
      );
      const candidate =
        free.find((b) => voiceTeams.has(b.team_name)) ??
        (orgKey === primary.org_key
          ? free.find((b) => /communication/i.test(b.team_name))
          : undefined);
      if (!candidate) continue;

      const { error } = await supabaseAdmin.from('session_page_controllers').upsert(
        {
          session_id: sessionId,
          user_id: candidate.user_id,
          org_key: orgKey,
          assigned_by: session.trainer_id,
        },
        { onConflict: 'session_id,user_id' },
      );
      if (error) {
        logger.warn({ err: error, sessionId, orgKey }, 'teammates: page holder assignment failed');
        continue;
      }
      holding.add(candidate.user_id);
      logger.info(
        { sessionId, bot: candidate.display_name, orgKey },
        'teammates: bot holds the org page',
      );
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'teammates: ensurePageHolder failed');
  }
}

/** Same payload routes/sessions.ts broadcasts after a ready toggle, so the lobby updates live. */
export async function broadcastReadyStatus(sessionId: string): Promise<void> {
  try {
    const { data: all } = await supabaseAdmin
      .from('session_participants')
      .select('user_id, is_ready, user:user_profiles(full_name)')
      .eq('session_id', sessionId);
    const participants = (all ?? []).map((p) => {
      const row = p as {
        user_id: string;
        is_ready: boolean | null;
        user?: { full_name: string } | Array<{ full_name: string }> | null;
      };
      const user = Array.isArray(row.user) ? row.user[0] : row.user;
      return {
        user_id: row.user_id,
        is_ready: Boolean(row.is_ready),
        user: user ? { full_name: user.full_name } : undefined,
      };
    });
    const total = participants.length;
    const ready = participants.filter((p) => p.is_ready).length;
    getWebSocketService().readyStatusUpdated(sessionId, {
      total,
      ready,
      all_ready: total > 0 && ready === total,
      participants,
    });
  } catch (err) {
    logger.debug({ err, sessionId }, 'teammates: ready-status broadcast failed');
  }
}
