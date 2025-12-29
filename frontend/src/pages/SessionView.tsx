import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { TimelineFeed } from '../components/COP/TimelineFeed';
import { ChatInterface } from '../components/Chat/ChatInterface';
import { DecisionWorkflow } from '../components/Decisions/DecisionWorkflow';
import { AIInjectSystem } from '../components/Injects/AIInjectSystem';
import { MediaFeed } from '../components/Media/MediaFeed';
import { AARDashboard } from '../components/AAR/AARDashboard';
import { ParticipantManagement } from '../components/Session/ParticipantManagement';
import { TeamAssignmentModal } from '../components/Teams/TeamAssignmentModal';
import { SessionLobby } from '../components/Session/SessionLobby';
import { NotificationBanner } from '../components/Notifications/NotificationBanner';
import { IncidentsPanel } from '../components/Incidents/IncidentsPanel';
import { useWebSocket } from '../hooks/useWebSocket';
import { type WebSocketEvent } from '../lib/websocketClient';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { useAuth } from '../contexts/AuthContext';

interface Session {
  id: string;
  status: string;
  scenario_id: string;
  start_time?: string | null;
  current_state?: {
    evacuation_zones?: Array<{
      id: string;
      center_lat: number;
      center_lng: number;
      radius_meters: number;
      title: string;
    }>;
    [key: string]: unknown;
  };
  trainer_instructions?: string | null;
  scheduled_start_time?: string | null;
  scenarios?: {
    id?: string;
    title: string;
    description: string;
  };
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
}

export const SessionView = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();
  const { user } = useAuth();
  // Notifications are now handled automatically by the backend notification system
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<
    'cop' | 'chat' | 'decisions' | 'injects' | 'media' | 'aar' | 'participants'
  >('cop');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [_incidents, setIncidents] = useState<
    Array<{
      id: string;
      title: string;
      description: string;
      location_lat?: number | null;
      location_lng?: number | null;
      severity: string;
      status: string;
      type: string;
      casualty_count?: number;
    }>
  >([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [showTeamAssignmentModal, setShowTeamAssignmentModal] = useState(false);
  const [myTeams, setMyTeams] = useState<Array<{ team_name: string; team_role?: string }>>([]);
  const [objectives, setObjectives] = useState<
    Array<{
      id: string;
      objective_id: string;
      objective_name: string;
      progress_percentage: number;
      status: 'not_started' | 'in_progress' | 'completed' | 'failed';
      score: number | null;
      weight: number;
    }>
  >([]);

  useEffect(() => {
    if (id) {
      loadSession();
      loadIncidents(id);
      loadMyTeams();
    }
  }, [id, user?.id]);

  useEffect(() => {
    // Only load objectives for trainers (load once, no polling)
    if (id && session?.status === 'in_progress' && isTrainer) {
      loadObjectives();
    }
  }, [id, session?.status, isTrainer]);

  useEffect(() => {
    // Check if there's a hash fragment in the URL and set the active tab accordingly
    const hash = window.location.hash.slice(1); // Remove the '#'
    const validTabs = ['cop', 'chat', 'decisions', 'injects', 'media', 'aar', 'participants'];
    if (hash && validTabs.includes(hash)) {
      setActiveTab(hash as typeof activeTab);
    }
  }, []);

  // Auto-select AAR tab for completed sessions when they load (if no hash specified)
  useEffect(() => {
    if (session?.status === 'completed' && activeTab === 'cop' && !window.location.hash) {
      setActiveTab('aar');
    }
  }, [session?.status]);

  // Also listen for hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      const validTabs = ['cop', 'chat', 'decisions', 'injects', 'media', 'aar', 'participants'];
      if (hash && validTabs.includes(hash)) {
        setActiveTab(hash as typeof activeTab);
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const loadMyTeams = async () => {
    if (!id || !user?.id) return;
    try {
      const result = await api.teams.getSessionTeams(id);
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

  const loadObjectives = async () => {
    if (!id) return;
    try {
      const result = await api.objectives.getProgress(id);
      setObjectives(
        (result.data || []) as Array<{
          id: string;
          objective_id: string;
          objective_name: string;
          progress_percentage: number;
          status: 'not_started' | 'in_progress' | 'completed' | 'failed';
          score: number | null;
          weight: number;
        }>,
      );
    } catch (error) {
      console.error('Failed to load objectives:', error);
    }
  };

  // Update current time every second for timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Calculate elapsed time
  const elapsedTime = useMemo(() => {
    if (!session?.start_time || session.status !== 'in_progress') {
      return null;
    }

    const start = new Date(session.start_time);
    const elapsed = currentTime.getTime() - start.getTime();

    const hours = Math.floor(elapsed / (1000 * 60 * 60));
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

    return {
      hours,
      minutes,
      seconds,
      totalSeconds: Math.floor(elapsed / 1000),
    };
  }, [session?.start_time, session?.status, currentTime]);

  const loadIncidents = async (sessionId: string) => {
    try {
      const result = await api.incidents.list(sessionId);
      setIncidents(
        (result.data || []) as Array<{
          id: string;
          title: string;
          description: string;
          location_lat?: number | null;
          location_lng?: number | null;
          severity: string;
          status: string;
          type: string;
          casualty_count?: number;
        }>,
      );
    } catch (error) {
      console.error('Failed to load incidents:', error);
    }
  };

  // Function commented out as it's currently unused
  // const handleIncidentClick = (incident: {
  //   id: string;
  //   title: string;
  //   description: string;
  //   location_lat?: number | null;
  //   location_lng?: number | null;
  //   severity: string;
  //   status: string;
  //   type: string;
  //   casualty_count?: number;
  // }) => {
  //   setSelectedIncidentId(incident.id);
  //   // Scroll to incidents panel if it exists
  //   setTimeout(() => {
  //     const incidentsPanel = document.getElementById('incidents-panel');
  //     if (incidentsPanel) {
  //       incidentsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  //     }
  //   }, 100);
  // };

  // WebSocket subscription for notifications
  useWebSocket({
    sessionId: id || '',
    eventTypes: [
      'inject.published',
      'decision.proposed',
      'decision.approved',
      'decision.executed',
      'resource.requested',
      'message.sent',
      'incident.created',
      'incident.updated',
    ],
    onEvent: (event: WebSocketEvent) => {
      // Handle event-specific UI updates
      // Note: Notifications are now automatically created by the backend notification system
      if (event.type === 'incident.created' || event.type === 'incident.updated') {
        // Reload incidents to update map
        if (id) {
          loadIncidents(id);
        }
      }
    },
    enabled: !!id && session?.status === 'in_progress',
  });

  const loadSession = async () => {
    if (!id) return;
    try {
      // For non-trainers, process invitations first to ensure they're added as participants
      if (!isTrainer) {
        try {
          await api.sessions.processInvitations();
        } catch (err) {
          console.debug('Failed to process invitations:', err);
          // Continue anyway - might have already been processed
        }
      }

      const result = await api.sessions.get(id);
      const sessionData = result.data as Session;
      // Add currentUserId for lobby component
      (sessionData as unknown as { currentUserId?: string }).currentUserId = user?.id;
      setSession(sessionData);
    } catch (error) {
      console.error('Failed to load session:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartSession = async () => {
    if (!id) return;
    try {
      await api.sessions.update(id, { status: 'in_progress' });
      await loadSession();
    } catch (error) {
      console.error('Failed to start session:', error);
      alert('Failed to start session');
    }
  };

  const handleCompleteSession = async () => {
    if (!id) return;
    if (
      !confirm(
        'Are you sure you want to complete this session? This will end the exercise and allow AAR generation.',
      )
    ) {
      return;
    }
    try {
      await api.sessions.update(id, { status: 'completed' });
      await loadSession();
    } catch (error) {
      console.error('Failed to complete session:', error);
      alert('Failed to complete session');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">Loading session...</div>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="military-border p-8 text-center">
          <h2 className="text-xl terminal-text text-robotic-orange mb-4">
            [ERROR] Session Not Found
          </h2>
          <button onClick={() => navigate('/sessions')} className="military-button px-6 py-3">
            [BACK_TO_SESSIONS]
          </button>
        </div>
      </div>
    );
  }

  // Show lobby if session is scheduled
  if (session.status === 'scheduled') {
    return (
      <div className="min-h-screen scanline">
        {/* Notification Banner */}
        <NotificationBanner />

        {/* Header */}
        <div className="military-border border-b-2 border-robotic-yellow bg-robotic-gray-300">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <div>
                <h1 className="text-lg terminal-text uppercase">
                  {session.scenarios?.title || 'Session'}
                </h1>
                <p className="text-xs terminal-text text-robotic-yellow/70">
                  Status: {session.status.toUpperCase().replace('_', ' ')}
                </p>
              </div>
              <button
                onClick={() => navigate('/sessions')}
                className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
              >
                [BACK]
              </button>
            </div>
          </div>
        </div>

        {/* Lobby Content */}
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          {id && (
            <SessionLobby
              sessionId={id}
              session={session}
              onStartSession={handleStartSession}
              onSessionUpdate={loadSession}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen scanline">
      {/* Notification Banner */}
      <NotificationBanner />

      {/* Header */}
      <div className="military-border border-b-2 border-robotic-yellow bg-robotic-gray-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-6 flex-1">
              <div>
                <h1 className="text-lg terminal-text uppercase">
                  {session.scenarios?.title || 'Session'}
                </h1>
                <p className="text-xs terminal-text text-robotic-yellow/70">
                  Status: {session.status.toUpperCase().replace('_', ' ')}
                </p>
              </div>
              {/* Team Assignments Badge */}
              {myTeams.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                    Teams:
                  </span>
                  <div className="flex gap-1">
                    {myTeams.map((team, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-1 text-xs terminal-text military-border bg-robotic-green/20 border-robotic-green"
                      >
                        {team.team_name.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {elapsedTime && (
                <div className="military-border px-4 py-2 bg-robotic-gray-200 border-robotic-yellow">
                  <div className="flex items-center gap-2">
                    <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                      [ELAPSED_TIME]
                    </span>
                    <span className="text-lg terminal-text text-robotic-yellow font-mono font-bold">
                      {String(elapsedTime.hours).padStart(2, '0')}:
                      {String(elapsedTime.minutes).padStart(2, '0')}:
                      {String(elapsedTime.seconds).padStart(2, '0')}
                    </span>
                  </div>
                </div>
              )}
              {session.status === 'completed' && (
                <div className="military-border px-4 py-2 bg-robotic-green/20 border-robotic-green">
                  <span className="text-xs terminal-text text-robotic-green uppercase">
                    [SESSION_COMPLETED]
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isTrainer && session.status === 'in_progress' && (
                <button
                  onClick={handleCompleteSession}
                  className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-red text-robotic-red hover:bg-robotic-red/10"
                >
                  [COMPLETE_SESSION]
                </button>
              )}
              <button
                onClick={() => navigate('/sessions')}
                className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
              >
                [BACK]
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Team Assignments Info Panel - Show during active session */}
      {session.status === 'in_progress' && myTeams.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="military-border p-4 bg-robotic-green/10 border-robotic-green">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm terminal-text uppercase text-robotic-green">
                [YOUR_TEAM_ASSIGNMENTS]
              </span>
              <div className="flex gap-2 flex-wrap">
                {myTeams.map((team, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 px-3 py-1 military-border bg-robotic-gray-200"
                  >
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
            </div>
            <p className="text-xs terminal-text text-robotic-yellow/70 mt-2">
              You will receive team-specific injects and information during the session.
            </p>
          </div>
        </div>
      )}

      {/* Objectives Progress Panel - Show during active session (trainer only) */}
      {session.status === 'in_progress' && isTrainer && objectives.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="military-border p-4 bg-robotic-gray-200">
            <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-3">
              [OBJECTIVES]
            </h3>
            <div className="space-y-3">
              {objectives.map((objective) => {
                const statusColor =
                  objective.status === 'completed'
                    ? 'text-robotic-green border-robotic-green'
                    : objective.status === 'failed'
                      ? 'text-robotic-red border-robotic-red'
                      : objective.status === 'in_progress'
                        ? 'text-robotic-yellow border-robotic-yellow'
                        : 'text-robotic-gray-50 border-robotic-gray-50';

                return (
                  <div key={objective.id} className="military-border p-3 bg-robotic-gray-300">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm terminal-text font-semibold">
                        {objective.objective_name}
                      </span>
                      <span className={`text-xs terminal-text px-2 py-1 border ${statusColor}`}>
                        {objective.status.toUpperCase().replace('_', ' ')}
                      </span>
                    </div>
                    <div className="w-full bg-robotic-gray-400 h-2 mb-1">
                      <div
                        className={`h-full ${
                          objective.status === 'completed'
                            ? 'bg-robotic-green'
                            : objective.status === 'failed'
                              ? 'bg-robotic-red'
                              : 'bg-robotic-yellow'
                        }`}
                        style={{ width: `${objective.progress_percentage}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs terminal-text text-robotic-yellow/70">
                      <span>{objective.progress_percentage}% Complete</span>
                      {objective.score !== null && <span>Score: {objective.score}/100</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            {objectives.every((obj) => obj.status === 'completed' || obj.status === 'failed') && (
              <div className="mt-3 p-2 military-border bg-robotic-yellow/10 border-robotic-yellow">
                <p className="text-xs terminal-text text-robotic-yellow">
                  [ALL_OBJECTIVES_RESOLVED] All objectives have been completed or failed.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="military-border border-b border-robotic-yellow/30 bg-robotic-gray-300">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-4 flex-wrap">
            {(
              [
                'cop',
                'chat',
                'decisions',
                'injects',
                'media',
                'aar',
                ...(isTrainer ? ['participants' as const] : []),
              ] as const
            ).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab as typeof activeTab)}
                className={`px-4 py-2 text-xs terminal-text uppercase border-b-2 transition-all ${
                  activeTab === tab
                    ? 'border-robotic-yellow text-robotic-yellow'
                    : 'border-transparent text-robotic-yellow/50 hover:text-robotic-yellow/70'
                } ${session.status === 'completed' && tab === 'aar' ? 'bg-robotic-green/10' : ''}`}
              >
                [{tab.toUpperCase()}]
                {session.status === 'completed' && tab === 'aar' && (
                  <span className="ml-2 text-robotic-green">●</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {activeTab === 'cop' && (
          <div className="space-y-6">
            <div className="military-border p-6">
              <h2 className="text-xl terminal-text uppercase mb-4">
                [COP] Common Operating Picture
              </h2>
              <p className="text-sm terminal-text text-robotic-yellow/70 mb-4">
                Real-time situational awareness dashboard
              </p>
              {/* Interactive Map - Temporarily disabled */}
              <div
                className="mb-6 military-border p-8 text-center"
                style={{ height: '400px', minHeight: '400px' }}
              >
                <h3 className="text-lg terminal-text text-robotic-orange mb-4">
                  [MAP_UNAVAILABLE]
                </h3>
                <p className="text-sm terminal-text text-robotic-yellow/70 mb-4">
                  The interactive map is temporarily disabled.
                </p>
                <p className="text-xs terminal-text text-robotic-yellow/50">
                  Map functionality will be restored in a future update.
                </p>
              </div>
            </div>

            {/* Incidents Panel */}
            {id && (
              <div id="incidents-panel" className="military-border p-6">
                <IncidentsPanel
                  sessionId={id}
                  selectedIncidentId={selectedIncidentId}
                  onIncidentSelect={(incidentId) => setSelectedIncidentId(incidentId)}
                />
              </div>
            )}

            {/* Timeline Feed */}
            {id && (
              <div className="military-border p-6">
                <TimelineFeed sessionId={id} />
              </div>
            )}
          </div>
        )}

        {activeTab === 'chat' && id && <ChatInterface sessionId={id} />}

        {activeTab === 'decisions' && id && <DecisionWorkflow sessionId={id} />}

        {activeTab === 'injects' && id && session.scenarios && session.scenarios.id && (
          <AIInjectSystem sessionId={id} scenarioId={session.scenarios.id} />
        )}

        {activeTab === 'media' && id && <MediaFeed sessionId={id} />}

        {activeTab === 'aar' && id && <AARDashboard sessionId={id} />}

        {activeTab === 'participants' && id && session && (
          <div className="space-y-4">
            {isTrainer && (
              <div className="military-border p-4 flex justify-between items-center">
                <h3 className="text-lg terminal-text uppercase">[PARTICIPANT_MANAGEMENT]</h3>
                <button
                  onClick={() => setShowTeamAssignmentModal(true)}
                  className="military-button px-4 py-2 text-sm"
                >
                  [MANAGE_TEAMS]
                </button>
              </div>
            )}
            <ParticipantManagement
              sessionId={id}
              participants={(session.participants || []).map((p) => ({
                ...p,
                user: p.user
                  ? {
                      id: p.user_id,
                      full_name: p.user.full_name,
                      email: '',
                      role: p.user.role,
                      agency_name: '',
                    }
                  : undefined,
              }))}
              onUpdate={loadSession}
            />
            {showTeamAssignmentModal && id && (
              <TeamAssignmentModal
                sessionId={id}
                onClose={() => setShowTeamAssignmentModal(false)}
                onSuccess={() => {
                  loadSession();
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
