-- Migration 202: country scoping for public content (contract §4.1, runtime plan §4.2).
-- Idempotent.
--
-- `country` = display name from initial_state.orgs[].country. NULL = visible in every country.
-- Replies / reposts inherit the parent's country through a trigger so every engine that
-- creates follow-on posts (reactions, hive threads, antagonist replies, engagement) is covered
-- without per-service changes.

ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE sim_news_articles ADD COLUMN IF NOT EXISTS country TEXT;

CREATE INDEX IF NOT EXISTS idx_social_posts_country ON social_posts (session_id, country);
CREATE INDEX IF NOT EXISTS idx_news_country ON sim_news_articles (session_id, country);

CREATE OR REPLACE FUNCTION social_posts_inherit_country()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_country TEXT;
BEGIN
  IF NEW.country IS NULL THEN
    IF NEW.reply_to_post_id IS NOT NULL THEN
      SELECT country INTO parent_country FROM social_posts WHERE id = NEW.reply_to_post_id;
    ELSIF NEW.original_post_id IS NOT NULL THEN
      SELECT country INTO parent_country FROM social_posts WHERE id = NEW.original_post_id;
    END IF;
    IF parent_country IS NOT NULL THEN
      NEW.country := parent_country;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_social_posts_inherit_country ON social_posts;
CREATE TRIGGER trg_social_posts_inherit_country
  BEFORE INSERT ON social_posts
  FOR EACH ROW EXECUTE FUNCTION social_posts_inherit_country();

COMMENT ON COLUMN social_posts.country IS
  'Country whose feeds show this post (initial_state.orgs[].country). NULL = everywhere. Inherited from the parent on replies/reposts.';
COMMENT ON COLUMN sim_news_articles.country IS
  'Country whose News app shows this article. NULL = everywhere.';
