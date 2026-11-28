/**
 * Reads for the trainer panel and the AAR. Migration 278 or 280 missing
 * (42P01 / 42703 / PGRST204 / PGRST205) turns that read off: one warn, empty
 * rows, no throw. Every read has an explicit limit.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { injectKeyOf } from '../../lib/injectKey.js';
import { templateInjectsValidAt } from '../../lib/templateRows.js';

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
    if (error) {
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
    if (isSchemaError(err as QueryError)) {
      warnOnce(
        'inject_triggers_unavailable',
        'Inject triggers are off because migration 278 is not applied',
      );
      return { missing: true, rows: [] };
    }
    warnOnce('inject_triggers_read_failed', 'Inject trigger history was not loaded');
    return { missing: false, rows: [] };
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
    if (error) {
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
    return { missing: false, rows: asRecords(data).map(triggerFrom) };
  } catch (err) {
    const error = err as QueryError;
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
    const [catalogResult, publishedIds] = await Promise.all([
      templateInjectsValidAt(scenarioId, sessionId, validAt, {
        select:
          'id, title, target_teams, conditions_to_appear, conditions_to_cancel, trigger_time_minutes, delivery_config',
        limit: CROSS_TEAM_READ_LIMITS.injects,
      }),
      readPublishedInjectIds(sessionId),
    ]);
    if (catalogResult.error) {
      warnOnce('cross_team_injects_read_failed', 'Inject titles were not loaded');
      return { catalog: [], published: [] };
    }
    const catalog = asRecords(catalogResult.data).map(briefFrom);
    const published = catalog.filter((brief) => publishedIds.has(brief.id));
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
  };
}

/**
 * Ids this session published. Claims are the record; a delivery counts too,
 * because a failed claim still lands the inject. Unpublished templates are absent.
 */
async function readPublishedInjectIds(sessionId: string): Promise<Set<string>> {
  const [claimed, delivered] = await Promise.all([
    readIdColumn('inject_publications', 'inject_id', sessionId),
    readIdColumn('inject_deliveries', 'inject_id', sessionId),
  ]);
  return new Set([...claimed.ids, ...delivered.ids]);
}

async function readIdColumn(
  table: string,
  column: string,
  sessionId: string,
): Promise<{ missing: boolean; ids: Set<string> }> {
  try {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(column)
      .eq('session_id', sessionId)
      .limit(CROSS_TEAM_READ_LIMITS.injects);
    if (error) {
      if (isSchemaError(error)) return { missing: true, ids: new Set() };
      warnOnce(`cross_team_${table}_read_failed`, `${table} was not loaded`);
      return { missing: false, ids: new Set() };
    }
    const ids = new Set<string>();
    for (const row of asRecords(data)) {
      const id = text(row[column]);
      if (id) ids.add(id);
    }
    return { missing: false, ids };
  } catch (err) {
    if (isSchemaError(err as QueryError)) return { missing: true, ids: new Set() };
    warnOnce(`cross_team_${table}_read_failed`, `${table} was not loaded`);
    return { missing: false, ids: new Set() };
  }
}
