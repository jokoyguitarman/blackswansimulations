import { useState, useEffect, type CSSProperties } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import {
  CreateSessionModal,
  type CreateSessionScenario,
} from '../components/Forms/CreateSessionModal';
import { BrandMark } from '../components/BrandMark';
import { WrIcon } from '../components/UI/WarRoomIcon';
import { artFor, SHELL_ART } from '../lib/scenarioArt';

interface Session {
  id: string;
  status: string;
  scenario_id: string;
  trainer_id: string;
  start_time: string | null;
  end_time: string | null;
  join_token?: string;
  scenarios?: {
    title: string;
    category: string;
    difficulty: string;
  };
  trainer?: {
    full_name: string;
  };
  participants?: Array<{
    user_id: string;
    role: string;
    user?: {
      full_name: string;
      role: string;
    };
  }>;
}

export const Sessions = () => {
  const { isTrainer } = useRoleVisibility();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  // `/sessions?create=<scenarioId>` (the library's Launch button) opens the modal preselected.
  const createParam = searchParams.get('create');
  const [showCreateModal, setShowCreateModal] = useState(!!createParam);
  const [scenarios, setScenarios] = useState<CreateSessionScenario[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'scheduled' | 'completed'>(
    'all',
  );

  useEffect(() => {
    const initialize = async () => {
      // Process any pending invitations first (for participants who signed up before trigger fix)
      if (!isTrainer) {
        try {
          await api.sessions.processInvitations();
        } catch (err) {
          // Silently fail - this is just a convenience feature
          console.debug('Failed to process invitations:', err);
        }
      }
      await loadSessions();
      if (isTrainer) {
        loadScenarios();
      }
    };
    initialize();
  }, [isTrainer]);

  const loadSessions = async () => {
    try {
      const result = await api.sessions.list(1, 20);
      if (import.meta.env.DEV) console.log('Sessions API response:', result);
      setSessions((result.data || []) as Session[]);
      if (!result.data || result.data.length === 0) {
        console.warn('No sessions returned from API');
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
      // Show error to user
      alert(`Failed to load sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const loadScenarios = async () => {
    try {
      const result = await api.scenarios.list();
      setScenarios((result.data || []) as CreateSessionScenario[]);
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    }
  };

  const handleStartSession = async (sessionId: string) => {
    try {
      await api.sessions.update(sessionId, { status: 'in_progress' });
      loadSessions();
    } catch (error) {
      console.error('Failed to start session:', error);
      alert('Failed to start session');
    }
  };

  /* ── Situation Map page (spec follow-up: Sessions) — logic above unchanged ─────────────── */

  const isLive = (s: Session) => s.status === 'in_progress' || s.status === 'paused';
  const elapsed = (s: Session) => {
    if (!s.start_time) return 'LIVE';
    const mins = Math.max(0, Math.round((Date.now() - new Date(s.start_time).getTime()) / 60000));
    return `T+${mins}`;
  };
  const fmtWhen = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
  const isSocialSession = (s: Session) => s.scenarios?.category === 'social_media_crisis';
  const artOf = (s: Session) =>
    artFor(
      {
        id: s.scenario_id,
        category: s.scenarios?.category ?? 'custom',
        title: s.scenarios?.title ?? '',
      },
      'sm',
    );

  const q = search.trim().toLowerCase();
  const filtered = sessions.filter((s) => {
    if (statusFilter === 'live' && !isLive(s)) return false;
    if (statusFilter === 'scheduled' && s.status !== 'scheduled') return false;
    if (statusFilter === 'completed' && s.status !== 'completed' && s.status !== 'cancelled')
      return false;
    if (!q) return true;
    return `${s.scenarios?.title ?? ''} ${s.trainer?.full_name ?? ''} ${s.scenarios?.category ?? ''}`
      .toLowerCase()
      .includes(q);
  });
  const live = filtered.filter(isLive);
  const scheduled = filtered.filter((s) => s.status === 'scheduled');
  const done = filtered.filter((s) => s.status === 'completed' || s.status === 'cancelled');
  const counts = {
    live: sessions.filter(isLive).length,
    scheduled: sessions.filter((s) => s.status === 'scheduled').length,
    completed: sessions.filter((s) => s.status === 'completed').length,
    participants: sessions.reduce((n, s) => n + (s.participants?.length ?? 0), 0),
  };

  const statusChip = (s: Session) =>
    isLive(s) ? (
      <span className="live">
        <span className="wr-livedot" /> {s.status === 'paused' ? 'Paused' : 'Live'}
      </span>
    ) : s.status === 'scheduled' ? (
      <span className="live" style={{ color: 'rgba(255,255,255,.8)' }}>
        <WrIcon name="cal" size={11} /> Scheduled
      </span>
    ) : (
      <span className="live" style={{ color: 'rgba(255,255,255,.6)' }}>
        <WrIcon name="check" size={11} /> {s.status === 'cancelled' ? 'Cancelled' : 'Completed'}
      </span>
    );

  const row = (s: Session) => (
    <div key={s.id} className="wr-liverow">
      <div className="band wr-artband">
        <img className="wr-art" src={artOf(s)} alt="" loading="lazy" />
        {statusChip(s)}
        <div className="t">
          {isLive(s)
            ? elapsed(s)
            : s.status === 'scheduled'
              ? (fmtWhen(s.start_time)?.split(',')[0] ?? 'Lobby')
              : (fmtWhen(s.start_time)?.split(',')[0] ?? 'Ended')}
        </div>
      </div>
      <div className="mid">
        <h4 title={s.scenarios?.title}>{s.scenarios?.title || 'Unknown scenario'}</h4>
        <div className="meta">
          <span className="inline-flex items-center gap-1.5">
            <WrIcon name={isSocialSession(s) ? 'phone' : 'map'} size={12} />
            {isSocialSession(s) ? 'Corporate crisis' : 'Field operations'}
          </span>
          {s.scenarios?.difficulty && (
            <>
              <span>·</span>
              <span className="capitalize">{s.scenarios.difficulty}</span>
            </>
          )}
          <span>·</span>
          <span>
            <WrIcon name="tie" size={11} /> {s.trainer?.full_name || 'Unknown trainer'}
          </span>
          {s.participants && (
            <>
              <span>·</span>
              <span>
                <WrIcon name="users" size={11} /> {s.participants.length} participant
                {s.participants.length === 1 ? '' : 's'}
              </span>
            </>
          )}
          {s.join_token?.startsWith('demo-') && <span className="wr-p live">demo</span>}
        </div>
        <div className="text-[11.5px] text-muted mt-2">
          {isLive(s)
            ? `Started ${fmtWhen(s.start_time) ?? '—'}`
            : s.status === 'scheduled'
              ? s.start_time
                ? `Scheduled for ${fmtWhen(s.start_time)}`
                : 'Not scheduled yet — start whenever the lobby is ready'
              : `Ran ${fmtWhen(s.start_time) ?? '—'}${s.end_time ? ` → ${fmtWhen(s.end_time)}` : ''}`}
        </div>
      </div>
      <div className="acts">
        {s.status === 'scheduled' && isTrainer && (
          <button onClick={() => handleStartSession(s.id)} className="wr-btn accent">
            <WrIcon name="play" /> Start
          </button>
        )}
        {(s.status === 'in_progress' ||
          s.status === 'scheduled' ||
          s.status === 'completed' ||
          s.status === 'paused') && (
          <button
            onClick={() => navigate(`/sessions/${s.id}`)}
            className={`wr-btn ${s.status === 'scheduled' && isTrainer ? '' : s.status === 'completed' ? '' : 'accent'}`}
          >
            {s.status === 'completed' ? (
              <>
                <WrIcon name="doc" /> View AAR
              </>
            ) : isLive(s) ? (
              <>
                Join <WrIcon name="arrow" />
              </>
            ) : (
              <>
                <WrIcon name="eye" /> Open lobby
              </>
            )}
          </button>
        )}
        {s.status === 'in_progress' && s.join_token?.startsWith('demo-') && (
          <button
            onClick={() => navigate(`/sessions/${s.id}?spectator=true&mode=cinematic`)}
            className="wr-btn sm danger"
          >
            Spectate
          </button>
        )}
      </div>
    </div>
  );

  const group = (title: string, list: Session[], family: string, sub: string) =>
    list.length > 0 && (
      <section className="mb-6">
        <div className="wr-sech" style={{ '--g': family, margin: '0 0 10px' } as CSSProperties}>
          <h2>
            {title === 'Live now' && <span className="wr-livedot" style={{ color: family }} />}
            {title} <span className="n">{list.length}</span>
          </h2>
          <p>{sub}</p>
        </div>
        <div className="wr-rail">{list.map(row)}</div>
      </section>
    );

  if (loading) {
    return (
      <div className="min-h-screen bg-bg">
        <header className="wr-artband wr-hero">
          <img className="wr-art" src={SHELL_ART.sessions} alt="" />
          <div className="wr-hero-top">
            <div className="wr-brandmark">
              <BrandMark className="h-8 w-8" /> Prophyion
            </div>
          </div>
          <div className="wr-hero-grid">
            <div>
              <div className="wr-eyebrow">Sessions</div>
              <h1>Loading…</h1>
            </div>
          </div>
        </header>
        <main className="wr-wrap">
          <div className="wr-rail">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="wr-liverow">
                <div className="wr-shimmer" style={{ height: 120 }} />
                <div className="mid space-y-2">
                  <div className="wr-shimmer h-4 w-2/3 rounded" />
                  <div className="wr-shimmer h-3 w-full rounded" />
                  <div className="wr-shimmer h-3 w-1/2 rounded" />
                </div>
                <div />
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="wr-artband wr-hero">
        <img className="wr-art" src={SHELL_ART.sessions} alt="" />
        <div className="wr-hero-top">
          <div className="wr-brandmark">
            <BrandMark className="h-8 w-8" /> Prophyion{' '}
            <span className="sub">· {isTrainer ? 'trainer' : 'participant'}</span>
          </div>
          <nav className="wr-nav" aria-label="Primary">
            <Link to="/dashboard">
              <WrIcon name="dash" /> Dashboard
            </Link>
            <Link to="/scenarios">
              <WrIcon name="layers" /> Scenarios
            </Link>
            <Link to="/sessions" className="here">
              <WrIcon name="cal" /> Sessions
            </Link>
            {isTrainer && (
              <>
                <Link to="/clients">
                  <WrIcon name="card" /> Clients &amp; billing
                </Link>
                <Link to="/warroom" className="cta">
                  <WrIcon name="bolt" /> War Room
                </Link>
              </>
            )}
          </nav>
        </div>
        <div
          className="wr-hero-grid"
          style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}
        >
          <div>
            <div className="wr-eyebrow">Sessions</div>
            <h1>
              {counts.live > 0
                ? `${counts.live} exercise${counts.live === 1 ? '' : 's'} running now`
                : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            </h1>
            <p className="lead">
              {isTrainer
                ? 'Every exercise you have scheduled, run or completed. Start a scheduled session from its lobby; completed ones open straight into the after-action review.'
                : 'The exercises you have been invited to. Join a live one, or open a completed one to read its after-action review.'}
            </p>
            {isTrainer && (
              <button onClick={() => setShowCreateModal(true)} className="wr-btn accent lg">
                <WrIcon name="plus" /> Create session
              </button>
            )}
          </div>
          <div className="wr-facts">
            <div className="wr-glass live">
              <b>{counts.live}</b>
              <span>
                <span className="wr-livedot" style={{ color: '#FCD34D' }} /> live now
              </span>
            </div>
            <div className="wr-glass">
              <b>{counts.scheduled}</b>
              <span>
                <WrIcon name="cal" size={12} /> scheduled
              </span>
            </div>
            <div className="wr-glass">
              <b>{counts.completed}</b>
              <span>
                <WrIcon name="check" size={12} /> completed
              </span>
            </div>
            <div className="wr-glass">
              <b>{counts.participants}</b>
              <span>
                <WrIcon name="users" size={12} /> participants
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="wr-wrap">
        <div className="wr-toolbar">
          <label className="wr-search">
            <WrIcon name="search" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions — scenario, trainer…"
              className="wr-field"
            />
          </label>
          <div className="wr-seg" role="tablist" aria-label="Status">
            {(
              [
                ['all', 'All', sessions.length],
                ['live', 'Live', counts.live],
                ['scheduled', 'Scheduled', counts.scheduled],
                ['completed', 'Completed', counts.completed],
              ] as Array<[typeof statusFilter, string, number]>
            ).map(([k, label, n]) => (
              <button
                key={k}
                className={statusFilter === k ? (k === 'live' ? 'on acc' : 'on') : ''}
                onClick={() => setStatusFilter(k)}
              >
                {label} <span className="n">{n}</span>
              </button>
            ))}
          </div>
          <span className="wr-shown">
            <b>{filtered.length}</b> of {sessions.length} shown
          </span>
        </div>

        <div className="mt-6">
          {group(
            'Live now',
            live,
            'var(--accent)',
            'Exercises in progress. Join as trainer or participant.',
          )}
          {group(
            'Scheduled',
            scheduled,
            'var(--brand)',
            'Lobbies waiting to start — assign teams, share the join link, then start.',
          )}
          {group(
            'Completed',
            done,
            'var(--success)',
            'Finished exercises with their after-action reviews.',
          )}
        </div>

        {sessions.length === 0 && (
          <div className="wr-empty" style={{ '--g': 'var(--brand)' } as CSSProperties}>
            <div className="wr-tile">
              <WrIcon name="cal" size={24} />
            </div>
            <div>
              <h4>No sessions yet</h4>
              <p>
                {isTrainer
                  ? 'Create a session from a scenario to get started.'
                  : 'You have not been invited to any sessions yet.'}
              </p>
            </div>
            {isTrainer && (
              <button onClick={() => navigate('/scenarios')} className="wr-btn accent">
                <WrIcon name="layers" /> Browse scenarios
              </button>
            )}
          </div>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <div className="wr-empty" style={{ '--g': 'var(--brand)' } as CSSProperties}>
            <div className="wr-tile">
              <WrIcon name="search" size={24} />
            </div>
            <div>
              <h4>No matches</h4>
              <p>Nothing matches this search or status filter.</p>
            </div>
            <button
              onClick={() => {
                setSearch('');
                setStatusFilter('all');
              }}
              className="wr-btn"
            >
              Clear filters
            </button>
          </div>
        )}
      </main>

      {/* Create Session Modal */}
      {showCreateModal && (
        <CreateSessionModal
          scenarios={scenarios}
          initialScenarioId={createParam ?? undefined}
          onClose={() => {
            setShowCreateModal(false);
            if (createParam) setSearchParams({}, { replace: true });
          }}
          onSuccess={loadSessions}
        />
      )}
    </div>
  );
};
