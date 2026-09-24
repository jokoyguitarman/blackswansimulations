import { useCallback, useEffect, useState } from 'react';
import type {
  AdminAgreementView,
  AdminTrainerAgreement,
  TrainerAgreementStatus,
} from '@shared/trainerAgreements';
import { api, type AgreementDecisionResult } from '../../lib/api';
import { openBlobInNewTab, openInNewTab } from '../../lib/openInNewTab';

const VIEWS: Array<{ id: AdminAgreementView; label: string; empty: string }> = [
  { id: 'review', label: 'Needs review', empty: 'No signed agreements are waiting for review.' },
  { id: 'in_progress', label: 'In progress', empty: 'Nobody is part-way through an application.' },
  { id: 'decided', label: 'Decided', empty: 'No decisions yet.' },
];

const STATUS_LABEL: Record<TrainerAgreementStatus, string> = {
  awaiting_signature: 'Awaiting signed copy',
  submitted: 'Needs review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
};

const formatDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
    : '-';

const pill = 'text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full';
const secondaryButton =
  'px-3 py-1.5 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all disabled:opacity-50';

function UploadChecks({ item }: { item: AdminTrainerAgreement }) {
  const pages = item.signed_file_pages ?? 0;
  const pagesOk = item.expected_pages === null || pages >= item.expected_pages;
  const reference = item.was_attached
    ? { ok: true, text: 'Attached by Prophyion' }
    : item.signed_file_has_reference === true
      ? { ok: true, text: 'Reference found in the file' }
      : item.signed_file_has_reference === false
        ? { ok: false, text: 'Reference not found: check this is the agreement we issued' }
        : { ok: false, text: 'Scanned copy: check the reference by eye' };

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      <span
        className={`${pill} ${pagesOk ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}
      >
        {item.expected_pages ? `${pages} of ${item.expected_pages} pages` : `${pages} pages`}
      </span>
      <span
        className={`${pill} ${reference.ok ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}
      >
        {reference.text}
      </span>
    </div>
  );
}

function ApplicationCard({
  item,
  view,
  onDecided,
}: {
  item: AdminTrainerAgreement;
  view: AdminAgreementView;
  onDecided: (message: string) => void;
}) {
  const [noteFor, setNoteFor] = useState<'request_changes' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isApplication = item.purpose === 'application';

  const run = async (
    decide: () => Promise<{ data: AgreementDecisionResult }>,
    describe: (result: AgreementDecisionResult) => string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await decide();
      const emailNote = res.data.emailed
        ? ' We emailed them.'
        : ' The email to them did not send, so let them know directly.';
      onDecided(describe(res.data) + emailNote);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    const pages = item.expected_pages
      ? `${item.signed_file_pages ?? 0} of ${item.expected_pages} pages uploaded`
      : `${item.signed_file_pages ?? 0} pages uploaded`;
    const question = isApplication
      ? `Approve ${item.full_name} as a Prophyion consultant? Their account gets trainer access.`
      : `Accept the signed agreement from ${item.full_name}?`;
    const checklist = [
      question,
      '',
      'Before you do, check that:',
      '- it is signed and dated in the Authorisation section',
      `- every page is there (${pages})`,
      `- the reference on the pages is ${item.reference}`,
      `- you have been in touch with them at ${item.email}`,
    ].join('\n');
    if (!window.confirm(checklist)) return;
    void run(
      () => api.trainerAgreements.approve(item.id),
      (r) =>
        r.promoted
          ? `${item.full_name} is now a trainer.`
          : `${item.full_name}'s agreement is on file.`,
    );
  };

  const submitNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (noteFor === 'request_changes') {
      void run(
        () => api.trainerAgreements.requestChanges(item.id, note.trim()),
        () => `Asked ${item.full_name} for changes.`,
      );
    } else if (noteFor === 'reject') {
      void run(
        () => api.trainerAgreements.reject(item.id, note.trim()),
        () => `Rejected the ${isApplication ? 'application' : 'agreement'} from ${item.full_name}.`,
      );
    }
  };

  const openSigned = () =>
    openInNewTab(async () => (await api.trainerAgreements.signedUrl(item.id)).data.url).catch(
      (err: unknown) => setError(err instanceof Error ? err.message : 'Could not open the file'),
    );
  const openIssued = () =>
    openBlobInNewTab(() => api.trainerAgreements.issuedDocument(item.id)).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not open the agreement'),
    );

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{item.full_name}</span>
            <span
              className={`${pill} ${isApplication ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted'}`}
            >
              {isApplication ? 'New applicant' : 'Existing trainer'}
            </span>
            {view !== 'review' && (
              <span
                className={`${pill} ${
                  item.status === 'approved'
                    ? 'bg-success/10 text-success'
                    : item.status === 'rejected'
                      ? 'bg-danger/10 text-danger'
                      : 'bg-warning/10 text-warning'
                }`}
              >
                {STATUS_LABEL[item.status]}
              </span>
            )}
          </div>
          <div className="text-[12px] text-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <a href={`mailto:${item.email}`} className="underline text-brand">
              {item.email}
            </a>
            {item.contact_number && <span>{item.contact_number}</span>}
            {item.organisation && <span>{item.organisation}</span>}
          </div>
          {item.address && <div className="text-[12px] text-muted mt-0.5">{item.address}</div>}
          <div className="text-[11px] text-muted mt-1">
            Ref <span className="font-mono text-ink">{item.reference}</span> · v
            {item.agreement_version} · started {formatDate(item.created_at)}
            {item.submitted_at && ` · submitted ${formatDate(item.submitted_at)}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {item.has_signed_copy && (
            <button onClick={openSigned} className={secondaryButton}>
              Open signed copy
            </button>
          )}
          {!item.was_attached && (
            <button onClick={openIssued} className={secondaryButton}>
              Open issued copy
            </button>
          )}
        </div>
      </div>

      {item.has_signed_copy && view !== 'in_progress' && <UploadChecks item={item} />}

      {view === 'review' && item.review_note && (
        <div className="text-[12px] text-muted mt-3">
          <span className="font-semibold text-ink">Changes you asked for earlier:</span>{' '}
          {item.review_note}
        </div>
      )}

      {view === 'in_progress' && (
        <div className="text-[12px] text-muted mt-3">
          {item.status === 'changes_requested'
            ? `Waiting for a corrected copy. You asked: ${item.review_note ?? 'no note'}`
            : 'Waiting for them to upload the signed copy.'}
        </div>
      )}

      {view === 'decided' && (
        <div className="text-[12px] text-muted mt-3 space-y-1">
          <div>
            {STATUS_LABEL[item.status]} {formatDate(item.reviewed_at)}
            {item.reviewed_by_name && ` by ${item.reviewed_by_name}`}
          </div>
          {item.review_note && <div className="text-ink">Note: {item.review_note}</div>}
          {!item.was_attached && !item.decision_emailed_at && (
            <div className="text-warning font-semibold">
              The decision email did not send. Let them know directly.
            </div>
          )}
        </div>
      )}

      {view !== 'decided' && (
        <div className="mt-4">
          {noteFor ? (
            <form onSubmit={submitNote} className="space-y-2">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-muted">
                {noteFor === 'request_changes'
                  ? 'What needs to change? They will see this.'
                  : 'Reason (optional). They will see this.'}
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                required={noteFor === 'request_changes'}
                maxLength={2000}
                rows={3}
                className="w-full px-3 py-2 text-sm bg-surface border border-border-strong rounded-lg text-ink focus:outline-none focus:border-brand"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="military-button px-4 py-1.5 text-xs disabled:opacity-50"
                >
                  {busy
                    ? 'Saving…'
                    : noteFor === 'request_changes'
                      ? 'Send change request'
                      : 'Reject'}
                </button>
                <button
                  type="button"
                  onClick={() => setNoteFor(null)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {view === 'review' && (
                <>
                  <button
                    onClick={approve}
                    disabled={busy}
                    className="military-button px-4 py-1.5 text-xs disabled:opacity-50"
                  >
                    {isApplication ? 'Approve' : 'Accept'}
                  </button>
                  <button
                    onClick={() => setNoteFor('request_changes')}
                    disabled={busy}
                    className={secondaryButton}
                  >
                    Request changes
                  </button>
                </>
              )}
              <button
                onClick={() => setNoteFor('reject')}
                disabled={busy}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-danger/40 text-danger hover:bg-danger/10 transition-all disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-danger mt-3">{error}</div>}
    </div>
  );
}

/** Consultant applications and signed agreements, for the Business console. */
export function TrainerApplicationsPanel({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<AdminAgreementView>('review');
  const [items, setItems] = useState<AdminTrainerAgreement[] | null>(null);
  const [counts, setCounts] = useState<Record<AdminAgreementView, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (which: AdminAgreementView) => {
    setError(null);
    try {
      const res = await api.trainerAgreements.list(which);
      setItems(res.data.items);
      setCounts(res.data.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load applications');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void load(view);
  }, [view, load]);

  const afterDecision = (message: string) => {
    setNotice(message);
    void load(view);
    onChanged?.();
  };

  const current = VIEWS.find((v) => v.id === view)!;

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-6 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-bold text-brand">Consultant applications</div>
          <p className="text-xs text-muted mt-0.5">
            Signed Prophyion Consultant Agreements from new applicants and existing trainers.
          </p>
        </div>
        <div className="flex gap-1 bg-surface-2 border border-border rounded-lg p-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => {
                setNotice(null);
                setView(v.id);
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                view === v.id ? 'bg-surface text-brand shadow-sm' : 'text-muted hover:text-ink'
              }`}
            >
              {v.label}
              {counts ? ` (${counts[v.id]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div className="bg-success/10 border border-success/40 rounded-lg p-3 mb-4 text-xs text-ink">
          {notice}
        </div>
      )}
      {error && (
        <div className="bg-danger/10 border border-danger/40 rounded-lg p-3 mb-4 text-xs text-danger">
          {error}
        </div>
      )}

      {items === null ? (
        <div className="text-xs text-muted animate-pulse">Loading applications…</div>
      ) : items.length === 0 ? (
        <div className="bg-surface-2 border border-border rounded-lg p-6 text-center text-xs text-muted">
          {current.empty}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ApplicationCard key={item.id} item={item} view={view} onDecided={afterDecision} />
          ))}
        </div>
      )}
    </div>
  );
}
