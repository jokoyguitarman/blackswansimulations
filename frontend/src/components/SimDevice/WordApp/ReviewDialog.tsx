import { useState } from 'react';
import { WordIcon } from './Icons';
import type { DraftDocument } from './types';

export function ReviewDialog({
  document,
  busy,
  onClose,
  onReview,
}: {
  document: DraftDocument;
  busy: boolean;
  onClose: () => void;
  onReview: (verdict: 'approve' | 'request_changes', note?: string) => void;
}) {
  const [note, setNote] = useState('');

  return (
    <div className="docs-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="docs-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docs-review-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Team review</span>
            <h2 id="docs-review-title">{document.title}</h2>
          </div>
          <button className="docs-icon-button" onClick={onClose} aria-label="Close review">
            <WordIcon name="x" />
          </button>
        </header>

        <div className="docs-review-meta">
          Submitted by {document.author_name}
          {document.team_name ? ` · ${document.team_name}` : ''}
        </div>

        <div
          className="docs-review-preview docs-prosemirror"
          dangerouslySetInnerHTML={{ __html: document.content_html || '<p>No content</p>' }}
        />

        <label className="docs-review-note">
          <span>Review note (optional)</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={2000}
            placeholder="Explain what is approved or what needs to change…"
          />
        </label>

        <footer>
          <button
            className="docs-secondary-button docs-request-button"
            onClick={() => onReview('request_changes', note.trim() || undefined)}
            disabled={busy}
          >
            Request changes
          </button>
          <button
            className="docs-primary-button docs-approve-button"
            onClick={() => onReview('approve', note.trim() || undefined)}
            disabled={busy}
          >
            <WordIcon name="check" />
            {busy ? 'Saving…' : 'Approve'}
          </button>
        </footer>
      </div>
    </div>
  );
}
