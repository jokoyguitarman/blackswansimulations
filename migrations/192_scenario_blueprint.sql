-- Migration 192: Document-driven scenario blueprint
-- Adds a nullable jsonb column to store the structured ScenarioBlueprint extracted
-- from a trainer's design document. Nullable + default NULL means existing
-- scenarios are unaffected and the runtime treats absence as "no blueprint".
-- A copy is also nested under scenarios.initial_state.blueprint at persist time so
-- runtime engines that already read initial_state need no new query.
BEGIN;

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS blueprint JSONB DEFAULT NULL;

COMMIT;
