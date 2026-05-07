-- Migration 172: Add social media notification types

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'decision_approval_required', 'decision_approved', 'decision_rejected', 'decision_executed',
  'inject_published', 'incident_reported', 'incident_assigned', 'incident_updated',
  'chat_message', 'resource_request', 'resource_approved', 'resource_rejected', 'system_alert',
  'social_reply', 'social_like', 'social_mention', 'social_repost'
));
