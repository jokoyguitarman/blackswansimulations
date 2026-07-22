import React from 'react';

/**
 * Dependency-free SVG chart kit + section renderers for the social-crisis
 * after-action report. All data comes from the AAR's persisted section
 * payloads (aar_reports.sections) — no fetches here.
 */

type Dict = Record<string, unknown>;
type SectionsMap = Record<string, { data: unknown; analysis: string | null }>;

const TEAM_COLOR: Record<string, string> = {
  Communications: '#3b82f6',
  Procurement: '#D97706',
  Sales: '#15803D',
  Legal: '#1E3A5F',
};
const teamColor = (name: unknown): string => TEAM_COLOR[String(name)] || '#64748b';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : []);

function scoreColor(value: number, lowerIsBetter = false): string {
  const good = lowerIsBetter ? value < 30 : value > 60;
  const bad = lowerIsBetter ? value > 60 : value < 30;
  return good ? '#15803D' : bad ? '#B91C1C' : '#D97706';
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function RadialGauge({
  label,
  value,
  lowerIsBetter,
}: {
  label: string;
  value: number;
  lowerIsBetter?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const r = 42;
  const c = 2 * Math.PI * r;
  const color = scoreColor(clamped, lowerIsBetter);
  return (
    <div className="flex flex-col items-center bg-surface border border-border rounded-xl p-3">
      <svg
        viewBox="0 0 120 120"
        className="w-full max-w-[110px]"
        role="img"
        aria-label={`${label}: ${Math.round(clamped)} out of 100`}
      >
        <circle cx="60" cy="60" r={r} fill="none" stroke="#E9E4DA" strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="67" textAnchor="middle" fontSize="20" fontWeight="800" fill="#1E3A5F">
          {Math.round(clamped)}
        </text>
      </svg>
      <div className="text-[10px] font-bold text-muted text-center mt-1 leading-tight">
        {label}
        {lowerIsBetter ? <span className="block font-normal">lower is better</span> : null}
      </div>
    </div>
  );
}

export function SentimentLineChart({
  trajectory,
  consequences,
}: {
  trajectory: Array<{ t: number; v: number }>;
  consequences: Array<{ t: number; positive: boolean; label: string }>;
}) {
  if (trajectory.length < 2) {
    return (
      <p className="text-xs terminal-text text-muted">Not enough sentiment snapshots to chart.</p>
    );
  }
  const W = 760;
  const H = 250;
  const left = 42;
  const top = 14;
  const plotW = W - left - 14;
  const plotH = H - top - 34;
  const maxT = Math.max(...trajectory.map((p) => p.t), 1);
  const toX = (t: number) => left + (Math.max(0, t) / maxT) * plotW;
  const toY = (v: number) => top + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH;
  const valueAt = (t: number): number => {
    if (t <= trajectory[0].t) return trajectory[0].v;
    for (let i = 1; i < trajectory.length; i++) {
      if (t <= trajectory[i].t) {
        const a = trajectory[i - 1];
        const b = trajectory[i];
        const span = b.t - a.t || 1;
        return a.v + ((t - a.t) / span) * (b.v - a.v);
      }
    }
    return trajectory[trajectory.length - 1].v;
  };
  const linePoints = trajectory.map((p) => `${toX(p.t)},${toY(p.v)}`).join(' L');
  const areaPath = `M${linePoints.replace(/ L/g, ' L')} L${toX(maxT)},${top + plotH} L${left},${top + plotH} Z`;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[560px]"
          role="img"
          aria-label="Public sentiment score over simulated time"
        >
          {[0, 25, 50, 75, 100].map((g) => (
            <g key={g}>
              <line
                x1={left}
                y1={toY(g)}
                x2={left + plotW}
                y2={toY(g)}
                stroke={g === 50 ? '#CFC7B9' : '#EDE8DE'}
                strokeWidth="1"
                strokeDasharray={g === 50 ? '5 5' : undefined}
              />
              <text x={left - 6} y={toY(g) + 3} textAnchor="end" fontSize="8" fill="#64748b">
                {g}
              </text>
            </g>
          ))}
          <path d={areaPath} fill="rgba(30,58,95,0.08)" />
          <path
            d={`M${linePoints}`}
            fill="none"
            stroke="#1E3A5F"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {consequences.slice(0, 14).map((c, i) => {
            const x = toX(c.t);
            const y = toY(valueAt(c.t));
            const color = c.positive ? '#15803D' : '#B91C1C';
            return (
              <g key={i}>
                <line
                  x1={x}
                  y1={top}
                  x2={x}
                  y2={top + plotH}
                  stroke={color}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.55"
                />
                <circle cx={x} cy={y} r="5" fill={color} stroke="#fff" strokeWidth="2">
                  <title>{`T+${Math.round(c.t)}m — ${c.label}`}</title>
                </circle>
              </g>
            );
          })}
          <text x={left} y={H - 8} fontSize="8" fill="#64748b">
            T+0
          </text>
          <text x={left + plotW} y={H - 8} fontSize="8" fill="#64748b" textAnchor="end">
            {`T+${Math.round(maxT)} min`}
          </text>
          <text x={left + plotW / 2} y={H - 8} fontSize="8" fill="#64748b" textAnchor="middle">
            Simulated time (minutes)
          </text>
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 mt-1 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1">
          <i
            className="w-2.5 h-2.5 rounded-full inline-block"
            style={{ backgroundColor: '#1E3A5F' }}
          />
          Sentiment score (0–100)
        </span>
        <span className="inline-flex items-center gap-1">
          <i
            className="w-2.5 h-2.5 rounded-full inline-block"
            style={{ backgroundColor: '#15803D' }}
          />
          Positive consequence
        </span>
        <span className="inline-flex items-center gap-1">
          <i
            className="w-2.5 h-2.5 rounded-full inline-block"
            style={{ backgroundColor: '#B91C1C' }}
          />
          Negative consequence
        </span>
      </div>
    </div>
  );
}

function TeamScoreBars({ teams }: { teams: Dict[] }) {
  const scored = teams.filter((t) => num(t.composite) != null);
  if (scored.length === 0) {
    return <p className="text-xs terminal-text text-muted">No staffed teams were scored.</p>;
  }
  return (
    <div className="space-y-3">
      {scored.map((t) => {
        const composite = num(t.composite) ?? 0;
        const color = teamColor(t.team_name);
        const parts: Array<[string, number | null]> = [
          ['QUALITY', num(t.content_quality)],
          ['TASKS', num(t.task_completion)],
          ['FIT', num(t.role_fit)],
          ['INTEL', num(t.collaboration)],
        ];
        return (
          <div key={String(t.team_name)}>
            <div className="grid grid-cols-[96px_1fr_36px] items-center gap-2">
              <div className="text-[10px] font-extrabold" style={{ color }}>
                {String(t.team_name)}
              </div>
              <div className="h-2.5 rounded-full overflow-hidden bg-surface-2">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${composite}%`, backgroundColor: color }}
                />
              </div>
              <div className="text-[11px] font-extrabold text-brand text-right">{composite}</div>
            </div>
            <div className="flex gap-3 mt-0.5 ml-[104px] text-[9px] font-bold text-muted">
              {parts
                .filter(([, v]) => v != null)
                .map(([label, v]) => (
                  <span key={label}>
                    {label} <span style={{ color: scoreColor(v as number) }}>{v}</span>
                  </span>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActionMixDonut({ scorecard }: { scorecard: Dict }) {
  const t1 = num(scorecard.tier1_count) ?? 0;
  const t2 = num(scorecard.tier2_count) ?? 0;
  const t3 = num(scorecard.tier3_count) ?? 0;
  const total = t1 + t2 + t3;
  if (total === 0) {
    return <p className="text-xs terminal-text text-muted">No tiered actions recorded.</p>;
  }
  const ratio = Math.round((num(scorecard.strategic_ratio) ?? (t2 + t3) / total) * 100);
  const r = 44;
  const c = 2 * Math.PI * r;
  const segments = [
    { value: t1, color: '#1E3A5F', label: `Tier 1 reactive · ${t1}` },
    { value: t2, color: '#D97706', label: `Tier 2 strategic · ${t2}` },
    { value: t3, color: '#15803D', label: `Tier 3 advanced · ${t3}` },
  ];
  let offset = 0;
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg
        viewBox="0 0 120 120"
        className="w-[120px]"
        role="img"
        aria-label={`Action mix: ${ratio}% strategic`}
      >
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={i}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="13"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            >
              <title>{s.label}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <text x="60" y="66" textAnchor="middle" fontSize="19" fontWeight="800" fill="#1E3A5F">
          {ratio}%
        </text>
      </svg>
      <div className="space-y-1 text-[10px] text-muted">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <i className="w-2 h-2 rounded-sm inline-block" style={{ backgroundColor: s.color }} />
            {s.label}
          </div>
        ))}
        <div className="font-extrabold text-brand pt-0.5">{ratio}% strategic ratio</div>
      </div>
    </div>
  );
}

function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'danger' | 'warning';
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    success: 'bg-success/10 text-success',
    danger: 'bg-danger/10 text-danger',
    warning: 'bg-accent/10 text-warning',
  };
  return (
    <span
      className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full whitespace-nowrap ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

export function IntelFlowStrip({ items }: { items: Dict[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs terminal-text text-muted">
        No cross-team intel dependencies in this scenario.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const shared = item.shared === true;
        const missed = item.deadline_missed === true;
        const sharedAt = num(item.shared_at_minutes);
        const deadline = num(item.deadline_minutes);
        const late = shared && sharedAt != null && deadline != null && sharedAt > deadline;
        return (
          <div
            key={i}
            className="flex items-center gap-2 flex-wrap border border-border rounded-lg bg-surface px-3 py-2"
          >
            <span
              className="text-[10px] font-extrabold"
              style={{ color: teamColor(item.holder_team) }}
            >
              {String(item.holder_team || '?')}
            </span>
            <span className="text-accent font-extrabold">→</span>
            <span className="text-[10px] font-extrabold">
              {arr(item.needed_by).length > 0
                ? (item.needed_by as string[]).map((t, j) => (
                    <span key={t} style={{ color: teamColor(t) }}>
                      {j > 0 ? ', ' : ''}
                      {t}
                    </span>
                  ))
                : '—'}
            </span>
            <span className="text-[10px] text-muted flex-1 min-w-[140px]">
              {String(item.title || item.summary || '')}
            </span>
            {shared ? (
              <StatusPill tone={late ? 'warning' : 'success'}>
                Shared T+{sharedAt ?? '?'}m{late ? ' · late' : ''}
              </StatusPill>
            ) : missed ? (
              <StatusPill tone="danger">
                Never shared{deadline != null ? ` · deadline T+${deadline}m` : ''}
              </StatusPill>
            ) : (
              <StatusPill tone="warning">Unshared</StatusPill>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── At-a-glance board (verdict banner + chart row) ──────────────────────────

export function socialSectionsPresent(sections: SectionsMap | undefined): boolean {
  return !!sections?.social_executive;
}

export function SocialGlanceBoard({ sections }: { sections: SectionsMap }) {
  const exec = (sections.social_executive?.data || {}) as Dict;
  const sentiment = (sections.social_sentiment?.data || {}) as Dict;
  const intel = (sections.social_information_flow?.data || {}) as Dict;

  const dimensions = arr(exec.final_dimensions);
  const teams = arr(exec.teams);
  const scorecard = (exec.strategic_scorecard || {}) as Dict;
  const intelItems = arr(intel.intel_items);
  const composite = num(exec.overall_composite);
  const counts = (exec.headline_counts || {}) as Dict;
  const executiveAnalysis = sections.social_executive?.analysis;

  const trajectory = arr(sentiment.trajectory)
    .map((p) => ({ t: num(p.t_plus_min), v: num(p.sentiment_score) }))
    .filter((p): p is { t: number; v: number } => p.t != null && p.v != null);
  const consequences = arr(sentiment.consequences)
    .map((c) => ({
      t: num(c.t_plus_min),
      positive: c.is_positive === true,
      label: String(c.description || ''),
    }))
    .filter((c): c is { t: number; positive: boolean; label: string } => c.t != null);

  const verdictTone =
    composite == null ? null : composite > 60 ? 'success' : composite < 40 ? 'danger' : 'warning';

  return (
    <div className="space-y-4 px-6">
      {/* Verdict banner */}
      <div className="military-border p-5 bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-accent">
              Social media crisis · Final report
            </div>
            <h3 className="text-xl font-extrabold text-brand mt-1">
              {String(exec.scenario_title || 'After-Action Report')}
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-muted">
              {exec.org_name ? <span>{String(exec.org_name)}</span> : null}
              {num(exec.duration_minutes) != null && (
                <span>{String(exec.duration_minutes)} minutes</span>
              )}
              {num(exec.participant_count) != null && (
                <span>{String(exec.participant_count)} participants</span>
              )}
              {num(counts.total_player_actions) != null && (
                <span>{String(counts.total_player_actions)} player actions analysed</span>
              )}
            </div>
            {executiveAnalysis ? (
              <p className="text-xs text-muted mt-2 max-w-2xl line-clamp-3">
                {executiveAnalysis.split('\n')[0]}
              </p>
            ) : null}
          </div>
          {composite != null && verdictTone && (
            <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-xl px-4 py-3">
              <div className="text-4xl font-black text-brand leading-none">
                {composite}
                <span className="text-sm text-muted font-bold">/100</span>
              </div>
              <div className="max-w-[140px]">
                <StatusPill tone={verdictTone}>
                  {composite > 60
                    ? 'Effective'
                    : composite < 40
                      ? 'High-risk'
                      : 'Effective with gaps'}
                </StatusPill>
                <div className="text-[9px] text-muted mt-1">
                  Composite across content, tasks, role fit and collaboration
                </div>
              </div>
            </div>
          )}
        </div>

        {dimensions.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            {dimensions.map((d, i) => (
              <RadialGauge
                key={i}
                label={String(d.label || d.key || '')}
                value={num(d.value) ?? 0}
                lowerIsBetter={d.lower_is_better === true}
              />
            ))}
          </div>
        )}
      </div>

      {/* Chart row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="military-border p-4 bg-surface lg:col-span-2">
          <div className="text-xs font-extrabold text-brand mb-2">
            Public sentiment over simulated time
          </div>
          <SentimentLineChart trajectory={trajectory} consequences={consequences} />
        </div>
        <div className="space-y-4">
          <div className="military-border p-4 bg-surface">
            <div className="text-xs font-extrabold text-brand mb-2">Team composite scores</div>
            <TeamScoreBars teams={teams} />
          </div>
          <div className="military-border p-4 bg-surface">
            <div className="text-xs font-extrabold text-brand mb-2">
              Action mix: reactive vs strategic
            </div>
            <ActionMixDonut scorecard={scorecard} />
          </div>
        </div>
      </div>

      {intelItems.length > 0 && (
        <div className="military-border p-4 bg-surface">
          <div className="text-xs font-extrabold text-brand mb-2">Cross-team intel at a glance</div>
          <IntelFlowStrip items={intelItems} />
        </div>
      )}
    </div>
  );
}

// ─── Section renderers (Data panels) ─────────────────────────────────────────

export function SocialSentimentSectionData({ data }: { data: Dict }) {
  const trajectory = arr(data.trajectory)
    .map((p) => ({ t: num(p.t_plus_min), v: num(p.sentiment_score) }))
    .filter((p): p is { t: number; v: number } => p.t != null && p.v != null);
  const consequences = arr(data.consequences).map((c) => ({
    t: num(c.t_plus_min),
    positive: c.is_positive === true,
    label: String(c.description || ''),
  }));
  return (
    <div className="space-y-4">
      <SentimentLineChart
        trajectory={trajectory}
        consequences={consequences.filter(
          (c): c is { t: number; positive: boolean; label: string } => c.t != null,
        )}
      />
      {consequences.length > 0 && (
        <div>
          <div className="text-[10px] font-extrabold uppercase text-muted mb-1.5">
            Consequence events
          </div>
          <div className="space-y-1">
            {consequences.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span
                  className="mt-1 w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: c.positive ? '#15803D' : '#B91C1C' }}
                />
                <span className="text-brand font-bold whitespace-nowrap">T+{c.t ?? '?'}m</span>
                <span className="text-ink">{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SocialInformationFlowSectionData({ data }: { data: Dict }) {
  const emailsByTeam = (data.emails_sent_by_team || {}) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <IntelFlowStrip items={arr(data.intel_items)} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(emailsByTeam).map(([team, count]) => (
          <div key={team} className="bg-surface border border-border rounded-lg p-3">
            <div className="text-[9px] font-bold uppercase text-muted">{team} emails</div>
            <div className="text-lg font-extrabold" style={{ color: teamColor(team) }}>
              {String(count)}
            </div>
          </div>
        ))}
        {num(data.total_chat_messages) != null && (
          <div className="bg-surface border border-border rounded-lg p-3">
            <div className="text-[9px] font-bold uppercase text-muted">Chat messages</div>
            <div className="text-lg font-extrabold text-brand">
              {String(data.total_chat_messages)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SocialTeamSectionData({ data }: { data: Dict }) {
  const color = teamColor(data.team_name);
  if (data.unstaffed === true) {
    return (
      <p className="text-xs terminal-text text-muted">This team was unstaffed for the session.</p>
    );
  }
  const scores = (data.scores || {}) as Dict;
  const tasks = arr(data.task_outcomes);
  const members = arr(data.members);
  const memberSummaries = arr(data.member_summaries);
  const intel = arr(data.intel);
  const outOfLane = arr(data.out_of_lane);
  const best = data.best_artifact as Dict | null;
  const worst = data.worst_artifact as Dict | null;
  const scoreParts: Array<[string, number | null]> = [
    ['Composite', num(scores.composite)],
    ['Quality', num(scores.content_quality)],
    ['Tasks', num(scores.task_completion)],
    ['Role fit', num(scores.role_fit)],
    ['Intel', num(scores.collaboration)],
  ];

  return (
    <div className="space-y-4">
      <div
        className="rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        style={{ backgroundColor: color }}
      >
        <div className="min-w-0">
          <div className="text-white font-extrabold text-sm">{String(data.team_name)}</div>
          <div className="text-white/75 text-[10px] max-w-xl">{String(data.mission || '')}</div>
        </div>
        <div className="flex gap-4">
          {scoreParts
            .filter(([, v]) => v != null)
            .map(([label, v]) => (
              <div key={label} className="text-center">
                <div className="text-white font-black text-lg leading-none">{v}</div>
                <div className="text-white/70 text-[8px] font-bold uppercase">{label}</div>
              </div>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] font-extrabold uppercase text-muted mb-1.5">
            Task outcomes
          </div>
          <div className="space-y-1">
            {tasks.map((t, i) => {
              const status = String(t.status || '');
              const tone =
                status === 'done' ? '#15803D' : status === 'overdue' ? '#B91C1C' : '#D97706';
              return (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <span className="font-black w-3 flex-shrink-0" style={{ color: tone }}>
                    {status === 'done' ? '✓' : status === 'overdue' ? '!' : '·'}
                  </span>
                  <span className="text-ink">
                    {String(t.description || '')}
                    {status === 'done' && t.on_time === false && (
                      <span className="text-warning font-bold"> (late)</span>
                    )}
                    {status !== 'done' && <span className="text-muted"> — {status}</span>}
                  </span>
                </div>
              );
            })}
            {tasks.length === 0 && <p className="text-xs text-muted">No expected tasks.</p>}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-extrabold uppercase text-muted mb-1.5">Members</div>
          <div className="space-y-1">
            {memberSummaries.map((m, i) => (
              <div
                key={i}
                className="flex justify-between gap-2 text-xs border-b border-border py-1"
              >
                <span className="text-ink font-semibold">
                  {String(m.display_name || 'Unknown')}
                </span>
                <span className="text-muted">
                  {m.avg_overall != null ? (
                    <>
                      quality{' '}
                      <span style={{ color: scoreColor(num(m.avg_overall) ?? 0) }}>
                        {String(m.avg_overall)}
                      </span>
                      {m.avg_role_fit != null && <> · fit {String(m.avg_role_fit)}</>}
                      <> · {String(m.graded_items ?? 0)} graded</>
                    </>
                  ) : (
                    'no graded output'
                  )}
                </span>
              </div>
            ))}
            {memberSummaries.length === 0 && members.length === 0 && (
              <p className="text-xs text-muted">No members recorded.</p>
            )}
          </div>
          {intel.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-extrabold uppercase text-muted mb-1.5">
                Intel involvement
              </div>
              <IntelFlowStrip
                items={intel.map((i) => ({
                  ...i,
                  holder_team: i.role === 'holder' ? data.team_name : undefined,
                }))}
              />
            </div>
          )}
        </div>
      </div>

      {(best || worst) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {best && (
            <blockquote
              className="border-l-2 pl-3 py-2 bg-surface-2 rounded-r-lg"
              style={{ borderColor: '#15803D' }}
            >
              <p className="text-xs text-ink italic">“{String(best.content || '')}”</p>
              <div className="text-[9px] text-muted mt-1 font-bold">
                Best artifact · overall {String(best.overall ?? '—')}
              </div>
            </blockquote>
          )}
          {worst && (
            <blockquote
              className="border-l-2 pl-3 py-2 bg-surface-2 rounded-r-lg"
              style={{ borderColor: '#D97706' }}
            >
              <p className="text-xs text-ink italic">“{String(worst.content || '')}”</p>
              <div className="text-[9px] text-muted mt-1 font-bold">
                Growth artifact · overall {String(worst.overall ?? '—')}
              </div>
            </blockquote>
          )}
        </div>
      )}

      {outOfLane.length > 0 && (
        <div>
          <div className="text-[10px] font-extrabold uppercase text-warning mb-1.5">
            Out-of-lane moments
          </div>
          <div className="space-y-1">
            {outOfLane.map((o, i) => (
              <div key={i} className="text-xs text-ink">
                <span className="text-brand font-bold">T+{String(o.t_plus_min ?? '?')}m</span>{' '}
                <span className="font-semibold">{String(o.author || '')}</span>:{' '}
                {String(o.content || '')}
                {o.role_fit != null && (
                  <span className="text-muted"> (role fit {String(o.role_fit)})</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {members.length > 0 && (
        <details>
          <summary className="text-[10px] font-extrabold uppercase text-muted cursor-pointer">
            Full member action log ({members.reduce((s, m) => s + arr(m.entries).length, 0)}{' '}
            entries)
          </summary>
          <div className="mt-2 space-y-3">
            {members.map((m, i) => (
              <div key={i}>
                <div className="text-xs font-bold text-brand">{String(m.display_name)}</div>
                <div className="space-y-0.5 mt-1">
                  {arr(m.entries).map((e, j) => (
                    <div key={j} className="text-[10px] text-ink flex gap-2">
                      <span className="text-brand font-bold whitespace-nowrap">
                        T+{String(e.t_plus_min ?? '?')}m
                      </span>
                      <span className="text-muted whitespace-nowrap">
                        {String(e.action_type || e.kind || '')}
                      </span>
                      <span className="min-w-0 break-words">
                        {String(e.content || '')}
                        {e.overall != null && (
                          <span className="text-muted"> · grade {String(e.overall)}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function SocialExecutiveSectionData({ data }: { data: Dict }) {
  const counts = (data.headline_counts || {}) as Record<string, unknown>;
  const entries = Object.entries(counts).filter(([, v]) => typeof v === 'number');
  if (entries.length === 0) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {entries.map(([k, v]) => (
        <div key={k} className="bg-surface border border-border rounded-lg p-3">
          <div className="text-[9px] font-bold uppercase text-muted">{k.replace(/_/g, ' ')}</div>
          <div className="text-lg font-extrabold text-brand">{String(v)}</div>
        </div>
      ))}
    </div>
  );
}
