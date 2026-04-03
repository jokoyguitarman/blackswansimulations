import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import type { WebSocketEvent } from '../../lib/websocketClient';
import { api } from '../../lib/api';

interface TeamPursuitMetrics {
  tips_received: number;
  tips_committed: number;
  tips_cautious: number;
  tips_ignored: number;
  true_leads_committed: number;
  false_leads_committed: number;
  true_leads_ignored: number;
  false_leads_avoided: number;
  accuracy_pct: number;
  avg_response_time_sec: number;
  resources_deployed: number;
  containment_actions: number;
  time_wasted_sec: number;
  intel_quality_score: number;
}

interface PursuitMetricsPanelProps {
  sessionId: string;
  currentState: Record<string, unknown>;
}

function accuracyColor(pct: number): string {
  if (pct >= 70) return '#22c55e';
  if (pct >= 40) return '#f59e0b';
  return '#ef4444';
}

function gradeFromAccuracy(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 75) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 40) return 'D';
  return 'F';
}

export function PursuitMetricsPanel({ sessionId, currentState }: PursuitMetricsPanelProps) {
  const [metrics, setMetrics] = useState<Record<string, TeamPursuitMetrics>>({});
  const [collapsed, setCollapsed] = useState(true);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    const pm = currentState?.pursuit_metrics as Record<string, TeamPursuitMetrics> | undefined;
    if (pm && Object.keys(pm).length > 0) {
      setMetrics(pm);
      setHasData(true);
    }
  }, [currentState]);

  const handleEvent = useCallback((event: WebSocketEvent) => {
    if (event.type === 'pursuit_metrics.updated') {
      const pm = (event.data as { pursuit_metrics?: Record<string, TeamPursuitMetrics> })
        ?.pursuit_metrics;
      if (pm) {
        setMetrics(pm);
        setHasData(true);
      }
    }
  }, []);

  useWebSocket({
    sessionId,
    eventTypes: ['pursuit_metrics.updated'],
    onEvent: handleEvent,
    enabled: true,
  });

  // Also try loading from pursuit-timeline on mount
  useEffect(() => {
    if (hasData) return;
    const load = async () => {
      try {
        const result = await api.sessions.pursuitTimeline(sessionId);
        const responses = (result.responses as Array<Record<string, unknown>>) || [];
        if (responses.length === 0) return;
        setHasData(true);
      } catch {
        // Non-pursuit scenario — no data
      }
    };
    load();
  }, [sessionId, hasData]);

  if (!hasData || Object.keys(metrics).length === 0) return null;

  const teamNames = Object.keys(metrics);

  return (
    <div className="absolute bottom-[100px] right-4 z-[1000] w-80">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-900/95 border border-purple-500/40 rounded-t text-xs terminal-text text-purple-300 hover:bg-gray-800/95 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
          PURSUIT METRICS
          <span className="text-purple-400/60">
            ({teamNames.length} team{teamNames.length !== 1 ? 's' : ''})
          </span>
        </span>
        <span className="text-purple-400/60">{collapsed ? '▲' : '▼'}</span>
      </button>

      {!collapsed && (
        <div className="bg-gray-900/95 border border-t-0 border-purple-500/40 rounded-b p-3 max-h-96 overflow-y-auto space-y-4">
          {teamNames.map((teamName) => {
            const m = metrics[teamName];
            const grade = gradeFromAccuracy(m.accuracy_pct);
            const color = accuracyColor(m.accuracy_pct);

            return (
              <div key={teamName} className="border border-purple-500/20 rounded p-3 bg-black/30">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs terminal-text text-purple-300 uppercase font-bold">
                    {teamName.replace(/_/g, ' ')}
                  </span>
                  <span
                    className="text-lg font-black font-mono px-2 rounded"
                    style={{ color, backgroundColor: color + '15' }}
                  >
                    {grade}
                  </span>
                </div>

                {/* Accuracy gauge */}
                <div className="mb-3">
                  <div className="flex justify-between text-[10px] text-purple-300/60 mb-1">
                    <span>Accuracy</span>
                    <span style={{ color }}>{m.accuracy_pct}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${m.accuracy_pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>

                {/* Counters grid */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-gray-800/60 rounded p-1.5">
                    <div className="text-sm font-bold text-purple-300 font-mono">
                      {m.tips_received}
                    </div>
                    <div className="text-[8px] text-purple-300/50 uppercase">Tips</div>
                  </div>
                  <div className="bg-gray-800/60 rounded p-1.5">
                    <div className="text-sm font-bold text-green-400 font-mono">
                      {m.tips_committed}
                    </div>
                    <div className="text-[8px] text-purple-300/50 uppercase">Commits</div>
                  </div>
                  <div className="bg-gray-800/60 rounded p-1.5">
                    <div className="text-sm font-bold text-red-400 font-mono">{m.tips_ignored}</div>
                    <div className="text-[8px] text-purple-300/50 uppercase">Ignored</div>
                  </div>
                </div>

                {/* Detail rows */}
                <div className="mt-2 space-y-1 text-[10px] font-mono">
                  <div className="flex justify-between text-purple-300/60">
                    <span>False leads committed</span>
                    <span className="text-red-400">{m.false_leads_committed}</span>
                  </div>
                  <div className="flex justify-between text-purple-300/60">
                    <span>False leads avoided</span>
                    <span className="text-green-400">{m.false_leads_avoided}</span>
                  </div>
                  <div className="flex justify-between text-purple-300/60">
                    <span>Missed leads</span>
                    <span className="text-red-400">{m.true_leads_ignored}</span>
                  </div>
                  <div className="flex justify-between text-purple-300/60">
                    <span>Avg response</span>
                    <span className="text-purple-300">{m.avg_response_time_sec}s</span>
                  </div>
                  <div className="flex justify-between text-purple-300/60">
                    <span>Time wasted</span>
                    <span className="text-red-400">
                      {m.time_wasted_sec > 0 ? `${Math.round(m.time_wasted_sec / 60)}m` : '0m'}
                    </span>
                  </div>
                  <div className="flex justify-between text-purple-300/60">
                    <span>Resources deployed</span>
                    <span className="text-purple-300">{m.resources_deployed}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
