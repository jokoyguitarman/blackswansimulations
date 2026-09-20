import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type DecisionOptionView, type DecisionSpaceView } from '../../../lib/api';
import { useWebSocket } from '../../../hooks/useWebSocket';

export type DecisionsAppVariant = 'mobile' | 'desktop';

const SEVERITY_COLOR: Record<string, string> = {
  low: '#34C759',
  medium: '#FF9F0A',
  high: '#FF6B35',
  critical: '#FF3B30',
};

function statusColor(status: 'open' | 'met' | 'lapsed'): string {
  return status === 'met' ? '#34C759' : status === 'lapsed' ? '#FF3B30' : '#FF9F0A';
}

/**
 * Executive decisions — record a business decision from the scenario's decision space and watch
 * the SOP obligations it creates. Visible only to Executive-team players (and trainers).
 */
export function DecisionsApp({ variant }: { variant: DecisionsAppVariant }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const isMobile = variant === 'mobile';

  const [space, setSpace] = useState<DecisionSpaceView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'forbidden' | 'error'>(
    'loading',
  );
  const [selected, setSelected] = useState<DecisionOptionView | null>(null);
  const [scope, setScope] = useState('');
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const showToast = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 2600);
  };

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await api.sessions.decisionSpace(sessionId);
      setSpace(res.data);
      setState('ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('decision_layer_not_enabled')) setState('unavailable');
      else if (msg.toLowerCase().includes('executive') || msg.includes('403'))
        setState('forbidden');
      else setState('error');
    }
    try {
      const s = await api.sessions.get(sessionId);
      const row = (s.data ?? s) as { start_time?: string; started_at?: string };
      const start = row.start_time ?? row.started_at;
      if (start)
        setElapsed(Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 60000)));
    } catch {
      /* elapsed is cosmetic */
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  useWebSocket({
    sessionId: sessionId || '',
    eventTypes: ['decision.recorded', 'inject.published'],
    onEvent: () => void load(),
    enabled: !!sessionId,
  });

  const recorded = useMemo(() => (space?.options ?? []).filter((o) => o.recorded), [space]);
  const available = useMemo(() => (space?.options ?? []).filter((o) => !o.recorded), [space]);

  const submit = async () => {
    if (!sessionId || !selected) return;
    setSubmitting(true);
    try {
      await api.sessions.recordDecision(sessionId, {
        decision_key: selected.decision_key,
        scope: scope.trim() || undefined,
        rationale: rationale.trim() || undefined,
      });
      showToast('Decision recorded and communicated to your organisation');
      setSelected(null);
      setScope('');
      setRationale('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setSubmitting(false);
    }
  };

  const bg = '#F2F2F7';
  const card: React.CSSProperties = {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: '12px 14px',
    boxShadow: '0 1px 0 rgba(60,60,67,0.12)',
  };

  return (
    <div
      className="h-full flex flex-col relative"
      style={{ backgroundColor: bg, color: '#1C1C1E' }}
    >
      <div
        className="flex items-center justify-between px-4 flex-shrink-0 ios-blur-nav"
        style={{
          height: 44,
          backgroundColor: 'rgba(242,242,247,0.92)',
          borderBottom: '0.5px solid rgba(60,60,67,0.29)',
        }}
      >
        {isMobile ? (
          <button
            onClick={() =>
              selected ? setSelected(null) : navigate(`/sim/${sessionId}/device/home`)
            }
            className="text-[17px] ios-btn-bounce"
            style={{ color: '#007AFF' }}
          >
            {selected ? 'Back' : 'Home'}
          </button>
        ) : (
          <span style={{ width: 48 }} />
        )}
        <span className="text-[17px] font-semibold">
          {selected ? 'Record decision' : 'Decisions'}
        </span>
        <span
          className="text-[13px]"
          style={{ color: '#8E8E93', minWidth: 48, textAlign: 'right' }}
        >
          {elapsed != null ? `T+${elapsed}` : ''}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {state === 'loading' && (
          <p className="text-center text-[13px] py-10" style={{ color: '#8E8E93' }}>
            Loading…
          </p>
        )}
        {state === 'unavailable' && (
          <div style={card}>
            <p className="text-[15px] font-semibold">No decisions to take in this exercise</p>
            <p className="text-[13px] mt-1" style={{ color: '#8E8E93' }}>
              This scenario does not include an executive decision layer.
            </p>
          </div>
        )}
        {state === 'forbidden' && (
          <div style={card}>
            <p className="text-[15px] font-semibold">Executive team only</p>
            <p className="text-[13px] mt-1" style={{ color: '#8E8E93' }}>
              Business decisions are recorded by the Executive team. Your team will be notified of
              any decision that creates obligations for you.
            </p>
          </div>
        )}
        {state === 'error' && (
          <div style={card}>
            <p className="text-[15px] font-semibold">Could not load decisions</p>
          </div>
        )}

        {state === 'ready' && space && !selected && (
          <>
            {space.is_trainer && (
              <p className="text-[12px] px-1" style={{ color: '#8E8E93' }}>
                Trainer view — decisions are recorded by Executive players. Recorded decisions and
                their obligations appear below.
              </p>
            )}

            <h2
              className="text-[12px] font-semibold uppercase tracking-wide px-1"
              style={{ color: '#8E8E93' }}
            >
              Available decisions ({available.length})
            </h2>
            {available.length === 0 && (
              <div style={card}>
                <p className="text-[13px]" style={{ color: '#8E8E93' }}>
                  Every decision in this exercise has been recorded.
                </p>
              </div>
            )}
            {available.map((o) => (
              <button
                key={o.decision_key}
                style={{
                  ...card,
                  width: '100%',
                  textAlign: 'left',
                  opacity: o.decidable ? 1 : 0.6,
                }}
                disabled={!o.decidable}
                onClick={() => setSelected(o)}
                className="ios-btn-bounce"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-semibold">{o.title}</span>
                  <span
                    className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                    style={{
                      color: '#fff',
                      backgroundColor: SEVERITY_COLOR[o.severity] || '#8E8E93',
                    }}
                  >
                    {o.severity}
                  </span>
                </div>
                {o.description && (
                  <p className="text-[13px] mt-1 leading-snug" style={{ color: '#3A3A3C' }}>
                    {o.description}
                  </p>
                )}
                <p className="text-[12px] mt-2" style={{ color: '#8E8E93' }}>
                  {o.sop_obligations.length > 0
                    ? `Creates ${o.sop_obligations.length} obligation${o.sop_obligations.length === 1 ? '' : 's'}: ${o.sop_obligations
                        .map((s) => `${s.by_function} within ${s.window_minutes} min`)
                        .join(' · ')}`
                    : 'No follow-up obligations'}
                  {!o.decidable && !space.is_trainer ? ' · not decidable by your organisation' : ''}
                </p>
              </button>
            ))}

            <h2
              className="text-[12px] font-semibold uppercase tracking-wide px-1 pt-2"
              style={{ color: '#8E8E93' }}
            >
              Recorded ({recorded.length})
            </h2>
            {recorded.length === 0 && (
              <div style={card}>
                <p className="text-[13px]" style={{ color: '#8E8E93' }}>
                  Nothing recorded yet.
                </p>
              </div>
            )}
            {recorded.map((o) => {
              const d = o.recorded!;
              return (
                <div key={o.decision_key} style={card}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-semibold">{o.title}</span>
                    <span className="text-[12px]" style={{ color: '#8E8E93' }}>
                      T+{d.recorded_at_minute} · {d.team_name}
                    </span>
                  </div>
                  {d.scope && (
                    <p className="text-[13px] mt-1" style={{ color: '#3A3A3C' }}>
                      <strong>Scope:</strong> {d.scope}
                    </p>
                  )}
                  {d.rationale && (
                    <p className="text-[13px] mt-1" style={{ color: '#3A3A3C' }}>
                      <strong>Rationale:</strong> {d.rationale}
                    </p>
                  )}
                  {d.obligations.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {d.obligations.map((ob) => (
                        <li key={ob.id} className="flex items-start gap-2 text-[12px]">
                          <span
                            className="mt-1 inline-block rounded-full flex-shrink-0"
                            style={{ width: 8, height: 8, backgroundColor: statusColor(ob.status) }}
                            aria-label={ob.status}
                          />
                          <span style={{ color: '#3A3A3C' }}>
                            <strong>{ob.by_function}</strong> →{' '}
                            {ob.stakeholder_name || ob.stakeholder_id}
                            {ob.description ? `: ${ob.description}` : ''} · due T+{ob.due_at_minute}{' '}
                            · <span style={{ color: statusColor(ob.status) }}>{ob.status}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </>
        )}

        {state === 'ready' && selected && (
          <div className="space-y-3">
            <div style={card}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[15px] font-semibold">{selected.title}</span>
                <span
                  className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                  style={{
                    color: '#fff',
                    backgroundColor: SEVERITY_COLOR[selected.severity] || '#8E8E93',
                  }}
                >
                  {selected.severity}
                </span>
              </div>
              {selected.description && (
                <p className="text-[13px] mt-1 leading-snug" style={{ color: '#3A3A3C' }}>
                  {selected.description}
                </p>
              )}
              {selected.sop_obligations.length > 0 && (
                <div className="mt-3">
                  <p
                    className="text-[12px] font-semibold uppercase tracking-wide"
                    style={{ color: '#8E8E93' }}
                  >
                    Obligations this creates
                  </p>
                  <ul className="mt-1 space-y-1">
                    {selected.sop_obligations.map((s, i) => (
                      <li key={i} className="text-[13px]" style={{ color: '#3A3A3C' }}>
                        <strong>{s.by_function}</strong> —{' '}
                        {s.description || 'contact the affected stakeholders'} within{' '}
                        {s.window_minutes} minutes
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div style={card}>
              <label
                className="block text-[12px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: '#8E8E93' }}
              >
                Scope
              </label>
              <textarea
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="Which products, regions or units does this apply to?"
                rows={2}
                className="w-full text-[15px] outline-none resize-none"
                style={{ color: '#1C1C1E', backgroundColor: 'transparent' }}
              />
              <label
                className="block text-[12px] font-semibold uppercase tracking-wide mb-1 mt-3"
                style={{ color: '#8E8E93' }}
              >
                Rationale
              </label>
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Why now, and what you expect it to achieve."
                rows={3}
                className="w-full text-[15px] outline-none resize-none"
                style={{ color: '#1C1C1E', backgroundColor: 'transparent' }}
              />
            </div>

            <button
              onClick={() => void submit()}
              disabled={submitting}
              className="w-full py-3 rounded-[14px] text-[16px] font-semibold ios-btn-bounce"
              style={{ backgroundColor: '#007AFF', color: '#fff', opacity: submitting ? 0.6 : 1 }}
            >
              {submitting ? 'Recording…' : 'Record decision'}
            </button>
            <p className="text-[12px] text-center px-2" style={{ color: '#8E8E93' }}>
              Recording is final. Your organisation&apos;s teams are notified immediately and the
              obligations above start their clock.
            </p>
          </div>
        )}
      </div>

      {toast && (
        <div
          className="absolute left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-[12px]"
          style={{ bottom: 24, background: 'rgba(30,30,30,0.92)', color: '#fff' }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

export function DecisionsAppMobile() {
  return <DecisionsApp variant="mobile" />;
}

export function DecisionsAppDesktop() {
  return <DecisionsApp variant="desktop" />;
}
