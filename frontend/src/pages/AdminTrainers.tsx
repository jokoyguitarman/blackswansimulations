import { useState, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { api, type AdminTrainerSummary } from '../lib/api';

/**
 * Admin business console - every trainer with their clients, paid
 * engagements, remaining credits, session activity and payout totals.
 */

const formatSgd = (cents: number) =>
  (cents / 100).toLocaleString('en-SG', { style: 'currency', currency: 'SGD' });

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });

const onboardingBadge = (status: AdminTrainerSummary['onboarding_status']) => {
  switch (status) {
    case 'complete':
      return (
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-success/10 text-success">
          Payouts ready
        </span>
      );
    case 'pending':
      return (
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-warning/10 text-warning">
          Onboarding
        </span>
      );
    default:
      return (
        <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-surface-2 text-muted">
          No payout setup
        </span>
      );
  }
};

export const AdminTrainers = () => {
  const [trainers, setTrainers] = useState<AdminTrainerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.billing
      .adminTrainers()
      .then((res) => setTrainers(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load trainers'))
      .finally(() => setLoading(false));
  }, []);

  const totals = trainers.reduce(
    (acc, t) => {
      acc.revenue += t.invoices.paid_amount_cents;
      acc.paidEngagements += t.invoices.paid;
      acc.pendingPayouts += t.payouts.pending_release_cents;
      acc.releasedPayouts += t.payouts.released_cents;
      return acc;
    },
    { revenue: 0, paidEngagements: 0, pendingPayouts: 0, releasedPayouts: 0 },
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading business console…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Business console</h1>
              <p className="text-sm text-muted">
                All trainers, their clients, engagements, credits and payouts.
              </p>
            </div>
            <div className="flex gap-3">
              <Link to="/admin/payouts" className="military-button px-4 py-2 text-sm">
                Payout review
              </Link>
              <Link
                to="/dashboard"
                className="px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-xl p-4 mb-6 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Business totals */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-surface border border-border rounded-xl shadow-sm p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">
              Trainers
            </div>
            <div className="text-2xl font-extrabold text-brand">{trainers.length}</div>
          </div>
          <div className="bg-surface border border-border rounded-xl shadow-sm p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">
              Revenue collected
            </div>
            <div className="text-2xl font-extrabold text-brand">{formatSgd(totals.revenue)}</div>
            <div className="text-[11px] text-muted">
              {totals.paidEngagements} paid engagement{totals.paidEngagements === 1 ? '' : 's'}
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl shadow-sm p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">
              Payouts pending
            </div>
            <div
              className={`text-2xl font-extrabold ${totals.pendingPayouts > 0 ? 'text-warning' : 'text-brand'}`}
            >
              {formatSgd(totals.pendingPayouts)}
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl shadow-sm p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-1">
              Payouts released
            </div>
            <div className="text-2xl font-extrabold text-success">
              {formatSgd(totals.releasedPayouts)}
            </div>
          </div>
        </div>

        {/* Trainer table */}
        {trainers.length === 0 ? (
          <div className="bg-surface-2 border border-border rounded-xl p-10 text-center text-xs text-muted">
            No trainer accounts yet.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Trainer
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Clients
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Engagements
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Credits left
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Sessions
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Payouts
                  </th>
                </tr>
              </thead>
              <tbody>
                {trainers.map((t) => {
                  const isOpen = expanded === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : t.id)}
                        className="border-b border-border last:border-b-0 align-top cursor-pointer hover:bg-surface-2/50 transition-colors"
                      >
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-ink">{t.full_name || t.username}</div>
                          <div className="text-[11px] text-muted">
                            joined {formatDate(t.created_at)}
                          </div>
                          <div className="mt-1">{onboardingBadge(t.onboarding_status)}</div>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-ink">{t.client_count}</div>
                          {t.invoices.sent > 0 && (
                            <div className="text-[11px] text-warning">
                              {t.invoices.sent} invoice{t.invoices.sent === 1 ? '' : 's'} awaiting
                              payment
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-ink">{t.invoices.paid} paid</div>
                          <div className="text-[11px] text-muted">
                            {formatSgd(t.invoices.paid_amount_cents)} collected
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className={`font-bold ${t.credits.scenario > 0 ? 'text-success' : 'text-muted'}`}
                          >
                            {t.credits.scenario}
                          </span>
                          <span className="text-[11px] text-muted"> scenario · </span>
                          <span
                            className={`font-bold ${t.credits.session > 0 ? 'text-success' : 'text-muted'}`}
                          >
                            {t.credits.session}
                          </span>
                          <span className="text-[11px] text-muted"> session</span>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-ink">{t.sessions.total}</div>
                          <div className="text-[11px] text-muted">
                            {t.sessions.upcoming} upcoming · {t.sessions.active} live ·{' '}
                            {t.sessions.completed} done
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          {t.payouts.pending_release_cents > 0 ? (
                            <div className="font-bold text-warning">
                              {formatSgd(t.payouts.pending_release_cents)} pending
                            </div>
                          ) : (
                            <div className="text-[11px] text-muted">none pending</div>
                          )}
                          <div className="text-[11px] text-muted">
                            {formatSgd(t.payouts.released_cents)} released
                          </div>
                          {t.payouts.held_cents > 0 && (
                            <div className="text-[11px] text-danger">
                              {formatSgd(t.payouts.held_cents)} on hold
                            </div>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-border last:border-b-0 bg-surface-2/40">
                          <td colSpan={6} className="px-5 py-3.5">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-[12px]">
                              <div>
                                <div className="font-bold text-muted uppercase tracking-wide text-[10px] mb-1">
                                  Enrolled clients
                                </div>
                                {t.client_names.length === 0 ? (
                                  <div className="text-muted">None yet</div>
                                ) : (
                                  <ul className="text-ink space-y-0.5">
                                    {t.client_names.map((name) => (
                                      <li key={name}>{name}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div>
                                <div className="font-bold text-muted uppercase tracking-wide text-[10px] mb-1">
                                  Invoices
                                </div>
                                <div className="text-ink">
                                  {t.invoices.paid} paid · {t.invoices.sent} outstanding ·{' '}
                                  {t.invoices.void} voided
                                </div>
                                <div className="font-bold text-muted uppercase tracking-wide text-[10px] mt-2 mb-1">
                                  Awaiting training
                                </div>
                                <div className="text-ink">
                                  {formatSgd(t.payouts.awaiting_completion_cents)} in engagements
                                  not yet concluded
                                </div>
                              </div>
                              <div>
                                <div className="font-bold text-muted uppercase tracking-wide text-[10px] mb-1">
                                  Details
                                </div>
                                <div className="text-ink">{t.agency_name ?? '-'}</div>
                                <div className="text-muted">{t.username}</div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted mt-4">
          Click a row for client and invoice details. Release or hold pending payouts from the{' '}
          <Link to="/admin/payouts" className="underline text-brand">
            Payout review
          </Link>{' '}
          page.
        </p>
      </div>
    </div>
  );
};
