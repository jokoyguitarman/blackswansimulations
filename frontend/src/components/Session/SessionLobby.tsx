import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { api, ApiError } from '../../lib/api';
import {
  PAGES_UNASSIGNED,
  pageCoverageMessage,
  type PageCoverage,
  type PageCoverageItem,
} from '@shared/sessionPageCoverage';
import { CALL_COVERAGE_INCOMPLETE, type CallCoverage } from '@shared/sessionCallCoverage';
import { CallCoveragePanel } from './CallCoveragePanel';
import { BriefingView } from './BriefingView';
import { ParticipantManagement } from './ParticipantManagement';
import { JoinLinkPanel } from './JoinLinkPanel';
import { TeamAssignmentModal } from '../Teams/TeamAssignmentModal';
import { PageAssignmentModal } from '../Teams/PageAssignmentModal';
import { AITeammatesPanel } from './AITeammatesPanel';
import { BotBadge } from '../UI/BotBadge';
import { WrIcon, teamIcon } from '../UI/WarRoomIcon';
import { initialsOf } from '../UI/Collapsible';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { useAuth } from '../../contexts/AuthContext';
import { websocketClient } from '../../lib/websocketClient';

interface SessionLobbyProps {
  sessionId: string;
  session: {
    status: string;
    sim_mode?: string | null;
    trainer_instructions?: string | null;
    scheduled_start_time?: string | null;
    join_token?: string | null;
    join_enabled?: boolean;
    join_expires_at?: string | null;
    participants?: Array<{
      user_id: string;
      role: string;
      is_ready?: boolean;
      user?: {
        id: string;
        full_name: string;
        email?: string;
        role: string;
        agency_name?: string;
        is_bot?: boolean;
      };
    }>;
  };
  onStartSession?: (override?: boolean) => Promise<void> | void;
  onSessionUpdate?: () => void;
}

export const SessionLobby = ({
  sessionId,
  session,
  onStartSession,
  onSessionUpdate,
}: SessionLobbyProps) => {
  const { isTrainer } = useRoleVisibility();
  const { user } = useAuth();
  const [isReady, setIsReady] = useState(false);
  const [readyStatus, setReadyStatus] = useState<{
    total: number;
    ready: number;
    all_ready: boolean;
    participants: Array<{ user_id: string; is_ready: boolean; user?: { full_name: string } }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [myTeams, setMyTeams] = useState<Array<{ team_name: string; team_role?: string }>>([]);
  const [allAssignments, setAllAssignments] = useState<
    Array<{ user_id: string; team_name: string; user?: { full_name?: string } }>
  >([]);
  const [showTeamAssignmentModal, setShowTeamAssignmentModal] = useState(false);
  const [showPageAssignmentModal, setShowPageAssignmentModal] = useState(false);
  const [coverage, setCoverage] = useState<(PageCoverage & { applies: boolean }) | null>(null);
  const [coverageAlert, setCoverageAlert] = useState(false);
  const [flashPages, setFlashPages] = useState(false);
  const [starting, setStarting] = useState(false);
  const pagesSectionRef = useRef<HTMLDivElement>(null);
  const pagesHeadingRef = useRef<HTMLHeadingElement>(null);
  const isSocialSim = session.sim_mode === 'social_media';
  const loadCoverageRef = useRef<() => void>(() => {});
  const [wsConnected, setWsConnected] = useState(false);
  const botIds = new Set(
    (session.participants || []).filter((p) => p.user?.is_bot).map((p) => p.user_id),
  );

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    let isMounted = true;

    const setupWebSocket = async () => {
      try {
        // Load initial status
        await loadReadyStatus();

        // Connect to WebSocket and join session room
        await websocketClient.connect();
        await websocketClient.joinSession(sessionId);
        setWsConnected(true);

        // Subscribe to ready status updates
        unsubscribers.push(
          websocketClient.on('participant.ready_status_updated', (event) => {
            if (!isMounted) return;
            loadCoverageRef.current();

            if (event.data) {
              setReadyStatus({
                total: event.data.total as number,
                ready: event.data.ready as number,
                all_ready: event.data.all_ready as boolean,
                participants: (event.data.participants || []) as Array<{
                  user_id: string;
                  is_ready: boolean;
                  user?: { full_name: string };
                }>,
              });

              // Update current user's ready status from participants
              if (user?.id && Array.isArray(event.data.participants)) {
                const currentParticipant = event.data.participants.find(
                  (p: { user_id: string; is_ready: boolean }) => p.user_id === user.id,
                );
                if (currentParticipant) {
                  setIsReady(currentParticipant.is_ready || false);
                }
              }
            }
          }),
        );

        // Subscribe to session start — auto-transition out of lobby
        unsubscribers.push(
          websocketClient.on('session.started', () => {
            if (!isMounted) return;
            if (onSessionUpdate) {
              onSessionUpdate();
            }
          }),
        );

        unsubscribers.push(
          websocketClient.on('session.page_assignments_updated', () => {
            if (!isMounted) return;
            loadCoverageRef.current();
          }),
        );
      } catch (error) {
        console.error('Failed to setup WebSocket:', error);
        setWsConnected(false);
      }
    };

    setupWebSocket();

    return () => {
      isMounted = false;
      unsubscribers.forEach((unsub) => unsub());
      websocketClient.leaveSession(sessionId);
    };
  }, [sessionId, isTrainer, user?.id]);

  // Polling fallback: check session status every 5s in case WebSocket misses the start event
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await api.sessions.get(sessionId);
        const session = result?.data as { status?: string } | undefined;
        if (session?.status === 'in_progress') {
          if (onSessionUpdate) onSessionUpdate();
        }
      } catch {
        // Non-blocking; WebSocket is the primary mechanism
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, onSessionUpdate]);

  // Load team assignments for current user
  useEffect(() => {
    if (sessionId && user?.id) {
      loadMyTeams();
    }
  }, [sessionId, user?.id]);

  const loadReadyStatus = async () => {
    try {
      // Get current user's ready status from session participants
      if (user?.id) {
        const currentParticipant = session.participants?.find((p) => p.user_id === user.id);
        if (currentParticipant) {
          setIsReady(currentParticipant.is_ready || false);
        }
      }

      // Trainer can see all ready status
      if (isTrainer) {
        const result = await api.sessions.getReadyStatus(sessionId);
        setReadyStatus({
          ...result.data,
          participants: (result.data.participants || []) as Array<{
            user_id: string;
            is_ready: boolean;
            user?: { full_name: string };
          }>,
        });
      }
    } catch (error) {
      console.error('Failed to load ready status:', error);
    }
  };

  const loadMyTeams = async () => {
    if (!sessionId || !user?.id) return;
    try {
      const result = await api.teams.getSessionTeams(sessionId);
      const assignments = (result.data || []) as Array<{
        user_id: string;
        team_name: string;
        team_role?: string;
        user?: { full_name?: string };
      }>;
      setAllAssignments(assignments);
      const myTeamAssignments = assignments.filter((assignment) => assignment.user_id === user.id);
      setMyTeams(
        myTeamAssignments.map((a) => ({
          team_name: a.team_name,
          team_role: a.team_role,
        })),
      );
    } catch (error) {
      console.error('Failed to load team assignments:', error);
    }
  };

  const handleToggleReady = async () => {
    setLoading(true);
    try {
      await api.sessions.markReady(sessionId, !isReady);
      // WebSocket will update the status automatically, but update local state optimistically
      setIsReady(!isReady);
      // If WebSocket is not connected, manually reload status
      if (!wsConnected) {
        await loadReadyStatus();
      }
    } catch (error) {
      console.error('Failed to update ready status:', error);
      alert('Failed to update ready status');
      // Revert optimistic update on error
      setIsReady(!isReady);
    } finally {
      setLoading(false);
    }
  };

  const loadCoverage = useCallback(async () => {
    if (!isTrainer || !isSocialSim) return;
    try {
      const result = await api.sessions.getPageCoverage(sessionId);
      setCoverage(result.data);
      if (result.data.covered) setCoverageAlert(false);
    } catch (error) {
      console.error('Failed to load page coverage:', error);
    }
  }, [sessionId, isTrainer, isSocialSim]);
  loadCoverageRef.current = loadCoverage;

  useEffect(() => {
    loadCoverage();
  }, [loadCoverage]);

  const [callCoverage, setCallCoverage] = useState<CallCoverage | null>(null);
  const pagesBlocked = Boolean(coverage?.applies && !coverage.covered);
  const callsBlocked = Boolean(callCoverage?.applies && callCoverage.mode === 'enforce' && !callCoverage.covered);
  const callGaps = callCoverage?.items.filter((item) => item.required && !item.satisfied).length ?? 0;
  const uncoveredCount = coverage?.uncovered.length ?? 0;
  const eligibleCount = (session.participants || []).filter(
    (p) => p.role !== 'observer' && p.user_id !== user?.id,
  ).length;

  const revealPageProblems = () => {
    setCoverageAlert(true);
    setFlashPages(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = pagesSectionRef.current;
        if (!el) return;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        pagesHeadingRef.current?.focus({ preventScroll: true });
        if (!reduce) {
          el.querySelectorAll<HTMLElement>('[data-page-uncovered="true"]').forEach((row) =>
            row.animate(
              [
                { boxShadow: '0 0 0 0 rgba(220, 38, 38, 0.55)' },
                { boxShadow: '0 0 0 12px rgba(220, 38, 38, 0)' },
              ],
              { duration: 750, iterations: 3, easing: 'ease-out' },
            ),
          );
        }
      });
    });
  };

  useEffect(() => {
    if (!flashPages) return;
    const t = window.setTimeout(() => setFlashPages(false), 4000);
    return () => window.clearTimeout(t);
  }, [flashPages]);

  const handleStartSession = async () => {
    if (!readyStatus?.all_ready) {
      alert('All participants must be ready before starting the session');
      return;
    }
    if (pagesBlocked) {
      revealPageProblems();
      return;
    }
    if (callsBlocked) {
      return;
    }

    // Social crisis sessions score and route content per team — warn (but do
    // not block) when players would start without a team.
    if (isSocialSim) {
      const assignedIds = new Set(allAssignments.map((a) => a.user_id));
      const unassigned = (session.participants || []).filter(
        (p) => !assignedIds.has(p.user_id) && p.user_id !== user?.id,
      );
      if (unassigned.length > 0) {
        const names = unassigned
          .map((p) => p.user?.full_name || 'Unknown')
          .slice(0, 5)
          .join(', ');
        const proceed = window.confirm(
          `${unassigned.length} player(s) have no team (${names}${unassigned.length > 5 ? ', …' : ''}). ` +
            'They will miss team-specific content and team scoring. Start anyway?',
        );
        if (!proceed) return;
      }
    }

    if (!onStartSession) return;
    setStarting(true);
    try {
      await onStartSession();
    } catch (error) {
      if (error instanceof ApiError && error.code === CALL_COVERAGE_INCOMPLETE) {
        const body = error.body as { coverage?: CallCoverage };
        if (body.coverage) setCallCoverage(body.coverage);
        return;
      }
      if (error instanceof ApiError && error.code === PAGES_UNASSIGNED) {
        const body = error.body as { pages?: PageCoverageItem[]; uncovered?: PageCoverageItem[] };
        setCoverage({
          applies: true,
          covered: false,
          pages: body.pages ?? coverage?.pages ?? [],
          uncovered: body.uncovered ?? [],
        });
        revealPageProblems();
      }
    } finally {
      setStarting(false);
    }
  };

  const scheduledTime = session.scheduled_start_time
    ? new Date(session.scheduled_start_time)
    : null;
  const now = new Date();
  const timeUntilStart = scheduledTime ? scheduledTime.getTime() - now.getTime() : null;

  /* ── Situation Map lobby (spec follow-up: lobby) — handlers above unchanged ─────────── */
  const teamGroups = Array.from(
    allAssignments.reduce((groups, a) => {
      const list = groups.get(a.team_name) || [];
      list.push(a);
      groups.set(a.team_name, list);
      return groups;
    }, new Map<string, typeof allAssignments>()),
  );
  const myTeamNames = new Set(myTeams.map((t) => t.team_name));
  const readyPct =
    readyStatus && readyStatus.total > 0
      ? Math.round((readyStatus.ready / readyStatus.total) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Trainer instructions */}
      {session.trainer_instructions && (
        <div className="wr-lockstrip locked" style={{ marginBottom: 0 }}>
          <WrIcon name="megaphone" size={16} className="mt-0.5 text-accent-strong" />
          <div>
            <div className="font-bold">Trainer instructions</div>
            <div className="text-ink whitespace-pre-wrap">{session.trainer_instructions}</div>
          </div>
        </div>
      )}

      <div className="wr-map">
        {/* Readiness */}
        <div className="wr-sech" style={{ margin: '0 0 12px' }}>
          <h2>
            <WrIcon name="check" size={16} /> Readiness
            {readyStatus && (
              <span className="n">
                {readyStatus.ready} / {readyStatus.total}
              </span>
            )}
          </h2>
          <p>
            {isTrainer
              ? 'Everyone marks ready in their own lobby; start when the room is green.'
              : 'Mark yourself ready once you have read the briefing. The trainer starts the session.'}
          </p>
          {scheduledTime && (
            <span className="more" style={{ color: 'var(--muted)', fontWeight: 600 }}>
              <WrIcon name="cal" size={12} />{' '}
              {timeUntilStart && timeUntilStart > 0
                ? `Starts in ${Math.floor(timeUntilStart / 60000)} min`
                : `Scheduled ${scheduledTime.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
            </span>
          )}
        </div>

        {isTrainer && readyStatus && (
          <div
            className="wr-node"
            style={
              { '--g': readyStatus.all_ready ? 'var(--success)' : 'var(--accent)' } as CSSProperties
            }
          >
            <div className="wr-phase" style={{ marginBottom: 12 }}>
              <span
                style={{
                  width: `${Math.max(2, readyPct)}%`,
                  background: readyStatus.all_ready ? 'var(--success)' : 'var(--accent)',
                }}
              />
            </div>
            {readyStatus.participants.length === 0 ? (
              <div className="text-xs text-muted py-2">
                No participants yet — share the join link below, or fill seats with AI teammates.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 mb-3">
                {readyStatus.participants.map((p) => (
                  <div key={p.user_id} className="wr-row" style={{ padding: '6px 8px' }}>
                    <div className={`wr-mono av ${botIds.has(p.user_id) ? 'ai' : 'plain'}`}>
                      {botIds.has(p.user_id) ? (
                        <WrIcon name="sparkle" size={14} />
                      ) : (
                        initialsOf(p.user?.full_name)
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="nm">
                        <span className="truncate">{p.user?.full_name || 'Unknown'}</span>
                        {botIds.has(p.user_id) && <BotBadge />}
                      </div>
                    </div>
                    <span className={`wr-p ${p.is_ready ? 'pure' : ''}`}>
                      {p.is_ready ? 'ready' : 'not ready'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {coverageAlert && pagesBlocked && coverage && (
              <div
                className="wr-lockstrip locked"
                role="alert"
                style={{ borderColor: 'var(--danger)' }}
              >
                <WrIcon name="alert" size={16} className="mt-0.5" />
                <div className="flex-1">
                  <div className="font-bold">Session can't start yet</div>
                  <div>{pageCoverageMessage(coverage.uncovered)}</div>
                  {eligibleCount < coverage.pages.length && (
                    <div className="text-xs text-muted mt-1">
                      Each person can run only one page. You have {eligibleCount} player(s) for{' '}
                      {coverage.pages.length} pages — add AI teammates to fill the gap.
                    </div>
                  )}
                </div>
                <button type="button" className="wr-btn" onClick={revealPageProblems}>
                  Show me
                </button>
                <button
                  type="button"
                  className="wr-btn ghost"
                  aria-label="Dismiss"
                  onClick={() => setCoverageAlert(false)}
                >
                  ✕
                </button>
              </div>
            )}
            <button
              onClick={handleStartSession}
              disabled={starting || !readyStatus.all_ready}
              aria-disabled={pagesBlocked && readyStatus.all_ready && !starting ? true : undefined}
              aria-describedby={pagesBlocked ? 'lobby-pages-gate-note' : undefined}
              className={`wr-btn accent lg w-full${pagesBlocked && readyStatus.all_ready && !starting ? ' wr-btn--blocked' : ''}`}
            >
              <WrIcon name="play" />
              {starting
                ? 'Starting…'
                : !readyStatus.all_ready
                  ? `Waiting · ${readyStatus.total - readyStatus.ready} participant${readyStatus.total - readyStatus.ready === 1 ? '' : 's'} not ready`
                  : pagesBlocked
                    ? `Start session · ${uncoveredCount} page${uncoveredCount === 1 ? '' : 's'} need${uncoveredCount === 1 ? 's' : ''} a player`
                    : callsBlocked
                      ? `Start session · ${callGaps} item${callGaps === 1 ? '' : 's'} missing`
                      : 'Start session'}
            </button>
            {callsBlocked && (
              <button
                type="button"
                className="wr-btn w-full mt-2"
                disabled={starting || !readyStatus.all_ready}
                onClick={() => {
                  if (!onStartSession) return;
                  setStarting(true);
                  void Promise.resolve(onStartSession(true))
                    .catch((error) => {
                      if (error instanceof ApiError && error.code === CALL_COVERAGE_INCOMPLETE) {
                        const body = error.body as { coverage?: CallCoverage };
                        if (body.coverage) setCallCoverage(body.coverage);
                      }
                    })
                    .finally(() => setStarting(false));
                }}
              >
                Start anyway…
              </button>
            )}
            {pagesBlocked && (
              <div id="lobby-pages-gate-note" className="wr-note">
                <WrIcon name="alert" size={13} />
                <span>
                  {uncoveredCount} page{uncoveredCount === 1 ? '' : 's'} still need
                  {uncoveredCount === 1 ? 's' : ''} a player. Every page must have someone assigned
                  before you can start.
                </span>
              </div>
            )}
          </div>
        )}

        {!isTrainer && (
          <div
            className="wr-node"
            style={
              {
                '--g': isReady ? 'var(--success)' : 'var(--accent)',
                textAlign: 'center',
                padding: 20,
              } as CSSProperties
            }
          >
            <button
              onClick={handleToggleReady}
              disabled={loading}
              className={`wr-btn lg ${isReady ? 'primary' : 'accent'}`}
              style={
                isReady
                  ? { background: 'var(--success)', borderColor: 'var(--success)' }
                  : undefined
              }
            >
              <WrIcon name={isReady ? 'check' : 'play'} />
              {loading ? 'Updating…' : isReady ? 'You are ready' : 'Mark me as ready'}
            </button>
            <p className="text-xs text-muted mt-2.5">
              {isReady
                ? 'Waiting for the trainer to start the session… you can un-ready by clicking again.'
                : 'Read the briefing below first; the trainer starts once everyone is ready.'}
            </p>
          </div>
        )}

        {/* AI teammates - Trainer only, social crisis sessions only */}
        {isTrainer && isSocialSim && (
          <div className="mt-4">
            <AITeammatesPanel
              sessionId={sessionId}
              sessionStatus={session.status}
              onChanged={() => {
                loadReadyStatus();
                loadMyTeams();
                loadCoverage();
                if (onSessionUpdate) onSessionUpdate();
              }}
            />
          </div>
        )}

        {/* Join Link Panel - Trainer Only */}
        {isTrainer &&
          session.join_token &&
          session.status !== 'completed' &&
          session.status !== 'cancelled' && (
            <div className="mt-4">
              <JoinLinkPanel
                sessionId={sessionId}
                joinToken={session.join_token}
                joinEnabled={session.join_enabled ?? true}
                joinExpiresAt={session.join_expires_at}
                onUpdate={onSessionUpdate}
              />
            </div>
          )}
      </div>

      {isTrainer && (
        <CallCoveragePanel sessionId={sessionId} userId={user?.id} onCoverage={setCallCoverage} />
      )}

      {isTrainer && isSocialSim && coverage?.applies && coverage.pages.length > 0 && (
        <div
          ref={pagesSectionRef}
          id="lobby-page-assignments"
          className={`wr-map${flashPages ? ' wr-invalid' : ''}`}
          aria-labelledby="lobby-page-assignments-title"
        >
          <div
            className="wr-sech"
            style={{ margin: '0 0 12px', '--g': 'var(--f-org)' } as CSSProperties}
          >
            <h2 id="lobby-page-assignments-title" ref={pagesHeadingRef} tabIndex={-1}>
              <WrIcon name="phone" size={16} /> Page assignments
              <span className="n">
                {coverage.pages.length - coverage.uncovered.length} / {coverage.pages.length}
              </span>
            </h2>
            <p>
              Every organisation page needs at least one player or AI teammate before the session
              can start.
            </p>
            <div className="ml-auto">
              <button onClick={() => setShowPageAssignmentModal(true)} className="wr-btn accent">
                <WrIcon name="phone" /> Manage pages
              </button>
            </div>
          </div>
          {coverage.uncovered.length > 0 && (
            <div className="wr-note" style={{ margin: '0 0 12px' }}>
              <WrIcon name="alert" size={13} />
              <span>{pageCoverageMessage(coverage.uncovered)}</span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {coverage.pages.map((pg) => {
              const missing = pg.assignees.length === 0;
              return (
                <div
                  key={pg.org_key}
                  data-page-uncovered={missing ? 'true' : 'false'}
                  className={`wr-node${missing ? ' wr-invalid' : ''}`}
                  style={{ '--g': missing ? 'var(--danger)' : 'var(--success)' } as CSSProperties}
                >
                  <div className="font-extrabold text-ink text-sm truncate" title={pg.display_name}>
                    {pg.display_name}
                    {pg.is_primary ? ' · crisis page' : ''}
                  </div>
                  {missing ? (
                    <div className="wr-note">
                      <WrIcon name="alert" size={13} />
                      <span>Nobody assigned</span>
                    </div>
                  ) : (
                    <div className="text-xs text-muted mt-1">
                      {pg.assignees.map((a) => a.full_name + (a.is_bot ? ' (AI)' : '')).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Team assignments */}
      <div className="wr-map">
        <div
          className="wr-sech"
          style={{ margin: '0 0 12px', '--g': 'var(--f-org)' } as CSSProperties}
        >
          <h2>
            <WrIcon name="users" size={16} /> Team assignments
            {teamGroups.length > 0 && <span className="n">{teamGroups.length} teams</span>}
          </h2>
          <p>
            One team per player. Each team has its own storyline pressure, tasks and scoring rubric.
          </p>
          {isTrainer && (
            <div className="ml-auto flex gap-2">
              {isSocialSim && (
                <button onClick={() => setShowPageAssignmentModal(true)} className="wr-btn">
                  <WrIcon name="phone" /> Manage pages
                </button>
              )}
              <button onClick={() => setShowTeamAssignmentModal(true)} className="wr-btn accent">
                <WrIcon name="users" /> Manage teams
              </button>
            </div>
          )}
        </div>

        {myTeams.length > 0 && (
          <div
            className="wr-node mb-3"
            style={{ '--g': 'var(--success)', borderColor: 'var(--success)' } as CSSProperties}
          >
            <div className="kicker">
              <WrIcon name="check" size={12} /> Your team
            </div>
            <div className="flex flex-wrap gap-3">
              {myTeams.map((team, idx) => (
                <div key={idx} className="flex items-center gap-2.5">
                  <div className="wr-tile" style={{ width: 36, height: 36 }}>
                    <WrIcon name={teamIcon(team.team_name)} size={16} />
                  </div>
                  <div>
                    <div className="font-extrabold text-ink">{team.team_name}</div>
                    {team.team_role && <div className="text-xs text-muted">{team.team_role}</div>}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted mt-2">
              You will receive team-specific information during the session.
            </p>
          </div>
        )}

        {teamGroups.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {teamGroups.map(([teamName, members]) => {
              const mine = myTeamNames.has(teamName);
              const bots = members.filter((m) => botIds.has(m.user_id)).length;
              return (
                <div
                  key={teamName}
                  className="wr-node"
                  style={
                    {
                      '--g': mine ? 'var(--success)' : 'var(--f-org)',
                      borderColor: mine ? 'var(--success)' : undefined,
                    } as CSSProperties
                  }
                >
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <div className="wr-tile" style={{ width: 34, height: 34 }}>
                      <WrIcon name={teamIcon(teamName)} size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-extrabold text-ink text-sm truncate" title={teamName}>
                        {teamName}
                      </div>
                      <div className="text-[11px] text-muted">
                        {members.length} member{members.length !== 1 ? 's' : ''}
                        {bots > 0 ? ` · ${bots} AI` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {members.map((m) => (
                      <div key={m.user_id} className="flex items-center gap-2 text-sm">
                        <div
                          className={`wr-mono ${botIds.has(m.user_id) ? 'ai' : 'plain'}`}
                          style={{ width: 24, height: 24, fontSize: 9, borderRadius: 7 }}
                        >
                          {botIds.has(m.user_id) ? (
                            <WrIcon name="sparkle" size={11} />
                          ) : (
                            initialsOf(m.user?.full_name)
                          )}
                        </div>
                        <span
                          className={`truncate ${m.user_id === user?.id ? 'font-bold text-ink' : 'text-ink'}`}
                        >
                          {m.user?.full_name || 'Unknown'}
                        </span>
                        {botIds.has(m.user_id) && <BotBadge />}
                        {m.user_id === user?.id && <span className="wr-p pure">you</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="wr-empty"
            style={{ marginTop: 0, '--g': 'var(--f-org)' } as CSSProperties}
          >
            <div className="wr-tile">
              <WrIcon name="users" size={24} />
            </div>
            <div>
              <h4>No team assignments yet</h4>
              <p>
                {isTrainer
                  ? 'Use “Manage teams” to place each player, or “Auto-balance” inside it to spread them evenly.'
                  : 'Waiting for the trainer to assign teams…'}
              </p>
            </div>
            {isTrainer && (
              <button onClick={() => setShowTeamAssignmentModal(true)} className="wr-btn accent">
                <WrIcon name="users" /> Manage teams
              </button>
            )}
          </div>
        )}
      </div>

      {/* Briefing Materials */}
      <div className="wr-map">
        <div
          className="wr-sech"
          style={{ margin: '0 0 12px', '--g': 'var(--f-crisis)' } as CSSProperties}
        >
          <h2>
            <WrIcon name="doc" size={16} /> Briefing materials
          </h2>
          <p>
            Read before you mark ready — the general briefing and anything specific to your team.
          </p>
        </div>
        <BriefingView sessionId={sessionId} />
      </div>

      {/* Participant Management - Trainer Only */}
      {isTrainer && (
        <div className="wr-map">
          <ParticipantManagement
            sessionId={sessionId}
            participants={(session.participants || []).map((p) => ({
              user_id: p.user_id,
              role: p.role,
              user: p.user
                ? {
                    id: p.user.id || p.user_id,
                    full_name: p.user.full_name,
                    email: p.user.email || '',
                    role: p.user.role,
                    agency_name: p.user.agency_name || '',
                    is_bot: p.user.is_bot,
                  }
                : undefined,
            }))}
            onUpdate={() => {
              // Reload ready status when participants are updated
              loadReadyStatus();
              // Reload team assignments
              loadMyTeams();
              loadCoverage();
              // Call parent update callback if provided
              if (onSessionUpdate) {
                onSessionUpdate();
              }
            }}
          />
        </div>
      )}

      {/* Team Assignment Modal */}
      {showTeamAssignmentModal && (
        <TeamAssignmentModal
          sessionId={sessionId}
          onClose={() => setShowTeamAssignmentModal(false)}
          onSuccess={() => {
            loadMyTeams();
            loadCoverage();
            if (onSessionUpdate) {
              onSessionUpdate();
            }
          }}
        />
      )}

      {/* Page Assignment Modal (social-media sims only) */}
      {showPageAssignmentModal && (
        <PageAssignmentModal
          sessionId={sessionId}
          onClose={() => {
            setShowPageAssignmentModal(false);
            loadCoverage();
          }}
          onSuccess={() => {
            loadCoverage();
            if (onSessionUpdate) {
              onSessionUpdate();
            }
          }}
        />
      )}
    </div>
  );
};
