-- Launch access locks.
-- The server uses the service-role key and bypasses these policies.
-- This closes the same doors for the public anon key and for signed-in callers
-- talking to the database directly.
--
-- Does not change bucket publicity, file size limits, anonymous sign-in,
-- or any account rows.

-- ---------------------------------------------------------------------------
-- 1. sim-media: stop public list / write. Public object URLs keep working
--    because the bucket stays public. Service-role uploads bypass RLS.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public read access for sim-media" ON storage.objects;
DROP POLICY IF EXISTS "Service role full access for sim-media" ON storage.objects;

-- ---------------------------------------------------------------------------
-- 2. Scenarios: a login alone is not enough to read the library.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone authenticated can view active scenarios" ON public.scenarios;

CREATE POLICY "Creators and admins can view scenarios"
  ON public.scenarios
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Scene configs: drop the world-readable select.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS rts_scene_configs_select ON public.rts_scene_configs;

CREATE POLICY rts_scene_configs_select
  ON public.rts_scene_configs
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Security-definer functions: the server does not call these via RPC.
--    Keep execute for service_role only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unread_notification_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_accepted_invitations_for_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_session_participant(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_unread_notification_count(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_accepted_invitations_for_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_session_participant(uuid, uuid) TO service_role;

ALTER FUNCTION public.log_session_event(uuid, text, text, uuid, text, jsonb) SET search_path = public;
ALTER FUNCTION public.update_sentiment_snapshot(uuid, integer, integer, integer) SET search_path = public;
ALTER FUNCTION public.get_unread_notification_count(uuid) SET search_path = public;
ALTER FUNCTION public.process_accepted_invitations_for_user(uuid) SET search_path = public;
ALTER FUNCTION public.is_session_participant(uuid, uuid) SET search_path = public;

-- ---------------------------------------------------------------------------
-- 6. Notifications: the server inserts with the service role.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "System can create notifications" ON public.notifications;

-- ---------------------------------------------------------------------------
-- 7. Trainer separation. Owner or admin. The "any trainer" branch is gone.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Trainers can view locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can create locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can update locations for their scenarios" ON public.scenario_locations;
DROP POLICY IF EXISTS "Trainers can delete locations for their scenarios" ON public.scenario_locations;

CREATE POLICY "Trainers can view locations for their scenarios"
  ON public.scenario_locations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can create locations for their scenarios"
  ON public.scenario_locations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can update locations for their scenarios"
  ON public.scenario_locations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can delete locations for their scenarios"
  ON public.scenario_locations FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_locations.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Trainers can view environmental seeds for their scenarios" ON public.scenario_environmental_seeds;
DROP POLICY IF EXISTS "Trainers can create environmental seeds for their scenarios" ON public.scenario_environmental_seeds;
DROP POLICY IF EXISTS "Trainers can update environmental seeds for their scenarios" ON public.scenario_environmental_seeds;
DROP POLICY IF EXISTS "Trainers can delete environmental seeds for their scenarios" ON public.scenario_environmental_seeds;

CREATE POLICY "Trainers can view environmental seeds for their scenarios"
  ON public.scenario_environmental_seeds FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can create environmental seeds for their scenarios"
  ON public.scenario_environmental_seeds FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can update environmental seeds for their scenarios"
  ON public.scenario_environmental_seeds FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can delete environmental seeds for their scenarios"
  ON public.scenario_environmental_seeds FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_environmental_seeds.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Trainers can view teams for their scenarios" ON public.scenario_teams;
DROP POLICY IF EXISTS "Trainers can create teams for their scenarios" ON public.scenario_teams;
DROP POLICY IF EXISTS "Trainers can update teams for their scenarios" ON public.scenario_teams;
DROP POLICY IF EXISTS "Trainers can delete teams for their scenarios" ON public.scenario_teams;

CREATE POLICY "Trainers can view teams for their scenarios"
  ON public.scenario_teams FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_teams.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can create teams for their scenarios"
  ON public.scenario_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_teams.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can update teams for their scenarios"
  ON public.scenario_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_teams.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

CREATE POLICY "Trainers can delete teams for their scenarios"
  ON public.scenario_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_teams.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Trainers can create injects" ON public.scenario_injects;

CREATE POLICY "Trainers can create injects"
  ON public.scenario_injects FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.scenarios s
      WHERE s.id = scenario_injects.scenario_id
        AND s.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Users can view their own team assignments" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can assign teams" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can update team assignments" ON public.session_teams;
DROP POLICY IF EXISTS "Trainers can remove team assignments" ON public.session_teams;

CREATE POLICY "Users can view their own team assignments"
  ON public.session_teams FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can assign teams"
  ON public.session_teams FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can update team assignments"
  ON public.session_teams FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );

CREATE POLICY "Trainers can remove team assignments"
  ON public.session_teams FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.id = session_teams.session_id
        AND (
          s.trainer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.user_profiles up
            WHERE up.id = auth.uid() AND up.role = 'admin'
          )
        )
    )
  );
