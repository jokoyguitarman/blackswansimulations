-- Migration 257: the building-hazard catalogue and its interaction rules (D42; master 10.8 item 43).
-- WS9, docs/field-ops/11-living-world.md section 5.15. Added 22 Nov 2026.
--
-- Additive and idempotent. loadCatalogue answers null until these tables hold a complete active catalogue,
-- so applying the file changes no running behaviour: WS5's dossier uses the generic building type, labelled
-- Assumed. agent_key and threat_key name rows of migration 258 by text, checked by the loaders, so this file
-- applies on its own. Service role only: row level security on with no policy, privileges revoked.
--
-- Rollback, tried on a branch database only, never on the shared project:
--   DROP TABLE IF EXISTS public.fieldops_hazard_interactions;
--   DROP TABLE IF EXISTS public.fieldops_building_items;
--   DROP TABLE IF EXISTS public.fieldops_hazard_item_kinds;
--   DROP TABLE IF EXISTS public.fieldops_building_types;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_building_types (
  type_key TEXT PRIMARY KEY CHECK (type_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  country TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  place_classes TEXT[] NOT NULL DEFAULT '{}',
  -- Added 22 Nov 2026: each entry is either a bare value, meaning the OSM tag building=<value>, or a key=value pair
  -- for another OSM tag ('amenity=food_court'); lower case, matching ^[a-z0-9_:]+(=[a-z0-9_:;]+)?$, checked by
  -- buildingTypeRowSchema. Version 1 matches bare values only, because WS3 keeps only the raw building tag.
  building_tags TEXT[] NOT NULL DEFAULT '{}',
  priority SMALLINT NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  storey_height_m NUMERIC(4, 2) NOT NULL CHECK (storey_height_m BETWEEN 2.4 AND 12),
  basement_storey_height_m NUMERIC(4, 2) NOT NULL CHECK (basement_storey_height_m BETWEEN 2.4 AND 8),
  contents_key TEXT NOT NULL REFERENCES public.fieldops_spread_materials(material_key) ON UPDATE CASCADE,
  frame_key TEXT NOT NULL REFERENCES public.fieldops_spread_materials(material_key) ON UPDATE CASCADE,
  sprinklered_permille INTEGER NOT NULL CHECK (sprinklered_permille BETWEEN 0 AND 1000),
  smoke_control BOOLEAN NOT NULL DEFAULT false,
  facade_class TEXT NOT NULL CHECK (facade_class IN ('curtain_wall_glass', 'masonry', 'concrete_panel', 'metal_cladding', 'open')),
  external_spread_permille INTEGER NOT NULL DEFAULT 0 CHECK (external_spread_permille BETWEEN 0 AND 1000),
  occupant_m2_per_person NUMERIC(6, 2) CHECK (occupant_m2_per_person IS NULL OR occupant_m2_per_person BETWEEN 0.3 AND 200),
  -- Added 22 Nov 2026 (D51): permille of the design occupancy at each hour 0 to 23, weekday then weekend.
  occupancy_by_hour SMALLINT[] NOT NULL DEFAULT '{}' CHECK (cardinality(occupancy_by_hour) IN (0, 48)),
  familiarity TEXT NOT NULL DEFAULT 'mixed' CHECK (familiarity IN ('familiar', 'mixed', 'unfamiliar')),
  sensitivity TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public', 'restricted_generic')),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_hazard_item_kinds (
  kind_key TEXT PRIMARY KEY CHECK (kind_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  category TEXT NOT NULL CHECK (category IN ('flammable_gas', 'flammable_liquid', 'toxic_chemical', 'oxidiser',
    'pressurised_gas', 'electrical', 'battery', 'fuel_store', 'combustible_store', 'explosive_store', 'mitigation', 'utility')),
  phase TEXT NOT NULL CHECK (phase IN ('gas', 'liquefied_gas', 'liquid', 'solid', 'equipment', 'system')),
  agent_key TEXT CHECK (agent_key IS NULL OR agent_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  contents_key TEXT REFERENCES public.fieldops_spread_materials(material_key) ON UPDATE CASCADE,
  threat_keys TEXT[] NOT NULL DEFAULT '{}',
  stored_pressure_bar NUMERIC(7, 2) CHECK (stored_pressure_bar IS NULL OR stored_pressure_bar BETWEEN 0 AND 400),
  flash_point_c NUMERIC(6, 1) CHECK (flash_point_c IS NULL OR flash_point_c BETWEEN -200 AND 400),
  mitigates TEXT CHECK (mitigates IS NULL OR mitigates IN ('fire_growth', 'smoke', 'gas', 'power')),
  activation_c NUMERIC(5, 1) CHECK (activation_c IS NULL OR activation_c BETWEEN 40 AND 300),
  -- Added 22 Nov 2026 (research gap): response time index, (m·s)^0.5. With it, activation follows the standard
  -- heat-detector response model in the ceiling jet; without it, the plain temperature threshold above.
  rti NUMERIC(6, 1) CHECK (rti IS NULL OR rti BETWEEN 10 AND 500),
  sensitivity TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public', 'restricted_generic')),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_hazard_item_kinds_explosive CHECK (category <> 'explosive_store' OR (sensitivity = 'restricted_generic' AND threat_keys = '{}')),
  CONSTRAINT fieldops_hazard_item_kinds_mitigation CHECK ((category = 'mitigation') = (mitigates IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.fieldops_building_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_key TEXT NOT NULL REFERENCES public.fieldops_building_types(type_key) ON UPDATE CASCADE,
  kind_key TEXT NOT NULL REFERENCES public.fieldops_hazard_item_kinds(kind_key) ON UPDATE CASCADE,
  location_kind TEXT NOT NULL CHECK (location_kind IN ('basement', 'ground', 'roof', 'plant_room', 'kitchen', 'loading_bay',
    'car_park', 'retail_floor', 'office_floor', 'process_area', 'tank_farm', 'store', 'laboratory', 'external_yard', 'any')),
  quantity_band TEXT NOT NULL CHECK (quantity_band IN ('small', 'medium', 'large', 'category_only')),
  quantity_low NUMERIC(12, 2),
  quantity_high NUMERIC(12, 2),
  quantity_unit TEXT CHECK (quantity_unit IS NULL OR quantity_unit IN ('kg', 'l', 'm3', 'count', 'kwh', 'kva')),
  likelihood_permille INTEGER NOT NULL CHECK (likelihood_permille BETWEEN 0 AND 1000),
  per_storey BOOLEAN NOT NULL DEFAULT false,
  auto_place BOOLEAN NOT NULL DEFAULT true,
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_building_items_unique UNIQUE (type_key, kind_key, location_kind),
  CONSTRAINT fieldops_building_items_quantity CHECK (
    (quantity_band = 'category_only' AND quantity_low IS NULL AND quantity_high IS NULL AND quantity_unit IS NULL)
    OR (quantity_band <> 'category_only' AND quantity_low IS NOT NULL AND quantity_high IS NOT NULL
        AND quantity_unit IS NOT NULL AND quantity_low <= quantity_high)
  )
);

CREATE TABLE IF NOT EXISTS public.fieldops_hazard_interactions (
  rule_key TEXT PRIMARY KEY CHECK (rule_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  kind_key TEXT NOT NULL REFERENCES public.fieldops_hazard_item_kinds(kind_key) ON UPDATE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('overpressure_kpa', 'impulse_kpa_ms', 'fire_exposure_s', 'ceiling_temp_c',
    'radiant_kw_m2', 'structural_state', 'vehicle_impact_kj', 'flood_depth_m', 'power_loss', 'gas_in_flammable_range')),
  -- Added 22 Nov 2026: the threshold's scale by trigger. A rule fires when the measured value reaches the threshold.
  --   overpressure_kpa kPa; impulse_kpa_ms kPa·ms; fire_exposure_s seconds; ceiling_temp_c °C; radiant_kw_m2 kW/m²;
  --   vehicle_impact_kj kJ; flood_depth_m metres;
  --   structural_state the state's ordinal: 1 damaged, 2 unsafe, 3 collapsed (sound is 0), as section 6.7.4 names them;
  --   gas_in_flammable_range a fraction of the agent's lower flammable limit, the rule firing at or above it and below the
  --     upper limit: 1.0 means inside the range, 0.25 means at 25 per cent of the lower limit (a detector alarm level);
  --   power_loss 1 (power lost).
  threshold NUMERIC(10, 3) NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('rupture_release', 'ignite', 'pool_fire', 'jet_fire', 'flash_fire', 'vapour_cloud_ignition',
    'vessel_burst', 'fireball', 'toxic_combustion_products', 'electrical_arc', 'thermal_runaway', 'oxygen_enrichment',
    'loss_of_function', 'activate', 'power_loss', 'collapse_local')),
  threat_key TEXT CHECK (threat_key IS NULL OR threat_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  agent_key TEXT CHECK (agent_key IS NULL OR agent_key ~ '^[a-z][a-z0-9_]{1,47}$'),
  delay_low_s INTEGER NOT NULL DEFAULT 0 CHECK (delay_low_s BETWEEN 0 AND 3600),
  delay_high_s INTEGER NOT NULL DEFAULT 0 CHECK (delay_high_s BETWEEN 0 AND 3600),
  probability_permille INTEGER NOT NULL DEFAULT 1000 CHECK (probability_permille BETWEEN 0 AND 1000),
  requires_ignition_source BOOLEAN NOT NULL DEFAULT false,
  event_text TEXT NOT NULL CHECK (char_length(event_text) BETWEEN 3 AND 200),
  source_keys TEXT[] NOT NULL DEFAULT '{}',
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 3 AND 300),
  source_note TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 400),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_hazard_interactions_delay CHECK (delay_low_s <= delay_high_s),
  CONSTRAINT fieldops_hazard_interactions_release CHECK (effect <> 'rupture_release' OR agent_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_fieldops_building_items_type ON public.fieldops_building_items (type_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fieldops_hazard_interactions_kind ON public.fieldops_hazard_interactions (kind_key) WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_fieldops_building_types_updated_at ON public.fieldops_building_types;
CREATE TRIGGER trg_fieldops_building_types_updated_at BEFORE UPDATE ON public.fieldops_building_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_hazard_item_kinds_updated_at ON public.fieldops_hazard_item_kinds;
CREATE TRIGGER trg_fieldops_hazard_item_kinds_updated_at BEFORE UPDATE ON public.fieldops_hazard_item_kinds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_building_items_updated_at ON public.fieldops_building_items;
CREATE TRIGGER trg_fieldops_building_items_updated_at BEFORE UPDATE ON public.fieldops_building_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS trg_fieldops_hazard_interactions_updated_at ON public.fieldops_hazard_interactions;
CREATE TRIGGER trg_fieldops_hazard_interactions_updated_at BEFORE UPDATE ON public.fieldops_hazard_interactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_building_types IS
  'WS9 building-hazard catalogue (D42): generic building types, never a named site. Seeded from reviewed files with sources. Service role only.';
COMMENT ON TABLE public.fieldops_building_items IS
  'WS9: what a building of a type typically holds, where, in what quantity band and how often. restricted_generic kinds are category only and never auto-placed.';
COMMENT ON TABLE public.fieldops_hazard_interactions IS
  'WS9: interaction rules. A trigger on an item kind past its threshold gives an effect after a delay with a probability, evaluated by the world.';

ALTER TABLE public.fieldops_building_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_hazard_item_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_building_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_hazard_interactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_building_types FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_hazard_item_kinds FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_building_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_hazard_interactions FROM PUBLIC, anon, authenticated;

COMMIT;
