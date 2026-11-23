-- Migration 261: unit kinds, equipment, response standards, hospitals and capacity aggregates (D54, D56).
-- Knowledge-seed import, docs/spec-knowledge-seed-supabase-migration.md section 5.3.
--
-- The same DDL as the D54/D56 passages of PR #23's migration 254 (docs/field-ops/11-living-world.md
-- section 5.6), split out because 254 refuses to apply until 252 (fieldops_world_sessions) exists.
-- Every statement is IF NOT EXISTS, so applying 254 later leaves these tables as they are.
-- Additive and idempotent. Service role only: RLS on with no policy, privileges revoked.
--
-- Rollback, on a branch or local database only, never on the shared project:
--   DROP TABLE IF EXISTS public.fieldops_capacity_aggregates;
--   DROP TABLE IF EXISTS public.fieldops_hospital_specialties;
--   DROP TABLE IF EXISTS public.fieldops_hospitals;
--   DROP TABLE IF EXISTS public.fieldops_response_standards;
--   DROP TABLE IF EXISTS public.fieldops_unit_equipment;
--   DROP TABLE IF EXISTS public.fieldops_equipment;
--   DROP TABLE IF EXISTS public.fieldops_unit_kinds;
BEGIN;

-- Added 22 Nov 2026 (D54, W56): unit kinds and equipment as seeded, reviewed rows. Amended in place; 254 is not applied.
CREATE TABLE IF NOT EXISTS public.fieldops_unit_kinds (
  kind_key TEXT PRIMARY KEY CHECK (kind_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  country TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  archetype_key TEXT NOT NULL,
  -- Updated 22 Nov 2026 (research gap): 'vessel' for marine units; stored, but fielded only when a water model exists (phase 3).
  mode TEXT NOT NULL CHECK (mode IN ('vehicle', 'foot', 'vessel')),
  crew SMALLINT NOT NULL CHECK (crew BETWEEN 1 AND 20),
  default_count SMALLINT NOT NULL CHECK (default_count BETWEEN 0 AND 8),
  turnout_s INTEGER NOT NULL CHECK (turnout_s BETWEEN 0 AND 3600),
  observes_m SMALLINT NOT NULL CHECK (observes_m BETWEEN 10 AND 500),
  asset_type TEXT NOT NULL CHECK (asset_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  tasks TEXT[] NOT NULL,
  starts_from TEXT[] NOT NULL DEFAULT '{}',
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fieldops_equipment (
  equipment_key TEXT PRIMARY KEY CHECK (equipment_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  category TEXT NOT NULL CHECK (category IN ('water_tank', 'pump', 'hose', 'foam', 'breathing_apparatus', 'ladder', 'aerial_platform',
    'stretcher', 'patient_capacity', 'decontamination', 'cutting', 'thermal_camera', 'gas_detector', 'lighting', 'barrier', 'shoring')),
  capacity NUMERIC(12, 2) NOT NULL CHECK (capacity >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('l', 'l_min', 'm', 's', 'count', 'p_h', 'm2')),
  consumable BOOLEAN NOT NULL DEFAULT false,
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fieldops_unit_equipment (
  kind_key TEXT NOT NULL REFERENCES public.fieldops_unit_kinds(kind_key) ON UPDATE CASCADE,
  equipment_key TEXT NOT NULL REFERENCES public.fieldops_equipment(equipment_key) ON UPDATE CASCADE,
  quantity SMALLINT NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  PRIMARY KEY (kind_key, equipment_key)
);
ALTER TABLE public.fieldops_unit_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_unit_equipment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_unit_kinds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_equipment FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_unit_equipment FROM PUBLIC, anon, authenticated;

-- Added 22 Nov 2026 (D56): published response standards, hospitals with their specialty roles, and capacity aggregates.
-- Real hospitals are named: they are public facilities, as WS3's saved facilities already name them.
CREATE TABLE IF NOT EXISTS public.fieldops_response_standards (
  standard_key TEXT PRIMARY KEY CHECK (standard_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  country TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  scope TEXT NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_]{1,63}$'),       -- an archetype key, a register agency key or a service key
  incident_types TEXT[] NOT NULL DEFAULT '{}',                            -- empty: every incident type
  respond_within_s INTEGER CHECK (respond_within_s IS NULL OR respond_within_s BETWEEN 1 AND 86400),
  answer_within_s INTEGER CHECK (answer_within_s IS NULL OR answer_within_s BETWEEN 1 AND 3600),
  target_share_pct NUMERIC(5, 2) CHECK (target_share_pct IS NULL OR target_share_pct BETWEEN 0 AND 100),
  measured_from TEXT CHECK (measured_from IS NULL OR measured_from IN ('call_receipt', 'dispatch', 'unknown')),
  stated_values JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(stated_values) = 'array'), -- every stated value as the seed gives it
  site_bound BOOLEAN NOT NULL DEFAULT false,                              -- D57
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fieldops_hospitals (
  hospital_key TEXT PRIMARY KEY CHECK (hospital_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  country TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  ownership TEXT NOT NULL CHECK (ownership IN ('public', 'private', 'community', 'military')),
  cluster TEXT CHECK (cluster IS NULL OR char_length(cluster) BETWEEN 2 AND 80),
  acute BOOLEAN NOT NULL,
  emergency_department BOOLEAN NOT NULL,
  lat DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  osm_id TEXT,                                                            -- matches WS3's saved facility when known
  beds INTEGER CHECK (beds IS NULL OR beds BETWEEN 0 AND 20000),
  beds_year SMALLINT CHECK (beds_year IS NULL OR beds_year BETWEEN 2000 AND 2100),
  stated_values JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(stated_values) = 'array'),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.fieldops_hospital_specialties (
  hospital_key TEXT NOT NULL REFERENCES public.fieldops_hospitals(hospital_key) ON UPDATE CASCADE ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('trauma_centre', 'burns_centre', 'paediatric', 'paediatric_emergency', 'neurosurgery',
    'cardiothoracic', 'spinal', 'hyperbaric', 'toxicology', 'decontamination', 'obstetric', 'ophthalmology', 'psychiatric',
    'infectious_isolation')),
  level TEXT CHECK (level IS NULL OR level IN ('national_centre', 'regional', 'service')),
  status TEXT NOT NULL CHECK (status IN ('sourced', 'unverified', 'assumed')),
  source_key TEXT,
  locator TEXT CHECK (locator IS NULL OR char_length(locator) BETWEEN 1 AND 120),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  PRIMARY KEY (hospital_key, role)
);
CREATE TABLE IF NOT EXISTS public.fieldops_capacity_aggregates (
  aggregate_key TEXT PRIMARY KEY CHECK (aggregate_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 160),
  country TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  scope TEXT NOT NULL,
  stated_values JSONB NOT NULL CHECK (jsonb_typeof(stated_values) = 'array'),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.fieldops_response_standards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_hospitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_hospital_specialties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_capacity_aggregates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_response_standards FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_hospitals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_hospital_specialties FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_capacity_aggregates FROM PUBLIC, anon, authenticated;

COMMIT;
