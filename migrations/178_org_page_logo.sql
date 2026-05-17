-- Migration 178: Add logo URL to org pages
BEGIN;
ALTER TABLE sim_org_pages ADD COLUMN IF NOT EXISTS page_logo_url TEXT;
COMMIT;
