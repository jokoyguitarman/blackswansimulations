import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { artFor } from '../../lib/scenarioArt';
import { WrIcon } from '../UI/WarRoomIcon';

/*
 * Create-session modal — Situation Map design. Logic unchanged: credit check (admins bypass),
 * create → onSuccess → onClose → navigate to the new session. The scenario picker is a
 * searchable list of poster rows instead of a <select>.
 */

export interface CreateSessionScenario {
  id: string;
  title: string;
  category?: string;
  description?: string;
  duration_minutes?: number;
  is_active?: boolean;
}

interface CreateSessionModalProps {
  scenarios: CreateSessionScenario[];
  onClose: () => void;
  onSuccess: () => void;
  /** Preselect a scenario (the library's Launch button arrives with `?create=<id>`). */
  initialScenarioId?: string;
}

export const CreateSessionModal = ({
  scenarios,
  onClose,
  onSuccess,
  initialScenarioId,
}: CreateSessionModalProps) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdminUser = user?.role === 'admin';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    scenario_id: initialScenarioId ?? '',
    scheduled_start_time: '',
    trainer_instructions: '',
  });
  const [query, setQuery] = useState('');

  // Payment portal: creating a session consumes one session credit (2 are
  // granted per paid invoice - a pre- and a post-training game). Admins
  // bypass. Server enforces regardless; this is UX.
  const [sessionCredits, setSessionCredits] = useState<number | null>(null);
  useEffect(() => {
    if (isAdminUser) return;
    api.billing
      .getCredits()
      .then((res) => setSessionCredits(res.data.session))
      .catch(() => setSessionCredits(null)); // unknown -> don't block; server enforces
  }, [isAdminUser]);

  const outOfCredits = !isAdminUser && sessionCredits === 0;

  const selected = scenarios.find((s) => s.id === formData.scenario_id) ?? null;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? scenarios.filter(
          (s) =>
            s.title.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
        )
      : scenarios;
    // keep the selected one visible even when filtered out
    if (selected && !list.some((s) => s.id === selected.id)) return [selected, ...list];
    return list;
  }, [scenarios, query, selected]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.scenario_id) return;

    setLoading(true);
    setError(null);
    try {
      const result = await api.sessions.create({
        scenario_id: formData.scenario_id,
        scheduled_start_time: formData.scheduled_start_time || undefined,
        trainer_instructions: formData.trainer_instructions || undefined,
      });
      const session = result.data as { id: string };
      onSuccess();
      onClose();
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      console.error('Failed to create session:', err);
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message.includes('session credit')) {
        setSessionCredits(0);
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const isSocial = (s: CreateSessionScenario) => s.category === 'social_media_crisis';

  return (
    <div className="wr-sheet flex items-start justify-center p-4 sm:p-6" onClick={onClose}>
      <div
        className="wr-detail w-full flex flex-col"
        style={{ maxWidth: 880, margin: '12px auto', maxHeight: 'calc(100vh - 48px)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-session-title"
      >
        <div className="wr-bar" style={{ position: 'static' }}>
          <span className="t" id="create-session-title">
            Create a session
          </span>
          {!isAdminUser && sessionCredits !== null && (
            <span className={`lockpill ${sessionCredits > 0 ? '' : 'locked'}`}>
              <WrIcon name={sessionCredits > 0 ? 'play' : 'lock'} /> {sessionCredits} session credit
              {sessionCredits === 1 ? '' : 's'}
            </span>
          )}
          <span className="grow" />
          <button
            type="button"
            className="wr-btn sm onDark icon"
            onClick={onClose}
            aria-label="Close"
          >
            <WrIcon name="x" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 bg-surface">
          <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-5">
            {outOfCredits && (
              <div className="wr-lockstrip locked">
                <WrIcon name="lock" size={16} className="mt-0.5 text-accent-strong" />
                <div>
                  <div className="font-bold">No session credits left</div>
                  <div className="text-muted">
                    Session credits are granted when a client pays an engagement invoice (2 per
                    engagement — a pre- and a post-training game).{' '}
                    <Link to="/clients" className="font-semibold text-brand underline">
                      Go to Clients &amp; billing →
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {error && !outOfCredits && (
              <div
                className="wr-lockstrip"
                style={{
                  background: 'color-mix(in srgb, var(--danger) 7%, #fff)',
                  borderColor: 'color-mix(in srgb, var(--danger) 35%, #fff)',
                }}
              >
                <WrIcon name="alert" size={16} className="mt-0.5 text-danger" />
                <div className="text-danger">{error}</div>
              </div>
            )}

            {/* scenario picker */}
            <div>
              <div className="flex items-center gap-3 mb-2">
                <label className="wr-lbl m-0">Scenario</label>
                <label className="wr-search ml-auto" style={{ flex: '0 1 320px' }}>
                  <WrIcon name="search" />
                  <input
                    className="wr-field"
                    style={{ padding: '7px 10px 7px 34px', fontSize: 12.5 }}
                    placeholder={`Search ${scenarios.length} scenarios…`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </div>
              <div
                className="border border-border rounded-2xl overflow-y-auto bg-surface"
                style={{ maxHeight: 300 }}
                role="listbox"
                aria-label="Scenario"
              >
                {visible.length === 0 && (
                  <div className="text-xs text-muted p-4">No scenarios match.</div>
                )}
                {visible.map((s) => {
                  const on = s.id === formData.scenario_id;
                  return (
                    <button
                      type="button"
                      key={s.id}
                      role="option"
                      aria-selected={on}
                      onClick={() => setFormData({ ...formData, scenario_id: s.id })}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-border last:border-b-0 transition-colors hover:bg-surface-2"
                      style={
                        on
                          ? ({
                              background: 'color-mix(in srgb, var(--accent) 8%, #fff)',
                              boxShadow: 'inset 3px 0 0 var(--accent)',
                            } as CSSProperties)
                          : undefined
                      }
                    >
                      <img
                        className="wr-thumb"
                        src={artFor(
                          {
                            id: s.id,
                            category: s.category,
                            title: s.title,
                            description: s.description,
                          },
                          'sm',
                        )}
                        alt=""
                        loading="lazy"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-ink text-sm truncate">{s.title}</div>
                        <div className="text-[11px] text-muted flex items-center gap-1.5">
                          <WrIcon name={isSocial(s) ? 'phone' : 'map'} size={11} />
                          {isSocial(s) ? 'Corporate crisis' : 'Field operations'}
                          {s.duration_minutes ? ` · ${s.duration_minutes} min` : ''}
                          {s.is_active === false ? ' · draft' : ''}
                        </div>
                      </div>
                      <span
                        className="wr-tile flex-none"
                        style={
                          {
                            width: 24,
                            height: 24,
                            borderRadius: 999,
                            '--g': on ? 'var(--accent)' : 'var(--border-strong)',
                            visibility: on ? 'visible' : 'hidden',
                          } as CSSProperties
                        }
                      >
                        <WrIcon name="check" size={13} />
                      </span>
                    </button>
                  );
                })}
              </div>
              {selected && (
                <div className="wr-help">
                  Selected: <b className="text-ink">{selected.title}</b>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="wr-lbl" htmlFor="cs-time">
                  Scheduled start (optional)
                </label>
                <input
                  id="cs-time"
                  type="datetime-local"
                  value={formData.scheduled_start_time}
                  onChange={(e) =>
                    setFormData({ ...formData, scheduled_start_time: e.target.value })
                  }
                  className="wr-field"
                />
                <p className="wr-help">
                  Participants see this time in their invitation. You can start early if needed.
                </p>
              </div>
              <div className="wr-node" style={{ '--g': 'var(--brand)' } as CSSProperties}>
                <div className="kicker">
                  <WrIcon name="info" size={12} /> What happens next
                </div>
                <ul className="text-xs text-muted space-y-1 m-0 p-0 list-none">
                  <li>· A lobby opens with a join link for participants.</li>
                  <li>· You assign players to teams (or fill seats with AI teammates).</li>
                  <li>· AI-operated organisations and pressure groups run themselves.</li>
                </ul>
              </div>
            </div>

            <div>
              <label className="wr-lbl" htmlFor="cs-instructions">
                Trainer instructions (optional)
              </label>
              <textarea
                id="cs-instructions"
                value={formData.trainer_instructions}
                onChange={(e) => setFormData({ ...formData, trainer_instructions: e.target.value })}
                className="wr-field"
                rows={4}
                placeholder="Final instructions for participants before the session starts…"
                maxLength={5000}
              />
              <p className="wr-help">Visible in the lobby before the session starts.</p>
            </div>
          </div>

          <div className="wr-ctabar" style={{ margin: 0, borderRadius: 0 }}>
            <span className="hint">
              {!isAdminUser && sessionCredits !== null && sessionCredits > 0
                ? `Creating this session uses 1 of ${sessionCredits} session credit${sessionCredits === 1 ? '' : 's'}.`
                : isAdminUser
                  ? 'Admin — no session credit is consumed.'
                  : ''}
            </span>
            <span className="grow" />
            <button type="button" onClick={onClose} className="wr-btn ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !formData.scenario_id || outOfCredits}
              className="wr-btn accent lg"
            >
              <WrIcon name="play" /> {loading ? 'Creating…' : 'Create session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
