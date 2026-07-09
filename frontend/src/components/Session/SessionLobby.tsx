import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { BriefingView } from './BriefingView';
import { ParticipantManagement } from './ParticipantManagement';
import { JoinLinkPanel } from './JoinLinkPanel';
import { TeamAssignmentModal } from '../Teams/TeamAssignmentModal';
import { PageAssignmentModal } from '../Teams/PageAssignmentModal';
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
      };
    }>;
  };
  onStartSession?: () => void;
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
  const [showTeamAssignmentModal, setShowTeamAssignmentModal] = useState(false);
  const [showPageAssignmentModal, setShowPageAssignmentModal] = useState(false);
  const isSocialSim = session.sim_mode === 'social_media';
  const [wsConnected, setWsConnected] = useState(false);

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
      const myTeamAssignments = (result.data || []).filter(
        (assignment: any) => assignment.user_id === user.id,
      );
      setMyTeams(
        myTeamAssignments.map((a: any) => ({
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

  const handleStartSession = async () => {
    if (!readyStatus?.all_ready) {
      alert('All participants must be ready before starting the session');
      return;
    }

    if (onStartSession) {
      onStartSession();
    }
  };

  const scheduledTime = session.scheduled_start_time
    ? new Date(session.scheduled_start_time)
    : null;
  const now = new Date();
  const timeUntilStart = scheduledTime ? scheduledTime.getTime() - now.getTime() : null;

  return (
    <div className="space-y-6">
      {/* Status Header */}
      <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-xl font-extrabold text-brand mb-1">Session lobby</h2>
            <p className="text-sm text-muted">Waiting for trainer to start the session…</p>
          </div>
          {scheduledTime && (
            <div className="text-right">
              <div className="text-xs text-muted uppercase tracking-wide">Scheduled start</div>
              <div className="text-sm font-semibold text-ink">
                {timeUntilStart && timeUntilStart > 0
                  ? `${Math.floor(timeUntilStart / 60000)} minutes`
                  : scheduledTime.toLocaleString()}
              </div>
            </div>
          )}
        </div>

        {/* Trainer Instructions */}
        {session.trainer_instructions && (
          <div className="border-l-4 border-accent bg-accent/10 rounded-md p-4 mt-4">
            <h3 className="text-xs font-bold uppercase tracking-wide mb-2 text-accent">
              Trainer instructions
            </h3>
            <div className="text-sm text-ink whitespace-pre-wrap">
              {session.trainer_instructions}
            </div>
          </div>
        )}

        {/* Ready Status for Trainer */}
        {isTrainer && readyStatus && (
          <div className="bg-surface-2 border border-border rounded-lg p-4 mt-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-semibold text-ink">Ready status</span>
              <span className="text-sm font-bold text-brand">
                {readyStatus.ready} / {readyStatus.total} ready
              </span>
            </div>
            <div className="space-y-1 mb-4">
              {readyStatus.participants.map((p) => (
                <div key={p.user_id} className="flex justify-between text-sm">
                  <span className="text-ink">{p.user?.full_name || 'Unknown'}</span>
                  <span
                    className={
                      p.is_ready
                        ? 'text-xs font-bold uppercase text-success'
                        : 'text-xs font-bold uppercase text-muted'
                    }
                  >
                    {p.is_ready ? 'Ready' : 'Not ready'}
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={handleStartSession}
              disabled={!readyStatus.all_ready}
              className="military-button w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {readyStatus.all_ready
                ? 'Start session'
                : `Waiting · ${readyStatus.total - readyStatus.ready} participant(s) not ready`}
            </button>
          </div>
        )}

        {/* Join Link Panel - Trainer Only */}
        {isTrainer &&
          session.join_token &&
          session.status !== 'completed' &&
          session.status !== 'cancelled' && (
            <JoinLinkPanel
              sessionId={sessionId}
              joinToken={session.join_token}
              joinEnabled={session.join_enabled ?? true}
              joinExpiresAt={session.join_expires_at}
              onUpdate={onSessionUpdate}
            />
          )}

        {/* Ready Button for Participants */}
        {!isTrainer && (
          <div className="mt-4">
            <button
              onClick={handleToggleReady}
              disabled={loading}
              className={`military-button w-full py-3 ${
                isReady ? '!bg-success !border-success' : ''
              }`}
            >
              {loading ? 'Updating…' : isReady ? 'Ready ✓' : 'Mark me as ready'}
            </button>
            {isReady && (
              <p className="text-xs text-muted mt-2 text-center">
                You are ready. Waiting for trainer to start the session…
              </p>
            )}
          </div>
        )}

        {/* Team Assignments - Show to all participants */}
        <div className="mt-4">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-bold uppercase tracking-wide text-brand">
              Team assignments
            </h3>
            {isTrainer && (
              <div className="flex gap-2">
                {isSocialSim && (
                  <button
                    onClick={() => setShowPageAssignmentModal(true)}
                    className="military-button-outline px-4 py-2 text-xs"
                  >
                    Manage pages
                  </button>
                )}
                <button
                  onClick={() => setShowTeamAssignmentModal(true)}
                  className="military-button px-4 py-2 text-xs"
                >
                  Manage teams
                </button>
              </div>
            )}
          </div>

          {myTeams.length > 0 ? (
            <div className="border-l-4 border-success bg-success/10 rounded-md p-4">
              <div className="space-y-2">
                {myTeams.map((team, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">{team.team_name}</span>
                    {team.team_role && (
                      <span className="text-xs text-muted">({team.team_role})</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted mt-2">
                You will receive team-specific information during the session.
              </p>
            </div>
          ) : (
            <div className="bg-surface-2 border border-border rounded-lg p-4">
              <p className="text-xs text-muted text-center">
                {isTrainer
                  ? 'No team assignments yet. Click “Manage teams” to assign teams.'
                  : 'No team assignments yet. Waiting for trainer to assign teams…'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Briefing Materials */}
      <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
        <h3 className="text-lg font-bold text-brand mb-4">Briefing materials</h3>
        <BriefingView sessionId={sessionId} />
      </div>

      {/* Participant Management - Trainer Only */}
      {isTrainer && (
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
                }
              : undefined,
          }))}
          onUpdate={() => {
            // Reload ready status when participants are updated
            loadReadyStatus();
            // Reload team assignments
            loadMyTeams();
            // Call parent update callback if provided
            if (onSessionUpdate) {
              onSessionUpdate();
            }
          }}
        />
      )}

      {/* Team Assignment Modal */}
      {showTeamAssignmentModal && (
        <TeamAssignmentModal
          sessionId={sessionId}
          onClose={() => setShowTeamAssignmentModal(false)}
          onSuccess={() => {
            loadMyTeams();
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
          onClose={() => setShowPageAssignmentModal(false)}
          onSuccess={() => {
            if (onSessionUpdate) {
              onSessionUpdate();
            }
          }}
        />
      )}
    </div>
  );
};
