-- Migration 035: Add source and headline fields to media_posts, update sentiment constraint
-- Fixes schema mismatch between database (platform/author) and frontend/API (source/headline)

-- Add new columns (nullable for backward compatibility)
ALTER TABLE media_posts 
  ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE media_posts 
  ADD COLUMN IF NOT EXISTS headline TEXT;

-- Migrate existing data: map platform to source, author to headline
-- For source: use platform value or a friendly name
UPDATE media_posts 
SET source = CASE 
  WHEN platform = 'twitter' THEN 'Twitter'
  WHEN platform = 'facebook' THEN 'Facebook'
  WHEN platform = 'news' THEN 'News Media'
  WHEN platform = 'citizen_report' THEN 'Citizen Report'
  ELSE platform
END
WHERE source IS NULL;

-- For headline: use author as headline (author was likely meant to be the headline/title)
UPDATE media_posts 
SET headline = author
WHERE headline IS NULL AND author IS NOT NULL;

-- Set defaults for any remaining nulls
UPDATE media_posts 
SET source = 'News Media'
WHERE source IS NULL;

UPDATE media_posts 
SET headline = 'Media Report'
WHERE headline IS NULL;

-- Now make source and headline NOT NULL (after setting defaults)
ALTER TABLE media_posts 
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE media_posts 
  ALTER COLUMN headline SET NOT NULL;

-- Update sentiment constraint to include 'critical' (frontend expects it)
ALTER TABLE media_posts 
  DROP CONSTRAINT IF EXISTS media_posts_sentiment_check;

ALTER TABLE media_posts 
  ADD CONSTRAINT media_posts_sentiment_check 
  CHECK (sentiment IN ('positive', 'neutral', 'negative', 'critical'));

-- Add comments
COMMENT ON COLUMN media_posts.source IS 'Display name of the media source (e.g., "News Media", "Citizen Report")';
COMMENT ON COLUMN media_posts.headline IS 'Headline/title of the media post';
COMMENT ON COLUMN media_posts.platform IS 'Platform type (kept for backward compatibility)';
COMMENT ON COLUMN media_posts.author IS 'Author/author name (kept for backward compatibility)';

