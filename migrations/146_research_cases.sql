-- Research cases: persistent knowledge base of real-world incidents used for scenario generation.
-- Avoids repeated internet lookups by caching research results and matching on scenario type,
-- weapon class, and setting tags.

CREATE TABLE IF NOT EXISTS research_cases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  normalized_name TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  timeline TEXT,
  adversary_behavior TEXT,
  other_actors TEXT,
  environment TEXT,
  outcome TEXT,
  casualties_killed INTEGER,
  casualties_injured INTEGER,
  num_attackers INTEGER,
  weapon_description TEXT,
  weapon_forensics TEXT,
  damage_radius_m REAL,
  hazards_triggered TEXT[],
  secondary_effects TEXT[],
  injury_breakdown TEXT,
  crowd_response TEXT,
  response_time_minutes REAL,
  containment_time_minutes REAL,
  environment_factors TEXT[],
  scenario_types TEXT[] NOT NULL DEFAULT '{}',
  weapon_classes TEXT[] NOT NULL DEFAULT '{}',
  setting_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_cases_scenario_types ON research_cases USING GIN (scenario_types);
CREATE INDEX IF NOT EXISTS idx_research_cases_weapon_classes ON research_cases USING GIN (weapon_classes);
CREATE INDEX IF NOT EXISTS idx_research_cases_setting_tags ON research_cases USING GIN (setting_tags);

-- Links scenarios to the research cases that informed their generation.
CREATE TABLE IF NOT EXISTS scenario_research_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  research_case_id UUID NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  relevance_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scenario_id, research_case_id)
);

CREATE INDEX IF NOT EXISTS idx_scenario_research_usage_scenario ON scenario_research_usage(scenario_id);

CREATE TRIGGER update_research_cases_updated_at BEFORE UPDATE ON research_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
