-- Migration 016: Add Team Assignment Support to Incidents
-- Allows incidents to be assigned to both agency roles and operational teams

-- Add assignment_type column to distinguish between agency_role and team assignments
ALTER TABLE incident_assignments 
  ADD COLUMN IF NOT EXISTS assignment_type VARCHAR(20) DEFAULT 'agency_role' 
    CHECK (assignment_type IN ('agency_role', 'team'));

-- Add team_name column for team assignments (nullable)
ALTER TABLE incident_assignments 
  ADD COLUMN IF NOT EXISTS team_name VARCHAR(100);

-- Make agency_role nullable (since it won't be used for team assignments)
ALTER TABLE incident_assignments 
  ALTER COLUMN agency_role DROP NOT NULL;

-- Add constraint to ensure either agency_role OR team_name is set (but not both)
ALTER TABLE incident_assignments 
  ADD CONSTRAINT incident_assignments_assignment_check 
  CHECK (
    (assignment_type = 'agency_role' AND agency_role IS NOT NULL AND team_name IS NULL) OR
    (assignment_type = 'team' AND team_name IS NOT NULL AND agency_role IS NULL)
  );

-- Backfill existing assignments as 'agency_role' type
UPDATE incident_assignments 
SET assignment_type = 'agency_role' 
WHERE assignment_type IS NULL;

-- Drop the old unique constraint/index if it exists
DROP INDEX IF EXISTS idx_incident_assignments_active_unique;

-- Create new partial unique indexes for both assignment types
-- For agency_role assignments
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_assignments_agency_role_unique
  ON incident_assignments(incident_id, agency_role)
  WHERE unassigned_at IS NULL AND assignment_type = 'agency_role' AND agency_role IS NOT NULL;

-- For team assignments
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_assignments_team_unique
  ON incident_assignments(incident_id, team_name)
  WHERE unassigned_at IS NULL AND assignment_type = 'team' AND team_name IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN incident_assignments.assignment_type IS 'Type of assignment: agency_role (assigned to agency role) or team (assigned to operational team)';
COMMENT ON COLUMN incident_assignments.team_name IS 'Name of the team this incident is assigned to (used when assignment_type = team)';
COMMENT ON COLUMN incident_assignments.agency_role IS 'Agency role this incident is assigned to (used when assignment_type = agency_role)';

