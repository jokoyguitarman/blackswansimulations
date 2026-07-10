import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminPayout } from '../lib/api';

/**
 * Admin payout review - the release valve of the payment portal.
 *
 * Producing an AAR only queues a payout as pending_release; nothing moves
 * until an admin releases it here (which executes the Stripe transfer).
 */

const formatSgd = (cents: number) =>
  (cents / 100).toLocaleString('en-SG', { style: 'currency', currency: 'SGD' });

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) : '-';

const sessionDuration = (s: { start_time: string | null; end_time: string | null }) => {
  if (!s.start_time || !s.end_time) return null;
  const mins = Math.round(
    (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 60000,
  );
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

const TABS: Array<{ id: string; label: string }> = [
  { id: 'pending_release', label: 'Pending release' },
  { id: 'awaiting_completion', label: 'Awaiting completion' },
  { id: 'released', label: 'Released' },
  { id: 'held', label: 'Held' },
  { id: 'failed', label: 'Failed' },
];

export const AdminPayouts = () => {
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [tab, setTab] = useState('pending_release');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.billing.listPayouts();
      setPayouts(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payouts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = payouts.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});
  const visible = payouts.filter((p) => p.status === tab);

  const handleRelease = async (p: AdminPayout) => {
    const trainerName = p.trainer?.full_name ?? 'the trainer';
    if (
      !window.confirm(
        `Release ${formatSgd(p.amount_cents)} to ${trainerName}?\n\nThis executes a Stripe transfer immediately and cannot be undone.`,
      )
    )
      return;
    setBusy(p.id);
    setError(null);
    try {
      await api.billing.releasePayout(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release payout');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const handleHold = async (p: AdminPayout) => {
    const reason =
      window.prompt('Reason for holding this payout (visible to admins only):') ?? undefined;
    if (reason === undefined) return;
    setBusy(p.id);
    try {
      await api.billing.holdPayout(p.id, reason || undefined);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to hold payout');
    } finally {
      setBusy(null);
    }
  };

  const handleUnhold = async (p: AdminPayout) => {
    setBusy(p.id);
    try {
      await api.billing.unholdPayout(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unhold payout');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading payouts…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Payout review</h1>
              <p className="text-sm text-muted">
                Release trainer payouts after verifying the funded training actually ran.
              </p>
            </div>
            <Link
              to="/dashboard"
              className="px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
            >
              Dashboard
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-xl p-4 mb-6 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-xs font-bold rounded-lg border transition-all ${
                tab === t.id
                  ? 'bg-brand text-white border-brand'
                  : 'bg-surface text-muted border-border hover:border-brand hover:text-brand'
              }`}
            >
              {t.label} · {counts[t.id] ?? 0}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="bg-surface-2 border border-border rounded-xl p-10 text-center text-xs text-muted">
            No payouts in this state.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Trainer
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Client / engagement
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Sessions run
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    AAR
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Payout
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => {
                  const onboarded = p.trainer_onboarding_status === 'complete';
                  const sessions = p.funded_sessions ?? [];
                  const shortSession = sessions.some((s) => {
                    const d =
                      s.start_time && s.end_time
                        ? (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) /
                          60000
                        : null;
                    return d !== null && d < 45;
                  });
                  return (
                    <tr key={p.id} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-ink">
                          {p.trainer?.full_name ?? 'Unknown'}
                        </div>
                        <div
                          className={`text-[11px] ${onboarded ? 'text-success' : 'text-danger'}`}
                        >
                          {onboarded ? 'Payouts: verified ✓' : 'Payouts: setup incomplete'}
                        </div>
                        {p.hold_reason && (
                          <div className="text-[11px] text-danger mt-1">Hold: {p.hold_reason}</div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-muted">
                        <div className="font-semibold text-ink">
                          {p.invoice?.organisation?.name ?? 'Unknown client'}
                        </div>
                        {p.invoice
                          ? `${formatSgd(p.invoice.amount_cents)} · paid ${formatDate(p.invoice.paid_at)}`
                          : ''}
                      </td>
                      <td className="px-5 py-3.5 text-muted">
                        {sessions.length === 0 ? (
                          <span className="text-[11px]">none yet</span>
                        ) : (
                          <>
                            <div className="text-ink font-semibold">{sessions.length} of 2</div>
                            <div className={`text-[11px] ${shortSession ? 'text-danger' : ''}`}>
                              {sessions.map((s) => sessionDuration(s) ?? s.status).join(' · ')}
                              {shortSession ? ' ⚠' : ''}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-muted">{formatDate(p.aar_generated_at)}</td>
                      <td className="px-5 py-3.5 font-extrabold text-brand whitespace-nowrap">
                        {formatSgd(p.amount_cents)}
                        {p.status === 'released' && p.released_at && (
                          <div className="text-[11px] font-medium text-success">
                            released {formatDate(p.released_at)}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {(p.status === 'pending_release' || p.status === 'failed') && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRelease(p)}
                              disabled={!onboarded || busy === p.id}
                              title={
                                onboarded
                                  ? undefined
                                  : 'Trainer has not finished Stripe payout setup'
                              }
                              className="military-button px-4 py-1.5 text-xs disabled:opacity-100"
                            >
                              {busy === p.id ? '…' : 'Release'}
                            </button>
                            <button
                              onClick={() => handleHold(p)}
                              disabled={busy === p.id}
                              className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-danger/40 text-danger hover:bg-danger/5 transition-all"
                            >
                              Hold
                            </button>
                          </div>
                        )}
                        {p.status === 'held' && (
                          <button
                            onClick={() => handleUnhold(p)}
                            disabled={busy === p.id}
                            className="px-4 py-1.5 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
                          >
                            Unhold
                          </button>
                        )}
                        {(p.status === 'awaiting_completion' || p.status === 'released') && (
                          <span className="text-[11px] text-muted">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted mt-4 max-w-2xl">
          Release executes a Stripe transfer of the trainer's 30% share to their verified bank
          account. Suspiciously short sessions are flagged with ⚠ - hold the payout and investigate
          before releasing.
        </p>
      </div>
    </div>
  );
};
