-- Migration 160: War Room wizard draft persistence
-- Stores multi-step wizard outputs so later steps can reuse prior research/doctrines
-- without re-researching, and so trainers can resume a draft.

CREATE TABLE IF NOT EXISTS warroom_wizard_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_step INT NOT NULL DEFAULT 1,
  -- Initial user inputs (prompt or structured selections, teams, toggles)
  input JSONB DEFAULT '{}'::jsonb,
  -- Step outputs
  geo_result JSONB DEFAULT NULL,
  geocode_result JSONB DEFAULT NULL,
  osm_vicinity JSONB DEFAULT NULL,
  area_dossier TEXT DEFAULT NULL,
  research_archive JSONB DEFAULT NULL,
  phase1_preview JSONB DEFAULT NULL,
  doctrines JSONB DEFAULT NULL,
  validated_doctrines JSONB DEFAULT NULL,
  pins_draft JSONB DEFAULT NULL,
  deterioration_preview JSONB DEFAULT NULL,
  scenario_id UUID REFERENCES scenarios(id) ON DELETE SET NULL,
  error TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warroom_wizard_drafts_created_by
  ON warroom_wizard_drafts(created_by);

CREATE INDEX IF NOT EXISTS idx_warroom_wizard_drafts_status
  ON warroom_wizard_drafts(status);

CREATE INDEX IF NOT EXISTS idx_warroom_wizard_drafts_updated_at
  ON warroom_wizard_drafts(updated_at DESC);

-- Keep updated_at fresh
CREATE OR REPLACE FUNCTION set_warroom_wizard_drafts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_warroom_wizard_drafts_updated_at ON warroom_wizard_drafts;
CREATE TRIGGER trg_warroom_wizard_drafts_updated_at
BEFORE UPDATE ON warroom_wizard_drafts
FOR EACH ROW EXECUTE PROCEDURE set_warroom_wizard_drafts_updated_at();

