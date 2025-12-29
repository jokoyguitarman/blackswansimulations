import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { api } from '../lib/api';
import { CreateSessionModal } from '../components/Forms/CreateSessionModal';

interface Session {
  id: string;
  status: string;
  scenario_id: string;
  trainer_id: string;
  start_time: string | null;
  end_time: string | null;
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
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [scenarios, setScenarios] = useState<Array<{ id: string; title: string }>>([]);

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
      console.log('Sessions API response:', result);
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
      setScenarios((result.data || []) as Array<{ id: string; title: string }>);
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'bg-robotic-yellow/20 text-robotic-yellow border-robotic-yellow';
      case 'completed':
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
      case 'paused':
        return 'bg-robotic-orange/20 text-robotic-orange border-robotic-orange';
      default:
        return 'bg-robotic-gray-200 text-robotic-gray-50 border-robotic-gray-200';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline">
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">Loading sessions...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen scanline">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="military-border p-6 mb-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl terminal-text uppercase tracking-wider mb-2">
                [SESSIONS] Active Exercises
              </h1>
              <p className="text-xs terminal-text text-robotic-yellow/70">
                {sessions.length} session{sessions.length !== 1 ? 's' : ''} available
              </p>
            </div>
            {isTrainer && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="military-button px-6 py-3"
              >
                [CREATE_SESSION]
              </button>
            )}
          </div>
        </div>

        {/* Sessions List */}
        <div className="space-y-4">
          {sessions.map((session) => (
            <div key={session.id} className="military-border p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-2">
                    <h3 className="text-lg terminal-text uppercase">
                      {session.scenarios?.title || 'Unknown Scenario'}
                    </h3>
                    <span
                      className={`text-xs terminal-text px-2 py-1 border ${getStatusColor(session.status)}`}
                    >
                      {session.status.toUpperCase().replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs terminal-text text-robotic-yellow/70 mb-4">
                    <span>[CATEGORY] {session.scenarios?.category}</span>
                    <span>[DIFFICULTY] {session.scenarios?.difficulty}</span>
                    <span>[TRAINER] {session.trainer?.full_name || 'Unknown'}</span>
                    {session.participants && (
                      <span>[PARTICIPANTS] {session.participants.length}</span>
                    )}
                  </div>
                  {session.start_time && (
                    <div className="text-xs terminal-text text-robotic-yellow/50">
                      Started: {new Date(session.start_time).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {session.status === 'scheduled' && isTrainer && (
                    <button
                      onClick={() => handleStartSession(session.id)}
                      className="military-button px-4 py-2 text-sm"
                    >
                      [START]
                    </button>
                  )}
                  {(session.status === 'in_progress' ||
                    session.status === 'scheduled' ||
                    session.status === 'completed') && (
                    <button
                      onClick={() => navigate(`/sessions/${session.id}`)}
                      className="military-button px-4 py-2 text-sm"
                    >
                      {session.status === 'completed'
                        ? '[VIEW_AAR]'
                        : session.status === 'in_progress'
                          ? '[JOIN]'
                          : '[VIEW]'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {sessions.length === 0 && (
          <div className="military-border p-12 text-center">
            <p className="text-lg terminal-text text-robotic-yellow/50 mb-2">
              [NO_SESSIONS] No sessions available
            </p>
            {isTrainer && (
              <p className="text-sm terminal-text text-robotic-yellow/30">
                Create a session from a scenario to get started
              </p>
            )}
          </div>
        )}
      </div>

      {/* Create Session Modal */}
      {showCreateModal && (
        <CreateSessionModal
          scenarios={scenarios}
          onClose={() => {
            setShowCreateModal(false);
          }}
          onSuccess={loadSessions}
        />
      )}
    </div>
  );
};
