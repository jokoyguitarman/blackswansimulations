-- Add media operational injects (spokesperson assignment, camera positioning,
-- media staging area) and reporter question injects to existing scenario.
-- Also ensures media_state flags exist in session initial state.

DO $$
DECLARE
  v_scenario_id UUID := 'ad2a8c57-f1ab-419d-aacb-1b1ec65c2cc6';
  v_media_team  TEXT;
  v_duration    INT;
BEGIN
  -- Resolve the media team name for this scenario
  SELECT team_name INTO v_media_team
    FROM scenario_teams
   WHERE scenario_id = v_scenario_id
     AND team_name ~* 'media|communi'
   LIMIT 1;

  IF v_media_team IS NULL THEN
    RAISE NOTICE 'No media team found for scenario %; skipping', v_scenario_id;
    RETURN;
  END IF;

  -- Get scenario duration
  SELECT COALESCE(duration_minutes, 60) INTO v_duration
    FROM scenarios
   WHERE id = v_scenario_id;

  -- 1) Spokesperson Assignment inject
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content,
    affected_roles, severity, inject_scope, target_teams,
    requires_response, requires_coordination,
    conditions_to_appear, eligible_after_minutes
  ) VALUES (
    v_scenario_id,
    NULL,
    'political_pressure',
    'SPOKESPERSON ASSIGNMENT REQUIRED',
    E'Reporters are arriving and cameras are being set up. Before the press briefing can proceed, you must designate a spokesperson.\n\nDescribe the person you are appointing as spokesperson — their role, rank, demeanor, and communication style. Explain WHY this person is the best candidate for addressing the public in this specific situation. Consider: Does their authority match the severity? Will they project calm and competence? Are they trained in crisis communications? How will the public perceive them?',
    '[]'::jsonb,
    'high',
    'team_specific',
    ARRAY[v_media_team],
    true,
    false,
    '{"threshold": 2, "conditions": ["media_no_spokesperson_designated", "media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.15)
  );

  -- 2) Camera Positioning inject
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content,
    affected_roles, severity, inject_scope, target_teams,
    requires_response, requires_coordination,
    conditions_to_appear, eligible_after_minutes
  ) VALUES (
    v_scenario_id,
    NULL,
    'field_update',
    'CAMERA POSITIONING FOR LIVE BROADCAST',
    E'A TV crew is ready to go live from the scene. They need your direction on where to position the camera for the broadcast.\n\nConsider the visual backdrop carefully: What should the public SEE behind the spokesperson? Showing active response efforts can build confidence, but capturing the triage area violates victim dignity. Revealing tactical positions compromises operational security. A chaotic background undermines the message of control.\n\nDescribe where the cameras should be placed, what angle to use, and what should be visible (and NOT visible) in frame.',
    '[]'::jsonb,
    'medium',
    'team_specific',
    ARRAY[v_media_team],
    true,
    false,
    '{"threshold": 1, "conditions": ["media_no_camera_placement"]}'::jsonb,
    ROUND(v_duration * 0.2)
  );

  -- 3) Media Staging Area inject
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content,
    affected_roles, severity, inject_scope, target_teams,
    requires_response, requires_coordination,
    conditions_to_appear, eligible_after_minutes
  ) VALUES (
    v_scenario_id,
    NULL,
    'field_update',
    'MEDIA STAGING AREA NEEDED',
    E'Multiple news crews, photographers, and social media journalists are converging on the scene. They are currently wandering into operational areas and interfering with response efforts.\n\nYou need to establish a designated media holding area. Where should it be located? It must be close enough for reporters to feel they have access, but far enough to avoid compromising operations, victim dignity, or security. Describe the location, any access rules, and how you will manage press movement.',
    '[]'::jsonb,
    'medium',
    'team_specific',
    ARRAY[v_media_team],
    true,
    false,
    '{"threshold": 1, "conditions": ["media_no_holding_area"]}'::jsonb,
    ROUND(v_duration * 0.1)
  );

  -- 4) Reporter questions (condition-driven, fire after press conference or statement)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content,
    affected_roles, severity, inject_scope, target_teams,
    requires_response, requires_coordination,
    conditions_to_appear, eligible_after_minutes
  ) VALUES
  (
    v_scenario_id, NULL, 'media_report',
    'Question from David Lim, The Straits Times',
    'David Lim, senior correspondent from The Straits Times, raises his hand firmly. His tone is measured but probing: "Can you confirm the number of casualties and whether any fatalities have been recorded? The public deserves accurate figures, not estimates. What is the current confirmed count?"',
    '[]'::jsonb, 'high', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 1, "conditions": ["media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.2)
  ),
  (
    v_scenario_id, NULL, 'media_report',
    'Question from Rachel Tan, Channel NewsAsia',
    'Rachel Tan from CNA steps forward with a microphone, her expression sharp: "Social media footage shows casualties lying unattended for what appears to be several minutes. Can you explain the delay in the medical response? Were there enough first responders on scene?"',
    '[]'::jsonb, 'high', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 2, "conditions": ["media_press_conference_or_statement", "patients_in_treatment_above_5"]}'::jsonb,
    ROUND(v_duration * 0.3)
  ),
  (
    v_scenario_id, NULL, 'media_report',
    'Question from @SG_WatchDog, Social Media Influencer',
    'A social media influencer who has been livestreaming from outside the cordon pushes to the front: "My followers are asking — there are videos showing what looks like a second explosion site. Are you hiding information about additional devices? People have a right to know if they are still in danger."',
    '[]'::jsonb, 'critical', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 1, "conditions": ["media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.35)
  ),
  (
    v_scenario_id, NULL, 'media_report',
    'Question from James Harper, BBC World Service',
    'James Harper from BBC World leans in, his tone measured but pointed: "Your team has restricted media access to the site. Given that this is a public safety event, don''t the families of those affected deserve to see what is happening? Why are you preventing journalists from documenting the response?"',
    '[]'::jsonb, 'high', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 1, "conditions": ["media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.45)
  ),
  (
    v_scenario_id, NULL, 'media_report',
    'Question from Priya Nair, Tamil Murasu',
    'Priya Nair from Tamil Murasu asks with quiet intensity: "We are hearing from family members that they cannot get any information about their loved ones. One mother has been waiting over 30 minutes with no update. Can you tell us whether a family reunification point has been established, and if so, why aren''t families being directed there?"',
    '[]'::jsonb, 'high', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 1, "conditions": ["media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.55)
  ),
  (
    v_scenario_id, NULL, 'media_report',
    'Question from Marcus Wong, Lianhe Zaobao',
    'Marcus Wong from Lianhe Zaobao asks bluntly, his cameraman zooming in on the spokesperson''s face: "Can you confirm the identity or ethnicity of the suspect? There are rumours circulating online and community tensions are rising. A clear answer now could prevent retaliatory incidents."',
    '[]'::jsonb, 'critical', 'team_specific', ARRAY[v_media_team], true, false,
    '{"threshold": 1, "conditions": ["media_press_conference_or_statement"]}'::jsonb,
    ROUND(v_duration * 0.65)
  );

  RAISE NOTICE 'Inserted 9 media operational + reporter injects for scenario %', v_scenario_id;
END $$;
