import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { useWebSocket, type WebSocketEvent } from '../../hooks/useWebSocket';
import { useRealtime } from '../../hooks/useRealtime';
import { supabase } from '../../lib/supabase';

interface Event {
  id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
  creator?: {
    full_name: string;
    role: string;
  };
}

interface TimelineFeedProps {
  sessionId: string;
}

export const TimelineFeed = ({ sessionId }: TimelineFeedProps) => {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    loadEvents();
  }, [sessionId]);

  // Supabase Realtime subscription for inject events (instant updates)
  useRealtime<{
    id: string;
    session_id: string;
    event_type: string;
    description: string;
    actor_id: string | null;
    actor_role: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }>({
    table: 'session_events',
    filter: sessionId ? `session_id=eq.${sessionId}.and(event_type=eq.inject)` : undefined,
    onInsert: async (payload) => {
      // Only process inject events
      if (payload.event_type !== 'inject') return;

      // Fetch actor information if available
      let creator = undefined;
      if (payload.actor_id) {
        try {
          const { data: actor } = await supabase
            .from('user_profiles')
            .select('full_name, role')
            .eq('id', payload.actor_id)
            .single();

          if (actor) {
            creator = {
              full_name: actor.full_name,
              role: actor.role,
            };
          }
        } catch (error) {
          console.error('Failed to fetch actor info for event:', error);
        }
      }

      // Transform database row into Event format
      const event: Event = {
        id: payload.id,
        event_type: payload.event_type,
        event_data: payload.metadata || {},
        created_at: payload.created_at,
        creator: creator,
      };

      // Add event optimistically to the beginning of the array
      setEvents((prev) => {
        // Check if event already exists (prevent duplicates)
        const exists = prev.some((e) => e.id === event.id);
        if (exists) return prev;
        // Add to beginning for newest first (assuming events are sorted newest first)
        return [event, ...prev];
      });
    },
    enabled: !!sessionId,
  });

  // WebSocket subscription for other event types (decisions, resources, etc.)
  useWebSocket({
    sessionId,
    eventTypes: [
      'decision.proposed',
      'decision.approved',
      'decision.rejected',
      'decision.executed',
      'resource.requested',
      'resource.countered',
      'resource.approved',
      'resource.rejected',
      'resource.transferred',
      'message.sent',
    ],
    onEvent: async (event: WebSocketEvent) => {
      // Reload events when non-inject events occur (these may not be in session_events yet)
      await loadEvents();
    },
    enabled: !!sessionId,
  });

  const loadEvents = async () => {
    try {
      const result = await api.events.list(sessionId, 1, 50);
      setEvents(result.data as Event[]);
    } catch (error) {
      console.error('Failed to load events:', error);
    } finally {
      setLoading(false);
    }
  };

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case 'inject':
        return '📡';
      case 'decision':
        return '⚡';
      case 'message':
        return '💬';
      case 'resource':
        return '📦';
      default:
        return '📋';
    }
  };

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case 'inject':
        return 'border-robotic-orange text-robotic-orange';
      case 'decision':
        return 'border-robotic-yellow text-robotic-yellow';
      case 'message':
        return 'border-robotic-gray-50 text-robotic-gray-50';
      case 'resource':
        return 'border-robotic-yellow text-robotic-yellow';
      default:
        return 'border-robotic-gray-200 text-robotic-gray-200';
    }
  };

  if (loading && events.length === 0) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_TIMELINE]
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="military-border p-6 h-[600px] overflow-y-auto">
      <h3 className="text-lg terminal-text uppercase mb-4">[TIMELINE] Event Feed</h3>
      <div className="space-y-3">
        {events.map((event) => (
          <div
            key={event.id}
            className={`military-border p-4 border-l-4 ${getEventColor(event.event_type)}`}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{getEventIcon(event.event_type)}</span>
              <div className="flex-1">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-xs terminal-text uppercase text-robotic-yellow/70">
                    [{event.event_type.toUpperCase()}]
                  </span>
                  <span className="text-xs terminal-text text-robotic-yellow/50">
                    {new Date(event.created_at).toLocaleTimeString()}
                  </span>
                </div>
                {(() => {
                  // Safety check: event_data might be undefined or null
                  if (!event.event_data || typeof event.event_data !== 'object') {
                    return null;
                  }
                  const title = 'title' in event.event_data ? event.event_data.title : null;
                  const content = 'content' in event.event_data ? event.event_data.content : null;
                  return (
                    <>
                      {title && (
                        <h4 className="text-sm terminal-text font-semibold mb-1">
                          {String(title)}
                        </h4>
                      )}
                      {content && (
                        <p className="text-xs terminal-text text-robotic-yellow/70">
                          {String(content)}
                        </p>
                      )}
                    </>
                  );
                })()}
                {event.creator && (
                  <p className="text-xs terminal-text text-robotic-yellow/50 mt-2">
                    By: {event.creator.full_name} [{event.creator.role}]
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-center py-8">
            <p className="text-sm terminal-text text-robotic-yellow/50">
              [NO_EVENTS] No events yet
            </p>
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
};
