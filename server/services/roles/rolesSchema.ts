import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';

const SCHEMA_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);

let state: 'unknown' | 'ready' | 'missing' = 'unknown';
let warned = false;

export function rolesErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isRolesSchemaMissing(err: unknown): boolean {
  const code = rolesErrorCode(err);
  return code != null && SCHEMA_CODES.has(code);
}

export function rolesTablesMissing(): boolean {
  return state === 'missing';
}

function warnOnce(code: string | null): void {
  if (warned) return;
  warned = true;
  logger.warn(
    { code, event: 'session_roles_unavailable' },
    'Player roles and team call lines are off because migration 271 is not applied',
  );
}

/** True once `session_call_lines` has been read. A missing table latches off for the process. */
export async function rolesFeatureReady(): Promise<boolean> {
  if (state === 'ready') return true;
  if (state === 'missing') return false;
  try {
    const { error } = await supabaseAdmin.from('session_call_lines').select('session_id').limit(1);
    if (!error) {
      state = 'ready';
      return true;
    }
    if (isRolesSchemaMissing(error)) {
      state = 'missing';
      warnOnce(rolesErrorCode(error));
      return false;
    }
    warnOnce(rolesErrorCode(error));
    return false;
  } catch (err) {
    warnOnce(rolesErrorCode(err));
    return false;
  }
}

export function markRolesTablesMissing(err?: unknown): void {
  state = 'missing';
  warnOnce(rolesErrorCode(err));
}
