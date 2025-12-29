-- Decision Steps Enhancement
-- Fixes schema mismatch and adds missing fields for multi-step approval chains
-- Run this in your Supabase SQL Editor

-- Add approver_role column if it doesn't exist (for backward compatibility)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'decision_steps' 
    AND column_name = 'approver_role'
  ) THEN
    ALTER TABLE decision_steps ADD COLUMN approver_role TEXT;
    -- Copy data from role to approver_role for existing records
    UPDATE decision_steps SET approver_role = role WHERE approver_role IS NULL;
  END IF;
END $$;

-- Add approved_by column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'decision_steps' 
    AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE decision_steps ADD COLUMN approved_by UUID REFERENCES user_profiles(id);
  END IF;
END $$;

-- Add approved_at column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'decision_steps' 
    AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE decision_steps ADD COLUMN approved_at TIMESTAMPTZ;
  END IF;
END $$;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_decision_steps_approver_role 
  ON decision_steps(approver_role) 
  WHERE approver_role IS NOT NULL;

-- Add comment
COMMENT ON TABLE decision_steps IS 'Tracks multi-step approval workflow for decisions';

