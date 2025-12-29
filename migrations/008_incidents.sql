-- Incidents System Enhancement
-- Enhances existing incidents table and adds supporting tables for incident management
-- Run this in your Supabase SQL Editor

-- Update incidents table status enum to match gameplay requirements
-- Note: We'll use ALTER TYPE if possible, but PostgreSQL doesn't support modifying ENUM easily
-- So we'll add a comment and ensure the CHECK constraint allows the values we need

-- First, let's check if we need to modify the status constraint
-- The existing status has: 'reported', 'acknowledged', 'responding', 'resolved'
-- We need: 'active', 'resolved', 'under_control', 'contained'
-- We'll add a new column or modify the constraint

-- Add new status values by dropping and recreating the constraint
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check;

ALTER TABLE incidents 
  ADD CONSTRAINT incidents_status_check 
  CHECK (status IN (
    'reported',      -- Original values (for backward compatibility)
    'acknowledged',
    'responding',
    'resolved',
    'active',        -- New values for gameplay
    'under_control',
    'contained'
  ));

-- Add casualty_count field for tracking
ALTER TABLE incidents 
  ADD COLUMN IF NOT EXISTS casualty_count INTEGER DEFAULT 0;

-- Add assigned_to field (single primary assignee)
ALTER TABLE incidents 
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES user_profiles(id);

-- Add assigned_at timestamp
ALTER TABLE incidents 
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Add resolved_at timestamp
ALTER TABLE incidents 
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Create incident_assignments table for tracking multiple agency assignments
CREATE TABLE IF NOT EXISTS incident_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  agency_role TEXT NOT NULL,
  assigned_by UUID REFERENCES user_profiles(id),
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  unassigned_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(incident_id, agency_role) -- One assignment per role per incident
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_incident_assignments_incident_id 
  ON incident_assignments(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_assignments_agency_role 
  ON incident_assignments(agency_role);
CREATE INDEX IF NOT EXISTS idx_incident_assignments_active 
  ON incident_assignments(incident_id, agency_role) 
  WHERE unassigned_at IS NULL;

-- Create incident_updates table for status history
CREATE TABLE IF NOT EXISTS incident_updates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  updated_by UUID NOT NULL REFERENCES user_profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident_id 
  ON incident_updates(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_updates_created_at 
  ON incident_updates(created_at DESC);

-- Create index on incidents for common queries
CREATE INDEX IF NOT EXISTS idx_incidents_session_id 
  ON incidents(session_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status 
  ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity 
  ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_assigned_to 
  ON incidents(assigned_to) 
  WHERE assigned_to IS NOT NULL;

-- RLS Policies for incident_assignments
ALTER TABLE incident_assignments ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Session participants can view incident assignments" ON incident_assignments;
DROP POLICY IF EXISTS "Session participants can create incident assignments" ON incident_assignments;
DROP POLICY IF EXISTS "Session participants can update incident assignments" ON incident_assignments;

-- Session participants can view incident assignments
CREATE POLICY "Session participants can view incident assignments"
  ON incident_assignments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM incidents
      WHERE id = incident_assignments.incident_id
      AND (
        EXISTS (
          SELECT 1 FROM session_participants
          WHERE session_id = incidents.session_id
          AND user_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM sessions
          WHERE id = incidents.session_id
          AND trainer_id = auth.uid()
        )
      )
    )
  );

-- Session participants can create incident assignments
CREATE POLICY "Session participants can create incident assignments"
  ON incident_assignments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM incidents
      WHERE id = incident_assignments.incident_id
      AND EXISTS (
        SELECT 1 FROM session_participants
        WHERE session_id = incidents.session_id
        AND user_id = auth.uid()
      )
    )
  );

-- Session participants can update incident assignments
CREATE POLICY "Session participants can update incident assignments"
  ON incident_assignments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM incidents
      WHERE id = incident_assignments.incident_id
      AND EXISTS (
        SELECT 1 FROM session_participants
        WHERE session_id = incidents.session_id
        AND user_id = auth.uid()
      )
    )
  );

-- RLS Policies for incident_updates
ALTER TABLE incident_updates ENABLE ROW LEVEL SECURITY;

-- Drop policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Session participants can view incident updates" ON incident_updates;
DROP POLICY IF EXISTS "Session participants can create incident updates" ON incident_updates;

-- Session participants can view incident updates
CREATE POLICY "Session participants can view incident updates"
  ON incident_updates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM incidents
      WHERE id = incident_updates.incident_id
      AND (
        EXISTS (
          SELECT 1 FROM session_participants
          WHERE session_id = incidents.session_id
          AND user_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM sessions
          WHERE id = incidents.session_id
          AND trainer_id = auth.uid()
        )
      )
    )
  );

-- Session participants can create incident updates
CREATE POLICY "Session participants can create incident updates"
  ON incident_updates FOR INSERT
  WITH CHECK (
    updated_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM incidents
      WHERE id = incident_updates.incident_id
      AND EXISTS (
        SELECT 1 FROM session_participants
        WHERE session_id = incidents.session_id
        AND user_id = auth.uid()
      )
    )
  );

-- Add UPDATE policy for incidents (missing from original)
DROP POLICY IF EXISTS "Session participants can update incidents" ON incidents;

CREATE POLICY "Session participants can update incidents"
  ON incidents FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = incidents.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = incidents.session_id
      AND trainer_id = auth.uid()
    )
  );

-- Add comments for documentation
COMMENT ON COLUMN incidents.casualty_count IS 'Number of casualties associated with this incident';
COMMENT ON COLUMN incidents.assigned_to IS 'Primary user assigned to handle this incident';
COMMENT ON COLUMN incidents.assigned_at IS 'When the incident was assigned';
COMMENT ON COLUMN incidents.resolved_at IS 'When the incident was resolved';
COMMENT ON TABLE incident_assignments IS 'Tracks which agencies/roles are assigned to incidents';
COMMENT ON TABLE incident_updates IS 'History of status changes for incidents';

