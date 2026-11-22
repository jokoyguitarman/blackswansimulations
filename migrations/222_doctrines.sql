-- Migration 222: the doctrine library (WS1, docs/field-ops/02-teams-and-doctrines.md section 5.4).
-- doctrines: one row per doctrine (a lineage of versions); doctrine_versions: immutable content.
-- Review status is per version; retirement is per doctrine. Server-only: RLS on, no policy; the
-- three functions are executable by the service role only.
-- Added 3 Nov 2026 (master D29, D30, 10.8 item 37): a doctrine carries the country it is grouped
-- under (null for a generic doctrine) and the agency it was written for, both fixed for its life;
-- a library title is unique per archetype and country; doctrine_source_documents keeps the
-- sanitised text of an uploaded doctrine document, never the file, for at most 30 days.
-- Rollback:
--   DROP FUNCTION IF EXISTS public.fieldops_verify_doctrine_version(UUID, INTEGER, UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.fieldops_create_doctrine_version(UUID, INTEGER, TEXT, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], UUID);
--   DROP FUNCTION IF EXISTS public.fieldops_create_doctrine(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, INTEGER, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.doctrine_source_documents;
--   DROP TABLE IF EXISTS public.doctrine_versions; DROP TABLE IF EXISTS public.doctrines;
BEGIN;

CREATE TABLE IF NOT EXISTS public.doctrines (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  archetype_key           TEXT NOT NULL REFERENCES public.team_archetypes(key),
  title                   TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  -- Updated 22 Nov 2026 (D58, Choice 27): 'custom' and 'organisation' for establishment doctrines.
  source                  TEXT NOT NULL CHECK (source IN ('seeded', 'trainer', 'ai_drafted', 'imported', 'custom')),
  visibility              TEXT NOT NULL DEFAULT 'library' CHECK (visibility IN ('library', 'private', 'organisation')),
  client_organisation_id  UUID REFERENCES public.client_organisations(id) ON DELETE CASCADE,
  establishment_type      TEXT CHECK (establishment_type IS NULL OR establishment_type IN
                            ('private_security', 'auxiliary_police', 'establishment_ert', 'venue_operations')),
  venue_scope             JSONB CHECK (venue_scope IS NULL OR jsonb_typeof(venue_scope) = 'object'),
  owner_id                UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  scope_draft_id          UUID REFERENCES public.warroom_wizard_drafts(id) ON DELETE SET NULL,
  parent_doctrine_id      UUID REFERENCES public.doctrines(id) ON DELETE SET NULL,
  parent_version          INTEGER CHECK (parent_version IS NULL OR parent_version >= 1),
  applies_to              TEXT[] NOT NULL DEFAULT '{}'::text[],
  latest_version          INTEGER NOT NULL DEFAULT 1 CHECK (latest_version >= 1),
  latest_verified_version INTEGER CHECK (latest_verified_version IS NULL OR latest_verified_version >= 1),
  retired_at              TIMESTAMPTZ,
  retired_by              UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  retired_reason          TEXT CHECK (retired_reason IS NULL OR char_length(retired_reason) <= 500),
  -- Added 3 Nov 2026 (D29): the country and the agency, fixed for the doctrine's life (Choice 18).
  country                 TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  agency_name             TEXT CHECK (agency_name IS NULL OR char_length(agency_name) BETWEEN 2 AND 120),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doctrines_applies_to_known CHECK (applies_to <@ ARRAY[
    'bombing', 'car_bomb', 'suicide_bombing', 'bombing_mall', 'open_field_shooting',
    'knife_attack', 'gas_attack', 'poisoning', 'kidnapping', 'hijacking',
    -- Updated 22 Nov 2026 (D46, D48): every key of INCIDENT_TYPE_KEYS.
    'building_fire', 'utility_failure', 'arson', 'stampede_crush', 'vehicle_ramming', 'aircraft_impact', 'gas_explosion',
    'chemical_release', 'structural_collapse', 'rail_incident', 'road_collision', 'flash_flood', 'biohazard',
    'maritime_incident', 'earthquake', 'active_shooter'
  ]::text[]),
  -- Added 22 Nov 2026 (Choice 27): an organisation doctrine is custom, owned and scoped to one client organisation.
  CONSTRAINT doctrines_organisation_scope CHECK (
    (visibility = 'organisation') = (source = 'custom')
    AND (visibility <> 'organisation' OR (owner_id IS NOT NULL AND establishment_type IS NOT NULL))
  ),
  CONSTRAINT doctrines_parent_version_needs_parent CHECK (parent_doctrine_id IS NULL OR parent_version IS NOT NULL),
  CONSTRAINT doctrines_verified_not_after_latest CHECK (
    latest_verified_version IS NULL OR latest_verified_version <= latest_version
  )
);

CREATE TABLE IF NOT EXISTS public.doctrine_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctrine_id    UUID NOT NULL REFERENCES public.doctrines(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version >= 1),
  title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  applies_to     TEXT[] NOT NULL DEFAULT '{}'::text[],
  content        JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_hash   TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  content_bytes  INTEGER NOT NULL CHECK (content_bytes BETWEEN 2 AND 24576),
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  ai_drafted     BOOLEAN NOT NULL DEFAULT false,
  source_note    TEXT CHECK (source_note IS NULL OR char_length(source_note) <= 300),
  -- Added 3 Nov 2026 (D30): the text hash of the uploaded document this version was drafted from.
  source_document_sha256 TEXT CHECK (source_document_sha256 IS NULL OR source_document_sha256 ~ '^[0-9a-f]{64}$'),
  screen_flags   TEXT[] NOT NULL DEFAULT '{}'::text[],
  review_status  TEXT NOT NULL DEFAULT 'unverified' CHECK (review_status IN ('unverified', 'verified')),
  reviewed_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doctrine_versions_unique UNIQUE (doctrine_id, version),
  CONSTRAINT doctrine_versions_screen_flags_known CHECK (screen_flags <@ ARRAY[
    'instruction_like', 'markup_removed', 'link_removed', 'contact_details', 'device_wording'
  ]::text[]),
  CONSTRAINT doctrine_versions_review_pair CHECK (review_status = 'unverified' OR reviewed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_doctrines_archetype ON public.doctrines (archetype_key);
CREATE INDEX IF NOT EXISTS idx_doctrine_versions_doctrine ON public.doctrine_versions (doctrine_id, version DESC);
-- Added 3 Nov 2026: a library title is unique per archetype and country, so two countries' agencies
-- can each have "Fire & Rescue: urban bombing response".
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctrines_library_title
  ON public.doctrines (archetype_key, COALESCE(country, ''), lower(title))
  WHERE visibility = 'library' AND retired_at IS NULL;
-- Added 3 Nov 2026: resolution and the library browser read by archetype and country.
CREATE INDEX IF NOT EXISTS idx_doctrines_country
  ON public.doctrines (archetype_key, country)
  WHERE visibility = 'library' AND retired_at IS NULL;

-- Added 3 Nov 2026 (D30, section 6.13): the sanitised text of an uploaded doctrine document. The
-- file is never stored. A row is deleted when its uploader removes it, when its draft or its
-- uploader's account is deleted, or after expires_at, and an expired row is never served.
CREATE TABLE IF NOT EXISTS public.doctrine_source_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  draft_id       UUID NOT NULL REFERENCES public.warroom_wizard_drafts(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 200),
  mime           TEXT NOT NULL CHECK (mime IN (
                   'application/pdf',
                   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                   'text/plain'
                 )),
  byte_size      INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  file_sha256    TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  pages          INTEGER CHECK (pages IS NULL OR pages BETWEEN 1 AND 10000),
  word_count     INTEGER NOT NULL CHECK (word_count >= 0),
  chars_original INTEGER NOT NULL CHECK (chars_original >= 1),
  chars_kept     INTEGER NOT NULL CHECK (chars_kept BETWEEN 1 AND 50000),
  truncated      BOOLEAN NOT NULL DEFAULT false,
  text           TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 50000),
  text_sha256    TEXT NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  screen_flags   TEXT[] NOT NULL DEFAULT '{}'::text[],
  country        TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  agency_name    TEXT CHECK (agency_name IS NULL OR char_length(agency_name) BETWEEN 2 AND 120),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT doctrine_source_documents_expiry CHECK (expires_at > created_at),
  CONSTRAINT doctrine_source_documents_flags_known CHECK (screen_flags <@ ARRAY[
    'instruction_like', 'markup_removed', 'link_removed', 'contact_details'
  ]::text[])
);
CREATE INDEX IF NOT EXISTS idx_doctrine_source_documents_owner
  ON public.doctrine_source_documents (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doctrine_source_documents_text
  ON public.doctrine_source_documents (created_by, text_sha256);
CREATE INDEX IF NOT EXISTS idx_doctrine_source_documents_expiry
  ON public.doctrine_source_documents (expires_at);

DROP TRIGGER IF EXISTS update_doctrines_updated_at ON public.doctrines;
CREATE TRIGGER update_doctrines_updated_at BEFORE UPDATE ON public.doctrines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One doctrine and its version 1, in one transaction.
-- Added 3 Nov 2026: p_country, p_agency_name and p_source_document_sha256 (D29, D30). The route checks
-- that the source document is the caller's and unexpired before it passes the document's text hash.
CREATE OR REPLACE FUNCTION public.fieldops_create_doctrine(
  p_archetype_key TEXT, p_title TEXT, p_source TEXT, p_visibility TEXT, p_owner_id UUID,
  p_scope_draft_id UUID, p_parent_doctrine_id UUID, p_parent_version INTEGER, p_applies_to TEXT[],
  p_content JSONB, p_content_hash TEXT, p_content_bytes INTEGER, p_ai_drafted BOOLEAN,
  p_source_note TEXT, p_screen_flags TEXT[],
  p_country TEXT, p_agency_name TEXT, p_source_document_sha256 TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.doctrines (archetype_key, title, source, visibility, owner_id, scope_draft_id,
                                parent_doctrine_id, parent_version, applies_to, latest_version,
                                country, agency_name)
  VALUES (p_archetype_key, p_title, p_source, p_visibility, p_owner_id, p_scope_draft_id,
          p_parent_doctrine_id, p_parent_version, COALESCE(p_applies_to, '{}'::text[]), 1,
          p_country, p_agency_name)
  RETURNING id INTO v_id;

  INSERT INTO public.doctrine_versions (doctrine_id, version, title, applies_to, content, content_hash,
                                        content_bytes, ai_drafted, source_note, screen_flags, created_by,
                                        source_document_sha256)
  VALUES (v_id, 1, p_title, COALESCE(p_applies_to, '{}'::text[]), p_content, p_content_hash,
          p_content_bytes, COALESCE(p_ai_drafted, false), p_source_note,
          COALESCE(p_screen_flags, '{}'::text[]), p_owner_id, p_source_document_sha256);

  RETURN jsonb_build_object('ok', true, 'doctrine_id', v_id, 'version', 1);
END;
$$;

-- A new version, refused unless p_base_version is still the latest.
CREATE OR REPLACE FUNCTION public.fieldops_create_doctrine_version(
  p_doctrine_id UUID, p_base_version INTEGER, p_title TEXT, p_applies_to TEXT[], p_content JSONB,
  p_content_hash TEXT, p_content_bytes INTEGER, p_ai_drafted BOOLEAN, p_source_note TEXT,
  p_screen_flags TEXT[], p_created_by UUID
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_latest INTEGER;
  v_retired TIMESTAMPTZ;
  v_next INTEGER;
BEGIN
  SELECT d.latest_version, d.retired_at INTO v_latest, v_retired
    FROM public.doctrines d
   WHERE d.id = p_doctrine_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_NOT_FOUND');
  END IF;
  IF v_retired IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_RETIRED');
  END IF;
  IF v_latest <> p_base_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_VERSION_CONFLICT', 'latest_version', v_latest);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.doctrine_versions dv
     WHERE dv.doctrine_id = p_doctrine_id AND dv.version = v_latest
       AND dv.content_hash = p_content_hash AND dv.title = p_title
       AND dv.applies_to = COALESCE(p_applies_to, '{}'::text[])
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_UNCHANGED');
  END IF;

  v_next := v_latest + 1;
  INSERT INTO public.doctrine_versions (doctrine_id, version, title, applies_to, content, content_hash,
                                        content_bytes, ai_drafted, source_note, screen_flags, created_by)
  VALUES (p_doctrine_id, v_next, p_title, COALESCE(p_applies_to, '{}'::text[]), p_content, p_content_hash,
          p_content_bytes, COALESCE(p_ai_drafted, false), p_source_note,
          COALESCE(p_screen_flags, '{}'::text[]), p_created_by);
  UPDATE public.doctrines
     SET latest_version = v_next, title = p_title, applies_to = COALESCE(p_applies_to, '{}'::text[])
   WHERE id = p_doctrine_id;

  RETURN jsonb_build_object('ok', true, 'doctrine_id', p_doctrine_id, 'version', v_next);
END;
$$;

-- An admin verifies one version of a library doctrine.
CREATE OR REPLACE FUNCTION public.fieldops_verify_doctrine_version(
  p_doctrine_id UUID, p_version INTEGER, p_admin_id UUID, p_note TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_retired TIMESTAMPTZ;
  v_visibility TEXT;
  v_status TEXT;
BEGIN
  SELECT d.retired_at, d.visibility INTO v_retired, v_visibility
    FROM public.doctrines d
   WHERE d.id = p_doctrine_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_NOT_FOUND');
  END IF;
  IF v_retired IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_RETIRED');
  END IF;
  IF v_visibility <> 'library' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_PRIVATE');
  END IF;
  SELECT dv.review_status INTO v_status
    FROM public.doctrine_versions dv
   WHERE dv.doctrine_id = p_doctrine_id AND dv.version = p_version;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_VERSION_NOT_FOUND');
  END IF;
  IF v_status = 'verified' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCTRINE_ALREADY_VERIFIED');
  END IF;

  UPDATE public.doctrine_versions
     SET review_status = 'verified', reviewed_by = p_admin_id, reviewed_at = now(), review_note = p_note
   WHERE doctrine_id = p_doctrine_id AND version = p_version;
  UPDATE public.doctrines
     SET latest_verified_version = GREATEST(COALESCE(latest_verified_version, 0), p_version)
   WHERE id = p_doctrine_id;

  RETURN jsonb_build_object('ok', true, 'doctrine_id', p_doctrine_id, 'version', p_version);
END;
$$;

-- Added 3 Nov 2026: the create function's signature gains three TEXT parameters.
REVOKE ALL ON FUNCTION public.fieldops_create_doctrine(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, INTEGER, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_create_doctrine_version(UUID, INTEGER, TEXT, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_verify_doctrine_version(UUID, INTEGER, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fieldops_create_doctrine(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, INTEGER, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], TEXT, TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fieldops_create_doctrine_version(UUID, INTEGER, TEXT, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], UUID) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fieldops_verify_doctrine_version(UUID, INTEGER, UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_create_doctrine(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, INTEGER, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_create_doctrine_version(UUID, INTEGER, TEXT, TEXT[], JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_verify_doctrine_version(UUID, INTEGER, UUID, TEXT) TO service_role;

ALTER TABLE public.doctrines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctrine_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctrine_source_documents ENABLE ROW LEVEL SECURITY; -- added 3 Nov 2026

COMMENT ON TABLE public.doctrines IS
  'Field-ops doctrine library: one row per doctrine. visibility private = "use in this scenario only".';
COMMENT ON TABLE public.doctrine_versions IS
  'Immutable doctrine content (DoctrineContent JSON). Review status is per version.';
COMMENT ON COLUMN public.doctrine_versions.screen_flags IS
  'What the save-time screen removed or flagged; flagged versions are shown first in the admin queue.';
-- Added 3 Nov 2026 (D29, D30).
COMMENT ON COLUMN public.doctrines.country IS
  'ISO 3166-1 alpha-2 in upper case of the country the doctrine is grouped under; null for a generic doctrine.';
COMMENT ON TABLE public.doctrine_source_documents IS
  'Sanitised text of an uploaded doctrine document, never the file; read by its uploader and admins only; kept at most 30 days.';

-- Added 22 Nov 2026 (D58, D59, Choice 28): custom documents stay with their client organisation; legal ceilings are preset.
ALTER TABLE public.doctrine_source_documents
  ADD COLUMN IF NOT EXISTS client_organisation_id UUID REFERENCES public.client_organisations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS custom BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.doctrine_force_ceilings (
  country            TEXT NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  establishment_type TEXT NOT NULL CHECK (establishment_type IN ('private_security', 'auxiliary_police', 'establishment_ert', 'venue_operations')),
  ceiling_levels     TEXT[] NOT NULL,
  legal_authorities  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(legal_authorities) = 'array'),
  reserved_functions TEXT[] NOT NULL DEFAULT '{}',
  source_note        TEXT NOT NULL CHECK (char_length(source_note) BETWEEN 3 AND 300),
  review_status      TEXT NOT NULL DEFAULT 'unverified' CHECK (review_status IN ('unverified', 'verified')),
  PRIMARY KEY (country, establishment_type)
);
ALTER TABLE public.doctrine_force_ceilings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.doctrine_force_ceilings FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.doctrine_force_ceilings IS
  'Preset legal ceiling on the use of force of a custom team per country and establishment type (D59). Seeded from public law, reviewed.';

COMMIT;
