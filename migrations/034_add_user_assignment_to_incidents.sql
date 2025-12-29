-- Migration 034: Add User-Based Assignment Support to Incidents
-- Allows incidents to be assigned to specific users (players) instead of just roles

-- Add user_id column to incident_assignments for user-based assignments
ALTER TABLE incident_assignments 
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

-- Update assignment_type to include 'user' option
ALTER TABLE incident_assignments 
  DROP CONSTRAINT IF EXISTS incident_assignments_assignment_type_check;

ALTER TABLE incident_assignments 
  ADD CONSTRAINT incident_assignments_assignment_type_check 
  CHECK (assignment_type IN ('agency_role', 'team', 'user'));

-- Update the assignment check constraint to allow user assignments
ALTER TABLE incident_assignments 
  DROP CONSTRAINT IF EXISTS incident_assignments_assignment_check;

ALTER TABLE incident_assignments 
  ADD CONSTRAINT incident_assignments_assignment_check 
  CHECK (
    (assignment_type = 'agency_role' AND agency_role IS NOT NULL AND team_name IS NULL AND user_id IS NULL) OR
    (assignment_type = 'team' AND team_name IS NOT NULL AND agency_role IS NULL AND user_id IS NULL) OR
    (assignment_type = 'user' AND user_id IS NOT NULL AND agency_role IS NULL AND team_name IS NULL)
  );

-- Create unique index for user assignments
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_assignments_user_unique
  ON incident_assignments(incident_id, user_id)
  WHERE unassigned_at IS NULL AND assignment_type = 'user' AND user_id IS NOT NULL;

-- Add index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_incident_assignments_user_id 
  ON incident_assignments(user_id);

-- Add comment
COMMENT ON COLUMN incident_assignments.user_id IS 'User (player) this incident is assigned to (used when assignment_type = user)';

