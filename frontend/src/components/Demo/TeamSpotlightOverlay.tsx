import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface TeamAction {
  id: string;
  type: string;
  text: string;
  timestamp: Date;
}

interface TeamData {
  name: string;
  displayName: string;
  actions: TeamAction[];
}

interface TeamSpotlightOverlayProps {
  sessionId: string;
  rotateIntervalMs?: number;
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

function getTeamColor(name: string): string {
  const key = name.toLowerCase().replace(/[\s-]+/g, '_');
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

const ROTATE_INTERVAL = 8000;
const MAX_ACTIONS_PER_TEAM = 6;

export function TeamSpotlightOverlay({
  sessionId,
  rotateIntervalMs = ROTATE_INTERVAL,
}: TeamSpotlightOverlayProps) {
  const teamsRef = useRef<Map<string, TeamData>>(new Map());
  const [activeTeam, setActiveTeam] = useState<TeamData | null>(null);
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const activeIdxRef = useRef(0);
  const [fade, setFade] = useState(true);

  const addAction = useCallback((teamName: string, action: TeamAction) => {
    if (!teamsRef.current.has(teamName)) {
      teamsRef.current.set(teamName, {
        name: teamName,
        displayName: formatTeamName(teamName),
        actions: [],
      });
      setTeamNames(Array.from(teamsRef.current.keys()));
    }
    const team = teamsRef.current.get(teamName)!;
    team.actions = [action, ...team.actions].slice(0, MAX_ACTIONS_PER_TEAM);
  }, []);

  const handleEvent = useCallback(
    (event: WebSocketEvent) => {
      const ts = new Date();

      if (event.type === 'decision.executed' || event.type === 'decision.proposed') {
        const d = (event.data as { decision?: Record<string, unknown> })?.decision;
        if (!d) return;
        const creator = d.creator as { full_name?: string } | undefined;
        const teamName =
          (creator?.full_name as string)?.toLowerCase().replace(/[\s.]+/g, '_') ?? 'command';
        addAction(teamName, {
          id: `d-${d.id}`,
          type: 'decision',
          text: (d.title as string) ?? '',
          timestamp: ts,
        });
      }

      if (event.type === 'placement.created') {
        const p = (event.data as { placement?: Record<string, unknown> })?.placement;
        if (!p) return;
        const teamName = (p.team_name as string) ?? 'unknown';
        addAction(teamName, {
          id: `p-${p.id}`,
          type: 'placement',
          text: (p.label as string) ?? (p.asset_type as string)?.replace(/_/g, ' '),
          timestamp: ts,
        });
      }

      if (event.type === 'message.sent') {
        const m = (event.data as { message?: Record<string, unknown> })?.message;
        if (!m || (m.type as string) === 'system') return;
        const sender = m.sender as { full_name?: string } | undefined;
        const name = (sender?.full_name ?? 'unknown').toLowerCase().replace(/[\s.]+/g, '_');
        addAction(name, {
          id: `m-${m.id}`,
          type: 'chat',
          text: (m.content as string)?.slice(0, 150) ?? '',
          timestamp: ts,
        });
      }
    },
    [addAction],
  );

  useWebSocket({
    sessionId,
    onEvent: handleEvent,
    eventTypes: ['decision.executed', 'decision.proposed', 'placement.created', 'message.sent'],
  });

  // Auto-rotate between teams
  useEffect(() => {
    const interval = setInterval(() => {
      const names = Array.from(teamsRef.current.keys());
      if (names.length === 0) return;

      setFade(false);
      setTimeout(() => {
        activeIdxRef.current = (activeIdxRef.current + 1) % names.length;
        const teamName = names[activeIdxRef.current];
        setActiveTeam(teamsRef.current.get(teamName) ?? null);
        setFade(true);
      }, 300);
    }, rotateIntervalMs);

    return () => clearInterval(interval);
  }, [rotateIntervalMs]);

  if (!activeTeam) {
    return (
      <div className="absolute bottom-16 left-4 z-[1000]">
        <div className="px-4 py-3 bg-robotic-gray-300/90 backdrop-blur-md border border-robotic-yellow/30 rounded-lg">
          <span className="text-xs terminal-text text-robotic-yellow/50 animate-pulse">
            Waiting for team activity...
          </span>
        </div>
      </div>
    );
  }

  const color = getTeamColor(activeTeam.name);
  const typeIcons: Record<string, string> = {
    decision: '⚡',
    placement: '📍',
    chat: '📻',
  };

  return (
    <div
      className="absolute bottom-16 left-4 z-[1000] w-96 transition-opacity duration-300"
      style={{ opacity: fade ? 1 : 0 }}
    >
      <div
        className="bg-robotic-gray-300/95 backdrop-blur-md border border-robotic-yellow/30 rounded-lg overflow-hidden shadow-2xl"
        style={{ borderTopWidth: 4, borderTopColor: color }}
      >
        {/* Team header */}
        <div
          className="px-4 py-3 flex items-center gap-3"
          style={{ backgroundColor: `${color}15` }}
        >
          <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: color }} />
          <span
            className="text-sm terminal-text font-bold uppercase tracking-wider"
            style={{ color }}
          >
            {activeTeam.displayName}
          </span>
          <span className="ml-auto text-[10px] terminal-text text-robotic-yellow/40 uppercase">
            Team Spotlight
          </span>
        </div>

        {/* Actions list */}
        <div className="px-4 py-2 space-y-1.5 max-h-52 overflow-y-auto">
          {activeTeam.actions.length === 0 ? (
            <p className="text-xs terminal-text text-robotic-yellow/40 py-2 text-center italic">
              No recent activity
            </p>
          ) : (
            activeTeam.actions.map((action) => (
              <div key={action.id} className="flex items-start gap-2 py-1">
                <span className="text-xs mt-0.5 shrink-0">{typeIcons[action.type] ?? '•'}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs terminal-text text-robotic-yellow/80 line-clamp-2">
                    {action.text}
                  </p>
                  <span className="text-[9px] text-robotic-yellow/30">
                    {action.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Team counter */}
        {teamNames.length > 1 && (
          <div className="px-4 py-2 border-t border-robotic-yellow/10 flex items-center gap-1 justify-center">
            {teamNames.map((tn) => (
              <div
                key={tn}
                className="w-1.5 h-1.5 rounded-full transition-colors"
                style={{
                  backgroundColor:
                    tn === activeTeam.name ? getTeamColor(tn) : 'rgba(255,255,255,0.15)',
                }}
                title={formatTeamName(tn)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
