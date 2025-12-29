-- Objective Tracking System for Scenarios
-- Tracks progress on scenario objectives in real-time

-- Create objective progress tracking table
CREATE TABLE IF NOT EXISTS scenario_objective_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL, -- e.g., "evacuation", "triage", "media", "coordination"
  objective_name TEXT NOT NULL, -- Human-readable name
  progress_percentage INTEGER NOT NULL DEFAULT 0 CHECK (progress_percentage >= 0 AND progress_percentage <= 100),
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed', 'failed')),
  score INTEGER CHECK (score >= 0 AND score <= 100), -- Final score for this objective
  metrics JSONB DEFAULT '{}'::jsonb, -- Detailed metrics for scoring (e.g., {"evacuated_count": 850, "total_participants": 1000})
  penalties JSONB DEFAULT '[]'::jsonb, -- Array of penalty objects with reason and points
  bonuses JSONB DEFAULT '[]'::jsonb, -- Array of bonus objects with reason and points
  weight DECIMAL(5,2) DEFAULT 25.00, -- Weight for overall score calculation (percentage)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, objective_id)
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_objective_progress_session ON scenario_objective_progress(session_id);
CREATE INDEX IF NOT EXISTS idx_objective_progress_status ON scenario_objective_progress(status);

-- Create objective definitions table (scenario-level)
CREATE TABLE IF NOT EXISTS scenario_objectives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL, -- Unique identifier within scenario
  objective_name TEXT NOT NULL,
  description TEXT,
  success_criteria JSONB DEFAULT '{}'::jsonb, -- Criteria for completion
  weight DECIMAL(5,2) DEFAULT 25.00, -- Default weight
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scenario_id, objective_id)
);

-- Create index
CREATE INDEX IF NOT EXISTS idx_scenario_objectives_scenario ON scenario_objectives(scenario_id);

-- Function to update objective progress
CREATE OR REPLACE FUNCTION update_objective_progress(
  p_session_id UUID,
  p_objective_id TEXT,
  p_progress_percentage INTEGER,
  p_status TEXT DEFAULT NULL,
  p_metrics JSONB DEFAULT NULL,
  p_objective_name TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
BEGIN
  -- Determine status based on progress
  IF p_status IS NULL THEN
    IF p_progress_percentage = 0 THEN
      v_status := 'not_started';
    ELSIF p_progress_percentage >= 100 THEN
      v_status := 'completed';
    ELSIF p_progress_percentage < 0 THEN
      v_status := 'failed';
    ELSE
      v_status := 'in_progress';
    END IF;
  ELSE
    v_status := p_status;
  END IF;
  
  -- Insert or update objective progress
  INSERT INTO scenario_objective_progress (
    session_id,
    objective_id,
    objective_name,
    progress_percentage,
    status,
    metrics,
    updated_at
  )
  VALUES (
    p_session_id,
    p_objective_id,
    COALESCE(p_objective_name, p_objective_id),
    p_progress_percentage,
    v_status,
    COALESCE(p_metrics, '{}'::jsonb),
    NOW()
  )
  ON CONFLICT (session_id, objective_id)
  DO UPDATE SET
    progress_percentage = EXCLUDED.progress_percentage,
    status = EXCLUDED.status,
    metrics = EXCLUDED.metrics,
    objective_name = COALESCE(EXCLUDED.objective_name, scenario_objective_progress.objective_name),
    updated_at = NOW();
END;
$$;

-- Function to add penalty to objective
CREATE OR REPLACE FUNCTION add_objective_penalty(
  p_session_id UUID,
  p_objective_id TEXT,
  p_reason TEXT,
  p_points INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE scenario_objective_progress
  SET 
    penalties = penalties || jsonb_build_object('reason', p_reason, 'points', p_points, 'timestamp', NOW()),
    score = GREATEST(0, COALESCE(score, 100) - p_points),
    updated_at = NOW()
  WHERE session_id = p_session_id AND objective_id = p_objective_id;
END;
$$;

-- Function to add bonus to objective
CREATE OR REPLACE FUNCTION add_objective_bonus(
  p_session_id UUID,
  p_objective_id TEXT,
  p_reason TEXT,
  p_points INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE scenario_objective_progress
  SET 
    bonuses = bonuses || jsonb_build_object('reason', p_reason, 'points', p_points, 'timestamp', NOW()),
    score = LEAST(100, COALESCE(score, 0) + p_points),
    updated_at = NOW()
  WHERE session_id = p_session_id AND objective_id = p_objective_id;
END;
$$;

-- Function to calculate overall session score
CREATE OR REPLACE FUNCTION calculate_session_score(p_session_id UUID)
RETURNS TABLE(
  overall_score DECIMAL(5,2),
  objective_scores JSONB,
  success_level TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_weighted_sum DECIMAL(10,2) := 0;
  v_total_weight DECIMAL(10,2) := 0;
  v_score DECIMAL(5,2);
  v_success_level TEXT;
  v_objective_scores JSONB := '[]'::jsonb;
BEGIN
  -- Calculate weighted average of all objectives
  SELECT 
    COALESCE(SUM(score * weight), 0),
    COALESCE(SUM(weight), 0),
    jsonb_agg(
      jsonb_build_object(
        'objective_id', objective_id,
        'objective_name', objective_name,
        'score', score,
        'weight', weight,
        'status', status
      )
    )
  INTO v_weighted_sum, v_total_weight, v_objective_scores
  FROM scenario_objective_progress
  WHERE session_id = p_session_id AND score IS NOT NULL;
  
  -- Calculate overall score
  IF v_total_weight > 0 THEN
    v_score := (v_weighted_sum / v_total_weight);
  ELSE
    v_score := 0;
  END IF;
  
  -- Determine success level
  IF v_score >= 90 THEN
    v_success_level := 'Excellent';
  ELSIF v_score >= 75 THEN
    v_success_level := 'Good';
  ELSIF v_score >= 60 THEN
    v_success_level := 'Adequate';
  ELSE
    v_success_level := 'Needs Improvement';
  END IF;
  
  RETURN QUERY SELECT v_score, v_objective_scores, v_success_level;
END;
$$;

-- Add updated_at trigger
CREATE TRIGGER update_objective_progress_updated_at 
  BEFORE UPDATE ON scenario_objective_progress
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Insert default objectives for C2E Bombing scenario
DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid 
  FROM scenarios 
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;
  
  IF scenario_uuid IS NOT NULL THEN
    -- Objective 1: Evacuation (Weight: 30%)
    INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
    VALUES (
      scenario_uuid,
      'evacuation',
      'Evacuate 1,000 Participants',
      'Manage bottlenecks, prevent discriminatory segregation, keep evacuees calm despite misinformation',
      30.00,
      '{"target_count": 1000, "success_threshold": 0.8, "penalties": {"discriminatory_segregation": 30, "major_stampede": 50, "no_plan": 100}}'::jsonb
    )
    ON CONFLICT (scenario_id, objective_id) DO NOTHING;
    
    -- Objective 2: Triage (Weight: 25%)
    INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
    VALUES (
      scenario_uuid,
      'triage',
      'Establish Medical Triage System',
      'Based on incomplete data, prioritize severely injured, shield casualty zones from intrusive filming',
      25.00,
      '{"time_threshold_minutes": 10, "success_time": 10, "good_time": 15, "adequate_time": 20, "penalties": {"filming_violation": 20, "no_coordination": 15}}'::jsonb
    )
    ON CONFLICT (scenario_id, objective_id) DO NOTHING;
    
    -- Objective 3: Media & Tension (Weight: 30%)
    INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
    VALUES (
      scenario_uuid,
      'media',
      'Manage Media and Mitigate Communal Tension',
      'Address online misinformation, prevent harassment, de-escalate confrontations, counter false narratives',
      30.00,
      '{"penalties": {"discriminatory_actions": 40, "harassment_not_prevented": 30, "false_narrative_as_fact": 50}}'::jsonb
    )
    ON CONFLICT (scenario_id, objective_id) DO NOTHING;
    
    -- Objective 4: Coordination (Weight: 15%)
    INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
    VALUES (
      scenario_uuid,
      'coordination',
      'Coordinate with Emergency Services',
      'Maintain accurate updates, identify safe access points, report potential secondary threats',
      15.00,
      '{}'::jsonb
    )
    ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  END IF;
END;
$$;

