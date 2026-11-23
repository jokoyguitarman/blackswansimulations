-- Migration 239: field-ops explosive materials (WS6, docs/field-ops/07-device-and-physics.md section 5.8)
--
-- A closed pick-list of named materials. Each carries the published TNT-equivalence factors
-- for pressure and impulse, used only to scale effects. Labels are names only.
--
-- SECURITY: service-role only; RLS enabled with no policy.
--
-- Rollback (only after the code that reads it is switched off):
--   ALTER TABLE IF EXISTS fieldops_device_presets DROP CONSTRAINT IF EXISTS fk_fieldops_device_presets_material;
--   DROP TABLE IF EXISTS fieldops_explosive_materials;

CREATE TABLE IF NOT EXISTS fieldops_explosive_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_key TEXT NOT NULL UNIQUE CHECK (material_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  aliases TEXT[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(aliases) <= 20),
  tnt_eq_pressure NUMERIC(5, 3) NOT NULL CHECK (tnt_eq_pressure >= 0.1 AND tnt_eq_pressure <= 2.5),
  tnt_eq_impulse NUMERIC(5, 3) NOT NULL CHECK (tnt_eq_impulse >= 0.1 AND tnt_eq_impulse <= 2.5),
  -- high, medium or low: low adds the note low_confidence_factor to estimates (amended 22 Nov 2026,
  -- before the migration is applied; the Gurney velocity column was removed, DC12)
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  is_unknown_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 10000),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'reviewed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active row is the default for an unknown material.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fieldops_explosive_materials_unknown
  ON fieldops_explosive_materials (is_unknown_default)
  WHERE is_unknown_default AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_fieldops_explosive_materials_order
  ON fieldops_explosive_materials (status, sort_order);

DROP TRIGGER IF EXISTS trg_fieldops_explosive_materials_updated_at ON fieldops_explosive_materials;
CREATE TRIGGER trg_fieldops_explosive_materials_updated_at
  BEFORE UPDATE ON fieldops_explosive_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE fieldops_explosive_materials ENABLE ROW LEVEL SECURITY;

-- Presets reference a material by key. NOT VALID so rows written before this migration are not
-- re-checked; new and updated rows are.
DO $$
BEGIN
  IF to_regclass('public.fieldops_device_presets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fieldops_device_presets_material') THEN
    ALTER TABLE fieldops_device_presets
      ADD CONSTRAINT fk_fieldops_device_presets_material
      FOREIGN KEY (charge_material_key) REFERENCES fieldops_explosive_materials (material_key)
      ON UPDATE CASCADE ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

COMMENT ON TABLE fieldops_explosive_materials IS
  'WS6 library: named materials with published TNT-equivalence factors, used only to scale effects. Service role only.';
COMMENT ON COLUMN fieldops_explosive_materials.aliases IS
  'Lower-case words a document may use for this material; matched whole-word by deviceSpecFromHint.';
