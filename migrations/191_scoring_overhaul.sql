-- Migration 191: Scoring overhaul
-- (a) Allow dispute_* player actions that were being rejected by the action_type CHECK
--     (their recordPlayerAction inserts were failing silently, undermining fact-check SOP credit).
-- (b) Add violation reason + validity columns to social_post_flags for scored reporting.
BEGIN;

ALTER TABLE player_actions DROP CONSTRAINT IF EXISTS player_actions_action_type_check;
ALTER TABLE player_actions ADD CONSTRAINT player_actions_action_type_check CHECK (action_type IN (
  'post_created', 'reply_posted', 'post_liked', 'post_reposted',
  'post_flagged', 'post_reported', 'dm_sent', 'dm_read', 'email_sent',
  'email_read', 'call_answered', 'call_declined', 'news_read',
  'fact_checked', 'draft_created', 'draft_submitted_for_approval',
  'draft_approved', 'draft_published', 'escalated', 'chat_message_sent',
  'content_graded', 'misinfo_flagged',
  'group_post_created', 'group_joined', 'event_created', 'event_responded', 'event_discussed',
  'dispute_filed', 'dispute_upheld', 'dispute_rejected'
));

ALTER TABLE social_post_flags ADD COLUMN IF NOT EXISTS violation_category TEXT;
ALTER TABLE social_post_flags ADD COLUMN IF NOT EXISTS reason_text TEXT;
ALTER TABLE social_post_flags ADD COLUMN IF NOT EXISTS is_valid_report BOOLEAN;

COMMIT;
