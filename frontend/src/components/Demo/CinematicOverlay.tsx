import { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface ActionCard {
  id: string;
  team: string;
  type: 'chat' | 'inject';
  title: string;
  description: string;
  timestamp: Date;
}

interface CinematicOverlayProps {
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

function getTeamColor(teamName: string): string {
  const key = teamName.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [k, color] of Object.entries(TEAM_COLORS)) {
    if (key.includes(k)) return color;
  }
  return '#94a3b8';
}

const MAX_CARDS = 5;
const CARD_LIFETIME_MS = 12000;

export function CinematicOverlay({ sessionId }: CinematicOverlayProps) {
  const [cards, setCards] = useState<ActionCard[]>([]);
  const [injectBanner, setInjectBanner] = useState<{ title: string; severity: string } | null>(
    null,
  );
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addCard = useCallback((card: ActionCard) => {
    setCards((prev) => {
      if (prev.some((c) => c.id === card.id)) return prev;
      return [card, ...prev].slice(0, MAX_CARDS);
    });
    setTimeout(() => {
      setCards((prev) => prev.filter((c) => c.id !== card.id));
    }, CARD_LIFETIME_MS);
  }, []);

  const handleEvent = useCallback(
    (event: WebSocketEvent) => {
      if (event.type === 'message.sent') {
        const message = (event.data as { message?: Record<string, unknown> })?.message;
        if (!message) return;
        const sender = message.sender as { full_name?: string } | undefined;
        const msgType = message.type as string;
        if (msgType === 'system') return;
        addCard({
          id: `msg-${message.id}`,
          team: sender?.full_name ?? 'Unknown',
          type: 'chat',
          title: sender?.full_name ?? 'Radio',
          description: (message.content as string)?.slice(0, 200) ?? '',
          timestamp: new Date(),
        });
      }

      if (event.type === 'inject.published') {
        const inject = (event.data as { inject?: Record<string, unknown> })?.inject;
        if (!inject) return;
        setInjectBanner({
          title: (inject.title as string) ?? 'INJECT',
          severity: (inject.severity as string) ?? 'medium',
        });
        if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
        bannerTimeoutRef.current = setTimeout(() => setInjectBanner(null), 8000);
      }
    },
    [addCard],
  );

  useWebSocket({
    sessionId,
    onEvent: handleEvent,
    eventTypes: ['message.sent', 'inject.published'],
  });

  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    };
  }, []);

  const severityColor = (s: string) =>
    s === 'critical' ? 'bg-red-600' : s === 'high' ? 'bg-orange-500' : 'bg-yellow-500';

  return (
    <>
      {/* Inject banner (top-center) */}
      {injectBanner && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1001] animate-pulse">
          <div
            className={`${severityColor(injectBanner.severity)} px-6 py-3 rounded-lg shadow-2xl border border-white/20`}
          >
            <div className="text-xs font-bold uppercase tracking-widest text-white/80 mb-0.5">
              INJECT
            </div>
            <div className="text-sm font-bold text-white max-w-md text-center">
              {injectBanner.title}
            </div>
          </div>
        </div>
      )}

      {/* Floating action cards (center of screen) */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] w-80 flex flex-col gap-2 pointer-events-none">
        {cards.map((card) => {
          const color = getTeamColor(card.team);
          const typeIcon = card.type === 'inject' ? '🔴' : '📻';

          return (
            <div
              key={card.id}
              className="bg-robotic-gray-300/95 backdrop-blur-md border border-robotic-yellow/30 rounded-lg p-3 shadow-2xl pointer-events-auto"
              style={{
                borderLeftWidth: 4,
                borderLeftColor: color,
                animation: 'fadeIn 0.5s ease-out',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{typeIcon}</span>
                <span className="text-xs terminal-text uppercase text-robotic-yellow/70">
                  {card.type}
                </span>
                <span className="ml-auto text-[10px] terminal-text text-robotic-yellow/40">
                  {card.timestamp.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              </div>
              <div className="text-sm terminal-text text-robotic-yellow font-semibold truncate">
                {card.title}
              </div>
              {card.description && (
                <div className="text-xs terminal-text text-robotic-yellow/60 mt-0.5 line-clamp-3">
                  {card.description}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
