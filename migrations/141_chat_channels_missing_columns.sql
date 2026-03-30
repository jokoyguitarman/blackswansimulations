-- Add missing columns to chat_channels that channelService.ts expects
ALTER TABLE chat_channels
  ADD COLUMN IF NOT EXISTS role_filter TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES user_profiles(id);
