-- Pre-Session Workflow Migration
-- Adds support for briefing materials, lobby, ready status, and trainer instructions

-- Add briefing fields to scenarios
ALTER TABLE scenarios 
  ADD COLUMN IF NOT EXISTS briefing TEXT,
  ADD COLUMN IF NOT EXISTS role_specific_briefs JSONB DEFAULT '{}'::jsonb;

-- Add trainer instructions and scheduled start time to sessions
ALTER TABLE sessions 
  ADD COLUMN IF NOT EXISTS trainer_instructions TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_start_time TIMESTAMPTZ;

-- Add ready status and lobby tracking to session participants
ALTER TABLE session_participants 
  ADD COLUMN IF NOT EXISTS is_ready BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS joined_lobby_at TIMESTAMPTZ;

-- Create index for ready status queries
CREATE INDEX IF NOT EXISTS idx_session_participants_ready 
  ON session_participants(session_id, is_ready) 
  WHERE is_ready = true;

-- Add comment for documentation
COMMENT ON COLUMN scenarios.briefing IS 'General briefing material visible to all participants';
COMMENT ON COLUMN scenarios.role_specific_briefs IS 'JSONB object with role-specific briefing content, keyed by role name';
COMMENT ON COLUMN sessions.trainer_instructions IS 'Final instructions from trainer visible in lobby';
COMMENT ON COLUMN sessions.scheduled_start_time IS 'Planned start time for the session';
COMMENT ON COLUMN session_participants.is_ready IS 'Whether participant has marked themselves as ready';
COMMENT ON COLUMN session_participants.joined_lobby_at IS 'When participant first entered the lobby';

