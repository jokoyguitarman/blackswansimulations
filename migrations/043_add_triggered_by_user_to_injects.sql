-- Add triggered_by_user_id to scenario_injects for AI-generated injects
-- This allows AI-generated injects to be visible only to the decision maker who triggered them

ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS triggered_by_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

-- Add comment for documentation
COMMENT ON COLUMN scenario_injects.triggered_by_user_id IS 'For AI-generated injects: the user_id of the decision maker who triggered this inject. If set, the inject is only visible to this user (and trainers/admins).';

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_scenario_injects_triggered_by_user 
  ON scenario_injects(triggered_by_user_id) 
  WHERE triggered_by_user_id IS NOT NULL;

