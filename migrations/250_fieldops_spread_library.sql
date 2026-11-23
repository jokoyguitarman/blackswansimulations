-- Migration 250: the stored spread and deterioration library (D31; master 10.8 items 35 and 38).
-- WS9, docs/field-ops/11-living-world.md section 5.2.
--
-- Additive and idempotent. loadSpreadLibrary answers null until these tables hold a complete active
-- library (W1), so applying the file changes no running behaviour: WS5 compiles without fire-spread
-- pins and with an empty facts block until an admin seeds the tables from the reviewed seed files.
-- Only the service role reads or writes them: row level security is on with no policy, and the
-- table privileges of PUBLIC, anon and authenticated are revoked.
--
-- Rollback, tried on a branch database only, never on the shared project (WS5 then degrades as above;
-- the world refuses to start):
--   DROP TABLE IF EXISTS public.fieldops_spread_changes;
--   DROP TABLE IF EXISTS public.fieldops_spread_reviews;
--   DROP TABLE IF EXISTS public.fieldops_spread_weather_effects;
--   DROP TABLE IF EXISTS public.fieldops_spread_exposure;
--   DROP TABLE IF EXISTS public.fieldops_spread_hazards;
--   DROP TABLE IF EXISTS public.fieldops_spread_materials;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_spread_materials (
  material_key TEXT PRIMARY KEY CHECK (material_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  material_role TEXT NOT NULL CHECK (material_role IN ('wall', 'contents', 'structure')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  aliases TEXT[] NOT NULL DEFAULT '{}',
  combustible BOOLEAN NOT NULL DEFAULT false,
  flame_spread_m_min NUMERIC(6, 3) CHECK (flame_spread_m_min IS NULL OR flame_spread_m_min BETWEEN 0.01 AND 30),
  burn_duration_s INTEGER CHECK (burn_duration_s IS NULL OR burn_duration_s BETWEEN 10 AND 14400),
  extinguish_s INTEGER CHECK (extinguish_s IS NULL OR extinguish_s BETWEEN 5 AND 3600),
  smoke_yield TEXT NOT NULL DEFAULT 'none'
    CHECK (smoke_yield IN ('none', 'light', 'moderate', 'heavy', 'toxic')),
  heat_release TEXT NOT NULL DEFAULT 'none'
    CHECK (heat_release IN ('none', 'slow', 'medium', 'fast', 'ultra_fast')),
  -- Added 22 Nov 2026 (D41, W29, W30): design-fire and smoke properties of contents.
  hrrpua_kw_m2 INTEGER CHECK (hrrpua_kw_m2 IS NULL OR hrrpua_kw_m2 BETWEEN 50 AND 5000),
  heat_of_combustion_mj_kg NUMERIC(5, 2) CHECK (heat_of_combustion_mj_kg IS NULL OR heat_of_combustion_mj_kg BETWEEN 5 AND 50),
  soot_yield NUMERIC(5, 4) CHECK (soot_yield IS NULL OR soot_yield BETWEEN 0 AND 0.3),
  co_yield NUMERIC(5, 4) CHECK (co_yield IS NULL OR co_yield BETWEEN 0 AND 0.3),
  -- Added 22 Nov 2026 (fire research): piloted ignition of thick solids, t_ig = (pi/4) (TRP / (q - CHF))^2 (NUREG-1805).
  critical_heat_flux_kw_m2 NUMERIC(5, 1) CHECK (critical_heat_flux_kw_m2 IS NULL OR critical_heat_flux_kw_m2 BETWEEN 5 AND 50),
  thermal_response_kw_s05_m2 NUMERIC(6, 1) CHECK (thermal_response_kw_s05_m2 IS NULL OR thermal_response_kw_s05_m2 BETWEEN 50 AND 1000),
  -- Added 22 Nov 2026 (fire research): thermal inertia k rho c of a lining, (kW/m2K)^2 s, for MQH's heat-loss term.
  lining_krhoc NUMERIC(6, 3) CHECK (lining_krhoc IS NULL OR lining_krhoc BETWEEN 0.001 AND 10),
  -- Added 22 Nov 2026 (research gap): yields after flashover, when the fire is ventilation-controlled. Null: use the values above.
  soot_yield_post_fo NUMERIC(5, 4) CHECK (soot_yield_post_fo IS NULL OR soot_yield_post_fo BETWEEN 0 AND 0.5),
  co_yield_post_fo NUMERIC(5, 4) CHECK (co_yield_post_fo IS NULL OR co_yield_post_fo BETWEEN 0 AND 0.5),
  burn_through_s INTEGER CHECK (burn_through_s IS NULL OR burn_through_s BETWEEN 10 AND 86400),
  smoke_leak NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (smoke_leak BETWEEN 0 AND 1),
  gas_leak NUMERIC(5, 4) NOT NULL DEFAULT 0 CHECK (gas_leak BETWEEN 0 AND 1),
  glazed BOOLEAN NOT NULL DEFAULT false,
  fire_resistance_min INTEGER CHECK (fire_resistance_min IS NULL OR fire_resistance_min BETWEEN 5 AND 480),
  creep_per_min NUMERIC(6, 2) CHECK (creep_per_min IS NULL OR creep_per_min BETWEEN 0 AND 100),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_materials_contents CHECK (
    material_role <> 'contents'
    OR (flame_spread_m_min IS NOT NULL AND burn_duration_s IS NOT NULL AND extinguish_s IS NOT NULL)
  ),
  CONSTRAINT fieldops_spread_materials_structure CHECK (
    material_role <> 'structure' OR (fire_resistance_min IS NOT NULL AND creep_per_min IS NOT NULL)
  ),
  CONSTRAINT fieldops_spread_materials_glazed CHECK (glazed = false OR material_role = 'wall'),
  -- Added 22 Nov 2026: every contents row carries its design-fire properties.
  CONSTRAINT fieldops_spread_materials_fire CHECK (
    material_role <> 'contents'
    OR (hrrpua_kw_m2 IS NOT NULL AND heat_of_combustion_mj_kg IS NOT NULL AND soot_yield IS NOT NULL AND co_yield IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_hazards (
  hazard_type TEXT PRIMARY KEY CHECK (hazard_type ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  trigger_on TEXT NOT NULL CHECK (trigger_on IN ('blast', 'ignition', 'none')),
  event_type TEXT CHECK (event_type IS NULL OR event_type IN ('ignite', 'rupture', 'collapse', 'arc')),
  spread_kind TEXT CHECK (spread_kind IS NULL OR spread_kind IN ('fire', 'gas', 'structural_zone')),
  delay_s INTEGER NOT NULL DEFAULT 0 CHECK (delay_s BETWEEN 0 AND 3600),
  radius_low_m NUMERIC(6, 2) NOT NULL CHECK (radius_low_m BETWEEN 0.5 AND 100),
  radius_medium_m NUMERIC(6, 2) NOT NULL CHECK (radius_medium_m BETWEEN 0.5 AND 100),
  radius_high_m NUMERIC(6, 2) NOT NULL CHECK (radius_high_m BETWEEN 0.5 AND 100),
  spread_rate_m_min NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (spread_rate_m_min BETWEEN 0 AND 60),
  max_radius_m NUMERIC(6, 2) NOT NULL CHECK (max_radius_m BETWEEN 0.5 AND 200),
  acceleration NUMERIC(5, 2) NOT NULL DEFAULT 1 CHECK (acceleration BETWEEN 0 AND 10),
  contents_key TEXT REFERENCES public.fieldops_spread_materials(material_key) ON UPDATE CASCADE,
  smoke_yield TEXT NOT NULL DEFAULT 'none'
    CHECK (smoke_yield IN ('none', 'light', 'moderate', 'heavy', 'toxic')),
  gas_agent TEXT CHECK (gas_agent IS NULL OR gas_agent IN ('toxic_gas', 'irritant_gas')),
  gas_source_rate INTEGER CHECK (gas_source_rate IS NULL OR gas_source_rate BETWEEN 1 AND 1000),
  gas_duration_s INTEGER CHECK (gas_duration_s IS NULL OR gas_duration_s BETWEEN 10 AND 14400),
  event_text TEXT NOT NULL CHECK (char_length(event_text) BETWEEN 3 AND 200),
  fact_dispersion TEXT NOT NULL CHECK (char_length(fact_dispersion) BETWEEN 3 AND 300),
  fact_structural TEXT NOT NULL CHECK (char_length(fact_structural) BETWEEN 3 AND 300),
  interactions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(interactions) = 'array'),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_hazards_radii CHECK (
    radius_low_m <= radius_medium_m AND radius_medium_m <= radius_high_m AND radius_high_m <= max_radius_m
  ),
  CONSTRAINT fieldops_spread_hazards_gas CHECK (
    (gas_agent IS NULL) = (gas_source_rate IS NULL) AND (gas_agent IS NULL) = (gas_duration_s IS NULL)
  ),
  CONSTRAINT fieldops_spread_hazards_event CHECK (spread_kind IS NULL OR event_type IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_exposure (
  -- Updated 22 Nov 2026 (D46): compression (crowd crush) and impact (vehicles, debris) added.
  agent TEXT PRIMARY KEY CHECK (agent IN ('smoke', 'toxic_gas', 'irritant_gas', 'heat', 'heat_stress', 'collapse', 'compression', 'impact')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  incapacitation_bands JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(incapacitation_bands) = 'array'),
  -- Added 22 Nov 2026 (research gap): the agent's ISO 13571 model constants (for example the CO, heat and radiant terms),
  -- validated per agent by exposureConstantsSchema; empty means the bands above alone.
  model_constants JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(model_constants) = 'object'),
  light_at NUMERIC(6, 3) NOT NULL CHECK (light_at > 0),
  serious_at NUMERIC(6, 3) NOT NULL,
  fatal_at NUMERIC(6, 3) NOT NULL,
  share_light INTEGER NOT NULL CHECK (share_light BETWEEN 0 AND 1000),
  share_serious INTEGER NOT NULL CHECK (share_serious BETWEEN 0 AND 1000),
  share_fatal INTEGER NOT NULL CHECK (share_fatal BETWEEN 0 AND 1000),
  share_trapped INTEGER NOT NULL DEFAULT 0 CHECK (share_trapped BETWEEN 0 AND 1000),
  patient_note TEXT NOT NULL CHECK (char_length(patient_note) BETWEEN 3 AND 300),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_spread_exposure_order CHECK (light_at < serious_at AND serious_at < fatal_at),
  CONSTRAINT fieldops_spread_exposure_shares CHECK (
    share_light + share_serious + share_fatal + share_trapped <= 1000
  )
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_weather_effects (
  weather_condition TEXT PRIMARY KEY
    CHECK (weather_condition IN ('clear', 'cloudy', 'light_rain', 'heavy_rain', 'thunderstorm', 'haze')),
  outdoor_spread NUMERIC(4, 3) NOT NULL CHECK (outdoor_spread BETWEEN 0 AND 2),
  plume_decay NUMERIC(4, 3) NOT NULL CHECK (plume_decay BETWEEN 0.1 AND 5),
  observation NUMERIC(4, 3) NOT NULL CHECK (observation BETWEEN 0.1 AND 1),
  road_speed NUMERIC(4, 3) NOT NULL CHECK (road_speed BETWEEN 0.1 AND 1),
  walking_speed NUMERIC(4, 3) NOT NULL CHECK (walking_speed BETWEEN 0.1 AND 1),
  day_stability TEXT NOT NULL CHECK (day_stability IN ('unstable', 'neutral', 'stable')),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 3 AND 40),
  dataset_version TEXT NOT NULL CHECK (dataset_version ~ '^[0-9a-f]{16}$'),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'revoked')),
  reviewer_name TEXT NOT NULL CHECK (char_length(reviewer_name) BETWEEN 2 AND 120),
  reviewer_qualification TEXT NOT NULL CHECK (char_length(reviewer_qualification) BETWEEN 2 AND 300),
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'object'),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 4000),
  library_snapshot JSONB NOT NULL CHECK (jsonb_typeof(library_snapshot) = 'object'),
  recorded_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  supersedes UUID REFERENCES public.fieldops_spread_reviews(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_spread_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Updated 22 Nov 2026: the tables of 257 and 258 are logged here too.
  table_name TEXT NOT NULL CHECK (table_name IN ('materials', 'hazards', 'exposure', 'weather_effects', 'road_speeds', 'traffic', 'weather_presets',
    'building_types', 'item_kinds', 'building_items', 'interactions', 'agents', 'threats', 'movement', 'incident_types')),
  row_key TEXT NOT NULL CHECK (char_length(row_key) BETWEEN 1 AND 120),
  action TEXT NOT NULL CHECK (action IN ('seed', 'create', 'update', 'retire')),
  row_before JSONB,
  row_after JSONB,
  dataset_version_before TEXT CHECK (dataset_version_before IS NULL OR dataset_version_before ~ '^[0-9a-f]{16}$'),
  dataset_version_after TEXT CHECK (dataset_version_after IS NULL OR dataset_version_after ~ '^[0-9a-f]{16}$'),
  changed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fieldops_spread_materials_role
  ON public.fieldops_spread_materials (material_role) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fieldops_spread_reviews_versions
  ON public.fieldops_spread_reviews (model_version, dataset_version, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fieldops_spread_changes_created
  ON public.fieldops_spread_changes (created_at DESC);

DROP TRIGGER IF EXISTS trg_fieldops_spread_materials_updated_at ON public.fieldops_spread_materials;
CREATE TRIGGER trg_fieldops_spread_materials_updated_at
  BEFORE UPDATE ON public.fieldops_spread_materials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_hazards_updated_at ON public.fieldops_spread_hazards;
CREATE TRIGGER trg_fieldops_spread_hazards_updated_at
  BEFORE UPDATE ON public.fieldops_spread_hazards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_exposure_updated_at ON public.fieldops_spread_exposure;
CREATE TRIGGER trg_fieldops_spread_exposure_updated_at
  BEFORE UPDATE ON public.fieldops_spread_exposure
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_spread_weather_updated_at ON public.fieldops_spread_weather_effects;
CREATE TRIGGER trg_fieldops_spread_weather_updated_at
  BEFORE UPDATE ON public.fieldops_spread_weather_effects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_spread_materials IS
  'WS9 spread library (D31): how walls, contents and structural frames behave in fire. Seeded from reviewed files with a source per row; edits make the dataset Unreviewed. Service role only.';
COMMENT ON COLUMN public.fieldops_spread_materials.burn_through_s IS
  'Walls: seconds of fire on one side before the wall is breached. NULL means it holds for any session length.';
COMMENT ON TABLE public.fieldops_spread_hazards IS
  'WS9: how each scene hazard type reacts and grows. hazardEventsFor turns a row into today''s HazardEvent shape; deteriorationFactsFor quotes its fact lines.';
COMMENT ON TABLE public.fieldops_spread_exposure IS
  'WS9: exposure doses (fractional effective dose bands) and the share of a crowd group hurt at each threshold, per agent.';
COMMENT ON TABLE public.fieldops_spread_weather_effects IS
  'WS9: multipliers each weather condition applies to outdoor spread, plumes, observation, road and walking speed.';
COMMENT ON TABLE public.fieldops_spread_reviews IS
  'WS9 review record, modelled on WS6''s physics reviews. The latest row for a (model_version, dataset_version) decides the review state.';
COMMENT ON TABLE public.fieldops_spread_changes IS
  'WS9: every seed, edit and retirement of a stored row, with the dataset version before and after.';

ALTER TABLE public.fieldops_spread_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_hazards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_exposure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_weather_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_spread_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_spread_materials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_hazards FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_exposure FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_weather_effects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_spread_changes FROM PUBLIC, anon, authenticated;

COMMIT;
