-- C2E: Add more Media team challenges – time-based, citizen_call, political_pressure, condition-driven.
-- Makes Media team workload comparable to Evacuation and Triage.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '092: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- ============================================
  -- PART 1: New time-based Media injects
  -- ============================================

  -- M4: Community leader demands statement (T+7) – pressures Media before first statement
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 7, 'citizen_call',
    'Community leader demands statement',
    'A respected community leader calls the coordination centre: "Our people are scared and confused. We need an official statement now. What do we tell our families?" You must respond before full facts are known. Delaying risks losing community trust; speaking too soon risks errors.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Community leader demands statement'
  );

  -- M5: Influencer amplifies false narrative (T+14)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 14, 'media_report',
    'Influencer amplifies false narrative',
    'A local influencer with 50,000 followers posts: "Confirmed: Malay extremist attack at our community event. Share if you agree we need to protect our community." The post is going viral. The false narrative is being amplified to a much wider audience. You must counter this amplification immediately.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Influencer amplifies false narrative'
  );

  -- M6: Second journalist arrives, aggressive questioning (T+18)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 18, 'media_report',
    'Second journalist arrives – aggressive questioning',
    'A second journalist from a major outlet arrives. She asks: "Why did you wait so long to address the Malay connection? Are you covering something up? The public deserves transparency." She is live-tweeting the exchange. You must handle hostile questioning without confirming unverified information or inflaming tensions.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Second journalist arrives – aggressive questioning'
  );

  -- M7: Family demands retraction (T+20)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 20, 'citizen_call',
    'Family demands retraction',
    'A Malay family whose son was misidentified in online rumours contacts the coordination centre. They demand a public retraction and apology. "Our son was helping victims. Now people are accusing him. You must correct this." You must balance accuracy, dignity, and legal risk.',
    'high',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Family demands retraction'
  );

  -- ============================================
  -- PART 2: citizen_call and political_pressure injects
  -- ============================================

  -- M8: Volunteer reports voice note in evacuation group (T+13)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 13, 'citizen_call',
    'Voice note spreading in evacuation group',
    'A volunteer reports: "People are sharing the voice note in our evacuation WhatsApp group. They are refusing to stand near Malay families. I tried to tell them it is false but they will not listen. We need an official message we can forward." Media must provide a debunking message that volunteers can share immediately.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Voice note spreading in evacuation group'
  );

  -- M9: Political pressure – PM office demands statement (T+16)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, 16, 'political_pressure',
    'PM office demands statement',
    'A senior official calls: "The PM''s office is asking why we have not issued a clear statement. They want something in the next 10 minutes. Get it out." You face political pressure and a tight deadline. Rushing risks errors; delaying risks escalation.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'PM office demands statement'
  );

  -- ============================================
  -- PART 3: Condition-driven Media injects
  -- ============================================

  -- M10: Statement issued but misinformation not addressed (eligible T+14)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"threshold": 2, "conditions": ["media_statement_issued", "media_misinformation_not_addressed"]}'::jsonb,
    '["media_misinformation_addressed"]'::jsonb,
    14, 'media_report',
    'First statement did not address rumours – second wave',
    'Your first statement has been published, but it did not address the viral rumours about Malay involvement. A second wave of misinformation is now spreading. Online commentators are asking: "Why did they not deny it?" You must issue a follow-up that explicitly counters the false narrative.',
    'critical',
    '[]'::jsonb, 'team_specific', ARRAY['media'], true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'First statement did not address rumours – second wave'
  );

  RAISE NOTICE '092: C2E Media team challenges added. New injects: Community leader, Influencer, Second journalist, Family retraction, Voice note in group, PM office, First statement did not address rumours.';
END $$;
