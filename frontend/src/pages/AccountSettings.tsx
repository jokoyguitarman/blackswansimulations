import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

/**
 * Account settings - name, organisation (trainers), password, and a shortcut
 * to the Stripe Express dashboard for bank/payout details.
 *
 * Built so trainers enrolled by an admin (temporary password, possibly
 * imperfect details) can correct everything themselves after first sign-in.
 */

export const AccountSettings = () => {
  const { user } = useAuth();
  const isStaff = user?.role === 'trainer' || user?.role === 'admin';
  const isTrainerRole = user?.role === 'trainer';

  // Profile
  const [fullName, setFullName] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Password
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Email
  const [newEmail, setNewEmail] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Payout account
  const [connectStatus, setConnectStatus] = useState<'none' | 'pending' | 'complete' | null>(null);
  const [openingStripe, setOpeningStripe] = useState(false);
  const [payoutMsg, setPayoutMsg] = useState<string | null>(null);

  useEffect(() => {
    api.profile
      .get()
      .then((res) => {
        setFullName(res.data.full_name ?? '');
        setAgencyName(res.data.agency_name ?? '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    supabase.auth
      .getUser()
      .then(({ data }: { data: { user: { email?: string } | null } }) =>
        setEmail(data.user?.email ?? ''),
      );
    if (isTrainerRole) {
      api.billing
        .connectStatus()
        .then((res) => setConnectStatus(res.data.status))
        .catch(() => setConnectStatus(null));
    }
  }, [isTrainerRole]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      const body: { full_name?: string; agency_name?: string } = { full_name: fullName };
      if (isStaff) body.agency_name = agencyName;
      await api.profile.update(body);
      setProfileMsg({ ok: true, text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to update profile',
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);
    if (newPassword.length < 6) {
      setPasswordMsg({ ok: false, text: 'Password must be at least 6 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ ok: false, text: 'Passwords do not match.' });
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMsg({ ok: true, text: 'Password changed. Use it the next time you sign in.' });
    } catch (err) {
      setPasswordMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to change password',
      });
    } finally {
      setSavingPassword(false);
    }
  };

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg(null);
    if (!newEmail || newEmail.toLowerCase() === email.toLowerCase()) {
      setEmailMsg({ ok: false, text: 'Enter a different email address.' });
      return;
    }
    setSavingEmail(true);
    try {
      // Supabase's secure email change: confirmation links are sent to BOTH
      // the current and the new address; the change only applies after both
      // are confirmed. Nothing changes until then.
      const { error } = await supabase.auth.updateUser(
        { email: newEmail },
        { emailRedirectTo: `${window.location.origin}/account` },
      );
      if (error) throw error;
      setEmailMsg({
        ok: true,
        text: `Confirmation links sent to ${email} and ${newEmail}. Open BOTH emails and click the links to complete the change - until then you keep signing in with your current email.`,
      });
      setNewEmail('');
    } catch (err) {
      setEmailMsg({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to start email change',
      });
    } finally {
      setSavingEmail(false);
    }
  };

  const handleManagePayouts = async () => {
    setOpeningStripe(true);
    setPayoutMsg(null);
    try {
      const res = await api.billing.connectManage();
      window.open(res.data.url, '_blank', 'noopener');
    } catch (err) {
      setPayoutMsg(err instanceof Error ? err.message : 'Failed to open Stripe dashboard');
    } finally {
      setOpeningStripe(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading account…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Account settings</h1>
              <p className="text-sm text-muted">Signed in as {email}</p>
            </div>
            <Link
              to="/dashboard"
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
            >
              Dashboard
            </Link>
          </div>
        </div>

        {/* Profile */}
        <form
          onSubmit={handleSaveProfile}
          className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6"
        >
          <div className="text-sm font-bold text-brand mb-4">Profile</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                Full name
              </label>
              <input
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={200}
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                Organisation / company
              </label>
              <input
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                maxLength={100}
                disabled={!isStaff}
                title={isStaff ? undefined : 'Participants cannot change their agency'}
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink focus:outline-none focus:border-brand disabled:bg-surface-2 disabled:text-muted"
              />
            </div>
          </div>
          {profileMsg && (
            <div className={`text-xs mb-3 ${profileMsg.ok ? 'text-success' : 'text-danger'}`}>
              {profileMsg.text}
            </div>
          )}
          <button
            type="submit"
            disabled={savingProfile}
            className="military-button px-6 py-2 text-sm disabled:opacity-50"
          >
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </form>

        {/* Email */}
        <form
          onSubmit={handleChangeEmail}
          className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6"
        >
          <div className="text-sm font-bold text-brand mb-1">Change sign-in email</div>
          <p className="text-xs text-muted mb-4">
            For security, confirmation links are sent to <b>both</b> your current and your new
            address - the change only takes effect after both are confirmed.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                Current email
              </label>
              <input
                value={email}
                disabled
                className="w-full px-3 py-2 text-sm bg-surface-2 border border-border-strong rounded-lg text-muted"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                New email
              </label>
              <input
                required
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink placeholder:text-muted/60 focus:outline-none focus:border-brand"
              />
            </div>
          </div>
          {emailMsg && (
            <div className={`text-xs mb-3 ${emailMsg.ok ? 'text-success' : 'text-danger'}`}>
              {emailMsg.text}
            </div>
          )}
          <button
            type="submit"
            disabled={savingEmail}
            className="military-button px-6 py-2 text-sm disabled:opacity-50"
          >
            {savingEmail ? 'Sending confirmations…' : 'Change email'}
          </button>
        </form>

        {/* Password */}
        <form
          onSubmit={handleChangePassword}
          className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6"
        >
          <div className="text-sm font-bold text-brand mb-1">Change password</div>
          <p className="text-xs text-muted mb-4">
            If your account was created for you with a temporary password, set your own here.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                New password
              </label>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                Confirm new password
              </label>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink focus:outline-none focus:border-brand"
              />
            </div>
          </div>
          {passwordMsg && (
            <div className={`text-xs mb-3 ${passwordMsg.ok ? 'text-success' : 'text-danger'}`}>
              {passwordMsg.text}
            </div>
          )}
          <button
            type="submit"
            disabled={savingPassword}
            className="military-button px-6 py-2 text-sm disabled:opacity-50"
          >
            {savingPassword ? 'Changing…' : 'Change password'}
          </button>
        </form>

        {/* Payout account (trainers only) */}
        {isTrainerRole && (
          <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
            <div className="text-sm font-bold text-brand mb-1">Payout account</div>
            {connectStatus === 'complete' ? (
              <>
                <p className="text-xs text-muted mb-4">
                  Your payout account is verified. Open your Stripe dashboard to change your bank
                  account or view payout history — changes there apply to future payouts
                  automatically.
                </p>
                <button
                  onClick={handleManagePayouts}
                  disabled={openingStripe}
                  className="military-button px-6 py-2 text-sm disabled:opacity-50"
                >
                  {openingStripe ? 'Opening…' : 'Manage bank details on Stripe'}
                </button>
              </>
            ) : (
              <p className="text-xs text-muted">
                You haven't completed payout setup yet — start it from the{' '}
                <Link to="/clients" className="underline text-brand">
                  Clients &amp; billing
                </Link>{' '}
                page. Once verified, you can manage your bank details here.
              </p>
            )}
            {payoutMsg && <div className="text-xs text-danger mt-3">{payoutMsg}</div>}
          </div>
        )}
      </div>
    </div>
  );
};
