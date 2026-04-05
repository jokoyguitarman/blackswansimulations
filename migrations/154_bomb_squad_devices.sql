-- Sweep device pool: array of device profiles to be attached to newly placed assets
ALTER TABLE scenarios
  ADD COLUMN IF NOT EXISTS sweep_device_pool JSONB DEFAULT '[]';

-- Session-level copies (pool depletes per session independently)
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS sweep_device_pool JSONB DEFAULT '[]';

-- Hidden devices: records of devices silently attached to placed assets (invisible until swept)
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS hidden_devices JSONB DEFAULT '[]';

-- Detonation deadline for live bombs (NULL = not live or already resolved)
ALTER TABLE scenario_hazards
  ADD COLUMN IF NOT EXISTS detonation_deadline TIMESTAMPTZ DEFAULT NULL;
