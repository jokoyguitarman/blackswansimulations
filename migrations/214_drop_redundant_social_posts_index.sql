-- Migration 214: drop idx_social_posts_algorithm_sort (docs/simulation-runtime-performance-plan.md
-- §1.1a). Idempotent.
--
-- (session_id, virality_score DESC, created_at DESC) is a superset of idx_social_posts_virality
-- (session_id, virality_score DESC), and the only virality-ordered query has no created_at
-- tiebreaker, so the planner already serves the feed from the smaller index. Dropping it reclaims
-- 25 MB and halves index maintenance for the engagement loop's per-post virality updates.
--
-- idx_social_posts_session_id and idx_session_events_session are kept even though the composites
-- from 213 cover them: deduplication keeps them at ~3 MB against 9 MB and 18 MB, and they remain
-- the cheaper path for session-only lookups.
--
-- Plain DROP INDEX (brief exclusive lock on social_posts), applied while no exercise was live.

DROP INDEX IF EXISTS public.idx_social_posts_algorithm_sort;
