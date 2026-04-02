import { useState, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface TickerEntry {
  id: string;
  team: string;
  type: string;
  text: string;
  timestamp: Date;
}

interface ActivityTickerProps {
  sessionId: string;
}

const TEAM_COLORS: Record<string, string> = {
  police: '#3b82f6',
  triage: '#ef4444',
  medical: '#ef4444',
  health: '#ef4444',
  evacuation: '#22c55e',
  civil: '#22c55e',
  media: '#a855f7',
  fire: '#f97316',
  hazmat: '#f97316',
  fire_hazmat: '#f97316',
  intelligence: '#6366f1',
  negotiation: '#06b6d4',
  security: '#eab308',
};

function resolveColor(name: string): string {
  const key = name.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [k, color] of Object.entries(TEAM_COLORS)) {
    if (key.includes(k)) return color;
  }
  return '#94a3b8';
}

const TYPE_ICONS: Record<string, string> = {
  decision: '⚡',
  placement: '📍',
  chat: '📻',
  inject: '🔴',
  resource: '📦',
  state: '🔄',
};

const MAX_ENTRIES = 50;

export function ActivityTicker({ sessionId }: ActivityTickerProps) {
  const [entries, setEntries] = useState<TickerEntry[]>([]);

  const addEntry = useCallback((entry: TickerEntry) => {
    setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
  }, []);

  const handleEvent = useCallback(
    (event: WebSocketEvent) => {
      const ts = new Date();

      if (event.type === 'decision.executed' || event.type === 'decision.proposed') {
        const d = (event.data as { decision?: Record<string, unknown> })?.decision;
        if (!d) return;
        const creator = d.creator as { full_name?: string } | undefined;
        addEntry({
          id: `d-${d.id}-${ts.getTime()}`,
          team: creator?.full_name ?? 'Command',
          type: 'decision',
          text: (d.title as string) ?? 'Decision executed',
          timestamp: ts,
        });
      }

      if (event.type === 'placement.created') {
        const p = (event.data as { placement?: Record<string, unknown> })?.placement;
        if (!p) return;
        addEntry({
          id: `p-${p.id}-${ts.getTime()}`,
          team: (p.team_name as string) ?? '',
          type: 'placement',
          text: `${(p.label as string) ?? (p.asset_type as string)?.replace(/_/g, ' ')}`,
          timestamp: ts,
        });
      }

      if (event.type === 'message.sent') {
        const m = (event.data as { message?: Record<string, unknown> })?.message;
        if (!m || (m.type as string) === 'system') return;
        const sender = m.sender as { full_name?: string } | undefined;
        addEntry({
          id: `m-${m.id}-${ts.getTime()}`,
          team: sender?.full_name ?? 'Unknown',
          type: 'chat',
          text: (m.content as string)?.slice(0, 120) ?? '',
          timestamp: ts,
        });
      }

      if (event.type === 'inject.published') {
        const i = (event.data as { inject?: Record<string, unknown> })?.inject;
        if (!i) return;
        addEntry({
          id: `i-${i.id}-${ts.getTime()}`,
          team: 'SCENARIO',
          type: 'inject',
          text: (i.title as string) ?? 'New inject',
          timestamp: ts,
        });
      }

      if (event.type === 'state.updated') {
        addEntry({
          id: `s-${ts.getTime()}`,
          team: 'SYSTEM',
          type: 'state',
          text: 'Scenario state updated',
          timestamp: ts,
        });
      }
    },
    [addEntry],
  );

  useWebSocket({
    sessionId,
    onEvent: handleEvent,
    eventTypes: [
      'decision.executed',
      'decision.proposed',
      'placement.created',
      'message.sent',
      'inject.published',
      'state.updated',
    ],
  });

  return (
    <div className="h-full flex flex-col bg-robotic-gray-400/95 border-l border-robotic-yellow/30">
      <div className="px-4 py-3 border-b border-robotic-yellow/20">
        <h3 className="text-sm terminal-text uppercase text-robotic-yellow tracking-wider">
          Activity Feed
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {entries.length === 0 && (
          <p className="text-xs terminal-text text-robotic-yellow/40 italic mt-4 text-center">
            Waiting for activity...
          </p>
        )}
        {entries.map((entry) => {
          const color = resolveColor(entry.team);
          return (
            <div
              key={entry.id}
              className="flex items-start gap-2 py-1.5 border-b border-robotic-yellow/10"
              style={{ animation: 'slideInDown 0.3s ease-out' }}
            >
              <span className="text-xs mt-0.5 shrink-0">{TYPE_ICONS[entry.type] ?? '•'}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[10px] font-bold uppercase tracking-wide truncate"
                    style={{ color }}
                  >
                    {entry.team}
                  </span>
                  <span className="text-[9px] text-robotic-yellow/30 shrink-0">
                    {entry.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-xs terminal-text text-robotic-yellow/80 line-clamp-2">
                  {entry.text}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
