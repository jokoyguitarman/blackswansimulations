-- Create storage bucket for scenario map images (vicinity + layout).
-- Used by scenarioMapImageService when generating maps via POST /scenarios/:id/generate-maps.
-- Bucket should be public read so that vicinity_map_url and layout_image_url work in briefing/Insider.
-- If this INSERT fails (e.g. id type is uuid), create the bucket manually: Dashboard > Storage > New bucket, name "scenario-assets", public.

INSERT INTO storage.buckets (id, name, public)
VALUES ('scenario-assets', 'scenario-assets', true)
ON CONFLICT (id) DO UPDATE SET public = true;
