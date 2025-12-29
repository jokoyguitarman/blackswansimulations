import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { logger } from '../lib/logger.js';
import type { Server as SocketServer } from 'socket.io';

/**
 * Event Service - Business logic for event logging and broadcasting
 * Separation of concerns: Event-related business logic
 */

export const logEvent = async (
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  createdBy: string,
): Promise<void> => {
  try {
    const { error } = await supabaseAdmin.from('session_events').insert({
      session_id: sessionId,
      event_type: eventType,
      event_data: eventData,
      created_by: createdBy,
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
