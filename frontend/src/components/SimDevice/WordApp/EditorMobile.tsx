import { useState } from 'react';
import type { ReactNode } from 'react';
import { EditorContent } from '@tiptap/react';
import { EditorPanel } from './EditorPanel';
import { ReviewDialog } from './ReviewDialog';
import { StatusChip, STATUS_LABEL } from './StatusChip';
import { WordIcon } from './Icons';
import { useEditorCore, type DocumentStyleName } from './useEditorCore';
import type { WordEditorProps } from './EditorProps';

type MobileSheet = 'actions' | 'styles' | 'editor' | null;

export function EditorMobile(props: WordEditorProps) {
  const {
    document,
    currentUserId,
    isStaff,
    saveState,
    grading,
    submitting,
    reviewing,
    deleting,
    onBack,
    onTitleChange,
    onContentChange,
    onCopy,
    onSubmit,
    onReview,
    onGrade,
    onDelete,
  } = props;
  const isAuthor = document.author_id === currentUserId;
  const canReview = !isAuthor && document.status === 'in_review';
  const canDelete = isAuthor || isStaff;
  const [sheet, setSheet] = useState<MobileSheet>(null);
  const [showReview, setShowReview] = useState(false);
  const { editor, applyStyle, activeStyle } = useEditorCore({
    content: document.content_html,
    editable: isAuthor,
    onChange: onContentChange,
  });

  const copyText = () => {
    onCopy(editor?.getText() || document.content_text);
    setSheet(null);
  };

  const runReview = (verdict: 'approve' | 'request_changes', note?: string) => {
    onReview(verdict, note);
    setShowReview(false);
  };

  return (
    <div className="docs-app docs-mobile-editor">
      <header className="docs-mobile-editor-bar">
        <button className="docs-icon-button docs-on-blue" onClick={onBack} aria-label="Back">
          <WordIcon name="arrow-left" />
        </button>
        {isAuthor ? (
          <input
            className="docs-mobile-title-input"
            value={document.title}
            onChange={(event) => onTitleChange(event.target.value)}
            aria-label="Document title"
          />
        ) : (
          <div className="docs-mobile-title-readonly">{document.title}</div>
        )}
        {isAuthor && (
          <div className={`docs-save-indicator docs-save-${saveState}`}>
            <WordIcon name="cloud-check" size={15} />
            <span>
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Retry' : 'Saved'}
            </span>
          </div>
        )}
        <button
          className="docs-icon-button docs-on-blue"
          onClick={() => setSheet('actions')}
          aria-label="Document actions"
        >
          <WordIcon name="more" />
        </button>
      </header>

      {document.status !== 'draft' && (
        <div className={`docs-mobile-status-banner docs-banner-${document.status}`}>
          <StatusChip status={document.status} compact />
          <span>
            {document.status === 'in_review' && 'Waiting for a teammate'}
            {document.status === 'approved' &&
              `Reviewed${document.reviewed_by_name ? ` by ${document.reviewed_by_name}` : ''}`}
            {document.status === 'changes_requested' &&
              (document.review_note || 'A teammate requested changes')}
          </span>
        </div>
      )}

      {!isAuthor && (
        <div className="docs-readonly-notice">
          <WordIcon name="review" size={15} />
          Read-only team document by {document.author_name}
        </div>
      )}

      <div className="docs-mobile-paper">
        <EditorContent editor={editor} />
      </div>

      {isAuthor ? (
        <div className="docs-mobile-format-bar">
          <MobileFormatButton
            label="Undo"
            active={false}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <WordIcon name="undo" />
          </MobileFormatButton>
          <MobileFormatButton
            label="Redo"
            active={false}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <WordIcon name="redo" />
          </MobileFormatButton>
          <span className="docs-toolbar-divider" />
          <MobileFormatButton
            label="Bold"
            active={Boolean(editor?.isActive('bold'))}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </MobileFormatButton>
          <MobileFormatButton
            label="Italic"
            active={Boolean(editor?.isActive('italic'))}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <em>I</em>
          </MobileFormatButton>
          <MobileFormatButton
            label="Underline"
            active={Boolean(editor?.isActive('underline'))}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >
            <u>U</u>
          </MobileFormatButton>
          <span className="docs-toolbar-divider" />
          <MobileFormatButton
            label="Bulleted list"
            active={Boolean(editor?.isActive('bulletList'))}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <WordIcon name="list-bulleted" />
          </MobileFormatButton>
          <MobileFormatButton
            label="Numbered list"
            active={Boolean(editor?.isActive('orderedList'))}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <WordIcon name="list-numbered" />
          </MobileFormatButton>
          <MobileFormatButton
            label="Styles"
            active={activeStyle !== 'normal'}
            onClick={() => setSheet('styles')}
          >
            <span>Aa</span>
          </MobileFormatButton>
          <MobileFormatButton
            label="Editor"
            active={sheet === 'editor'}
            onClick={() => setSheet('editor')}
          >
            <WordIcon name="sparkle" />
          </MobileFormatButton>
        </div>
      ) : (
        <div className="docs-mobile-readonly-actions">
          <button className="docs-secondary-button" onClick={copyText}>
            <WordIcon name="copy" />
            Copy text
          </button>
          {canReview && (
            <button className="docs-primary-button" onClick={() => setShowReview(true)}>
              <WordIcon name="review" />
              Review
            </button>
          )}
        </div>
      )}

      {sheet && (
        <div className="docs-sheet-backdrop" onMouseDown={() => setSheet(null)}>
          <div className="docs-mobile-sheet" onMouseDown={(event) => event.stopPropagation()}>
            {sheet === 'editor' && (
              <EditorPanel
                mode="sheet"
                grade={document.last_grade}
                grading={grading}
                onGrade={onGrade}
                onClose={() => setSheet(null)}
              />
            )}

            {sheet === 'styles' && (
              <>
                <div className="docs-sheet-handle" />
                <div className="docs-mobile-sheet-head">
                  <div>
                    <span>Formatting</span>
                    <h2>Styles</h2>
                  </div>
                  <button className="docs-icon-button" onClick={() => setSheet(null)}>
                    <WordIcon name="x" />
                  </button>
                </div>
                <div className="docs-mobile-styles">
                  {(
                    [
                      ['normal', 'Normal', 'Body text'],
                      ['heading1', 'Heading 1', 'Major section'],
                      ['heading2', 'Heading 2', 'Subsection'],
                      ['title', 'Title', 'Document title'],
                    ] as Array<[DocumentStyleName, string, string]>
                  ).map(([style, label, description]) => (
                    <button
                      key={style}
                      className={`docs-mobile-style-option docs-style-${style}${
                        activeStyle === style ? ' active' : ''
                      }`}
                      onClick={() => {
                        applyStyle(style);
                        setSheet(null);
                      }}
                    >
                      <span>{label}</span>
                      <small>{description}</small>
                    </button>
                  ))}
                </div>
              </>
            )}

            {sheet === 'actions' && (
              <>
                <div className="docs-sheet-handle" />
                <div className="docs-mobile-sheet-head">
                  <div>
                    <span>{STATUS_LABEL[document.status]}</span>
                    <h2>Document actions</h2>
                  </div>
                  <button className="docs-icon-button" onClick={() => setSheet(null)}>
                    <WordIcon name="x" />
                  </button>
                </div>
                <div className="docs-action-list">
                  <button onClick={copyText}>
                    <WordIcon name="copy" />
                    <span>
                      <strong>Copy text</strong>
                      <small>Paste it into Social or Mail</small>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setSheet('editor');
                    }}
                  >
                    <WordIcon name="sparkle" />
                    <span>
                      <strong>Open Editor</strong>
                      <small>AI writing and role-fit feedback</small>
                    </span>
                  </button>
                  {isAuthor && document.status !== 'in_review' && (
                    <button
                      onClick={() => {
                        onSubmit();
                        setSheet(null);
                      }}
                      disabled={submitting || !document.content_text.trim()}
                    >
                      <WordIcon name="send" />
                      <span>
                        <strong>{submitting ? 'Submitting…' : 'Submit for review'}</strong>
                        <small>Optional team approval</small>
                      </span>
                    </button>
                  )}
                  {canReview && (
                    <button
                      onClick={() => {
                        setSheet(null);
                        setShowReview(true);
                      }}
                    >
                      <WordIcon name="review" />
                      <span>
                        <strong>Review document</strong>
                        <small>Approve or request changes</small>
                      </span>
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="docs-action-danger"
                      onClick={() => {
                        setSheet(null);
                        onDelete();
                      }}
                      disabled={deleting}
                    >
                      <WordIcon name="trash" />
                      <span>
                        <strong>{deleting ? 'Deleting…' : 'Delete document'}</strong>
                        <small>This cannot be undone</small>
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showReview && (
        <ReviewDialog
          document={document}
          busy={reviewing}
          onClose={() => setShowReview(false)}
          onReview={runReview}
        />
      )}
    </div>
  );
}

function MobileFormatButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`docs-format-button${active ? ' active' : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
