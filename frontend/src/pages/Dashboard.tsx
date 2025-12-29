import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { TrainerDashboard } from '../components/dashboards/TrainerDashboard';
import { AgencyDashboard } from '../components/dashboards/AgencyDashboard';

export const Dashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen scanline">
      {/* Background grid */}
      <div
        className="fixed inset-0 opacity-10 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
          backgroundSize: '50px 50px',
        }}
      ></div>

      {/* Top Navigation */}
      <nav className="military-border border-b-2 border-robotic-yellow relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-4">
              <div className="w-2 h-2 bg-robotic-yellow rounded-full animate-pulse"></div>
              <h1 className="text-lg terminal-text uppercase tracking-wider">
                [USE] Unified Simulation Environment
              </h1>
            </div>
            <div className="flex items-center space-x-6">
              {/* Role-based navigation */}
              <div className="flex items-center space-x-4">
                {isTrainer && (
                  <a
                    href="/scenarios"
                    className="px-3 py-1 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 transition-all"
                  >
                    [SCENARIOS]
                  </a>
                )}
                <a
                  href="/sessions"
                  className="px-3 py-1 text-xs terminal-text uppercase border border-robotic-yellow text-robotic-yellow hover:bg-robotic-yellow/10 transition-all"
                >
                  [SESSIONS]
                </a>
              </div>
              <div className="text-right">
                <div className="text-xs terminal-text text-robotic-yellow/70 uppercase">[USER]</div>
                <div className="text-sm terminal-text">{user?.displayName || user?.email}</div>
                <div className="text-xs terminal-text text-robotic-yellow/50">
                  [{user?.role?.toUpperCase()}]
                </div>
              </div>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-xs terminal-text uppercase border border-robotic-orange text-robotic-orange hover:bg-robotic-orange/10 transition-all"
              >
                [LOGOUT]
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Status Bar */}
        <div className="military-border p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-robotic-yellow rounded-full animate-pulse"></div>
                <span className="text-xs terminal-text text-robotic-yellow">[SYSTEM] ONLINE</span>
              </div>
              <span className="text-xs terminal-text text-robotic-yellow/50">|</span>
              <span className="text-xs terminal-text text-robotic-yellow/70">
                [CLEARANCE] {user?.role?.toUpperCase() || 'NONE'}
              </span>
            </div>
            <div className="text-xs terminal-text text-robotic-yellow/50">
              {new Date().toLocaleTimeString('en-US', { hour12: false })}
            </div>
          </div>
        </div>

        {/* Dashboard Content */}
        <div className="military-border p-6">
          {/* User Info Panel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="military-border p-4">
              <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                [CLEARANCE_LEVEL]
              </div>
              <div className="text-lg terminal-text uppercase">{user?.role || 'NONE'}</div>
            </div>
            <div className="military-border p-4">
              <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-2">
                [AGENCY]
              </div>
              <div className="text-lg terminal-text uppercase">
                {user?.agency || 'NOT_ASSIGNED'}
              </div>
            </div>
          </div>

          {/* Role-specific dashboard content */}
          {isTrainer ? <TrainerDashboard /> : <AgencyDashboard />}

          {/* System Status */}
          <div className="military-border p-4 mt-6">
            <div className="text-xs terminal-text text-robotic-yellow/70 uppercase mb-3">
              [SYSTEM_STATUS]
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm terminal-text">[DATABASE]</span>
                <span className="text-sm terminal-text text-robotic-yellow">CONNECTED</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm terminal-text">[WEBSOCKET]</span>
                <span className="text-sm terminal-text text-robotic-yellow">ACTIVE</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm terminal-text">[AI_ENGINE]</span>
                <span className="text-sm terminal-text text-robotic-yellow">STANDBY</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-xs terminal-text text-robotic-yellow/30">
            [SYSTEM] USE v1.0.0 // Secure Connection Established
          </p>
        </div>
      </main>
    </div>
  );
};
