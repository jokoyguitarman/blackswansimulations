import { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface ActionCard {
  id: string;
  team: string;
  type: 'decision' | 'placement' | 'chat' | 'inject';
  title: string;
  description: string;
  timestamp: Date;
}

interface CinematicOverlayProps {
  sessionId: string;
  onPanTo?: (lat: number, lng: number) => void;
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

function formatTeamName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const MAX_CARDS = 5;
const CARD_LIFETIME_MS = 12000;

export function CinematicOverlay({ sessionId, onPanTo }: CinematicOverlayProps) {
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
      if (event.type === 'decision.executed' || event.type === 'decision.proposed') {
        const decision = (event.data as { decision?: Record<string, unknown> })?.decision;
        if (!decision) return;
        const creator = decision.creator as { full_name?: string } | undefined;
        addCard({
          id: `dec-${decision.id}`,
          team: (creator?.full_name as string) ?? 'Command',
          type: 'decision',
          title: (decision.title as string) ?? 'Decision',
          description: (decision.description as string)?.slice(0, 160) ?? '',
          timestamp: new Date(),
        });
      }

      if (event.type === 'placement.created') {
        const placement = (event.data as { placement?: Record<string, unknown> })?.placement;
        if (!placement) return;
        const teamName = (placement.team_name as string) ?? '';
        addCard({
          id: `plc-${placement.id}`,
          team: teamName,
          type: 'placement',
          title:
            (placement.label as string) ??
            (placement.asset_type as string)?.replace(/_/g, ' ') ??
            'Asset',
          description: `${formatTeamName(teamName)} placed ${(placement.asset_type as string)?.replace(/_/g, ' ')}`,
          timestamp: new Date(),
        });

        if (onPanTo) {
          const geom = placement.geometry as { type?: string; coordinates?: unknown } | undefined;
          if (geom?.type === 'Point') {
            const coords = geom.coordinates as [number, number];
            if (coords) onPanTo(coords[1], coords[0]);
          }
        }
      }

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
    [addCard, onPanTo],
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
    ],
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

      {/* Floating action cards (bottom-left) */}
      <div className="absolute bottom-16 left-4 z-[1000] w-80 flex flex-col gap-2">
        {cards.map((card) => {
          const color = getTeamColor(card.team);
          const typeIcon =
            card.type === 'decision'
              ? '⚡'
              : card.type === 'placement'
                ? '📍'
                : card.type === 'inject'
                  ? '🔴'
                  : '📻';

          return (
            <div
              key={card.id}
              className="bg-robotic-gray-300/90 backdrop-blur-md border border-robotic-yellow/30 rounded-lg p-3 shadow-lg"
              style={{
                borderLeftWidth: 4,
                borderLeftColor: color,
                animation: 'slideInLeft 0.4s ease-out',
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
                <div className="text-xs terminal-text text-robotic-yellow/60 mt-0.5 line-clamp-2">
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
