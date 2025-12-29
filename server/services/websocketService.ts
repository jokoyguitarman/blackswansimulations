import type { Server as SocketServer } from 'socket.io';
import { logger } from '../lib/logger.js';

/**
 * WebSocket Service - Server-side only
 * Separation of concerns: All WebSocket event broadcasting logic
 * This service is called by route handlers to broadcast events
 */

export interface WebSocketEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export class WebSocketService {
  private io: SocketServer;

  constructor(io: SocketServer) {
    this.io = io;
  }

  /**
   * Broadcast event to all clients in a session room
   */
  broadcastToSession(sessionId: string, event: WebSocketEvent): void {
    try {
      this.io.to(`session:${sessionId}`).emit('event', event);
      logger.debug({ sessionId, eventType: event.type }, 'Event broadcasted to session');
    } catch (err) {
      logger.error(
        { error: err, sessionId, eventType: event.type },
        'Error broadcasting to session',
      );
    }
  }

  /**
   * Broadcast event to a specific channel room
   */
  broadcastToChannel(channelId: string, event: WebSocketEvent): void {
    try {
      this.io.to(`channel:${channelId}`).emit('event', event);
      logger.debug({ channelId, eventType: event.type }, 'Event broadcasted to channel');
    } catch (err) {
      logger.error(
        { error: err, channelId, eventType: event.type },
        'Error broadcasting to channel',
      );
    }
  }

  /**
   * Emit event to a specific user
   */
  emitToUser(userId: string, event: WebSocketEvent): void {
    try {
      this.io.to(`user:${userId}`).emit('event', event);
      logger.debug({ userId, eventType: event.type }, 'Event emitted to user');
    } catch (err) {
      logger.error({ error: err, userId, eventType: event.type }, 'Error emitting to user');
    }
  }

  /**
   * Decision events
   */
  decisionProposed(sessionId: string, decision: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'decision.proposed',
      data: { decision },
      timestamp: new Date().toISOString(),
    });
  }

  decisionApproved(sessionId: string, decision: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'decision.approved',
      data: { decision },
      timestamp: new Date().toISOString(),
    });
  }

  decisionRejected(sessionId: string, decision: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'decision.rejected',
      data: { decision },
      timestamp: new Date().toISOString(),
    });
  }

  decisionExecuted(sessionId: string, decision: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'decision.executed',
      data: { decision },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Resource events
   */
  resourceRequested(sessionId: string, request: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'resource.requested',
      data: { request },
      timestamp: new Date().toISOString(),
    });
  }

  resourceCountered(sessionId: string, request: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'resource.countered',
      data: { request },
      timestamp: new Date().toISOString(),
    });
  }

  resourceApproved(sessionId: string, request: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'resource.approved',
      data: { request },
      timestamp: new Date().toISOString(),
    });
  }

  resourceRejected(sessionId: string, request: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'resource.rejected',
      data: { request },
      timestamp: new Date().toISOString(),
    });
  }

  resourceTransferred(sessionId: string, transaction: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'resource.transferred',
      data: { transaction },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Message events
   */
  messageSent(channelId: string, message: Record<string, unknown>): void {
    this.broadcastToChannel(channelId, {
      type: 'message.sent',
      data: { message },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Inject events
   */
  injectPublished(sessionId: string, inject: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'inject.published',
      data: { inject },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Incident events (for future use)
   */
  incidentCreated(sessionId: string, incident: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'incident.created',
      data: { incident },
      timestamp: new Date().toISOString(),
    });
  }

  incidentUpdated(sessionId: string, incident: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'incident.updated',
      data: { incident },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Participant ready status events
   */
  readyStatusUpdated(
    sessionId: string,
    statusData: {
      total: number;
      ready: number;
      all_ready: boolean;
      participants: Array<{ user_id: string; is_ready: boolean; user?: { full_name: string } }>;
    },
  ): void {
    this.broadcastToSession(sessionId, {
      type: 'participant.ready_status_updated',
      data: statusData,
      timestamp: new Date().toISOString(),
    });
    logger.debug(
      { sessionId, total: statusData.total, ready: statusData.ready },
      'Ready status updated event broadcasted',
    );
  }

  /**
   * State update events
   */
  stateUpdated(sessionId: string, stateUpdate: Record<string, unknown>): void {
    this.broadcastToSession(sessionId, {
      type: 'state.updated',
      data: stateUpdate,
      timestamp: new Date().toISOString(),
    });
    logger.debug({ sessionId }, 'State updated event broadcasted');
  }

  /**
   * Notification events (for user-specific notifications)
   */
  notificationCreated(userId: string, notification: Record<string, unknown>): void {
    this.emitToUser(userId, {
      type: 'notification.created',
      data: { notification },
      timestamp: new Date().toISOString(),
    });
  }
}

// Singleton instance - will be initialized in index.ts
let websocketServiceInstance: WebSocketService | null = null;

export const initializeWebSocketService = (io: SocketServer): WebSocketService => {
  websocketServiceInstance = new WebSocketService(io);
  return websocketServiceInstance;
};

export const getWebSocketService = (): WebSocketService => {
  if (!websocketServiceInstance) {
    throw new Error('WebSocketService not initialized. Call initializeWebSocketService first.');
  }
  return websocketServiceInstance;
};
