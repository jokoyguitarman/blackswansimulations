-- Migration: Fix AAR Reports Schema
-- Adds missing fields that the code expects: key_decisions and timeline_summary

-- Add key_decisions JSONB field to store structured decision data
ALTER TABLE aar_reports 
ADD COLUMN IF NOT EXISTS key_decisions JSONB DEFAULT '[]'::jsonb;

-- Add timeline_summary JSONB field to store chronological event timeline
ALTER TABLE aar_reports 
ADD COLUMN IF NOT EXISTS timeline_summary JSONB DEFAULT '[]'::jsonb;

-- Add comment to document the field
COMMENT ON COLUMN aar_reports.key_decisions IS 'Array of key decisions made during the session, stored as JSONB for flexible structure';
COMMENT ON COLUMN aar_reports.timeline_summary IS 'Chronological summary of session events, stored as JSONB array of event objects';

