import { useCallback, useEffect, useState } from 'react';
import { api, type TeammateBotsView, type TeammateBotView } from '../../lib/api';
import { IntellectSlider } from '../Session/IntellectSlider';
import { BotBadge } from '../UI/BotBadge';

/**
 * Trainer-only console for the AI teammates in a live session
 * (docs/ai-teammate-bots-plan.md §10.2): who is playing, what each bot did last,
 * pause / resume, a nudge box, and the same intellect slider as the lobby.
 * Mirrors AdversaryConsole, which does the same for the AI opposition.
 */

const STATUS_META: Record<TeammateBotView['status'], { label: string; color: string }> = {
  idle: { label: 'waiting', color: '#6B7280' },
  acting: { label: 'acting', color: '#047857' },
  paused: { label: 'paused', color: '#B45309' },
  stopped: { label: 'stopped', color: '#B91C1C' },
};

function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.round(ms / 60_000));
  return m === 0 ? 'just now' : `${m}m ago`;
}

export function TeammateConsole({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<TeammateBotsView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nudge, setNudge] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await api.bots.get(sessionId);
      setView(res.data);
      setHidden(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not enabled|404/i.test(msg)) setHidden(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (hidden || !view || view.bots.length === 0) return null;

  const act = async (userId: string, fn: () => Promise<unknown>) => {
    setBusy(userId);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ backgroundColor: '#FFFFFF', borderColor: '#E4DFD4' }}
    >
      <div
        className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider uppercase flex items-center justify-between gap-3"
        style={{ borderColor: '#E4DFD4', color: '#6B7280' }}
      >
        <span>
          Teammate Console ({view.bots.length})
          {!view.running && (
            <span className="ml-2 normal-case tracking-normal font-normal">· not running</span>
          )}
        </span>
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{ backgroundColor: 'rgba(30,58,95,0.10)', color: '#1E3A5F' }}
        >
          allies · LLM {view.llm_budget.used}/{view.llm_budget.limit} this hour
        </span>
      </div>

      <div className="p-4 space-y-3">
        <div
          className="rounded-lg p-3"
          style={{ backgroundColor: '#FAF8F4', border: '1px solid #E4DFD4' }}
        >
          <IntellectSlider
            value={view.intellect}
            compact
            onCommit={async (v) => {
              try {
                await api.bots.setIntellect(sessionId, v);
                setView((cur) => (cur ? { ...cur, intellect: v } : cur));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </div>

        {error && (
          <div className="text-[12px]" style={{ color: '#B91C1C' }}>
            {error}
          </div>
        )}

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
        >
          {view.bots.map((b) => {
            const meta = STATUS_META[b.status];
            const paused = b.status === 'paused';
            const running = b.status !== 'stopped';
            return (
              <div
                key={b.user_id}
                className="rounded-lg p-3"
                style={{
                  backgroundColor: '#FAF8F4',
                  border: '1px solid #E4DFD4',
                  borderLeft: `3px solid ${meta.color}`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-[13px] font-semibold" style={{ color: '#172033' }}>
                      {b.display_name}
                    </span>{' '}
                    <BotBadge />
                    <div className="text-[11px]" style={{ color: '#6B7280' }}>
                      {b.team_name ?? 'unassigned'} ·{' '}
                      <span style={{ color: meta.color }}>{meta.label}</span>
                      {b.stats
                        ? ` · ${b.stats.actions} actions${b.stats.failures ? `, ${b.stats.failures} skipped` : ''}`
                        : ''}
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      act(b.user_id, () =>
                        paused
                          ? api.bots.resume(sessionId, b.user_id)
                          : api.bots.pause(sessionId, b.user_id),
                      )
                    }
                    disabled={busy === b.user_id || !running}
                    className="text-[10px] font-bold uppercase px-2.5 py-1 rounded border disabled:opacity-50"
                    style={
                      paused
                        ? {
                            color: '#047857',
                            borderColor: 'rgba(4,120,87,0.4)',
                            backgroundColor: 'rgba(4,120,87,0.08)',
                          }
                        : {
                            color: '#B45309',
                            borderColor: 'rgba(180,83,9,0.4)',
                            backgroundColor: 'rgba(180,83,9,0.08)',
                          }
                    }
                  >
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                </div>

                {b.stats?.lastAction && (
                  <div className="mt-2 text-[11px]" style={{ color: '#374151' }}>
                    <span className="font-semibold">{b.stats.lastAction.kind}</span> ·{' '}
                    {b.stats.lastAction.summary}
                    <span style={{ color: '#9CA3AF' }}> · {relTime(b.stats.lastAction.at)}</span>
                  </div>
                )}
                {b.stats?.lastError && !b.stats.lastAction && (
                  <div className="mt-2 text-[11px]" style={{ color: '#B45309' }}>
                    last issue: {b.stats.lastError.slice(0, 120)}
                  </div>
                )}

                {running && (
                  <div className="mt-2 flex gap-1">
                    <input
                      value={nudge[b.user_id] ?? ''}
                      onChange={(e) => setNudge((s) => ({ ...s, [b.user_id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (nudge[b.user_id] ?? '').trim()) {
                          void act(b.user_id, async () => {
                            await api.bots.nudge(sessionId, b.user_id, nudge[b.user_id].trim());
                            setNudge((s) => ({ ...s, [b.user_id]: '' }));
                          });
                        }
                      }}
                      placeholder={`Tell ${b.display_name.split(' ')[0]} what to do…`}
                      className="flex-1 text-[12px] px-2 py-1 rounded outline-none"
                      style={{
                        backgroundColor: '#FFFFFF',
                        border: '1px solid #E4DFD4',
                        color: '#172033',
                      }}
                    />
                    <button
                      onClick={() =>
                        act(b.user_id, async () => {
                          await api.bots.nudge(
                            sessionId,
                            b.user_id,
                            (nudge[b.user_id] ?? '').trim(),
                          );
                          setNudge((s) => ({ ...s, [b.user_id]: '' }));
                        })
                      }
                      disabled={busy === b.user_id || !(nudge[b.user_id] ?? '').trim()}
                      className="text-[11px] font-bold px-3 py-1 rounded disabled:opacity-50"
                      style={{ backgroundColor: '#1E3A5F', color: '#fff' }}
                    >
                      Nudge
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
