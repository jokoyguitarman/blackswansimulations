-- Row Level Security (RLS) Policies
-- Ensures users can only access data they're authorized to see

-- Enable RLS on all tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_injects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sentiment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aar_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE participant_scores ENABLE ROW LEVEL SECURITY;

-- User Profiles Policies
CREATE POLICY "Users can view their own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Trainers and admins can view all profiles"
  ON user_profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('trainer', 'admin')
    )
  );

-- Scenarios Policies
CREATE POLICY "Anyone authenticated can view active scenarios"
  ON scenarios FOR SELECT
  USING (is_active = true AND auth.role() = 'authenticated');

CREATE POLICY "Trainers can create scenarios"
  ON scenarios FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Scenario creators can update their scenarios"
  ON scenarios FOR UPDATE
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('admin')
    )
  );

-- Scenario Injects Policies
CREATE POLICY "Session participants can view injects for their sessions"
  ON scenario_injects FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sessions s
      JOIN session_participants sp ON s.id = sp.session_id
      WHERE s.scenario_id = scenario_injects.scenario_id
      AND sp.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.scenario_id = scenario_injects.scenario_id
      AND s.trainer_id = auth.uid()
    )
  );

CREATE POLICY "Trainers can create injects"
  ON scenario_injects FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('trainer', 'admin')
    )
  );

-- Sessions Policies
CREATE POLICY "Participants can view their sessions"
  ON sessions FOR SELECT
  USING (
    trainer_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = sessions.id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Trainers can create sessions"
  ON sessions FOR INSERT
  WITH CHECK (
    trainer_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role IN ('trainer', 'admin')
    )
  );

CREATE POLICY "Trainers can update their sessions"
  ON sessions FOR UPDATE
  USING (
    trainer_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- Session Participants Policies
CREATE POLICY "Participants can view participants in their sessions"
  ON session_participants FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND (trainer_id = auth.uid() OR id IN (
        SELECT session_id FROM session_participants WHERE user_id = auth.uid()
      ))
    )
  );

CREATE POLICY "Trainers can manage participants"
  ON session_participants FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_participants.session_id
      AND trainer_id = auth.uid()
    )
  );

-- Incidents Policies
CREATE POLICY "Session participants can view incidents"
  ON incidents FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = incidents.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = incidents.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can create incidents"
  ON incidents FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = incidents.session_id
      AND user_id = auth.uid()
    )
  );

-- Decisions Policies
CREATE POLICY "Session participants can view decisions"
  ON decisions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = decisions.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = decisions.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can create decisions"
  ON decisions FOR INSERT
  WITH CHECK (
    proposed_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = decisions.session_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Decision approvers can update decisions"
  ON decisions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM decision_steps
      WHERE decision_id = decisions.id
      AND user_id = auth.uid()
      AND status = 'pending'
    )
    OR proposed_by = auth.uid()
  );

-- Decision Steps Policies
CREATE POLICY "Session participants can view decision steps"
  ON decision_steps FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM decisions d
      JOIN session_participants sp ON d.session_id = sp.session_id
      WHERE d.id = decision_steps.decision_id
      AND sp.user_id = auth.uid()
    )
  );

CREATE POLICY "Approvers can update their decision steps"
  ON decision_steps FOR UPDATE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM decisions d
      WHERE d.id = decision_steps.decision_id
      AND d.proposed_by = auth.uid()
    )
  );

-- Chat Channels Policies
CREATE POLICY "Session participants can view channels"
  ON chat_channels FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = chat_channels.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = chat_channels.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can create channels"
  ON chat_channels FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = chat_channels.session_id
      AND user_id = auth.uid()
    )
  );

-- Chat Messages Policies
CREATE POLICY "Session participants can view messages"
  ON chat_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = chat_messages.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = chat_messages.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can send messages"
  ON chat_messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = chat_messages.session_id
      AND user_id = auth.uid()
    )
  );

-- Media Posts Policies
CREATE POLICY "Session participants can view media posts"
  ON media_posts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = media_posts.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = media_posts.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Trainers can create media posts"
  ON media_posts FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = media_posts.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Session Events Policies
CREATE POLICY "Session participants can view events"
  ON session_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = session_events.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = session_events.session_id
      AND trainer_id = auth.uid()
    )
  );

-- AAR Reports Policies
CREATE POLICY "Session participants can view AAR reports"
  ON aar_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = aar_reports.session_id
      AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE id = aar_reports.session_id
      AND trainer_id = auth.uid()
    )
  );

CREATE POLICY "Trainers can create AAR reports"
  ON aar_reports FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = aar_reports.session_id
      AND s.trainer_id = auth.uid()
    )
  );

-- Resource tables policies (similar pattern)
CREATE POLICY "Session participants can view resources"
  ON agency_resources FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = agency_resources.session_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can view resource allocations"
  ON resource_allocations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = resource_allocations.session_id
      AND user_id = auth.uid()
    )
  );

CREATE POLICY "Session participants can create resource requests"
  ON resource_requests FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM session_participants
      WHERE session_id = resource_requests.session_id
      AND user_id = auth.uid()
    )
  );

