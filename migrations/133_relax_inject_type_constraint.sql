-- Relax the type CHECK constraint on scenario_injects to allow new types
-- like 'field_update' from deterioration cycles and AI-generated injects.
-- The original constraint only allowed 7 hardcoded types from the initial schema.
ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_type_check;
