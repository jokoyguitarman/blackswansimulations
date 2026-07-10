import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type ClientOrganisation, type BillingPayout } from '../lib/api';

/**
 * Clients & billing - the trainer's payment-portal home.
 *
 * Enroll client organisations, send them the fixed-fee engagement invoice,
 * watch credits arrive when they pay, set up Stripe payouts, and track
 * earnings per engagement.
 */

const formatSgd = (cents: number) =>
  (cents / 100).toLocaleString('en-SG', { style: 'currency', currency: 'SGD' });

const formatDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

const latestInvoice = (org: ClientOrganisation) => {
  const invoices = org.invoices ?? [];
  if (invoices.length === 0) return null;
  return [...invoices].sort(
    (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime(),
  )[0];
};

const invoiceBadge = (status: string | null) => {
  switch (status) {
    case 'sent':
      return (
        <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-warning/10 text-warning">
          Invoice sent
        </span>
      );
    case 'paid':
      return (
        <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-success/10 text-success">
          Invoice paid
        </span>
      );
    case 'void':
      return (
        <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-danger/10 text-danger">
          Voided
        </span>
      );
    default:
      return (
        <span className="text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full bg-surface-2 text-muted">
          No invoice
        </span>
      );
  }
};

const payoutStatusLabel: Record<BillingPayout['status'], { text: string; cls: string }> = {
  awaiting_completion: { text: 'Awaiting training', cls: 'bg-surface-2 text-muted' },
  pending_release: { text: 'Pending release', cls: 'bg-warning/10 text-warning' },
  released: { text: 'Released', cls: 'bg-success/10 text-success' },
  held: { text: 'On hold', cls: 'bg-danger/10 text-danger' },
  failed: { text: 'Failed - contact support', cls: 'bg-danger/10 text-danger' },
};

export const Clients = () => {
  const [searchParams] = useSearchParams();
  const [orgs, setOrgs] = useState<ClientOrganisation[]>([]);
  const [credits, setCredits] = useState<{ scenario: number; session: number }>({
    scenario: 0,
    session: 0,
  });
  const [payouts, setPayouts] = useState<BillingPayout[]>([]);
  const [connectStatus, setConnectStatus] = useState<'none' | 'pending' | 'complete'>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enroll form
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formContact, setFormContact] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [invoicing, setInvoicing] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [copiedInvoiceId, setCopiedInvoiceId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [orgsRes, creditsRes, payoutsRes, connectRes] = await Promise.allSettled([
        api.billing.listOrganisations(),
        api.billing.getCredits(),
        api.billing.myPayouts(),
        api.billing.connectStatus(),
      ]);
      if (orgsRes.status === 'fulfilled') setOrgs(orgsRes.value.data);
      if (creditsRes.status === 'fulfilled') setCredits(creditsRes.value.data);
      if (payoutsRes.status === 'fulfilled') setPayouts(payoutsRes.value.data);
      if (connectRes.status === 'fulfilled') setConnectStatus(connectRes.value.data.status);
      if (orgsRes.status === 'rejected') {
        setError(
          orgsRes.reason instanceof Error ? orgsRes.reason.message : 'Failed to load clients',
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Returning from Stripe onboarding: re-check status.
  useEffect(() => {
    if (searchParams.get('connect') === 'return') {
      api.billing
        .connectStatus()
        .then((res) => setConnectStatus(res.data.status))
        .catch(() => {});
    }
  }, [searchParams]);

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.billing.createOrganisation({
        name: formName,
        contact_name: formContact || undefined,
        contact_email: formEmail,
        notes: formNotes || undefined,
      });
      setFormName('');
      setFormContact('');
      setFormEmail('');
      setFormNotes('');
      setShowForm(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enroll client');
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerateInvoice = async (org: ClientOrganisation) => {
    if (
      !window.confirm(
        `Send a S$10,000 engagement invoice to ${org.contact_email}?\n\nWhen paid, you receive 1 scenario credit + 2 session credits, and your 30% share (S$3,000) is released after the training concludes.`,
      )
    )
      return;
    setInvoicing(org.id);
    setError(null);
    try {
      await api.billing.generateInvoice(org.id);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate invoice');
    } finally {
      setInvoicing(null);
    }
  };

  const handleVoidInvoice = async (invoiceId: string) => {
    if (!window.confirm('Void this unpaid invoice? The client will no longer be able to pay it.'))
      return;
    try {
      await api.billing.voidInvoice(invoiceId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to void invoice');
    }
  };

  const handleConnectOnboard = async () => {
    setOnboarding(true);
    setError(null);
    try {
      const res = await api.billing.connectOnboard();
      window.location.href = res.data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start payout setup');
      setOnboarding(false);
    }
  };

  const copyInvoiceLink = (invoiceId: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedInvoiceId(invoiceId);
      setTimeout(() => setCopiedInvoiceId(null), 2000);
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
          <div className="text-xs text-muted">Loading clients &amp; billing…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
          <div className="flex flex-wrap justify-between items-end gap-4">
            <div>
              <h1 className="text-2xl font-extrabold text-brand mb-1">Clients &amp; billing</h1>
              <p className="text-sm text-muted">
                Enroll the organisations you train, invoice them, track your credits and earnings.
              </p>
            </div>
            <div className="flex gap-3">
              <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-4 py-2">
                <span
                  className={`text-2xl font-extrabold ${credits.scenario > 0 ? 'text-success' : 'text-brand'}`}
                >
                  {credits.scenario}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted leading-tight">
                  Scenario
                  <br />
                  credits
                </span>
              </div>
              <div className="flex items-center gap-3 bg-surface-2 border border-border rounded-lg px-4 py-2">
                <span
                  className={`text-2xl font-extrabold ${credits.session > 0 ? 'text-success' : 'text-brand'}`}
                >
                  {credits.session}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted leading-tight">
                  Session
                  <br />
                  credits
                </span>
              </div>
              <Link
                to="/dashboard"
                className="self-center px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </div>

        {/* Payout setup banner */}
        {connectStatus !== 'complete' && (
          <div className="bg-warning/10 border border-warning/40 border-l-4 border-l-warning rounded-xl p-4 mb-6 flex flex-wrap justify-between items-center gap-3">
            <div>
              <div className="text-sm font-bold text-ink">
                {connectStatus === 'pending'
                  ? 'Finish your payout setup'
                  : 'Set up payouts to get paid for your trainings'}
              </div>
              <div className="text-xs text-muted">
                One-time identity &amp; bank verification via Stripe. Required before your earnings
                can be released.
              </div>
            </div>
            <button
              onClick={handleConnectOnboard}
              disabled={onboarding}
              className="military-button px-5 py-2 text-sm disabled:opacity-50"
            >
              {onboarding
                ? 'Opening Stripe…'
                : connectStatus === 'pending'
                  ? 'Continue setup'
                  : 'Set up payouts'}
            </button>
          </div>
        )}
        {connectStatus === 'complete' && (
          <div className="bg-success/10 border border-success/30 rounded-xl px-4 py-2.5 mb-6 text-xs font-semibold text-success">
            Payout setup complete - your released earnings go straight to your bank account.
          </div>
        )}

        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-xl p-4 mb-6 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Enroll + client cards */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-brand">Enrolled clients</h2>
          <button
            onClick={() => setShowForm(!showForm)}
            className="military-button px-5 py-2 text-sm"
          >
            {showForm ? 'Close' : '+ Enroll client'}
          </button>
        </div>

        {showForm && (
          <form
            onSubmit={handleEnroll}
            className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                  Organisation name *
                </label>
                <input
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  maxLength={200}
                  placeholder="Meridian Foods Pte Ltd"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink placeholder:text-muted/60 focus:outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                  Contact person
                </label>
                <input
                  value={formContact}
                  onChange={(e) => setFormContact(e.target.value)}
                  maxLength={200}
                  placeholder="Daniel Tan, Head of Corporate Affairs"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink placeholder:text-muted/60 focus:outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                  Contact email *{' '}
                  <span className="normal-case font-medium">(the invoice is sent here)</span>
                </label>
                <input
                  required
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="finance@client.com"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink placeholder:text-muted/60 focus:outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-muted mb-1.5">
                  Notes
                </label>
                <input
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  maxLength={2000}
                  placeholder="Product-recall crisis training, Q3 engagement…"
                  className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink placeholder:text-muted/60 focus:outline-none focus:border-brand"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="military-button px-6 py-2 text-sm disabled:opacity-50"
            >
              {submitting ? 'Enrolling…' : 'Enroll client'}
            </button>
          </form>
        )}

        {orgs.length === 0 && !showForm ? (
          <div className="bg-surface-2 border border-dashed border-border-strong rounded-xl p-10 text-center mb-8">
            <div className="text-sm font-bold text-brand mb-1">No clients enrolled yet</div>
            <div className="text-xs text-muted max-w-sm mx-auto">
              Enroll a client and send your first invoice to unlock scenario generation and session
              credits.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {orgs.map((org) => {
              const invoice = latestInvoice(org);
              const canInvoice = !invoice || invoice.status === 'void';
              return (
                <div
                  key={org.id}
                  className="bg-surface border border-border rounded-xl shadow-sm p-5"
                >
                  <div className="flex justify-between items-start gap-3 mb-1">
                    <div>
                      <div className="text-base font-extrabold text-brand">{org.name}</div>
                      <div className="text-xs text-muted">
                        {org.contact_name ? `${org.contact_name} · ` : ''}
                        {org.contact_email}
                      </div>
                      {org.notes && <div className="text-xs text-muted mt-0.5">{org.notes}</div>}
                    </div>
                    <div className="flex-none">
                      {invoiceBadge(invoice?.status ?? null)}
                      {invoice?.paid_at && (
                        <div className="text-[10px] text-muted text-right mt-1">
                          paid {formatDate(invoice.paid_at)}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-border mt-3 pt-3 flex flex-wrap items-center gap-2.5">
                    <button
                      onClick={() => handleGenerateInvoice(org)}
                      disabled={!canInvoice || invoicing === org.id}
                      className="military-button px-4 py-2 text-xs disabled:opacity-100"
                    >
                      {invoicing === org.id ? 'Sending…' : 'Generate invoice'}
                    </button>
                    {invoice?.status === 'sent' && (
                      <>
                        {invoice.hosted_invoice_url && (
                          <button
                            onClick={() => copyInvoiceLink(invoice.id, invoice.hosted_invoice_url!)}
                            className="px-4 py-2 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
                          >
                            {copiedInvoiceId === invoice.id ? 'Copied!' : 'Copy payment link'}
                          </button>
                        )}
                        <button
                          onClick={() => handleVoidInvoice(invoice.id)}
                          className="px-4 py-2 text-xs font-semibold rounded-lg border border-danger/40 text-danger hover:bg-danger/5 transition-all"
                        >
                          Void
                        </button>
                        <span className="text-[11px] text-muted">
                          {formatSgd(invoice.amount_cents)} · emailed to {org.contact_email}
                        </span>
                      </>
                    )}
                    {invoice?.status === 'paid' && (
                      <span className="text-[11px] text-muted">
                        Engagement funds: <b className="text-brand">1</b> scenario ·{' '}
                        <b className="text-brand">2</b> sessions · payout{' '}
                        <b className="text-success">30%</b> after AAR
                      </span>
                    )}
                    {canInvoice && !invoice && (
                      <span className="text-[11px] text-muted">
                        Fixed engagement fee · S$10,000 · paid on a secure Stripe page
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Earnings */}
        <h2 className="text-lg font-bold text-brand mb-4">My earnings</h2>
        {payouts.length === 0 ? (
          <div className="bg-surface-2 border border-border rounded-xl p-6 text-center text-xs text-muted">
            Your payouts appear here once a client pays an invoice.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Engagement
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Invoice
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Your share
                  </th>
                  <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => {
                  const badge = payoutStatusLabel[p.status];
                  return (
                    <tr key={p.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3.5 font-semibold text-ink">
                        {p.invoice?.organisation?.name ?? 'Engagement'}
                      </td>
                      <td className="px-5 py-3.5 text-muted">
                        {p.invoice ? formatSgd(p.invoice.amount_cents) : ''}
                        {p.invoice?.paid_at ? ` · paid ${formatDate(p.invoice.paid_at)}` : ''}
                      </td>
                      <td className="px-5 py-3.5 font-extrabold text-brand">
                        {formatSgd(p.amount_cents)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={`text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${badge.cls}`}
                        >
                          {badge.text}
                          {p.status === 'released' && p.released_at
                            ? ` ${formatDate(p.released_at)}`
                            : ''}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
