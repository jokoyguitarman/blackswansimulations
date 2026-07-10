import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface InvitationInfo {
  sessionTitle: string;
  scenarioTitle: string;
  role: string;
  trainerName: string;
}

export const SignUp = () => {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [agencyName, setAgencyName] = useState('');
  // 'trainer' = free trainer account (payment portal); 'participant' = invited player.
  const [accountType, setAccountType] = useState<'trainer' | 'participant'>(
    inviteToken ? 'participant' : 'trainer',
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [invitationInfo, setInvitationInfo] = useState<InvitationInfo | null>(null);
  const [loadingInvitation, setLoadingInvitation] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();

  // Load invitation details if token is present
  useEffect(() => {
    if (inviteToken) {
      loadInvitationInfo();
    }
  }, [inviteToken]);

  const loadInvitationInfo = async () => {
    setLoadingInvitation(true);
    try {
      // Note: This endpoint doesn't require auth, so we'll need to create it
      // For now, we'll just extract info from the token or skip
      // The backend should have a public endpoint to get invitation details
      const response = await fetch(`/api/invitations/${inviteToken}`);
      if (response.ok) {
        const data = await response.json();
        setInvitationInfo(data.data);
        if (data.data.email) {
          setEmail(data.data.email);
        }
        // NOTE: the invited role is intentionally NOT read from the client here.
        // It is applied server-side from the trusted session_invitations row.
      }
    } catch (err) {
      console.error('Failed to load invitation:', err);
      // Continue with signup even if invitation load fails
    } finally {
      setLoadingInvitation(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // SECURITY: do not send a self-selected role in metadata. New accounts
    // default to the least-privileged role server-side. Trainer accounts are
    // upgraded through the explicit become-trainer endpoint below, which only
    // ever grants 'trainer' (all cost-incurring features are credit-gated).
    const { error } = await signUp(email, password, {
      full_name: fullName,
      agency_name: agencyName,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    if (accountType === 'trainer' && !inviteToken) {
      // If Supabase established a session immediately, upgrade now; otherwise
      // the Login page finishes the upgrade after first sign-in.
      localStorage.setItem('bsw_pending_trainer_upgrade', '1');
      try {
        const { api } = await import('../lib/api');
        await api.profile.becomeTrainer();
        localStorage.removeItem('bsw_pending_trainer_upgrade');
      } catch {
        // No session yet (e.g. email confirmation required) - handled at login.
      }
    }

    setSuccess(true);
    // If they signed up via invitation, redirect to sessions after a delay
    setTimeout(() => {
      if (inviteToken) {
        navigate('/sessions');
      } else {
        navigate('/login');
      }
    }, 2000);
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center relative px-4">
        <div className="max-w-md w-full relative z-10">
          <div className="bg-surface border border-border rounded-2xl shadow-lg p-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-success/10 text-success mb-4">
              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-extrabold text-brand mb-2">Access request approved</h2>
            <p className="text-sm text-muted mb-4">Your credentials have been registered.</p>
            <p className="text-xs text-muted">Redirecting to sign in…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center relative py-12 px-4">
      <div className="max-w-md w-full relative z-10">
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand text-white font-extrabold text-lg mb-4">
              BS
            </div>
            <h2 className="text-2xl font-extrabold text-brand mb-1">
              {inviteToken ? 'Accept invitation' : 'Request access'}
            </h2>
            <p className="text-sm text-muted">New user registration</p>
          </div>

          {/* Invitation Info */}
          {inviteToken && invitationInfo && (
            <div className="border-l-4 border-accent bg-accent/10 p-4 rounded-md">
              <div className="text-xs font-bold text-accent uppercase tracking-wide mb-2">
                Invitation detected
              </div>
              <div className="text-sm text-ink space-y-1">
                <p>
                  <strong>Session:</strong> {invitationInfo.sessionTitle}
                </p>
                <p>
                  <strong>Scenario:</strong> {invitationInfo.scenarioTitle}
                </p>
                <p>
                  <strong>Assigned role:</strong>{' '}
                  {invitationInfo.role.toUpperCase().replace('_', ' ')}
                </p>
                <p>
                  <strong>Trainer:</strong> {invitationInfo.trainerName}
                </p>
              </div>
              <p className="text-xs text-muted mt-2">
                After signing up, you will automatically be added to this session.
              </p>
            </div>
          )}

          {inviteToken && loadingInvitation && (
            <div className="text-center py-4">
              <p className="text-xs text-muted">Loading invitation…</p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="border-l-4 border-danger bg-danger/10 p-4 rounded-md">
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          {/* Account type (hidden for invitation signups, which are players) */}
          {!inviteToken && (
            <div>
              <div className="block text-xs font-semibold text-ink mb-2">I am signing up as</div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setAccountType('trainer')}
                  className={`text-left p-3 rounded-lg border-2 transition-all ${
                    accountType === 'trainer'
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  <div
                    className={`text-sm font-bold ${accountType === 'trainer' ? 'text-brand' : 'text-muted'}`}
                  >
                    Trainer
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    I run crisis trainings for clients
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType('participant')}
                  className={`text-left p-3 rounded-lg border-2 transition-all ${
                    accountType === 'participant'
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  <div
                    className={`text-sm font-bold ${accountType === 'participant' ? 'text-brand' : 'text-muted'}`}
                  >
                    Participant
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">
                    I was invited to a training session
                  </div>
                </button>
              </div>
              {accountType === 'trainer' && (
                <p className="text-[11px] text-muted mt-2">
                  Free forever to enroll clients. The War Room unlocks when a client pays an
                  engagement invoice.
                </p>
              )}
            </div>
          )}

          {/* Form */}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="fullName" className="block text-xs font-semibold text-ink mb-2">
                Full name
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder="Last, First M."
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-semibold text-ink mb-2">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder="you@agency.gov"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-semibold text-ink mb-2">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder="••••••••"
              />
              <p className="mt-1 text-xs text-muted">Minimum 6 characters.</p>
            </div>

            <div>
              <label htmlFor="agencyName" className="block text-xs font-semibold text-ink mb-2">
                Agency / organization
              </label>
              <input
                id="agencyName"
                name="agencyName"
                type="text"
                required
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder="e.g. Ministry of Defence"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full military-button py-3 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Processing…' : 'Submit request'}
            </button>
          </form>

          {/* Login Link */}
          <div className="text-center pt-4 border-t border-border">
            <p className="text-sm text-muted">
              Already have an account?{' '}
              <Link
                to="/login"
                className="text-brand hover:text-accent font-semibold transition-colors"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
