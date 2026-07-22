import React, { useState, useEffect, useRef } from 'react';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { api } from '../../lib/api';
import { PursuitTimeline } from './PursuitTimeline';
import {
  SocialGlanceBoard,
  SocialSentimentSectionData,
  SocialInformationFlowSectionData,
  SocialTeamSectionData,
  SocialExecutiveSectionData,
  socialSectionsPresent,
} from './SocialAARCharts';

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
  // Social media crisis report sections (list order = display order)
  'social_executive',
  'social_timeline',
  'social_public_comms',
  'social_team_communications',
  'social_team_procurement',
  'social_team_sales',
  'social_team_legal',
  'social_information_flow',
  'social_misinformation',
  'social_sentiment',
  'social_crisis_standards',
  'social_player_performance',
  'social_recommendations',
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
  social_executive: 'Executive summary',
  social_timeline: 'Crisis timeline reconstruction',
  social_public_comms: 'Public communications review',
  social_team_communications: 'Team deep-dive: Communications',
  social_team_procurement: 'Team deep-dive: Procurement',
  social_team_sales: 'Team deep-dive: Sales',
  social_team_legal: 'Team deep-dive: Legal',
  social_information_flow: 'Cross-team information flow',
  social_misinformation: 'Misinformation and moderation',
  social_sentiment: 'Sentiment journey and turning points',
  social_crisis_standards: 'Crisis communication standards',
  social_player_performance: 'Individual player performance',
  social_recommendations: 'Key takeaways and recommendations',
};

/** Slugify a section heading into a DOM id for the sticky jump-nav. */
function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

/** Keyword-based mapping of heading text → icon tile + hue classes (presentational only). */
const SECTION_HEADING_STYLES: Array<{
  pattern: RegExp;
  icon: string;
  tile: string;
  title: string;
  border: string;
}> = [
  {
    pattern: /executive|summary|overview/i,
    icon: '📋',
    tile: 'bg-brand',
    title: 'text-brand',
    border: 'border-brand/25',
  },
  {
    pattern: /metric|score|matri|statistic/i,
    icon: '📊',
    tile: 'bg-accent',
    title: 'text-accent',
    border: 'border-accent/25',
  },
  {
    pattern: /strength|positive|recommendation|takeaway/i,
    icon: '✅',
    tile: 'bg-success',
    title: 'text-success',
    border: 'border-success/25',
  },
  {
    pattern: /weakness|escalation|failure|cancel|misinformation/i,
    icon: '⚠️',
    tile: 'bg-danger',
    title: 'text-danger',
    border: 'border-danger/25',
  },
  {
    pattern: /team deep-dive/i,
    icon: '👥',
    tile: 'bg-brand',
    title: 'text-brand',
    border: 'border-brand/25',
  },
  {
    pattern: /sentiment|journey/i,
    icon: '📈',
    tile: 'bg-accent',
    title: 'text-accent',
    border: 'border-accent/25',
  },
  {
    pattern: /information flow|communications review/i,
    icon: '🔁',
    tile: 'bg-accent',
    title: 'text-accent',
    border: 'border-accent/25',
  },
  {
    pattern: /standards|doctrine|timeline|player performance/i,
    icon: '📄',
    tile: 'bg-brand',
    title: 'text-brand',
    border: 'border-brand/25',
  },
];

const DEFAULT_HEADING_STYLE = {
  icon: '📄',
  tile: 'bg-brand',
  title: 'text-brand',
  border: 'border-brand/25',
};

function SectionHeading({ title }: { title: string }) {
  const style = SECTION_HEADING_STYLES.find((s) => s.pattern.test(title)) ?? DEFAULT_HEADING_STYLE;
  return (
    <div className={`flex items-center gap-2.5 mb-3 pb-2 border-b-2 ${style.border}`}>
      <span
        aria-hidden="true"
        className={`w-7 h-7 rounded-lg grid place-items-center text-sm text-white ${style.tile}`}
      >
        {style.icon}
      </span>
      <h4 className={`text-sm font-extrabold uppercase tracking-wide ${style.title}`}>{title}</h4>
    </div>
  );
}

const VERDICT_PILL_BASE = 'text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-full';

/** Map a quality/verdict string to pill classes; null if it doesn't look like a verdict. */
function verdictPillClasses(verdict: string): string | null {
  if (/\b(good|strong|robust|high)\b/i.test(verdict)) return 'bg-success/10 text-success';
  if (/\b(poor|costly|weak|low|fragile)\b/i.test(verdict)) return 'bg-danger/10 text-danger';
  if (/\b(mixed|neutral|moderate|medium|adequate)\b/i.test(verdict))
    return 'bg-accent/10 text-accent';
  return null;
}

/** Render a verdict string as a pill badge when recognized, otherwise as plain text. */
function VerdictBadge({ verdict }: { verdict: string }) {
  const classes = verdictPillClasses(verdict);
  if (!classes) return <>{verdict}</>;
  return <span className={`${VERDICT_PILL_BASE} ${classes}`}>{verdict}</span>;
}

/** Stat card for a simple label → value pair (key-metrics style sections). */
function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
      <div className="text-[10px] font-bold text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-extrabold text-brand break-words">{value}</div>
      <div className="h-[3px] w-8 bg-accent rounded mt-2" />
    </div>
  );
}

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
  const presentKeys = AAR_SECTION_KEYS.filter((key) => sections[key] != null);
  return (
    <div className="military-border space-y-8 pb-6">
      {presentKeys.length > 0 && (
        <nav
          aria-label="AAR sections"
          className="sticky top-0 z-20 bg-surface border-b border-border shadow-sm flex gap-1 overflow-x-auto px-2 rounded-t-xl"
        >
          {presentKeys.map((key) => (
            <button
              key={key}
              type="button"
              className="text-xs font-semibold text-muted px-3 py-2.5 border-b-2 border-transparent hover:text-brand whitespace-nowrap"
              onClick={() =>
                document
                  .getElementById(`aar-section-${slugifyHeading(AAR_SECTION_LABELS[key])}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {AAR_SECTION_LABELS[key]}
            </button>
          ))}
        </nav>
      )}
      <div className="text-xs terminal-text text-muted mb-4 px-6">
        Generated: {new Date(aar.generated_at).toLocaleString()} (section-based report)
      </div>
      {socialSectionsPresent(sections) && <SocialGlanceBoard sections={sections} />}
      {AAR_SECTION_KEYS.map((key) => {
        const entry = sections[key];
        if (!entry) return null;
        const data = entry.data;
        const analysis = entry.analysis;
        const label = AAR_SECTION_LABELS[key];
        return (
          <div
            key={key}
            id={`aar-section-${slugifyHeading(label)}`}
            style={{ scrollMarginTop: 56 }}
            className="space-y-2 px-6"
          >
            <SectionHeading title={label} />
            {data != null && key !== 'social_recommendations' && (
              <div className="military-border p-4 bg-surface-2">
                <div className="text-xs terminal-text text-muted mb-2">Data</div>
                <SectionDataDisplay keyName={key} data={data} />
              </div>
            )}
            <div className="military-border p-4">
              <div className="text-xs terminal-text text-success mb-2">Analysis</div>
              {analysis ? (
                <p className="text-sm terminal-text whitespace-pre-wrap">{analysis}</p>
              ) : (
                <p className="text-xs terminal-text text-muted">Analysis not available.</p>
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
      return <span className="text-muted">[{value.length} items]</span>;
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
    <span className="text-muted">
      {entries
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${v == null || typeof v !== 'object' ? v : '…'}`)
        .join('; ')}
      …
    </span>
  );
}

/** Key-value table for a plain object. Flat all-numeric objects render as stat cards. */
function KeyValueTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  const allNumeric = entries.every(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (allNumeric) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {entries.map(([k, v]) => (
          <StatCard key={k} label={k.replace(/_/g, ' ')} value={String(v)} />
        ))}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs terminal-text">
        <thead>
          <tr className="text-muted border-b border-border">
            <th className="text-left py-1 pr-2">Key</th>
            <th className="text-left py-1 pr-2">Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-border">
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

/** Render analysis object as full text (no truncation). */
function formatAnalysisFull(analysis: unknown): string {
  if (analysis == null) return '—';
  if (typeof analysis !== 'object' || Array.isArray(analysis)) return String(analysis);
  const obj = analysis as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.overall === 'string' && obj.overall.trim())
    parts.push(`Overall: ${obj.overall.trim()}`);
  if (typeof obj.matrix_reasoning === 'string' && obj.matrix_reasoning.trim())
    parts.push(`Matrix: ${obj.matrix_reasoning.trim()}`);
  if (typeof obj.robustness_reasoning === 'string' && obj.robustness_reasoning.trim())
    parts.push(`Robustness: ${obj.robustness_reasoning.trim()}`);
  const byDec = obj.robustness_reasoning_by_decision;
  if (byDec && typeof byDec === 'object' && !Array.isArray(byDec)) {
    const entries = Object.entries(byDec as Record<string, string>)
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${k}: ${(v as string).trim()}`);
    if (entries.length > 0) parts.push(`By decision: ${entries.join(' | ')}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : JSON.stringify(obj);
}

const CONTENT_PREVIEW_CHARS = 400;
const INCIDENT_RESPONSE_EXPAND_THRESHOLD = 800;

function IncidentResponsePairsTable({ pairs }: { pairs: Array<Record<string, unknown>> }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div className="overflow-x-auto space-y-4">
      {pairs.map((p, i) => {
        const inc = (p.incident as Record<string, unknown>) ?? {};
        const dec = (p.decision as Record<string, unknown>) ?? {};
        const incDesc: string = inc.description != null ? String(inc.description) : '';
        const decDesc: string = dec.description != null ? String(dec.description) : '';
        return (
          <div key={i} className="border border-border p-3 bg-surface font-mono text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-muted mb-1">Incident</div>
                <div className="text-success font-semibold">{String(inc.title ?? '') || '—'}</div>
                <div className="text-ink mt-1 whitespace-pre-wrap break-words">
                  {incDesc
                    ? incDesc.length > INCIDENT_RESPONSE_EXPAND_THRESHOLD
                      ? (() => {
                          const key = `${i}-inc-desc`;
                          const expanded = expandedKeys.has(key);
                          const display = expanded
                            ? incDesc
                            : incDesc.slice(0, INCIDENT_RESPONSE_EXPAND_THRESHOLD);
                          return (
                            <span>
                              <span className="whitespace-pre-wrap break-words">{display}</span>
                              {!expanded && <span className="text-muted">… </span>}
                              <button
                                type="button"
                                className="ml-1 text-ink hover:text-ink underline text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle(key);
                                }}
                              >
                                {expanded ? 'See less' : 'See more'}
                              </button>
                            </span>
                          );
                        })()
                      : incDesc
                    : '—'}
                </div>
                {inc.reported_at ? (
                  <div className="text-muted mt-1">
                    Reported: {new Date(inc.reported_at as string).toLocaleString()}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-muted mb-1">Decision</div>
                <div className="text-success font-semibold">{String(dec.title ?? '') || '—'}</div>
                <div className="text-ink mt-1 whitespace-pre-wrap break-words">
                  {decDesc
                    ? decDesc.length > INCIDENT_RESPONSE_EXPAND_THRESHOLD
                      ? (() => {
                          const key = `${i}-dec-desc`;
                          const expanded = expandedKeys.has(key);
                          const display = expanded
                            ? decDesc
                            : decDesc.slice(0, INCIDENT_RESPONSE_EXPAND_THRESHOLD);
                          return (
                            <span>
                              <span className="whitespace-pre-wrap break-words">{display}</span>
                              {!expanded && <span className="text-muted">… </span>}
                              <button
                                type="button"
                                className="ml-1 text-ink hover:text-ink underline text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle(key);
                                }}
                              >
                                {expanded ? 'See less' : 'See more'}
                              </button>
                            </span>
                          );
                        })()
                      : decDesc
                    : '—'}
                </div>
                {dec.executed_at ? (
                  <div className="text-muted mt-1">
                    Executed: {new Date(dec.executed_at as string).toLocaleString()}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-3 mt-2 pt-2 border-t border-border text-muted">
              {p.robustness != null && (
                <span className="inline-flex items-center gap-1">
                  Robustness: <VerdictBadge verdict={String(p.robustness)} />
                </span>
              )}
              {p.latencyMinutes != null && <span>Latency: {String(p.latencyMinutes)} min</span>}
              {p.insiderConsulted != null && (
                <span>Insider consulted: {p.insiderConsulted ? 'Yes' : 'No'}</span>
              )}
              {p.environmentalConsistency != null &&
                typeof p.environmentalConsistency === 'object' && (
                  <span className="whitespace-pre-wrap break-words">
                    Env:{' '}
                    {(p.environmentalConsistency as { consistent?: boolean; reason?: string })
                      .reason ?? JSON.stringify(p.environmentalConsistency)}
                  </span>
                )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InjectsPublishedTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const toggle = (i: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs terminal-text">
        <thead>
          <tr className="text-muted border-b border-border">
            <th className="text-left py-1 pr-2">at</th>
            <th className="text-left py-1 pr-2">title</th>
            <th className="text-left py-1 pr-2">content</th>
            <th className="text-left py-1 pr-2">inject_scope</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const content = row.content;
            const contentStr = content != null ? String(content) : '';
            const isLong = contentStr.length > CONTENT_PREVIEW_CHARS;
            const isExpanded = expandedIds.has(i);
            const displayContent =
              isLong && !isExpanded ? contentStr.slice(0, CONTENT_PREVIEW_CHARS) : contentStr;
            return (
              <tr key={i} className="border-b border-border align-top">
                <td className="py-1 pr-2 whitespace-nowrap">{formatCellValue(row.at)}</td>
                <td className="py-1 pr-2 max-w-[200px] break-words">
                  {formatCellValue(row.title)}
                </td>
                <td className="py-1 pr-2 max-w-none whitespace-pre-wrap break-words">
                  {displayContent || '—'}
                  {isLong && (
                    <button
                      type="button"
                      className="ml-2 text-ink hover:text-ink underline"
                      onClick={() => toggle(i)}
                    >
                      {isExpanded ? 'See less' : 'See more'}
                    </button>
                  )}
                </td>
                <td className="py-1 pr-2">{formatCellValue(row.inject_scope)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionDataDisplay({ keyName, data }: { keyName: string; data: unknown }) {
  if (data == null) return null;
  // Social crisis sections get designed renderers (charts, team cards, intel strips)
  if (keyName.startsWith('social_team_') && typeof data === 'object' && !Array.isArray(data)) {
    return <SocialTeamSectionData data={data as Record<string, unknown>} />;
  }
  if (keyName === 'social_sentiment' && typeof data === 'object' && !Array.isArray(data)) {
    return <SocialSentimentSectionData data={data as Record<string, unknown>} />;
  }
  if (keyName === 'social_information_flow' && typeof data === 'object' && !Array.isArray(data)) {
    return <SocialInformationFlowSectionData data={data as Record<string, unknown>} />;
  }
  if (keyName === 'social_executive' && typeof data === 'object' && !Array.isArray(data)) {
    return <SocialExecutiveSectionData data={data as Record<string, unknown>} />;
  }
  if (keyName === 'social_recommendations') {
    return null; // the analysis text is the whole section; no raw data panel
  }
  // Injects published: columns at, title, content, inject_scope; all rows, full text, See more for long content
  if (keyName === 'injects_published' && Array.isArray(data)) {
    if (data.length === 0)
      return <p className="text-xs terminal-text text-muted">No injects published.</p>;
    return <InjectsPublishedTable rows={data as Array<Record<string, unknown>>} />;
  }
  // Pathway outcomes: decision text and pathway outcome(s) only
  if (keyName === 'pathway_outcomes' && Array.isArray(data)) {
    const pairs = data as Array<{
      decision_text?: string;
      pathway_outcomes?: Array<{ title?: string; content?: string }>;
    }>;
    if (pairs.length === 0)
      return <p className="text-xs terminal-text text-muted">No pathway outcome pairs.</p>;
    return (
      <div className="space-y-4">
        {pairs.map((p, i) => (
          <div key={i} className="border border-border p-3 bg-surface font-mono text-xs">
            <div className="mb-3">
              <div className="text-muted mb-1">Decision</div>
              <div className="text-success whitespace-pre-wrap break-words">
                {p.decision_text || '—'}
              </div>
            </div>
            <div>
              <div className="text-muted mb-1">Pathway outcome(s)</div>
              {(p.pathway_outcomes ?? []).length === 0 ? (
                <p className="text-muted">—</p>
              ) : (
                <div className="space-y-2">
                  {(p.pathway_outcomes ?? []).map((o, j) => (
                    <div key={j} className="border-l-2 border-border pl-2">
                      <div className="text-success font-semibold">{o.title || '—'}</div>
                      <div className="text-ink mt-0.5 whitespace-pre-wrap break-words">
                        {o.content || '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // Insider information usage: no ids, full text
  if (keyName === 'insider_usage' && data != null && typeof data === 'object') {
    const obj = data as {
      questions?: Array<Record<string, unknown>>;
      gaps?: Array<Record<string, unknown>>;
    };
    const questions = obj.questions ?? [];
    const gaps = obj.gaps ?? [];
    return (
      <div className="space-y-4">
        <div>
          <div className="text-muted mb-2 text-xs">Questions asked</div>
          {questions.length === 0 ? (
            <p className="text-muted text-xs">No questions asked.</p>
          ) : (
            <div className="space-y-2">
              {questions.map((q, i) => (
                <div key={i} className="border border-border p-3 bg-surface font-mono text-xs">
                  <div className="text-success font-semibold whitespace-pre-wrap break-words">
                    {String(q.question_text ?? '—')}
                  </div>
                  <div className="text-muted mt-1">
                    Category: {String(q.category ?? '—')} | Asked at:{' '}
                    {q.asked_at ? new Date(q.asked_at as string).toLocaleString() : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="text-muted mb-2 text-xs">Gaps (incidents with intel not consulted)</div>
          {gaps.length === 0 ? (
            <p className="text-muted text-xs">No gaps.</p>
          ) : (
            <div className="space-y-2">
              {gaps.map((g, i) => (
                <div key={i} className="border border-border p-3 bg-surface font-mono text-xs">
                  <div className="text-success font-semibold whitespace-pre-wrap break-words">
                    {String(g.incident_title ?? '—')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  // Incident–response pairs: no ids, full text, See more only if very long
  if (keyName === 'incident_response' && Array.isArray(data)) {
    if (data.length === 0)
      return <p className="text-xs terminal-text text-muted">No incident–response pairs.</p>;
    return <IncidentResponsePairsTable pairs={data as Array<Record<string, unknown>>} />;
  }
  // Impact matrices: columns matrix, analysis, evaluated_at, response_taxonomy; full analysis text
  if (keyName === 'matrices' && Array.isArray(data) && data.length > 0) {
    const rows = data as Array<Record<string, unknown>>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs terminal-text">
          <thead>
            <tr className="text-muted border-b border-border">
              <th className="text-left py-1 pr-2">matrix</th>
              <th className="text-left py-1 pr-2">analysis</th>
              <th className="text-left py-1 pr-2">evaluated_at</th>
              <th className="text-left py-1 pr-2">response_taxonomy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border align-top">
                <td className="py-1 pr-2 max-w-[300px] break-words">
                  {formatCellValue(row.matrix)}
                </td>
                <td className="py-1 pr-2 max-w-none whitespace-pre-wrap break-words">
                  {formatAnalysisFull(row.analysis)}
                </td>
                <td className="py-1 pr-2">{formatCellValue(row.evaluated_at)}</td>
                <td className="py-1 pr-2 max-w-[200px] break-words">
                  {formatCellValue(row.response_taxonomy)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return <p className="text-xs terminal-text text-muted">No entries.</p>;
    const first = data[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      const keys = Object.keys(first as Record<string, unknown>);
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs terminal-text">
            <thead>
              <tr className="text-muted border-b border-border">
                {keys.map((k) => (
                  <th key={k} className="text-left py-1 pr-2">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.slice(0, 30).map((row, i) => (
                <tr key={i} className="border-b border-border">
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
            <p className="text-xs terminal-text text-muted mt-1">… and {data.length - 30} more</p>
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
              <div className="text-xs terminal-text text-muted mb-1">Communication</div>
              <KeyValueTable data={obj.communication as Record<string, unknown>} />
            </div>
          ) : null}
          <div>
            <div className="text-xs terminal-text text-muted mb-1">Participants</div>
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
              <div className="text-xs terminal-text text-muted mb-1">{k}</div>
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
  const [heatMeter, setHeatMeter] = useState<Record<
    string,
    {
      mistake_points: number;
      cooldown_points: number;
      total_decisions: number;
      heat_percentage: number;
    }
  > | null>(null);

  useEffect(() => {
    loadAAR();
    api.sessions
      .get(sessionId)
      .then((res) => {
        const cs = (res.data as Record<string, unknown>)?.current_state as
          | Record<string, unknown>
          | undefined;
        if (cs?.heat_meter) setHeatMeter(cs.heat_meter as typeof heatMeter);
      })
      .catch(() => {});
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

  // While the multi-call AI generation runs, the backend persists each section
  // as it completes — poll so sections appear progressively instead of the
  // page sitting frozen for minutes.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleGenerate = async () => {
    if (!confirm('Generate AAR report? This will overwrite any existing report.')) return;

    setGenerating(true);
    pollRef.current = setInterval(async () => {
      try {
        const result = await api.aar.get(sessionId);
        setAarData(result.data as AARData);
      } catch {
        /* keep polling */
      }
    }, 5000);
    try {
      await api.aar.generate(sessionId);
    } catch (error) {
      console.error('Failed to generate AAR:', error);
      alert('Failed to generate AAR report');
    } finally {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      await loadAAR();
      setGenerating(false);
    }
  };

  const handleExport = async (format: 'pdf' | 'excel') => {
    setExporting(format);
    try {
      const result = await api.aar.export(sessionId, format);
      const { url, fileName } = result.data;
      // Download via blob + anchor instead of window.open: window.open after an
      // async wait is silently killed by popup blockers (always on mobile
      // Chrome). A programmatic anchor click with the download attribute goes
      // through the browser's download manager instead.
      const fileResponse = await fetch(url);
      if (!fileResponse.ok) throw new Error(`File fetch failed (${fileResponse.status})`);
      const blob = await fileResponse.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName || `aar-export.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (error) {
      console.error(`Failed to export AAR as ${format}:`, error);
      alert(`Failed to export AAR as ${format}. Please try again.`);
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <div className="military-border p-6">
        <div className="text-center">
          <div className="text-sm terminal-text text-muted animate-pulse">Loading AAR…</div>
        </div>
      </div>
    );
  }

  if (!aarData) {
    return (
      <div className="military-border p-6">
        <p className="text-sm terminal-text text-muted">Failed to load AAR data</p>
      </div>
    );
  }

  const canGenerate = isTrainer && aarData.session.status === 'completed';
  const metrics = aarData.aar?.key_metrics as Record<string, unknown> | undefined;

  // Progress across section AI analyses (backend persists after each call).
  const sectionEntries =
    aarData.aar?.report_format === 'sections' && aarData.aar.sections
      ? Object.values(aarData.aar.sections)
      : [];
  const analysedCount = sectionEntries.filter((s) => s?.analysis).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="military-border p-4 flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-3">
          <h3 className="text-lg terminal-text">AAR — After-action review</h3>
          {generating && (
            <span className="text-xs terminal-text text-warning animate-pulse">
              Generating…{' '}
              {sectionEntries.length > 0
                ? `${analysedCount} of ${sectionEntries.length} sections analysed`
                : 'assembling report data'}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {canGenerate && aarData.aar && (
            <button
              onClick={() => handleExport('excel')}
              disabled={exporting !== null}
              className="military-button px-4 py-2 text-sm disabled:opacity-50"
            >
              {exporting === 'excel' ? 'Exporting…' : 'Export Excel'}
            </button>
          )}
          {/* PDF export is open to participants of completed sessions too. */}
          {aarData.aar && aarData.session.status === 'completed' && (
            <button
              onClick={() => handleExport('pdf')}
              disabled={exporting !== null}
              className="military-button px-4 py-2 text-sm disabled:opacity-50"
            >
              {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
          )}
          {canGenerate && (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="military-button px-4 py-2 text-sm disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate AAR'}
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
              <SectionHeading title="Summary" />
              <p className="text-sm terminal-text whitespace-pre-wrap">{aarData.aar.summary}</p>
            </div>

            {/* Key Metrics */}
            {metrics && (
              <div>
                <SectionHeading title="Key metrics" />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {metrics.decision_latency ? (
                    <StatCard
                      label="Decision latency (avg)"
                      value={`${(
                        (metrics.decision_latency as { avg_minutes?: number }).avg_minutes || 0
                      ).toFixed(1)} min`}
                    />
                  ) : null}
                  {metrics.coordination ? (
                    <StatCard
                      label="Coordination score"
                      value={`${
                        (metrics.coordination as { overall_score?: number }).overall_score || 0
                      }/100`}
                    />
                  ) : null}
                  {metrics.compliance ? (
                    <StatCard
                      label="Compliance rate"
                      value={`${((metrics.compliance as { rate?: number }).rate || 0).toFixed(1)}%`}
                    />
                  ) : null}
                </div>
              </div>
            )}

            {/* AI Insights */}
            {aarData.aar.ai_insights && aarData.aar.ai_insights.length > 0 && (
              <div>
                <SectionHeading title="AI insights" />
                <div className="space-y-2">
                  {aarData.aar.ai_insights.map(
                    (insight: { type?: string; content?: string }, idx) => (
                      <div key={idx} className="military-border p-3">
                        <div className="text-xs terminal-text text-success mb-1">
                          {insight.type || 'Insight'}
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
                <SectionHeading title="Key decisions" />
                <div className="space-y-2">
                  {aarData.aar.key_decisions.slice(0, 10).map((decision: unknown, idx: number) => {
                    const d = decision as { title?: string; type?: string; status?: string };
                    return (
                      <div key={idx} className="military-border p-3">
                        <div className="text-sm terminal-text font-semibold mb-1">
                          {d.title || 'Untitled Decision'}
                        </div>
                        <div className="text-xs terminal-text text-muted">
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
                <SectionHeading title="Recommendations" />
                <ul className="list-disc list-inside space-y-1">
                  {aarData.aar.recommendations.map((rec, idx) => (
                    <li key={idx} className="text-sm terminal-text">
                      {rec}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-xs terminal-text text-muted">
              Generated: {new Date(aarData.aar.generated_at).toLocaleString()}
            </div>
          </div>
        )
      ) : (
        <div className="military-border p-8 text-center">
          <p className="text-sm terminal-text text-muted mb-4">No AAR report available</p>
          {canGenerate && (
            <p className="text-xs terminal-text text-muted">
              Generate an AAR report to review session performance
            </p>
          )}
        </div>
      )}

      {/* Decision Quality Heat Meter */}
      {heatMeter && Object.keys(heatMeter).length > 0 && (
        <div className="military-border p-6">
          <SectionHeading title="Decision quality" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Object.entries(heatMeter).map(([team, data]) => {
              const pct = data.heat_percentage ?? 0;
              const color =
                pct >= 60
                  ? 'text-danger'
                  : pct >= 40
                    ? 'text-warning'
                    : pct >= 20
                      ? 'text-warning'
                      : 'text-success';
              const barColor =
                pct >= 60
                  ? 'bg-danger'
                  : pct >= 40
                    ? 'bg-warning'
                    : pct >= 20
                      ? 'bg-warning'
                      : 'bg-success';
              const label =
                pct >= 60
                  ? 'Poor'
                  : pct >= 40
                    ? 'Needs improvement'
                    : pct >= 20
                      ? 'Adequate'
                      : 'Good';
              const mistakes = data.mistake_points ?? 0;
              return (
                <div key={team} className="military-border p-4">
                  <div className="text-sm terminal-text font-semibold mb-2">
                    {team.toUpperCase()}
                  </div>
                  <div className="w-full h-3 bg-surface-2 rounded-sm overflow-hidden mb-2">
                    <div
                      className={`h-full ${barColor} transition-all`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs terminal-text">
                    <div>
                      <span className="text-muted">Heat:</span>{' '}
                      <span className={color}>{pct.toFixed(1)}%</span>
                    </div>
                    <div>
                      <span className="text-muted">Rating:</span>{' '}
                      <span className={color}>{label}</span>
                    </div>
                    <div>
                      <span className="text-muted">Decisions:</span>{' '}
                      <span className="text-ink">{data.total_decisions}</span>
                    </div>
                    <div>
                      <span className="text-muted">Mistakes:</span>{' '}
                      <span className="text-ink">{mistakes}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Participant Scores */}
      {aarData.scores.length > 0 && (
        <div className="military-border p-6">
          <SectionHeading title="Participant scores" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {aarData.scores.map((score) => (
              <div key={score.user_id} className="military-border p-4">
                <div className="text-sm terminal-text font-semibold mb-1">
                  {score.participant?.full_name || 'Unknown'}
                </div>
                <div className="text-xs terminal-text text-muted mb-2">
                  {score.role || 'Unknown'}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs terminal-text">
                  <div>
                    <span className="text-muted">Coordination:</span>{' '}
                    <span className="text-ink">{score.coordination_score}/100</span>
                  </div>
                  <div>
                    <span className="text-muted">Leadership:</span>{' '}
                    <span className="text-ink">{score.leadership_score}/100</span>
                  </div>
                  <div>
                    <span className="text-muted">Decisions:</span>{' '}
                    <span className="text-ink">{score.decisions_proposed}</span>
                  </div>
                  <div>
                    <span className="text-muted">Messages:</span>{' '}
                    <span className="text-ink">{score.communications_sent}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pursuit Intelligence Timeline */}
      <PursuitTimeline sessionId={sessionId} />

      {/* Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Events" value={aarData.events.length} />
        <StatCard label="Decisions" value={aarData.decisions.length} />
        <StatCard
          label="Duration"
          value={
            aarData.session.start_time && aarData.session.end_time
              ? `${Math.round(
                  (new Date(aarData.session.end_time).getTime() -
                    new Date(aarData.session.start_time).getTime()) /
                    60000,
                )} min`
              : 'N/A'
          }
        />
      </div>
    </div>
  );
};
