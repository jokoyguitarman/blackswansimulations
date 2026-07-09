import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { TrainerDashboard } from '../components/dashboards/TrainerDashboard';
import { AgencyDashboard } from '../components/dashboards/AgencyDashboard';
import { NotificationBell } from '../components/Notifications/NotificationBell';

export const Dashboard = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { isTrainer } = useRoleVisibility();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen">
      {/* Top Navigation */}
      <nav className="bg-brand text-white relative z-10 shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent grid place-items-center font-extrabold text-brand text-sm">
                BS
              </div>
              <h1 className="text-base font-bold leading-tight">
                Black Swan
                <span className="block text-[11px] font-normal text-white/60">
                  Unified Simulation Environment
                </span>
              </h1>
            </div>
            <div className="flex items-center gap-4">
              {/* Role-based navigation */}
              <div className="flex items-center gap-1">
                {isTrainer && (
                  <>
                    <a
                      href="/scenarios"
                      className="px-3 py-1.5 text-sm font-medium rounded-lg text-white/80 hover:bg-white/10 hover:text-white transition-all"
                    >
                      Scenarios
                    </a>
                    <a
                      href="/warroom"
                      className="px-3 py-1.5 text-sm font-medium rounded-lg text-white/80 hover:bg-white/10 hover:text-white transition-all"
                    >
                      War Room
                    </a>
                    <a
                      href="/demo"
                      className="px-3 py-1.5 text-sm font-medium rounded-lg text-white/80 hover:bg-white/10 hover:text-white transition-all"
                    >
                      Demo
                    </a>
                  </>
                )}
                <a
                  href="/sessions"
                  className="px-3 py-1.5 text-sm font-medium rounded-lg text-white/80 hover:bg-white/10 hover:text-white transition-all"
                >
                  Sessions
                </a>
              </div>
              {/* Notification Bell */}
              <NotificationBell />
              <div className="text-right leading-tight">
                <div className="text-sm font-semibold">{user?.displayName || user?.email}</div>
                <div className="text-[11px] text-white/60 capitalize">{user?.role}</div>
              </div>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-white/30 text-white hover:bg-white/10 transition-all"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Status Bar */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-success/10 text-success">
                <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
                System online
              </span>
              <span className="text-sm text-muted">
                Clearance ·{' '}
                <span className="text-ink font-semibold capitalize">{user?.role || 'none'}</span>
              </span>
            </div>
            <div className="text-sm text-muted tabular-nums">
              {new Date().toLocaleTimeString('en-US', { hour12: false })}
            </div>
          </div>
        </div>

        {/* Dashboard Content */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
          {/* User Info Panel */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="bg-surface-2 border border-border rounded-lg p-4">
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                Clearance level
              </div>
              <div className="text-lg font-bold text-ink capitalize">{user?.role || 'None'}</div>
            </div>
            <div className="bg-surface-2 border border-border rounded-lg p-4">
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                Agency
              </div>
              <div className="text-lg font-bold text-ink">{user?.agency || 'Not assigned'}</div>
            </div>
          </div>

          {/* Role-specific dashboard content */}
          {isTrainer ? <TrainerDashboard /> : <AgencyDashboard />}

          {/* System Status */}
          <div className="bg-surface-2 border border-border rounded-lg p-4 mt-6">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              System status
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink">Database</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2 py-0.5 rounded-full bg-success/10 text-success">
                  Connected
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink">Realtime / WebSocket</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2 py-0.5 rounded-full bg-success/10 text-success">
                  Active
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-ink">AI engine</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                  Standby
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-muted">
            Black Swan Simulations v2.0 · Secure connection established
          </p>
        </div>
      </main>
    </div>
  );
};
