import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

// Mirrors the session shape used in pages/Sessions.tsx (participants included by the API).
interface SessionRow {
  status?: string;
  participants?: Array<{ user_id: string }>;
}

interface DashboardStats {
  scenarios: number | null;
  activeSessions: number | null;
  totalSessions: number | null;
  participants: number | null;
}

export function TrainerDashboard() {
  const { user } = useAuth();
  const isAdminUser = user?.role === 'admin';

  const [credits, setCredits] = useState<{ scenario: number; session: number } | null>(null);
  const [clientCount, setClientCount] = useState<number | null>(null);
  const [pendingPayouts, setPendingPayouts] = useState<number | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.scenarios.list(), api.sessions.list(1, 50)]).then(
      ([scenariosResult, sessionsResult]) => {
        if (cancelled) return;
        const next: DashboardStats = {
          scenarios: null,
          activeSessions: null,
          totalSessions: null,
          participants: null,
        };
        if (scenariosResult.status === 'fulfilled') {
          next.scenarios = (scenariosResult.value.data || []).length;
        }
        if (sessionsResult.status === 'fulfilled') {
          const rows = (sessionsResult.value.data || []) as SessionRow[];
          next.totalSessions = sessionsResult.value.count ?? rows.length;
          next.activeSessions = rows.filter((s) => s.status === 'in_progress').length;
          const hasParticipants = rows.some((s) => Array.isArray(s.participants));
          if (hasParticipants) {
            const uniqueIds = new Set<string>();
            rows.forEach((s) => s.participants?.forEach((p) => uniqueIds.add(p.user_id)));
            next.participants = uniqueIds.size;
          }
        }
        setStats(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isAdminUser) {
      // Admins have no usage limits - fetch business-console context instead.
      api.billing
        .listPayouts('pending_release')
        .then((res) => setPendingPayouts(res.data.length))
        .catch(() => setPendingPayouts(0));
      return;
    }
    api.billing
      .getCredits()
      .then((res) => setCredits(res.data))
      .catch(() => setCredits({ scenario: 0, session: 0 }));
    api.billing
      .listOrganisations()
      .then((res) => setClientCount(res.data.length))
      .catch(() => setClientCount(0));
  }, [isAdminUser]);

  const hasScenarioCredit = (credits?.scenario ?? 0) > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-border pb-4 mb-6">
        <h2 className="text-2xl font-extrabold text-brand mb-1">
          {isAdminUser ? 'Admin command center' : 'Trainer command center'}
        </h2>
        <p className="text-sm text-muted">
          {isAdminUser
            ? 'Full unlimited access · business oversight mode'
            : 'Full system visibility · exercise oversight mode'}
        </p>
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
          {isAdminUser
            ? 'As admin, you have unlimited access to all features - no credits or usage limits apply to your account.'
            : 'As trainer, you have complete visibility into all agency activities, decisions, and blind spots. Use this to monitor exercise progress and provide guidance.'}
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Scenarios', value: stats?.scenarios, icon: '🗺️' },
          { label: 'Active sessions', value: stats?.activeSessions, icon: '📡' },
          { label: 'Total sessions', value: stats?.totalSessions, icon: '🗂️' },
          { label: 'Participants', value: stats?.participants, icon: '👥' },
        ].map(({ label, value, icon }) => (
          <div
            key={label}
            className="bg-surface border border-border rounded-xl p-4 shadow-sm relative"
          >
            <div className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-brand/5 grid place-items-center text-sm">
              {icon}
            </div>
            <div className="text-[11px] font-bold text-muted uppercase tracking-wide">{label}</div>
            {stats === null ? (
              <div className="skeleton w-12 h-8 mt-1" />
            ) : (
              <div className="text-3xl font-extrabold text-brand mt-1">{value ?? '—'}</div>
            )}
            <div className="h-[3px] w-8 bg-accent rounded mt-3" />
          </div>
        ))}
      </div>

      {/* Modules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isAdminUser ? (
          <div className="bg-surface-2 border border-border rounded-lg p-4">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Business console
            </div>
            <p className="text-xs text-muted mb-3">
              {pendingPayouts === null
                ? 'Trainers, clients, engagements and payouts.'
                : pendingPayouts > 0
                  ? `${pendingPayouts} payout${pendingPayouts === 1 ? '' : 's'} awaiting your review.`
                  : 'Trainers, clients, engagements and payouts. No payouts awaiting review.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link to="/admin/trainers" className="military-button inline-block px-4 py-2 text-xs">
                Trainer directory →
              </Link>
              <Link
                to="/admin/payouts"
                className={`inline-block px-4 py-2 text-xs font-semibold rounded-lg border transition-all ${
                  (pendingPayouts ?? 0) > 0
                    ? 'border-warning text-warning hover:bg-warning/10'
                    : 'border-border-strong text-brand hover:bg-surface-2'
                }`}
              >
                Payout review{(pendingPayouts ?? 0) > 0 ? ` (${pendingPayouts})` : ''} →
              </Link>
            </div>
          </div>
        ) : (
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
        )}

        <div className="bg-surface-2 border border-border rounded-lg p-4">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
            Scenario management
          </div>
          {isAdminUser || hasScenarioCredit ? (
            <>
              <p className="text-xs text-muted mb-3">
                {isAdminUser
                  ? 'Build and manage scenarios in the War Room - unlimited access.'
                  : "You have a scenario credit available - build your client's scenario in the War Room."}
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
            {isAdminUser
              ? 'Produce AARs after trainings conclude - this queues the trainer payout for your review.'
              : 'Produce the AAR after a training concludes - this also queues your payout for release.'}
          </p>
        </div>
      </div>
    </div>
  );
}
