-- Migration 221: team archetypes (WS1, docs/field-ops/02-teams-and-doctrines.md section 5.2).
-- The closed list of archetype keys (master plan 10.1). Labels, descriptions, aliases and default
-- rosters are tunable here; capabilities live in code (shared/fieldOps/archetypes.ts) because they
-- name code keys. Null columns mean "use the code catalogue". Server-only: RLS on, no policy.
-- Added 3 Nov 2026 (master D29, 10.8 item 37): extra aliases are rows of team_archetype_aliases, each
-- with a kind, a country (ISO 3166-1 alpha-2, null for a phrase that means the same everywhere) and
-- the agency it names. The table replaces the aliases array team_archetypes carried before.
-- Rollback (only after 222 to 225 are rolled back, because doctrines reference this table):
--   DROP TABLE IF EXISTS public.team_archetype_aliases;
--   DROP TABLE IF EXISTS public.team_archetypes;
BEGIN;

CREATE TABLE IF NOT EXISTS public.team_archetypes (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 60),
  description    TEXT CHECK (description IS NULL OR char_length(description) <= 400),
  -- Added 3 Nov 2026: the aliases array is replaced by team_archetype_aliases below.
  default_roster JSONB CHECK (default_roster IS NULL OR jsonb_typeof(default_roster) = 'array'),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  sort_order     SMALLINT NOT NULL DEFAULT 100,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_archetypes_key_closed CHECK (key IN (
    'bomb_disposal_eod', 'medical_triage', 'fire_rescue', 'evacuation_crowd', 'media_comms',
    'pursuit_investigation', 'incident_command', 'police_security',
    'transport_operator', 'venue_operations', 'hospital_ed', 'utilities', 'ministry_liaison',
    -- Added 22 Nov 2026 (D40): amended in place, because 221 is not applied.
    'tactical_response', 'military_support', 'cbrn_defence'
  ))
);

INSERT INTO public.team_archetypes (key, label, sort_order) VALUES
  ('incident_command', 'Incident Command', 10),
  ('police_security', 'Police / Security', 20),
  ('fire_rescue', 'Fire & Rescue', 30),
  ('medical_triage', 'Medical Triage', 40),
  ('bomb_disposal_eod', 'Bomb Disposal / EOD', 50),
  ('evacuation_crowd', 'Evacuation & Crowd', 60),
  ('media_comms', 'Media & Communications', 70),
  ('pursuit_investigation', 'Pursuit & Investigation', 80),
  ('transport_operator', 'Transport Operator', 90),
  ('venue_operations', 'Venue Operations', 100),
  ('hospital_ed', 'Hospital / ED', 110),
  ('utilities', 'Utilities', 120),
  ('ministry_liaison', 'Ministry Liaison', 130),
  ('tactical_response', 'Tactical Response', 140),
  ('military_support', 'Military Support', 150),
  ('cbrn_defence', 'CBRN Defence', 160)
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS update_team_archetypes_updated_at ON public.team_archetypes;
CREATE TRIGGER update_team_archetypes_updated_at BEFORE UPDATE ON public.team_archetypes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Added 3 Nov 2026 (D29): aliases with a country and an agency, seeded from the reviewed registers
-- of section 6.11.2. A phrase is stored as normaliseTeamText gives it.
CREATE TABLE IF NOT EXISTS public.team_archetype_aliases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  archetype_key TEXT NOT NULL REFERENCES public.team_archetypes(key) ON DELETE CASCADE,
  phrase        TEXT NOT NULL CHECK (char_length(phrase) BETWEEN 2 AND 80 AND phrase = lower(phrase)),
  kind          TEXT NOT NULL CHECK (kind IN ('exact', 'function', 'organisation')),
  country       TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  agency_name   TEXT CHECK (agency_name IS NULL OR char_length(agency_name) BETWEEN 2 AND 120),
  source        TEXT NOT NULL DEFAULT 'seeded' CHECK (source IN ('seeded', 'admin')),
  source_ref    TEXT CHECK (source_ref IS NULL OR char_length(source_ref) <= 200),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT team_archetype_aliases_org_agency CHECK (
    kind <> 'organisation' OR country IS NULL OR agency_name IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_archetype_aliases
  ON public.team_archetype_aliases (archetype_key, phrase, COALESCE(country, ''));
CREATE INDEX IF NOT EXISTS idx_team_archetype_aliases_active
  ON public.team_archetype_aliases (archetype_key)
  WHERE is_active;

ALTER TABLE public.team_archetypes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_archetype_aliases ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.team_archetypes IS
  'Field-ops team archetypes (closed list). Tunable label, description and default roster; capabilities are in code.';
COMMENT ON TABLE public.team_archetype_aliases IS
  'Extra normalised alias phrases per archetype, with the country and agency they name; added to the code catalogue''s aliases, never replacing them.';
COMMENT ON COLUMN public.team_archetype_aliases.country IS
  'ISO 3166-1 alpha-2 in upper case; null for a phrase that means the same in every country.';

COMMIT;
