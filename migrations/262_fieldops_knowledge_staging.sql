-- Migration 262: the knowledge-seed staging layer, import run log, reference values and record history.
-- Knowledge-seed import, docs/spec-knowledge-seed-supabase-migration.md section 5.4.
--
-- Every record of every research seed file is stored here with its review state, provenance and validation
-- issues, whether or not it is approved. No game code reads these tables: the library loaders read only the
-- typed tables, which receive approved records through the importer's promote step.
-- Also adds source_run_id and source_folder to fieldops_seed_runs (259), so one research run can own one
-- row per library it fed.
-- Requires 259. Additive and idempotent. Service role only: RLS on with no policy, privileges revoked.
--
-- Rollback, on a branch or local database only, never on the shared project:
--   DROP VIEW IF EXISTS public.fieldops_knowledge_review_queue;
--   DROP TABLE IF EXISTS public.fieldops_knowledge_reference_values;
--   DROP TRIGGER IF EXISTS trg_fieldops_knowledge_records_audit ON public.fieldops_knowledge_records;
--   DROP TRIGGER IF EXISTS trg_fieldops_knowledge_records_no_delete ON public.fieldops_knowledge_records;
--   DROP FUNCTION IF EXISTS public.fieldops_knowledge_records_audit();
--   DROP FUNCTION IF EXISTS public.fieldops_knowledge_records_no_delete();
--   DROP TABLE IF EXISTS public.fieldops_knowledge_record_history;
--   DROP TABLE IF EXISTS public.fieldops_knowledge_records;
--   DROP TABLE IF EXISTS public.fieldops_seed_files;
--   DROP TABLE IF EXISTS public.fieldops_knowledge_import_runs;
--   ALTER TABLE public.fieldops_seed_runs DROP COLUMN IF EXISTS source_folder, DROP COLUMN IF EXISTS source_run_id;
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_seed_runs') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/259_fieldops_knowledge_provenance.sql before 262_fieldops_knowledge_staging.sql';
  END IF;
END $$;

ALTER TABLE public.fieldops_seed_runs
  ADD COLUMN IF NOT EXISTS source_run_id UUID,
  ADD COLUMN IF NOT EXISTS source_folder TEXT CHECK (source_folder IS NULL OR source_folder ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
CREATE INDEX IF NOT EXISTS idx_fieldops_seed_runs_source ON public.fieldops_seed_runs (source_run_id);

CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command TEXT NOT NULL CHECK (command IN ('stage', 'promote', 'verify')),
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'rolled_back')),
  target TEXT NOT NULL CHECK (target IN ('local', 'shared')),
  seeds_dir TEXT NOT NULL CHECK (char_length(seeds_dir) BETWEEN 1 AND 300),
  folders TEXT[] NOT NULL DEFAULT '{}',
  libraries TEXT[] NOT NULL DEFAULT '{}',
  git_sha TEXT CHECK (git_sha IS NULL OR git_sha ~ '^[0-9a-f]{7,40}$'),
  importer_version TEXT NOT NULL CHECK (char_length(importer_version) BETWEEN 1 AND 40),
  manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  operator TEXT CHECK (operator IS NULL OR char_length(operator) BETWEEN 1 AND 120),
  args JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(args) = 'object'),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  issue_summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(issue_summary) = 'object'),
  error TEXT CHECK (error IS NULL OR char_length(error) <= 4000),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT fieldops_knowledge_import_runs_finished CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_import_runs_started
  ON public.fieldops_knowledge_import_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS public.fieldops_seed_files (
  file_path TEXT PRIMARY KEY CHECK (file_path ~ '^[a-z0-9_][a-z0-9_.-]*(/[a-z0-9_][a-z0-9_.-]*)+\.json$' AND char_length(file_path) <= 200),
  folder TEXT NOT NULL CHECK (folder ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  library TEXT NOT NULL CHECK (library IN ('doctrines', 'devices', 'spread', 'threats', 'building_hazards', 'movement', 'units',
    'hospitals', 'blast_effects', 'fire_smoke_tenability')),
  format TEXT NOT NULL CHECK (format IN ('table_rows_v0', 'reference_rows_v0', 'blast_curves_v0', 'worked_examples_v0',
    'responder_rows_v0', 'sources_v0', 'run_manifest_v0', 'agency_register_v1', 'doctrine_seed_v1', 'doctrine_review_v0',
    'planning_rows_v0')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 2 AND 5242880),
  header JSONB NOT NULL CHECK (jsonb_typeof(header) = 'object'),
  header_review_status TEXT CHECK (header_review_status IS NULL OR char_length(header_review_status) <= 40),
  released BOOLEAN NOT NULL DEFAULT false,
  file_review JSONB CHECK (file_review IS NULL OR jsonb_typeof(file_review) = 'object'),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  first_import_run_id UUID REFERENCES public.fieldops_knowledge_import_runs(id) ON DELETE SET NULL,
  last_import_run_id UUID REFERENCES public.fieldops_knowledge_import_runs(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  missing_since TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES public.fieldops_seed_files(file_path) ON UPDATE CASCADE,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('table_row', 'reference', 'curve_table', 'oracle', 'worked_example', 'source',
    'run', 'register_agency', 'register_unit', 'doctrine_seed', 'doctrine_review', 'uncovered', 'refused', 'gap',
    'not_representable')),
  record_key TEXT NOT NULL CHECK (char_length(record_key) BETWEEN 1 AND 200 AND record_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:/#-]*$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  library TEXT NOT NULL CHECK (library IN ('doctrines', 'devices', 'spread', 'threats', 'building_hazards', 'movement', 'units',
    'hospitals', 'blast_effects', 'fire_smoke_tenability')),
  country TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  target_table TEXT CHECK (target_table IS NULL OR target_table IN ('fieldops_spread_materials', 'fieldops_release_agents',
    'fieldops_threat_profiles', 'fieldops_movement_parameters', 'fieldops_incident_types', 'fieldops_building_types',
    'fieldops_hazard_item_kinds', 'fieldops_building_items', 'fieldops_hazard_interactions', 'fieldops_unit_kinds',
    'fieldops_equipment', 'fieldops_unit_equipment', 'fieldops_response_standards', 'fieldops_hospitals',
    'fieldops_capacity_aggregates', 'fieldops_explosive_materials', 'fieldops_injury_thresholds', 'fieldops_knowledge_sources',
    'fieldops_knowledge_reference_values', 'doctrines', 'team_archetype_aliases')),
  target_key TEXT CHECK (target_key IS NULL OR char_length(target_key) BETWEEN 1 AND 200),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) IN ('object', 'array')),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  provenance JSONB CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  review_evidence JSONB CHECK (review_evidence IS NULL OR jsonb_typeof(review_evidence) = 'object'),
  drafted_by TEXT CHECK (drafted_by IS NULL OR drafted_by IN ('agent', 'person')),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  assumed_fields TEXT[] NOT NULL DEFAULT '{}',
  to_verify TEXT[] NOT NULL DEFAULT '{}',
  unverified_fields TEXT[] NOT NULL DEFAULT '{}',
  withheld_fields TEXT[] NOT NULL DEFAULT '{}',
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  seed_run_id UUID REFERENCES public.fieldops_seed_runs(id) ON DELETE SET NULL,
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'amended', 'rejected')),
  review JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(review) = 'object'),
  reviewer_name TEXT CHECK (reviewer_name IS NULL OR char_length(reviewer_name) BETWEEN 2 AND 120),
  reviewer_qualification TEXT CHECK (reviewer_qualification IS NULL OR char_length(reviewer_qualification) BETWEEN 2 AND 300),
  decided_on DATE,
  approved_payload JSONB CHECK (approved_payload IS NULL OR jsonb_typeof(approved_payload) IN ('object', 'array')),
  approved_payload_sha256 TEXT CHECK (approved_payload_sha256 IS NULL OR approved_payload_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at TIMESTAMPTZ,
  pending_change BOOLEAN NOT NULL DEFAULT false,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  promoted_at TIMESTAMPTZ,
  promoted_payload_sha256 TEXT CHECK (promoted_payload_sha256 IS NULL OR promoted_payload_sha256 ~ '^[0-9a-f]{64}$'),
  promoted_import_run_id UUID REFERENCES public.fieldops_knowledge_import_runs(id) ON DELETE SET NULL,
  first_import_run_id UUID REFERENCES public.fieldops_knowledge_import_runs(id) ON DELETE SET NULL,
  last_import_run_id UUID REFERENCES public.fieldops_knowledge_import_runs(id) ON DELETE SET NULL,
  missing_since TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_knowledge_records_unique UNIQUE (file_path, record_kind, record_key),
  CONSTRAINT fieldops_knowledge_records_approval CHECK (
    review_state NOT IN ('approved', 'amended')
    OR (reviewer_name IS NOT NULL AND reviewer_qualification IS NOT NULL AND decided_on IS NOT NULL
        AND approved_payload IS NOT NULL AND approved_payload_sha256 IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT fieldops_knowledge_records_approved_pair CHECK ((approved_payload IS NULL) = (approved_payload_sha256 IS NULL)),
  CONSTRAINT fieldops_knowledge_records_promoted CHECK (promoted_at IS NULL OR approved_payload IS NOT NULL),
  CONSTRAINT fieldops_knowledge_records_target_pair CHECK ((target_table IS NULL) = (target_key IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_records_library_state
  ON public.fieldops_knowledge_records (library, review_state);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_records_target
  ON public.fieldops_knowledge_records (target_table, target_key) WHERE target_table IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_records_blocked
  ON public.fieldops_knowledge_records (library) WHERE blocker_count > 0;
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_records_sources
  ON public.fieldops_knowledge_records USING gin (source_keys);

DROP TRIGGER IF EXISTS trg_fieldops_knowledge_records_updated_at ON public.fieldops_knowledge_records;
CREATE TRIGGER trg_fieldops_knowledge_records_updated_at
  BEFORE UPDATE ON public.fieldops_knowledge_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- History of every change to a staged record. No foreign key, so history outlives a deleted record.
CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_record_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  changed_columns TEXT[] NOT NULL DEFAULT '{}',
  row_before JSONB,
  row_after JSONB,
  import_run_id UUID,
  db_user TEXT NOT NULL DEFAULT current_user,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_record_history_record
  ON public.fieldops_knowledge_record_history (record_id, created_at DESC);

-- The importer sets fieldops.import_run_id with set_config(..., true) at the start of each transaction.
-- Bookkeeping columns alone (last_import_run_id, updated_at) never make a history row.
CREATE OR REPLACE FUNCTION public.fieldops_knowledge_records_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run UUID := NULLIF(current_setting('fieldops.import_run_id', true), '')::uuid;
  v_cols TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.fieldops_knowledge_record_history (record_id, action, row_after, import_run_id)
    VALUES (NEW.id, 'insert', to_jsonb(NEW), v_run);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(array_agg(n.key ORDER BY n.key), '{}') INTO v_cols
      FROM jsonb_each(to_jsonb(NEW)) AS n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
       AND n.key NOT IN ('updated_at', 'last_import_run_id');
    IF cardinality(v_cols) = 0 THEN
      RETURN NEW;
    END IF;
    INSERT INTO public.fieldops_knowledge_record_history (record_id, action, changed_columns, row_before, row_after, import_run_id)
    VALUES (NEW.id, 'update', v_cols, to_jsonb(OLD), to_jsonb(NEW), v_run);
    RETURN NEW;
  ELSE
    INSERT INTO public.fieldops_knowledge_record_history (record_id, action, row_before, import_run_id)
    VALUES (OLD.id, 'delete', to_jsonb(OLD), v_run);
    RETURN OLD;
  END IF;
END;
$$;

-- Staged records are never deleted by the importer; a deliberate clean-up sets fieldops.allow_delete = 'on'.
CREATE OR REPLACE FUNCTION public.fieldops_knowledge_records_no_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('fieldops.allow_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'fieldops_knowledge_records rows are not deleted; set fieldops.allow_delete = on for a deliberate clean-up';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_fieldops_knowledge_records_audit ON public.fieldops_knowledge_records;
CREATE TRIGGER trg_fieldops_knowledge_records_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.fieldops_knowledge_records
  FOR EACH ROW EXECUTE FUNCTION public.fieldops_knowledge_records_audit();
DROP TRIGGER IF EXISTS trg_fieldops_knowledge_records_no_delete ON public.fieldops_knowledge_records;
CREATE TRIGGER trg_fieldops_knowledge_records_no_delete
  BEFORE DELETE ON public.fieldops_knowledge_records
  FOR EACH ROW EXECUTE FUNCTION public.fieldops_knowledge_records_no_delete();

-- Approved reference rows (engine constants, equations, tables, curves) that no typed library column holds.
CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_reference_values (
  library TEXT NOT NULL CHECK (library IN ('doctrines', 'devices', 'spread', 'threats', 'building_hazards', 'movement', 'units',
    'hospitals', 'blast_effects', 'fire_smoke_tenability')),
  ref_key TEXT NOT NULL CHECK (ref_key ~ '^[a-z0-9][a-z0-9_.-]{1,119}$'),
  topic TEXT NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 60),
  value JSONB NOT NULL,
  unit TEXT NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 120),
  formula TEXT CHECK (formula IS NULL OR char_length(formula) <= 2000),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 4000),
  spec_ref TEXT CHECK (spec_ref IS NULL OR char_length(spec_ref) <= 400),
  extends TEXT CHECK (extends IS NULL OR char_length(extends) <= 400),
  worked_example JSONB,
  provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  assumed_fields TEXT[] NOT NULL DEFAULT '{}',
  to_verify TEXT[] NOT NULL DEFAULT '{}',
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  record_id BIGINT NOT NULL REFERENCES public.fieldops_knowledge_records(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (library, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_reference_values_topic
  ON public.fieldops_knowledge_reference_values (library, topic) WHERE status = 'active';
DROP TRIGGER IF EXISTS trg_fieldops_knowledge_reference_values_updated_at ON public.fieldops_knowledge_reference_values;
CREATE TRIGGER trg_fieldops_knowledge_reference_values_updated_at
  BEFORE UPDATE ON public.fieldops_knowledge_reference_values
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- What a reviewer still has to decide, and what blocks promotion.
CREATE OR REPLACE VIEW public.fieldops_knowledge_review_queue AS
SELECT r.library, r.file_path, r.record_kind, r.record_key, r.target_table, r.target_key, r.review_state,
       r.pending_change, r.blocker_count, r.warning_count, r.confidence, r.assumed_fields, r.to_verify,
       f.released AS file_released, r.updated_at
  FROM public.fieldops_knowledge_records r
  JOIN public.fieldops_seed_files f ON f.file_path = r.file_path
 WHERE r.missing_since IS NULL
   AND r.record_kind IN ('table_row', 'reference', 'curve_table', 'register_agency', 'doctrine_seed')
   AND (r.review_state = 'pending' OR r.pending_change OR r.blocker_count > 0);

COMMENT ON TABLE public.fieldops_knowledge_import_runs IS
  'Knowledge-seed importer run log: one row per stage, promote or verify run, dry or applied, with counts and the outcome. Service role only.';
COMMENT ON TABLE public.fieldops_seed_files IS
  'Every research seed file the importer has read, with its checksum, header and whether the reviewer released it. Service role only.';
COMMENT ON TABLE public.fieldops_knowledge_records IS
  'Every record of every seed file, pending or approved, with provenance, flags and validation issues. Never read by game code. Service role only.';
COMMENT ON COLUMN public.fieldops_knowledge_records.approved_payload IS
  'The payload as last approved. A later pending change to the file never overwrites it (D39); promotion reads only this column.';
COMMENT ON TABLE public.fieldops_knowledge_reference_values IS
  'Approved reference values (equations, constants, tables, curves) from the research libraries that no typed column holds. Service role only.';

ALTER TABLE public.fieldops_knowledge_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_seed_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_knowledge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_knowledge_record_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_knowledge_reference_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_knowledge_import_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_seed_files FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_knowledge_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_knowledge_record_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_knowledge_reference_values FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fieldops_knowledge_review_queue FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_knowledge_records_audit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_knowledge_records_no_delete() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.fieldops_knowledge_import_runs, public.fieldops_seed_files,
  public.fieldops_knowledge_records, public.fieldops_knowledge_reference_values TO service_role;
GRANT SELECT, INSERT ON public.fieldops_knowledge_record_history TO service_role;
GRANT SELECT ON public.fieldops_knowledge_review_queue TO service_role;

COMMIT;
