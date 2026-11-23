ALTER TABLE public.rts_scene_configs
  ADD COLUMN IF NOT EXISTS placed_objects JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.rts_scene_configs.placed_objects IS
  'Objects a trainer placed on studs: description, library matches, and confirmed. Unconfirmed rows are stored and do not burn.';
