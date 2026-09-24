import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { BrandMark } from '../components/BrandMark';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { ApplicationSteps } from '../components/agreement/ApplicationSteps';
import {
  AgreementDetailsFields,
  clearAgreementDraft,
  emptyAgreementDetails,
  saveAgreementDraft,
  type AgreementDetails,
} from '../components/agreement/AgreementDetailsFields';
import type { ApplyLocationState } from './Apply';

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
  // 'trainer' = a consultant applying for trainer access; 'participant' = invited player.
  const [accountType, setAccountType] = useState<'trainer' | 'participant'>(
    inviteToken ? 'participant' : 'trainer',
  );
  const [details, setDetails] = useState<AgreementDetails>(emptyAgreementDetails);
  const [requiresAddress, setRequiresAddress] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [confirmEmailFirst, setConfirmEmailFirst] = useState(false);
  const [applyState, setApplyState] = useState<ApplyLocationState | null>(null);
  const [invitationInfo, setInvitationInfo] = useState<InvitationInfo | null>(null);
  const [loadingInvitation, setLoadingInvitation] = useState(false);
  const { signUp, user } = useAuth();
  const navigate = useNavigate();
  const isConsultant = accountType === 'trainer' && !inviteToken;

  // Load invitation details if token is present
  useEffect(() => {
    if (inviteToken) {
      loadInvitationInfo();
    }
  }, [inviteToken]);

  useEffect(() => {
    if (!isConsultant) return;
    api.trainerAgreements
      .current()
      .then((res) => setRequiresAddress(res.data.fields.includes('address')))
      .catch(() => {});
  }, [isConsultant]);

  // The auth context resolves the new account asynchronously, and /apply needs it resolved.
  useEffect(() => {
    if (applyState && user) navigate('/apply', { replace: true, state: applyState });
  }, [applyState, user, navigate]);

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

    // SECURITY: do not send a self-selected role in metadata. New accounts default to the
    // least-privileged role server-side; trainer access comes only from an admin approving
    // the signed Consultant Agreement. `applying_as_consultant` only steers navigation.
    const { error } = await signUp(email, password, {
      full_name: fullName,
      agency_name: isConsultant
        ? details.organisation.trim() || 'Independent Consultant'
        : agencyName,
      ...(isConsultant ? { applying_as_consultant: true } : {}),
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    if (!isConsultant) {
      setSuccess(true);
      // If they signed up via invitation, redirect to sessions after a delay
      setTimeout(() => {
        if (inviteToken) {
          navigate('/sessions');
        } else {
          navigate('/login');
        }
      }, 2000);
      return;
    }

    const draft: AgreementDetails = { ...details, full_name: fullName };
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      // Email confirmation is required before the first sign-in; /apply picks the draft up then.
      saveAgreementDraft(draft);
      setConfirmEmailFirst(true);
      setLoading(false);
      return;
    }
    try {
      await api.trainerAgreements.saveMine({
        full_name: draft.full_name.trim(),
        contact_number: draft.contact_number.trim(),
        address: draft.address.trim() || null,
        organisation: draft.organisation.trim() || null,
      });
      clearAgreementDraft();
      setApplyState({});
    } catch (err) {
      // The account exists now, so carry on at /apply, which shows the problem with the form.
      saveAgreementDraft(draft);
      setApplyState({
        detailsError: err instanceof Error ? err.message : 'Could not save your details',
      });
    }
  };

  if (success || confirmEmailFirst) {
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
            {confirmEmailFirst ? (
              <>
                <h2 className="text-2xl font-extrabold text-brand mb-2">Confirm your email</h2>
                <p className="text-sm text-muted mb-4">
                  We sent a confirmation link to {email}. Open it, then sign in to continue your
                  application.
                </p>
                <Link to="/login" className="military-button inline-block px-6 py-2 text-sm">
                  Go to sign in
                </Link>
              </>
            ) : (
              <>
                <h2 className="text-2xl font-extrabold text-brand mb-2">Account created</h2>
                <p className="text-sm text-muted mb-4">Your account is ready.</p>
                <p className="text-xs text-muted">
                  {inviteToken ? 'Taking you to your session…' : 'Redirecting to sign in…'}
                </p>
              </>
            )}
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
            <BrandMark className="w-12 h-12 mx-auto mb-4" />
            <h2 className="text-2xl font-extrabold text-brand mb-1">
              {inviteToken
                ? 'Accept invitation'
                : isConsultant
                  ? 'Apply as a consultant'
                  : 'Create your account'}
            </h2>
            <p className="text-sm text-muted">
              {isConsultant ? 'Prophyion consultant application' : 'New user registration'}
            </p>
          </div>

          {isConsultant && <ApplicationSteps current={1} compact />}

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
                    Consultant
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
                  Prophyion approves every consultant account. After this step you review and sign
                  the Prophyion Consultant Agreement, then upload the signed copy.
                </p>
              )}
            </div>
          )}

          {/* Form */}
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="fullName" className="block text-xs font-semibold text-ink mb-2">
                {isConsultant ? 'Full legal name' : 'Full name'}
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                required
                minLength={isConsultant ? 2 : undefined}
                maxLength={isConsultant ? 120 : undefined}
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-4 py-3 military-input text-sm"
                placeholder={isConsultant ? 'Tan Mei Ling' : 'Last, First M.'}
              />
              {isConsultant && (
                <p className="mt-1 text-xs text-muted">
                  As on your NRIC or passport, in English letters. It is printed on your agreement.
                </p>
              )}
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

            {isConsultant ? (
              <AgreementDetailsFields
                value={details}
                onChange={setDetails}
                requiresAddress={requiresAddress}
                showName={false}
              />
            ) : (
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
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full military-button py-3 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading
                ? 'Processing…'
                : isConsultant
                  ? 'Continue to the agreement'
                  : 'Create account'}
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
