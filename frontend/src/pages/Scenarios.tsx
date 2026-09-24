import { useState, useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import {
  listScenariosWithSummary,
  getSessionCredits,
  getScenarioInjectsPeek,
  getScenarioTeamsPeek,
  type LibraryScenario,
  type ScenarioSummaryOrg,
  type PeekInject,
  type PeekTeam,
} from '../lib/scenarioLibraryApi';
import { artFor, SHELL_ART } from '../lib/scenarioArt';
import { WrIcon, teamIcon } from '../components/UI/WarRoomIcon';
import { OriginBadge } from '../components/UI/OriginBadge';
import { countryCode, initialsOf } from '../components/UI/Collapsible';
import { BrandMark } from '../components/BrandMark';
import { ScenarioDetailView } from '../components/Scenario/ScenarioDetailView';

/*
 * Scenario library — Situation Map design (docs/design/warroom/scenario-library.html,
 * IMPLEMENTATION_SPEC.md §3). Logic preserved from the previous page: list load, trainer /
 * participant split, search + type filter, delete, detail view mount, participant brief modal.
 */

type Scenario = LibraryScenario;
type TypeFilter = 'all' | 'field' | 'social';
type StatusFilter = 'all' | 'active' | 'draft' | 'live' | 'locked';
type SortKey = 'compiled' | 'run' | 'sessions' | 'az';
type LockState = 'editable' | 'locked-live' | 'locked-credits' | 'draft';

const isSocial = (s: Scenario) => s.category === 'social_media_crisis';

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

const elapsedLabel = (startedAt: string | null | undefined) => {
  if (!startedAt) return 'LIVE';
  const mins = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
  return `T+${mins}`;
};

const orgClass = (o: ScenarioSummaryOrg) =>
  o.side === 'pressure'
    ? 'pr'
    : o.side === 'antagonist'
      ? 'rv'
      : o.operation === 'ai'
        ? 'ai'
        : 'hq';

const orgIcon = (o: ScenarioSummaryOrg) => {
  if (o.side === 'antagonist') return 'swords' as const;
  if (o.side === 'pressure') {
    if (o.kind === 'union') return 'fist' as const;
    if (o.kind === 'ngo') return 'leaf' as const;
    if (o.kind === 'community_group') return 'community' as const;
    if (o.kind === 'political') return 'podium' as const;
    return 'landmark' as const;
  }
  return null;
};

/** Cast chips for a card, derived from the summary registry (falls back to the country). */
const CastChips = ({ s, onDark = false }: { s: Scenario; onDark?: boolean }) => {
  const orgs = s.summary?.orgs ?? [];
  if (orgs.length === 0) {
    const country = s.country;
    if (!country) return null;
    return (
      <div className={`wr-cast ${onDark ? 'onDark' : ''}`}>
        <span className="o hq">
          <span className="wr-cc">{countryCode(country)}</span> {country}
        </span>
      </div>
    );
  }
  return (
    <div className={`wr-cast ${onDark ? 'onDark' : ''}`}>
      {orgs.slice(0, 5).map((o) => {
        const icon = orgIcon(o);
        return (
          <span key={o.org_key} className={`o ${orgClass(o)}`} title={o.name}>
            {icon ? (
              <WrIcon name={icon} size={12} />
            ) : (
              <span className={`wr-cc ${onDark ? 'dark' : ''}`}>{countryCode(o.country)}</span>
            )}
            {o.name}
            {o.is_primary && ' · HQ'}
            {o.operation === 'ai' && o.side === 'protagonist' && ' · AI'}
          </span>
        );
      })}
      {orgs.length > 5 && <span className="o">+{orgs.length - 5}</span>}
    </div>
  );
};

const Kpis = ({ s, onDark = false }: { s: Scenario; onDark?: boolean }) => {
  const sum = s.summary;
  const social = isSocial(s);
  const items: Array<[number | string, string]> = social
    ? [
        [sum?.teams ?? '—', 'teams'],
        [sum?.contacts ?? '—', 'contacts'],
        [sum?.injects ?? '—', 'injects'],
        [s.duration_minutes, 'min'],
      ]
    : [
        [sum?.teams ?? '—', 'teams'],
        [s.objectives?.length ?? 0, 'objectives'],
        [sum?.injects ?? '—', 'injects'],
        [s.duration_minutes, 'min'],
      ];
  return (
    <div className={`wr-kpis ${onDark ? 'onDark' : ''}`}>
      {items.map(([v, l]) => (
        <div key={l}>
          <b>{v}</b>
          <span>{l}</span>
        </div>
      ))}
    </div>
  );
};

export const Scenarios = () => {
  const { isTrainer } = useRoleVisibility();
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [detailScenarioId, setDetailScenarioId] = useState<string | null>(null);

  // Search + filters (sticky toolbar)
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('compiled');
  const [view, setView] = useState<'cards' | 'list'>('cards');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sessionCredits, setSessionCredits] = useState<number | null>(null);

  useEffect(() => {
    loadScenarios();
  }, []);

  useEffect(() => {
    if (!isTrainer) return;
    getSessionCredits().then(setSessionCredits);
  }, [isTrainer]);

  const loadScenarios = async () => {
    try {
      const data = await listScenariosWithSummary();
      setScenarios(data);
    } catch (error) {
      console.error('Failed to load scenarios:', error);
    } finally {
      setLoading(false);
    }
  };

  const lockState = useCallback(
    (s: Scenario): LockState => {
      if (s.summary?.live_session_id) return 'locked-live';
      if (!s.is_active) return 'draft';
      if (sessionCredits === 0) return 'locked-credits';
      return 'editable';
    },
    [sessionCredits],
  );

  const counts = useMemo(() => {
    const c = {
      all: scenarios.length,
      social: 0,
      field: 0,
      active: 0,
      draft: 0,
      live: 0,
      locked: 0,
    };
    for (const s of scenarios) {
      if (isSocial(s)) c.social++;
      else c.field++;
      if (s.is_active) c.active++;
      else c.draft++;
      const l = lockState(s);
      if (l === 'locked-live') c.live++;
      if (l === 'locked-live' || l === 'locked-credits') c.locked++;
    }
    return c;
  }, [scenarios, lockState]);

  const filteredScenarios = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = scenarios.filter((s) => {
      const social = isSocial(s);
      if (typeFilter === 'field' && social) return false;
      if (typeFilter === 'social' && !social) return false;
      const l = lockState(s);
      if (statusFilter === 'active' && !s.is_active) return false;
      if (statusFilter === 'draft' && s.is_active) return false;
      if (statusFilter === 'live' && l !== 'locked-live') return false;
      if (statusFilter === 'locked' && l !== 'locked-live' && l !== 'locked-credits') return false;
      if (!q) return true;
      const orgText = (s.summary?.orgs ?? [])
        .map((o) => `${o.name} ${o.country ?? ''}`)
        .join(' ')
        .toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        orgText.includes(q) ||
        (s.country ?? '').toLowerCase().includes(q)
      );
    });
    const by: Record<SortKey, (a: Scenario, b: Scenario) => number> = {
      compiled: (a, b) => b.created_at.localeCompare(a.created_at),
      run: (a, b) =>
        (b.summary?.last_session_at ?? '').localeCompare(a.summary?.last_session_at ?? ''),
      sessions: (a, b) => (b.summary?.sessions_run ?? 0) - (a.summary?.sessions_run ?? 0),
      az: (a, b) => a.title.localeCompare(b.title),
    };
    return [...list].sort(by[sort]);
  }, [scenarios, search, typeFilter, statusFilter, sort, lockState]);

  const liveScenarios = useMemo(
    () => scenarios.filter((s) => s.summary?.live_session_id),
    [scenarios],
  );

  const [deleting, setDeleting] = useState<string | null>(null);

  const handleViewScenario = (scenario: Scenario) => {
    if (isTrainer) {
      setDetailScenarioId(scenario.id);
    } else {
      setSelectedScenario(scenario);
    }
  };

  const handleDeleteScenario = async (e: React.MouseEvent, scenario: Scenario) => {
    e.stopPropagation();
    if (
      !window.confirm(
        `Delete "${scenario.title}" and ALL related sessions, injects, teams, and locations? This cannot be undone.`,
      )
    )
      return;
    setDeleting(scenario.id);
    try {
      await api.scenarios.delete(scenario.id);
      setScenarios((prev) => prev.filter((s) => s.id !== scenario.id));
      if (expandedId === scenario.id) setExpandedId(null);
    } catch (err) {
      console.error('Failed to delete scenario:', err);
      alert('Failed to delete scenario. Check the console for details.');
    } finally {
      setDeleting(null);
    }
  };

  const launch = (s: Scenario) => {
    const live = s.summary?.live_session_id;
    if (live) navigate(`/sessions/${live}`);
    else navigate(`/sessions?create=${s.id}`);
  };

  const clearFilters = () => {
    setSearch('');
    setTypeFilter('all');
    setStatusFilter('all');
  };

  const filtersActive = !!search || typeFilter !== 'all' || statusFilter !== 'all';

  /* ── loading ─────────────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-screen bg-bg">
        <header className="wr-artband wr-hero">
          <img className="wr-art" src={SHELL_ART.library} alt="" />
          <div className="wr-hero-top">
            <div className="wr-brandmark">
              <BrandMark className="h-8 w-8" /> Prophyion
            </div>
          </div>
          <div className="wr-hero-grid">
            <div>
              <div className="wr-eyebrow">Scenario library</div>
              <h1>Loading…</h1>
            </div>
          </div>
        </header>
        <main className="wr-wrap">
          <div className="wr-posters">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="wr-poster">
                <div className="wr-shimmer" style={{ height: 168 }} />
                <div className="body">
                  <div className="wr-shimmer h-4 w-2/3 rounded" />
                  <div className="wr-shimmer h-3 w-full rounded" />
                  <div className="wr-shimmer h-10 w-full rounded" />
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  /* ── page ────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-bg">
      <header className="wr-artband wr-hero">
        <img className="wr-art" src={SHELL_ART.library} alt="" />
        <div className="wr-hero-top">
          <div className="wr-brandmark">
            <BrandMark className="h-8 w-8" /> Prophyion{' '}
            <span className="sub">· {isTrainer ? 'trainer' : 'participant'}</span>
          </div>
          <nav className="wr-nav" aria-label="Primary">
            <Link to="/dashboard">
              <WrIcon name="dash" /> Dashboard
            </Link>
            <Link to="/scenarios" className="here">
              <WrIcon name="layers" /> Scenarios
            </Link>
            <Link to="/sessions">
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
            <div className="wr-eyebrow">Scenario library</div>
            <h1>
              {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''}
              {isTrainer ? ', ready to run' : ' available'}
            </h1>
            <p className="lead">
              {isTrainer
                ? 'Everything the War Room has built. Cards open in place; the full view has the cast, injects and fact sheet. Editing locks while a session is live or when you are out of session credits.'
                : 'Scenarios your trainer has published. Open one to read its brief.'}
            </p>
          </div>
          <div className="wr-facts">
            <div className="wr-glass">
              <b>{counts.social}</b>
              <span>
                <WrIcon name="phone" size={12} /> corporate
              </span>
            </div>
            <div className="wr-glass">
              <b>{counts.field}</b>
              <span>
                <WrIcon name="map" size={12} /> field ops
              </span>
            </div>
            <div className="wr-glass live">
              <b>{counts.live}</b>
              <span>
                <span className="wr-livedot" style={{ color: '#FCD34D' }} /> live now
              </span>
            </div>
            {isTrainer && sessionCredits !== null && (
              <div className="wr-glass">
                <b>{sessionCredits}</b>
                <span>
                  <WrIcon name="play" size={12} /> session credits
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="wr-wrap">
        {/* toolbar */}
        <div className="wr-toolbar">
          <label className="wr-search">
            <WrIcon name="search" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${scenarios.length} scenarios — title, organisation, country…`}
              className="wr-field"
            />
          </label>
          <div className="wr-seg" role="tablist" aria-label="Scenario type">
            <button
              className={typeFilter === 'all' ? 'on' : ''}
              onClick={() => setTypeFilter('all')}
            >
              All <span className="n">{counts.all}</span>
            </button>
            <button
              className={typeFilter === 'social' ? 'on acc' : ''}
              onClick={() => setTypeFilter('social')}
            >
              <WrIcon name="phone" size={12} /> Corporate crisis{' '}
              <span className="n">{counts.social}</span>
            </button>
            <button
              className={typeFilter === 'field' ? 'on' : ''}
              onClick={() => setTypeFilter('field')}
            >
              <WrIcon name="map" size={12} /> Field ops <span className="n">{counts.field}</span>
            </button>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {(
              [
                ['active', 'Active', counts.active, 'var(--success)'],
                ['draft', 'Draft', counts.draft, 'var(--muted)'],
                ['live', 'Live', counts.live, 'var(--accent)'],
                ['locked', 'Locked', counts.locked, 'var(--accent-strong)'],
              ] as Array<[StatusFilter, string, number, string]>
            ).map(([key, label, n, colour]) => (
              <button
                key={key}
                className={`wr-fchip ${statusFilter === key ? 'on' : ''}`}
                onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
              >
                {key === 'locked' ? (
                  <WrIcon name="lock" size={12} />
                ) : (
                  <span className="dot" style={{ color: colour }} />
                )}
                {label} {n}
              </button>
            ))}
          </div>
          <label className="wr-sort">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="compiled">Recently compiled</option>
              <option value="run">Recently run</option>
              <option value="sessions">Most sessions</option>
              <option value="az">A – Z</option>
            </select>
          </label>
          <div className="wr-view" role="group" aria-label="View">
            <button
              className={view === 'cards' ? 'on' : ''}
              onClick={() => setView('cards')}
              title="Cards"
              aria-label="Card view"
            >
              <WrIcon name="grid" />
            </button>
            <button
              className={view === 'list' ? 'on' : ''}
              onClick={() => setView('list')}
              title="List"
              aria-label="List view"
            >
              <WrIcon name="list" />
            </button>
          </div>
          <span className="wr-shown">
            <b>{filteredScenarios.length}</b> of {scenarios.length} shown
          </span>
        </div>

        {/* live rail */}
        {liveScenarios.length > 0 && statusFilter !== 'draft' && (
          <section>
            <div className="wr-sech" style={{ '--g': 'var(--accent)' } as CSSProperties}>
              <h2>
                <span className="wr-livedot" style={{ color: 'var(--accent)' }} /> Live now{' '}
                <span className="n">{liveScenarios.length}</span>
              </h2>
              <p>
                Sessions in progress. Their scenarios are locked for editing until the session ends.
              </p>
              <Link className="more" to="/sessions">
                All sessions →
              </Link>
            </div>
            <div className="wr-rail">
              {liveScenarios.map((s) => (
                <div key={s.id} className="wr-liverow">
                  <div className="band wr-artband">
                    <img className="wr-art" src={artFor(s, 'sm')} alt="" loading="lazy" />
                    <span className="live">
                      <span className="wr-livedot" /> Live
                    </span>
                    <div className="t">{elapsedLabel(s.summary?.live_session_started_at)}</div>
                  </div>
                  <div className="mid">
                    <h4>{s.title}</h4>
                    <div className="meta">
                      <span className="inline-flex items-center gap-1.5">
                        <WrIcon name={isSocial(s) ? 'phone' : 'map'} size={12} />
                        {isSocial(s) ? 'Corporate crisis' : 'Field operations'}
                      </span>
                      <span>·</span>
                      <span>{s.summary?.teams ?? 0} teams</span>
                      <span>·</span>
                      <span>{s.duration_minutes} min</span>
                    </div>
                    <div className="mt-2.5">
                      <CastChips s={s} />
                    </div>
                  </div>
                  <div className="acts">
                    <button className="wr-btn accent" onClick={() => launch(s)}>
                      Open session <WrIcon name="arrow" />
                    </button>
                    <button className="wr-btn sm ghost" onClick={() => handleViewScenario(s)}>
                      <WrIcon name="eye" /> {isTrainer ? 'Preview' : 'Brief'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* grid / list */}
        {filteredScenarios.length > 0 && (
          <section>
            <div className="wr-sech">
              <h2>
                {filtersActive ? 'Matching scenarios' : 'All scenarios'}{' '}
                <span className="n">{filteredScenarios.length}</span>
              </h2>
              <p>
                {sort === 'compiled'
                  ? 'Recently compiled first.'
                  : sort === 'run'
                    ? 'Recently run first.'
                    : sort === 'sessions'
                      ? 'Most sessions first.'
                      : 'Alphabetical.'}
              </p>
            </div>
            {view === 'cards' ? (
              <div className="wr-posters">
                {filteredScenarios.map((s, i) =>
                  expandedId === s.id ? (
                    <ExpandedPoster
                      key={s.id}
                      s={s}
                      lock={lockState(s)}
                      isTrainer={isTrainer}
                      onCollapse={() => setExpandedId(null)}
                      onOpen={() => handleViewScenario(s)}
                      onLaunch={() => launch(s)}
                    />
                  ) : (
                    <Poster
                      key={s.id}
                      s={s}
                      index={i}
                      lock={lockState(s)}
                      isTrainer={isTrainer}
                      deleting={deleting === s.id}
                      onExpand={() => (isTrainer ? setExpandedId(s.id) : handleViewScenario(s))}
                      onOpen={() => handleViewScenario(s)}
                      onLaunch={() => launch(s)}
                      onDelete={(e) => handleDeleteScenario(e, s)}
                    />
                  ),
                )}
              </div>
            ) : (
              <table className="wr-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Scenario</th>
                    <th>Type</th>
                    <th>Organisations</th>
                    <th>Teams</th>
                    <th>Injects</th>
                    <th>Min</th>
                    <th>State</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredScenarios.map((s) => {
                    const lock = lockState(s);
                    return (
                      <tr key={s.id}>
                        <td>
                          <img className="wr-thumb" src={artFor(s, 'sm')} alt="" loading="lazy" />
                        </td>
                        <td>
                          <button
                            className="font-bold text-ink text-left hover:underline"
                            onClick={() => handleViewScenario(s)}
                          >
                            {s.title}
                          </button>
                          <div className="text-[11px] text-muted">
                            Compiled {fmtDate(s.created_at)}
                            {s.summary?.sessions_run ? ` · ${s.summary.sessions_run} run` : ''}
                          </div>
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <WrIcon name={isSocial(s) ? 'phone' : 'map'} size={12} />
                            {isSocial(s) ? 'Corporate' : 'Field ops'}
                          </span>
                        </td>
                        <td>
                          <CastChips s={s} />
                        </td>
                        <td>{s.summary?.teams ?? '—'}</td>
                        <td>{s.summary?.injects ?? '—'}</td>
                        <td>{s.duration_minutes}</td>
                        <td>
                          <LockLabel lock={lock} />
                        </td>
                        <td>
                          {isTrainer && (
                            <div className="flex gap-1 justify-end">
                              <button
                                className="wr-btn sm"
                                onClick={() => handleViewScenario(s)}
                                disabled={lock === 'locked-live' || lock === 'locked-credits'}
                                title={lock.startsWith('locked') ? 'Editing is locked' : 'Edit'}
                              >
                                <WrIcon name="edit" /> Edit
                              </button>
                              <button className="wr-btn sm accent" onClick={() => launch(s)}>
                                <WrIcon name="play" /> {lock === 'locked-live' ? 'Open' : 'Launch'}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}

        {/* empty states */}
        {scenarios.length === 0 && (
          <div className="wr-empty" style={{ '--g': 'var(--brand)' } as CSSProperties}>
            <div className="wr-tile">
              <WrIcon name="layers" size={24} />
            </div>
            <div>
              <h4>No scenarios yet</h4>
              <p>
                {isTrainer
                  ? 'Build your first scenario in the War Room to get started.'
                  : 'Scenarios will appear here once your trainer publishes them.'}
              </p>
            </div>
            {isTrainer && (
              <Link to="/warroom" className="wr-btn accent">
                <WrIcon name="bolt" /> Open War Room
              </Link>
            )}
          </div>
        )}
        {scenarios.length > 0 && filteredScenarios.length === 0 && (
          <div className="wr-empty" style={{ '--g': 'var(--brand)' } as CSSProperties}>
            <div className="wr-tile">
              <WrIcon name="search" size={24} />
            </div>
            <div>
              <h4>No matches</h4>
              <p>
                Nothing matches your search or filters. Try different terms or clear the filters.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={clearFilters} className="wr-btn">
                Clear filters
              </button>
              {isTrainer && (
                <Link to="/warroom" className="wr-btn accent">
                  <WrIcon name="bolt" /> Open War Room
                </Link>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Trainer full detail view */}
      {detailScenarioId && (
        <ScenarioDetailView
          scenarioId={detailScenarioId}
          onClose={() => {
            setDetailScenarioId(null);
            // counts may have changed after edits
            loadScenarios();
          }}
        />
      )}

      {/* Participant brief-only modal */}
      {selectedScenario && !isTrainer && (
        <div
          className="fixed inset-0 bg-ink/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedScenario(null)}
        >
          <div
            className="bg-surface border border-border rounded-2xl shadow-lg max-w-2xl w-full max-h-[90vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wr-artband center" style={{ padding: '22px 24px 18px' }}>
              <img className="wr-art" src={artFor(selectedScenario, 'sm')} alt="" />
              <div className="flex justify-between items-start gap-3">
                <div>
                  <div className="wr-eyebrow">
                    {isSocial(selectedScenario) ? 'Corporate crisis' : 'Field operations'} ·{' '}
                    {selectedScenario.duration_minutes} min
                  </div>
                  <h2 className="text-xl font-extrabold text-white mt-1">
                    {selectedScenario.title}
                  </h2>
                </div>
                <button
                  onClick={() => setSelectedScenario(null)}
                  className="wr-btn sm onDark icon"
                  aria-label="Close"
                >
                  <WrIcon name="x" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto max-h-[60vh]">
              <div>
                <h3 className="wr-lbl">Description</h3>
                <p className="text-sm text-ink">{selectedScenario.description}</p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <h3 className="wr-lbl">Category</h3>
                  <p className="text-sm text-ink capitalize">
                    {selectedScenario.category.replace(/_/g, ' ')}
                  </p>
                </div>
                <div>
                  <h3 className="wr-lbl">Difficulty</h3>
                  <p className="text-sm text-ink capitalize">{selectedScenario.difficulty}</p>
                </div>
                <div>
                  <h3 className="wr-lbl">Duration</h3>
                  <p className="text-sm text-ink">{selectedScenario.duration_minutes} minutes</p>
                </div>
              </div>
              {selectedScenario.objectives.length > 0 && (
                <div>
                  <h3 className="wr-lbl">Objectives</h3>
                  <ul className="list-disc list-inside space-y-1">
                    {selectedScenario.objectives.map((obj, idx) => (
                      <li key={idx} className="text-sm text-ink">
                        {obj}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ── card pieces ─────────────────────────────────────────────────────── */

const LockLabel = ({ lock }: { lock: LockState }) =>
  lock === 'editable' ? (
    <span className="wr-lock">
      <WrIcon name="unlock" size={12} /> Editable
    </span>
  ) : lock === 'locked-live' ? (
    <span className="wr-lock locked">
      <WrIcon name="lock" size={12} /> Locked — session live
    </span>
  ) : lock === 'locked-credits' ? (
    <span className="wr-lock locked">
      <WrIcon name="lock" size={12} /> Locked — no session credits
    </span>
  ) : (
    <span className="wr-lock draft">Draft</span>
  );

const StatusChip = ({ s, lock }: { s: Scenario; lock: LockState }) =>
  lock === 'locked-live' ? (
    <span className="status live">
      <span className="wr-livedot" /> Live · {elapsedLabel(s.summary?.live_session_started_at)}
    </span>
  ) : s.is_active ? (
    <span className="status">
      <WrIcon name="check" size={12} /> Active
    </span>
  ) : (
    <span className="status">Draft</span>
  );

const Poster = ({
  s,
  index,
  lock,
  isTrainer,
  deleting,
  onExpand,
  onOpen,
  onLaunch,
  onDelete,
}: {
  s: Scenario;
  index: number;
  lock: LockState;
  isTrainer: boolean;
  deleting: boolean;
  onExpand: () => void;
  onOpen: () => void;
  onLaunch: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) => {
  const social = isSocial(s);
  const family = social ? 'var(--accent)' : 'var(--brand)';
  return (
    <article
      className="wr-poster wr-reveal"
      style={{ '--g': family, '--i': Math.min(index, 4) } as CSSProperties}
    >
      <div className="band wr-artband center" onClick={onExpand} role="button" tabIndex={0}>
        <img className="wr-art" src={artFor(s, 'sm')} alt="" loading="lazy" />
        <div className="row">
          <span className="mode">
            <WrIcon name={social ? 'phone' : 'map'} size={12} />{' '}
            {social ? 'Corporate crisis' : 'Field operations'}
          </span>
          <StatusChip s={s} lock={lock} />
        </div>
        <h4>{s.title}</h4>
        <p className="desc">{s.description}</p>
      </div>
      <div className="body" onClick={onExpand}>
        <CastChips s={s} />
        <Kpis s={s} />
        <div className="meta">
          <WrIcon name="clock" size={12} /> Compiled {fmtDate(s.created_at)}
          {s.summary?.sessions_run
            ? ` · ${s.summary.sessions_run} session${s.summary.sessions_run === 1 ? '' : 's'} run`
            : s.objectives?.length
              ? ` · ${s.objectives.length} objective${s.objectives.length === 1 ? '' : 's'}`
              : ''}
        </div>
      </div>
      <div className="ft">
        <LockLabel lock={lock} />
        {isTrainer ? (
          <>
            <button className="wr-btn sm ghost" onClick={onOpen} title="Preview">
              <WrIcon name="eye" /> Preview
            </button>
            <button
              className="wr-btn sm ghost icon"
              onClick={onDelete}
              disabled={deleting}
              title="Delete scenario and all related data"
              aria-label="Delete scenario"
            >
              {deleting ? '…' : <WrIcon name="trash" />}
            </button>
            {lock === 'locked-live' ? (
              <button className="wr-btn sm accent" onClick={onLaunch}>
                Open session <WrIcon name="arrow" />
              </button>
            ) : lock === 'draft' ? (
              <button className="wr-btn sm" onClick={onOpen}>
                Open <WrIcon name="arrow" />
              </button>
            ) : (
              <>
                <button
                  className="wr-btn sm"
                  onClick={onOpen}
                  disabled={lock === 'locked-credits'}
                  title={
                    lock === 'locked-credits' ? 'No session credits — editing is locked' : 'Edit'
                  }
                >
                  <WrIcon name="edit" /> Edit
                </button>
                <button className="wr-btn sm accent" onClick={onLaunch}>
                  <WrIcon name="play" /> Launch
                </button>
              </>
            )}
          </>
        ) : (
          <button className="wr-btn sm" onClick={onOpen}>
            View brief <WrIcon name="arrow" />
          </button>
        )}
      </div>
    </article>
  );
};

const ExpandedPoster = ({
  s,
  lock,
  isTrainer,
  onCollapse,
  onOpen,
  onLaunch,
}: {
  s: Scenario;
  lock: LockState;
  isTrainer: boolean;
  onCollapse: () => void;
  onOpen: () => void;
  onLaunch: () => void;
}) => {
  const social = isSocial(s);
  const family = social ? 'var(--accent)' : 'var(--brand)';
  const [injects, setInjects] = useState<PeekInject[] | null>(null);
  const [teams, setTeams] = useState<PeekTeam[] | null>(null);

  useEffect(() => {
    let alive = true;
    getScenarioInjectsPeek(s.id).then((d) => alive && setInjects(d));
    getScenarioTeamsPeek(s.id).then((d) => alive && setTeams(d));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCollapse();
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [s.id, onCollapse]);

  const contacts = s.summary?.contacts ?? 0;
  const orgs = s.summary?.orgs ?? [];
  const orgName = (key: string | null | undefined) =>
    orgs.find((o) => o.org_key === key)?.name ?? (key ? key : 'Common');
  const castGroups = s.summary?.cast ?? [];

  const sortedInjects = useMemo(
    () =>
      [...(injects ?? [])]
        .sort(
          (a, b) =>
            (a.trigger_time_minutes ?? Number.MAX_SAFE_INTEGER) -
            (b.trigger_time_minutes ?? Number.MAX_SAFE_INTEGER),
        )
        .slice(0, 8),
    [injects],
  );

  return (
    <article className="wr-poster expanded" style={{ '--g': family } as CSSProperties}>
      <div className="band wr-artband center">
        <img className="wr-art" src={artFor(s, 'sm')} alt="" loading="lazy" />
        <div className="row">
          <span className="mode">
            <WrIcon name={social ? 'phone' : 'map'} size={12} />{' '}
            {social ? 'Corporate crisis' : 'Field operations'}
          </span>
          <StatusChip s={s} lock={lock} />
          <button
            className="wr-btn sm onDark icon"
            onClick={onCollapse}
            aria-label="Collapse"
            title="Collapse (Esc)"
            style={{ marginLeft: 6 }}
          >
            <WrIcon name="collapse" />
          </button>
        </div>
        <h4>{s.title}</h4>
        <p className="desc">{s.description}</p>
        <div className="bandfoot">
          <CastChips s={s} onDark />
          <Kpis s={s} onDark />
          <button className="wr-btn accent" onClick={onOpen}>
            {isTrainer ? 'Open full scenario' : 'View brief'} <WrIcon name="arrow" />
          </button>
          {isTrainer && (
            <div className="flex gap-2">
              <button
                className="wr-btn onDark flex-1"
                onClick={onOpen}
                disabled={lock === 'locked-live' || lock === 'locked-credits'}
              >
                <WrIcon name="edit" /> Edit
              </button>
              <button className="wr-btn onDark flex-1" onClick={onLaunch}>
                <WrIcon name="play" /> {lock === 'locked-live' ? 'Open session' : 'Launch'}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="wr-peek">
        <section>
          <h5>
            <WrIcon name="users" /> Cast <span className="n">{contacts}</span>
          </h5>
          {castGroups.length === 0 && (
            <div className="empty">
              {social
                ? 'No stakeholder contacts in this scenario.'
                : 'Field-ops scenarios have no contact cast.'}
            </div>
          )}
          {castGroups.map(({ key, count, members }) => (
            <div key={key}>
              <div className="grp">
                {key === '__common' ? 'Common to every organisation' : orgName(key)} · {count}
              </div>
              {members.map((st, i) => {
                const org = orgs.find((o) => o.org_key === st.org_key);
                const cls = st.page_org_key ? 'pr' : org?.operation === 'ai' ? 'ai' : '';
                return (
                  <div key={st.id ?? i} className="row">
                    <span className={`wr-mono ${cls}`}>{initialsOf(st.name)}</span>
                    <div>
                      <b>{st.name}</b>
                      <span>
                        {st.title}
                        {st.page_org_key
                          ? ` · speaks for ${orgName(st.page_org_key)}`
                          : st.relationship
                            ? ` · ${st.relationship}`
                            : ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {contacts > 0 && (
            <button className="more" onClick={onOpen}>
              All {contacts} contacts, grouped by organisation →
            </button>
          )}
        </section>
        <section>
          <h5>
            <WrIcon name="layers" /> Injects{' '}
            <span className="n">{s.summary?.injects ?? injects?.length ?? '—'}</span>
          </h5>
          {injects === null ? (
            <div className="space-y-2 py-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="wr-shimmer h-8 rounded" />
              ))}
            </div>
          ) : sortedInjects.length === 0 ? (
            <div className="empty">No injects yet.</div>
          ) : (
            sortedInjects.map((inj) => {
              const dc = (inj.delivery_config ?? {}) as Record<string, unknown>;
              const author = String(dc.author_display_name ?? dc.author_handle ?? '');
              const target = (inj.target_teams ?? []).slice(0, 2).join(', ');
              return (
                <div key={inj.id} className="row inj">
                  <span className="t">
                    {inj.trigger_time_minutes != null
                      ? `T+${String(inj.trigger_time_minutes).padStart(2, '0')}`
                      : 'IF'}
                  </span>
                  <div>
                    <b>{inj.title}</b>
                    <span>
                      <OriginBadge inject={inj} size="sm" />
                      {author}
                      {author && target ? ' → ' : ''}
                      {target}
                    </span>
                  </div>
                </div>
              );
            })
          )}
          {(injects?.length ?? 0) > 0 && (
            <button className="more" onClick={onOpen}>
              All {injects?.length} by phase →
            </button>
          )}
        </section>
        <section>
          <h5>
            <WrIcon name="building" /> Pages &amp; teams{' '}
            <span className="n">
              {orgs.length} · {teams?.length ?? s.summary?.teams ?? '—'}
            </span>
          </h5>
          {orgs.length === 0 && !teams?.length && (
            <div className="empty">No organisation registry.</div>
          )}
          {orgs.slice(0, 5).map((o) => {
            const icon = orgIcon(o);
            return (
              <div key={o.org_key} className="row">
                <span className={`wr-mono ${orgClass(o) === 'hq' ? '' : orgClass(o)}`}>
                  {icon ? <WrIcon name={icon} size={12} /> : initialsOf(o.name)}
                </span>
                <div>
                  <b>{o.name}</b>
                  <span>
                    {o.side === 'pressure'
                      ? `pressure · ${o.kind ?? 'group'}`
                      : o.side === 'antagonist'
                        ? 'rival · AI'
                        : `protagonist · ${o.operation === 'ai' ? 'AI-operated' : 'players'}${o.is_primary ? ' · HQ' : ''}`}
                    {o.country ? ` · ${o.country}` : ''}
                  </span>
                </div>
              </div>
            );
          })}
          {teams && teams.length > 0 && (
            <>
              <div className="grp" style={{ marginTop: 12 }}>
                Teams · {teams.length}
              </div>
              {teams.slice(0, 4).map((t) => (
                <div key={t.id} className="row">
                  <span className="wr-mono plain">
                    <WrIcon name={teamIcon(t.team_name)} size={12} />
                  </span>
                  <div>
                    <b>{t.team_name}</b>
                    <span>{t.team_description || t.function_key || ''}</span>
                  </div>
                </div>
              ))}
            </>
          )}
          <button className="more" onClick={onOpen}>
            All teams &amp; charters →
          </button>
        </section>
      </div>
    </article>
  );
};
