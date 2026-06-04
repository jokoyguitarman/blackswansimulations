-- Migration 183: Add shared_article_id to social_posts for news article link previews
BEGIN;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS shared_article_id UUID REFERENCES sim_news_articles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_shared_article ON social_posts(shared_article_id) WHERE shared_article_id IS NOT NULL;
COMMIT;
