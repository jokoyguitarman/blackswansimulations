-- Migration 223: doctrine usage, reports and events (WS1, section 6.7).
-- Server-only: RLS on, no policy.
-- Added 3 Nov 2026 (D29, D30): doctrine_usage.country_match, the report reason wrong_country and the
-- event types document_uploaded and document_removed.
-- Rollback: DROP TABLE IF EXISTS public.doctrine_events; DROP TABLE IF EXISTS public.doctrine_reports;
--           DROP TABLE IF EXISTS public.doctrine_usage;
BEGIN;

CREATE TABLE IF NOT EXISTS public.doctrine_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctrine_id   UUID NOT NULL REFERENCES public.doctrines(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL CHECK (version >= 1),
  scenario_id   UUID NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  draft_id      UUID REFERENCES public.warroom_wizard_drafts(id) ON DELETE SET NULL,
  team_name     TEXT NOT NULL CHECK (char_length(team_name) BETWEEN 1 AND 100),
  archetype_key TEXT REFERENCES public.team_archetypes(key),
  used_by       UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  status_at_use TEXT NOT NULL CHECK (status_at_use IN ('unverified', 'verified')),
  -- Added 3 Nov 2026 (D29): how the doctrine's country met the card's at compile.
  country_match TEXT CHECK (country_match IS NULL OR country_match IN ('same', 'generic', 'other', 'unset')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doctrine_usage_one_per_team UNIQUE (scenario_id, team_name)
);
CREATE INDEX IF NOT EXISTS idx_doctrine_usage_doctrine ON public.doctrine_usage (doctrine_id, version);

CREATE TABLE IF NOT EXISTS public.doctrine_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctrine_id     UUID NOT NULL REFERENCES public.doctrines(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  reported_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Added 3 Nov 2026: wrong_country (D29, Choice 18).
  reason          TEXT NOT NULL CHECK (reason IN (
                    'inaccurate', 'unsafe', 'restricted_material', 'instructions_in_text', 'duplicate', 'other',
                    'wrong_country'
                  )),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  resolved_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT doctrine_reports_resolution_pair CHECK (status = 'open' OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctrine_reports_one_open
  ON public.doctrine_reports (doctrine_id, reported_by)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.doctrine_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctrine_id UUID REFERENCES public.doctrines(id) ON DELETE CASCADE,
  version     INTEGER CHECK (version IS NULL OR version >= 1),
  actor_id    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Added 3 Nov 2026: document_uploaded and document_removed (D30); their doctrine_id is null.
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'created', 'version_created', 'forked', 'shared', 'verified', 'retired', 'reinstated',
                'reported', 'report_resolved', 'seeded', 'imported', 'ai_draft_generated',
                'document_uploaded', 'document_removed'
              )),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctrine_events_doctrine ON public.doctrine_events (doctrine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doctrine_events_actor ON public.doctrine_events (actor_id, created_at DESC);

ALTER TABLE public.doctrine_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctrine_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctrine_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.doctrine_usage IS
  'Which doctrine version each compiled field-ops team used; written by WS5 through recordDoctrineUsage.';
COMMENT ON TABLE public.doctrine_reports IS 'Trainer reports on a doctrine; one open report per trainer and doctrine.';
COMMENT ON TABLE public.doctrine_events IS 'Audit trail of the doctrine library. details never holds doctrine text.';

COMMIT;
