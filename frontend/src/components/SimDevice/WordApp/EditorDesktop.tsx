import { useState } from 'react';
import type { ReactNode } from 'react';
import { EditorContent } from '@tiptap/react';
import { EditorPanel } from './EditorPanel';
import { ReviewDialog } from './ReviewDialog';
import { StatusChip } from './StatusChip';
import { WordIcon } from './Icons';
import { useEditorCore, type DocumentStyleName } from './useEditorCore';
import type { WordEditorProps } from './EditorProps';
import type { RibbonTab } from './types';

export function EditorDesktop(props: WordEditorProps) {
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
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('home');
  const [editorPaneOpen, setEditorPaneOpen] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const { editor, wordCount, applyStyle, activeStyle } = useEditorCore({
    content: document.content_html,
    editable: isAuthor,
    onChange: onContentChange,
  });

  const copyText = () => onCopy(editor?.getText() || document.content_text);
  const saveLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved';

  return (
    <div className="docs-app docs-desktop-editor">
      <div className="docs-desktop-titlebar">
        <div className="docs-desktop-autosave">
          <span>AutoSave</span>
          <span className={`docs-autosave-toggle${saveState === 'error' ? ' error' : ''}`}>
            <span />
          </span>
        </div>
        <div className="docs-desktop-document-name">
          {isAuthor ? (
            <input
              value={document.title}
              onChange={(event) => onTitleChange(event.target.value)}
              aria-label="Document title"
            />
          ) : (
            <span>{document.title}</span>
          )}
          <small>— {saveLabel}</small>
        </div>
        <button className="docs-titlebar-copy" onClick={copyText}>
          <WordIcon name="copy" size={15} />
          Copy text
        </button>
      </div>

      <div className="docs-ribbon-tabs">
        <button className="docs-file-tab" onClick={onBack}>
          File
        </button>
        <button
          className={ribbonTab === 'home' ? 'active' : ''}
          onClick={() => setRibbonTab('home')}
        >
          Home
        </button>
        <button
          className={ribbonTab === 'review' ? 'active' : ''}
          onClick={() => setRibbonTab('review')}
        >
          Review
        </button>
      </div>

      {ribbonTab === 'home' ? (
        <HomeRibbon
          editor={editor}
          editable={isAuthor}
          activeStyle={activeStyle}
          applyStyle={applyStyle}
          onOpenEditor={() => setEditorPaneOpen(true)}
        />
      ) : (
        <div className="docs-ribbon docs-review-ribbon">
          <RibbonGroup label="AI review">
            <button className="docs-ribbon-wide" onClick={() => setEditorPaneOpen(true)}>
              <WordIcon name="sparkle" />
              Editor
            </button>
          </RibbonGroup>
          <RibbonGroup label="Workflow">
            {isAuthor && (
              <button
                className="docs-ribbon-wide docs-ribbon-blue"
                onClick={onSubmit}
                disabled={
                  submitting || document.status === 'in_review' || !document.content_text.trim()
                }
              >
                <WordIcon name="send" />
                {submitting ? 'Submitting…' : 'Submit for review'}
              </button>
            )}
            {canReview && (
              <>
                <button
                  className="docs-ribbon-wide docs-ribbon-green"
                  onClick={() => onReview('approve')}
                  disabled={reviewing}
                >
                  <WordIcon name="check" />
                  Approve
                </button>
                <button
                  className="docs-ribbon-wide docs-ribbon-red"
                  onClick={() => setShowReview(true)}
                  disabled={reviewing}
                >
                  <WordIcon name="review" />
                  Request changes
                </button>
              </>
            )}
            <button className="docs-ribbon-wide" onClick={copyText}>
              <WordIcon name="copy" />
              Copy text
            </button>
          </RibbonGroup>
          <RibbonGroup label="Document status" className="docs-ribbon-status-group">
            <StatusChip status={document.status} />
            <span className="docs-review-summary">
              {document.status === 'draft' && 'Not submitted'}
              {document.status === 'in_review' && `Submitted by ${document.author_name}`}
              {document.status === 'approved' &&
                `Approved${document.reviewed_by_name ? ` by ${document.reviewed_by_name}` : ''}`}
              {document.status === 'changes_requested' &&
                (document.review_note || 'Changes requested')}
            </span>
          </RibbonGroup>
          {canDelete && (
            <RibbonGroup label="Document">
              <button
                className="docs-ribbon-wide docs-ribbon-red"
                onClick={onDelete}
                disabled={deleting}
              >
                <WordIcon name="trash" />
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </RibbonGroup>
          )}
        </div>
      )}

      {document.status !== 'draft' && (
        <div className={`docs-desktop-status-banner docs-banner-${document.status}`}>
          <StatusChip status={document.status} compact />
          <span>
            {document.status === 'in_review' && 'This version is awaiting teammate review.'}
            {document.status === 'approved' &&
              `Approved${document.reviewed_by_name ? ` by ${document.reviewed_by_name}` : ''}. Editing creates a new draft version.`}
            {document.status === 'changes_requested' &&
              (document.review_note || 'A teammate requested changes.')}
          </span>
        </div>
      )}

      <div className="docs-desktop-workspace">
        <main className="docs-page-canvas">
          {!isAuthor && (
            <div className="docs-desktop-readonly-notice">
              <WordIcon name="review" size={15} />
              Read-only team document by {document.author_name}
              {canReview && <button onClick={() => setShowReview(true)}>Open review</button>}
            </div>
          )}
          <div className="docs-paper">
            <EditorContent editor={editor} />
          </div>
        </main>

        {editorPaneOpen && (
          <EditorPanel
            mode="pane"
            grade={document.last_grade}
            grading={grading}
            onGrade={onGrade}
            onClose={() => setEditorPaneOpen(false)}
          />
        )}
      </div>

      <footer className="docs-desktop-statusbar">
        <span>
          Page 1 of 1 · {wordCount} word{wordCount === 1 ? '' : 's'}
        </span>
        <span>
          {document.team_name || 'Private'} · {saveLabel} · {document.status.replace('_', ' ')}
        </span>
      </footer>

      {showReview && (
        <ReviewDialog
          document={document}
          busy={reviewing}
          onClose={() => setShowReview(false)}
          onReview={(verdict, note) => {
            onReview(verdict, note);
            setShowReview(false);
          }}
        />
      )}
    </div>
  );
}

function HomeRibbon({
  editor,
  editable,
  activeStyle,
  applyStyle,
  onOpenEditor,
}: {
  editor: ReturnType<typeof useEditorCore>['editor'];
  editable: boolean;
  activeStyle: DocumentStyleName;
  applyStyle: (style: DocumentStyleName) => void;
  onOpenEditor: () => void;
}) {
  const disabled = !editable;
  return (
    <div className="docs-ribbon">
      <RibbonGroup label="Undo">
        <RibbonButton
          label="Undo"
          disabled={disabled || !editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <WordIcon name="undo" />
        </RibbonButton>
        <RibbonButton
          label="Redo"
          disabled={disabled || !editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <WordIcon name="redo" />
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup label="Font">
        <span className="docs-ribbon-select docs-font-select">
          Calibri (Body)
          <WordIcon name="chevron-down" size={12} />
        </span>
        <select
          className="docs-ribbon-select docs-size-select"
          value={String(editor?.getAttributes('textStyle').fontSize || '11px')}
          onChange={(event) => editor?.chain().focus().setFontSize(event.target.value).run()}
          disabled={disabled}
          aria-label="Font size"
        >
          <option value="11px">11</option>
          <option value="14px">14</option>
          <option value="18px">18</option>
          <option value="24px">24</option>
        </select>
        <RibbonButton
          label="Bold"
          active={Boolean(editor?.isActive('bold'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </RibbonButton>
        <RibbonButton
          label="Italic"
          active={Boolean(editor?.isActive('italic'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </RibbonButton>
        <RibbonButton
          label="Underline"
          active={Boolean(editor?.isActive('underline'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        >
          <u>U</u>
        </RibbonButton>
        <RibbonButton
          label="Strikethrough"
          active={Boolean(editor?.isActive('strike'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <s>ab</s>
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup label="Paragraph">
        <RibbonButton
          label="Bulleted list"
          active={Boolean(editor?.isActive('bulletList'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          •≡
        </RibbonButton>
        <RibbonButton
          label="Numbered list"
          active={Boolean(editor?.isActive('orderedList'))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          1≡
        </RibbonButton>
        <RibbonButton
          label="Align left"
          active={Boolean(editor?.isActive({ textAlign: 'left' }))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign('left').run()}
        >
          ≡
        </RibbonButton>
        <RibbonButton
          label="Align center"
          active={Boolean(editor?.isActive({ textAlign: 'center' }))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign('center').run()}
        >
          ≡
        </RibbonButton>
        <RibbonButton
          label="Align right"
          active={Boolean(editor?.isActive({ textAlign: 'right' }))}
          disabled={disabled}
          onClick={() => editor?.chain().focus().setTextAlign('right').run()}
        >
          ≡
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup label="Styles" className="docs-styles-group">
        {(
          [
            ['normal', 'Normal'],
            ['heading1', 'Heading 1'],
            ['heading2', 'Heading 2'],
            ['title', 'Title'],
          ] as Array<[DocumentStyleName, string]>
        ).map(([style, label]) => (
          <button
            key={style}
            className={`docs-style-card docs-style-${style}${activeStyle === style ? ' active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyStyle(style)}
            disabled={disabled}
          >
            {label}
          </button>
        ))}
      </RibbonGroup>

      <RibbonGroup label="Editor" className="docs-ribbon-last">
        <button className="docs-ribbon-wide docs-ribbon-blue" onClick={onOpenEditor}>
          <WordIcon name="sparkle" />
          Editor
        </button>
      </RibbonGroup>
    </div>
  );
}

function RibbonGroup({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`docs-ribbon-group ${className}`}>
      <div className="docs-ribbon-controls">{children}</div>
      <span className="docs-ribbon-group-label">{label}</span>
    </div>
  );
}

function RibbonButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`docs-ribbon-button${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
