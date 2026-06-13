-- Migration 188: Protagonist / Antagonist org page roles
-- Adds a role (protagonist = player-assignable, antagonist = trainer/AI-driven rival)
-- and a control_mode to each org page. Backfills existing rows as protagonist/player.

BEGIN;

ALTER TABLE sim_org_pages
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'protagonist'
    CHECK (role IN ('protagonist', 'antagonist'));

ALTER TABLE sim_org_pages
  ADD COLUMN IF NOT EXISTS control_mode TEXT NOT NULL DEFAULT 'player'
    CHECK (control_mode IN ('player', 'ai', 'trainer'));

-- Existing pages were all protagonist crisis/ally pages controlled by players.
UPDATE sim_org_pages SET role = 'protagonist' WHERE role IS NULL;
UPDATE sim_org_pages SET control_mode = 'player' WHERE control_mode IS NULL;

CREATE INDEX IF NOT EXISTS idx_sim_org_pages_role ON sim_org_pages(session_id, role);

COMMIT;
