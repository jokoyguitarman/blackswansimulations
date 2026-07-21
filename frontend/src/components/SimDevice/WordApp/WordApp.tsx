import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { DocumentList } from './DocumentList';
import { EditorMobile } from './EditorMobile';
import { EditorDesktop } from './EditorDesktop';
import { useDraftAutosave, useDrafts } from './useDrafts';
import type { DraftDocument, WordAppVariant } from './types';
import './word-app.css';

export function WordApp({ variant }: { variant: WordAppVariant }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const draftsApi = useDrafts(sessionId);
  const [activeDocument, setActiveDocument] = useState<DraftDocument | null>(null);
  const [creating, setCreating] = useState(false);
  const [grading, setGrading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const isStaff = user?.role === 'trainer' || user?.role === 'admin';

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2600);
  }, []);

  const { saveState, queue, flush } = useDraftAutosave(
    draftsApi.save,
    useCallback((saved) => setActiveDocument(saved), []),
  );

  // Pull teammate review/status changes into an open document while it is not
  // locally saving. The author's own saves already update activeDocument.
  useEffect(() => {
    if (!activeDocument || saveState !== 'saved') return;
    const latest = draftsApi.drafts.find((draft) => draft.id === activeDocument.id);
    if (!latest || latest.updated_at === activeDocument.updated_at) return;
    setActiveDocument(latest);
  }, [activeDocument, draftsApi.drafts, saveState]);

  const createDocument = async () => {
    setCreating(true);
    try {
      const created = await draftsApi.create();
      setActiveDocument(created);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not create document');
    } finally {
      setCreating(false);
    }
  };

  const openDocument = async (document: DraftDocument) => {
    try {
      await flush();
    } catch {
      showToast('The previous document could not be saved');
      return;
    }
    setActiveDocument(document);
  };

  const closeDocument = async () => {
    try {
      await flush();
    } catch {
      showToast('Save failed. Check your connection before leaving.');
      return;
    }
    setActiveDocument(null);
    void draftsApi.refresh();
  };

  const changeTitle = (title: string) => {
    if (!activeDocument) return;
    const safeTitle = title.slice(0, 200);
    setActiveDocument((current) => (current ? { ...current, title: safeTitle } : current));
    queue(activeDocument.id, { title: safeTitle.trim() || 'Untitled document' });
  };

  const changeContent = (contentHtml: string) => {
    if (!activeDocument) return;
    setActiveDocument((current) =>
      current
        ? {
            ...current,
            content_html: contentHtml,
            status: current.status === 'draft' ? current.status : 'draft',
            submitted_at: current.status === 'draft' ? current.submitted_at : null,
            reviewed_by: current.status === 'draft' ? current.reviewed_by : null,
            reviewed_by_name: current.status === 'draft' ? current.reviewed_by_name : null,
            reviewed_at: current.status === 'draft' ? current.reviewed_at : null,
            review_note: current.status === 'draft' ? current.review_note : null,
          }
        : current,
    );
    queue(activeDocument.id, { content_html: contentHtml });
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = window.document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      window.document.body.appendChild(area);
      area.select();
      window.document.execCommand('copy');
      area.remove();
    }
    showToast('Copied — paste it into a post or an email.');
  };

  const submitForReview = async () => {
    if (!activeDocument) return;
    setSubmitting(true);
    try {
      const flushed = await flush();
      const target = flushed || activeDocument;
      const updated = await draftsApi.submit(target.id);
      setActiveDocument(updated);
      showToast('Submitted to your team for review.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not submit document');
    } finally {
      setSubmitting(false);
    }
  };

  const reviewDocument = async (verdict: 'approve' | 'request_changes', note?: string) => {
    if (!activeDocument) return;
    setReviewing(true);
    try {
      const updated = await draftsApi.review(activeDocument.id, verdict, note);
      setActiveDocument(updated);
      showToast(verdict === 'approve' ? 'Document approved.' : 'Changes requested.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not save review');
    } finally {
      setReviewing(false);
    }
  };

  const runGrade = async () => {
    if (!activeDocument) return;
    setGrading(true);
    try {
      const flushed = await flush();
      const target = flushed || activeDocument;
      const grade = await draftsApi.grade(target.id);
      setActiveDocument((current) => (current ? { ...current, last_grade: grade } : current));
      showToast('Editor review complete.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Editor could not grade this document');
    } finally {
      setGrading(false);
    }
  };

  const removeDocument = async () => {
    if (!activeDocument) return;
    const confirmed = window.confirm(`Delete “${activeDocument.title}”? This cannot be undone.`);
    if (!confirmed) return;
    setDeleting(true);
    try {
      await draftsApi.remove(activeDocument.id);
      setActiveDocument(null);
      showToast('Document deleted.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete document');
    } finally {
      setDeleting(false);
    }
  };

  const editorProps = activeDocument
    ? {
        document: activeDocument,
        currentUserId: user?.id,
        isStaff,
        saveState,
        grading,
        submitting,
        reviewing,
        deleting,
        onBack: closeDocument,
        onTitleChange: changeTitle,
        onContentChange: changeContent,
        onCopy: copyText,
        onSubmit: submitForReview,
        onReview: reviewDocument,
        onGrade: runGrade,
        onDelete: removeDocument,
      }
    : null;

  return (
    <>
      {editorProps ? (
        variant === 'mobile' ? (
          <EditorMobile {...editorProps} />
        ) : (
          <EditorDesktop {...editorProps} />
        )
      ) : (
        <DocumentList
          variant={variant}
          documents={draftsApi.drafts}
          loading={draftsApi.loading}
          error={draftsApi.error}
          creating={creating}
          currentUserId={user?.id}
          onCreate={createDocument}
          onOpen={openDocument}
          onBack={() => navigate(`/sim/${sessionId}/device/home`)}
        />
      )}

      {toast && <div className="docs-toast">{toast}</div>}
    </>
  );
}

export function WordAppMobile() {
  return <WordApp variant="mobile" />;
}

export function WordAppDesktop() {
  return <WordApp variant="desktop" />;
}
