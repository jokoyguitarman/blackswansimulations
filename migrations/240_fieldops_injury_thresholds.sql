-- Migration 240: field-ops injury and damage thresholds (WS6, docs/field-ops/07-device-and-physics.md section 5.8)
--
-- Published criteria that turn calculated overpressure and fragment energy into named bands.
-- The keys are a closed list; the values are transcribed from the sources in source_ref.
--
-- SECURITY: service-role only; RLS enabled with no policy.
--
-- Rollback (only after the code that reads it is switched off):
--   DROP TABLE IF EXISTS fieldops_injury_thresholds;

CREATE TABLE IF NOT EXISTS fieldops_injury_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threshold_key TEXT NOT NULL UNIQUE CHECK (threshold_key IN (
    'lethal_onset', 'serious_injury_onset', 'minor_injury_onset', 'glass_injury',
    'glass_breakage', 'structural_light', 'structural_moderate', 'structural_severe', 'fragment_hazard'
  )),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('injury', 'damage', 'fragment')),
  band TEXT NOT NULL CHECK (band IN ('lethal', 'serious', 'minor', 'structural', 'fragment')),
  -- effective_overpressure_kpa: the maximum of Ps, Ps + q and Pr for the person's position (DC13; amended 22 Nov 2026)
  metric TEXT NOT NULL CHECK (metric IN ('effective_overpressure_kpa', 'peak_overpressure_kpa', 'kinetic_energy_j')),
  value NUMERIC(12, 4) NOT NULL CHECK (value > 0 AND value < 100000),
  applies_to TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'glazed_only')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 3 AND 120),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'reviewed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_fieldops_injury_thresholds_shape CHECK (
    (effect_class = 'injury' AND threshold_key IN ('lethal_onset', 'serious_injury_onset', 'minor_injury_onset')
      AND metric = 'effective_overpressure_kpa')
    OR (effect_class = 'injury' AND threshold_key = 'glass_injury' AND metric = 'peak_overpressure_kpa')
    OR (effect_class = 'damage' AND band = 'structural' AND metric = 'peak_overpressure_kpa')
    OR (effect_class = 'fragment' AND band = 'fragment' AND metric = 'kinetic_energy_j')
  ),
  CONSTRAINT ck_fieldops_injury_thresholds_key_band CHECK (
    (threshold_key = 'lethal_onset' AND band = 'lethal')
    OR (threshold_key = 'serious_injury_onset' AND band = 'serious')
    OR (threshold_key IN ('minor_injury_onset', 'glass_injury') AND band = 'minor')
    OR (threshold_key IN ('glass_breakage', 'structural_light', 'structural_moderate', 'structural_severe')
        AND band = 'structural')
    OR (threshold_key = 'fragment_hazard' AND band = 'fragment')
  )
);

DROP TRIGGER IF EXISTS trg_fieldops_injury_thresholds_updated_at ON fieldops_injury_thresholds;
CREATE TRIGGER trg_fieldops_injury_thresholds_updated_at
  BEFORE UPDATE ON fieldops_injury_thresholds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE fieldops_injury_thresholds ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fieldops_injury_thresholds IS
  'WS6 library: published injury, damage and fragment-hazard criteria; one active row per key. Service role only.';
COMMENT ON COLUMN fieldops_injury_thresholds.applies_to IS
  'glazed_only: used only where the confinement is listed in environment.json glazed_confinements.';
