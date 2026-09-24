import { useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import {
  APPLICATION_REVIEW_TIME,
  isOpenAgreementStatus,
  type TrainerAgreement,
} from '@shared/trainerAgreements';
import { useAuth } from '../contexts/AuthContext';
import { useMyAgreement } from '../hooks/useMyAgreement';
import { api } from '../lib/api';
import { openInNewTab } from '../lib/openInNewTab';
import { BrandMark } from '../components/BrandMark';
import { ApplicationSteps } from '../components/agreement/ApplicationSteps';
import {
  AgreementDetailsFields,
  clearAgreementDraft,
  emptyAgreementDetails,
  loadAgreementDraft,
  type AgreementDetails,
} from '../components/agreement/AgreementDetailsFields';
import { AgreementPreview } from '../components/agreement/AgreementPreview';
import { SignedUploadCard } from '../components/agreement/SignedUploadCard';
import { formatAgreementDate } from '../components/agreement/AgreementStatusCard';

/** Passed by the signup page when the account was created but saving the details failed. */
export interface ApplyLocationState {
  detailsError?: string;
}

const card = 'bg-surface border border-border rounded-xl shadow-sm p-6';
const secondaryButton =
  'px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all';

const detailsFrom = (row: TrainerAgreement): AgreementDetails => ({
  full_name: row.full_name,
  contact_number: row.contact_number ?? '',
  address: row.address ?? '',
  organisation: row.organisation ?? '',
});

function DetailsForm({
  initial,
  email,
  requiresAddress,
  submitLabel,
  note,
  initialError,
  onSaved,
  onCancel,
}: {
  initial: AgreementDetails;
  email: string;
  requiresAddress: boolean;
  submitLabel: string;
  note?: string;
  initialError?: string;
  onSaved: (row: TrainerAgreement) => void;
  onCancel?: () => void;
}) {
  const [details, setDetails] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.trainerAgreements.saveMine({
        full_name: details.full_name.trim(),
        contact_number: details.contact_number.trim(),
        address: details.address.trim() || null,
        organisation: details.organisation.trim() || null,
      });
      clearAgreementDraft();
      onSaved(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your details');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className={`${card} space-y-4`}>
      <div>
        <div className="text-sm font-bold text-brand">Your details</div>
        <p className="text-xs text-muted mt-1">These are printed on your agreement.</p>
      </div>
      <AgreementDetailsFields
        value={details}
        onChange={setDetails}
        requiresAddress={requiresAddress}
      />
      <div>
        <div className="block text-xs font-semibold text-ink mb-2">Email</div>
        <div className="text-sm text-ink">{email}</div>
        <p className="mt-1 text-xs text-muted">
          Your sign-in email. Notices under the agreement are sent here.
        </p>
      </div>
      {note && <p className="text-xs text-warning">{note}</p>}
      {error && (
        <div className="border-l-4 border-danger bg-danger/10 p-3 rounded-md text-sm text-danger">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="military-button px-6 py-2 text-sm disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-semibold rounded-lg text-muted hover:text-ink transition-all"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const Detail = ({ label, value }: { label: string; value: string | null }) => (
  <div>
    <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</dt>
    <dd className="text-sm text-ink mt-0.5 break-words">{value || 'Not given'}</dd>
  </div>
);

function DetailsSummary({
  agreement,
  onEdit,
}: {
  agreement: TrainerAgreement;
  onEdit: () => void;
}) {
  return (
    <section className={card}>
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <div className="text-sm font-bold text-brand">Your details</div>
          <p className="text-xs text-muted mt-1">Printed on your agreement.</p>
        </div>
        <button onClick={onEdit} className={secondaryButton}>
          Edit details
        </button>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mt-4">
        <Detail label="Full legal name" value={agreement.full_name} />
        <Detail label="Email" value={agreement.email} />
        <Detail label="Contact number" value={agreement.contact_number} />
        {agreement.address && <Detail label="Address" value={agreement.address} />}
        {agreement.organisation && (
          <Detail label="Company or organisation" value={agreement.organisation} />
        )}
      </dl>
    </section>
  );
}

function ViewSignedCopyButton({ label }: { label: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        onClick={() =>
          openInNewTab(async () => (await api.trainerAgreements.mySignedUrl()).data.url).catch(
            (err: unknown) =>
              setError(err instanceof Error ? err.message : 'Could not open the file'),
          )
        }
        className={secondaryButton}
      >
        {label}
      </button>
      {error && <p className="basis-full text-xs text-danger">{error}</p>}
    </>
  );
}

const SuccessIcon = () => (
  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 text-success mb-3">
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  </div>
);

function UnderReview({ agreement }: { agreement: TrainerAgreement }) {
  const isApplication = agreement.purpose === 'application';
  return (
    <section className={card}>
      <SuccessIcon />
      <h2 className="text-lg font-extrabold text-brand">
        {isApplication ? 'Application submitted' : 'Signed agreement submitted'}
      </h2>
      <p className="text-sm text-muted mt-2">
        Thank you. We received your signed agreement on{' '}
        {formatAgreementDate(agreement.submitted_at)}.{' '}
        {isApplication
          ? `We review every application personally and aim to respond within ${APPLICATION_REVIEW_TIME}.`
          : 'We will confirm by email once it is on file. Your access continues as normal.'}{' '}
        We will email you at <span className="font-semibold text-ink">{agreement.email}</span>.
      </p>
      <p className="text-xs text-muted mt-3">
        Reference <span className="font-mono text-ink">{agreement.reference}</span>
      </p>
      <div className="flex flex-wrap gap-3 mt-5">
        <ViewSignedCopyButton label="View what you submitted" />
        <Link to="/dashboard" className="military-button px-4 py-2 text-sm">
          Go to dashboard
        </Link>
      </div>
    </section>
  );
}

export const Apply = () => {
  const { user } = useAuth();
  const location = useLocation();
  const isAdmin = user?.role === 'admin';
  const { mine, setMine, loading, error, reload } = useMyAgreement(!isAdmin);
  const [editing, setEditing] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  if (isAdmin) return <Navigate to="/admin/trainers" replace />;

  if (!mine) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        {loading ? (
          <div className="text-center">
            <div className="text-lg text-ink mb-2 animate-pulse">Loading</div>
            <div className="text-xs text-muted">Loading your application…</div>
          </div>
        ) : (
          <div className={`${card} max-w-md text-center`}>
            <p className="text-sm text-danger mb-4">
              {error ?? 'Could not load your application.'}
            </p>
            <button onClick={() => void reload()} className="military-button px-6 py-2 text-sm">
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const { current, onFile, agreement: info } = mine;
  const requiresAddress = info.fields.includes('address');
  const open = current && isOpenAgreementStatus(current.status) ? current : null;
  const isTrainer = user?.role === 'trainer';
  const updateRow = (row: TrainerAgreement) => {
    setMine({ ...mine, current: row });
    setEditing(false);
  };

  let step: 1 | 2 | 3 | 4 | null = null;
  let content: ReactNode;

  if (open && open.status !== 'submitted') {
    step = downloaded ? 3 : 2;
    content = (
      <>
        {open.status === 'changes_requested' && (
          <div className="border-l-4 border-warning bg-warning/10 p-4 rounded-md">
            <div className="text-sm font-bold text-ink">
              We need a change before we can continue
            </div>
            {open.review_note && (
              <p className="text-sm text-ink mt-1 whitespace-pre-line">{open.review_note}</p>
            )}
            <p className="text-xs text-muted mt-2">
              Correct your details if needed, sign the agreement again and upload the new copy.
            </p>
          </div>
        )}
        {editing ? (
          <DetailsForm
            initial={detailsFrom(open)}
            email={open.email}
            requiresAddress={requiresAddress}
            submitLabel="Save and re-issue the agreement"
            note="Saving issues a fresh copy of the agreement. If you have already signed the old copy, sign the new one instead."
            onSaved={updateRow}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <DetailsSummary agreement={open} onEdit={() => setEditing(true)} />
            <AgreementPreview agreement={open} onDownloaded={() => setDownloaded(true)} />
            <SignedUploadCard agreement={open} onUploaded={updateRow} />
          </>
        )}
      </>
    );
  } else if (open) {
    step = 4;
    content = <UnderReview agreement={open} />;
  } else if (onFile && user?.role === 'participant') {
    content = (
      <section className={card}>
        <SuccessIcon />
        <h2 className="text-lg font-extrabold text-brand">Your application is approved</h2>
        <p className="text-sm text-muted mt-2">
          Welcome to Prophyion. Your account now has consultant access.
        </p>
        <button
          onClick={() => {
            window.location.href = '/clients';
          }}
          className="military-button mt-5 px-6 py-2 text-sm"
        >
          Open consultant tools
        </button>
      </section>
    );
  } else if (onFile) {
    content = (
      <section className={card}>
        <SuccessIcon />
        <h2 className="text-lg font-extrabold text-brand">Your signed agreement is on file</h2>
        <p className="text-sm text-muted mt-2">
          Version {onFile.agreement_version}, accepted {formatAgreementDate(onFile.reviewed_at)}.
        </p>
        <div className="flex flex-wrap gap-3 mt-5">
          <ViewSignedCopyButton label="View your signed copy" />
          <Link to="/dashboard" className="military-button px-4 py-2 text-sm">
            Go to dashboard
          </Link>
        </div>
      </section>
    );
  } else if (current?.status === 'rejected' && !isTrainer) {
    content = (
      <section className={card}>
        <h2 className="text-lg font-extrabold text-brand">Your application was not approved</h2>
        {current.review_note && (
          <p className="text-sm text-ink mt-2 whitespace-pre-line">{current.review_note}</p>
        )}
        <p className="text-sm text-muted mt-2">
          If you have questions, reply to the email we sent you.
        </p>
        <Link to="/dashboard" className="military-button inline-block mt-5 px-6 py-2 text-sm">
          Go to dashboard
        </Link>
      </section>
    );
  } else {
    step = 1;
    const name = user?.displayName && !user.displayName.includes('@') ? user.displayName : '';
    content = (
      <DetailsForm
        initial={{ ...emptyAgreementDetails, full_name: name, ...loadAgreementDraft() }}
        email={user?.email ?? ''}
        requiresAddress={requiresAddress}
        submitLabel="Continue to the agreement"
        initialError={(location.state as ApplyLocationState | null)?.detailsError}
        onSaved={updateRow}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:px-6 lg:px-8 space-y-6">
        <div className={card}>
          <div className="flex justify-between items-start gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <BrandMark className="w-10 h-10 shrink-0" />
              <div>
                <h1 className="text-2xl font-extrabold text-brand">
                  {isTrainer
                    ? 'Sign the Prophyion Consultant Agreement'
                    : 'Apply as a Prophyion consultant'}
                </h1>
                <p className="text-sm text-muted mt-1">
                  {isTrainer
                    ? 'Every Prophyion consultant signs this agreement. Your access continues while we review it.'
                    : 'Prophyion approves every consultant account. Sign the Prophyion Consultant Agreement to apply.'}
                </p>
              </div>
            </div>
            <Link to="/dashboard" className={`${secondaryButton} shrink-0`}>
              Dashboard
            </Link>
          </div>
          {step && (
            <div className="mt-5">
              <ApplicationSteps current={step} />
            </div>
          )}
        </div>
        {content}
      </div>
    </div>
  );
};
