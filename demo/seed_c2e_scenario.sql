-- C2E Bombing at Community Event - Demo Scenario Seed Script
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
    'C2E Bombing at Community Event',
    'A large grassroots community event is underway at a neighbourhood hard court with approximately 1,000 participants. At the height of the event, an unattended bag placed near the central seating area detonates unexpectedly, causing casualties, panic, severe confusion, and a complex crisis environment.

The Community Emergency and Engagement (C2E) Committee becomes the first and only organised response element for at least 15 minutes, which later extends due to delayed emergency services.

Unknown to the C2E, two terrorists remain on site:
• One discreetly records the aftermath for propaganda.
• One intends to conduct a suicide attack at a moment of maximum crowd density.

The situation is complicated by a developing media environment in which misinformation, communal tensions, and opportunistic narratives rapidly escalate.',
    'terrorism',
    'advanced',
    60,
    '[
      "Evacuate 1,000 participants safely",
      "Establish a medical triage system",
      "Manage media and mitigate communal tension",
      "Coordinate with delayed emergency services"
    ]'::jsonb,
    '{
      "participant_count": 1000,
      "location": "neighbourhood_hard_court",
      "initial_casualties": "unknown",
      "terrorists_on_site": 2,
      "emergency_services_eta": 15
    }'::jsonb,
    'You are part of the Community Emergency and Engagement (C2E) Committee responding to a bombing at a community event. Approximately 1,000 people are present. Emergency services are delayed due to traffic. You must coordinate the response while managing misinformation, communal tensions, and potential secondary threats.

**Key Challenges:**
- Incomplete and conflicting information from volunteers
- Viral misinformation spreading online with racial accusations
- Journalists arriving before emergency services
- Hidden adversaries on site (propaganda operative, potential suicide attacker)
- Escalating communal tensions interfering with operations

**Your Role:** Work with your team to manage this crisis while maintaining safety, accuracy, and community cohesion.',
    '{
      "evacuation": "You are responsible for safely evacuating 1,000 participants. Manage bottlenecks, prevent discriminatory segregation, and keep evacuees calm despite misinformation. Watch for suspicious individuals and coordinate with other teams.",
      "triage": "You must establish a medical triage system based on incomplete, evolving data. Prioritize severely injured despite unclear casualty numbers. Shield casualty zones from intrusive filming. Manage conflicting reports about injury counts.",
      "media": "You must address online racialized misinformation, prevent on-site harassment, guide volunteers on communications, de-escalate ethnic/religious confrontations, and counter false narratives. Journalists are arriving and demanding information."
    }'::jsonb,
    trainer_user_id,
    true
  ) RETURNING id INTO scenario_uuid;
  
  -- ============================================
  -- PART 2: Create Team Definitions
  -- ============================================
  
  INSERT INTO scenario_teams (scenario_id, team_name, team_description, required_roles, min_participants, max_participants)
  VALUES
    (scenario_uuid, 'evacuation', 'Responsible for safely evacuating participants, managing bottlenecks, and preventing discriminatory segregation', ARRAY[]::TEXT[], 2, 10),
    (scenario_uuid, 'triage', 'Establishes medical triage system, prioritizes injuries, and manages casualty zones', ARRAY[]::TEXT[], 2, 8),
    (scenario_uuid, 'media', 'Manages media relations, counters misinformation, and handles communications', ARRAY[]::TEXT[], 2, 6);
  
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
    'A sudden explosion occurs at the hard court. Smoke, dust, and debris obscure visibility. Panic spreads rapidly. People run in multiple directions, screaming. The extent of casualties is unknown.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
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
• "I saw five people down."
• "I only saw smoke."
• "Someone said there is a second device."
• "A man ran away after the blast."

No two accounts match.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
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
    'Dispatch (995 and 999) informs the coordination centre: "Traffic congestion is severe. Ambulances and police cannot reach your location within the initial 15-minute estimate." C2E must manage the crisis longer and more independently.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
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
    'A short clip showing the explosion aftermath appears online. Due to poor visibility, it appears that Malay youths are standing near the blast area. Online commenters claim:
• "Malay boys planted the bomb."
• "This is extremist terrorism."
• "Keep the Malays away from the exits."

The video is going viral rapidly.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
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
    NULL,
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
    NULL,
    true,
    true
  );
  
  -- ============================================
  -- PART 4: Create Evacuation Team Injects
  -- ============================================
  
  -- Evacuation Inject E1 - Exit Congestion (T+6)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  ) VALUES (
    scenario_uuid, 6, 'field_update',
    'Exit Congestion',
    'A major exit becomes clogged as more than 150 people attempt to leave simultaneously. A child has fallen, and several attendees are at risk of trampling. Immediate action required to manage the bottleneck.',
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
    'A volunteer reports: "There is a man standing near Exit B with a backpack. He isn''t evacuating." This could be the suicide attacker. Immediate security assessment needed. Coordinate with other teams.',
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
    'Volunteers report conflicting casualty numbers:
• "Three critical injuries."
• "I saw at least seven."
• "One person has stopped moving."

You cannot establish an accurate count. Smoke is obscuring injuries. Prioritize based on incomplete information.',
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
    'A viral WhatsApp audio note begins circulating: "There is a second bomb. The attacker was a Malay male. Stay away from the CC." This is false information spreading rapidly. You must counter this misinformation immediately.',
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
    'A Telegram channel posts: "Confirmed: Islamist terror attack at the community event. This is why we must separate communities." The false narrative is gaining traction. Old social media posts about unrelated incidents are resurfacing to reinforce prejudice.',
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
  
  RAISE NOTICE 'C2E Bombing scenario created successfully!';
  RAISE NOTICE 'Scenario ID: %', scenario_uuid;
  RAISE NOTICE 'Created 3 teams and 15 injects';
  
END $$;

-- Display summary
SELECT 
  'Scenario Created' as status,
  title,
  id as scenario_id
FROM scenarios 
WHERE title = 'C2E Bombing at Community Event';

SELECT 
  'Teams Created' as status,
  COUNT(*) as team_count
FROM scenario_teams st
JOIN scenarios s ON s.id = st.scenario_id
WHERE s.title = 'C2E Bombing at Community Event';

SELECT 
  'Injects Created' as status,
  COUNT(*) as inject_count,
  COUNT(*) FILTER (WHERE inject_scope = 'universal') as universal_count,
  COUNT(*) FILTER (WHERE inject_scope = 'team_specific') as team_specific_count
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'C2E Bombing at Community Event';

