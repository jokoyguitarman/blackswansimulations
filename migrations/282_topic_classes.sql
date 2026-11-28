-- Migration 282: topic classes on social posts, direct messages and emails.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   ALTER TABLE social_posts DROP COLUMN IF EXISTS topic_kind;
--   ALTER TABLE social_posts DROP COLUMN IF EXISTS topic_class;
--   ALTER TABLE social_posts DROP COLUMN IF EXISTS topic_confidence;
--   ALTER TABLE social_posts DROP COLUMN IF EXISTS topic_bridge;
--   ALTER TABLE sim_direct_messages DROP COLUMN IF EXISTS topic_class;
--   ALTER TABLE sim_emails DROP COLUMN IF EXISTS topic_class;

ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS topic_kind text NOT NULL DEFAULT 'crisis' CHECK (topic_kind IN ('crisis','normal'));
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS topic_class text CHECK (topic_class IN ('on_topic','bridge','off_topic','crisis','unclassified'));
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS topic_confidence real;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS topic_bridge text;
ALTER TABLE sim_direct_messages ADD COLUMN IF NOT EXISTS topic_class text CHECK (topic_class IN ('on_topic','bridge','off_topic','crisis','unclassified'));
ALTER TABLE sim_emails ADD COLUMN IF NOT EXISTS topic_class text CHECK (topic_class IN ('on_topic','bridge','off_topic','crisis','unclassified'));
UPDATE social_posts SET topic_kind = 'normal' WHERE is_branded_history = true;
