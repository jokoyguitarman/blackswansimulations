import { useState, useEffect } from 'react';
import { api } from '../../lib/api';

interface Decision {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  executed_at?: string | null;
  created_at: string;
  proposed_by?: string;
}

interface ImpactMatrixRow {
  id: string;
  evaluated_at: string;
  robustness_by_decision: Record<string, number>;
  analysis?: {
    robustness_reasoning_by_decision?: Record<string, string>;
  };
}

interface Participant {
  user_id: string;
  user?: { full_name?: string } | null;
}

interface DecisionsAIRatingsPanelData {
  decisions: Decision[];
  impact_matrices: ImpactMatrixRow[];
  participants: Participant[];
}

interface DecisionsAIRatingsPanelProps {
  sessionId: string;
}

export const DecisionsAIRatingsPanel = ({ sessionId }: DecisionsAIRatingsPanelProps) => {
  const [data, setData] = useState<DecisionsAIRatingsPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = async () => {
      try {
        const result = await api.aar.get(sessionId);
        const d = result.data as {
          decisions?: Decision[];
          impact_matrices?: ImpactMatrixRow[];
          participants?: Participant[];
        };
        setData({
          decisions: d.decisions || [],
          impact_matrices: d.impact_matrices || [],
          participants: d.participants || [],
        });
      } catch (err) {
        console.error('Failed to load decisions and AI ratings:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_DECISIONS_AND_RATINGS]
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-robotic-yellow/50">
          [ERROR] Failed to load decisions and AI ratings
        </p>
      </div>
    );
  }

  const { decisions, impact_matrices, participants } = data;

  // Build name map: user_id -> full_name
  const nameByUserId: Record<string, string> = {};
  for (const p of participants) {
    const name = (p.user as { full_name?: string } | null)?.full_name;
    if (p.user_id && name) nameByUserId[p.user_id] = name;
  }

  // Build robustness and reasoning from latest impact matrix
  const robustnessByDecisionId: Record<string, number> = {};
  const reasoningByDecisionId: Record<string, string> = {};
  for (let i = impact_matrices.length - 1; i >= 0; i--) {
    const m = impact_matrices[i];
    const rb = m.robustness_by_decision || {};
    const reasoning = m.analysis?.robustness_reasoning_by_decision || {};
    for (const [decId, score] of Object.entries(rb)) {
      if (robustnessByDecisionId[decId] === undefined) robustnessByDecisionId[decId] = score;
    }
    for (const [decId, text] of Object.entries(reasoning)) {
      if (reasoningByDecisionId[decId] === undefined && text) reasoningByDecisionId[decId] = text;
    }
  }

  const decisionsSorted = [...decisions].sort(
    (a, b) =>
      new Date(a.executed_at || a.created_at).getTime() -
      new Date(b.executed_at || b.created_at).getTime(),
  );

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
        [DECISIONS_AND_SCORING_HISTORY] ({decisionsSorted.length})
      </h4>
      <div className="space-y-2">
        {decisionsSorted.length === 0 ? (
          <p className="text-robotic-yellow/70 text-sm">No decisions in this session.</p>
        ) : (
          decisionsSorted.map((d) => {
            const robustness = robustnessByDecisionId[d.id];
            const reasoning = reasoningByDecisionId[d.id];
            const deciderName = d.proposed_by ? (nameByUserId[d.proposed_by] ?? 'Unknown') : '—';
            const executedAt = d.executed_at
              ? new Date(d.executed_at).toLocaleString()
              : new Date(d.created_at).toLocaleString();
            const isExpanded = expandedIds.has(d.id);

            return (
              <div
                key={d.id}
                className="border border-robotic-yellow/30 bg-robotic-gray-300/80 font-mono text-xs cursor-pointer hover:border-robotic-yellow/50 transition-colors"
                role="button"
                tabIndex={0}
                onClick={() => toggleExpanded(d.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleExpanded(d.id);
                  }
                }}
                aria-expanded={isExpanded}
              >
                <div className="p-3">
                  <div className="text-robotic-green font-semibold">{d.title}</div>
                  <div className="text-robotic-yellow/70 mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
                    <span className="text-robotic-yellow/50">Decider:</span>
                    <span>{deciderName}</span>
                    <span className="text-robotic-yellow/50">Executed:</span>
                    <span>{executedAt}</span>
                    {robustness !== undefined && (
                      <>
                        <span className="text-robotic-yellow/50">Robustness:</span>
                        <span className="text-robotic-gold">{robustness}/10</span>
                      </>
                    )}
                  </div>
                  {reasoning && (
                    <div
                      className={`mt-2 text-robotic-yellow/80 ${!isExpanded ? 'line-clamp-2' : ''}`}
                    >
                      <span className="text-robotic-yellow/50">Reasoning: </span>
                      {reasoning}
                    </div>
                  )}
                  {isExpanded && d.description && (
                    <div className="mt-2 text-robotic-yellow/70 whitespace-pre-wrap">
                      {d.description}
                    </div>
                  )}
                  <div className="text-robotic-yellow/50 mt-1" aria-hidden>
                    {isExpanded ? '▼' : '▶'}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
