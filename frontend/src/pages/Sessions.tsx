import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
        return 'bg-success/10 text-success';
      case 'completed':
        return 'bg-surface-2 text-muted';
      case 'paused':
        return 'bg-accent/10 text-accent';
      default:
        return 'bg-brand/10 text-brand';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading sessions…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4 mb-4">
          <Link to="/dashboard" className="text-sm text-muted hover:text-brand">
            ← Home
          </Link>
        </div>
        {/* Header */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Active exercises</h1>
              <p className="text-sm text-muted">
                {sessions.length} session{sessions.length !== 1 ? 's' : ''} available
              </p>
            </div>
            {isTrainer && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="military-button px-5 py-2.5"
              >
                + Create session
              </button>
            )}
          </div>
        </div>

        {/* Sessions List */}
        <div className="space-y-4">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-surface border border-border rounded-xl shadow-sm p-6"
            >
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-bold text-ink">
                      {session.scenarios?.title || 'Unknown scenario'}
                    </h3>
                    {session.join_token?.startsWith('demo-') && (
                      <span className="text-[10px] px-2 py-0.5 bg-accent/10 text-accent rounded-full uppercase font-bold tracking-wide">
                        Demo
                      </span>
                    )}
                    <span
                      className={`text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(session.status)}`}
                    >
                      {session.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-muted mb-4">
                    <span>
                      Category ·{' '}
                      <span className="text-ink font-medium capitalize">
                        {session.scenarios?.category}
                      </span>
                    </span>
                    <span>
                      Difficulty ·{' '}
                      <span className="text-ink font-medium capitalize">
                        {session.scenarios?.difficulty}
                      </span>
                    </span>
                    <span>
                      Trainer ·{' '}
                      <span className="text-ink font-medium">
                        {session.trainer?.full_name || 'Unknown'}
                      </span>
                    </span>
                    {session.participants && (
                      <span>
                        Participants ·{' '}
                        <span className="text-ink font-medium">{session.participants.length}</span>
                      </span>
                    )}
                  </div>
                  {session.start_time && (
                    <div className="text-xs text-muted">
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
                      Start
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
                        ? 'View AAR'
                        : session.status === 'in_progress'
                          ? 'Join'
                          : 'View'}
                    </button>
                  )}
                  {session.status === 'in_progress' && session.join_token?.startsWith('demo-') && (
                    <button
                      onClick={() =>
                        navigate(`/sessions/${session.id}?spectator=true&mode=cinematic`)
                      }
                      className="px-4 py-2 text-sm font-semibold rounded-lg border border-danger/40 text-danger hover:bg-danger/10 transition-all"
                    >
                      Spectate
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {sessions.length === 0 && (
          <div className="bg-surface border border-border rounded-xl shadow-sm p-12 text-center">
            <p className="text-lg text-muted mb-2">No sessions available</p>
            {isTrainer && (
              <p className="text-sm text-muted">Create a session from a scenario to get started</p>
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
