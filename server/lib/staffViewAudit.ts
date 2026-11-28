import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

const WINDOW_MS = 60_000;
const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

const recent = new Map<string, number>();
let disabled = false;
let warned = false;

export interface StaffViewAuditInput {
  sessionId: string;
  staffUserId: string;
  subjectUserId: string | null;
  mode: 'spectator' | 'view_as' | 'sandbox';
  now?: number;
}

function codeOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function schemaMissing(err: unknown): boolean {
  const code = codeOf(err);
  return code != null && SCHEMA_CODES.has(code);
}

function warnOnce(err: unknown, unapplied: boolean): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { event: 'staff_view_audit_unavailable', code: codeOf(err) },
    unapplied
      ? 'Staff view audit is off because migration 283 is not applied'
      : 'Staff view audit write failed',
  );
}

function turnOff(err: unknown): void {
  disabled = true;
  warnOnce(err, true);
}

function memoryKey(input: StaffViewAuditInput): string {
  return `${input.sessionId}|${input.staffUserId}|${input.subjectUserId ?? ''}|${input.mode}`;
}

/** Test hook. Production never calls this. */
export function resetStaffViewAuditForTests(): void {
  recent.clear();
  disabled = false;
  warned = false;
}

/**
 * One row per (session, staff, subject, mode). `last_at` moves at most once a minute.
 * A missing table turns audit off for the process; the view itself still succeeds.
 */
export async function recordStaffView(input: StaffViewAuditInput): Promise<void> {
  if (disabled) return;
  const now = input.now ?? Date.now();
  const key = memoryKey(input);
  const seen = recent.get(key);
  if (seen != null && now - seen < WINDOW_MS) return;

  try {
    const base = supabaseAdmin
      .from('staff_view_audit')
      .select('id, last_at, request_count')
      .eq('session_id', input.sessionId)
      .eq('staff_user_id', input.staffUserId)
      .eq('mode', input.mode);
    const filtered = input.subjectUserId
      ? base.eq('subject_user_id', input.subjectUserId)
      : base.is('subject_user_id', null);
    const { data, error } = await filtered.maybeSingle();
    if (error) {
      if (schemaMissing(error)) turnOff(error);
      else warnOnce(error, false);
      return;
    }

    const row = data as { id?: string; last_at?: string; request_count?: number } | null;
    if (row?.last_at) {
      const at = Date.parse(row.last_at);
      if (Number.isFinite(at) && now - at < WINDOW_MS) {
        recent.set(key, at);
        return;
      }
    }

    if (row?.id) {
      const { error: updateError } = await supabaseAdmin
        .from('staff_view_audit')
        .update({
          last_at: new Date(now).toISOString(),
          request_count: Number(row.request_count ?? 1) + 1,
        })
        .eq('id', row.id);
      if (updateError) {
        if (schemaMissing(updateError)) turnOff(updateError);
        else warnOnce(updateError, false);
        return;
      }
      recent.set(key, now);
      return;
    }

    const { error: insertError } = await supabaseAdmin.from('staff_view_audit').insert({
      session_id: input.sessionId,
      staff_user_id: input.staffUserId,
      subject_user_id: input.subjectUserId,
      mode: input.mode,
      first_at: new Date(now).toISOString(),
      last_at: new Date(now).toISOString(),
      request_count: 1,
    });
    if (insertError) {
      if (schemaMissing(insertError)) turnOff(insertError);
      else warnOnce(insertError, false);
      return;
    }
    recent.set(key, now);
  } catch (err) {
    if (schemaMissing(err)) turnOff(err);
    else warnOnce(err, false);
  }
}
