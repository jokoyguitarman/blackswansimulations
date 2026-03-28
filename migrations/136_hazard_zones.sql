-- Hidden ground-truth zones per hazard (hot/warm/cold) for AI evaluation.
-- Players never see this data; they must draw and classify zones themselves.
ALTER TABLE scenario_hazards
  ADD COLUMN IF NOT EXISTS zones JSONB NOT NULL DEFAULT '[]';
