import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface PursuitResponse {
  id: string;
  sighting_pin_id: string;
  inject_id: string | null;
  adversary_id: string;
  team_name: string;
  source_reliability: string;
  info_credibility: string;
  nato_grade: string;
  is_false_lead: boolean;
  response_window_start: string;
  response_window_end: string | null;
  response_type: string;
  decisions_committed: string[];
  assets_deployed: string[];
  score_impact: string | null;
  time_wasted_seconds: number;
  zone_label?: string;
  sighting_order?: number;
  sighting_status?: string;
}

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

interface PursuitTimelineProps {
  sessionId: string;
}

const SCORE_STYLES: Record<string, { label: string; color: string; icon: string }> = {
  good_commit: { label: 'CORRECT', color: '#22c55e', icon: '✓' },
  good_caution: { label: 'GOOD JUDGMENT', color: '#22c55e', icon: '✓' },
  good_recovery: { label: 'RECOVERED', color: '#f59e0b', icon: '~' },
  wasted_resources: { label: 'WASTED', color: '#ef4444', icon: '✗' },
  missed_lead: { label: 'MISSED', color: '#ef4444', icon: '✗' },
};

const RESPONSE_LABELS: Record<string, string> = {
  committed: 'Committed Resources',
  split: 'Split Resources',
  cautious: 'Cautious / Discussed',
  ignored: 'No Response',
  pending: 'Pending',
};

function natoGradeColor(grade: string): string {
  if (/^[AB][12]/.test(grade)) return '#22c55e';
  if (/^[CD][34]/.test(grade)) return '#f59e0b';
  return '#ef4444';
}

function gradeFromAccuracy(pct: number): { grade: string; color: string; label: string } {
  if (pct >= 90) return { grade: 'A', color: '#22c55e', label: 'Excellent' };
  if (pct >= 75) return { grade: 'B', color: '#22c55e', label: 'Good' };
  if (pct >= 60) return { grade: 'C', color: '#f59e0b', label: 'Adequate' };
  if (pct >= 40) return { grade: 'D', color: '#f97316', label: 'Below Standard' };
  return { grade: 'F', color: '#ef4444', label: 'Failing' };
}

export const PursuitTimeline: React.FC<PursuitTimelineProps> = ({ sessionId }) => {
  const [responses, setResponses] = useState<PursuitResponse[]>([]);
  const [investigativeTeams, setInvestigativeTeams] = useState<string[]>([]);
  const [pursuitMetrics, setPursuitMetrics] = useState<Record<string, TeamPursuitMetrics>>({});
  const [loading, setLoading] = useState(true);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await api.sessions.pursuitTimeline(sessionId);
        setResponses((result.responses as PursuitResponse[]) || []);
        setInvestigativeTeams((result.investigative_teams as string[]) || []);
        setPursuitMetrics((result.pursuit_metrics as Record<string, TeamPursuitMetrics>) || {});
      } catch {
        // Pursuit data may not exist for non-pursuit scenarios
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-robotic-yellow/40 font-mono text-sm">
        Loading pursuit intelligence data...
      </div>
    );
  }

  if (responses.length === 0) return null;

  const hasInvestigativeTeams = investigativeTeams.length > 0;
  const uniqueTeams = [...new Set(responses.map((r) => r.team_name))];
  const displayTeams = hasInvestigativeTeams ? investigativeTeams : uniqueTeams;

  const filteredResponses = selectedTeam
    ? responses.filter((r) => r.team_name === selectedTeam)
    : responses;

  // Aggregate stats from filtered responses
  const totalSightings = filteredResponses.length;
  const falseLeads = filteredResponses.filter((r) => r.is_false_lead).length;
  const correctCommits = filteredResponses.filter((r) => r.score_impact === 'good_commit').length;
  const falseCommits = filteredResponses.filter(
    (r) => r.score_impact === 'wasted_resources',
  ).length;
  const goodCaution = filteredResponses.filter((r) => r.score_impact === 'good_caution').length;
  const missedLeads = filteredResponses.filter((r) => r.score_impact === 'missed_lead').length;
  const totalWastedSeconds = filteredResponses.reduce((sum, r) => sum + r.time_wasted_seconds, 0);
  const intelScore = Math.round(
    ((correctCommits + goodCaution) / Math.max(totalSightings, 1)) * 100,
  );

  return (
    <div className="bg-gray-900/80 border border-robotic-yellow/20 rounded-lg p-4 mt-4">
      <h3 className="text-sm font-bold terminal-text text-robotic-yellow tracking-wider mb-3">
        PURSUIT INTELLIGENCE ANALYSIS
      </h3>

      {/* Per-team summary cards (only if investigative teams exist) */}
      {hasInvestigativeTeams && Object.keys(pursuitMetrics).length > 0 && (
        <div className="mb-4 space-y-3">
          <div className="text-[10px] text-purple-300/60 uppercase tracking-wider font-bold mb-2">
            Investigative Team Performance
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {displayTeams.map((teamName) => {
              const m = pursuitMetrics[teamName];
              if (!m) return null;
              const g = gradeFromAccuracy(m.accuracy_pct);
              const isSelected = selectedTeam === teamName;

              return (
                <button
                  key={teamName}
                  onClick={() => setSelectedTeam(isSelected ? null : teamName)}
                  className={`text-left border rounded p-3 transition-all ${
                    isSelected
                      ? 'border-purple-500 bg-purple-500/10'
                      : 'border-purple-500/20 bg-black/30 hover:border-purple-500/40'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs terminal-text text-purple-300 uppercase font-bold">
                      {teamName.replace(/_/g, ' ')}
                    </span>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-2xl font-black font-mono leading-none"
                        style={{ color: g.color }}
                      >
                        {g.grade}
                      </span>
                    </div>
                  </div>

                  <div className="text-[10px] font-mono" style={{ color: g.color }}>
                    {g.label} — {m.accuracy_pct}% accuracy
                  </div>

                  <div className="grid grid-cols-4 gap-1 mt-2">
                    <div className="text-center">
                      <div className="text-xs font-bold text-purple-300 font-mono">
                        {m.tips_received}
                      </div>
                      <div className="text-[7px] text-purple-300/50 uppercase">Tips</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs font-bold text-green-400 font-mono">
                        {m.true_leads_committed}
                      </div>
                      <div className="text-[7px] text-purple-300/50 uppercase">Correct</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs font-bold text-red-400 font-mono">
                        {m.false_leads_committed}
                      </div>
                      <div className="text-[7px] text-purple-300/50 uppercase">Traps</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs font-bold text-red-400 font-mono">
                        {m.time_wasted_sec > 0 ? `${Math.round(m.time_wasted_sec / 60)}m` : '0m'}
                      </div>
                      <div className="text-[7px] text-purple-300/50 uppercase">Wasted</div>
                    </div>
                  </div>

                  <div className="flex gap-3 mt-2 text-[9px] text-purple-300/50 font-mono">
                    <span>Avg resp: {m.avg_response_time_sec}s</span>
                    <span>Deployed: {m.resources_deployed}</span>
                    <span>Missed: {m.true_leads_ignored}</span>
                  </div>

                  {isSelected && (
                    <div className="mt-2 text-[9px] text-purple-400/70 text-center">
                      ▼ Showing timeline for this team
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Team filter tabs (when multiple teams but no investigative breakdown) */}
      {!hasInvestigativeTeams && uniqueTeams.length > 1 && (
        <div className="flex gap-2 mb-3 flex-wrap">
          <button
            onClick={() => setSelectedTeam(null)}
            className={`px-2 py-1 text-[10px] terminal-text uppercase rounded border transition-all ${
              !selectedTeam
                ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                : 'border-robotic-yellow/30 text-robotic-yellow/50 hover:border-robotic-yellow/50'
            }`}
          >
            All Teams
          </button>
          {uniqueTeams.map((t) => (
            <button
              key={t}
              onClick={() => setSelectedTeam(selectedTeam === t ? null : t)}
              className={`px-2 py-1 text-[10px] terminal-text uppercase rounded border transition-all ${
                selectedTeam === t
                  ? 'border-robotic-yellow bg-robotic-yellow/10 text-robotic-yellow'
                  : 'border-robotic-yellow/30 text-robotic-yellow/50 hover:border-robotic-yellow/50'
              }`}
            >
              {t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-800/60 rounded p-2 text-center">
          <div className="text-lg font-bold text-robotic-yellow font-mono">{totalSightings}</div>
          <div className="text-[10px] text-robotic-yellow/50 uppercase">Total Sightings</div>
        </div>
        <div className="bg-gray-800/60 rounded p-2 text-center">
          <div className="text-lg font-bold text-amber-400 font-mono">{falseLeads}</div>
          <div className="text-[10px] text-robotic-yellow/50 uppercase">False Leads</div>
        </div>
        <div className="bg-gray-800/60 rounded p-2 text-center">
          <div
            className="text-lg font-bold font-mono"
            style={{
              color: intelScore >= 70 ? '#22c55e' : intelScore >= 40 ? '#f59e0b' : '#ef4444',
            }}
          >
            {intelScore}%
          </div>
          <div className="text-[10px] text-robotic-yellow/50 uppercase">Intel Score</div>
        </div>
        <div className="bg-gray-800/60 rounded p-2 text-center">
          <div className="text-lg font-bold text-red-400 font-mono">
            {totalWastedSeconds > 0 ? `${Math.round(totalWastedSeconds / 60)}m` : '0m'}
          </div>
          <div className="text-[10px] text-robotic-yellow/50 uppercase">Time Wasted</div>
        </div>
      </div>

      {/* Detailed Breakdown */}
      <div className="flex gap-4 mb-4 text-[10px] text-robotic-yellow/60 font-mono flex-wrap">
        <span>
          Correct Commits: <b className="text-green-400">{correctCommits}</b>
        </span>
        <span>
          False Commits: <b className="text-red-400">{falseCommits}</b>
        </span>
        <span>
          Good Caution: <b className="text-green-400">{goodCaution}</b>
        </span>
        <span>
          Missed Leads: <b className="text-red-400">{missedLeads}</b>
        </span>
      </div>

      {/* Timeline */}
      <div className="relative">
        <div className="absolute left-4 top-0 bottom-0 w-px bg-robotic-yellow/20" />

        {filteredResponses.map((r, idx) => {
          const scoreStyle = r.score_impact ? SCORE_STYLES[r.score_impact] : null;
          const gradeColor = natoGradeColor(r.nato_grade);
          const windowStart = new Date(r.response_window_start);
          const minutesMark = Math.round(
            (windowStart.getTime() -
              new Date(filteredResponses[0]?.response_window_start || '').getTime()) /
              60000,
          );
          const isInvestigative = investigativeTeams.includes(r.team_name);

          return (
            <div key={r.id} className="relative pl-10 pb-4">
              {/* Node dot */}
              <div
                className="absolute left-2.5 top-1 w-3 h-3 rounded-full border-2"
                style={{
                  borderColor: r.is_false_lead ? '#ef4444' : '#22c55e',
                  backgroundColor:
                    r.sighting_status === 'debunked'
                      ? '#ef4444'
                      : r.is_false_lead
                        ? '#374151'
                        : '#22c55e',
                }}
              />

              <div className="bg-gray-800/40 rounded border border-gray-700/50 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* NATO Grade */}
                  <span
                    className="px-1.5 py-0.5 text-[10px] font-black rounded font-mono"
                    style={{
                      backgroundColor: gradeColor + '22',
                      color: gradeColor,
                      border: `1px solid ${gradeColor}44`,
                    }}
                  >
                    {r.nato_grade}
                  </span>

                  {/* Time */}
                  <span className="text-[10px] text-robotic-yellow/50 font-mono">
                    T+{minutesMark}min
                  </span>

                  {/* Truth tag */}
                  <span
                    className="px-1 py-0.5 text-[9px] font-bold rounded"
                    style={{
                      backgroundColor: r.is_false_lead ? '#ef444422' : '#22c55e22',
                      color: r.is_false_lead ? '#ef4444' : '#22c55e',
                    }}
                  >
                    {r.is_false_lead ? 'FALSE' : 'TRUE'}
                  </span>

                  {/* Debunked */}
                  {r.sighting_status === 'debunked' && (
                    <span className="px-1 py-0.5 text-[9px] font-bold rounded bg-red-900/30 text-red-400 line-through">
                      DEBUNKED
                    </span>
                  )}

                  {/* Team name + investigative badge */}
                  {!selectedTeam && (
                    <span className="flex items-center gap-1 ml-auto">
                      <span className="text-[10px] text-robotic-yellow/40 font-mono">
                        {r.team_name.replace(/_/g, ' ')}
                      </span>
                      {isInvestigative && (
                        <span className="px-1 py-0.5 text-[8px] font-bold rounded border border-purple-500/40 bg-purple-500/15 text-purple-300">
                          INV
                        </span>
                      )}
                    </span>
                  )}

                  {/* Sighting # */}
                  {selectedTeam && (
                    <span className="text-[10px] text-robotic-yellow/40 font-mono ml-auto">
                      Sighting #{idx + 1}
                    </span>
                  )}
                </div>

                {/* Zone */}
                {r.zone_label && (
                  <div className="text-xs text-robotic-yellow/70 mt-1">{r.zone_label}</div>
                )}

                {/* Response */}
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[10px] text-robotic-yellow/50">Team response:</span>
                  <span className="text-[10px] font-bold text-robotic-yellow/80">
                    {RESPONSE_LABELS[r.response_type] || r.response_type}
                  </span>
                  {r.decisions_committed?.length > 0 && (
                    <span className="text-[9px] text-robotic-yellow/40">
                      ({r.decisions_committed.length} decision
                      {r.decisions_committed.length > 1 ? 's' : ''})
                    </span>
                  )}
                </div>

                {/* Score */}
                {scoreStyle && (
                  <div
                    className="flex items-center gap-1 mt-1.5 text-[10px] font-bold"
                    style={{ color: scoreStyle.color }}
                  >
                    <span>{scoreStyle.icon}</span>
                    <span>{scoreStyle.label}</span>
                    {r.time_wasted_seconds > 0 && (
                      <span className="text-red-400/60 ml-1">
                        ({Math.round(r.time_wasted_seconds / 60)}m wasted)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
