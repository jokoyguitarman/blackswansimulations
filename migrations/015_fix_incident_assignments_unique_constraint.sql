-- Fix incident_assignments unique constraint
-- Replace the UNIQUE constraint with a partial unique index that only applies to active assignments
-- This allows reassigning an agency after it was unassigned

-- Drop the existing UNIQUE constraint
ALTER TABLE incident_assignments 
  DROP CONSTRAINT IF EXISTS incident_assignments_incident_id_agency_role_key;

-- Create a partial unique index that only applies when unassigned_at IS NULL
-- This ensures only one active assignment per (incident_id, agency_role) pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_assignments_active_unique
  ON incident_assignments(incident_id, agency_role)
  WHERE unassigned_at IS NULL;

-- Add comment explaining the constraint
COMMENT ON INDEX idx_incident_assignments_active_unique IS 
  'Ensures only one active assignment per incident and agency role. Allows reassignment after unassignment.';

