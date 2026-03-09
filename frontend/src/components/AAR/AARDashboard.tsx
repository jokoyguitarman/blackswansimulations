import { useState, useEffect } from 'react';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { api } from '../../lib/api';

const AAR_SECTION_KEYS = [
  'executive',
  'decisions',
  'matrices',
  'injects_published',
  'injects_cancelled',
  'coordination',
  'escalation',
  'incident_response',
  'insider_usage',
  'team_metrics',
  'resource_requests',
  'pathway_outcomes',
  'information_analysis',
  'recommendations',
] as const;

const AAR_SECTION_LABELS: Record<(typeof AAR_SECTION_KEYS)[number], string> = {
  executive: 'Executive overview',
  decisions: 'Decisions and scoring history',
  matrices: 'Impact matrices',
  injects_published: 'Injects published',
  injects_cancelled: 'Injects cancelled',
  coordination: 'Coordination and communication',
  escalation: 'Escalation factors and pathways',
  incident_response: 'Incident–Response pairs',
  insider_usage: 'Insider information usage',
  team_metrics: 'Team metrics over time',
  resource_requests: 'Resource requests and transfers',
  pathway_outcomes: 'Pathway outcomes',
  information_analysis: 'Information-sharing analysis',
  recommendations: 'Key takeaways and recommendations',
};

interface AARData {
  aar: {
    id: string;
    summary: string;
    key_metrics?: Record<string, unknown>;
    key_decisions: unknown[];
    timeline_summary: unknown[];
    recommendations: string[];
    ai_insights?: Array<Record<string, unknown>>;
    generated_at: string;
    report_format?: string;
    sections?: Record<string, { data: unknown; analysis: string | null }>;
  } | null;
  scores: Array<{
    user_id: string;
    role: string;
    decisions_proposed: number;
    communications_sent: number;
    avg_response_time_minutes: number;
    coordination_score: number;
    leadership_score: number;
    participant?: {
      full_name: string;
      role: string;
    };
  }>;
  metrics?: Array<{
    metric_type: string;
    metric_name: string;
    metric_value: Record<string, unknown>;
  }>;
  events: unknown[];
  decisions: unknown[];
  session: {
    id: string;
    status: string;
    start_time: string | null;
    end_time: string | null;
  };
}

interface AARDashboardProps {
  sessionId: string;
}

function AARSectionView({
  aar,
}: {
  aar: {
    summary: string;
    generated_at: string;
    sections?: Record<string, { data: unknown; analysis: string | null }>;
  };
}) {
  const sections = aar.sections ?? {};
  return (
    <div className="military-border p-6 space-y-8">
      <div className="text-xs terminal-text text-robotic-yellow/50 mb-4">
        Generated: {new Date(aar.generated_at).toLocaleString()} (section-based report)
      </div>
      {AAR_SECTION_KEYS.map((key) => {
        const entry = sections[key];
        if (!entry) return null;
        const data = entry.data;
        const analysis = entry.analysis;
        const label = AAR_SECTION_LABELS[key];
        return (
          <div key={key} className="space-y-2">
            <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase border-b border-robotic-yellow/30 pb-1">
              {label}
            </h4>
            {data != null && (
              <div className="military-border p-4 bg-black/20">
                <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-2">
                  Data
                </div>
                <SectionDataDisplay keyName={key} data={data} />
              </div>
            )}
            <div className="military-border p-4">
              <div className="text-xs terminal-text text-robotic-green/70 uppercase mb-2">
                Analysis
              </div>
              {analysis ? (
                <p className="text-sm terminal-text whitespace-pre-wrap">{analysis}</p>
              ) : (
                <p className="text-xs terminal-text text-robotic-yellow/50">
                  Analysis not available.
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Format a value for table cell: avoid raw JSON; use key-value or comma list. */
function formatCellValue(value: unknown): React.ReactNode {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    const first = value[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      return <span className="text-robotic-yellow/70">[{value.length} items]</span>;
    }
    return value.map((v) => String(v)).join(', ');
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length <= 3) {
    return entries
      .map(([k, v]) => `${k}: ${v == null || typeof v !== 'object' ? v : '[object]'}`)
      .join('; ');
  }
  return (
    <span className="text-robotic-yellow/70">
      {entries
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${v == null || typeof v !== 'object' ? v : '…'}`)
        .join('; ')}
      …
    </span>
  );
}

/** Key-value table for a plain object. */
function KeyValueTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs terminal-text">
        <thead>
          <tr className="text-robotic-yellow/70 border-b border-robotic-yellow/30">
            <th className="text-left py-1 pr-2">Key</th>
            <th className="text-left py-1 pr-2">Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-robotic-yellow/10">
              <td className="py-1 pr-2 font-medium">{k}</td>
              <td className="py-1 pr-2 max-w-[300px] break-words">
                {v != null && typeof v === 'object' && !Array.isArray(v)
                  ? (formatCellValue(v) ?? JSON.stringify(v).slice(0, 200))
                  : String(v ?? '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionDataDisplay({ keyName, data }: { keyName: string; data: unknown }) {
  if (data == null) return null;
  if (Array.isArray(data)) {
    if (data.length === 0)
      return <p className="text-xs terminal-text text-robotic-yellow/50">No entries.</p>;
    const first = data[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      const keys = Object.keys(first as Record<string, unknown>);
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs terminal-text">
            <thead>
              <tr className="text-robotic-yellow/70 border-b border-robotic-yellow/30">
                {keys.map((k) => (
                  <th key={k} className="text-left py-1 pr-2">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.slice(0, 30).map((row, i) => (
                <tr key={i} className="border-b border-robotic-yellow/10">
                  {keys.map((k) => (
                    <td key={k} className="py-1 pr-2 max-w-[200px]">
                      {formatCellValue((row as Record<string, unknown>)[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > 30 && (
            <p className="text-xs terminal-text text-robotic-yellow/50 mt-1">
              … and {data.length - 30} more
            </p>
          )}
        </div>
      );
    }
  }
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (keyName === 'decisions' && obj.decisions && Array.isArray(obj.decisions)) {
      return <SectionDataDisplay keyName="decisions_list" data={obj.decisions} />;
    }
    if (
      keyName === 'coordination' &&
      obj.participantSummary &&
      Array.isArray(obj.participantSummary)
    ) {
      return (
        <div className="space-y-4">
          {obj.communication != null &&
          typeof obj.communication === 'object' &&
          !Array.isArray(obj.communication) ? (
            <div>
              <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
                Communication
              </div>
              <KeyValueTable data={obj.communication as Record<string, unknown>} />
            </div>
          ) : null}
          <div>
            <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">
              Participants
            </div>
            <SectionDataDisplay keyName="participants" data={obj.participantSummary} />
          </div>
        </div>
      );
    }
    // Generic object: array-valued keys as tables, else key-value table
    const objKeys = Object.keys(obj);
    const arrayOfObjectsKeys = objKeys.filter((k) => {
      const v = obj[k];
      return (
        Array.isArray(v) &&
        v.length > 0 &&
        typeof v[0] === 'object' &&
        v[0] !== null &&
        !Array.isArray(v[0])
      );
    });
    if (arrayOfObjectsKeys.length > 0) {
      return (
        <div className="space-y-4">
          {arrayOfObjectsKeys.map((k) => (
            <div key={k}>
              <div className="text-xs terminal-text text-robotic-yellow/50 uppercase mb-1">{k}</div>
              <SectionDataDisplay keyName={k} data={obj[k]} />
            </div>
          ))}
          {objKeys.filter((k) => !arrayOfObjectsKeys.includes(k)).length > 0 ? (
            <KeyValueTable
              data={Object.fromEntries(
                objKeys.filter((k) => !arrayOfObjectsKeys.includes(k)).map((k) => [k, obj[k]]),
              )}
            />
          ) : null}
        </div>
      );
    }
    return <KeyValueTable data={obj} />;
  }
  return <span className="text-xs terminal-text">{String(data)}</span>;
}

export const AARDashboard = ({ sessionId }: AARDashboardProps) => {
  const { isTrainer } = useRoleVisibility();
  const [aarData, setAarData] = useState<AARData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => {
    loadAAR();
  }, [sessionId]);

  const loadAAR = async () => {
    try {
      const result = await api.aar.get(sessionId);
      setAarData(result.data as AARData);
    } catch (error) {
      console.error('Failed to load AAR:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!confirm('Generate AAR report? This will overwrite any existing report.')) return;

    setGenerating(true);
    try {
      await api.aar.generate(sessionId);
      await loadAAR();
    } catch (error) {
      console.error('Failed to generate AAR:', error);
      alert('Failed to generate AAR report');
    } finally {
      setGenerating(false);
    }
  };

  const handleExport = async (format: 'pdf' | 'excel') => {
    setExporting(format);
    try {
      const result = await api.aar.export(sessionId, format);
      window.open(result.data.url, '_blank');
    } catch (error) {
      console.error(`Failed to export AAR as ${format}:`, error);
      alert(
        `Failed to export AAR as ${format}. Export functionality may not be fully implemented yet.`,
      );
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-robotic-yellow/50 animate-pulse">
            [LOADING_AAR]
          </div>
        </div>
      </div>
    );
  }

  if (!aarData) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-robotic-yellow/50">
          [ERROR] Failed to load AAR data
        </p>
      </div>
    );
  }

  const canGenerate = isTrainer && aarData.session.status === 'completed';
  const metrics = aarData.aar?.key_metrics as Record<string, unknown> | undefined;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="military-border p-4 flex justify-between items-center">
        <h3 className="text-lg terminal-text uppercase">[AAR] After-Action Review</h3>
        <div className="flex gap-2">
          {canGenerate && aarData.aar && (
            <>
              <button
                onClick={() => handleExport('excel')}
                disabled={exporting !== null}
                className="military-button px-4 py-2 text-sm disabled:opacity-50"
              >
                {exporting === 'excel' ? '[EXPORTING...]' : '[EXPORT_EXCEL]'}
              </button>
              <button
                onClick={() => handleExport('pdf')}
                disabled={exporting !== null}
                className="military-button px-4 py-2 text-sm disabled:opacity-50"
              >
                {exporting === 'pdf' ? '[EXPORTING...]' : '[EXPORT_PDF]'}
              </button>
            </>
          )}
          {canGenerate && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="military-button px-4 py-2 text-sm disabled:opacity-50"
            >
              {generating ? '[GENERATING...]' : '[GENERATE_AAR]'}
            </button>
          )}
        </div>
      </div>

      {/* AAR Report */}
      {aarData.aar ? (
        aarData.aar.sections != null && aarData.aar.report_format === 'sections' ? (
          <AARSectionView aar={aarData.aar} />
        ) : (
          <div className="military-border p-6 space-y-6">
            <div>
              <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                [SUMMARY]
              </h4>
              <p className="text-sm terminal-text whitespace-pre-wrap">{aarData.aar.summary}</p>
            </div>

            {/* Key Metrics */}
            {metrics && (
              <div>
                <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-4">
                  [KEY_METRICS]
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {metrics.decision_latency ? (
                    <div className="military-border p-4">
                      <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                        [DECISION_LATENCY]
                      </div>
                      <div className="text-sm terminal-text">
                        Avg:{' '}
                        {(
                          (metrics.decision_latency as { avg_minutes?: number }).avg_minutes || 0
                        ).toFixed(1)}{' '}
                        min
                      </div>
                    </div>
                  ) : null}
                  {metrics.coordination ? (
                    <div className="military-border p-4">
                      <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                        [COORDINATION_SCORE]
                      </div>
                      <div className="text-sm terminal-text">
                        {(metrics.coordination as { overall_score?: number }).overall_score || 0}
                        /100
                      </div>
                    </div>
                  ) : null}
                  {metrics.compliance ? (
                    <div className="military-border p-4">
                      <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                        [COMPLIANCE_RATE]
                      </div>
                      <div className="text-sm terminal-text">
                        {((metrics.compliance as { rate?: number }).rate || 0).toFixed(1)}%
                      </div>
                    </div>
                  ) : null}
                  {metrics.objectives ? (
                    <div className="military-border p-4">
                      <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                        [OBJECTIVES_SCORE]
                      </div>
                      <div className="text-sm terminal-text">
                        {(metrics.objectives as { overall_score?: number }).overall_score || 0}/100
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {/* AI Insights */}
            {aarData.aar.ai_insights && aarData.aar.ai_insights.length > 0 && (
              <div>
                <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                  [AI_INSIGHTS]
                </h4>
                <div className="space-y-2">
                  {aarData.aar.ai_insights.map(
                    (insight: { type?: string; content?: string }, idx) => (
                      <div key={idx} className="military-border p-3">
                        <div className="text-xs terminal-text text-robotic-green mb-1">
                          [{insight.type || 'INSIGHT'}]
                        </div>
                        <p className="text-sm terminal-text">{insight.content || ''}</p>
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}

            {aarData.aar.key_decisions.length > 0 && (
              <div>
                <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                  [KEY_DECISIONS]
                </h4>
                <div className="space-y-2">
                  {aarData.aar.key_decisions.slice(0, 10).map((decision: unknown, idx: number) => {
                    const d = decision as { title?: string; type?: string; status?: string };
                    return (
                      <div key={idx} className="military-border p-3">
                        <div className="text-sm terminal-text font-semibold mb-1">
                          {d.title || 'Untitled Decision'}
                        </div>
                        <div className="text-xs terminal-text text-robotic-yellow/70">
                          Type: {d.type || 'Unknown'} | Status: {d.status || 'Unknown'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {aarData.aar.recommendations.length > 0 && (
              <div>
                <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-2">
                  [RECOMMENDATIONS]
                </h4>
                <ul className="list-disc list-inside space-y-1">
                  {aarData.aar.recommendations.map((rec, idx) => (
                    <li key={idx} className="text-sm terminal-text">
                      {rec}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-xs terminal-text text-robotic-yellow/50">
              Generated: {new Date(aarData.aar.generated_at).toLocaleString()}
            </div>
          </div>
        )
      ) : (
        <div className="military-border p-8 text-center">
          <p className="text-sm terminal-text text-robotic-yellow/50 mb-4">
            [NO_AAR] No AAR report available
          </p>
          {canGenerate && (
            <p className="text-xs terminal-text text-robotic-yellow/30">
              Generate an AAR report to review session performance
            </p>
          )}
        </div>
      )}

      {/* Participant Scores */}
      {aarData.scores.length > 0 && (
        <div className="military-border p-6">
          <h4 className="text-sm terminal-text text-robotic-yellow/70 uppercase mb-4">
            [PARTICIPANT_SCORES]
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {aarData.scores.map((score) => (
              <div key={score.user_id} className="military-border p-4">
                <div className="text-sm terminal-text font-semibold mb-1">
                  {score.participant?.full_name || 'Unknown'}
                </div>
                <div className="text-xs terminal-text text-robotic-yellow/70 mb-2">
                  [{score.role || 'UNKNOWN'}]
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs terminal-text">
                  <div>
                    <span className="text-robotic-yellow/70">Coordination:</span>{' '}
                    <span className="text-robotic-yellow">{score.coordination_score}/100</span>
                  </div>
                  <div>
                    <span className="text-robotic-yellow/70">Leadership:</span>{' '}
                    <span className="text-robotic-yellow">{score.leadership_score}/100</span>
                  </div>
                  <div>
                    <span className="text-robotic-yellow/70">Decisions:</span>{' '}
                    <span className="text-robotic-yellow">{score.decisions_proposed}</span>
                  </div>
                  <div>
                    <span className="text-robotic-yellow/70">Messages:</span>{' '}
                    <span className="text-robotic-yellow">{score.communications_sent}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="military-border p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
            [EVENTS]
          </div>
          <div className="text-2xl terminal-text text-robotic-yellow">{aarData.events.length}</div>
        </div>
        <div className="military-border p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
            [DECISIONS]
          </div>
          <div className="text-2xl terminal-text text-robotic-yellow">
            {aarData.decisions.length}
          </div>
        </div>
        <div className="military-border p-4">
          <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-1">
            [DURATION]
          </div>
          <div className="text-sm terminal-text text-robotic-yellow">
            {aarData.session.start_time && aarData.session.end_time
              ? `${Math.round(
                  (new Date(aarData.session.end_time).getTime() -
                    new Date(aarData.session.start_time).getTime()) /
                    60000,
                )} minutes`
              : 'N/A'}
          </div>
        </div>
      </div>
    </div>
  );
};
