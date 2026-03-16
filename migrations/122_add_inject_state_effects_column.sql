-- Add a separate JSONB column for inject-triggered state effects.
-- Only injectPublishEffectsService writes to this column, so it cannot
-- be clobbered by the counter scheduler or any other current_state writer.
-- The frontend and condition evaluator merge both columns at read time.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS inject_state_effects JSONB NOT NULL DEFAULT '{}'::jsonb;
