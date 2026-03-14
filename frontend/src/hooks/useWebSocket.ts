import { useEffect, useRef, useCallback } from 'react';
import { websocketClient, type WebSocketEvent } from '../lib/websocketClient';

/**
 * React Hook for WebSocket subscriptions - Client-side only
 * Separation of concerns: React-specific WebSocket integration
 */

// Re-export WebSocketEvent for convenience
export type { WebSocketEvent };

export interface UseWebSocketOptions {
  sessionId?: string;
  channelId?: string;
  eventTypes?: string[];
  onEvent?: (event: WebSocketEvent) => void;
  enabled?: boolean;
}

/**
 * Hook to subscribe to WebSocket events.
 * Uses a ref for onEvent so the effect only re-runs when sessionId,
 * channelId, enabled, or eventTypes change — not on every render.
 */
export const useWebSocket = (options: UseWebSocketOptions = {}) => {
  const { sessionId, channelId, eventTypes = [], onEvent, enabled = true } = options;

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const handlersRef = useRef<Map<string, () => void>>(new Map());

  const stableOnEvent = useCallback((event: WebSocketEvent) => {
    onEventRef.current?.(event);
  }, []);

  // Memoize eventTypes join so a new array with same contents doesn't re-trigger
  const eventTypesKey = eventTypes.join(',');

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const unsubscribers: (() => void)[] = [];

    const setup = async () => {
      try {
        await websocketClient.connect();

        if (cancelled) return;

        if (sessionId) {
          await websocketClient.joinSession(sessionId);
        }

        if (channelId) {
          await websocketClient.joinChannel(channelId);
        }

        if (cancelled) return;

        const types = eventTypesKey ? eventTypesKey.split(',') : [];

        if (types.length > 0) {
          types.forEach((eventType) => {
            const unsubscribe = websocketClient.on(eventType, stableOnEvent);
            unsubscribers.push(unsubscribe);
            handlersRef.current.set(eventType, unsubscribe);
          });
        } else {
          const unsubscribe = websocketClient.onAll(stableOnEvent);
          unsubscribers.push(unsubscribe);
          handlersRef.current.set('*', unsubscribe);
        }
      } catch (error) {
        console.error('[useWebSocket] Error setting up WebSocket:', error);
      }
    };

    setup();

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      handlersRef.current.clear();

      if (sessionId) {
        websocketClient.leaveSession(sessionId);
      }
    };
  }, [sessionId, channelId, enabled, eventTypesKey, stableOnEvent]);

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
