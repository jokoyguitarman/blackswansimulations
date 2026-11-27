/**
 * Pure role decisions: assignment checks, offline prompts, timed fallback,
 * reroute, and the scope strings chains and moods will store.
 */

import type { FallbackReason, RoleFallback } from '../calls/lineCore.js';

export const ROLE_ID_RE = /^[a-z0-9_]{2,40}$/;

export interface PlayerRoleDef {
  role_id: string;
  title: string;
  team_name: string;
  description?: string;
  max_per_session: number;
}

export interface PendingContact {
  id: string;
  kind: 'delivery' | 'call_group' | 'chain';
  channel?: 'email' | 'npc_dm' | 'messenger_dm' | 'chat' | 'call';
  inject_id?: string;
  /** Ledger id of the original delivery, when this row is a scheduled call group. */
  delivery_id?: string;
  /** Already re-delivered or itself a linked fallback. */
  already_linked?: boolean;
}

export interface LinkedRedelivery {
  source_id: string;
  channel: 'email' | 'npc_dm' | 'messenger_dm' | 'chat' | 'call';
  team_name: string;
  fallback_reason: FallbackReason;
  /** Original delivery this new one is linked to. Null when the call has not been delivered yet. */
  chain_root_id: string | null;
  inject_id?: string;
  call_group_id?: string;
}

export function roleIdFromTitle(title: string, taken: readonly string[] = []): string {
  let base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (base.length < 2) base = 'role';
  const used = new Set(taken);
  let id = base;
  let n = 2;
  while (used.has(id) || !ROLE_ID_RE.test(id)) {
    const suffix = `_${n}`;
    id = `${base.slice(0, Math.max(2, 40 - suffix.length))}${suffix}`;
    n += 1;
    if (n > 100) break;
  }
  return id;
}

export function parsePlayerRoles(value: unknown): PlayerRoleDef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roles: PlayerRoleDef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const roleId = typeof row.role_id === 'string' ? row.role_id.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const team = typeof row.team_name === 'string' ? row.team_name.trim() : '';
    if (!ROLE_ID_RE.test(roleId) || !title || !team || seen.has(roleId)) continue;
    seen.add(roleId);
    const maxRaw = row.max_per_session;
    const max = typeof maxRaw === 'number' && maxRaw >= 1 ? Math.floor(maxRaw) : 1;
    const description = typeof row.description === 'string' ? row.description : undefined;
    roles.push({
      role_id: roleId,
      title,
      team_name: team,
      max_per_session: max,
      ...(description ? { description } : {}),
    });
  }
  return roles;
}

export function validateRoleAssignment(input: {
  role: PlayerRoleDef | null;
  userIds: readonly string[];
  members: ReadonlyArray<{ user_id: string; team_name: string; is_bot: boolean }>;
}): { ok: true } | { ok: false; error: string } {
  if (!input.role) return { ok: false, error: 'Unknown role' };
  if (input.userIds.length > input.role.max_per_session) {
    return { ok: false, error: `At most ${input.role.max_per_session} player(s) may hold this role` };
  }
  for (const userId of input.userIds) {
    const member = input.members.find((row) => row.user_id === userId && row.team_name === input.role?.team_name);
    if (!member) return { ok: false, error: 'That player is not on the role’s team' };
    if (member.is_bot) return { ok: false, error: 'A bot cannot hold a role' };
  }
  return { ok: true };
}

export function injectRoleTargetError(input: {
  config: Record<string, unknown> | null;
  roles: readonly PlayerRoleDef[];
  targetTeams: readonly string[];
  isTemplate: boolean;
}): { error?: string; warning?: string } {
  if (!input.config) return {};
  const roleId = typeof input.config.target_role_id === 'string' ? input.config.target_role_id : '';
  const callTarget = input.config.call_target as { mode?: unknown } | undefined;
  if (input.isTemplate && callTarget?.mode === 'player') {
    return { error: 'A template cannot target a specific player id' };
  }
  if (!roleId) return {};
  const role = input.roles.find((row) => row.role_id === roleId);
  if (!role) return { error: `Unknown role "${roleId}"` };
  if (input.targetTeams.length > 0 && !input.targetTeams.includes(role.team_name)) {
    return { warning: `${role.title} is on ${role.team_name}, which is not one of the targeted teams. The role still wins.` };
  }
  return {};
}

/** One prompt per offline stretch. Later ticks pass alreadyPrompted. */
export function shouldPromptUnreachable(input: {
  enginesOn: boolean;
  roleOfflinePrompt: boolean;
  alreadyPrompted: boolean;
  offlinePastGrace: boolean;
  pending: readonly PendingContact[];
}): { emit: boolean } {
  if (!input.enginesOn || !input.roleOfflinePrompt || input.alreadyPrompted) return { emit: false };
  if (!input.offlinePastGrace || input.pending.length === 0) return { emit: false };
  return { emit: true };
}

/**
 * Inject fallback wins over the session policy. `none` still allows the session
 * default when `role_offline_auto_fallback_minutes` is set. A player who is back
 * online stops the timer.
 */
export function timedFallbackDue(input: {
  roleFallback: RoleFallback;
  roleFallbackMinutes: number | null;
  policyMinutes: number | null;
  offlineMinutes: number;
  playerBackOnline: boolean;
}): { due: boolean; reason?: 'role_offline_fallback' | 'role_fallback_after_minutes' } {
  if (input.playerBackOnline) return { due: false };
  if (input.roleFallback === 'line') return { due: false };
  if (input.roleFallback === 'line_after_minutes') {
    const minutes = input.roleFallbackMinutes ?? 10;
    if (input.offlineMinutes >= minutes) return { due: true, reason: 'role_fallback_after_minutes' };
    return { due: false };
  }
  if (input.policyMinutes != null && input.offlineMinutes >= input.policyMinutes) {
    return { due: true, reason: 'role_offline_fallback' };
  }
  return { due: false };
}

export type RerouteClaim = 'deliver' | 'skip_already' | 'skip_unwritable';

/**
 * A repeat pass is a no-op once the original is stamped or a linked child exists.
 * If the marker column cannot be written, skip the copy instead of sending it again.
 */
export function rerouteClaim(input: {
  markerWritable: boolean;
  originalStamped: boolean;
  childExists: boolean;
}): RerouteClaim {
  if (input.originalStamped || input.childExists) return 'skip_already';
  if (!input.markerWritable) return 'skip_unwritable';
  return 'deliver';
}

/** Second pass sees the originals stamped by the first pass's deliveries. */
export function rerouteRepeat(pending: readonly PendingContact[], options?: { teamName?: string; reason?: FallbackReason }): {
  first: LinkedRedelivery[];
  second: LinkedRedelivery[];
} {
  const first = planReroute(pending, options);
  const stampedIds = new Set(
    first.deliveries.flatMap((item) => [item.source_id, item.chain_root_id].filter((id): id is string => Boolean(id))),
  );
  const second = planReroute(
    pending.map((item) => (stampedIds.has(item.id) ? { ...item, already_linked: true } : item)),
    options,
  );
  return { first: first.deliveries, second: second.deliveries };
}

export function planReroute(
  pending: readonly PendingContact[],
  options?: { teamName?: string; reason?: FallbackReason },
): {
  rerouted: PendingContact[];
  cancelCallGroups: string[];
  pauseChains: string[];
  fallback_reason: FallbackReason;
  deliveries: LinkedRedelivery[];
} {
  const reason = options?.reason ?? 'trainer_reroute';
  const team = options?.teamName ?? '';
  const seen = new Set<string>();
  const rerouted: PendingContact[] = [];
  for (const item of pending) {
    if (item.already_linked || seen.has(item.id)) continue;
    seen.add(item.id);
    rerouted.push(item);
  }
  const deliveries: LinkedRedelivery[] = [];
  for (const item of rerouted) {
    if (item.kind === 'chain') continue;
    const channel = item.kind === 'call_group' ? 'call' : (item.channel ?? 'email');
    deliveries.push({
      source_id: item.id,
      channel,
      team_name: team,
      fallback_reason: reason,
      chain_root_id: item.kind === 'delivery' ? item.id : (item.delivery_id ?? null),
      ...(item.inject_id ? { inject_id: item.inject_id } : {}),
      ...(item.kind === 'call_group' ? { call_group_id: item.id } : {}),
    });
  }
  const collapsed: LinkedRedelivery[] = [];
  const callByInject = new Map<string, LinkedRedelivery>();
  for (const item of deliveries) {
    if (item.channel !== 'call') {
      collapsed.push(item);
      continue;
    }
    const key = item.inject_id ?? item.source_id;
    const previous = callByInject.get(key);
    if (!previous) {
      callByInject.set(key, item);
      continue;
    }
    callByInject.set(key, {
      ...previous,
      chain_root_id: previous.chain_root_id ?? item.chain_root_id,
      source_id: previous.source_id,
      call_group_id: previous.call_group_id ?? item.call_group_id,
    });
  }
  collapsed.push(...callByInject.values());
  return {
    rerouted,
    cancelCallGroups: rerouted.filter((item) => item.kind === 'call_group').map((item) => item.id),
    pauseChains: rerouted.filter((item) => item.kind === 'chain').map((item) => item.id),
    fallback_reason: reason,
    deliveries: collapsed,
  };
}

export function moodScope(input: { roleId?: string | null; team?: string | null }): string {
  if (input.roleId) return `role:${input.roleId}`;
  return input.team ?? '';
}

/** Held stretches, while every role player was offline, do not count as wait. */
export function waitMinutesExcludingHeld(input: {
  elapsedMinutes: number;
  firstContactMinute: number;
  heldIntervals: ReadonlyArray<{ start: number; end: number }>;
}): number {
  const span = Math.max(0, input.elapsedMinutes - input.firstContactMinute);
  let held = 0;
  for (const interval of input.heldIntervals) {
    const start = Math.max(interval.start, input.firstContactMinute);
    const end = Math.min(interval.end, input.elapsedMinutes);
    if (end > start) held += end - start;
  }
  return Math.max(0, span - held);
}

export function chainScopeForRole(roleId: string, team: string): { scope_team: string; scope_role: string } {
  return { scope_team: team, scope_role: roleId };
}

export function chainStepHeld(input: { roleTargeted: boolean; allPlayersOfflinePastGrace: boolean }): boolean {
  return input.roleTargeted && input.allPlayersOfflinePastGrace;
}
