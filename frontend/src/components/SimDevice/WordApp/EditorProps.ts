import type { DraftDocument, SaveState } from './types';

export interface WordEditorProps {
  document: DraftDocument;
  currentUserId: string | undefined;
  isStaff: boolean;
  saveState: SaveState;
  grading: boolean;
  submitting: boolean;
  reviewing: boolean;
  deleting: boolean;
  onBack: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (html: string) => void;
  onCopy: (text: string) => void;
  onSubmit: () => void;
  onReview: (verdict: 'approve' | 'request_changes', note?: string) => void;
  onGrade: () => void;
  onDelete: () => void;
}
