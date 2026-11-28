/**
 * Trigger and guard-event reads for the trainer panel and the AAR.
 * Migration 278 missing (42P01 / 42703 / PGRST204 / PGRST205) turns that read
 * off: one warn, empty rows, no throw. Every read has an explicit limit.
 */

import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';
import { isUnappliedSchema } from '../../lib/unappliedSchema.js';
import type { TriggerKeyDetail, TriggerOrigin } from '../conditions/injectTriggerService.js';

export const CROSS_TEAM_READ_LIMITS = {
  triggers: 2000,
  guardEvents: 500,
  chainSteps: 2000,
  names: 2000,
} as const;

const warned = new Set<string>();

export interface RecentTriggerRow {
  inject_key: string;
  minute: number;
  origin: TriggerOrigin;
  source_teams: string[];
  target_teams: string[];
}

export interface TriggerHistoryRow {
  inject_id: string;
  inject_key: string;
  minute: number;
  origin: TriggerOrigin;
  source_teams: string[];
  target_teams: string[];
  dep_id: string | null;
  cause_depth: number;
  parent_inject_keys: string[];
  met_keys: string[];
  key_details: TriggerKeyDetail[];
}

export interface GuardEventRow {
  event_type: string;
  inject_key: string;
  reason: string;
  minute: number;
}

type QueryError = { code?: string; message?: string } | null;

function warnOnce(kind: string, message: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  logger.warn({ event: kind }, message);
}

function isSchemaError(error: QueryError): boolean {
  if (isUnappliedSchema(error)) return true;
  const message = error?.message ?? '';
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

function isTriggerOrigin(value: string): value is TriggerOrigin {
  switch (value) {
    case 'timed':
    case 'conditional':
    case 'dependency':
    case 'chain':
    case 'mood':
    case 'decision':
    case 'director':
    case 'trainer':
      return true;
    default:
      return false;
  }
}

function originOf(value: unknown): TriggerOrigin {
  return typeof value === 'string' && isTriggerOrigin(value) ? value : 'conditional';
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
        origin: originOf(row.origin),
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
    origin: originOf(row.origin),
    source_teams: strings(row.source_teams),
    target_teams: strings(row.target_teams),
    dep_id: text(row.dep_id),
    cause_depth: num(row.cause_depth) ?? 0,
    parent_inject_keys: strings(row.parent_inject_keys),
    met_keys: strings(row.met_keys),
    key_details: detailsFrom(row.key_details),
  };
}

function detailsFrom(value: unknown): TriggerKeyDetail[] {
  if (!Array.isArray(value)) return [];
  const details: TriggerKeyDetail[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { key?: unknown; label?: unknown; detail?: unknown; teams?: unknown };
    if (typeof row.key !== 'string') continue;
    details.push({
      key: row.key,
      label: typeof row.label === 'string' ? row.label : '',
      detail: typeof row.detail === 'string' ? row.detail : '',
      teams: strings(row.teams),
    });
  }
  return details;
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
