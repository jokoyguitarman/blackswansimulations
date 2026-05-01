-- Migration 166: Properly drop the unique index on scenario_injects(scenario_id, title)
-- Migration 143 tried DROP CONSTRAINT but the restriction was created as a unique INDEX in migration 108.
-- DROP CONSTRAINT doesn't remove indexes, so it was never actually dropped.
-- Social crisis scenarios generate per-team storylines with potentially similar titles.

DROP INDEX IF EXISTS uq_scenario_injects_scenario_title;
