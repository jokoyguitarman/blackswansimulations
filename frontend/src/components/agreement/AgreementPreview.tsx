import { useEffect, useState } from 'react';
import type { TrainerAgreement } from '@shared/trainerAgreements';
import { api } from '../../lib/api';

interface Props {
  agreement: TrainerAgreement;
  onDownloaded?: () => void;
}

/** The personalised agreement, shown inline on larger screens, with a download. */
export function AgreementPreview({ agreement, onDownloaded }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    api.trainerAgreements
      .document()
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Could not load the agreement');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agreement.id, agreement.issued_at]);

  const fileName = `Prophyion-Consultant-Agreement-${agreement.reference}.pdf`;

  return (
    <section className="bg-surface border border-border rounded-xl shadow-sm p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-bold text-brand">Review and download</div>
          <p className="text-xs text-muted mt-1">
            Your agreement is filled in with your details. Reference{' '}
            <span className="font-mono font-semibold text-ink">{agreement.reference}</span>.
          </p>
        </div>
        {url && (
          <div className="flex flex-wrap gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener"
              className="md:hidden px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
            >
              Open agreement
            </a>
            <a
              href={url}
              download={fileName}
              onClick={onDownloaded}
              className="military-button px-4 py-2 text-sm"
            >
              Download PDF
            </a>
          </div>
        )}
      </div>

      {error ? (
        <div className="border-l-4 border-danger bg-danger/10 p-4 rounded-md text-sm text-danger">
          {error}
        </div>
      ) : url ? (
        <iframe
          title="Prophyion Consultant Agreement"
          src={url}
          className="hidden md:block w-full h-[75vh] rounded-lg border border-border bg-surface-2"
        />
      ) : (
        <div className="h-24 md:h-[75vh] flex items-center justify-center rounded-lg border border-border bg-surface-2 text-xs text-muted animate-pulse">
          Preparing your agreement…
        </div>
      )}

      <div className="mt-5 rounded-lg bg-surface-2 border border-border p-4">
        <div className="text-xs font-bold text-ink mb-2">How to sign</div>
        <ol className="list-decimal pl-5 space-y-1 text-xs text-muted">
          <li>Download the PDF and check your details on the first page.</li>
          <li>
            Sign in the Authorisation section on the last page and write the date. To sign
            digitally, open the PDF in Adobe Acrobat Reader (free) and use Fill &amp; Sign.
          </li>
          <li>
            If you signed on paper, scan every page into one PDF. Your phone can do this: the Files
            or Notes app on iPhone, or Google Drive on Android.
          </li>
          <li>Upload the signed PDF below.</li>
        </ol>
      </div>
    </section>
  );
}
