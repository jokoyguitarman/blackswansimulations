ALTER TABLE public.rts_scene_configs
  ADD COLUMN IF NOT EXISTS levels JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.rts_scene_configs.levels IS
  'RTS editor storeys: [{id,name,index,heightM,designed,pedestrianCount}]. Empty = single ground storey.';
