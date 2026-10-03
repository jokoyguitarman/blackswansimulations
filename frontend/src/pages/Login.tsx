import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { BrandMark } from '../components/BrandMark';
import { ResendVerification } from '../components/auth/ResendVerification';
import { clearAuthLinkError, readAuthLinkError } from '../lib/authLinkError';

/** Supabase says this when the password is right but the email was never verified. */
const isUnverified = (error: Error & { code?: string }) =>
  error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message);

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [loading, setLoading] = useState(false);
  // An expired or already-used verification link sends people here with the reason in the address;
  // main.tsx captured it before the redirects dropped it. Shown once per landing, so it does not
  // resurface on a later visit.
  const [linkError] = useState(() => {
    const found = readAuthLinkError();
    clearAuthLinkError();
    return found;
  });
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverified(false);
    setLoading(true);

    const { error } = await signIn(email, password);

    if (error) {
      if (isUnverified(error)) setUnverified(true);
      else setError(error.message);
      setLoading(false);
    } else {
      // Anyone who still owes a signed Consultant Agreement is held at that form by the route guard.
      navigate('/dashboard');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative px-4">
      <div className="max-w-md w-full relative z-10">
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <BrandMark className="w-12 h-12 mx-auto mb-4" />
            <h2 className="text-2xl font-extrabold text-brand mb-1">Prophyion</h2>
            <p className="text-sm text-muted">Unified Simulation Environment</p>
          </div>

          {/* Arrived from a verification link that expired or was already used */}
          {linkError && !unverified && (
            <div className="border-l-4 border-warning bg-warning/10 p-4 rounded-md">
              <p className="text-sm font-semibold text-ink">
                {linkError.expired
                  ? 'That verification link has expired or was already used.'
                  : "That link couldn't be used."}
              </p>
              <p className="text-xs text-muted mt-1">
                {linkError.expired
                  ? "Links only work once and stop working after a while. If you've already verified your email, sign in below. If not, enter your email below and send yourself a new link."
                  : 'Try signing in below. If your email is not verified yet, enter it below and send yourself a new link.'}
              </p>
              <ResendVerification email={email} />
            </div>
          )}

          {/* Signed in with the right password, but the email was never verified */}
          {unverified && (
            <div className="border-l-4 border-warning bg-warning/10 p-4 rounded-md">
              <p className="text-sm font-semibold text-ink">
                Your email address hasn&apos;t been verified yet.
              </p>
              <p className="text-xs text-muted mt-1">
                We sent a verification link to <span className="font-semibold">{email}</span> when
                you signed up. Open it to finish setting up your account, or send a new link if it
                has expired or gone missing.
              </p>
              <ResendVerification email={email} />
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="border-l-4 border-danger bg-danger/10 p-4 rounded-md">
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          {/* Form */}
          <form className="space-y-5" onSubmit={handleSubmit}>
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
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full military-button py-3 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* Sign Up Link */}
          <div className="text-center pt-4 border-t border-border">
            <p className="text-sm text-muted">
              No account?{' '}
              <Link
                to="/signup"
                className="text-brand hover:text-accent font-semibold transition-colors"
              >
                Request access
              </Link>
            </p>
          </div>

          {/* Footer */}
          <div className="text-center pt-2">
            <p className="text-xs text-muted">Secure connection established</p>
            <p className="text-xs text-muted/70 mt-1">© 2026 Prophyion</p>
          </div>
        </div>
      </div>
    </div>
  );
};
