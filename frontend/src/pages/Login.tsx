import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await signIn(email, password);

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      // Complete a trainer signup that couldn't be finished at signup time
      // (e.g. when email confirmation deferred the first session).
      if (localStorage.getItem('bsw_pending_trainer_upgrade')) {
        try {
          await api.profile.becomeTrainer();
          localStorage.removeItem('bsw_pending_trainer_upgrade');
          // Full reload so the auth context picks up the new role.
          window.location.href = '/clients';
          return;
        } catch {
          localStorage.removeItem('bsw_pending_trainer_upgrade');
        }
      }
      navigate('/dashboard');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative px-4">
      <div className="max-w-md w-full relative z-10">
        <div className="bg-surface border border-border rounded-2xl shadow-lg p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-brand text-white font-extrabold text-lg mb-4">
              BS
            </div>
            <h2 className="text-2xl font-extrabold text-brand mb-1">Black Swan Simulations</h2>
            <p className="text-sm text-muted">Unified Simulation Environment</p>
          </div>

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
            <p className="text-xs text-muted/70 mt-1">© 2026 Black Swan Simulations</p>
          </div>
        </div>
      </div>
    </div>
  );
};
