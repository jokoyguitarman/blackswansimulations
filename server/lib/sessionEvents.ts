import { supabaseAdmin } from './supabaseAdmin.js';
import { logger } from './logger.js';

const CHECK_VIOLATION = '23514';
let typeWarned = false;
const otherWarned = new Set<string>();

/**
 * Insert a session event. A check-constraint rejection (migration 271 not applied)
 * is one warning per process. Any other error is logged once per type and code.
 */
export async function insertSessionEvent(row: {
  session_id: string;
  event_type: string;
  metadata?: Record<string, unknown>;
  actor_id?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('session_events').insert(row);
  if (!error) return;
  const code = error.code ?? '';
  const check =
    code === CHECK_VIOLATION ||
    (typeof error.message === 'string' && error.message.includes('session_events_event_type_check'));
  if (check) {
    if (typeWarned) return;
    typeWarned = true;
    logger.warn(
      { code, event_type: row.event_type, event: 'session_event_type_unavailable' },
      'Session event type is not allowed until migration 271 is applied',
    );
    return;
  }
  const key = `${row.event_type}:${code || 'unknown'}`;
  if (otherWarned.has(key)) return;
  otherWarned.add(key);
  logger.warn(
    { code: code || undefined, event_type: row.event_type, event: 'session_event_insert_failed' },
    'Session event insert failed',
  );
}
