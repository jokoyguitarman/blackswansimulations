-- Migration 195: Team-shared player documents for the social-crisis Docs app.
--
-- Documents are author-edited and team-readable. Review is optional: approval
-- is a training signal, not a technical publishing gate. Both rich HTML and
-- plain text are stored so the editor can preserve formatting while grading
-- and clipboard handoff use a deterministic text representation.
BEGIN;

CREATE TABLE IF NOT EXISTS player_drafts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  team_name TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled document',
  content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved', 'changes_requested')),
  submitted_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  last_grade JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_drafts_session
  ON player_drafts(session_id, team_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_drafts_author
  ON player_drafts(session_id, author_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_player_drafts_updated_at ON player_drafts;
CREATE TRIGGER trg_player_drafts_updated_at
  BEFORE UPDATE ON player_drafts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The application server uses a service-role client and performs the richer
-- team/trainer authorization in code. These policies keep direct Supabase
-- access author-only as a conservative defence-in-depth baseline.
ALTER TABLE player_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authors can view their own drafts" ON player_drafts;
CREATE POLICY "Authors can view their own drafts"
  ON player_drafts FOR SELECT
  USING (auth.uid() = author_id);

DROP POLICY IF EXISTS "Authors can create their own drafts" ON player_drafts;
CREATE POLICY "Authors can create their own drafts"
  ON player_drafts FOR INSERT
  WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "Authors can update their own drafts" ON player_drafts;
CREATE POLICY "Authors can update their own drafts"
  ON player_drafts FOR UPDATE
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "Authors can delete their own drafts" ON player_drafts;
CREATE POLICY "Authors can delete their own drafts"
  ON player_drafts FOR DELETE
  USING (auth.uid() = author_id);

COMMIT;
