-- Migration 011: Team Assignments and Enhanced Inject Scoping
-- Adds support for team-based scenarios and role/team-specific inject delivery

-- ============================================
-- PART 1: Team Assignment System
-- ============================================

-- Scenario Teams: Define teams available in a scenario
CREATE TABLE IF NOT EXISTS scenario_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  team_name VARCHAR(100) NOT NULL,
  team_description TEXT,
  required_roles TEXT[], -- Roles that can be assigned to this team
  min_participants INTEGER DEFAULT 1,
  max_participants INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scenario_id, team_name)
);

-- Session Teams: Assign users to teams within a session
CREATE TABLE IF NOT EXISTS session_teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  team_name VARCHAR(100) NOT NULL,
  team_role VARCHAR(100), -- Optional: specific role within the team (e.g., "lead", "coordinator")
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_by UUID REFERENCES user_profiles(id), -- Trainer who made the assignment
  UNIQUE(session_id, user_id, team_name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_session_teams_session_id ON session_teams(session_id);
CREATE INDEX IF NOT EXISTS idx_session_teams_user_id ON session_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_session_teams_team_name ON session_teams(team_name);
CREATE INDEX IF NOT EXISTS idx_scenario_teams_scenario_id ON scenario_teams(scenario_id);

-- ============================================
-- PART 2: Enhanced Inject Scoping
-- ============================================

-- Add inject scope and team targeting to scenario_injects
ALTER TABLE scenario_injects 
  ADD COLUMN IF NOT EXISTS inject_scope VARCHAR(20) DEFAULT 'universal' 
    CHECK (inject_scope IN ('universal', 'role_specific', 'team_specific')),
  ADD COLUMN IF NOT EXISTS target_teams TEXT[],
  ADD COLUMN IF NOT EXISTS requires_coordination BOOLEAN DEFAULT false;

-- Add comment for clarity
COMMENT ON COLUMN scenario_injects.inject_scope IS 'universal: visible to all, role_specific: filtered by affected_roles, team_specific: filtered by target_teams';
COMMENT ON COLUMN scenario_injects.target_teams IS 'Array of team names that should receive this inject (used when inject_scope = team_specific)';
COMMENT ON COLUMN scenario_injects.requires_coordination IS 'Whether this inject requires coordination between multiple teams';

-- Update existing injects to be universal by default (safe default)
UPDATE scenario_injects SET inject_scope = 'universal' WHERE inject_scope IS NULL;

-- ============================================
-- PART 3: RLS Policies
-- ============================================

-- Enable RLS on new tables
ALTER TABLE scenario_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_teams ENABLE ROW LEVEL SECURITY;

-- Scenario Teams: Trainers can manage teams for their scenarios
CREATE POLICY "Trainers can view teams for their scenarios"
  ON scenario_teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_teams.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can create teams for their scenarios"
  ON scenario_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_teams.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can update teams for their scenarios"
  ON scenario_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_teams.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can delete teams for their scenarios"
  ON scenario_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM scenarios s
      WHERE s.id = scenario_teams.scenario_id
      AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
      AND up.role IN ('trainer', 'admin')
    )
  );

-- Session Teams: Users can view their own team assignments, trainers can view all
CREATE POLICY "Users can view their own team assignments"
  ON session_teams FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_teams.session_id
      AND (s.trainer_id = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles up
        WHERE up.id = auth.uid()
        AND up.role IN ('trainer', 'admin')
      ))
    )
  );

CREATE POLICY "Trainers can assign teams"
  ON session_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_teams.session_id
      AND (s.trainer_id = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles up
        WHERE up.id = auth.uid()
        AND up.role IN ('trainer', 'admin')
      ))
    )
  );

CREATE POLICY "Trainers can update team assignments"
  ON session_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_teams.session_id
      AND (s.trainer_id = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles up
        WHERE up.id = auth.uid()
        AND up.role IN ('trainer', 'admin')
      ))
    )
  );

CREATE POLICY "Trainers can remove team assignments"
  ON session_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_teams.session_id
      AND (s.trainer_id = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles up
        WHERE up.id = auth.uid()
        AND up.role IN ('trainer', 'admin')
      ))
    )
  );

