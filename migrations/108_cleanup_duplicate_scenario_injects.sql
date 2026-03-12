-- 108: Clean up duplicate scenario_injects rows and add unique index to prevent recurrence.
--
-- Root cause: several inject-insertion migrations (025, 077, 092, 098, 101, 102, 105, etc.)
-- use plain INSERT with no ON CONFLICT guard. Re-running migrations (common in development)
-- silently accumulates duplicates. Migration 028 only cleaned decision-based injects;
-- time-based and condition-driven injects were never cleaned.
--
-- Strategy: for every (scenario_id, title) group keep the single oldest row (lowest UUID,
-- which correlates with insertion order). Then add a unique index so this cannot happen again.

DO $$
DECLARE
  total_before  INTEGER;
  total_after   INTEGER;
  deleted_count INTEGER;
BEGIN
  -- ── 1. Count before ──────────────────────────────────────────────────────────
  SELECT COUNT(*) INTO total_before FROM scenario_injects;
  RAISE NOTICE '108: scenario_injects rows BEFORE cleanup: %', total_before;

  -- ── 2. Delete all duplicates, keeping the oldest row per (scenario_id, title) ──
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY scenario_id, title
        ORDER BY created_at ASC, id ASC   -- oldest first; id as tiebreaker
      ) AS rn
    FROM scenario_injects
  )
  DELETE FROM scenario_injects
  WHERE id IN (
    SELECT id FROM ranked WHERE rn > 1
  );

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- ── 3. Count after ───────────────────────────────────────────────────────────
  SELECT COUNT(*) INTO total_after FROM scenario_injects;

  RAISE NOTICE '108: deleted % duplicate inject row(s).', deleted_count;
  RAISE NOTICE '108: scenario_injects rows AFTER cleanup: %', total_after;
END $$;

-- ── 4. Add unique index to prevent future duplicates ─────────────────────────
-- Using a unique index (not constraint) so it can be created CONCURRENTLY if needed later.
-- This will raise an error if duplicates still exist — the DO block above should have
-- cleared them all.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scenario_injects_scenario_title
  ON scenario_injects (scenario_id, title);

-- ── 5. Summary query ─────────────────────────────────────────────────────────
SELECT
  s.title                          AS scenario_title,
  COUNT(*)                         AS inject_count,
  COUNT(*) FILTER (WHERE si.trigger_time_minutes IS NOT NULL)           AS time_based,
  COUNT(*) FILTER (WHERE si.trigger_condition IS NOT NULL)              AS decision_based,
  COUNT(*) FILTER (
    WHERE si.trigger_time_minutes IS NULL AND si.trigger_condition IS NULL
  )                                                                     AS condition_driven
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
GROUP BY s.title
ORDER BY inject_count DESC;
