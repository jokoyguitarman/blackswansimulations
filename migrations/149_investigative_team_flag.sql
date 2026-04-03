-- Add investigative team designation for pursuit metrics tracking
ALTER TABLE scenario_teams
  ADD COLUMN IF NOT EXISTS is_investigative BOOLEAN DEFAULT FALSE;
