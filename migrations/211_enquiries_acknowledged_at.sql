-- Records whether the enquirer received their own confirmation email, separately
-- from whether the team was notified. Without this we cannot answer "they say
-- they never got a confirmation" without guessing.

ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

COMMENT ON COLUMN enquiries.acknowledged_at IS 'When the confirmation email to the enquirer was sent. Null means they were never acknowledged.';
