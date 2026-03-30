-- Index for efficient session-scoped queries after pin cloning
CREATE INDEX IF NOT EXISTS idx_scenario_casualties_session_id ON scenario_casualties (session_id);
CREATE INDEX IF NOT EXISTS idx_scenario_hazards_session_id ON scenario_hazards (session_id);
