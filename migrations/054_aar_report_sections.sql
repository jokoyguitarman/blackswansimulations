-- AAR Option B: section-based report (revertible)
-- Additive only: new columns for report_format and sections.
-- Revert: set AAR_REPORT_FORMAT=legacy and redeploy; optional rollback migration can drop these columns.

ALTER TABLE aar_reports
  ADD COLUMN IF NOT EXISTS report_format TEXT DEFAULT 'legacy';

ALTER TABLE aar_reports
  ADD COLUMN IF NOT EXISTS sections JSONB DEFAULT NULL;

COMMENT ON COLUMN aar_reports.report_format IS 'legacy = single summary + insights; sections = per-section data + AI analysis. Revert by setting to legacy and redeploying.';
COMMENT ON COLUMN aar_reports.sections IS 'Section-based AAR: { "executive": { "data": {...}, "analysis": "..." }, ... }. Null for legacy reports.';
