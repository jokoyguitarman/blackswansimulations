import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * Event Service - Business logic for event logging and broadcasting
 * Separation of concerns: Event-related business logic
 *
 * session_events table uses: actor_id (not created_by), metadata (not event_data), description (required).
 * See migrations/001_initial_schema.sql and docs/SESSION_EVENTS_EVENT_SERVICE_FIX.md.
 */

const MAX_DESCRIPTION_LENGTH = 500;

function eventDescription(eventType: string, eventData: Record<string, unknown>): string {
  switch (eventType) {
    case 'decision': {
      const title = eventData.title as string | undefined;
      const id = eventData.decision_id as string | undefined;
      const s = title
        ? `Decision: ${title}`
        : id
          ? `Decision created (${id.slice(0, 8)}…)`
          : 'Decision created';
      return s.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    case 'media_post': {
      const headline = eventData.headline as string | undefined;
      const s = headline ? `Media post: ${headline}` : 'Media post';
      return s.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    default: {
      const s = `Event: ${eventType}`;
      return s.slice(0, MAX_DESCRIPTION_LENGTH);
    }
  }
}

export const logEvent = async (
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  createdBy: string,
): Promise<void> => {
  try {
    const description = eventDescription(eventType, eventData ?? {});
    const { error } = await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: eventType,
      description,
      actor_id: createdBy,
      metadata: eventData ?? {},
    });

    if (error) {
      logger.error({ error, sessionId, eventType }, 'Failed to log event');
      throw error;
    }

    logger.info({ sessionId, eventType }, 'Event logged');
  } catch (err) {
    logger.error({ error: err, sessionId, eventType }, 'Error logging event');
    throw err;
  }
};

export const broadcastEvent = (
  io: SocketServer,
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
): void => {
  try {
    io.to(`session:${sessionId}`).emit('event', {
      type: eventType,
      data: eventData,
      timestamp: new Date().toISOString(),
    });
    logger.debug({ sessionId, eventType }, 'Event broadcasted');
  } catch (err) {
    logger.error({ error: err, sessionId, eventType }, 'Error broadcasting event');
  }
};

export const logAndBroadcastEvent = async (
  io: SocketServer,
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  createdBy: string,
): Promise<void> => {
  await logEvent(sessionId, eventType, eventData, createdBy);
  broadcastEvent(io, sessionId, eventType, eventData);
};
