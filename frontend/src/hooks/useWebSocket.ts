import { useEffect, useRef, useCallback } from 'react';
import { websocketClient, type WebSocketEvent } from '../lib/websocketClient';

/**
 * React Hook for WebSocket subscriptions - Client-side only
 * Separation of concerns: React-specific WebSocket integration
 */

export interface UseWebSocketOptions {
  sessionId?: string;
  channelId?: string;
  eventTypes?: string[];
  onEvent?: (event: WebSocketEvent) => void;
  enabled?: boolean;
}

/**
 * Hook to subscribe to WebSocket events
 */
export const useWebSocket = (options: UseWebSocketOptions = {}) => {
  const { sessionId, channelId, eventTypes = [], onEvent, enabled = true } = options;

  const handlersRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const setup = async () => {
      try {
        // Connect to WebSocket
        await websocketClient.connect();

        // Join session room if provided
        if (sessionId) {
          await websocketClient.joinSession(sessionId);
        }

        // Join channel room if provided
        if (channelId) {
          await websocketClient.joinChannel(channelId);
        }

        // Subscribe to specific event types
        const unsubscribers: (() => void)[] = [];

        if (onEvent) {
          // Subscribe to all specified event types
          eventTypes.forEach((eventType) => {
            const unsubscribe = websocketClient.on(eventType, onEvent);
            unsubscribers.push(unsubscribe);
            handlersRef.current.set(eventType, unsubscribe);
          });

          // If no specific event types, subscribe to all events
          if (eventTypes.length === 0) {
            const unsubscribe = websocketClient.onAll(onEvent);
            unsubscribers.push(unsubscribe);
            handlersRef.current.set('*', unsubscribe);
          }
        }

        // Cleanup function
        return () => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
          handlersRef.current.clear();

          if (sessionId) {
            websocketClient.leaveSession(sessionId);
          }
        };
      } catch (error) {
        console.error('[useWebSocket] Error setting up WebSocket:', error);
      }
    };

    const cleanup = setup();

    return () => {
      cleanup.then((cleanupFn) => cleanupFn?.());
    };
  }, [sessionId, channelId, enabled, onEvent, eventTypes.join(',')]);

  // Return connection status
  return {
    isConnected: websocketClient.isConnected(),
  };
};

/**
 * Hook to subscribe to specific event types
 */
export const useWebSocketEvent = (
  eventType: string,
  handler: (event: WebSocketEvent) => void,
  options: { sessionId?: string; enabled?: boolean } = {},
) => {
  return useWebSocket({
    ...options,
    eventTypes: [eventType],
    onEvent: handler,
  });
};
