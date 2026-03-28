-- Player triage assessment: allows responders to tag casualties with their own triage color
ALTER TABLE scenario_casualties
  ADD COLUMN IF NOT EXISTS player_triage_color TEXT,
  ADD COLUMN IF NOT EXISTS assessed_by TEXT,
  ADD COLUMN IF NOT EXISTS assessed_at_minutes INT;
