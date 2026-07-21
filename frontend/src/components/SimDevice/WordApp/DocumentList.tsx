import { StatusChip } from './StatusChip';
import { WordIcon } from './Icons';
import type { DraftDocument, WordAppVariant } from './types';

function formatModified(date: string): string {
  const value = new Date(date);
  const today = new Date();
  if (value.toDateString() === today.toDateString()) {
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return value.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function DocumentList({
  variant,
  documents,
  loading,
  error,
  creating,
  currentUserId,
  onCreate,
  onOpen,
  onBack,
}: {
  variant: WordAppVariant;
  documents: DraftDocument[];
  loading: boolean;
  error: string | null;
  creating: boolean;
  currentUserId: string | undefined;
  onCreate: () => void;
  onOpen: (document: DraftDocument) => void;
  onBack: () => void;
}) {
  const teamName = documents.find((document) => document.team_name)?.team_name;

  if (variant === 'mobile') {
    return (
      <div className="docs-app docs-mobile-list">
        <header className="docs-mobile-list-bar">
          <button className="docs-icon-button docs-on-blue" onClick={onBack} aria-label="Back home">
            <WordIcon name="arrow-left" />
          </button>
          <div>
            <div className="docs-mobile-list-title">Docs</div>
            <div className="docs-mobile-list-subtitle">
              {teamName ? `${teamName} team` : 'My documents'}
            </div>
          </div>
          <button
            className="docs-icon-button docs-on-blue"
            onClick={onCreate}
            disabled={creating}
            aria-label="New document"
          >
            <WordIcon name="plus" />
          </button>
        </header>

        <DocumentRows
          documents={documents}
          loading={loading}
          error={error}
          currentUserId={currentUserId}
          onOpen={onOpen}
          mobile
        />

        <button
          className="docs-mobile-fab"
          onClick={onCreate}
          disabled={creating}
          aria-label="Create new document"
        >
          <WordIcon name="plus" size={24} />
        </button>
      </div>
    );
  }

  return (
    <div className="docs-app docs-desktop-start">
      <aside className="docs-start-sidebar">
        <div className="docs-start-brand">
          <span className="docs-word-mark">W</span>
          <div>
            <strong>Docs</strong>
            <span>Team document editor</span>
          </div>
        </div>
        <button className="docs-start-new" onClick={onCreate} disabled={creating}>
          <WordIcon name="plus" />
          <span>{creating ? 'Creating…' : 'New document'}</span>
        </button>
        <div className="docs-start-sidebar-note">
          Documents autosave and remain available when you switch to the simulated phone.
        </div>
      </aside>
      <main className="docs-start-main">
        <div className="docs-start-heading">
          <div>
            <h1>Recent</h1>
            <p>{teamName ? `Shared with ${teamName}` : 'Your private documents'}</p>
          </div>
          <span>
            {documents.length} document{documents.length === 1 ? '' : 's'}
          </span>
        </div>
        <DocumentRows
          documents={documents}
          loading={loading}
          error={error}
          currentUserId={currentUserId}
          onOpen={onOpen}
        />
      </main>
    </div>
  );
}

function DocumentRows({
  documents,
  loading,
  error,
  currentUserId,
  onOpen,
  mobile = false,
}: {
  documents: DraftDocument[];
  loading: boolean;
  error: string | null;
  currentUserId: string | undefined;
  onOpen: (document: DraftDocument) => void;
  mobile?: boolean;
}) {
  if (loading) {
    return (
      <div className="docs-list-state">
        <div className="docs-loading-ring" />
        <p>Loading documents…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="docs-list-state docs-list-error">
        <WordIcon name="document" size={38} />
        <strong>Documents could not be loaded</strong>
        <p>{error}</p>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="docs-list-state">
        <div className="docs-empty-document">
          <WordIcon name="document" size={38} />
        </div>
        <strong>No documents yet</strong>
        <p>New team drafts will appear here and stay available across phone and desktop.</p>
      </div>
    );
  }

  return (
    <div className={mobile ? 'docs-mobile-rows' : 'docs-desktop-rows'}>
      {documents.map((document) => {
        const mine = document.author_id === currentUserId;
        return (
          <button key={document.id} className="docs-document-row" onClick={() => onOpen(document)}>
            <span className="docs-document-icon">
              <span>W</span>
            </span>
            <span className="docs-document-copy">
              <span className="docs-document-title">{document.title}</span>
              <span className="docs-document-meta">
                Modified {formatModified(document.updated_at)}
                {' · '}
                {mine ? 'You' : document.author_name}
                {document.team_name ? ` · ${document.team_name}` : ''}
              </span>
              {document.review_note && document.status === 'changes_requested' && (
                <span className="docs-document-note">{document.review_note}</span>
              )}
            </span>
            <StatusChip status={document.status} compact />
            <WordIcon name="chevron-right" size={15} className="docs-row-chevron" />
          </button>
        );
      })}
    </div>
  );
}
