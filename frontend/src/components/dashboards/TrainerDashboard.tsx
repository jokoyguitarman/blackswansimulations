import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';

export function TrainerDashboard() {
  const [credits, setCredits] = useState<{ scenario: number; session: number } | null>(null);
  const [clientCount, setClientCount] = useState<number | null>(null);

  useEffect(() => {
    api.billing
      .getCredits()
      .then((res) => setCredits(res.data))
      .catch(() => setCredits({ scenario: 0, session: 0 }));
    api.billing
      .listOrganisations()
      .then((res) => setClientCount(res.data.length))
      .catch(() => setClientCount(0));
  }, []);

  const hasScenarioCredit = (credits?.scenario ?? 0) > 0;

  return (
    <div className="space-y-6">
      {/* Trainer-specific header */}
      <div className="border-b border-border pb-4 mb-6">
        <h2 className="text-2xl font-extrabold text-brand mb-1">Trainer command center</h2>
        <p className="text-sm text-muted">Full system visibility · exercise oversight mode</p>
      </div>

      {/* Full visibility notice */}
      <div className="border-l-4 border-accent bg-accent/10 rounded-md p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 bg-accent rounded-full"></div>
          <span className="text-xs font-bold text-accent uppercase tracking-wide">
            Full system visibility
          </span>
        </div>
        <p className="text-sm text-muted">
          As trainer, you have complete visibility into all agency activities, decisions, and blind
          spots. Use this to monitor exercise progress and provide guidance.
        </p>
      </div>

      {/* Trainer modules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
            Clients &amp; billing
          </div>
          <div className="flex gap-3 mb-3">
            <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5">
              <span
                className={`text-xl font-extrabold ${
                  (credits?.scenario ?? 0) > 0 ? 'text-success' : 'text-brand'
                }`}
              >
                {credits?.scenario ?? '·'}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted leading-tight">
                Scenario
                <br />
                credits
              </span>
            </div>
            <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-1.5">
              <span
                className={`text-xl font-extrabold ${
                  (credits?.session ?? 0) > 0 ? 'text-success' : 'text-brand'
                }`}
              >
                {credits?.session ?? '·'}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted leading-tight">
                Session
                <br />
                credits
              </span>
            </div>
          </div>
          <p className="text-xs text-muted mb-3">
            {clientCount === 0
              ? 'No enrolled clients yet. Enroll a client and send your first invoice to unlock scenario generation.'
              : `${clientCount ?? '…'} enrolled client${clientCount === 1 ? '' : 's'}.`}
          </p>
          <Link
            to="/clients"
            className="inline-block px-4 py-2 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
          >
            Manage clients →
          </Link>
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
            Scenario management
          </div>
          {hasScenarioCredit ? (
            <>
              <p className="text-xs text-muted mb-3">
                You have a scenario credit available - build your client's scenario in the War Room.
              </p>
              <Link to="/warroom" className="military-button inline-block px-4 py-2 text-xs">
                Open War Room →
              </Link>
            </>
          ) : (
            <div className="bg-surface border border-border rounded-lg p-3 text-center">
              <div className="text-sm font-bold text-brand mb-0.5">War Room locked</div>
              <div className="text-[11px] text-muted">
                Requires 1 scenario credit - granted when a client pays an invoice
              </div>
            </div>
          )}
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Exercise monitoring
          </div>
          <p className="text-xs text-muted mb-3">Monitor live sessions and participant activity.</p>
          <Link
            to="/sessions"
            className="inline-block px-4 py-2 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
          >
            View sessions →
          </Link>
        </div>

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Analytics &amp; AAR
          </div>
          <p className="text-xs text-muted">
            Produce the AAR after a training concludes - this also queues your payout for release.
          </p>
        </div>
      </div>
    </div>
  );
}
