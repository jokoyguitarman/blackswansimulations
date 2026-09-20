import { supabaseAdmin } from '../../lib/supabaseAdmin.js';
import { logger } from '../../lib/logger.js';

/**
 * Insert a session_events row using a type introduced by migration 205, falling back to a
 * pre-205 type (with `metadata.kind` carrying the intended one) when the CHECK rejects it.
 * The fallback decision is cached per type so the DB is only asked once per boot.
 */
const typeSupported = new Map<string, boolean>();

export async function emitSessionEvent(
  sessionId: string,
  eventType: string,
  fallbackType: string,
  body: { description: string; metadata?: Record<string, unknown>; user_id?: string | null },
): Promise<void> {
  const metadata = { ...(body.metadata || {}) };
  const supported = typeSupported.get(eventType);
  if (supported !== false) {
    const { error } = await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: eventType,
      description: body.description,
      metadata,
      ...(body.user_id ? { user_id: body.user_id } : {}),
    });
    if (!error) {
      typeSupported.set(eventType, true);
      return;
    }
    if (/check constraint|violates|invalid input value/i.test(error.message || '')) {
      if (supported === undefined) {
        logger.error(
          { eventType, fallbackType },
          'session_events CHECK predates migration 205 — emitting as fallback type with metadata.kind',
        );
      }
      typeSupported.set(eventType, false);
    } else {
      logger.warn({ error, eventType }, 'session_events insert failed');
      return;
    }
  }
  const { error } = await supabaseAdmin.from('session_events').insert({
    session_id: sessionId,
    event_type: fallbackType,
    description: body.description,
    metadata: { ...metadata, kind: metadata.kind ?? eventType },
    ...(body.user_id ? { user_id: body.user_id } : {}),
  });
  if (error)
    logger.warn({ error, eventType, fallbackType }, 'session_events fallback insert failed');
}
