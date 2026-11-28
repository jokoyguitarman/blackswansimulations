/**
 * Reads for the trainer panel and the AAR. Migration 278 or 280 missing
 * (42P01 / 42703 / PGRST204 / PGRST205) turns that read off: one warn, empty
 * rows, no throw. Every read has an explicit limit.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { templateInjectsValidAt } from '../../lib/templateRows.js';
import { sessionMinute } from '../dependencies/dependencyService.js';

export const CROSS_TEAM_READ_LIMITS = {
  triggers: 2000,
  states: 500,
  guardEvents: 500,
  responses: 2000,
  injects: 2000,
  chainSteps: 2000,
  names: 2000,
} as const;

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
const warned = new Set<string>();

export interface RecentTriggerRow {
  inject_key: string;
  minute: number;
  origin: string;
  source_teams: string[];
  target_teams: string[];
}

export interface TriggerHistoryRow {
  inject_id: string;
  inject_key: string;
  minute: number;
  origin: string;
  source_teams: string[];
  target_teams: string[];
  dep_id: string | null;
  cause_depth: number;
  parent_inject_keys: string[];
  met_keys: string[];
  key_details: Array<{ key: string; detail: string }>;
}

export interface StoredStateRow {
  dep_id: string;
  status: string;
  broken_minute: number | null;
  met_minute: number | null;
  recovered_minute: number | null;
  hold_until_minute: number | null;
  evidence: Array<{ key: string; detail: string; minute: number }>;
}

export interface GuardEventRow {
  event_type: string;
  inject_key: string;
  reason: string;
  minute: number;
}

export interface ReplyHistoryRow {
  inject_key: string;
  team_name: string | null;
  response_minute: number;
  judgement: unknown;
}

export interface InjectBriefRow {
  id: string;
  inject_key: string;
  title: string;
  target_teams: string[];
  conditions_to_appear: unknown;
  conditions_to_cancel: unknown;
  trigger_time_minutes: number | null;
  published_minute: number | null;
}

type QueryError = { code?: string; message?: string } | null;

function warnOnce(kind: string, message: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  logger.warn({ event: kind }, message);
}

function isSchemaError(error: QueryError): boolean {
  if (!error) return false;
  if (error.code && SCHEMA_CODES.has(error.code)) return true;
  const message = error.message ?? '';
  return /does not exist|schema cache|could not find/i.test(message);
}

function asRecords(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function triggerReadFailed<T>(error: QueryError): { missing: boolean; rows: T[] } {
  if (isSchemaError(error)) {
    warnOnce(
      'inject_triggers_unavailable',
      'Inject triggers are off because migration 278 is not applied',
    );
    return { missing: true, rows: [] };
  }
  warnOnce('inject_triggers_read_failed', 'Inject trigger history was not loaded');
  return { missing: false, rows: [] };
}

/**
 * Fire minute for specific inject keys, across the whole session.
 * The panel uses this for due-minute anchors and to clear held items.
 */
export async function readTriggerMinutes(
  sessionId: string,
  injectKeys: readonly string[],
): Promise<{ missing: boolean; rows: Array<{ inject_key: string; minute: number }> }> {
  const keys = [...new Set(injectKeys.filter((key) => key.trim() !== ''))];
  if (keys.length === 0) return { missing: false, rows: [] };
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_triggers')
      .select('inject_key, minute')
      .eq('session_id', sessionId)
      .in('inject_key', keys)
      .order('minute', { ascending: true })
      .limit(CROSS_TEAM_READ_LIMITS.triggers);
    if (error) return triggerReadFailed(error);
    return {
      missing: false,
      rows: asRecords(data)
        .map((row) => ({ inject_key: text(row.inject_key) ?? '', minute: num(row.minute) ?? 0 }))
        .filter((row) => row.inject_key !== ''),
    };
  } catch (err) {
    return triggerReadFailed(err as QueryError);
  }
}

/** Pressure strip: only the columns and the minutes the panel shows. */
export async function readRecentTriggerPressure(
  sessionId: string,
  sinceMinute: number,
): Promise<{ missing: boolean; rows: RecentTriggerRow[] }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_triggers')
      .select('inject_key, minute, origin, source_teams, target_teams')
      .eq('session_id', sessionId)
      .gte('minute', sinceMinute)
      .order('minute', { ascending: true })
      .limit(CROSS_TEAM_READ_LIMITS.triggers);
    if (error) return triggerReadFailed(error);
    return {
      missing: false,
      rows: asRecords(data).map((row) => ({
        inject_key: text(row.inject_key) ?? '',
        minute: num(row.minute) ?? 0,
        origin: text(row.origin) ?? '',
        source_teams: strings(row.source_teams),
        target_teams: strings(row.target_teams),
      })),
    };
  } catch (err) {
    return triggerReadFailed(err as QueryError);
  }
}

export async function readInjectTriggers(
  sessionId: string,
): Promise<{ missing: boolean; rows: TriggerHistoryRow[] }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_triggers')
      .select(
        'inject_id, inject_key, minute, origin, source_teams, target_teams, dep_id, cause_depth, parent_inject_keys, met_keys, key_details',
      )
      .eq('session_id', sessionId)
      .order('minute', { ascending: true })
      .limit(CROSS_TEAM_READ_LIMITS.triggers);
    if (error) return triggerReadFailed(error);
    return { missing: false, rows: asRecords(data).map(triggerFrom) };
  } catch (err) {
    return triggerReadFailed(err as QueryError);
  }
}

function triggerFrom(row: Record<string, unknown>): TriggerHistoryRow {
  return {
    inject_id: text(row.inject_id) ?? '',
    inject_key: text(row.inject_key) ?? '',
    minute: num(row.minute) ?? 0,
    origin: text(row.origin) ?? '',
    source_teams: strings(row.source_teams),
    target_teams: strings(row.target_teams),
    dep_id: text(row.dep_id),
    cause_depth: num(row.cause_depth) ?? 0,
    parent_inject_keys: strings(row.parent_inject_keys),
    met_keys: strings(row.met_keys),
    key_details: detailsFrom(row.key_details),
  };
}

function detailsFrom(value: unknown): Array<{ key: string; detail: string }> {
  if (!Array.isArray(value)) return [];
  const details: Array<{ key: string; detail: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { key?: unknown; detail?: unknown };
    if (typeof row.key !== 'string') continue;
    details.push({ key: row.key, detail: typeof row.detail === 'string' ? row.detail : '' });
  }
  return details;
}

export async function readDependencyStateRows(
  sessionId: string,
): Promise<{ missing: boolean; rows: StoredStateRow[] }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_dependency_states')
      .select(
        'dep_id, status, broken_minute, met_minute, recovered_minute, hold_until_minute, evidence',
      )
      .eq('session_id', sessionId)
      .limit(CROSS_TEAM_READ_LIMITS.states);
    if (error) {
      if (isSchemaError(error)) {
        warnOnce(
          'session_dependency_states_unavailable',
          'Team dependency states are off because migration 280 is not applied',
        );
        return { missing: true, rows: [] };
      }
      warnOnce('dependency_states_read_failed', 'Dependency states were not loaded');
      return { missing: false, rows: [] };
    }
    return {
      missing: false,
      rows: asRecords(data)
        .map(stateFrom)
        .filter((row): row is StoredStateRow => row != null),
    };
  } catch (err) {
    if (isSchemaError(err as QueryError)) {
      warnOnce(
        'session_dependency_states_unavailable',
        'Team dependency states are off because migration 280 is not applied',
      );
      return { missing: true, rows: [] };
    }
    warnOnce('dependency_states_read_failed', 'Dependency states were not loaded');
    return { missing: false, rows: [] };
  }
}

function stateFrom(row: Record<string, unknown>): StoredStateRow | null {
  const depId = text(row.dep_id);
  const status = text(row.status);
  if (!depId || !status) return null;
  return {
    dep_id: depId,
    status,
    broken_minute: num(row.broken_minute),
    met_minute: num(row.met_minute),
    recovered_minute: num(row.recovered_minute),
    hold_until_minute: num(row.hold_until_minute),
    evidence: evidenceFrom(row.evidence),
  };
}

function evidenceFrom(value: unknown): Array<{ key: string; detail: string; minute: number }> {
  if (!Array.isArray(value)) return [];
  const evidence: Array<{ key: string; detail: string; minute: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { key?: unknown; detail?: unknown; minute?: unknown };
    if (typeof row.key !== 'string') continue;
    evidence.push({
      key: row.key,
      detail: typeof row.detail === 'string' ? row.detail : '',
      minute: typeof row.minute === 'number' ? row.minute : 0,
    });
  }
  return evidence;
}

export async function readGuardEvents(sessionId: string): Promise<GuardEventRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('session_events')
      .select('event_type, metadata, created_at')
      .eq('session_id', sessionId)
      .in('event_type', ['cross_team_deferred', 'cross_team_held'])
      .order('created_at', { ascending: false })
      .limit(CROSS_TEAM_READ_LIMITS.guardEvents);
    if (error) {
      if (isSchemaError(error)) {
        warnOnce(
          'cross_team_events_unavailable',
          'Cross-team guard events are off because migration 278 is not applied',
        );
      } else {
        warnOnce('cross_team_events_read_failed', 'Cross-team guard events were not loaded');
      }
      return [];
    }
    const events: GuardEventRow[] = [];
    for (const row of asRecords(data)) {
      const metadata =
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as { inject_key?: unknown; reason?: unknown; minute?: unknown })
          : null;
      const injectKey = text(metadata?.inject_key);
      if (!injectKey) continue;
      events.push({
        event_type: text(row.event_type) ?? '',
        inject_key: injectKey,
        reason: text(metadata?.reason) ?? '',
        minute: num(metadata?.minute) ?? 0,
      });
    }
    return events;
  } catch (err) {
    if (isSchemaError(err as QueryError)) {
      warnOnce(
        'cross_team_events_unavailable',
        'Cross-team guard events are off because migration 278 is not applied',
      );
    } else {
      warnOnce('cross_team_events_read_failed', 'Cross-team guard events were not loaded');
    }
    return [];
  }
}

export async function readCrossTeamReplies(sessionId: string): Promise<ReplyHistoryRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_responses')
      .select('inject_key, team_name, response_minute, judgement')
      .eq('session_id', sessionId)
      .order('response_minute', { ascending: true })
      .limit(CROSS_TEAM_READ_LIMITS.responses);
    if (error) {
      if (!isSchemaError(error))
        warnOnce('cross_team_replies_read_failed', 'Replies were not loaded');
      return [];
    }
    return asRecords(data).map((row) => ({
      inject_key: text(row.inject_key) ?? '',
      team_name: text(row.team_name),
      response_minute: num(row.response_minute) ?? 0,
      judgement: row.judgement,
    }));
  } catch {
    warnOnce('cross_team_replies_read_failed', 'Replies were not loaded');
    return [];
  }
}

/**
 * Injects valid for this session, split into the whole current set (titles
 * and parent keys) and the ones this session actually published.
 */
export async function readSessionInjects(
  scenarioId: string,
  sessionId: string,
  validAt: string,
): Promise<{ catalog: InjectBriefRow[]; published: InjectBriefRow[] }> {
  try {
    const [catalogResult, published] = await Promise.all([
      templateInjectsValidAt(scenarioId, sessionId, validAt, {
        select:
          'id, title, target_teams, conditions_to_appear, conditions_to_cancel, trigger_time_minutes, delivery_config',
        limit: CROSS_TEAM_READ_LIMITS.injects,
      }),
      readPublishedMinutes(sessionId, validAt),
    ]);
    if (catalogResult.error) {
      warnOnce('cross_team_injects_read_failed', 'Inject titles were not loaded');
      return { catalog: [], published: [] };
    }
    const catalog = asRecords(catalogResult.data).map(briefFrom);
    const published = catalog.flatMap((brief) => {
      if (!published.minutes.has(brief.id)) return [];
      return [{ ...brief, published_minute: published.minutes.get(brief.id) ?? null }];
    });
    return { catalog, published };
  } catch {
    warnOnce('cross_team_injects_read_failed', 'Inject titles were not loaded');
    return { catalog: [], published: [] };
  }
}

function briefFrom(row: Record<string, unknown>): InjectBriefRow {
  const config =
    row.delivery_config && typeof row.delivery_config === 'object'
      ? (row.delivery_config as { inject_key?: unknown })
      : null;
  const id = text(row.id) ?? '';
  return {
    id,
    inject_key: injectKeyOf({ id, delivery_config: config }),
    title: text(row.title) ?? '',
    target_teams: strings(row.target_teams),
    conditions_to_appear: row.conditions_to_appear,
    conditions_to_cancel: row.conditions_to_cancel,
    trigger_time_minutes: num(row.trigger_time_minutes),
    published_minute: null,
  };
}

/**
 * Ids this session published, with the session minute when we know it.
 * A delivery's minute wins. A claim with only a timestamp is converted from
 * the session start. Unpublished templates are absent.
 */
async function readPublishedMinutes(
  sessionId: string,
  startTime: string,
): Promise<{ minutes: Map<string, number | null> }> {
  const [delivered, claimed] = await Promise.all([
    readDeliveryMinutes(sessionId),
    readClaimedAt(sessionId),
  ]);
  const minutes = new Map<string, number | null>(delivered);
  for (const [id, at] of claimed) {
    if (minutes.has(id)) continue;
    const parsed = at ? Date.parse(at) : Number.NaN;
    minutes.set(id, Number.isFinite(parsed) ? sessionMinute(startTime, parsed) : null);
  }
  return { minutes };
}

async function readDeliveryMinutes(sessionId: string): Promise<Map<string, number>> {
  const minutes = new Map<string, number>();
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_deliveries')
      .select('inject_id, delivered_minute')
      .eq('session_id', sessionId)
      .order('delivered_minute', { ascending: true })
      .limit(CROSS_TEAM_READ_LIMITS.injects);
    if (error) {
      if (!isSchemaError(error))
        warnOnce('cross_team_inject_deliveries_read_failed', 'Deliveries were not loaded');
      return minutes;
    }
    for (const row of asRecords(data)) {
      const id = text(row.inject_id);
      const minute = num(row.delivered_minute);
      if (!id || minute == null || minutes.has(id)) continue;
      minutes.set(id, minute);
    }
  } catch {
    warnOnce('cross_team_inject_deliveries_read_failed', 'Deliveries were not loaded');
  }
  return minutes;
}

async function readClaimedAt(sessionId: string): Promise<Map<string, string | null>> {
  const claimed = new Map<string, string | null>();
  try {
    const { data, error } = await supabaseAdmin
      .from('inject_publications')
      .select('inject_id, claimed_at')
      .eq('session_id', sessionId)
      .limit(CROSS_TEAM_READ_LIMITS.injects);
    if (error) {
      if (!isSchemaError(error)) {
        warnOnce(
          'cross_team_inject_publications_read_failed',
          'Publication claims were not loaded',
        );
      }
      return claimed;
    }
    for (const row of asRecords(data)) {
      const id = text(row.inject_id);
      if (!id || claimed.has(id)) continue;
      claimed.set(id, text(row.claimed_at));
    }
  } catch {
    warnOnce('cross_team_inject_publications_read_failed', 'Publication claims were not loaded');
  }
  return claimed;
}
