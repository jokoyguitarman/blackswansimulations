import { useRef, useState } from 'react';
import type { TrainerAgreement } from '@shared/trainerAgreements';
import { api } from '../../lib/api';
import { openInNewTab } from '../../lib/openInNewTab';

const MAX_BYTES = 10 * 1024 * 1024;

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

interface Props {
  agreement: TrainerAgreement;
  /** The signed copy was saved (this does not submit the application). */
  onSaved: (updated: TrainerAgreement) => void;
}

/**
 * Saves the signed agreement as soon as a file is chosen, so it is kept if the applicant leaves
 * and comes back. Sending the application is a separate step (SubmitApplicationCard).
 */
export function SignedUploadCard({ agreement, onSaved }: Props) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (candidate: File | undefined) => {
    setError(null);
    if (!candidate) return;
    const isPdf =
      candidate.type === 'application/pdf' || candidate.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setError('Please choose a PDF file.');
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setError('The file is larger than 10 MB. Please upload a smaller PDF.');
      return;
    }
    setUploading(true);
    try {
      const res = await api.trainerAgreements.uploadSigned(candidate);
      onSaved(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const view = () =>
    openInNewTab(async () => (await api.trainerAgreements.mySignedUrl()).data.url).catch(
      (err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not open the file. Please try again.'),
    );

  const buttonClass =
    'px-3 py-1.5 text-xs font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all disabled:opacity-50';

  return (
    <section className="bg-surface border border-border rounded-xl shadow-sm p-6">
      <div className="text-sm font-bold text-brand mb-1">Sign and upload</div>
      <p className="text-xs text-muted mb-4">
        Upload the signed agreement as one PDF, up to 10 MB. It is saved as soon as you choose it,
        and you send your application in the next step.
      </p>

      {agreement.copy_uploaded ? (
        <div className="rounded-lg border border-success/40 bg-success/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink">Signed copy saved</div>
            <div className="text-[11px] text-muted mt-0.5">
              {agreement.copy_uploaded_at && `Uploaded ${formatWhen(agreement.copy_uploaded_at)}`}
              {agreement.copy_pages !== null &&
                ` · ${agreement.copy_pages} page${agreement.copy_pages === 1 ? '' : 's'}`}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void view()} className={buttonClass}>
              View
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className={buttonClass}
            >
              {uploading ? 'Uploading…' : 'Replace'}
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files?.[0]);
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/5' : 'border-border-strong'
          }`}
        >
          {uploading ? (
            <p className="text-sm text-ink animate-pulse">Uploading…</p>
          ) : (
            <>
              <p className="text-sm text-ink">Drag the signed PDF here, or</p>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-2 px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
              >
                Choose file
              </button>
            </>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => void upload(e.target.files?.[0])}
      />

      {error && (
        <div className="mt-4 border-l-4 border-danger bg-danger/10 p-3 rounded-md text-sm text-danger">
          {error}
        </div>
      )}
    </section>
  );
}
