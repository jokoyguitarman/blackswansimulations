import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { BriefingView } from './BriefingView';
import { ParticipantManagement } from './ParticipantManagement';
import { TeamAssignmentModal } from '../Teams/TeamAssignmentModal';
import { useRoleVisibility } from '../../hooks/useRoleVisibility';
import { useAuth } from '../../contexts/AuthContext';
import { websocketClient } from '../../lib/websocketClient';

interface SessionLobbyProps {
  sessionId: string;
  session: {
    status: string;
    trainer_instructions?: string | null;
    scheduled_start_time?: string | null;
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
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
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
        unsubscribe = websocketClient.on('participant.ready_status_updated', (event) => {
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
        });
      } catch (error) {
        console.error('Failed to setup WebSocket:', error);
        setWsConnected(false);
        // No polling fallback - WebSocket is required for real-time updates
        // User will need to refresh if WebSocket fails
      }
    };

    setupWebSocket();

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
      websocketClient.leaveSession(sessionId);
    };
  }, [sessionId, isTrainer, user?.id]);

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
      <div className="military-border p-6 bg-robotic-gray-300">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-xl terminal-text uppercase mb-2">[SESSION_LOBBY]</h2>
            <p className="text-sm terminal-text text-robotic-yellow/70">
              Waiting for trainer to start the session...
            </p>
          </div>
          {scheduledTime && (
            <div className="text-right">
              <div className="text-xs terminal-text text-robotic-yellow/50 uppercase">
                Scheduled Start
              </div>
              <div className="text-sm terminal-text">
                {timeUntilStart && timeUntilStart > 0
                  ? `${Math.floor(timeUntilStart / 60000)} minutes`
                  : scheduledTime.toLocaleString()}
              </div>
            </div>
          )}
        </div>

        {/* Trainer Instructions */}
        {session.trainer_instructions && (
          <div className="military-border p-4 bg-robotic-yellow/10 border-robotic-yellow mt-4">
            <h3 className="text-sm terminal-text uppercase mb-2 text-robotic-yellow">
              [TRAINER_INSTRUCTIONS]
            </h3>
            <div className="text-sm terminal-text text-robotic-yellow/90 whitespace-pre-wrap">
              {session.trainer_instructions}
            </div>
          </div>
        )}

        {/* Ready Status for Trainer */}
        {isTrainer && readyStatus && (
          <div className="military-border p-4 bg-robotic-gray-300 mt-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm terminal-text uppercase">[READY_STATUS]</span>
              <span className="text-sm terminal-text">
                {readyStatus.ready} / {readyStatus.total} Ready
              </span>
            </div>
            <div className="space-y-1 mb-4">
              {readyStatus.participants.map((p) => (
                <div key={p.user_id} className="flex justify-between text-xs terminal-text">
                  <span>{p.user?.full_name || 'Unknown'}</span>
                  <span className={p.is_ready ? 'text-robotic-yellow' : 'text-robotic-yellow/50'}>
                    {p.is_ready ? '[READY]' : '[NOT_READY]'}
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
                ? '[START_SESSION]'
                : `[WAITING] ${readyStatus.total - readyStatus.ready} participant(s) not ready`}
            </button>
          </div>
        )}

        {/* Ready Button for Participants */}
        {!isTrainer && (
          <div className="mt-4">
            <button
              onClick={handleToggleReady}
              disabled={loading}
              className={`military-button w-full py-3 ${
                isReady ? 'bg-robotic-yellow/20 border-robotic-yellow' : ''
              }`}
            >
              {loading ? '[UPDATING...]' : isReady ? '[READY] ✓' : '[MARK_AS_READY]'}
            </button>
            {isReady && (
              <p className="text-xs terminal-text text-robotic-yellow/70 mt-2 text-center">
                You are ready. Waiting for trainer to start the session...
              </p>
            )}
          </div>
        )}

        {/* Team Assignments - Show to all participants */}
        <div className="mt-4">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm terminal-text uppercase text-robotic-green">
              [TEAM_ASSIGNMENTS]
            </h3>
            {isTrainer && (
              <button
                onClick={() => setShowTeamAssignmentModal(true)}
                className="military-button px-4 py-2 text-xs"
              >
                [MANAGE_TEAMS]
              </button>
            )}
          </div>

          {myTeams.length > 0 ? (
            <div className="military-border p-4 bg-robotic-green/10 border-robotic-green">
              <div className="space-y-2">
                {myTeams.map((team, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-sm terminal-text font-semibold">
                      {team.team_name.toUpperCase()}
                    </span>
                    {team.team_role && (
                      <span className="text-xs terminal-text text-robotic-yellow/70">
                        ({team.team_role})
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs terminal-text text-robotic-yellow/70 mt-2">
                You will receive team-specific information during the session.
              </p>
            </div>
          ) : (
            <div className="military-border p-4 bg-robotic-gray-200">
              <p className="text-xs terminal-text text-robotic-yellow/50 text-center">
                {isTrainer
                  ? 'No team assignments yet. Click [MANAGE_TEAMS] to assign teams.'
                  : 'No team assignments yet. Waiting for trainer to assign teams...'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Briefing Materials */}
      <div className="military-border p-6">
        <h3 className="text-lg terminal-text uppercase mb-4">[BRIEFING_MATERIALS]</h3>
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
    </div>
  );
};
