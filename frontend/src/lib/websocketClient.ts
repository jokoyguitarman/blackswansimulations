import { io, type Socket } from 'socket.io-client';
import { supabase } from './supabase';

/**
 * WebSocket Client Service - Client-side only
 * Separation of concerns: All WebSocket client logic
 * This service handles connection, subscriptions, and event listeners
 */

export interface WebSocketEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type EventHandler = (event: WebSocketEvent) => void;

class WebSocketClient {
  private socket: Socket | null = null;
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private connectionPromise: Promise<Socket> | null = null;

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<Socket> {
    if (this.socket?.connected) {
      return this.socket;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Not authenticated');
      }

      // Use environment variable for WebSocket URL (same as API)
      // In development, Vite proxy handles it. In production, use VITE_API_URL
      const wsUrl = import.meta.env.DEV
        ? window.location.origin.replace(':3000', ':3001')
        : import.meta.env.VITE_API_URL || window.location.origin;

      this.socket = io(wsUrl, {
        auth: {
          token: session.access_token,
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
      });

      this.socket.on('connect', () => {
        console.log('[WEBSOCKET] Connected');
        this.connectionPromise = null;
      });

      this.socket.on('disconnect', (reason: string) => {
        console.log('[WEBSOCKET] Disconnected:', reason);
        this.connectionPromise = null;
      });

      this.socket.on('error', (error: Error | { message?: string }) => {
        // Filter out noisy "Channel not found" errors - these are expected during channel switching
        // Chat messages are handled by Supabase Realtime, so WebSocket channel joins are optional
        const errorMessage =
          typeof error === 'object' && 'message' in error ? error.message : String(error);
        if (errorMessage === 'Channel not found') {
          // Only log at debug level - this is expected behavior when channels don't exist yet
          console.debug('[WEBSOCKET] Channel not found (expected during channel loading):', error);
        } else {
          console.error('[WEBSOCKET] Error:', error);
        }
      });

      // Listen for all events and route to handlers
      this.socket.on('event', (event: WebSocketEvent) => {
        this.handleEvent(event);
      });

      return this.socket;
    })();

    return this.connectionPromise;
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.eventHandlers.clear();
    this.connectionPromise = null;
  }

  /**
   * Join a session room
   */
  async joinSession(sessionId: string): Promise<void> {
    const socket = await this.connect();
    socket.emit('join_session', sessionId);
  }

  /**
   * Leave a session room
   */
  leaveSession(sessionId: string): void {
    if (this.socket) {
      this.socket.emit('leave_session', sessionId);
    }
  }

  /**
   * Join a channel room
   */
  async joinChannel(channelId: string): Promise<void> {
    if (!channelId) {
      console.warn('[WEBSOCKET] Cannot join channel: channelId is empty');
      return;
    }
    const socket = await this.connect();
    socket.emit('join_channel', channelId);
  }

  /**
   * Subscribe to specific event types
   */
  on(eventType: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }
    this.eventHandlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(eventType);
        }
      }
    };
  }

  /**
   * Subscribe to all events
   */
  onAll(handler: EventHandler): () => void {
    return this.on('*', handler);
  }

  /**
   * Handle incoming event and route to appropriate handlers
   */
  private handleEvent(event: WebSocketEvent): void {
    // Call specific event type handlers
    const specificHandlers = this.eventHandlers.get(event.type);
    if (specificHandlers) {
      specificHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error(`[WEBSOCKET] Error in handler for ${event.type}:`, error);
        }
      });
    }

    // Call wildcard handlers
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error('[WEBSOCKET] Error in wildcard handler:', error);
        }
      });
    }
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

// Singleton instance
export const websocketClient = new WebSocketClient();
