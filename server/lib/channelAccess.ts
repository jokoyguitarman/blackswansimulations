/**
 * Channel access — the one rule for REST and WebSocket.
 *
 * Mirrors the SQL predicate `can_user_access_channel` (migration 198) exactly. If you change
 * one, change the other.
 */
import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';
import type { AccessUser } from './access.js';

export type ChannelType =
  | 'public'
  | 'inter_agency'
  | 'private'
  | 'command'
  | 'trainer'
  | 'role_specific'
  | 'direct'
  | 'team'
  | 'npc_direct';

export interface ChannelRow {
  id: string;
  session_id: string;
  name: string;
  type: ChannelType;
  team_name: string | null;
  stakeholder_id: string | null;
  members: string[];
  role_filter: string | null;
  created_by: string | null;
  created_at: string;
}

export type ChannelAccessResult =
  | { ok: true; channel: ChannelRow; isTrainer: boolean }
  | { ok: false; status: 403 | 404; error: string };

const MEMBER_ONLY_TYPES: ReadonlySet<ChannelType> = new Set(['direct', 'npc_direct']);

export function toChannelRow(raw: Record<string, unknown>): ChannelRow {
  return {
    id: String(raw.id),
    session_id: String(raw.session_id),
    name: String(raw.name ?? ''),
    type: String(raw.type) as ChannelType,
    team_name: (raw.team_name as string | null | undefined) ?? null,
    stakeholder_id: (raw.stakeholder_id as string | null | undefined) ?? null,
    members: Array.isArray(raw.members) ? (raw.members as string[]) : [],
    role_filter: (raw.role_filter as string | null | undefined) ?? null,
    created_by: (raw.created_by as string | null | undefined) ?? null,
    created_at: String(raw.created_at ?? ''),
  };
}

async function isSessionStaff(sessionId: string, user: AccessUser): Promise<boolean> {
  if (user.role === 'admin') return true;
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('trainer_id')
    .eq('id', sessionId)
    .maybeSingle();
  return !!data && data.trainer_id === user.id;
}

async function isParticipant(sessionId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('session_participants')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

async function isTeamMember(sessionId: string, userId: string, teamName: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('session_teams')
    .select('user_id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .eq('team_name', teamName)
    .limit(1);
  return !!data && data.length > 0;
}

/** Pure part of the rule, given the facts. Exported for the list filter. */
export function channelAllows(
  channel: ChannelRow,
  facts: { userId: string; isStaff: boolean; isParticipant: boolean; teamNames: Set<string> },
): boolean {
  if (facts.isStaff) return true;
  if (MEMBER_ONLY_TYPES.has(channel.type)) return channel.members.includes(facts.userId);
  if (channel.type === 'team') return !!channel.team_name && facts.teamNames.has(channel.team_name);
  if (channel.type === 'trainer') return false;
  return facts.isParticipant;
}

export async function assertChannelAccess(
  channelId: string,
  user: AccessUser,
): Promise<ChannelAccessResult> {
  const { data, error } = await supabaseAdmin
    .from('chat_channels')
    .select('*')
    .eq('id', channelId)
    .maybeSingle();
  if (error) {
    logger.error({ error, channelId }, 'assertChannelAccess: failed to load channel');
    return { ok: false, status: 404, error: 'Channel not found' };
  }
  if (!data) return { ok: false, status: 404, error: 'Channel not found' };

  const channel = toChannelRow(data as Record<string, unknown>);
  const staff = await isSessionStaff(channel.session_id, user);
  if (staff) return { ok: true, channel, isTrainer: true };

  let allowed = false;
  if (MEMBER_ONLY_TYPES.has(channel.type)) {
    allowed = channel.members.includes(user.id);
  } else if (channel.type === 'team') {
    allowed =
      !!channel.team_name && (await isTeamMember(channel.session_id, user.id, channel.team_name));
  } else if (channel.type === 'trainer') {
    allowed = false;
  } else {
    allowed = await isParticipant(channel.session_id, user.id);
  }

  if (!allowed) return { ok: false, status: 403, error: 'Access denied' };
  return { ok: true, channel, isTrainer: false };
}

/** Non-DM channels the caller may see, in creation order. */
export async function listAccessibleChannels(
  sessionId: string,
  user: AccessUser,
): Promise<{ channels: ChannelRow[]; isTrainer: boolean }> {
  const { data, error } = await supabaseAdmin
    .from('chat_channels')
    .select('*')
    .eq('session_id', sessionId)
    .not('type', 'in', '("direct","npc_direct")')
    .order('created_at', { ascending: true });
  if (error) {
    logger.error({ error, sessionId }, 'listAccessibleChannels: failed to load channels');
    return { channels: [], isTrainer: false };
  }
  const rows = (data ?? []).map((r) => toChannelRow(r as Record<string, unknown>));

  const isStaff = await isSessionStaff(sessionId, user);
  if (isStaff) return { channels: rows, isTrainer: true };

  const [participant, teams] = await Promise.all([
    isParticipant(sessionId, user.id),
    supabaseAdmin
      .from('session_teams')
      .select('team_name')
      .eq('session_id', sessionId)
      .eq('user_id', user.id),
  ]);
  const teamNames = new Set(
    (teams.data ?? []).map((r) => String((r as { team_name: string }).team_name)),
  );
  const facts = { userId: user.id, isStaff: false, isParticipant: participant, teamNames };
  return { channels: rows.filter((c) => channelAllows(c, facts)), isTrainer: false };
}

/**
 * User ids who may read a channel — used for member counts, member lists and per-message
 * notifications. Trainer is included for every channel.
 */
export async function getChannelMemberIds(channel: ChannelRow): Promise<string[]> {
  const ids = new Set<string>();
  const { data: session } = await supabaseAdmin
    .from('sessions')
    .select('trainer_id')
    .eq('id', channel.session_id)
    .maybeSingle();
  const trainerId = (session?.trainer_id as string | null) ?? null;

  if (MEMBER_ONLY_TYPES.has(channel.type)) {
    for (const m of channel.members) ids.add(m);
  } else if (channel.type === 'team' && channel.team_name) {
    const { data } = await supabaseAdmin
      .from('session_teams')
      .select('user_id')
      .eq('session_id', channel.session_id)
      .eq('team_name', channel.team_name);
    for (const r of data ?? []) ids.add(String((r as { user_id: string }).user_id));
    if (trainerId) ids.add(trainerId);
  } else if (channel.type === 'trainer') {
    if (trainerId) ids.add(trainerId);
  } else {
    const { data } = await supabaseAdmin
      .from('session_participants')
      .select('user_id')
      .eq('session_id', channel.session_id);
    for (const r of data ?? []) ids.add(String((r as { user_id: string }).user_id));
    if (trainerId) ids.add(trainerId);
  }
  return Array.from(ids);
}
