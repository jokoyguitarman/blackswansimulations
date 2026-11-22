-- Migration 259: seed runs, knowledge sources and coverage (D38, D39; master 10.8 item 42).
-- WS9, docs/field-ops/11-living-world.md section 5.17. Added 22 Nov 2026.
--
-- Additive and idempotent. Every writer checks the tables exist and skips provenance when they do not;
-- no library depends on them to load. Service role only: row level security on with no policy.
--
-- Rollback, tried on a branch database only, never on the shared project:
--   DROP FUNCTION IF EXISTS public.fieldops_record_gap(TEXT, TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.fieldops_knowledge_coverage;
--   DROP TABLE IF EXISTS public.fieldops_knowledge_sources;
--   DROP TABLE IF EXISTS public.fieldops_seed_runs;
BEGIN;

CREATE TABLE IF NOT EXISTS public.fieldops_seed_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library TEXT NOT NULL CHECK (library IN ('doctrines', 'devices', 'spread', 'threats', 'building_hazards', 'movement', 'units', 'hospitals',
    'blast_effects', 'fire_smoke_tenability')), -- the last two added 22 Nov 2026 (D62)
  run_kind TEXT NOT NULL CHECK (run_kind IN ('agent', 'person', 'import')),
  agent_model TEXT CHECK (agent_model IS NULL OR char_length(agent_model) BETWEEN 2 AND 120),
  brief_key TEXT CHECK (brief_key IS NULL OR brief_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  brief_hash TEXT CHECK (brief_hash IS NULL OR brief_hash ~ '^[0-9a-f]{64}$'),
  output_hash TEXT CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  rows_drafted INTEGER NOT NULL DEFAULT 0 CHECK (rows_drafted >= 0),
  rows_refused INTEGER NOT NULL DEFAULT 0 CHECK (rows_refused >= 0),
  rows_imported INTEGER NOT NULL DEFAULT 0 CHECK (rows_imported >= 0),
  sources_cited INTEGER NOT NULL DEFAULT 0 CHECK (sources_cited >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  imported_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  CONSTRAINT fieldops_seed_runs_agent CHECK (run_kind <> 'agent' OR (agent_model IS NOT NULL AND brief_hash IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_sources (
  source_key TEXT PRIMARY KEY CHECK (source_key ~ '^[a-z0-9][a-z0-9_.:-]{2,119}$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 300),
  publisher TEXT NOT NULL CHECK (char_length(publisher) BETWEEN 2 AND 200),
  url TEXT CHECK (url IS NULL OR (char_length(url) <= 1000 AND url ~ '^https://')),
  published_on DATE,
  accessed_on DATE NOT NULL,
  language TEXT NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),
  terms_note TEXT NOT NULL CHECK (char_length(terms_note) BETWEEN 3 AND 300),
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  review_interval_days INTEGER NOT NULL DEFAULT 365 CHECK (review_interval_days BETWEEN 30 AND 1825),
  next_review_due DATE NOT NULL,
  libraries TEXT[] NOT NULL CHECK (cardinality(libraries) >= 1),
  first_run_id UUID REFERENCES public.fieldops_seed_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fieldops_knowledge_coverage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  library TEXT NOT NULL CHECK (library IN ('doctrines', 'devices', 'spread', 'threats', 'building_hazards', 'movement', 'units', 'hospitals',
    'blast_effects', 'fire_smoke_tenability')), -- the last two added 22 Nov 2026 (D62)
  country TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  subject_key TEXT NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('covered', 'assumed', 'gap')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 400),
  sources_checked INTEGER NOT NULL DEFAULT 0 CHECK (sources_checked >= 0),
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
  last_run_id UUID REFERENCES public.fieldops_seed_runs(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fieldops_knowledge_coverage_subject
  ON public.fieldops_knowledge_coverage (library, COALESCE(country, '--'), subject_key);
CREATE INDEX IF NOT EXISTS idx_fieldops_knowledge_sources_due
  ON public.fieldops_knowledge_sources (next_review_due) WHERE status = 'active';

-- A loader that found no row records the gap once and counts later hits. It never downgrades 'covered'.
CREATE OR REPLACE FUNCTION public.fieldops_record_gap(p_library TEXT, p_country TEXT, p_subject TEXT, p_note TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.fieldops_knowledge_coverage (library, country, subject_key, status, note, hits)
  VALUES (p_library, p_country, p_subject, 'gap', left(p_note, 400), 1)
  ON CONFLICT (library, COALESCE(country, '--'), subject_key) DO UPDATE
    SET hits = public.fieldops_knowledge_coverage.hits + 1, updated_at = now();
$$;

DROP TRIGGER IF EXISTS trg_fieldops_knowledge_sources_updated_at ON public.fieldops_knowledge_sources;
CREATE TRIGGER trg_fieldops_knowledge_sources_updated_at BEFORE UPDATE ON public.fieldops_knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.fieldops_seed_runs IS
  'WS9 knowledge pipeline (D39): one row per drafting, person or import run of a library.';
COMMENT ON TABLE public.fieldops_knowledge_sources IS
  'WS9: every source a seeded row cites, with its access date and review-due date. URLs are shown to admins only.';
COMMENT ON TABLE public.fieldops_knowledge_coverage IS
  'WS9 (D38): what each library covers, assumes or lacks, per country and subject. Gaps are recorded by loaders, never filled by a model.';

ALTER TABLE public.fieldops_seed_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fieldops_knowledge_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fieldops_seed_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_knowledge_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fieldops_knowledge_coverage FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fieldops_record_gap(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fieldops_record_gap(TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
