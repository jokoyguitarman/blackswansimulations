-- Scenario casualties: individual patient, crowd, and evacuee group pins
CREATE TABLE IF NOT EXISTS scenario_casualties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  casualty_type TEXT NOT NULL CHECK (casualty_type IN ('patient', 'crowd', 'evacuee_group')),
  location_lat FLOAT NOT NULL,
  location_lng FLOAT NOT NULL,
  floor_level TEXT NOT NULL DEFAULT 'G',
  headcount INT NOT NULL DEFAULT 1,
  -- injuries, mobility, behavior, mixed_wounded, deterioration_timeline, etc.
  conditions JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'undiscovered'
    CHECK (status IN (
      'undiscovered','identified','being_evacuated','at_assembly',
      'endorsed_to_triage','in_treatment','endorsed_to_transport',
      'transported','resolved','deceased'
    )),
  assigned_team TEXT,
  linked_decision_id UUID REFERENCES decisions(id) ON DELETE SET NULL,
  appears_at_minutes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenario_casualties_scenario ON scenario_casualties(scenario_id);
CREATE INDEX IF NOT EXISTS idx_scenario_casualties_session ON scenario_casualties(session_id);
CREATE INDEX IF NOT EXISTS idx_scenario_casualties_session_status ON scenario_casualties(session_id, status);
