-- Add inject_id field to incidents table to track which inject created the incident
-- This allows filtering incidents based on inject scope (universal, role_specific, team_specific)

ALTER TABLE incidents 
  ADD COLUMN IF NOT EXISTS inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL;

-- Add index for performance when filtering incidents by inject_id
CREATE INDEX IF NOT EXISTS idx_incidents_inject_id 
  ON incidents(inject_id) 
  WHERE inject_id IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN incidents.inject_id IS 'ID of the inject that created this incident (if created from an inject). Used for filtering incidents based on inject scope.';

