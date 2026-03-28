-- Add team scoping to scenario equipment so each item is only shown to relevant teams.
ALTER TABLE scenario_equipment
  ADD COLUMN IF NOT EXISTS applicable_teams TEXT[] NOT NULL DEFAULT '{}';
