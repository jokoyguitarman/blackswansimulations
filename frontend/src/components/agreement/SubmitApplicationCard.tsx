import { useState } from 'react';
import type { TrainerAgreement } from '@shared/trainerAgreements';
import { api } from '../../lib/api';

const Check = ({ done }: { done: boolean }) => (
  <span
    className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
      done ? 'bg-success text-white' : 'border border-border-strong text-muted'
    }`}
    aria-hidden
  >
    {done ? '✓' : ''}
  </span>
);

interface Props {
  agreement: TrainerAgreement;
  /** The rest of the platform is closed until this is submitted. */
  holdsPlatform: boolean;
  onSubmitted: (updated: TrainerAgreement) => void | Promise<void>;
}

/** The last step: sends the saved details and the saved signed copy to Prophyion together. */
export function SubmitApplicationCard({ agreement, holdsPlatform, onSubmitted }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = agreement.copy_uploaded;
  const isApplication = agreement.purpose === 'application';

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.trainerAgreements.submit();
      await onSubmitted(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-surface border border-border rounded-xl shadow-sm p-6">
      <div className="text-sm font-bold text-brand mb-3">
        {isApplication ? 'Submit your application' : 'Submit your signed agreement'}
      </div>

      <ul className="space-y-1.5 text-xs text-ink mb-4">
        <li className="flex items-center gap-2">
          <Check done /> Your details are saved
        </li>
        <li className="flex items-center gap-2">
          <Check done={ready} /> {ready ? 'Signed copy saved' : 'Signed copy not uploaded yet'}
        </li>
      </ul>

      <label
        className={`flex items-start gap-2 text-xs ${ready ? 'text-ink cursor-pointer' : 'text-muted'}`}
      >
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!ready}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I have read and signed the Prophyion Consultant Agreement, reference{' '}
          <span className="font-mono">{agreement.reference}</span>.
        </span>
      </label>

      {error && (
        <div className="mt-4 border-l-4 border-danger bg-danger/10 p-3 rounded-md text-sm text-danger">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready || !confirmed || submitting}
        className="military-button mt-4 px-6 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting
          ? 'Submitting…'
          : isApplication
            ? 'Submit application'
            : 'Submit signed agreement'}
      </button>

      <p className="text-xs text-muted mt-3">
        {holdsPlatform
          ? 'Your details and signed copy are saved, so you can leave and come back. Nothing reaches Prophyion, and the rest of the platform stays closed, until you submit.'
          : 'Nothing reaches Prophyion until you submit.'}
      </p>
    </section>
  );
}
