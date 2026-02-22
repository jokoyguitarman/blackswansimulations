# Reverting AAR Section-Based Report (Option B)

## What was added

- **Database:** `aar_reports.report_format` (TEXT, default `'legacy'`) and `aar_reports.sections` (JSONB, default NULL). See migration `054_aar_report_sections.sql`.
- **Environment:** `AAR_REPORT_FORMAT` — set to `sections` to use section-based AAR; omit or set to `legacy` for the previous behavior.
- **Backend:** When `AAR_REPORT_FORMAT=sections`, the generate route builds per-section data (decisions + scoring history, matrices, injects published/cancelled, coordination, escalation), runs per-section AI analysis, and stores the result in `sections`. Legacy path (single summary + insights) is unchanged when format is `legacy`.
- **Frontend:** If `aar.sections` is present and `aar.report_format === 'sections'`, the dashboard renders the section-based view (data + analysis per section). Otherwise it renders the legacy view (summary, key metrics, AI insights, key decisions).

## How to revert to the previous AAR behavior

1. **Set the format to legacy**
   - In your deployment environment, set `AAR_REPORT_FORMAT=legacy` (or remove the variable so it defaults to `legacy`).

2. **Redeploy the backend**
   - New AAR generations will use the legacy flow (single summary + AI insights). No code or schema change is required.

3. **Existing section-based reports**
   - Reports that were already generated with sections still have `summary` populated (from the executive section analysis or a short fallback). The frontend shows the **legacy view** for any report where `report_format !== 'sections'` or `sections` is null, so those reports will display the stored `summary` and other legacy fields.

## Optional: remove the new columns from the database

If you want to fully remove the feature from the schema:

1. Add a new migration that drops the columns:
   - `ALTER TABLE aar_reports DROP COLUMN IF EXISTS report_format;`
   - `ALTER TABLE aar_reports DROP COLUMN IF EXISTS sections;`
2. Run the migration. Existing section-based reports will then have no `sections` or `report_format`; the frontend will treat them as legacy and show only `summary` (and other existing fields).
