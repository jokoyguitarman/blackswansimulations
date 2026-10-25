import { useAuth } from '../contexts/AuthContext';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { TrainerDashboard } from '../components/dashboards/TrainerDashboard';
import { AgencyDashboard } from '../components/dashboards/AgencyDashboard';
import { AgreementStatusCard } from '../components/agreement/AgreementStatusCard';
import { useMyAgreement } from '../hooks/useMyAgreement';

export const Dashboard = () => {
  const { user, session } = useAuth();
  const { isTrainer } = useRoleVisibility();
  // Trainers see their agreement status on the trainer dashboard itself.
  const { mine } = useMyAgreement(Boolean(user) && !isTrainer);
  const signedUpAsConsultant = session?.user.user_metadata?.applying_as_consultant === true;

  return (
    <div className="min-h-screen">
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

        {mine && !isTrainer && (
          <div className="mb-6">
            <AgreementStatusCard mine={mine} role={user?.role} applying={signedUpAsConsultant} />
          </div>
        )}

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
                {user?.role === 'admin' ? 'Organisation' : 'Agency'}
              </div>
              <div className="text-lg font-bold text-ink">
                {user?.role === 'admin' ? 'Advanced AI Solutions' : user?.agency || 'Not assigned'}
              </div>
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
          <p className="text-xs text-muted">Prophyion v2.0 · Secure connection established</p>
        </div>
      </main>
    </div>
  );
};
