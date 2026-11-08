import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { snapshotFinalStateOnCompletion } from './scenarioStateService.js';
import { getWebSocketService } from './websocketService.js';

export interface IdleSettings {
  idleEndMinutes: number;
  idleWarnMinutes: number;
  maxHours: number;
}

export type IdleReason = 'idle' | 'max_duration';

export type IdleAction =
  | { kind: 'none' }
  | { kind: 'warn'; reason: IdleReason; endsAt: string }
  | { kind: 'end'; reason: IdleReason; idleMinutes: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Pure. The whole rule; the sweeper only gathers its inputs and carries out its answer. */
export function decideIdleAction(input: {
  now: number;
  startTime: string;
  lastHumanAt: string | null;
  warnedFor: readonly IdleReason[];
  settings: IdleSettings;
}): IdleAction {
  const start = Date.parse(input.startTime);
  if (!Number.isFinite(start)) return { kind: 'none' };

  const lastHumanMs = input.lastHumanAt ? Date.parse(input.lastHumanAt) : Number.NaN;
  const lastActive = Number.isFinite(lastHumanMs) ? Math.max(start, lastHumanMs) : start;
  const { idleEndMinutes, idleWarnMinutes, maxHours } = input.settings;

  if (maxHours > 0) {
    const limit = start + maxHours * HOUR_MS;
    if (input.now >= limit) {
      return {
        kind: 'end',
        reason: 'max_duration',
        idleMinutes: wholeMinutes(input.now, lastActive),
      };
    }
    if (
      idleWarnMinutes > 0 &&
      input.now >= limit - idleWarnMinutes * MINUTE_MS &&
      !input.warnedFor.includes('max_duration')
    ) {
      return { kind: 'warn', reason: 'max_duration', endsAt: new Date(limit).toISOString() };
    }
  }

  if (idleEndMinutes > 0) {
    const idleEnd = lastActive + idleEndMinutes * MINUTE_MS;
    if (input.now >= idleEnd) {
      return { kind: 'end', reason: 'idle', idleMinutes: wholeMinutes(input.now, lastActive) };
    }
    if (
      idleWarnMinutes > 0 &&
      input.now >= idleEnd - idleWarnMinutes * MINUTE_MS &&
      !input.warnedFor.includes('idle')
    ) {
      return { kind: 'warn', reason: 'idle', endsAt: new Date(idleEnd).toISOString() };
    }
  }

  return { kind: 'none' };
}

function wholeMinutes(now: number, lastActive: number): number {
  return Math.max(0, Math.floor((now - lastActive) / MINUTE_MS));
}

export interface IdleMarker {
  kind: 'idle_warning' | 'idle_cleared' | 'idle_keepalive';
  reason: IdleReason | null;
  created_at: string;
}

/** Which warnings still stand, and whether players came back after an idle warning nobody has cleared. */
export function readIdleMarkers(
  markers: readonly IdleMarker[],
  lastActiveIso: string,
): { warnedFor: IdleReason[]; clearIdleWarning: boolean } {
  const lastActive = Date.parse(lastActiveIso);
  let maxDuration = false;
  let latestIdleMs = Number.NEGATIVE_INFINITY;
  let hasIdleWarning = false;
  for (const marker of markers) {
    if (marker.kind !== 'idle_warning') continue;
    if (marker.reason === 'max_duration') maxDuration = true;
    if (marker.reason !== 'idle') continue;
    const at = Date.parse(marker.created_at);
    if (!Number.isFinite(at)) continue;
    hasIdleWarning = true;
    if (at > latestIdleMs) latestIdleMs = at;
  }

  const warnedFor: IdleReason[] = [];
  if (maxDuration) warnedFor.push('max_duration');
  const idleStands = hasIdleWarning && Number.isFinite(lastActive) && latestIdleMs > lastActive;
  if (idleStands) warnedFor.push('idle');

  let clearIdleWarning = false;
  if (hasIdleWarning && Number.isFinite(lastActive) && latestIdleMs < lastActive) {
    const answered = markers.some((marker) => {
      if (marker.kind !== 'idle_cleared' && marker.kind !== 'idle_keepalive') return false;
      const at = Date.parse(marker.created_at);
      return Number.isFinite(at) && at > latestIdleMs;
    });
    clearIdleWarning = !answered;
  }

  return { warnedFor, clearIdleWarning };
}

export interface ActivityQuery {
  table: string;
  timeColumn: string;
  actorColumn: string;
  sessionId: string;
  sinceIso: string;
  excludeActorIds: readonly string[];
}

export interface ActivityQueryClient {
  /** Newest matching time, null when none, or 'failed' when the read failed. */
  latestTime(query: ActivityQuery): Promise<string | null | 'failed'>;
}

const HUMAN_ACTIVITY_SOURCES = [
  { table: 'session_participants', timeColumn: 'joined_at', actorColumn: 'user_id' },
  { table: 'chat_messages', timeColumn: 'created_at', actorColumn: 'sender_id' },
  { table: 'decisions', timeColumn: 'created_at', actorColumn: 'proposed_by' },
  { table: 'player_actions', timeColumn: 'created_at', actorColumn: 'player_id' },
  { table: 'social_posts', timeColumn: 'created_at', actorColumn: 'posted_by_user_id' },
  { table: 'session_events', timeColumn: 'created_at', actorColumn: 'actor_id' },
] as const;

/**
 * Latest human activity across the six sources. A failed read answers `nowIso`,
 * so a database hiccup never looks like an idle session.
 */
export async function latestHumanActivityFromReads(
  client: ActivityQueryClient,
  sessionId: string,
  sinceIso: string,
  botIds: readonly string[],
  nowIso: string,
): Promise<string | null> {
  let latest: string | null = null;
  for (const source of HUMAN_ACTIVITY_SOURCES) {
    let time: string | null | 'failed';
    try {
      time = await client.latestTime({
        table: source.table,
        timeColumn: source.timeColumn,
        actorColumn: source.actorColumn,
        sessionId,
        sinceIso,
        excludeActorIds: botIds,
      });
    } catch {
      return nowIso;
    }
    if (time === 'failed') return nowIso;
    if (time && (latest === null || time > latest)) latest = time;
  }
  return latest;
}

export interface IdleSweepStore {
  listRunningSessions(): Promise<Array<{ id: string; start_time: string }>>;
  listBotUserIds(): Promise<string[]>;
  latestHumanActivity(
    sessionId: string,
    sinceIso: string,
    botIds: readonly string[],
  ): Promise<string | null>;
  listIdleMarkers(sessionId: string, sinceIso: string): Promise<IdleMarker[]>;
  completeIfRunning(sessionId: string): Promise<boolean>;
  recordEvent(row: {
    session_id: string;
    event_type: 'trainer_alert' | 'status_update';
    actor_id: string | null;
    description: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  isBotUser(userId: string): Promise<boolean>;
  latestKeepalive(sessionId: string, userId: string, sinceIso: string): Promise<string | null>;
}

const supabaseActivityClient: ActivityQueryClient = {
  async latestTime(query) {
    const excluded =
      query.excludeActorIds.length > 0
        ? `(${query.excludeActorIds.map((id) => `"${id}"`).join(',')})`
        : null;
    const request = supabaseAdmin
      .from(query.table)
      .select(query.timeColumn)
      .eq('session_id', query.sessionId)
      .gt(query.timeColumn, query.sinceIso)
      .not(query.actorColumn, 'is', null);
    const filtered = excluded ? request.not(query.actorColumn, 'in', excluded) : request;
    const { data, error } = await filtered.order(query.timeColumn, { ascending: false }).limit(1);
    if (error) return 'failed';
    const row = Array.isArray(data)
      ? (data[0] as unknown as Record<string, unknown> | undefined)
      : undefined;
    const time = row?.[query.timeColumn];
    return typeof time === 'string' ? time : null;
  },
};

function asReason(value: unknown): IdleReason | null {
  return value === 'idle' || value === 'max_duration' ? value : null;
}

function toIdleMarker(metadata: unknown, createdAt: unknown): IdleMarker | null {
  if (!metadata || typeof metadata !== 'object' || typeof createdAt !== 'string') return null;
  const kind = (metadata as { kind?: unknown }).kind;
  if (kind !== 'idle_warning' && kind !== 'idle_cleared' && kind !== 'idle_keepalive') return null;
  const reason =
    kind === 'idle_warning' ? asReason((metadata as { reason?: unknown }).reason) : null;
  return { kind, reason, created_at: createdAt };
}

export function createSupabaseIdleSweepStore(): IdleSweepStore {
  return {
    async listRunningSessions() {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('status', 'in_progress')
        .not('start_time', 'is', null);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const sessions: Array<{ id: string; start_time: string }> = [];
      for (const row of rows) {
        const record = row as { id?: unknown; start_time?: unknown };
        if (typeof record.id === 'string' && typeof record.start_time === 'string') {
          sessions.push({ id: record.id, start_time: record.start_time });
        }
      }
      return sessions;
    },

    async listBotUserIds() {
      const { data, error } = await supabaseAdmin
        .from('user_profiles')
        .select('id')
        .eq('is_bot', true);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const ids: string[] = [];
      for (const row of rows) {
        const id = (row as { id?: unknown }).id;
        if (typeof id === 'string') ids.push(id);
      }
      return ids;
    },

    async latestHumanActivity(sessionId, sinceIso, botIds) {
      return latestHumanActivityFromReads(
        supabaseActivityClient,
        sessionId,
        sinceIso,
        botIds,
        new Date().toISOString(),
      );
    },

    async listIdleMarkers(sessionId, sinceIso) {
      const { data, error } = await supabaseAdmin
        .from('session_events')
        .select('metadata, created_at')
        .eq('session_id', sessionId)
        .in('metadata->>kind', ['idle_warning', 'idle_cleared', 'idle_keepalive'])
        .gt('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const markers: IdleMarker[] = [];
      for (const row of rows) {
        const record = row as { metadata?: unknown; created_at?: unknown };
        const marker = toIdleMarker(record.metadata, record.created_at);
        if (marker) markers.push(marker);
      }
      return markers;
    },

    async completeIfRunning(sessionId) {
      const { data, error } = await supabaseAdmin
        .from('sessions')
        .update({ status: 'completed', end_time: new Date().toISOString() })
        .eq('id', sessionId)
        .eq('status', 'in_progress')
        .select('id');
      if (error) throw error;
      return Array.isArray(data) && data.length === 1;
    },

    async recordEvent(row) {
      const { error } = await supabaseAdmin.from('session_events').insert({
        session_id: row.session_id,
        event_type: row.event_type,
        actor_id: row.actor_id,
        description: row.description,
        metadata: row.metadata,
      });
      if (error) throw error;
    },

    async isBotUser(userId) {
      const { data, error } = await supabaseAdmin
        .from('user_profiles')
        .select('is_bot')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return (data as { is_bot?: unknown } | null)?.is_bot === true;
    },

    async latestKeepalive(sessionId, userId, sinceIso) {
      const { data, error } = await supabaseAdmin
        .from('session_events')
        .select('created_at')
        .eq('session_id', sessionId)
        .eq('actor_id', userId)
        .eq('event_type', 'status_update')
        .eq('metadata->>kind', 'idle_keepalive')
        .gt('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data)
        ? (data[0] as { created_at?: unknown } | undefined)
        : undefined;
      return typeof row?.created_at === 'string' ? row.created_at : null;
    },
  };
}

export function broadcastIdleEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): void {
  getWebSocketService().broadcastToSession(sessionId, {
    type,
    data,
    timestamp: new Date().toISOString(),
  });
}

/** The logic of POST /api/sessions/:id/keepalive, after the route's access check. */
export async function recordKeepalive(
  deps: {
    store: IdleSweepStore;
    broadcast: (sessionId: string, type: string, data: Record<string, unknown>) => void;
    now?: () => number;
  },
  input: { sessionId: string; sessionStatus: string; userId: string },
): Promise<{ status: 204 | 409 }> {
  if (input.sessionStatus !== 'in_progress') return { status: 409 };
  if (await deps.store.isBotUser(input.userId)) return { status: 204 };
  const nowMs = (deps.now ?? Date.now)();
  const sinceIso = new Date(nowMs - MINUTE_MS).toISOString();
  const recent = await deps.store.latestKeepalive(input.sessionId, input.userId, sinceIso);
  if (recent) return { status: 204 };
  await deps.store.recordEvent({
    session_id: input.sessionId,
    event_type: 'status_update',
    actor_id: input.userId,
    description: 'Still here',
    metadata: { kind: 'idle_keepalive' },
  });
  deps.broadcast(input.sessionId, 'session.idle_cleared', { session_id: input.sessionId });
  return { status: 204 };
}

const inFlight = new Set<string>();

export async function runIdleSweep(deps: {
  store: IdleSweepStore;
  settings: IdleSettings;
  now?: () => number;
  onEnded?: (sessionId: string) => Promise<void>;
  broadcast?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
}): Promise<{ warned: number; ended: number }> {
  if (deps.settings.idleEndMinutes <= 0 && deps.settings.maxHours <= 0) {
    return { warned: 0, ended: 0 };
  }
  const now = deps.now ?? Date.now;
  const broadcast = deps.broadcast ?? (() => undefined);
  const botIds = await deps.store.listBotUserIds();
  const sessions = await deps.store.listRunningSessions();
  let warned = 0;
  let ended = 0;

  for (const session of sessions) {
    if (inFlight.has(session.id)) continue;
    inFlight.add(session.id);
    try {
      const nowMs = now();
      const lastHumanAt = await deps.store.latestHumanActivity(
        session.id,
        session.start_time,
        botIds,
      );
      const lastActiveIso = laterIso(session.start_time, lastHumanAt);
      const markers = await deps.store.listIdleMarkers(session.id, session.start_time);
      const { warnedFor, clearIdleWarning } = readIdleMarkers(markers, lastActiveIso);
      const action = decideIdleAction({
        now: nowMs,
        startTime: session.start_time,
        lastHumanAt,
        warnedFor,
        settings: deps.settings,
      });
      if (clearIdleWarning && action.kind !== 'end') {
        await deps.store.recordEvent({
          session_id: session.id,
          event_type: 'status_update',
          actor_id: null,
          description: 'Player activity resumed, so the session continues.',
          metadata: { kind: 'idle_cleared' },
        });
        broadcast(session.id, 'session.idle_cleared', { session_id: session.id });
        logger.info({ sessionId: session.id }, 'session_idle_cleared');
      }
      if (action.kind === 'warn') {
        await deps.store.recordEvent({
          session_id: session.id,
          event_type: 'trainer_alert',
          actor_id: null,
          description: warningDescription(action.reason, action.endsAt, deps.settings),
          metadata: { kind: 'idle_warning', reason: action.reason, ends_at: action.endsAt },
        });
        broadcast(session.id, 'session.idle_warning', {
          session_id: session.id,
          reason: action.reason,
          ends_at: action.endsAt,
          idle_end_minutes: deps.settings.idleEndMinutes,
          idle_warn_minutes: deps.settings.idleWarnMinutes,
          max_hours: deps.settings.maxHours,
        });
        logger.info(
          { sessionId: session.id, reason: action.reason, endsAt: action.endsAt },
          'session_idle_warning',
        );
        warned += 1;
      } else if (action.kind === 'end') {
        const completed = await deps.store.completeIfRunning(session.id);
        if (completed) {
          if (deps.onEnded) await deps.onEnded(session.id);
          const endedAt = new Date(nowMs).toISOString();
          await deps.store.recordEvent({
            session_id: session.id,
            event_type: 'status_update',
            actor_id: null,
            description: endedDescription(action.reason, deps.settings),
            metadata: {
              kind: 'idle_auto_end',
              reason: action.reason,
              idle_minutes: action.idleMinutes,
              last_human_activity_at: lastHumanAt,
            },
          });
          broadcast(session.id, 'session.auto_ended', {
            session_id: session.id,
            reason: action.reason,
            ended_at: endedAt,
            idle_end_minutes: deps.settings.idleEndMinutes,
            idle_warn_minutes: deps.settings.idleWarnMinutes,
            max_hours: deps.settings.maxHours,
          });
          logger.info(
            { sessionId: session.id, reason: action.reason, idleMinutes: action.idleMinutes },
            'session_auto_ended',
          );
          ended += 1;
        }
      }
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, 'session_idle_sweep_failed');
    } finally {
      inFlight.delete(session.id);
    }
  }

  return { warned, ended };
}

function laterIso(startTime: string, lastHumanAt: string | null): string {
  if (!lastHumanAt) return startTime;
  const startMs = Date.parse(startTime);
  const humanMs = Date.parse(lastHumanAt);
  if (!Number.isFinite(humanMs)) return startTime;
  if (!Number.isFinite(startMs) || humanMs > startMs) return lastHumanAt;
  return startTime;
}

function formatUtcClock(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}

function warningDescription(reason: IdleReason, endsAt: string, settings: IdleSettings): string {
  const time = formatUtcClock(endsAt);
  if (reason === 'idle') {
    const quietFor = settings.idleEndMinutes - settings.idleWarnMinutes;
    return `No player activity for ${quietFor} minutes. This session ends automatically at ${time} unless someone acts.`;
  }
  return `This session reaches its ${settings.maxHours}-hour limit at ${time} and will end then.`;
}

function endedDescription(reason: IdleReason, settings: IdleSettings): string {
  if (reason === 'idle') {
    return `This session has ended: no player activity for ${settings.idleEndMinutes} minutes.`;
  }
  return `This session has ended: it reached its ${settings.maxHours}-hour limit.`;
}

async function runEndHooks(sessionId: string): Promise<void> {
  await snapshotFinalStateOnCompletion(sessionId);
  try {
    const { getTeammateBotService } = await import('./teammates/teammateBotService.js');
    await getTeammateBotService().onBotsChanged(sessionId);
  } catch (err) {
    logger.debug({ err, sessionId }, 'teammate bots hook failed');
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSessionIdleSweeper(): void {
  if (timer) return;
  if (env.sessionIdleEndMinutes === 0 && env.sessionMaxHours === 0) return;
  const store = createSupabaseIdleSweepStore();
  timer = setInterval(() => {
    void runIdleSweep({
      store,
      settings: {
        idleEndMinutes: env.sessionIdleEndMinutes,
        idleWarnMinutes: env.sessionIdleWarnMinutes,
        maxHours: env.sessionMaxHours,
      },
      onEnded: runEndHooks,
      broadcast: broadcastIdleEvent,
    }).catch((err) => {
      logger.warn({ err }, 'session_idle_sweep_failed');
    });
  }, 60_000);
}

export function stopSessionIdleSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
