-- Migration 213: performance stage 1 (docs/app-load-performance-plan.md §3, §7;
-- docs/simulation-runtime-performance-plan.md §7a.1–7a.3). Idempotent.
--
-- Plain CREATE INDEX, because migrations run inside a transaction and CONCURRENTLY cannot.
-- Applied while no exercise was live: each build blocks writes to its table for a few seconds.
-- On a busy database, run each index as CREATE INDEX CONCURRENTLY, one statement per run.
--
-- The single-column indexes these replace are dropped in 214, once the planner is confirmed
-- to use the replacements.

-- One session's posts in time order. Same leading column as idx_social_posts_session_id, so it
-- serves every session_id lookup, and oldest-first reads (statement watchdog) stop walking the
-- table-wide created_at index through every finished exercise.
CREATE INDEX IF NOT EXISTS idx_social_posts_session_created
  ON public.social_posts (session_id, created_at);

-- Every post delete runs the foreign-key check for reposts pointing at it, which had no index and
-- scanned the whole table. Partial: only reposts set original_post_id.
CREATE INDEX IF NOT EXISTS idx_social_posts_original_post
  ON public.social_posts (original_post_id)
  WHERE original_post_id IS NOT NULL;

-- `session_id = ? AND event_type = ?` without intersecting a table-wide event_type bitmap.
CREATE INDEX IF NOT EXISTS idx_session_events_session_type_created
  ON public.session_events (session_id, event_type, created_at);

-- Template injects are the rows with no session; idx_scenario_injects_session_id covers the inverse.
CREATE INDEX IF NOT EXISTS idx_scenario_injects_template
  ON public.scenario_injects (scenario_id)
  WHERE session_id IS NULL;

-- Per-card counts for the scenario library in one call. A function rather than a grouped
-- select, because PostgREST caps every select at 1000 rows.
CREATE OR REPLACE FUNCTION public.scenario_library_counts(p_scenario_ids UUID[])
RETURNS TABLE (scenario_id UUID, teams BIGINT, injects BIGINT, crowd INTEGER)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    s.id,
    (SELECT count(*) FROM public.scenario_teams t WHERE t.scenario_id = s.id),
    (SELECT count(*) FROM public.scenario_injects i
      WHERE i.scenario_id = s.id AND i.session_id IS NULL),
    CASE WHEN jsonb_typeof(s.initial_state -> 'npc_personas') = 'array'
      THEN jsonb_array_length(s.initial_state -> 'npc_personas') ELSE 0 END
  FROM public.scenarios s
  WHERE s.id = ANY(p_scenario_ids)
$$;

-- Trainer dashboard tiles, with the same visibility as the list routes: a trainer sees their own
-- scenarios and sessions; p_trainer_id NULL means everyone's (admin).
CREATE OR REPLACE FUNCTION public.dashboard_stats(p_trainer_id UUID)
RETURNS TABLE (scenarios BIGINT, total_sessions BIGINT, active_sessions BIGINT, participants BIGINT)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT
    (SELECT count(*) FROM public.scenarios sc
      WHERE p_trainer_id IS NULL OR sc.created_by = p_trainer_id),
    (SELECT count(*) FROM public.sessions s
      WHERE p_trainer_id IS NULL OR s.trainer_id = p_trainer_id),
    (SELECT count(*) FROM public.sessions s
      WHERE (p_trainer_id IS NULL OR s.trainer_id = p_trainer_id) AND s.status = 'in_progress'),
    (SELECT count(DISTINCT sp.user_id) FROM public.session_participants sp
      JOIN public.sessions s ON s.id = sp.session_id
      WHERE p_trainer_id IS NULL OR s.trainer_id = p_trainer_id)
$$;

-- Server-only: both are called with the service role after the route has checked the caller.
REVOKE EXECUTE ON FUNCTION public.scenario_library_counts(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.scenario_library_counts(UUID[]) TO service_role;
REVOKE EXECUTE ON FUNCTION public.dashboard_stats(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dashboard_stats(UUID) TO service_role;
