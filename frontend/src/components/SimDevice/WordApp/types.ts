export type DraftStatus = 'draft' | 'in_review' | 'approved' | 'changes_requested';

export interface ContentGrade {
  format?: string;
  accuracy?: number;
  tone?: number;
  cultural_sensitivity?: number;
  persuasiveness?: number;
  completeness?: number;
  clarity?: number;
  overall?: number;
  role_fit?: number;
  graded_as_team?: string;
  feedback?: string;
  strengths?: string[];
  improvements?: string[];
  signals?: Record<string, boolean>;
}

export interface DraftDocument {
  id: string;
  session_id: string;
  author_id: string;
  author_name: string;
  team_name: string | null;
  title: string;
  content_html: string;
  content_text: string;
  status: DraftStatus;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  last_grade: ContentGrade | null;
  created_at: string;
  updated_at: string;
}

export type WordAppVariant = 'mobile' | 'desktop';
export type SaveState = 'saved' | 'saving' | 'error';
export type RibbonTab = 'home' | 'review';
