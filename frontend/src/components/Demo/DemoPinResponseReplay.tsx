import { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface PinResponseEvent {
  bot_user_id: string;
  team_name: string;
  decision_id: string;
  target_id: string;
  target_type: 'casualty' | 'hazard';
  target_label: string;
  actions: string[];
  resources: Array<{ type: string; label: string; quantity: number }>;
  triage_color: string | null;
  description: string;
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

const TRIAGE_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  green: { bg: 'bg-green-500/20', border: 'border-green-400', label: 'MINOR' },
  yellow: { bg: 'bg-yellow-500/20', border: 'border-yellow-400', label: 'DELAYED' },
  red: { bg: 'bg-red-500/20', border: 'border-red-400', label: 'IMMEDIATE' },
  black: { bg: 'bg-gray-800/40', border: 'border-gray-500', label: 'DECEASED' },
};

const PANEL_DISPLAY_MS = 10000;
const STAGGER_DELAY = 600;

export function DemoPinResponseReplay({ sessionId }: { sessionId: string }) {
  const [queue, setQueue] = useState<PinResponseEvent[]>([]);
  const [active, setActive] = useState<PinResponseEvent | null>(null);
  const [phase, setPhase] = useState<'entering' | 'visible' | 'exiting'>('entering');
  const [revealedActions, setRevealedActions] = useState(0);
  const [revealedResources, setRevealedResources] = useState(0);
  const [showTriage, setShowTriage] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enqueue = useCallback((evt: PinResponseEvent) => {
    setQueue((prev) => [...prev, evt]);
  }, []);

  // Pull next item from queue when nothing is active
  useEffect(() => {
    if (active || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setActive(next);
    setPhase('entering');
    setRevealedActions(0);
    setRevealedResources(0);
    setShowTriage(false);
  }, [active, queue]);

  // Animate reveal sequence
  useEffect(() => {
    if (!active) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    // Enter -> visible
    timers.push(setTimeout(() => setPhase('visible'), 400));

    // Stagger reveal actions
    active.actions.forEach((_, i) => {
      timers.push(setTimeout(() => setRevealedActions(i + 1), 800 + i * STAGGER_DELAY));
    });

    const actionsEnd = 800 + active.actions.length * STAGGER_DELAY;

    // Stagger reveal resources
    active.resources.forEach((_, i) => {
      timers.push(
        setTimeout(() => setRevealedResources(i + 1), actionsEnd + 200 + i * STAGGER_DELAY),
      );
    });

    const resourcesEnd = actionsEnd + 200 + active.resources.length * STAGGER_DELAY;

    // Show triage tag
    if (active.triage_color) {
      timers.push(setTimeout(() => setShowTriage(true), resourcesEnd + 400));
    }

    // Start exit
    timers.push(setTimeout(() => setPhase('exiting'), PANEL_DISPLAY_MS - 600));

    // Clear active
    timerRef.current = setTimeout(() => setActive(null), PANEL_DISPLAY_MS);

    return () => {
      timers.forEach(clearTimeout);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active]);

  // WebSocket listener
  useWebSocket({
    sessionId,
    eventTypes: ['demo.pin_response'],
    onEvent: (event: WebSocketEvent) => {
      if (event.type !== 'demo.pin_response') return;
      const data = event.data as unknown as PinResponseEvent;
      if (!data?.target_id) return;
      enqueue(data);
    },
  });

  if (!active) return null;

  const teamColor = getTeamColor(active.team_name);
  const isCasualty = active.target_type === 'casualty';
  const triageMeta = active.triage_color ? TRIAGE_COLORS[active.triage_color] : null;

  return (
    <div
      className={`absolute right-4 z-[1002] transition-all duration-500 ease-out ${
        phase === 'entering'
          ? 'opacity-0 translate-x-12'
          : phase === 'exiting'
            ? 'opacity-0 translate-x-12'
            : 'opacity-100 translate-x-0'
      }`}
      style={{
        top: '50%',
        transform: `translateY(-50%) ${phase !== 'visible' ? 'translateX(3rem)' : ''}`,
      }}
    >
      <div
        className="w-[340px] bg-robotic-gray-300/95 backdrop-blur-xl border border-robotic-yellow/40 rounded-xl shadow-2xl overflow-hidden"
        style={{ borderTopWidth: 4, borderTopColor: teamColor }}
      >
        {/* Header */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">{isCasualty ? '🚑' : '⚠️'}</span>
            <span
              className="text-[10px] terminal-text uppercase font-bold px-2 py-0.5 rounded"
              style={{ background: teamColor + '30', color: teamColor }}
            >
              {formatTeamName(active.team_name)}
            </span>
            <span className="ml-auto text-[10px] terminal-text text-robotic-yellow/40 uppercase">
              {isCasualty ? 'Casualty Response' : 'Hazard Mitigation'}
            </span>
          </div>
          <div className="text-sm terminal-text text-robotic-yellow font-semibold">
            {active.target_label}
          </div>
          {active.description && (
            <div className="text-xs terminal-text text-robotic-yellow/60 mt-1 line-clamp-2">
              {active.description}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-robotic-yellow/20 mx-3" />

        {/* Actions */}
        {active.actions.length > 0 && (
          <div className="px-4 py-2">
            <div className="text-[10px] terminal-text text-robotic-yellow/50 uppercase mb-1.5">
              Actions Taken
            </div>
            <div className="flex flex-col gap-1">
              {active.actions.slice(0, revealedActions).map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs terminal-text text-robotic-yellow/80 animate-fadeInUp"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-robotic-yellow/60 shrink-0" />
                  {a}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resources */}
        {active.resources.length > 0 && (
          <div className="px-4 py-2">
            <div className="text-[10px] terminal-text text-robotic-yellow/50 uppercase mb-1.5">
              Resources Deployed
            </div>
            <div className="flex flex-wrap gap-1.5">
              {active.resources.slice(0, revealedResources).map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1 px-2 py-0.5 bg-robotic-gray-200/50 border border-robotic-yellow/20 rounded text-[11px] terminal-text text-robotic-yellow/70 animate-fadeInUp"
                >
                  <span className="font-bold text-robotic-yellow">{r.quantity}x</span>
                  {r.label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Triage Tag (casualty only) */}
        {showTriage && triageMeta && (
          <div className="px-4 py-2">
            <div className="text-[10px] terminal-text text-robotic-yellow/50 uppercase mb-1.5">
              Triage Assessment
            </div>
            <div
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border-2 ${triageMeta.bg} ${triageMeta.border} animate-triagePulse`}
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{
                  backgroundColor:
                    active.triage_color === 'green'
                      ? '#22c55e'
                      : active.triage_color === 'yellow'
                        ? '#eab308'
                        : active.triage_color === 'red'
                          ? '#ef4444'
                          : '#6b7280',
                }}
              />
              <span className="text-xs terminal-text font-bold text-white uppercase">
                {triageMeta.label}
              </span>
              <span className="text-[10px] terminal-text text-white/60 uppercase">
                ({active.triage_color})
              </span>
            </div>
          </div>
        )}

        {/* Footer progress bar */}
        <div className="h-1 bg-robotic-gray-200/30 mt-1">
          <div
            className="h-full bg-robotic-yellow/50 transition-all ease-linear"
            style={{
              width: phase === 'visible' ? '100%' : '0%',
              transitionDuration: `${PANEL_DISPLAY_MS - 1000}ms`,
            }}
          />
        </div>
      </div>

      {/* Queue indicator */}
      {queue.length > 0 && (
        <div className="mt-2 text-center text-[10px] terminal-text text-robotic-yellow/40">
          +{queue.length} more response{queue.length > 1 ? 's' : ''} queued
        </div>
      )}
    </div>
  );
}
