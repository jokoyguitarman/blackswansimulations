import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * React Hook for Supabase Realtime subscriptions
 * Handles subscribing to table changes with filtering and automatic cleanup
 */

export interface UseRealtimeOptions<T = Record<string, unknown>> {
  table: string;
  filter?: string; // PostgREST filter string, e.g., "session_id=eq.123"
  onInsert?: (payload: T) => void;
  onUpdate?: (payload: T) => void;
  onDelete?: (payload: T) => void;
  enabled?: boolean;
}

export interface UseRealtimeReturn {
  isConnected: boolean;
  error: Error | null;
}

/**
 * Hook to subscribe to Supabase Realtime changes for a table
 *
 * @example
 * ```tsx
 * useRealtime({
 *   table: 'chat_messages',
 *   filter: `channel_id=eq.${channelId}`,
 *   onInsert: (message) => setMessages(prev => [...prev, message]),
 *   enabled: !!channelId,
 * });
 * ```
 */
export const useRealtime = <T = Record<string, unknown>>(
  options: UseRealtimeOptions<T>,
): UseRealtimeReturn => {
  const { table, filter, onInsert, onUpdate, onDelete, enabled = true } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const processedIdsRef = useRef<Set<string>>(new Set());
  // One Realtime channel PER HOOK INSTANCE. Since realtime-js 2.9x `supabase.channel(topic)`
  // returns the existing channel when the topic already exists, so two components subscribing to
  // the same table (e.g. TeamChat's list, conversation and ChatInterface all watching
  // `chat_messages`) would share one channel and the second `.on('postgres_changes')` would throw
  // "cannot add `postgres_changes` callbacks … after `subscribe()`". A unique suffix keeps every
  // subscriber on its own channel; Supabase happily multiplexes them over one socket.
  const instanceIdRef = useRef(
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );

  // Store callbacks in refs to prevent re-subscription on every render
  const onInsertRef = useRef(onInsert);
  const onUpdateRef = useRef(onUpdate);
  const onDeleteRef = useRef(onDelete);

  // Update refs when callbacks change
  useEffect(() => {
    onInsertRef.current = onInsert;
    onUpdateRef.current = onUpdate;
    onDeleteRef.current = onDelete;
  }, [onInsert, onUpdate, onDelete]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Ensure Realtime auth token is set (required for RLS to work with Realtime)
    const setRealtimeAuth = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
        console.log(`[useRealtime] Set Realtime auth token for ${table}`);
      } else {
        console.warn(`[useRealtime] No session found - Realtime may not work with RLS`);
      }
    };
    setRealtimeAuth();

    // Create channel with filter — suffixed per hook instance so subscribers never share a topic.
    const baseName = filter ? `${table}:${filter.replace(/[^a-zA-Z0-9]/g, '_')}` : table;
    const channelName = `${baseName}:${instanceIdRef.current}`;

    // Parse filter if provided (format: "column=eq.value" or "column=in.(value1,value2)")
    let filterConfig: Record<string, string> | undefined = undefined;
    if (filter) {
      // Parse PostgREST filter format: "column=eq.value" -> { column: 'column', value: 'value' }
      const match = filter.match(/^(\w+)=eq\.(.+)$/);
      if (match) {
        const [, column, value] = match;
        filterConfig = { filter: `${column}=eq.${value}` };
      } else {
        // Use filter as-is if it doesn't match expected format
        filterConfig = { filter };
      }
    }

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: table,
          ...filterConfig,
        },
        (payload) => {
          console.log(`[useRealtime] ✅✅✅ INSERT event received for ${table}!`, {
            event: 'INSERT',
            table,
            filter,
            messageId: (payload.new as { id?: string })?.id,
            payloadKeys: Object.keys(payload.new || {}),
            fullPayload: payload.new,
          });

          // Prevent duplicate processing
          const id = (payload.new as { id?: string })?.id;
          if (id && processedIdsRef.current.has(id)) {
            console.log(`[useRealtime] Skipping duplicate ID: ${id}`);
            return;
          }
          if (id) {
            processedIdsRef.current.add(id);
            // Clean up old IDs to prevent memory leak (keep last 1000)
            if (processedIdsRef.current.size > 1000) {
              const idsArray = Array.from(processedIdsRef.current);
              processedIdsRef.current = new Set(idsArray.slice(-500));
            }
          }

          // Use ref to get latest callback
          if (onInsertRef.current) {
            console.log(`[useRealtime] Calling onInsert handler for ${table}`);
            try {
              onInsertRef.current(payload.new as T);
            } catch (err) {
              console.error(`[useRealtime] Error in onInsert handler for ${table}:`, err);
              setError(err instanceof Error ? err : new Error(String(err)));
            }
          } else {
            console.warn(`[useRealtime] No onInsert handler registered for ${table}`);
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: table,
          ...filterConfig,
        },
        (payload) => {
          if (onUpdateRef.current) {
            try {
              onUpdateRef.current(payload.new as T);
            } catch (err) {
              console.error(`[useRealtime] Error in onUpdate handler for ${table}:`, err);
              setError(err instanceof Error ? err : new Error(String(err)));
            }
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: table,
          ...filterConfig,
        },
        (payload) => {
          if (onDeleteRef.current) {
            try {
              onDeleteRef.current(payload.old as T);
            } catch (err) {
              console.error(`[useRealtime] Error in onDelete handler for ${table}:`, err);
              setError(err instanceof Error ? err : new Error(String(err)));
            }
          }
        },
      )
      .subscribe((status, err) => {
        console.log(
          `[useRealtime] Subscription status for ${table}${filter ? ` (filter: ${filter})` : ''}:`,
          status,
          err ? { error: err } : '',
        );
        setIsConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') {
          setError(null);
          console.log(
            `[useRealtime] ✅ Successfully subscribed to ${table}${filter ? ` with filter ${filter}` : ' (no filter - subscribing to all)'}`,
          );
          console.log(
            `[useRealtime] 💡 Waiting for INSERT events. When a row is inserted, you should see: "[useRealtime] ✅ INSERT event received"`,
          );
        } else if (status === 'CHANNEL_ERROR') {
          const errorMsg = `Failed to subscribe to ${table}`;
          console.error(`[useRealtime] ❌ ${errorMsg}`, err);
          setError(new Error(errorMsg));
        } else if (status === 'TIMED_OUT') {
          const errorMsg = `Subscription to ${table} timed out`;
          console.error(`[useRealtime] ❌ ${errorMsg}`);
          setError(new Error(errorMsg));
        } else if (status === 'CLOSED') {
          console.warn(`[useRealtime] ⚠️ Subscription to ${table} closed`);
        }
      });

    channelRef.current = channel;

    // Cleanup function
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      processedIdsRef.current.clear();
      setIsConnected(false);
      setError(null);
    };
  }, [table, filter, enabled]); // Removed callbacks from dependencies - using refs instead

  return {
    isConnected,
    error,
  };
};
