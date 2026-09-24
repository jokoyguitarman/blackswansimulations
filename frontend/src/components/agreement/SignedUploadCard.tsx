import { useRef, useState } from 'react';
import type { TrainerAgreement } from '@shared/trainerAgreements';
import { api } from '../../lib/api';

const MAX_BYTES = 10 * 1024 * 1024;

interface Props {
  agreement: TrainerAgreement;
  onUploaded: (updated: TrainerAgreement) => void;
}

export function SignedUploadCard({ agreement, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (candidate: File | undefined) => {
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
    setFile(candidate);
  };

  const clearFile = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !confirmed) return;
    setUploading(true);
    setError(null);
    try {
      const res = await api.trainerAgreements.uploadSigned(file);
      onUploaded(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface border border-border rounded-xl shadow-sm p-6"
    >
      <div className="text-sm font-bold text-brand mb-1">Sign and upload</div>
      <p className="text-xs text-muted mb-4">
        Upload the signed agreement as one PDF, up to 10 MB.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/5' : 'border-border-strong'
        }`}
      >
        {file ? (
          <div>
            <div className="text-sm font-semibold text-ink break-all">{file.name}</div>
            <div className="text-[11px] text-muted mt-0.5">
              {(file.size / (1024 * 1024)).toFixed(1)} MB
            </div>
            <button
              type="button"
              onClick={clearFile}
              className="mt-2 text-xs font-semibold text-brand underline"
            >
              Choose a different file
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm text-ink">Drag the signed PDF here, or</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-2 px-4 py-2 text-sm font-semibold rounded-lg border border-border-strong text-brand hover:bg-surface-2 transition-all"
            >
              Choose file
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </div>

      <label className="flex items-start gap-2 mt-4 text-xs text-ink cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
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
        type="submit"
        disabled={!file || !confirmed || uploading}
        className="military-button mt-4 px-6 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {uploading
          ? 'Uploading…'
          : agreement.purpose === 'application'
            ? 'Submit application'
            : 'Submit signed agreement'}
      </button>
    </form>
  );
}
