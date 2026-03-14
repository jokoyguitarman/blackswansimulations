-- Bombing at Jurong Point Mall - Demo Scenario Seed Script
-- Run this in your Supabase SQL Editor to create the complete demo scenario

-- ============================================
-- PART 1: Create the Scenario
-- ============================================

-- Note: This script will use the first trainer/admin user found
-- If you need a specific user, modify the created_by selection below

DO $$
DECLARE
  scenario_uuid UUID;
  trainer_user_id UUID;
BEGIN
  -- Get a trainer/admin user ID
  SELECT id INTO trainer_user_id FROM user_profiles WHERE role IN ('trainer', 'admin') LIMIT 1;
  
  IF trainer_user_id IS NULL THEN
    RAISE EXCEPTION 'No trainer or admin user found. Please create a user with trainer or admin role first.';
  END IF;

  -- Insert the scenario and capture the ID
  INSERT INTO scenarios (
    id,
    title,
    description,
    category,
    difficulty,
    duration_minutes,
    objectives,
    initial_state,
    briefing,
    role_specific_briefs,
    created_by,
    is_active
  ) VALUES (
    gen_random_uuid(),
    'Bombing at Jurong Point Mall',
    'A bombing occurs at Jurong Point shopping mall during a community event. An unattended bag detonates near the central atrium on Level 2, causing casualties, panic, and secondary fires. The Community Emergency and Engagement (C2E) Committee and Fire Department become the first organised response for at least 15 minutes due to delayed emergency services.

Unknown to responders, two terrorists remain on site:
• One discreetly records the aftermath for propaganda.
• One intends to conduct a suicide attack at a moment of maximum crowd density.

The situation is complicated by misinformation, communal tensions, and the unique challenges of a 9-storey enclosed mall—vertical evacuation, smoke spread, and fire containment.',
    'terrorism',
    'advanced',
    60,
    '[
      "Evacuate participants safely (vertical and horizontal)",
      "Establish a medical triage system",
      "Manage media and mitigate communal tension",
      "Coordinate with Fire Department and delayed emergency services",
      "Contain fire and smoke risks"
    ]'::jsonb,
    '{
      "participant_count": 1500,
      "location": "jurong_point_mall",
      "floors": 9,
      "blast_floor": 2,
      "initial_casualties": "unknown",
      "terrorists_on_site": 2,
      "emergency_services_eta": 15,
      "secondary_fire_risk": true
    }'::jsonb,
    'You are part of the Community Emergency and Engagement (C2E) Committee and Fire Department responding to a bombing at Jurong Point Mall. Approximately 1,500 people are present across 9 floors. The blast occurred on Level 2. Emergency services are delayed due to traffic. You must coordinate the response while managing misinformation, communal tensions, fire/smoke risks, and potential secondary threats.

**Key Challenges:**
- Incomplete and conflicting information from volunteers
- Vertical evacuation across 9 floors; stairwell bottlenecks
- Fire and smoke spread in enclosed mall environment
- Viral misinformation spreading online with racial accusations
- Journalists arriving before emergency services
- Hidden adversaries on site (propaganda operative, potential suicide attacker)
- Escalating communal tensions interfering with operations

**Your Role:** Work with your team to manage this crisis while maintaining safety, accuracy, and community cohesion.',
    '{
      "evacuation": "You are responsible for safely evacuating participants across 9 floors. Manage stairwell bottlenecks, prevent discriminatory segregation, and keep evacuees calm despite misinformation. Coordinate with Fire Department on safe routes and floor-by-floor priority. Watch for suspicious individuals.",
      "triage": "You must establish a medical triage system based on incomplete, evolving data. Prioritize severely injured despite unclear casualty numbers across multiple floors. Shield casualty zones from intrusive filming. Coordinate with Fire for smoke-free triage sites.",
      "media": "You must address online racialized misinformation, prevent on-site harassment, guide volunteers on communications, de-escalate ethnic/religious confrontations, and counter false narratives. Journalists are arriving and demanding information.",
      "fire": "You are responsible for fire containment, smoke control, and structural assessment. Conduct search and rescue across floors. Coordinate with Evacuation on safe routes and floor priority. Coordinate with Triage on casualty access and smoke-free zones."
    }'::jsonb,
    trainer_user_id,
    true
  ) RETURNING id INTO scenario_uuid;
  
  -- ============================================
  -- PART 2: Create Team Definitions
  -- ============================================
  
  INSERT INTO scenario_teams (scenario_id, team_name, team_description, required_roles, min_participants, max_participants)
  VALUES
    (scenario_uuid, 'evacuation', 'Vertical and horizontal evacuation; manage bottlenecks at stairwells and exits; prevent discriminatory segregation; coordinate floor-by-floor priority with Fire', ARRAY[]::TEXT[], 2, 10),
    (scenario_uuid, 'triage', 'Establishes medical triage system, prioritizes injuries, manages casualty zones; coordinates with Fire for smoke-free triage sites', ARRAY[]::TEXT[], 2, 8),
    (scenario_uuid, 'media', 'Manages media relations, counters misinformation, and handles communications', ARRAY[]::TEXT[], 2, 6),
    (scenario_uuid, 'fire', 'Fire containment, smoke control, structural assessment, search and rescue; coordinates safe evacuation routes and triage access', ARRAY[]::TEXT[], 2, 8);
  
  -- ============================================
  -- PART 3: Create Universal Injects
  -- ============================================
  
  -- Universal Inject 1 - Initial Explosion (T+0)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 0, 'field_update',
    'Initial Explosion',
    'A sudden explosion occurs at the central atrium on Level 2. Smoke, dust, and debris obscure visibility. Panic spreads rapidly across multiple floors. People run toward stairwells and exits, screaming. The extent of casualties is unknown.',
    'critical',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    true,
    false
  );
  
  -- Universal Inject 2 - Fragmented Early Reports (T+5)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 5, 'field_update',
    'Fragmented Early Reports',
    'Volunteers sent to assess the situation return with inconsistent information:
• "I saw five people down on Level 2."
• "I only saw smoke."
• "Someone said there is a second device."
• "A man ran away after the blast."
• "Smoke is spreading to Level 3."

No two accounts match.',
    'high',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    false,
    true
  );
  
  -- Universal Inject 3 - Emergency Services Delay (T+10)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 10, 'field_update',
    'Emergency Services Delay',
    'Dispatch (995 and 999) informs the coordination centre: "Traffic congestion near Boon Lay is severe. Ambulances and police cannot reach your location within the initial 15-minute estimate." C2E and Fire must manage the crisis longer and more independently.',
    'high',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    true,
    true
  );
  
  -- Universal Inject 4 - Viral Video Circulates (T+10)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 10, 'media_report',
    'Viral Video Circulates',
    'A short clip showing the explosion aftermath at Jurong Point appears online. Due to poor visibility, it appears that Malay youths are standing near the blast area. Online commenters claim:
• "Malay boys planted the bomb."
• "This is extremist terrorism."
• "Keep the Malays away from the exits."

The video is going viral rapidly.',
    'critical',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    true,
    true
  );
  
  -- Universal Inject 5 - Journalist Arrives (T+12)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 12, 'media_report',
    'Journalist Arrives',
    'A freelance journalist arrives before emergency services. He begins filming casualties and asks: "Is it true the attacker was a radicalised Malay youth?" He is posting unverified observations online and photographing visibly Malay families disproportionately.',
    'high',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    true,
    true
  );
  
  -- Universal Inject 6 - Crowd Tension Escalation (T+15)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 15, 'field_update',
    'Crowd Tension Escalation',
    'A dispute erupts near the evacuation zone. An attendee shouts: "The attackers are among us! The Malays are responsible!" Fear and confusion escalate. Some non-Malay attendees begin avoiding Malay families. A minor altercation occurs. A Malay volunteer assigned to evacuation is confronted by a frightened resident.',
    'critical',
    '[]'::jsonb,
    'universal',
    ARRAY['evacuation', 'triage', 'media', 'fire'],
    true,
    true
  );
  
  -- ============================================
  -- PART 4: Create Evacuation Team Injects
  -- ============================================
  
  -- Evacuation Inject E1 - Stairwell Congestion (T+6)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 6, 'field_update',
    'Stairwell Congestion',
    'The main stairwell becomes clogged as more than 150 people attempt to descend simultaneously. A child has fallen, and several attendees are at risk of trampling. Immediate action required to manage the bottleneck. Coordinate with Fire on alternative routes if available.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['evacuation'],
    true,
    false
  );
  
  -- Evacuation Inject E2 - Request to Segregate Malays (T+11)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 11, 'citizen_call',
    'Request to Segregate Malays',
    'A fearful resident approaches the Evacuation Team: "For safety, please separate the Malays from the rest." This request is discriminatory and could inflame tensions. How do you respond?',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['evacuation'],
    true,
    true
  );
  
  -- Evacuation Inject E3 - Suspicious Individual (T+14)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 14, 'intel_brief',
    'Suspicious Individual',
    'A volunteer reports: "There is a man standing near Stairwell B with a backpack. He isn''t evacuating." This could be the suicide attacker. Immediate security assessment needed. Coordinate with other teams.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['evacuation'],
    true,
    true
  );
  
  -- ============================================
  -- PART 5: Create Triage Team Injects
  -- ============================================
  
  -- Triage Inject T1 - Unclear Casualty Count (T+6)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 6, 'field_update',
    'Unclear Casualty Count',
    'Volunteers report conflicting casualty numbers across multiple floors:
• "Three critical injuries on Level 2."
• "I saw at least seven."
• "One person has stopped moving."
• "Smoke is obscuring injuries on Level 3."

You cannot establish an accurate count. Prioritize based on incomplete information.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['triage'],
    true,
    false
  );
  
  -- Triage Inject T2 - On-Site Filming at Triage Area (T+12)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 12, 'media_report',
    'On-Site Filming at Triage Area',
    'A bystander films traumatised victims receiving first aid. A family pleads for privacy. The filming is intrusive and violates victim dignity. You must protect the casualty zone while managing media access.',
    'medium',
    '[]'::jsonb,
    'team_specific',
    ARRAY['triage'],
    true,
    true
  );
  
  -- Triage Inject T3 - Accusations from a Patient (T+15)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 15, 'citizen_call',
    'Accusations from a Patient',
    'An injured attendee becomes agitated and shouts: "I saw the Malay boys laughing before the explosion! They did this!" This unverified accusation could inflame tensions. Coordinate with Media team to manage the narrative.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['triage'],
    true,
    true
  );
  
  -- ============================================
  -- PART 6: Create Media/Communications Team Injects
  -- ============================================
  
  -- Media Inject M1 - Fake Voice Note (T+9)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 9, 'media_report',
    'Fake Voice Note',
    'A viral WhatsApp audio note begins circulating: "There is a second bomb. The attacker was a Malay male. Stay away from the mall." This is false information spreading rapidly. You must counter this misinformation immediately.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    true,
    true
  );
  
  -- Media Inject M2 - Amplified Online Claims (T+11)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 11, 'media_report',
    'Amplified Online Claims',
    'A Telegram channel posts: "Confirmed: Islamist terror attack at Jurong Point Mall. This is why we must separate communities." The false narrative is gaining traction. Old social media posts about unrelated incidents are resurfacing to reinforce prejudice.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    true,
    true
  );
  
  -- Media Inject M3 - Press Demand for Confirmation (T+12)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 12, 'media_report',
    'Press Demand for Confirmation',
    'The journalist asks again: "Can you confirm the attacker was Malay? The public deserves transparency." You must respond without confirming unverified information or inflaming tensions. Prepare a statement.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    true,
    false
  );
  
  -- ============================================
  -- PART 7: Create Fire Department Team Injects
  -- ============================================
  
  -- Fire Inject F1 - Secondary Fire Reported (T+4)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 4, 'field_update',
    'Secondary Fire Reported',
    'A small fire has been reported in a retail unit near the blast site. Smoke is spreading toward Level 3 via the atrium. Immediate assessment and containment required. Coordinate with Evacuation on affected routes.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['fire'],
    true,
    true
  );
  
  -- Fire Inject F2 - Escalator/Elevator Hazard (T+7)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 7, 'field_update',
    'Escalator/Elevator Hazard',
    'Volunteers report that people are still using escalators and elevators to evacuate. Structural damage from the blast is suspected. Escalators may have stopped or become unstable. Elevators could trap occupants if power fails. Fire must advise Evacuation: use stairwells only.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['fire'],
    true,
    true
  );
  
  -- Fire Inject F3 - Smoke Spread to Upper Floors (T+9)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 9, 'field_update',
    'Smoke Spread to Upper Floors',
    'Smoke is migrating via the central atrium to Levels 4 and 5. Visibility is deteriorating. A ventilation decision is needed: evacuate upper floors first, or attempt to contain smoke? Coordinate with Evacuation on floor priority and with Triage on casualty access routes.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['fire'],
    true,
    true
  );
  
  -- Fire Inject F4 - Structural Concern (T+13)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 13, 'field_update',
    'Structural Concern',
    'Cracking has been observed in the ceiling near the blast zone. Fire must assess before Triage and Evacuation use certain routes. A corridor may need to be cordoned. Communicate assessment to other teams immediately.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['fire'],
    true,
    true
  );
  
  -- ============================================
  -- PART 8: Create Scenario Objectives
  -- ============================================
  
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'evacuation', 'Evacuate participants safely (vertical and horizontal)', 'Manage stairwell bottlenecks, prevent discriminatory segregation, keep evacuees calm despite misinformation; coordinate with Fire on safe routes.', 25.00, '{"target_count": 1500, "success_threshold": 0.8, "penalties": {"discriminatory_segregation": 30, "major_stampede": 50, "no_plan": 100}}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'triage', 'Establish medical triage system', 'Based on incomplete data across multiple floors, prioritize severely injured, shield casualty zones from intrusive filming.', 20.00, '{"time_threshold_minutes": 10, "penalties": {"filming_violation": 20, "no_coordination": 15}}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'media', 'Manage media and mitigate communal tension', 'Address online misinformation, prevent harassment, de-escalate confrontations, counter false narratives.', 25.00, '{"penalties": {"discriminatory_actions": 40, "harassment_not_prevented": 30, "false_narrative_as_fact": 50}}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'fire', 'Contain fire/smoke risks; coordinate safe routes', 'Fire containment, smoke control, structural assessment; coordinate evacuation routes and triage access with other teams.', 20.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'coordination', 'Coordinate with Fire Department and emergency services', 'Maintain accurate updates, identify safe access points, report potential secondary threats.', 10.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  
  RAISE NOTICE 'Bombing at Jurong Point Mall scenario created successfully!';
  RAISE NOTICE 'Scenario ID: %', scenario_uuid;
  RAISE NOTICE 'Created 4 teams, 19 injects, 5 objectives';
  
END $$;

-- Display summary
SELECT 
  'Scenario Created' as status,
  title,
  id as scenario_id
FROM scenarios 
WHERE title = 'Bombing at Jurong Point Mall';

SELECT 
  'Teams Created' as status,
  COUNT(*) as team_count
FROM scenario_teams st
JOIN scenarios s ON s.id = st.scenario_id
WHERE s.title = 'Bombing at Jurong Point Mall';

SELECT 
  'Injects Created' as status,
  COUNT(*) as inject_count,
  COUNT(*) FILTER (WHERE inject_scope = 'universal') as universal_count,
  COUNT(*) FILTER (WHERE inject_scope = 'team_specific') as team_specific_count
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'Bombing at Jurong Point Mall';

SELECT 
  'Objectives Created' as status,
  COUNT(*) as objective_count
FROM scenario_objectives so
JOIN scenarios s ON s.id = so.scenario_id
WHERE s.title = 'Bombing at Jurong Point Mall';
