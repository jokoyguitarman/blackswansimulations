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
  const [role, setRole] = useState('trainer');
  const [agencyName, setAgencyName] = useState('');
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
        if (data.data.role) {
          setRole(data.data.role);
        }
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

    const { error } = await signUp(email, password, {
      full_name: fullName,
      role: role,
      agency_name: agencyName,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setSuccess(true);
      // If they signed up via invitation, redirect to sessions after a delay
      setTimeout(() => {
        if (inviteToken) {
          navigate('/sessions');
        } else {
          navigate('/login');
        }
      }, 2000);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black scanline relative">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255, 184, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 107, 53, 0.1) 1px, transparent 1px)',
            backgroundSize: '50px 50px',
          }}
        ></div>
        <div className="max-w-md w-full mx-4 relative z-10">
          <div className="military-border bg-black/90 p-8 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 border-2 border-robotic-yellow mb-4">
              <svg
                className="w-8 h-8 text-robotic-yellow"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold terminal-text mb-2 uppercase">
              Access Request Approved
            </h2>
            <p className="text-sm terminal-text text-robotic-yellow/70 mb-4">
              [SYSTEM] Credentials registered
            </p>
            <p className="text-xs terminal-text text-robotic-yellow/50">
              Redirecting to authentication...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-black scanline relative py-12 px-4">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0, 255, 0, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 0, 0.1) 1px, transparent 1px)',
          backgroundSize: '50px 50px',
        }}
      ></div>

      <div className="max-w-md w-full relative z-10">
        <div className="military-border bg-black/90 p-8 space-y-6">
          {/* Header */}
          <div className="text-center border-b-2 border-robotic-yellow pb-4 mb-6">
            <div className="classified-stamp text-xl mb-2 inline-block">
              {inviteToken ? 'INVITATION ACCEPTANCE' : 'ACCESS REQUEST'}
            </div>
            <div className="terminal-text text-xs tracking-widest mt-2 text-robotic-yellow/70">
              NEW USER REGISTRATION
            </div>
          </div>

          {/* Invitation Info */}
          {inviteToken && invitationInfo && (
            <div className="border-l-4 border-robotic-yellow bg-robotic-yellow/10 p-4 mb-6">
              <div className="text-xs terminal-text text-robotic-yellow uppercase mb-2">
                [INVITATION_DETECTED]
              </div>
              <div className="text-sm terminal-text space-y-1">
                <p>
                  <strong>Session:</strong> {invitationInfo.sessionTitle}
                </p>
                <p>
                  <strong>Scenario:</strong> {invitationInfo.scenarioTitle}
                </p>
                <p>
                  <strong>Assigned Role:</strong>{' '}
                  {invitationInfo.role.toUpperCase().replace('_', ' ')}
                </p>
                <p>
                  <strong>Trainer:</strong> {invitationInfo.trainerName}
                </p>
              </div>
              <p className="text-xs terminal-text text-robotic-yellow/70 mt-2">
                After signing up, you will automatically be added to this session.
              </p>
            </div>
          )}

          {inviteToken && loadingInvitation && (
            <div className="text-center py-4 mb-6">
              <p className="text-xs terminal-text text-robotic-yellow/50">
                [LOADING_INVITATION...]
              </p>
            </div>
          )}

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
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label
                htmlFor="fullName"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [FULL_NAME]
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
                placeholder="LAST, FIRST M."
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [EMAIL]
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
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
                placeholder="••••••••"
              />
              <p className="mt-1 text-xs terminal-text text-robotic-yellow/50">
                [MIN] 6 characters required
              </p>
            </div>

            <div>
              <label
                htmlFor="role"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [CLEARANCE_LEVEL]
              </label>
              <select
                id="role"
                name="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
              >
                <option value="trainer">TRAINER</option>
                <option value="defence_liaison">DEFENCE_LIAISON</option>
                <option value="police_commander">POLICE_COMMANDER</option>
                <option value="public_information_officer">PUBLIC_INFO_OFFICER</option>
                <option value="health_director">HEALTH_DIRECTOR</option>
                <option value="civil_government">CIVIL_GOVERNMENT</option>
                <option value="utility_manager">UTILITY_MANAGER</option>
                <option value="intelligence_analyst">INTELLIGENCE_ANALYST</option>
                <option value="ngo_liaison">NGO_LIAISON</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="agencyName"
                className="block text-xs terminal-text text-robotic-yellow mb-2 uppercase tracking-wider"
              >
                [AGENCY/ORGANIZATION]
              </label>
              <input
                id="agencyName"
                name="agencyName"
                type="text"
                required
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                className="w-full px-4 py-3 military-input terminal-text text-sm"
                placeholder="MINISTRY_OF_DEFENCE"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full military-button py-3 px-4 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <span className="animate-pulse mr-2">[</span>
                  <span className="animate-pulse">PROCESSING</span>
                  <span className="animate-pulse ml-2">]</span>
                </span>
              ) : (
                '[SUBMIT_REQUEST]'
              )}
            </button>
          </form>

          {/* Login Link */}
          <div className="text-center pt-4 border-t border-robotic-yellow/30">
            <p className="text-xs terminal-text text-robotic-yellow/70">
              [EXISTING_USER]{' '}
              <Link
                to="/login"
                className="text-robotic-yellow hover:text-robotic-yellow underline transition-colors"
              >
                Authenticate
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
