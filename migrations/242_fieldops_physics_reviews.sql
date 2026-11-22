-- Migration 242: field-ops physics reviews and library changes (WS6, docs/field-ops/07-device-and-physics.md section 5.8)
--
-- The D22 review record: who reviewed which model and dataset version, against which checklist,
-- with which oracle results and library contents, and the decision. Also an append-only log of
-- every admin change to the library tables.
--
-- SECURITY: service-role only; RLS enabled with no policy on both tables.
--
-- Rollback (only after the code that reads them is switched off):
--   DROP TABLE IF EXISTS fieldops_physics_library_changes;
--   DROP TABLE IF EXISTS fieldops_physics_reviews;

CREATE TABLE IF NOT EXISTS fieldops_physics_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 40),
  dataset_version TEXT NOT NULL CHECK (dataset_version ~ '^[0-9a-f]{16}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected', 'revoked')),
  reviewer_name TEXT NOT NULL CHECK (char_length(reviewer_name) BETWEEN 2 AND 120),
  reviewer_qualification TEXT NOT NULL CHECK (char_length(reviewer_qualification) BETWEEN 10 AND 500),
  reviewer_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  recorded_by UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'object'),
  oracle_report JSONB NOT NULL CHECK (jsonb_typeof(oracle_report) = 'object'),
  library_snapshot JSONB NOT NULL CHECK (jsonb_typeof(library_snapshot) = 'object'),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 4000),
  supersedes UUID REFERENCES fieldops_physics_reviews(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fieldops_physics_reviews_versions
  ON fieldops_physics_reviews (model_version, dataset_version, created_at DESC);

ALTER TABLE fieldops_physics_reviews ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS fieldops_physics_library_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL CHECK (table_name IN (
    'fieldops_device_presets', 'fieldops_explosive_materials', 'fieldops_injury_thresholds'
  )),
  row_key TEXT NOT NULL CHECK (char_length(row_key) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('seed', 'create', 'update', 'retire')),
  before_row JSONB,
  after_row JSONB,
  dataset_version_before TEXT CHECK (dataset_version_before IS NULL OR dataset_version_before ~ '^[0-9a-f]{16}$'),
  dataset_version_after TEXT CHECK (dataset_version_after IS NULL OR dataset_version_after ~ '^[0-9a-f]{16}$'),
  actor_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fieldops_physics_library_changes_row
  ON fieldops_physics_library_changes (table_name, row_key, created_at DESC);

ALTER TABLE fieldops_physics_library_changes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fieldops_physics_reviews IS
  'WS6 D22 review record. The latest row for a (model_version, dataset_version) decides the review state. Service role only.';
COMMENT ON TABLE fieldops_physics_library_changes IS
  'WS6 append-only log of admin changes to the physics library tables. Service role only.';
