-- Migration 263: row history for every typed knowledge-library table, and updated_at triggers for 261's tables.
-- Knowledge-seed import, docs/spec-knowledge-seed-supabase-migration.md section 5.5.
--
-- Attaches one AFTER trigger per table that exists when the file runs, so it is safe before or after any of
-- 221 to 261 and can be re-applied after a later library migration to pick up its tables. The importer's own
-- change logs (fieldops_spread_changes, fieldops_physics_library_changes, doctrine_events) are still written;
-- this table catches every write, including admin edits made outside the importer.
-- Requires 262. Additive and idempotent. Service role only.
--
-- Rollback, on a branch or local database only, never on the shared project:
--   (for each table t below) DROP TRIGGER IF EXISTS trg_fieldops_row_history ON public.t;
--   DROP FUNCTION IF EXISTS public.fieldops_library_row_audit();
--   DROP TABLE IF EXISTS public.fieldops_library_row_history;
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.fieldops_knowledge_records') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations/262_fieldops_knowledge_staging.sql before 263_fieldops_library_row_history.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fieldops_library_row_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL CHECK (char_length(table_name) BETWEEN 3 AND 63),
  row_key TEXT NOT NULL CHECK (char_length(row_key) BETWEEN 1 AND 300),
  action TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  row_before JSONB,
  row_after JSONB,
  import_run_id UUID,
  db_user TEXT NOT NULL DEFAULT current_user,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fieldops_library_row_history_row
  ON public.fieldops_library_row_history (table_name, row_key, created_at DESC);

-- TG_ARGV holds the key columns; the row key is their values joined with '/'.
CREATE OR REPLACE FUNCTION public.fieldops_library_row_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_key TEXT;
  v_run UUID := NULLIF(current_setting('fieldops.import_run_id', true), '')::uuid;
BEGIN
  SELECT string_agg(COALESCE(v_row ->> k, '-'), '/' ORDER BY ord) INTO v_key
    FROM unnest(TG_ARGV) WITH ORDINALITY AS t(k, ord);
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.fieldops_library_row_history (table_name, row_key, action, row_before, row_after, import_run_id)
  VALUES (TG_TABLE_NAME, left(v_key, 300), lower(TG_OP),
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
          v_run);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('fieldops_spread_materials', ARRAY['material_key']),
    ('fieldops_release_agents', ARRAY['agent_key']),
    ('fieldops_threat_profiles', ARRAY['threat_key']),
    ('fieldops_movement_parameters', ARRAY['param_key']),
    ('fieldops_incident_types', ARRAY['incident_type']),
    ('fieldops_building_types', ARRAY['type_key']),
    ('fieldops_hazard_item_kinds', ARRAY['kind_key']),
    ('fieldops_building_items', ARRAY['type_key', 'kind_key', 'location_kind']),
    ('fieldops_hazard_interactions', ARRAY['rule_key']),
    ('fieldops_unit_kinds', ARRAY['kind_key']),
    ('fieldops_equipment', ARRAY['equipment_key']),
    ('fieldops_unit_equipment', ARRAY['kind_key', 'equipment_key']),
    ('fieldops_response_standards', ARRAY['standard_key']),
    ('fieldops_hospitals', ARRAY['hospital_key']),
    ('fieldops_hospital_specialties', ARRAY['hospital_key', 'role']),
    ('fieldops_capacity_aggregates', ARRAY['aggregate_key']),
    ('fieldops_explosive_materials', ARRAY['material_key']),
    ('fieldops_injury_thresholds', ARRAY['threshold_key']),
    ('fieldops_knowledge_sources', ARRAY['source_key']),
    ('fieldops_knowledge_coverage', ARRAY['library', 'country', 'subject_key']),
    ('fieldops_knowledge_reference_values', ARRAY['library', 'ref_key']),
    ('team_archetype_aliases', ARRAY['archetype_key', 'phrase', 'country']),
    ('doctrines', ARRAY['id']),
    ('doctrine_versions', ARRAY['doctrine_id', 'version'])
  ) AS v(tbl, keys)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_fieldops_row_history ON public.%I', t.tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_fieldops_row_history AFTER INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.fieldops_library_row_audit(%s)',
        t.tbl, (SELECT string_agg(quote_literal(k), ', ') FROM unnest(t.keys) AS k));
    END IF;
  END LOOP;
END $$;

-- 261's tables carry updated_at but, like 254, no trigger; add one per table present.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['fieldops_unit_kinds', 'fieldops_equipment', 'fieldops_response_standards', 'fieldops_hospitals',
                             'fieldops_capacity_aggregates']
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON public.%I', tbl, tbl);
      EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()', tbl, tbl);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE public.fieldops_library_row_history IS
  'Every insert, update and delete on the typed knowledge-library tables, with the importer run that made it when there was one. Service role only.';

ALTER TABLE public.fieldops_library_row_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_library_row_history FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_library_row_audit() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.fieldops_library_row_history TO service_role;

COMMIT;
