-- Add join link support to sessions table
-- Allows participants to join via a shareable link without email invitation

-- Step 1: Add columns (nullable initially for safe backfill)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS join_token VARCHAR(20) UNIQUE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS join_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS join_expires_at TIMESTAMPTZ;

-- Step 2: Backfill existing sessions with unique tokens
-- Uses gen_random_bytes to create URL-safe random strings
DO $$
DECLARE
  r RECORD;
  v_token TEXT;
  v_collision BOOLEAN;
BEGIN
  FOR r IN SELECT id, scheduled_start_time FROM sessions WHERE join_token IS NULL
  LOOP
    v_collision := true;
    WHILE v_collision LOOP
      -- Generate a 20-char base64url token
      v_token := replace(replace(encode(gen_random_bytes(15), 'base64'), '+', '-'), '/', '_');
      v_token := left(v_token, 20);
      -- Check for collision
      SELECT EXISTS(SELECT 1 FROM sessions WHERE join_token = v_token) INTO v_collision;
    END LOOP;

    UPDATE sessions
    SET
      join_token = v_token,
      join_enabled = true,
      join_expires_at = COALESCE(r.scheduled_start_time + INTERVAL '2 hours', NOW() + INTERVAL '24 hours')
    WHERE id = r.id;
  END LOOP;
END $$;

-- Step 3: Now make join_token NOT NULL
ALTER TABLE sessions ALTER COLUMN join_token SET NOT NULL;

-- Step 4: Add index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_sessions_join_token ON sessions(join_token);
CREATE INDEX IF NOT EXISTS idx_sessions_join_enabled ON sessions(join_enabled) WHERE join_enabled = true;
