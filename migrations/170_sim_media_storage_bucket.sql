-- Migration 170: Create sim-media storage bucket for generated images
-- This bucket stores DALL-E generated images for social media posts.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('sim-media', 'sim-media', true, 10485760)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to all files in the bucket
DO $$ BEGIN
  CREATE POLICY "Public read access for sim-media"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sim-media');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Allow service role to insert/update/delete
DO $$ BEGIN
  CREATE POLICY "Service role full access for sim-media"
  ON storage.objects FOR ALL
  USING (bucket_id = 'sim-media')
  WITH CHECK (bucket_id = 'sim-media');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
