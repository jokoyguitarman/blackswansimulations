import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

interface SpatialAARPanelProps {
  sessionId: string;
}

interface PlacementRecord {
  id: string;
  team_name: string;
  asset_type: string;
  label: string;
  geometry: { type: string; coordinates: unknown };
  placement_score: {
    overall?: number;
    dimensions?: Array<{ dimension: string; score: number; reasoning: string }>;
  } | null;
  status: string;
  placed_at: string;
  removed_at: string | null;
}

export const SpatialAARPanel = ({ sessionId }: SpatialAARPanelProps) => {
  const [placements, setPlacements] = useState<PlacementRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.placements
      .list(sessionId)
      .then((res) => {
        if (Array.isArray(res.data)) {
          setPlacements(res.data as unknown as PlacementRecord[]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) {
    return (
      <div className="p-4 text-xs terminal-text text-robotic-yellow/50">
        Loading spatial analysis...
      </div>
    );
  }

  if (!placements.length) {
    return (
      <div className="p-4 text-xs terminal-text text-robotic-yellow/50">
        No placements were made during this session.
      </div>
    );
  }

  // Group by team
  const teamGroups: Record<string, PlacementRecord[]> = {};
  for (const p of placements) {
    if (!teamGroups[p.team_name]) teamGroups[p.team_name] = [];
    teamGroups[p.team_name].push(p);
  }

  // Team averages
  const teamStats = Object.entries(teamGroups).map(([team, records]) => {
    const scored = records.filter((r) => r.placement_score?.overall != null);
    const avg =
      scored.length > 0
        ? scored.reduce((sum, r) => sum + (r.placement_score!.overall ?? 0), 0) / scored.length
        : 0;
    const relocated = records.filter((r) => r.status === 'relocated').length;
    const removed = records.filter((r) => r.status === 'removed').length;

    return { team, total: records.length, avgScore: avg, relocated, removed };
  });

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold terminal-text text-robotic-yellow uppercase">
        Spatial Placement Analysis
      </h3>

      {/* Team Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {teamStats.map((ts) => (
          <div key={ts.team} className="bg-black/50 border border-robotic-yellow/30 rounded p-3">
            <div className="text-xs font-medium terminal-text text-robotic-yellow mb-2">
              {ts.team}
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] terminal-text text-robotic-yellow/70">
              <div>
                <span className="text-robotic-yellow/40">Placements:</span> {ts.total}
              </div>
              <div>
                <span className="text-robotic-yellow/40">Avg Score:</span>{' '}
                <span
                  style={{
                    color:
                      ts.avgScore >= 0.7 ? '#22c55e' : ts.avgScore >= 0.4 ? '#f59e0b' : '#ef4444',
                  }}
                >
                  {Math.round(ts.avgScore * 100)}%
                </span>
              </div>
              <div>
                <span className="text-robotic-yellow/40">Relocated:</span> {ts.relocated}
              </div>
              <div>
                <span className="text-robotic-yellow/40">Removed:</span> {ts.removed}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Placement Timeline */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium terminal-text text-robotic-yellow/70 uppercase">
          Placement Timeline
        </h4>
        <div className="max-h-64 overflow-y-auto space-y-1.5">
          {placements
            .sort((a, b) => new Date(a.placed_at).getTime() - new Date(b.placed_at).getTime())
            .map((p) => {
              const score = p.placement_score?.overall;
              const scoreColor =
                score != null
                  ? score >= 0.7
                    ? '#22c55e'
                    : score >= 0.4
                      ? '#f59e0b'
                      : '#ef4444'
                  : '#6b7280';

              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 px-2 py-1.5 bg-black/30 rounded border border-robotic-yellow/10 text-[10px] terminal-text"
                >
                  <span className="text-robotic-yellow/40 w-16 shrink-0">
                    {new Date(p.placed_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-robotic-yellow/70 w-20 truncate shrink-0">
                    {p.team_name}
                  </span>
                  <span className="text-robotic-yellow flex-1 truncate">{p.label}</span>
                  {score != null && (
                    <span style={{ color: scoreColor }} className="font-medium shrink-0">
                      {Math.round(score * 100)}%
                    </span>
                  )}
                  {p.status !== 'active' && (
                    <span className="text-red-400/60 shrink-0 uppercase">{p.status}</span>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      {/* Dimension Breakdown (worst performers) */}
      <div className="space-y-2">
        <h4 className="text-xs font-medium terminal-text text-robotic-yellow/70 uppercase">
          Key Issues
        </h4>
        <div className="space-y-1">
          {placements
            .filter((p) => p.placement_score?.dimensions?.some((d) => d.score < 0.5))
            .slice(0, 5)
            .map((p) => (
              <div
                key={`issue-${p.id}`}
                className="px-2 py-1.5 bg-red-900/10 border border-red-500/20 rounded text-[10px] terminal-text"
              >
                <span className="text-robotic-yellow">{p.label}</span>
                <span className="text-robotic-yellow/40 mx-1">({p.team_name})</span>
                <div className="mt-0.5 text-red-400/70">
                  {p.placement_score?.dimensions
                    ?.filter((d) => d.score < 0.5)
                    .map((d) => d.reasoning)
                    .join('; ')}
                </div>
              </div>
            ))}
          {!placements.some((p) => p.placement_score?.dimensions?.some((d) => d.score < 0.5)) && (
            <div className="text-[10px] terminal-text text-green-500/70 px-2 py-1">
              No critical spatial issues detected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
