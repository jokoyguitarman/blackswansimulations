-- Migration 185: Multi-page control
-- Allows multiple org pages per session (grouped by org_key across platforms),
-- and tracks which players control which page.

BEGIN;

-- Group an org's Facebook + X rows under a shared key; mark the crisis page.
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS org_key TEXT;
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false;

-- Backfill existing single-org rows.
UPDATE sim_org_pages SET org_key = 'primary' WHERE org_key IS NULL;
UPDATE sim_org_pages SET is_primary = true WHERE org_key = 'primary';

-- Allow multiple distinct orgs per platform per session.
ALTER TABLE sim_org_pages DROP CONSTRAINT IF EXISTS sim_org_pages_session_id_platform_key;
ALTER TABLE sim_org_pages ADD CONSTRAINT sim_org_pages_session_platform_org_key UNIQUE (session_id, platform, org_key);

-- Which players control which page (org_key). Each player controls at most one page.
CREATE TABLE IF NOT EXISTS session_page_controllers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_key TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES user_profiles(id),
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_page_controllers_session ON session_page_controllers(session_id);
CREATE INDEX IF NOT EXISTS idx_session_page_controllers_org ON session_page_controllers(session_id, org_key);

COMMIT;
