import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface JoinInfo {
  sessionTitle: string;
  teams: Array<{ id: string; team_name: string; team_description?: string }>;
}

const DISPLAY_NAME_REGEX = /^[a-zA-Z0-9 .'\-]+$/;

export const JoinSessionPage = () => {
  const { joinToken } = useParams<{ joinToken: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // State
  const [joinInfo, setJoinInfo] = useState<JoinInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [invalidLink, setInvalidLink] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // Load join info on mount
  useEffect(() => {
    if (!joinToken) {
      setInvalidLink(true);
      setLoadingInfo(false);
      return;
    }
    loadJoinInfo();
  }, [joinToken]);

  // Pre-fill display name if user is logged in
  useEffect(() => {
    if (user?.displayName && !displayName) {
      setDisplayName(user.displayName);
    }
  }, [user]);

  const loadJoinInfo = async () => {
    try {
      const result = await api.join.getInfo(joinToken!);
      setJoinInfo(result.data);
      // Pre-select first team if only one
      if (result.data.teams.length === 1) {
        setTeamName(result.data.teams[0].team_name);
      }
    } catch {
      setInvalidLink(true);
    } finally {
      setLoadingInfo(false);
    }
  };

  const validateDisplayName = (name: string): string | null => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return 'Display name must be at least 2 characters';
    if (trimmed.length > 50) return 'Display name must be at most 50 characters';
    if (!DISPLAY_NAME_REGEX.test(trimmed)) {
      return 'Display name can only contain letters, numbers, spaces, periods, hyphens, and apostrophes';
    }
    return null;
  };

  const handleNameChange = (value: string) => {
    setDisplayName(value);
    if (value.trim().length > 0) {
      setNameError(validateDisplayName(value));
    } else {
      setNameError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate
    const nameValidation = validateDisplayName(displayName);
    if (nameValidation) {
      setNameError(nameValidation);
      return;
    }
    if (!teamName) {
      setError('Please select a team');
      return;
    }

    setSubmitting(true);

    try {
      // Step 1: Ensure authenticated (anonymous sign-in if needed)
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();

      if (!currentSession) {
        const { error: anonError } = await supabase.auth.signInAnonymously();
        if (anonError) {
          setError('Failed to create session. Please try again.');
          setSubmitting(false);
          return;
        }
        // Wait briefly for auth state to propagate
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Step 2: Register as participant
      const result = await api.join.register(joinToken!, displayName.trim(), teamName);

      // Step 3: Optional email linking
      if (email.trim()) {
        try {
          await supabase.auth.updateUser({ email: email.trim() });
        } catch {
          // Non-blocking - email linking is optional
          console.warn('Failed to link email, continuing...');
        }
      }

      // Step 4: Redirect to session lobby
      navigate(`/sessions/${result.sessionId}`, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join session';
      setError(message);
      setSubmitting(false);
    }
  };

  // Loading state
  if (loadingInfo || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline relative">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
            backgroundSize: '50px 50px',
          }}
        />
        <div className="text-center">
          <div className="text-lg terminal-text mb-2 animate-pulse">[LOADING]</div>
          <div className="text-xs terminal-text text-robotic-yellow/50">Verifying join link...</div>
        </div>
      </div>
    );
  }

  // Invalid link
  if (invalidLink) {
    return (
      <div className="min-h-screen flex items-center justify-center scanline relative">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
            backgroundSize: '50px 50px',
          }}
        />
        <div className="max-w-md w-full mx-4 relative z-10">
          <div className="military-border p-8 space-y-6">
            <div className="text-center border-b-2 border-red-500 pb-4 mb-6">
              <div className="text-2xl terminal-text text-red-400 mb-2">[LINK_NOT_VALID]</div>
            </div>
            <div className="text-center space-y-4">
              <p className="text-sm terminal-text text-robotic-yellow/80">
                This join link is invalid, has expired, or has been disabled by the trainer.
              </p>
              <p className="text-xs terminal-text text-robotic-yellow/50">
                Please contact your trainer for a new link.
              </p>
              <Link to="/login" className="military-button inline-block px-6 py-2 text-sm mt-4">
                [GO_TO_LOGIN]
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Join form
  return (
    <div className="min-h-screen flex items-center justify-center scanline relative">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
          backgroundSize: '50px 50px',
        }}
      />

      <div className="max-w-md w-full mx-4 relative z-10">
        <div className="military-border p-8 space-y-6">
          {/* Header */}
          <div className="text-center border-b-2 border-robotic-yellow pb-4 mb-6">
            <div className="classified-stamp text-xl mb-2 inline-block">SIMULATION EXERCISE</div>
            <div className="terminal-text text-xs tracking-widest mt-2">
              CLASSIFIED // AUTHORIZED PERSONNEL
            </div>
          </div>

          {/* Session Title */}
          <div className="text-center">
            <div className="text-sm terminal-text text-robotic-yellow/50 uppercase mb-1">
              Session
            </div>
            <div className="text-lg terminal-text font-semibold">{joinInfo?.sessionTitle}</div>
          </div>

          <p className="text-sm terminal-text text-robotic-yellow/70 text-center">
            Enter your details below to join this simulation.
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Display Name */}
            <div>
              <label
                htmlFor="displayName"
                className="block text-xs terminal-text uppercase mb-2 text-robotic-yellow/70"
              >
                Display Name *
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. CPT James Lee"
                required
                maxLength={50}
                className="w-full bg-robotic-gray-300 border-2 border-robotic-yellow/30 text-robotic-yellow px-4 py-3 terminal-text focus:border-robotic-yellow focus:outline-none placeholder-robotic-yellow/30"
              />
              {nameError && <p className="text-xs terminal-text text-red-400 mt-1">{nameError}</p>}
              <p className="text-xs terminal-text text-robotic-yellow/40 mt-1">
                2-50 characters. Letters, numbers, spaces, periods, hyphens, and apostrophes.
              </p>
            </div>

            {/* Team Selection */}
            <div>
              <label
                htmlFor="teamName"
                className="block text-xs terminal-text uppercase mb-2 text-robotic-yellow/70"
              >
                Team *
              </label>
              {joinInfo && joinInfo.teams.length > 0 ? (
                <select
                  id="teamName"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  required
                  className="w-full bg-robotic-gray-300 border-2 border-robotic-yellow/30 text-robotic-yellow px-4 py-3 terminal-text focus:border-robotic-yellow focus:outline-none appearance-none"
                >
                  <option value="">Select your team...</option>
                  {joinInfo.teams.map((team) => (
                    <option key={team.id} value={team.team_name}>
                      {team.team_name}
                      {team.team_description ? ` - ${team.team_description}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="teamName"
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Enter team name"
                  required
                  className="w-full bg-robotic-gray-300 border-2 border-robotic-yellow/30 text-robotic-yellow px-4 py-3 terminal-text focus:border-robotic-yellow focus:outline-none placeholder-robotic-yellow/30"
                />
              )}
            </div>

            {/* Error Display */}
            {error && (
              <div className="military-border p-3 border-red-500 bg-red-500/10">
                <p className="text-xs terminal-text text-red-400">{error}</p>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={submitting || !!nameError}
              className="military-button w-full py-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? '[JOINING...]' : '[JOIN_SESSION]'}
            </button>

            {/* Optional Email Linking (only for non-authenticated users) */}
            {!user && (
              <div className="border-t border-robotic-yellow/20 pt-4 mt-4">
                <label
                  htmlFor="email"
                  className="block text-xs terminal-text uppercase mb-2 text-robotic-yellow/50"
                >
                  Optional: Link your email for account recovery
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full bg-robotic-gray-300 border-2 border-robotic-yellow/20 text-robotic-yellow px-4 py-2 terminal-text text-sm focus:border-robotic-yellow focus:outline-none placeholder-robotic-yellow/20"
                />
                <p className="text-xs terminal-text text-robotic-yellow/30 mt-1">
                  If you don't link an email, clearing your browser data will lose your account.
                </p>
              </div>
            )}
          </form>

          {/* Login Link */}
          <div className="text-center pt-2">
            <span className="text-xs terminal-text text-robotic-yellow/50">
              Already have an account?{' '}
            </span>
            <Link to="/login" className="text-xs terminal-text text-robotic-yellow hover:underline">
              Log in instead
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
