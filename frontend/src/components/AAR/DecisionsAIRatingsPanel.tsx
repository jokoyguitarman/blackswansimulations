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
  environmental_consistency?: {
    consistent?: boolean;
    mismatch_kind?: string;
    severity?: string;
    reason?: string;
  } | null;
}

interface ImpactMatrixRow {
  id: string;
  evaluated_at: string;
  matrix: Record<string, Record<string, number>>;
  robustness_by_decision: Record<string, number>;
  analysis?: {
    raw_robustness_by_decision?: Record<string, number>;
    robustness_cap_detail?: Record<
      string,
      { raw: number; capped: number; severity: string; mismatch_kind: string; reason?: string }
    >;
  };
}

interface DecisionsAIRatingsPanelData {
  decisions: Decision[];
  impact_matrices: ImpactMatrixRow[];
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
        };
        setData({
          decisions: d.decisions || [],
          impact_matrices: d.impact_matrices || [],
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

  const { decisions, impact_matrices } = data;

  // Build a map: decision_id -> robustness from latest evaluation that has it
  const robustnessByDecisionId: Record<string, number> = {};
  const capDetailByDecisionId: Record<
    string,
    { raw: number; capped: number; severity: string; mismatch_kind: string; reason?: string }
  > = {};
  for (let i = impact_matrices.length - 1; i >= 0; i--) {
    const rb = impact_matrices[i].robustness_by_decision || {};
    const cap = impact_matrices[i].analysis?.robustness_cap_detail || {};
    for (const [decId, score] of Object.entries(rb)) {
      if (robustnessByDecisionId[decId] === undefined) {
        robustnessByDecisionId[decId] = score;
      }
      if (cap[decId] && capDetailByDecisionId[decId] === undefined) {
        capDetailByDecisionId[decId] = cap[decId];
      }
    }
  }

  const decisionsSorted = [...decisions].sort(
    (a, b) =>
      new Date(a.executed_at || a.created_at).getTime() -
      new Date(b.executed_at || b.created_at).getTime(),
  );

  // Redeeming: decision has high robustness (>=7) and follows a capped decision from same "team" (inferred by sequence)
  const cappedDecisionIds = new Set(Object.keys(capDetailByDecisionId));
  const redeemingIds = new Set<string>();
  for (let i = 0; i < decisionsSorted.length; i++) {
    const d = decisionsSorted[i];
    const robustness = robustnessByDecisionId[d.id];
    if (robustness != null && robustness >= 7 && !cappedDecisionIds.has(d.id)) {
      // Check if prior decision in same sequence was capped
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        if (cappedDecisionIds.has(decisionsSorted[j].id)) {
          redeemingIds.add(d.id);
          break;
        }
      }
    }
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Section 1: All decisions with AI robustness rating */}
      <div>
        <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
          [ALL_DECISIONS] ({decisionsSorted.length})
        </h4>
        <div className="space-y-2">
          {decisionsSorted.length === 0 ? (
            <p className="text-robotic-yellow/70 text-sm">No decisions in this session.</p>
          ) : (
            decisionsSorted.map((d) => {
              const robustness = robustnessByDecisionId[d.id];
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
                  <div className="p-3 flex justify-between items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-robotic-green font-semibold ${!isExpanded ? 'truncate' : ''}`}
                        title={!isExpanded ? d.title : undefined}
                      >
                        {d.title}
                      </div>
                      <div
                        className={`text-robotic-yellow/70 mt-1 whitespace-pre-wrap break-words ${!isExpanded ? 'truncate' : ''}`}
                        title={!isExpanded ? d.description : undefined}
                      >
                        {d.description}
                      </div>
                      <div className="text-robotic-yellow/50 mt-1">
                        Type: {d.type || '—'} | Status: {d.status} |{' '}
                        {d.executed_at
                          ? `Executed: ${new Date(d.executed_at).toLocaleString()}`
                          : `Created: ${new Date(d.created_at).toLocaleString()}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                      {d.environmental_consistency &&
                        d.environmental_consistency.consistent === false && (
                          <span
                            className="px-2 py-0.5 rounded bg-robotic-yellow/30 text-robotic-yellow text-xs"
                            title={d.environmental_consistency.reason}
                          >
                            {d.environmental_consistency.mismatch_kind === 'below_standard'
                              ? 'Below standard'
                              : 'Mismatch'}
                          </span>
                        )}
                      {capDetailByDecisionId[d.id] && (
                        <span
                          className="px-2 py-0.5 rounded bg-robotic-yellow/20 text-robotic-yellow/90 text-xs"
                          title={capDetailByDecisionId[d.id].reason}
                        >
                          Raw: {capDetailByDecisionId[d.id].raw} → Capped:{' '}
                          {capDetailByDecisionId[d.id].capped}
                        </span>
                      )}
                      {redeemingIds.has(d.id) && (
                        <span className="px-2 py-0.5 rounded bg-robotic-green/20 text-robotic-green text-xs">
                          Corrective
                        </span>
                      )}
                      {robustness !== undefined && (
                        <span
                          className="px-2 py-0.5 rounded bg-robotic-gold/20 text-robotic-gold"
                          title="AI robustness score 1–10"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Robustness: {robustness}
                        </span>
                      )}
                      <span className="text-robotic-yellow/70 text-xs" aria-hidden>
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Section 2: Full AI rating output (each impact matrix evaluation) */}
      <div>
        <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
          [COMPLETE_AI_RATINGS] ({impact_matrices.length} evaluations)
        </h4>
        <div className="space-y-3">
          {impact_matrices.length === 0 ? (
            <p className="text-robotic-yellow/70 text-sm">
              No impact matrix evaluations. AI ratings run during active sessions when decisions are
              made.
            </p>
          ) : (
            impact_matrices.map((m, idx) => {
              const rb = m.robustness_by_decision || {};
              const mean =
                Object.keys(rb).length > 0
                  ? Object.values(rb).reduce((a, b) => a + b, 0) / Object.values(rb).length
                  : null;
              const band =
                mean != null ? (mean <= 3 ? 'low' : mean >= 7 ? 'high' : 'medium') : null;
              const prevRb = idx > 0 ? impact_matrices[idx - 1].robustness_by_decision || {} : {};
              const prevMean =
                Object.keys(prevRb).length > 0
                  ? Object.values(prevRb).reduce((a, b) => a + b, 0) / Object.values(prevRb).length
                  : null;
              const prevBand =
                prevMean != null
                  ? prevMean <= 3
                    ? 'low'
                    : prevMean >= 7
                      ? 'high'
                      : 'medium'
                  : null;
              const bandImproved =
                band &&
                prevBand &&
                ((prevBand === 'low' && (band === 'medium' || band === 'high')) ||
                  (prevBand === 'medium' && band === 'high'));
              return (
                <div
                  key={m.id}
                  className="border border-robotic-yellow/30 p-3 bg-robotic-gray-400/50 font-mono text-xs"
                >
                  <div className="text-robotic-yellow/90 mb-2">
                    Evaluation {idx + 1} — {new Date(m.evaluated_at).toLocaleString()}
                    {band && (
                      <span className="ml-2 text-robotic-yellow/70">
                        Band: {band}
                        {bandImproved && (
                          <span className="text-robotic-green/90 ml-1">↑ improved</span>
                        )}
                      </span>
                    )}
                  </div>
                  {m.matrix && Object.keys(m.matrix).length > 0 && (
                    <div className="mb-2">
                      <div className="text-robotic-yellow/80 mb-1">[INTER-TEAM IMPACT -2..+2]</div>
                      <div className="space-y-0.5">
                        {Object.entries(m.matrix).map(([acting, affected]) => (
                          <div key={acting} className="text-robotic-green/90">
                            {acting} →{' '}
                            {Object.entries(affected)
                              .map(([team, score]) => `${team}: ${score}`)
                              .join(', ')}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {m.robustness_by_decision && Object.keys(m.robustness_by_decision).length > 0 && (
                    <div>
                      <div className="text-robotic-yellow/80 mb-1">
                        [PER-DECISION ROBUSTNESS 1–10]
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(m.robustness_by_decision).map(([decId, score]) => {
                          const dec = decisions.find((d) => d.id === decId);
                          const label = dec?.title
                            ? `${dec.title.slice(0, 25)}…`
                            : `${decId.slice(0, 8)}…`;
                          return (
                            <span
                              key={decId}
                              className="bg-robotic-gray-500 px-1.5 py-0.5 rounded text-robotic-gold"
                              title={dec?.title ?? decId}
                            >
                              {label}:{score}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
