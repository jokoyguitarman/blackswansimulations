-- Migration 258: release agents, threat profiles and movement parameters (D41, D44; master 10.8 item 44).
-- WS9, docs/field-ops/11-living-world.md section 5.16. Added 22 Nov 2026.
--
-- Additive and idempotent. loadThreatLibrary answers null until these tables hold a complete active library;
-- the world then runs the single-layer engine's rules without releases or threats and says so.
-- Service role only: row level security on with no policy, privileges revoked.
--
-- Rollback, tried on a branch database only, never on the shared project:
--   DROP TABLE IF EXISTS public.fieldops_incident_types;
--   DROP TABLE IF EXISTS public.fieldops_movement_parameters;
--   DROP TABLE IF EXISTS public.fieldops_threat_profiles;
--   DROP TABLE IF EXISTS public.fieldops_release_agents;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_release_agents (
  agent_key TEXT PRIMARY KEY CHECK (agent_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  cas_number TEXT CHECK (cas_number IS NULL OR cas_number ~ '^[0-9]{2,7}-[0-9]{2}-[0-9]$'),
  molecular_weight NUMERIC(7, 2) NOT NULL CHECK (molecular_weight BETWEEN 1 AND 500),
  density_ratio NUMERIC(5, 3) NOT NULL CHECK (density_ratio BETWEEN 0.05 AND 10),
  boiling_point_c NUMERIC(6, 1) CHECK (boiling_point_c IS NULL OR boiling_point_c BETWEEN -273 AND 500),
  lfl_pct NUMERIC(5, 2) CHECK (lfl_pct IS NULL OR lfl_pct BETWEEN 0.1 AND 100),
  ufl_pct NUMERIC(5, 2) CHECK (ufl_pct IS NULL OR ufl_pct BETWEEN 0.1 AND 100),
  tier_scheme TEXT CHECK (tier_scheme IS NULL OR tier_scheme IN ('aegl', 'erpg', 'teel')),
  tiers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tiers) = 'array'),
  toxic_load_n NUMERIC(4, 2) CHECK (toxic_load_n IS NULL OR toxic_load_n BETWEEN 0.5 AND 4),
  irritant BOOLEAN NOT NULL DEFAULT false,
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_release_agents_flammable CHECK ((lfl_pct IS NULL) = (ufl_pct IS NULL) AND (lfl_pct IS NULL OR lfl_pct < ufl_pct)),
  CONSTRAINT fieldops_release_agents_tiers CHECK ((tier_scheme IS NULL) = (jsonb_array_length(tiers) = 0))
);

CREATE TABLE IF NOT EXISTS public.fieldops_threat_profiles (
  threat_key TEXT PRIMARY KEY CHECK (threat_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  -- Updated 22 Nov 2026 (D46): the incident types' categories and models.
  category TEXT NOT NULL CHECK (category IN ('explosion', 'fire', 'toxic_release', 'flammable_release',
    'structural_collapse', 'vehicle_impact', 'flood', 'crowd_crush', 'ramming', 'aircraft_impact', 'armed_attacker',
    'rail', 'utility_failure', 'earthquake')),
  model TEXT NOT NULL CHECK (model IN ('blast_profile', 'vessel_burst', 'bleve_fireball', 'vapour_cloud', 'pool_fire',
    'jet_fire', 'flash_fire', 'gaussian_plume', 'dense_gas_plume', 'indoor_transport', 'progressive_collapse',
    'kinetic_impact', 'water_ingress', 'crowd_pressure', 'ramming_path', 'aircraft_impact', 'vented_deflagration',
    'shelter_in_place', 'attacker_zone', 'rolling_stock_fire', 'surface_flood', 'utility_cascade', 'ground_shaking')),
  parameters JSONB NOT NULL CHECK (jsonb_typeof(parameters) = 'object' AND octet_length(parameters::text) <= 16384),
  environment JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(environment) = 'array'),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_movement_parameters (
  param_key TEXT PRIMARY KEY CHECK (param_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  applies_to TEXT NOT NULL CHECK (applies_to IN ('walking', 'stairs', 'crouch', 'crawl', 'visibility', 'heat', 'gas', 'water', 'exit', 'group')),
  value NUMERIC(12, 4) NOT NULL,
  -- Updated 22 Nov 2026 (research gap): ppm and per cent for gas limits.
  unit TEXT NOT NULL CHECK (unit IN ('m_s', 'p_m2', 'm2_p', 'p_s_m', 'm', 'c', 'kw_m2', 'per_m', 'm2_g', 'ratio', 's', 'permille', 'ppm', 'pct')),
  plausible_low NUMERIC(12, 4) NOT NULL,
  plausible_high NUMERIC(12, 4) NOT NULL,
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_movement_parameters_range CHECK (plausible_low <= value AND value <= plausible_high)
);

DROP TRIGGER IF EXISTS trg_fieldops_release_agents_updated_at ON public.fieldops_release_agents;
CREATE TRIGGER trg_fieldops_release_agents_updated_at BEFORE UPDATE ON public.fieldops_release_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_threat_profiles_updated_at ON public.fieldops_threat_profiles;
CREATE TRIGGER trg_fieldops_threat_profiles_updated_at BEFORE UPDATE ON public.fieldops_threat_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_movement_parameters_updated_at ON public.fieldops_movement_parameters;
CREATE TRIGGER trg_fieldops_movement_parameters_updated_at BEFORE UPDATE ON public.fieldops_movement_parameters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_release_agents IS
  'WS9 (D41): physical properties and exposure tiers of agents that buildings hold or fires produce. Planning values with sources; reviewed under W24.';
COMMENT ON TABLE public.fieldops_threat_profiles IS
  'WS9 (D41): how each threat is modelled and how it reacts with the environment. parameters is validated per model by threatParamsSchema.';
COMMENT ON TABLE public.fieldops_movement_parameters IS
  'WS9 (D44): evacuee movement parameters with their published sources and plausible ranges.';

-- Added 22 Nov 2026 (D46): one row per incident type beyond the bombing types.
CREATE TABLE IF NOT EXISTS public.fieldops_incident_types (
  incident_type TEXT PRIMARY KEY CHECK (incident_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  type_group TEXT NOT NULL CHECK (type_group IN ('explosives', 'crowd_and_vehicle', 'fire_and_explosion', 'hazardous_materials',
    'structural_and_transport', 'natural_hazards', 'armed_attack', 'utilities')),
  phase SMALLINT NOT NULL CHECK (phase BETWEEN 1 AND 3),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('device', 'crowd_trigger', 'vehicle_path', 'aircraft_impact', 'ignition', 'gas_leak',
    'release', 'collapse_zone', 'train_event', 'road_collision', 'rainfall', 'utility_outage', 'attacker_route')),
  threat_keys TEXT[] NOT NULL CHECK (cardinality(threat_keys) >= 1),
  responder_archetypes TEXT[] NOT NULL CHECK (cardinality(responder_archetypes) >= 2),
  catalogue_needs TEXT[] NOT NULL DEFAULT '{}',
  template_file TEXT NOT NULL CHECK (template_file ~ '^[a-z][a-z0-9_]{1,47}\.json$'),
  sensitivity TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public', 'restricted_generic')),
  briefing_note TEXT NOT NULL CHECK (char_length(briefing_note) BETWEEN 3 AND 400),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_fieldops_incident_types_updated_at ON public.fieldops_incident_types;
CREATE TRIGGER trg_fieldops_incident_types_updated_at BEFORE UPDATE ON public.fieldops_incident_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
ALTER TABLE public.fieldops_incident_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_incident_types FROM PUBLIC, anon, authenticated;

ALTER TABLE public.fieldops_release_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_threat_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_movement_parameters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_release_agents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_threat_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_movement_parameters FROM PUBLIC, anon, authenticated;

COMMIT;
