import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useRoleVisibility } from '../hooks/useRoleVisibility';
import { NotificationBell } from './Notifications/NotificationBell';
import { BrandMark } from './BrandMark';

/**
 * The one navigation bar for the simulation suite. Same bar on every suite
 * page: the trainer dashboard, the library, the War Room, sessions, and the
 * pages those open. Trainer links stay hidden for participants.
 */
export function SuiteNav() {
  const { user, signOut } = useAuth();
  const { isTrainer } = useRoleVisibility();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const item = (to: string, label: string, active: boolean) => (
    <Link
      key={to}
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
        active ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <nav className="sticky top-0 z-50 bg-brand text-white shadow-md" aria-label="Primary">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link to="/dashboard" className="flex shrink-0 items-center gap-3 text-white">
            <BrandMark className="h-9 w-9" />
            <span className="text-base font-bold leading-tight">
              Prophyion
              <span className="block text-[11px] font-normal text-white/60">
                Unified Simulation Environment
              </span>
            </span>
          </Link>

          <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
            <div className="flex items-center gap-1">
              {isTrainer && (
                <>
                  {item('/scenarios', 'Scenarios', pathname.startsWith('/scenarios'))}
                  {item('/warroom', 'War Room', pathname.startsWith('/warroom'))}
                  {item('/demo', 'Demo', pathname.startsWith('/demo'))}
                </>
              )}
              {item(
                '/sessions',
                'Sessions',
                pathname.startsWith('/sessions') || /^\/sim\/[^/]+\/trainer/.test(pathname),
              )}
            </div>
            <NotificationBell />
            <Link
              to="/account"
              className="shrink-0 text-right leading-tight text-white hover:opacity-80 transition-opacity"
              title="Account settings"
            >
              <div className="max-w-[14rem] truncate text-sm font-semibold text-white">
                {user?.displayName || user?.email}
              </div>
              <div className="text-[11px] capitalize text-white/60">{user?.role} · settings</div>
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              className="shrink-0 rounded-lg border border-white/30 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-white/10"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
