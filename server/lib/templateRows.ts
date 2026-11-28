import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

/**
 * Template rows (scenario_teams, scenario_injects) are append-and-retire once
 * migration 275 is applied. Readers that run or edit use active rows
 * (`retired_at IS NULL`). Readers that report a past session use rows valid at
 * the session's start_time. When 275 is not applied, both filters are dropped
 * after one missing-column error so PostgREST is not asked for `retired_at`.
 */

export type VersioningState = 'unknown' | 'present' | 'absent';

export interface VersioningFilter {
  column: string;
  op: 'is' | 'lte' | 'or';
  value: string;
}

export interface VersionedRow {
  valid_from?: string | null;
  retired_at?: string | null;
}

const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);

let state: VersioningState = 'unknown';
let warned = false;
let warningCount = 0;

export function templateVersioningState(): VersioningState {
  return state;
}

export function templateVersioningWarningCount(): number {
  return warningCount;
}

export function resetTemplateVersioningForTests(): void {
  state = 'unknown';
  warned = false;
  warningCount = 0;
}

export function isTemplateVersioningMissing(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const message = `${record.message ?? ''} ${record.details ?? ''}`;
  const namesColumn = /retired_at|valid_from/.test(message);
  if (code && MISSING_COLUMN_CODES.has(code) && namesColumn) return true;
  return /column .*retired_at.* does not exist|could not find the 'retired_at' column|column .*valid_from.* does not exist|could not find the 'valid_from' column/i.test(
    message,
  );
}

function noteMissing(): void {
  if (state === 'absent') return;
  state = 'absent';
  if (warned) return;
  warned = true;
  warningCount += 1;
  logger.warn(
    { event: 'template_versioning_unavailable' },
    'Template versioning filters are off because migration 275 is not applied',
  );
}

function notePresent(): void {
  if (state === 'unknown') state = 'present';
}

export function activeRowFilters(versioning: 'present' | 'absent'): VersioningFilter[] {
  if (versioning === 'absent') return [];
  return [{ column: 'retired_at', op: 'is', value: 'null' }];
}

export function validAtRowFilters(at: string | Date, versioning: 'present' | 'absent'): VersioningFilter[] {
  if (versioning === 'absent') return [];
  const iso = isoAt(at);
  return [
    { column: 'valid_from', op: 'lte', value: iso },
    { column: 'or', op: 'or', value: `retired_at.is.null,retired_at.gt.${iso}` },
  ];
}

export function isoAt(at: string | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

/** valid_from <= T AND (retired_at IS NULL OR retired_at > T). */
export function rowValidAt(row: VersionedRow, at: string | Date): boolean {
  const t = new Date(isoAt(at)).getTime();
  if (row.valid_from != null) {
    const from = new Date(row.valid_from).getTime();
    if (Number.isNaN(from) || from > t) return false;
  }
  if (row.retired_at == null) return true;
  const retired = new Date(row.retired_at).getTime();
  return !Number.isNaN(retired) && retired > t;
}

export function rowsValidAt<T extends VersionedRow>(rows: readonly T[], at: string | Date): T[] {
  return rows.filter((row) => rowValidAt(row, at));
}

interface FilterableQuery extends PromiseLike<unknown> {
  is(column: string, value: null): this;
  url?: URL;
}

function errorOf(result: unknown): unknown {
  if (!result || typeof result !== 'object') return null;
  return (result as { error?: unknown }).error ?? null;
}

function withMissingColumnRetry<Q>(filtered: Q, url: URL, search: string): Q {
  let settled = false;
  const proxy = new Proxy(filtered as object, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        const then = Reflect.get(target, prop, target) as (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise<unknown>;
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          then.call(
            target,
            (result: unknown) => {
              if (!settled && isTemplateVersioningMissing(errorOf(result))) {
                settled = true;
                noteMissing();
                url.search = search;
                return then.call(target, onFulfilled, onRejected);
              }
              settled = true;
              if (!errorOf(result)) notePresent();
              return onFulfilled ? onFulfilled(result) : result;
            },
            onRejected,
          );
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const out = (value as (...inner: unknown[]) => unknown).apply(target, args);
          return out === target ? proxy : out;
        };
      }
      return value;
    },
  });
  return proxy as Q;
}

function applyActiveFilter<Q>(query: Q): Q {
  if (state === 'absent') return query;
  const builder = query as unknown as FilterableQuery;
  const url = builder.url instanceof URL ? builder.url : undefined;
  const search = url ? url.search : null;
  const filtered = builder.is('retired_at', null) as unknown as Q;
  if (state === 'present' || !url || search == null) return filtered;
  return withMissingColumnRetry(filtered, url, search);
}

/** Active scenario_teams read. Call this as the outermost await. */
export function activeTeams<Q>(query: Q): Q {
  return applyActiveFilter(query);
}

/** Active template-inject read. The caller still restricts session_id. */
export function activeTemplateInjects<Q>(query: Q): Q {
  return applyActiveFilter(query);
}

export interface QueryResult<T = Record<string, unknown>> {
  data: T[] | null;
  error: { code?: string; message?: string } | null;
}

async function runVersioned(
  versioned: () => PromiseLike<QueryResult>,
  plain: () => PromiseLike<QueryResult>,
): Promise<QueryResult> {
  if (state === 'absent') return plain();
  const result = await versioned();
  if (isTemplateVersioningMissing(result.error)) {
    noteMissing();
    return plain();
  }
  if (!result.error) notePresent();
  return result;
}

/** Teams of one scenario that were current at `at`, ordered by name. */
export async function teamsValidAt(
  scenarioId: string,
  at: string | Date,
): Promise<QueryResult> {
  const iso = isoAt(at);
  const base = () =>
    supabaseAdmin
      .from('scenario_teams')
      .select('*')
      .eq('scenario_id', scenarioId)
      .order('team_name', { ascending: true });
  return runVersioned(
    () =>
      base()
        .lte('valid_from', iso)
        .or(`retired_at.is.null,retired_at.gt.${iso}`),
    () => base(),
  ) as Promise<QueryResult>;
}

/**
 * PostgREST `or` body for template injects valid at `at`.
 * A session's own runtime copies are included whole: they are created after
 * start_time, so a valid_from <= start filter would hide them. Only template
 * rows (`session_id` null) are bounded by valid time.
 */
export function templateInjectValidityOr(sessionId: string | null, at: string | Date): string {
  const iso = isoAt(at);
  const templates = `and(session_id.is.null,valid_from.lte.${iso},or(retired_at.is.null,retired_at.gt.${iso}))`;
  if (!sessionId) return templates;
  return `session_id.eq.${sessionId},${templates}`;
}

/**
 * Template injects valid at `at`, plus this session's runtime copies when
 * sessionId is set.
 */
export async function templateInjectsValidAt(
  scenarioId: string,
  sessionId: string | null,
  at: string | Date,
  options?: { select?: string; limit?: number },
): Promise<QueryResult> {
  const columns = options?.select ?? '*';
  const plainOr = sessionId
    ? `session_id.is.null,session_id.eq.${sessionId}`
    : 'session_id.is.null';
  const build = (versioned: boolean) => {
    let query = supabaseAdmin
      .from('scenario_injects')
      .select(columns)
      .eq('scenario_id', scenarioId)
      .or(versioned ? templateInjectValidityOr(sessionId, at) : plainOr);
    if (options?.limit != null) query = query.limit(options.limit);
    return query;
  };
  return runVersioned(
    () => build(true) as unknown as PromiseLike<QueryResult>,
    () => build(false) as unknown as PromiseLike<QueryResult>,
  );
}

export interface SessionOrg {
  org_uid?: string;
  org_key: string;
  display_name: string;
  country: string | null;
  side: 'protagonist' | 'antagonist' | 'pressure';
  is_primary: boolean;
}

export interface SessionOrgSource {
  start_time?: string | null;
  current_state?: unknown;
  /** Live scenarios.initial_state. Used only when start_time is null. */
  initial_state?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asOrgList(value: unknown): SessionOrg[] {
  if (!Array.isArray(value)) return [];
  const out: SessionOrg[] = [];
  for (const raw of value) {
    const org = asRecord(raw);
    if (!org) continue;
    const key = typeof org.org_key === 'string' ? org.org_key : '';
    if (!key) continue;
    const role = org.role === 'antagonist' ? 'antagonist' : null;
    const side =
      org.side === 'antagonist' || org.side === 'pressure' || org.side === 'protagonist'
        ? org.side
        : role === 'antagonist'
          ? 'antagonist'
          : 'protagonist';
    const display =
      (typeof org.display_name === 'string' && org.display_name) ||
      (typeof org.name === 'string' && org.name) ||
      key;
    out.push({
      org_uid: typeof org.org_uid === 'string' ? org.org_uid : undefined,
      org_key: key,
      display_name: display,
      country: typeof org.country === 'string' ? org.country : null,
      side,
      is_primary: org.is_primary === true || key === 'primary',
    });
  }
  return out;
}

function orgsInState(state: Record<string, unknown> | null): SessionOrg[] {
  const direct = asOrgList(state?.orgs);
  if (direct.length > 0) return direct;
  const page = asRecord(state?.org_page);
  const fromPage = asOrgList(page?.orgs);
  if (fromPage.length > 0) return fromPage;
  return [];
}

/**
 * Organisations as they were for this session. A started session is labelled
 * from its own current_state snapshot, never from the live scenario, so a
 * later primary swap does not rename history. A session with no start_time
 * still uses the live initial_state.
 */
export function orgsForSession(session: SessionOrgSource): SessionOrg[] {
  if (session.start_time) return orgsInState(asRecord(session.current_state));
  return orgsInState(asRecord(session.initial_state));
}

export interface OrgKeyHistoryEntry {
  org_uid: string;
  org_key: string;
  from_edit: string | null;
  until_edit: string | null;
}

/**
 * Stamp org_uid on initial_state.orgs and org_page.orgs, and record each key
 * in org_key_history. Idempotent. Edit-open (WP7) and any path that copies an
 * older scenario should call this before writing the state back.
 */
export function stampOrgIdentity<T>(initialState: T): T {
  const state = asRecord(initialState);
  if (!state) return initialState;
  const copy = structuredClone(state);
  const history = Array.isArray(copy.org_key_history)
    ? (structuredClone(copy.org_key_history) as OrgKeyHistoryEntry[])
    : [];
  const seen = new Set(
    history
      .filter((entry) => entry && entry.until_edit == null)
      .map((entry) => `${entry.org_uid}:${entry.org_key}`),
  );
  const uidByKey = new Map<string, string>();

  const stampList = (value: unknown, share: boolean) => {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      const org = asRecord(raw);
      if (!org) continue;
      const key = typeof org.org_key === 'string' ? org.org_key : '';
      let uid = typeof org.org_uid === 'string' && org.org_uid ? org.org_uid : '';
      if (share && key && uidByKey.has(key)) uid = uidByKey.get(key) as string;
      if (!uid) uid = randomUUID();
      org.org_uid = uid;
      if (key) uidByKey.set(key, uid);
      if (!key) continue;
      const id = `${uid}:${key}`;
      if (seen.has(id)) continue;
      history.push({ org_uid: uid, org_key: key, from_edit: null, until_edit: null });
      seen.add(id);
    }
  };

  stampList(copy.orgs, false);
  const page = asRecord(copy.org_page);
  if (page) stampList(page.orgs, true);
  if (history.length > 0) copy.org_key_history = history;
  return copy as T;
}
