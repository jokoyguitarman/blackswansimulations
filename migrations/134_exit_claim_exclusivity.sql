-- Add claim_exclusivity column to scenario_locations for entry/exit pins
-- Values: 'exclusive' (only claiming team uses it) or 'shared' (all teams may use it)
ALTER TABLE scenario_locations
  ADD COLUMN IF NOT EXISTS claim_exclusivity TEXT;
