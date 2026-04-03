import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';

interface TeamHeatState {
  heat_percentage?: number;
  mistake_points?: number;
  total_decisions?: number;
}

interface DemoMetricsOverlayProps {
  sessionId: string;
  currentState: Record<string, unknown>;
}

function extractTeamCounters(
  cs: Record<string, unknown>,
): Array<{ teamName: string; counters: Array<{ label: string; value: string; alert?: boolean }> }> {
  const results: Array<{
    teamName: string;
    counters: Array<{ label: string; value: string; alert?: boolean }>;
  }> = [];

  for (const [key, val] of Object.entries(cs)) {
    if (!key.endsWith('_state') || typeof val !== 'object' || val === null) continue;
    if (key === 'heat_meter') continue;

    const state = val as Record<string, unknown>;
    const displayName = key
      .replace(/_state$/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const counters: Array<{ label: string; value: string; alert?: boolean }> = [];

    for (const [k, v] of Object.entries(state)) {
      if (typeof v === 'number') {
        const label = k.replace(/_/g, ' ');
        const alert = k.includes('death') || k.includes('breach') || k.includes('unanswered');
        counters.push({ label, value: String(v), alert: alert && v > 0 });
      } else if (
        typeof v === 'string' &&
        v.length < 30 &&
        !k.includes('label') &&
        !k.includes('reason')
      ) {
        counters.push({ label: k.replace(/_/g, ' '), value: v });
      }
    }

    if (counters.length > 0) {
      results.push({ teamName: displayName, counters: counters.slice(0, 6) });
    }
  }

  return results;
}

export function DemoMetricsOverlay({ sessionId, currentState }: DemoMetricsOverlayProps) {
  const [state, setState] = useState<Record<string, unknown>>(currentState);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setState(currentState);
  }, [currentState]);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    if (event.type === 'state.updated') {
      const payload = event.data as { state?: Record<string, unknown> };
      const stateData = payload.state;
      if (stateData && typeof stateData === 'object') {
        setState((prev) => ({ ...prev, ...stateData }));
      }
    }
  }, []);

  useWebSocket({
    sessionId,
    eventTypes: ['state.updated'],
    onEvent: handleEvent,
  });

  const heatMeter = (state.heat_meter ?? {}) as Record<string, TeamHeatState>;
  const heatTeams = Object.entries(heatMeter).filter(([, v]) => v?.heat_percentage !== undefined);
  const teamCounters = extractTeamCounters(state);

  return (
    <div className="absolute top-16 left-4 z-[999] flex flex-col gap-1.5 w-[200px] max-h-[calc(100vh-160px)] overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="self-start px-2 py-1 text-[10px] terminal-text uppercase tracking-wider bg-robotic-gray-300/90 border border-robotic-yellow/40 rounded backdrop-blur-sm text-robotic-yellow/70 hover:text-robotic-yellow"
      >
        {collapsed ? '▶ METRICS' : '▼ METRICS'}
      </button>

      {!collapsed && (
        <>
          {/* Heat Meter */}
          <div className="bg-robotic-gray-300/90 border border-robotic-yellow/30 rounded p-2.5 backdrop-blur-sm">
            <div className="text-[10px] terminal-text uppercase text-robotic-yellow/60 mb-1.5 tracking-wider">
              HEAT METER
            </div>
            {heatTeams.length === 0 ? (
              <div className="text-[10px] terminal-text text-robotic-yellow/30 italic">
                Awaiting first decisions...
              </div>
            ) : (
              <div className="space-y-1.5">
                {heatTeams.map(([name, data]) => {
                  const pct = data.heat_percentage ?? 0;
                  const barColor =
                    pct >= 60
                      ? 'bg-red-500'
                      : pct >= 40
                        ? 'bg-orange-500'
                        : pct >= 20
                          ? 'bg-yellow-500'
                          : 'bg-green-500';
                  const textColor =
                    pct >= 60
                      ? 'text-red-400'
                      : pct >= 40
                        ? 'text-orange-400'
                        : pct >= 20
                          ? 'text-yellow-400'
                          : 'text-green-400';
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <span className="text-[10px] terminal-text text-robotic-yellow/60 uppercase w-16 shrink-0 truncate">
                        {name}
                      </span>
                      <div className="flex-1 h-2 bg-robotic-gray-100 rounded-sm overflow-hidden">
                        <div
                          className={`h-full ${barColor} transition-all duration-700`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <span
                        className={`text-[10px] terminal-text font-mono font-bold w-8 text-right ${textColor}`}
                      >
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Team Counters */}
          {teamCounters.length === 0 ? (
            <div className="bg-robotic-gray-300/90 border border-robotic-yellow/30 rounded p-2.5 backdrop-blur-sm">
              <div className="text-[10px] terminal-text uppercase text-robotic-yellow/60 mb-1 tracking-wider">
                COUNTERS
              </div>
              <div className="space-y-0.5">
                <div className="flex justify-between text-[11px] terminal-text text-robotic-gray-50/80">
                  <span>debris cleared</span>
                  <span className="font-mono">0</span>
                </div>
                <div className="flex justify-between text-[11px] terminal-text text-robotic-gray-50/80">
                  <span>fires resolved</span>
                  <span className="font-mono">0</span>
                </div>
                <div className="flex justify-between text-[11px] terminal-text text-robotic-gray-50/80">
                  <span>fires contained</span>
                  <span className="font-mono">0</span>
                </div>
                <div className="flex justify-between text-[11px] terminal-text text-robotic-gray-50/80">
                  <span>extracted to warm</span>
                  <span className="font-mono">0</span>
                </div>
                <div className="flex justify-between text-[11px] terminal-text text-robotic-gray-50/80">
                  <span>casualties in hot zone</span>
                  <span className="font-mono">0</span>
                </div>
              </div>
            </div>
          ) : (
            teamCounters.map(({ teamName, counters }) => (
              <div
                key={teamName}
                className="bg-robotic-gray-300/90 border border-robotic-yellow/30 rounded p-2.5 backdrop-blur-sm"
              >
                <div className="text-[10px] terminal-text uppercase text-robotic-yellow/60 mb-1 tracking-wider">
                  {teamName}
                </div>
                <div className="space-y-0.5">
                  {counters.map(({ label, value, alert }) => (
                    <div
                      key={label}
                      className={`flex justify-between text-[11px] terminal-text ${
                        alert ? 'text-red-400' : 'text-robotic-gray-50/80'
                      }`}
                    >
                      <span className="truncate mr-2">{label}</span>
                      <span className="font-mono shrink-0">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
