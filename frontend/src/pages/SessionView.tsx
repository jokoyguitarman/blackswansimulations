import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ChatInterface } from '../components/Chat/ChatInterface';
import { DecisionWorkflow } from '../components/Decisions/DecisionWorkflow';
import { AIInjectSystem } from '../components/Injects/AIInjectSystem';
import { MediaFeed } from '../components/Media/MediaFeed';
import { AARDashboard } from '../components/AAR/AARDashboard';
import { DecisionsAIRatingsPanel } from '../components/AAR/DecisionsAIRatingsPanel';
import { ParticipantManagement } from '../components/Session/ParticipantManagement';
import { TrainerEnvironmentalTruths } from '../components/Session/TrainerEnvironmentalTruths';
import { TeamAssignmentModal } from '../components/Teams/TeamAssignmentModal';
import { SessionLobby } from '../components/Session/SessionLobby';
import { NotificationBell } from '../components/Notifications/NotificationBell';
import { IncidentsPanel } from '../components/Incidents/IncidentsPanel';
import { MapView } from '../components/COP/MapView';
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
  join_token?: string | null;
  join_enabled?: boolean;
  join_expires_at?: string | null;
  scenarios?: {
    id?: string;
    title: string;
    description: string;
    center_lat?: number | null;
    center_lng?: number | null;
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

interface CounterDefinition {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'enum';
  initial_value: number | boolean | string;
  behavior: string;
  visible_to?: 'all' | 'trainer_only';
  config?: {
    cap_key?: string;
    [k: string]: unknown;
  };
}

interface ScenarioTeamWithCounters {
  team_name: string;
  team_description?: string;
  counter_definitions?: CounterDefinition[] | null;
}

/**
 * Flatten any nested objects inside *_state entries of current_state to primitives.
 * Prevents React error #31 when AI-generated state contains objects as counter values.
 */
function sanitizeCurrentState(state: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (
      key.endsWith('_state') &&
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const teamState: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v != null && typeof v === 'object' && !Array.isArray(v)) {
          teamState[k] = JSON.stringify(v);
        } else {
          teamState[k] = v;
        }
      }
      result[key] = teamState;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const SessionView = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();
  const { user } = useAuth();
  // Notifications are now handled automatically by the backend notification system
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  // Card notification state: 'new' = green dot, 'viewed' = yellow dot, 'none' = no dot
  const [cardNotifications, setCardNotifications] = useState<
    Record<string, 'new' | 'viewed' | 'none'>
  >({});
  const [showMapModule, setShowMapModule] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#show-map',
  );
  const [mapModuleReady, setMapModuleReady] = useState(false);
  const [mapHasBeenOpened, setMapHasBeenOpened] = useState(false);
  const [locationsRefreshTrigger, setLocationsRefreshTrigger] = useState(0);
  const sessionContentRef = useRef<HTMLDivElement | null>(null);
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
  const [scenarioTeams, setScenarioTeams] = useState<ScenarioTeamWithCounters[]>([]);
  const [backendDecisions, setBackendDecisions] = useState<
    Array<{
      id: string;
      title: string;
      executed_at: string | null;
      environmental_consistency?: {
        consistent?: boolean;
        mismatch_kind?: string;
        severity?: string;
        reason?: string;
      } | null;
    }>
  >([]);
  const [backendActivities, setBackendActivities] = useState<
    Array<{
      type: string;
      at: string;
      title?: string;
      reason?: string;
      step?: string;
      summary?: string;
      matrix?: Record<string, Record<string, number>>;
      robustness_by_decision?: Record<string, number>;
      response_taxonomy?: Record<string, string>;
      analysis?: {
        overall?: string;
        matrix_reasoning?: string;
        robustness_reasoning?: string;
        matrix_cell_reasoning?: Record<string, Record<string, string>>;
        raw_robustness_by_decision?: Record<string, number>;
        robustness_cap_detail?: Record<
          string,
          { raw: number; capped: number; severity: string; mismatch_kind: string; reason?: string }
        >;
      };
      computed_band?: 'low' | 'medium' | 'high';
      managed_effect_keys?: string[];
      factors?: Array<{ id: string; name: string; description: string; severity: string }>;
      de_escalation_factors?: Array<{ id: string; name: string; description: string }>;
      pathways?: Array<{
        pathway_id: string;
        trajectory: string;
        trigger_behaviours: string[];
      }>;
      de_escalation_pathways?: Array<{
        pathway_id: string;
        trajectory: string;
        mitigating_behaviours: string[];
        emerging_challenges?: string[];
      }>;
    }>
  >([]);

  // Sync map module visibility with #show-map hash (link in Insider reply opens map via hash).
  useEffect(() => {
    const syncFromHash = () => {
      setShowMapModule(window.location.hash === '#show-map');
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  // Once the user opens the map, keep it mounted but hidden when closed (avoids Leaflet removeChild on unmount).
  useEffect(() => {
    if (showMapModule) setMapHasBeenOpened(true);
  }, [showMapModule]);

  // Mount MapView as soon as the map module is shown so Leaflet gets into the DOM.
  useEffect(() => {
    if (!showMapModule) {
      setMapModuleReady(false);
      return;
    }
    setMapModuleReady(true);
  }, [showMapModule]);

  useEffect(() => {
    if (id) {
      loadSession();
      loadIncidents(id);
      loadMyTeams();
    }
  }, [id, user?.id]);

  // Load scenario teams when session has scenario (for dynamic team counters)
  useEffect(() => {
    const scenarioId = session?.scenarios?.id ?? session?.scenario_id;
    if (!scenarioId) return;
    api.teams
      .getScenarioTeams(scenarioId)
      .then((r) => setScenarioTeams(r.data || []))
      .catch(() => setScenarioTeams([]));
  }, [session?.scenarios?.id, session?.scenario_id]);

  // Backend/AI activity log for trainers (poll every 8s when in progress, load once when completed)
  useEffect(() => {
    if (!id || !isTrainer || !session) return;
    if (session.status !== 'in_progress' && session.status !== 'completed') return;
    const loadBackendActivity = async () => {
      try {
        const res = await api.sessions.getBackendActivity(id);
        setBackendActivities(res.activities || []);
        setBackendDecisions(res.decisions || []);
      } catch {
        // Non-blocking; leave previous data
      }
    };
    loadBackendActivity();
    const interval =
      session.status === 'in_progress' ? setInterval(loadBackendActivity, 8000) : undefined;
    return () => (interval ? clearInterval(interval) : undefined);
  }, [id, isTrainer, session?.status]);

  // Mark card as viewed (green → yellow dot)
  const markCardViewed = (cardId: string) => {
    setCardNotifications((prev) => {
      if (prev[cardId] === 'new') {
        return { ...prev, [cardId]: 'viewed' };
      }
      return prev;
    });
  };

  const loadMyTeams = async () => {
    if (!id || !user?.id) {
      console.log('[SessionView] loadMyTeams: Missing id or user.id', { id, userId: user?.id });
      return;
    }
    try {
      const result = await api.teams.getSessionTeams(id);
      console.log('[SessionView] loadMyTeams: API result', {
        allAssignments: result.data,
        userId: user.id,
      });
      const myTeamAssignments = (result.data || []).filter(
        (assignment: any) => assignment.user_id === user.id,
      );
      console.log('[SessionView] loadMyTeams: Filtered assignments', myTeamAssignments);
      setMyTeams(
        myTeamAssignments.map((a: any) => ({
          team_name: a.team_name,
          team_role: a.team_role,
        })),
      );
    } catch (error) {
      console.error('[SessionView] Failed to load team assignments:', error);
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

  // WebSocket subscription for notifications and card updates
  useWebSocket({
    sessionId: id || '',
    eventTypes: [
      'inject.published',
      'decision.proposed',
      'decision.approved',
      'decision.executed',
      'resource.requested',
      'resource.countered',
      'resource.approved',
      'resource.rejected',
      'resource.transferred',
      'message.sent',
      'incident.created',
      'incident.updated',
      'media_post',
      'state.updated',
    ],
    onEvent: (event: WebSocketEvent) => {
      if (event.type === 'state.updated') {
        const rawState = (event.data as { state?: Record<string, unknown> })?.state;
        if (rawState) {
          const state = sanitizeCurrentState(rawState);
          setSession((prev) => (prev ? { ...prev, current_state: state } : null));
        }
        return;
      }
      // Handle event-specific UI updates
      // Note: Notifications are now automatically created by the backend notification system

      // Update card notification dots based on event type
      if (event.type === 'inject.published') {
        setCardNotifications((prev) => ({ ...prev, injects: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (
        event.type === 'decision.proposed' ||
        event.type === 'decision.approved' ||
        event.type === 'decision.executed'
      ) {
        setCardNotifications((prev) => ({ ...prev, decisions: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (event.type === 'message.sent') {
        setCardNotifications((prev) => ({ ...prev, chat: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      } else if (event.type === 'incident.created' || event.type === 'incident.updated') {
        setCardNotifications((prev) => ({ ...prev, incidents: 'new' }));
        // Also update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
        // Reload incidents to update map
        if (id) {
          loadIncidents(id);
        }
      } else if (event.type === 'media_post') {
        setCardNotifications((prev) => ({ ...prev, media: 'new' }));
      } else if (
        event.type === 'resource.requested' ||
        event.type === 'resource.countered' ||
        event.type === 'resource.approved' ||
        event.type === 'resource.rejected' ||
        event.type === 'resource.transferred'
      ) {
        // Resource events update timeline
        setCardNotifications((prev) => ({ ...prev, timeline: 'new' }));
      }
    },
    enabled: !!id && session?.status === 'in_progress',
  });

  const loadSession = async () => {
    if (!id) return;
    try {
      // Remove this - it's already called in Sessions page
      // if (!isTrainer) {
      //   try {
      //     await api.sessions.processInvitations();
      //   } catch (err) {
      //     console.debug('Failed to process invitations:', err);
      //   }
      // }

      const result = await api.sessions.get(id);
      const sessionData = result.data as Session;
      if (sessionData.current_state && typeof sessionData.current_state === 'object') {
        sessionData.current_state = sanitizeCurrentState(
          sessionData.current_state as Record<string, unknown>,
        ) as Session['current_state'];
      }
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
              <div className="flex items-center gap-4">
                <NotificationBell />
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
              {/* Player Name and Team Assignments */}
              <div className="flex items-center gap-4">
                {/* Player Name */}
                {user && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                      Player:
                    </span>
                    <span className="px-2 py-1 text-xs terminal-text military-border bg-robotic-gray-200 border-robotic-yellow">
                      {session?.participants?.find((p) => p.user_id === user.id)?.user?.full_name ||
                        user.displayName ||
                        user.email ||
                        'Unknown'}
                    </span>
                  </div>
                )}
                {/* Team Assignments Badge */}
                <div className="flex items-center gap-2">
                  <span className="text-xs terminal-text text-robotic-yellow/70 uppercase">
                    Teams:
                  </span>
                  {myTeams.length > 0 ? (
                    <div className="flex gap-1">
                      {myTeams.map((team, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 text-xs terminal-text military-border bg-robotic-green/20 border-robotic-green"
                        >
                          {team.team_name.toUpperCase()}
                          {team.team_role && (
                            <span className="ml-1 text-robotic-yellow/70">({team.team_role})</span>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="px-2 py-1 text-xs terminal-text text-robotic-yellow/50 italic">
                      [NO_TEAMS_ASSIGNED]
                    </span>
                  )}
                </div>
              </div>
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
              <NotificationBell />
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

      {/* Team Counters Panel - dynamic per scenario teams; trainer sees all, participant sees own team(s) */}
      {(session.status === 'in_progress' || session.status === 'completed') &&
        (() => {
          const cs = session.current_state as Record<string, unknown> | undefined;

          // Map team_name to current_state key (backward compat: Evacuation/Triage/Media)
          const teamToStateKey = (name: string): string => {
            const n = (name ?? '').toLowerCase();
            if (/evacuation|evac/.test(n)) return 'evacuation_state';
            if (/triage/.test(n)) return 'triage_state';
            if (/media/.test(n)) return 'media_state';
            return `${n.replace(/\s+/g, '_')}_state`;
          };

          // Use scenario teams when available; fallback to legacy evac/triage/media if no teams
          const teamsToShow =
            scenarioTeams.length > 0
              ? scenarioTeams
              : [{ team_name: 'Evacuation' }, { team_name: 'Triage' }, { team_name: 'Media' }];

          const blocks: React.ReactNode[] = [];
          for (const team of teamsToShow) {
            const stateKey = teamToStateKey(team.team_name);
            const state = (cs?.[stateKey] as Record<string, unknown> | undefined) ?? {};
            const showBlock =
              isTrainer ||
              myTeams.some((t) => t.team_name?.toLowerCase() === team.team_name?.toLowerCase());
            if (!showBlock) continue;
            if (Object.keys(state).length === 0 && !isTrainer) continue;

            const displayName =
              team.team_name.charAt(0).toUpperCase() + (team.team_name?.slice(1) ?? '');

            const defs = (team as ScenarioTeamWithCounters).counter_definitions;

            if (defs && Array.isArray(defs) && defs.length > 0) {
              // Data-driven rendering from counter_definitions
              const visibleDefs = defs.filter((d) => d.visible_to !== 'trainer_only' || isTrainer);
              if (visibleDefs.length === 0 && !isTrainer) continue;

              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    {visibleDefs.map((def) => {
                      const val = state[def.key];
                      if (def.type === 'number') {
                        const numVal = Math.max(0, Number(val) || 0);
                        const capKey = def.config?.cap_key;
                        const capVal = capKey ? Math.max(0, Number(state[capKey]) || 0) : null;
                        return (
                          <div key={def.key}>
                            {def.label}: {numVal}
                            {capVal != null && capVal > 0 && (
                              <>
                                {' / '}
                                {capVal}
                                <span className="text-robotic-yellow/70 ml-1">
                                  ({Math.round((numVal / capVal) * 100)}%)
                                </span>
                              </>
                            )}
                          </div>
                        );
                      } else if (def.type === 'boolean') {
                        return (
                          <div key={def.key}>
                            {def.label}: {val === true ? 'Yes' : 'No'}
                          </div>
                        );
                      } else {
                        return (
                          <div key={def.key}>
                            {def.label}:{' '}
                            {val == null
                              ? '–'
                              : typeof val === 'object'
                                ? JSON.stringify(val)
                                : String(val)}
                          </div>
                        );
                      }
                    })}
                  </div>
                </div>,
              );
            } else if (stateKey === 'evacuation_state') {
              // Legacy hardcoded rendering
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50">
                    Evacuated: {Math.max(0, Number(state.evacuated_count) || 0)} /{' '}
                    {Math.max(0, Number(state.total_evacuees) || 1000)}
                    {(Number(state.total_evacuees) || 1000) > 0 && (
                      <span className="text-robotic-yellow/70 ml-1">
                        (
                        {Math.round(
                          ((Number(state.evacuated_count) || 0) /
                            (Number(state.total_evacuees) || 1000)) *
                            100,
                        )}
                        %)
                      </span>
                    )}
                  </div>
                </div>,
              );
            } else if (stateKey === 'triage_state') {
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>
                      Patients being treated:{' '}
                      {Math.max(0, Number(state.patients_being_treated) || 0)}
                    </div>
                    <div>
                      Patients waiting medical attention:{' '}
                      {Math.max(0, Number(state.patients_waiting) || 0)}
                    </div>
                    <div>
                      Handed over to hospital:{' '}
                      {Math.max(0, Number(state.handed_over_to_hospital) || 0)}
                    </div>
                    <div>Casualties: {Math.max(0, Number(state.casualties) || 0)}</div>
                    <div>Deaths on site: {Math.max(0, Number(state.deaths_on_site) || 0)}</div>
                  </div>
                </div>,
              );
            } else if (stateKey === 'media_state') {
              blocks.push(
                <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                  <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                    {displayName}
                  </div>
                  <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                    <div>
                      Statements issued: {Math.max(0, Number(state.statements_issued) || 0)}
                    </div>
                    <div>
                      Misinformation addressed:{' '}
                      {Math.max(0, Number(state.misinformation_addressed_count) || 0)}
                    </div>
                    <div>
                      Public sentiment:{' '}
                      {state.public_sentiment != null ? Number(state.public_sentiment) : '–'} / 10
                      {state.sentiment_label != null ? (
                        <span
                          className="ml-1 text-robotic-yellow/70"
                          title={String(state.sentiment_reason ?? '')}
                        >
                          ({String(state.sentiment_label)})
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>,
              );
            } else {
              // Generic team: show counter-like keys (numbers, booleans as yes/no)
              const entries = Object.entries(state).filter(
                ([_, v]) =>
                  typeof v === 'number' ||
                  typeof v === 'boolean' ||
                  (typeof v === 'string' && v.length < 50),
              );
              if (entries.length > 0 || isTrainer) {
                blocks.push(
                  <div key={stateKey} className="military-border p-3 bg-robotic-gray-300">
                    <div className="text-xs terminal-text uppercase text-robotic-yellow/80 mb-2">
                      {displayName}
                    </div>
                    <div className="text-sm terminal-text text-robotic-gray-50 space-y-1">
                      {entries.length > 0 ? (
                        entries.map(([k, v]) => (
                          <div key={k}>
                            {k.replace(/_/g, ' ')}:{' '}
                            {typeof v === 'boolean'
                              ? v
                                ? 'Yes'
                                : 'No'
                              : typeof v === 'object' && v !== null
                                ? JSON.stringify(v)
                                : String(v)}
                          </div>
                        ))
                      ) : (
                        <span className="text-robotic-gray-500 text-xs">No metrics yet</span>
                      )}
                    </div>
                  </div>,
                );
              }
            }
          }

          if (blocks.length === 0) return null;
          return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
              <div className="military-border p-4 bg-robotic-gray-200">
                <h3 className="text-sm terminal-text uppercase text-robotic-yellow mb-3">
                  [TEAM METRICS]
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {blocks}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Card-Based Content Grid */}
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <div
          ref={sessionContentRef}
          className="grid grid-cols-1 md:grid-cols-2 gap-6"
          tabIndex={-1}
        >
          {/* Row 1: Incidents Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('incidents')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[INCIDENTS]</h3>
                {cardNotifications['incidents'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['incidents'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <IncidentsPanel
                  sessionId={id}
                  selectedIncidentId={selectedIncidentId}
                  onIncidentSelect={(incidentId) => setSelectedIncidentId(incidentId)}
                />
              </div>
            </div>
          )}

          {/* Row 1: Decisions Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('decisions')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[DECISIONS]</h3>
                {cardNotifications['decisions'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['decisions'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <DecisionWorkflow sessionId={id} />
              </div>
            </div>
          )}

          {/* Chat Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('chat')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[CHAT]</h3>
                {cardNotifications['chat'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['chat'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <ChatInterface
                  sessionId={id}
                  onInsiderAsked={() => setLocationsRefreshTrigger((t) => t + 1)}
                />
              </div>
            </div>
          )}

          {/* Row 3: Media Card */}
          {id && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('media')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[MEDIA]</h3>
                {cardNotifications['media'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['media'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <MediaFeed sessionId={id} />
              </div>
            </div>
          )}

          {/* Row 3+: Injects Card - Trainer only */}
          {id && session.scenarios && session.scenarios.id && isTrainer && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('injects')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[INJECTS]</h3>
                {cardNotifications['injects'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['injects'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <AIInjectSystem sessionId={id} scenarioId={session.scenarios.id} />
              </div>
            </div>
          )}

          {/* Row 3+: Participants Card - Trainer only */}
          {id && session && isTrainer && (
            <div
              className="military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
              onClick={() => markCardViewed('participants')}
            >
              <div className="flex items-center justify-between mb-4 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[PARTICIPANTS]</h3>
                {cardNotifications['participants'] === 'new' && (
                  <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                )}
                {cardNotifications['participants'] === 'viewed' && (
                  <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                <div className="space-y-4">
                  {isTrainer && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm terminal-text text-robotic-yellow/70">
                        [MANAGE_TEAMS]
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowTeamAssignmentModal(true);
                        }}
                        className="military-button px-4 py-2 text-sm"
                      >
                        [MANAGE]
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
              </div>
            </div>
          )}

          {/* Trainer only: Environmental truths (2 cols), then full map (2 cols), then Timeline last (2 cols × 2 rows) */}
          {id && isTrainer && session?.scenarios?.id && (
            <>
              {/* Environmental truths / conditions - 2 columns width */}
              <div
                className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative flex flex-col h-[750px]"
                onClick={() => markCardViewed('env_truths')}
              >
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">
                    [ENVIRONMENTAL TRUTHS] Conditions players are evaluated against
                  </h3>
                </div>
                <div
                  className="flex-1 overflow-y-auto min-h-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <TrainerEnvironmentalTruths sessionId={id} scenarioId={session.scenarios.id} />
                </div>
              </div>

              {/* Trainer map - 2 columns, always visible, all pins */}
              <div className="md:col-span-2 military-border p-6 bg-robotic-gray-300 flex flex-col h-[700px]">
                <div className="flex justify-between items-center mb-3 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">
                    [TRAINER MAP] All markings and pins
                  </h3>
                </div>
                <div className="flex-1 min-h-0 rounded border border-robotic-yellow/30 overflow-hidden h-[620px]">
                  <MapView
                    sessionId={id}
                    incidents={[]}
                    resources={[]}
                    isVisible={true}
                    fillHeight
                    showAllPins
                    locationsRefreshTrigger={locationsRefreshTrigger}
                    initialCenter={
                      session?.scenarios?.center_lat != null &&
                      session?.scenarios?.center_lng != null
                        ? ([session.scenarios.center_lat, session.scenarios.center_lng] as [
                            number,
                            number,
                          ])
                        : [1.3521, 103.8198]
                    }
                    initialZoom={16}
                  />
                </div>
              </div>

              {/* Decisions & AI Ratings - 2 cols, before timeline (completed sessions only) */}
              {session.status === 'completed' && (
                <div
                  className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer overflow-visible flex flex-col h-[750px]"
                  onClick={() => markCardViewed('decisions_ai')}
                >
                  <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg terminal-text uppercase">[DECISIONS & AI RATINGS]</h3>
                    {cardNotifications['decisions_ai'] === 'new' && (
                      <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                    )}
                    {cardNotifications['decisions_ai'] === 'viewed' && (
                      <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                    )}
                  </div>
                  <div
                    className="flex-1 overflow-y-auto min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DecisionsAIRatingsPanel sessionId={id} />
                  </div>
                </div>
              )}

              {/* Timeline - 2 cols, fixed height (3 rows), scrollable */}
              <div
                className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer flex flex-col h-[420px]"
                onClick={() => markCardViewed('timeline')}
              >
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                  <h3 className="text-lg terminal-text uppercase">[TIMELINE] Session activity</h3>
                  {cardNotifications['timeline'] === 'new' && (
                    <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                  )}
                  {cardNotifications['timeline'] === 'viewed' && (
                    <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                  )}
                </div>
                <div
                  className="flex-1 overflow-y-auto min-h-0 space-y-2 text-sm"
                  onClick={(e) => e.stopPropagation()}
                >
                  {session?.status !== 'in_progress' && session?.status !== 'completed' ? (
                    <p className="text-robotic-yellow/70">
                      No activity yet. Session activity (injects, impact matrix, escalation) will
                      appear here when the session is in progress.
                    </p>
                  ) : backendActivities.length === 0 ? (
                    <p className="text-robotic-yellow/70">
                      No activity yet. Injects and impact matrix will appear here.
                    </p>
                  ) : (
                    backendActivities.map((a, i) => (
                      <div
                        key={`${a.type}-${a.at}-${a.step ?? ''}-${i}`}
                        className="border border-robotic-yellow/30 p-2 bg-robotic-gray-300/80 font-mono text-xs"
                      >
                        <span className="text-robotic-yellow/90">
                          {new Date(a.at).toLocaleTimeString()}
                        </span>
                        {' — '}
                        {a.type === 'inject_published' && (
                          <span className="text-robotic-green">
                            Inject published: {a.title ?? '—'}
                          </span>
                        )}
                        {a.type === 'inject_cancelled' && (
                          <span className="text-robotic-yellow">
                            Inject cancelled by AI. Reason: {a.reason ?? '—'}
                          </span>
                        )}
                        {a.type === 'ai_step_start' && (
                          <span className="text-robotic-cyan/90">
                            {a.title ?? `AI: ${a.step ?? 'step'} started`}
                          </span>
                        )}
                        {a.type === 'ai_step_end' && (
                          <div>
                            <span className="text-robotic-green/90">
                              {a.title ?? `AI: ${a.step ?? 'step'} completed`}
                            </span>
                            {a.step === 'evaluating_inject_cancellation' && a.reason && (
                              <div className="mt-1 text-robotic-yellow/80">Reason: {a.reason}</div>
                            )}
                          </div>
                        )}
                        {a.type === 'state_effect_managed' && (
                          <div>
                            <span className="text-robotic-gold">
                              State effect managed{a.summary ? ` (${a.summary})` : ''}
                            </span>
                          </div>
                        )}
                        {a.type === 'escalation_factors_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Escalation factors computed ({a.summary ?? '—'})
                            </span>
                            {a.factors && a.factors.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [ESCALATION FACTORS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.factors.map((f) => (
                                    <li key={f.id}>
                                      {f.name} ({f.severity}): {f.description}
                                      {(f as { consequence_for_inaction?: boolean })
                                        .consequence_for_inaction && (
                                        <span className="ml-1 text-robotic-yellow/90 text-xs">
                                          [Consequence for inaction]
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {a.de_escalation_factors && a.de_escalation_factors.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [DE-ESCALATION FACTORS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.de_escalation_factors.map((f) => (
                                    <li key={f.id}>
                                      {f.name}: {f.description}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                        {a.type === 'escalation_pathways_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Escalation pathways computed ({a.summary ?? '—'})
                            </span>
                            {a.pathways && a.pathways.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">[PATHWAYS]</div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.pathways.map((p) => (
                                    <li key={p.pathway_id}>
                                      {p.trajectory}
                                      {p.trigger_behaviours?.length
                                        ? ` (triggers: ${p.trigger_behaviours.join(', ')})`
                                        : ''}
                                      {(p as { consequence_for_inaction?: boolean })
                                        .consequence_for_inaction && (
                                        <span className="ml-1 text-robotic-yellow/90 text-xs">
                                          [Consequence for inaction]
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {a.de_escalation_pathways && a.de_escalation_pathways.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [DE-ESCALATION PATHWAYS]
                                </div>
                                <ul className="list-disc pl-4 space-y-1 text-robotic-green/90 text-xs break-words">
                                  {a.de_escalation_pathways.map((p) => (
                                    <li key={p.pathway_id}>{p.trajectory}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                        {a.type === 'impact_matrix_computed' && (
                          <div>
                            <span className="text-robotic-gold">
                              Impact matrix computed ({a.summary ?? '—'})
                              {a.computed_band && (
                                <span className="ml-1 text-robotic-yellow/80 text-xs">
                                  [Band: {a.computed_band}]
                                </span>
                              )}
                            </span>
                            {a.analysis?.overall && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20 break-words">
                                <div className="text-robotic-yellow/80 mb-1">[AI REASONING]</div>
                                <p className="text-robotic-green/90 text-xs whitespace-pre-wrap">
                                  {a.analysis.overall}
                                </p>
                                {a.analysis.matrix_reasoning && (
                                  <p className="text-robotic-green/80 text-xs mt-1 whitespace-pre-wrap">
                                    Matrix: {a.analysis.matrix_reasoning}
                                  </p>
                                )}
                                {a.analysis.robustness_reasoning && (
                                  <p className="text-robotic-green/80 text-xs mt-1 whitespace-pre-wrap">
                                    Robustness: {a.analysis.robustness_reasoning}
                                  </p>
                                )}
                              </div>
                            )}
                            {a.response_taxonomy && Object.keys(a.response_taxonomy).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [RESPONSE TAXONOMY]
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {Object.entries(a.response_taxonomy).map(([team, cat]) => (
                                    <span
                                      key={team}
                                      className="bg-robotic-gray-400 px-1 rounded text-robotic-green/90"
                                    >
                                      {team}:{' '}
                                      {typeof cat === 'object' ? JSON.stringify(cat) : String(cat)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {a.matrix && Object.keys(a.matrix).length > 0 && (
                              <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                <div className="text-robotic-yellow/80 mb-1">
                                  [INTER-TEAM IMPACT -2..+2]
                                </div>
                                <div className="overflow-x-auto space-y-2">
                                  {Object.entries(a.matrix).map(([acting, affectedMap]) => (
                                    <div key={acting} className="text-robotic-green/90">
                                      {Object.entries(affectedMap as Record<string, number>).map(
                                        ([team, score]) => {
                                          const cellReason =
                                            a.analysis?.matrix_cell_reasoning?.[acting]?.[team];
                                          return (
                                            <div
                                              key={`${acting}-${team}`}
                                              className="ml-2 mb-1 border-l-2 border-robotic-yellow/30 pl-2"
                                            >
                                              <span className="font-medium">
                                                {acting} → {team}:{' '}
                                                {typeof score === 'object'
                                                  ? JSON.stringify(score)
                                                  : String(score)}
                                              </span>
                                              {cellReason && (
                                                <p className="text-robotic-green/80 text-xs mt-0.5 italic break-words whitespace-pre-wrap">
                                                  {typeof cellReason === 'object'
                                                    ? JSON.stringify(cellReason)
                                                    : String(cellReason)}
                                                </p>
                                              )}
                                            </div>
                                          );
                                        },
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {a.robustness_by_decision &&
                              Object.keys(a.robustness_by_decision).length > 0 && (
                                <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                  <div className="text-robotic-yellow/80 mb-1">
                                    [PER-DECISION ROBUSTNESS 1-10]
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {Object.entries(a.robustness_by_decision).map(
                                      ([decId, score]) => {
                                        const dec = backendDecisions.find((d) => d.id === decId);
                                        const label = dec?.title
                                          ? `${dec.title.slice(0, 30)}…`
                                          : `${decId.slice(0, 8)}…`;
                                        return (
                                          <span
                                            key={decId}
                                            className="bg-robotic-gray-400 px-1 rounded break-all text-xs"
                                            title={dec?.title ?? decId}
                                          >
                                            {label}:
                                            {typeof score === 'object'
                                              ? JSON.stringify(score)
                                              : String(score)}
                                          </span>
                                        );
                                      },
                                    )}
                                  </div>
                                </div>
                              )}
                            {a.robustness_by_decision &&
                              Object.keys(a.robustness_by_decision).length > 0 && (
                                <div className="mt-2 pt-2 border-t border-robotic-yellow/20">
                                  <div className="text-robotic-yellow/80 mb-1">
                                    [ROBUSTNESS PROCESS: RAW → CAPPED]
                                  </div>
                                  <ul className="list-none space-y-1.5 text-xs">
                                    {Object.keys(a.robustness_by_decision).map((decId) => {
                                      const cappedScore = a.robustness_by_decision![decId];
                                      const rawScore =
                                        a.analysis?.raw_robustness_by_decision?.[decId];
                                      const capDetail = a.analysis?.robustness_cap_detail?.[decId];
                                      const dec = backendDecisions.find((d) => d.id === decId);
                                      const decLabel = dec?.title ?? `${decId.slice(0, 8)}…`;
                                      return (
                                        <li
                                          key={decId}
                                          className="border-l-2 border-robotic-yellow/30 pl-2 text-robotic-green/90 break-words"
                                        >
                                          <span className="font-mono text-robotic-gray-50">
                                            {decLabel.length > 35
                                              ? `${decLabel.slice(0, 35)}…`
                                              : decLabel}
                                          </span>
                                          {' — raw: '}
                                          {rawScore != null ? String(rawScore) : '—'}
                                          {' → capped (used): '}
                                          {String(cappedScore)}
                                          {capDetail && (
                                            <div className="mt-0.5 text-robotic-yellow/80 italic">
                                              Below standard / mismatch — {capDetail.severity}{' '}
                                              {capDetail.mismatch_kind}.
                                              {capDetail.reason ? ` ${capDetail.reason}` : ''}
                                            </div>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* AAR - same size as map (h-[700px]), under timeline (completed sessions only) */}
              {session.status === 'completed' && (
                <div
                  className="md:col-span-2 military-border p-6 bg-robotic-gray-300 relative cursor-pointer flex flex-col h-[700px]"
                  onClick={() => markCardViewed('aar')}
                >
                  <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg terminal-text uppercase">[AAR] After Action Review</h3>
                    {cardNotifications['aar'] === 'new' && (
                      <div className="w-3 h-3 bg-robotic-green rounded-full"></div>
                    )}
                    {cardNotifications['aar'] === 'viewed' && (
                      <div className="w-3 h-3 bg-robotic-yellow rounded-full"></div>
                    )}
                  </div>
                  <div
                    className="flex-1 overflow-y-auto min-h-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <AARDashboard sessionId={id} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Live map module - 2 columns, bottom; keep mounted when closed to avoid Leaflet removeChild on unmount */}
          {id && (
            <div
              className={`md:col-span-2 military-border p-6 bg-robotic-gray-300 flex flex-col h-[700px] ${showMapModule ? '' : 'hidden'}`}
              aria-hidden={!showMapModule}
            >
              <div className="flex justify-between items-center mb-3 flex-shrink-0">
                <h3 className="text-lg terminal-text uppercase">[MAP]</h3>
                <button
                  onClick={() => {
                    sessionContentRef.current?.focus({ preventScroll: true });
                    setShowMapModule(false);
                    if (window.location.hash === '#show-map') {
                      window.history.replaceState(
                        null,
                        '',
                        window.location.pathname + window.location.search,
                      );
                    }
                  }}
                  className="px-3 py-1 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10"
                >
                  [HIDE MAP]
                </button>
              </div>
              <div className="flex-1 min-h-0 rounded border border-robotic-yellow/30 overflow-hidden h-[620px]">
                {mapModuleReady && mapHasBeenOpened && (
                  <MapView
                    sessionId={id}
                    incidents={[]}
                    resources={[]}
                    isVisible={showMapModule}
                    fillHeight
                    locationsRefreshTrigger={locationsRefreshTrigger}
                    initialCenter={
                      session?.scenarios?.center_lat != null &&
                      session?.scenarios?.center_lng != null
                        ? ([session.scenarios.center_lat, session.scenarios.center_lng] as [
                            number,
                            number,
                          ])
                        : [1.3521, 103.8198]
                    }
                    initialZoom={16}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
