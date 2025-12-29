-- Migration 017: Add Direct Messaging Support
-- Adds 'direct' channel type for private one-on-one messaging

-- Update chat_channels type constraint to include 'direct'
ALTER TABLE chat_channels
  DROP CONSTRAINT IF EXISTS chat_channels_type_check;

ALTER TABLE chat_channels
  ADD CONSTRAINT chat_channels_type_check 
  CHECK (type IN ('public', 'inter_agency', 'private', 'command', 'trainer', 'role_specific', 'direct'));

-- Add index for querying DM channels by members
CREATE INDEX IF NOT EXISTS idx_chat_channels_members ON chat_channels USING GIN (members);

-- Add comment explaining direct channel structure
COMMENT ON COLUMN chat_channels.members IS 'For direct channels: JSONB array of two user IDs [user1_id, user2_id]. For other channels: array of member user IDs or empty array.';

