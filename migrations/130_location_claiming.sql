-- Allow entry/exit pins to be claimed by teams during gameplay
ALTER TABLE scenario_locations
  ADD COLUMN IF NOT EXISTS claimable_by TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS claimed_by_team TEXT,
  ADD COLUMN IF NOT EXISTS claimed_as TEXT;
