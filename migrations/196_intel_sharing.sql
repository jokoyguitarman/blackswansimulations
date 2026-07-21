-- Migration 196: Cross-team intel sharing for the social media crisis module
-- (a) Allow the new intel_shared player action (recorded when a player relays
--     tagged intel from a team-scoped email to the team that needs it).
-- (b) collaboration column on team_score_snapshots: the new composite component
--     scoring whether a team shared the intel it held (NULL = team held none).
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
  'dispute_filed', 'dispute_upheld', 'dispute_rejected',
  'intel_shared'
));

ALTER TABLE team_score_snapshots ADD COLUMN IF NOT EXISTS collaboration NUMERIC;

COMMIT;
