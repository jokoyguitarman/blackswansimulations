-- Add image_prompt column to social_posts for storing player media descriptions
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS image_prompt TEXT;
