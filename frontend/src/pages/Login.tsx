import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
      navigate('/dashboard');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center scanline relative">
      {/* Background grid pattern */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
          backgroundSize: '50px 50px',
        }}
      ></div>

      <div className="max-w-md w-full mx-4 relative z-10">
        <div className="military-border p-8 space-y-6">
          {/* Top Secret Banner */}
          <div className="text-center border-b-2 border-robotic-yellow pb-4 mb-6">
            <div className="classified-stamp text-2xl mb-2 inline-block">TOP SECRET</div>
            <div className="terminal-text text-xs tracking-widest mt-2">
              CLASSIFIED // EYES ONLY
            </div>
          </div>

          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 border-2 border-robotic-yellow mb-4 relative">
              <div className="absolute inset-0 bg-robotic-yellow/20 animate-pulse"></div>
              <svg
                className="w-8 h-8 text-robotic-yellow relative z-10"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold terminal-text uppercase tracking-wider mb-2">
              Unified Simulation Environment
            </h2>
            <p className="text-xs terminal-text text-robotic-yellow/70">
              [SYSTEM] Authentication Required
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="border-l-4 border-red-500 bg-red-900/20 p-4">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-red-500" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
                <div className="ml-3">
                  <p className="text-sm terminal-text text-red-400">[ERROR] {error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Form */}
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div>
              <label
                htmlFor="email"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [USER_ID]
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
                placeholder="user@domain.mil"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [PASSWORD]
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full military-button py-3 px-4 disabled:opacity-50 disabled:cursor-not-allowed transition-all relative overflow-hidden"
            >
              {loading ? (
                <>
                  <span className="relative z-10 flex items-center justify-center">
                    <span className="animate-pulse mr-2">[</span>
                    <span className="animate-pulse">AUTHENTICATING</span>
                    <span className="animate-pulse ml-2">]</span>
                  </span>
                </>
              ) : (
                <span className="relative z-10">[AUTHENTICATE]</span>
              )}
            </button>
          </form>

          {/* Sign Up Link */}
          <div className="text-center pt-4 border-t border-robotic-yellow/30">
            <p className="text-xs terminal-text text-robotic-yellow/70">
              [NEW_USER]{' '}
              <Link
                to="/signup"
                className="text-robotic-yellow hover:text-robotic-orange underline transition-colors"
              >
                Request Access
              </Link>
            </p>
          </div>

          {/* Footer */}
          <div className="text-center pt-4">
            <p className="text-xs terminal-text text-robotic-yellow/50">
              [SYSTEM] Secure Connection Established
            </p>
            <p className="text-xs terminal-text text-robotic-yellow/30 mt-1">
              © 2025 USE // All Rights Reserved
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
