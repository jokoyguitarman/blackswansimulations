-- Add Decision-Based Injects to C2E Bombing Scenario
-- These injects trigger based on player decisions, not time

-- This script finds the C2E Bombing scenario and adds decision-based injects
-- Run this AFTER seed_c2e_scenario.sql has been executed

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  -- Find the C2E Bombing scenario
  SELECT id INTO scenario_uuid 
  FROM scenarios 
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;
  
  IF scenario_uuid IS NULL THEN
    RAISE EXCEPTION 'C2E Bombing scenario not found. Please run seed_c2e_scenario.sql first.';
  END IF;
  
  -- ============================================
  -- DECISION BRANCH 1A: Evacuate Everyone Together
  -- ============================================
  
  -- Inject 1: People Refuse Evacuation
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid, 
    NULL, -- No time-based trigger
    '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration"], "keywords": ["evacuate", "together", "everyone", "all"]}, "match_mode": "any"}',
    'field_update',
    'People Refuse Evacuation - Protests Break Out',
    'Despite your evacuation order to group everyone together, many people refuse to be grouped with Malay families due to fear from the viral misinformation. Protests break out at the evacuation zone. Some attendees are creating their own exit routes, causing chaos. A Malay volunteer assigned to evacuation is confronted by frightened residents. The evacuation is now stalled.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'People Refuse Evacuation - Protests Break Out'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration"], "keywords": ["evacuate", "together", "everyone", "all"]}, "match_mode": "any"}'
  );
  
  -- Inject 2: Alternative Exit Routes Created (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration"], "keywords": ["evacuate", "together", "everyone"]}, "match_mode": "any"}',
    'field_update',
    'Chaotic Self-Evacuation Creates New Risks',
    'Frightened attendees are bypassing your evacuation plan and creating their own exit routes. This uncontrolled movement is creating new bottlenecks and potential stampede risks. The suicide attacker (if still on site) could exploit these chaotic exit points. You''ve lost control of the evacuation flow.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Chaotic Self-Evacuation Creates New Risks'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration"], "keywords": ["evacuate", "together", "everyone"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 1B: Evacuate with Separate Groups
  -- ============================================
  
  -- Inject 3: Discriminatory Evacuation Causes Backlash
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["separate", "segregate", "malay", "demographic", "group"]}, "match_mode": "any"}',
    'media_report',
    'Discriminatory Evacuation Observed and Spreads Online',
    'Your decision to segregate evacuees by demographics has been observed by journalists and attendees. Photos and videos of the separation are spreading online. Community leaders are demanding answers. The discriminatory approach is inflaming tensions further. Some Malay families are refusing to comply with the segregation order.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Discriminatory Evacuation Observed and Spreads Online'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["separate", "segregate", "malay", "demographic", "group"]}, "match_mode": "any"}'
  );
  
  -- Inject 4: Legal/Policy Violation Concerns (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["separate", "segregate", "malay"]}, "match_mode": "any"}',
    'political_pressure',
    'Policy Violation Concerns Raised',
    'Internal communications indicate that your segregation decision may violate equal treatment policies. Legal advisors are questioning the decision. This could have serious consequences for the organization and individuals involved.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Policy Violation Concerns Raised'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["separate", "segregate", "malay"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 1C: Delay Evacuation
  -- ============================================
  
  -- Inject 5: Public Pressure Mounts
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["delay", "investigate", "wait", "evacuation"]}, "match_mode": "any"}',
    'political_pressure',
    'Public Demands Immediate Evacuation',
    'As you delay the evacuation to investigate, public pressure is mounting. Families are demanding to know why people aren''t being moved to safety. Online commentators are criticizing the delay. The situation inside the event grounds is becoming more volatile as people feel trapped.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Public Demands Immediate Evacuation'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["delay", "investigate", "wait", "evacuation"]}, "match_mode": "any"}'
  );
  
  -- Inject 6: Secondary Threat Risk Increases (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["delay", "investigate", "evacuation"]}, "match_mode": "any"}',
    'intel_brief',
    'Delayed Evacuation Creates Target Opportunity',
    'By keeping people on site longer, you''ve created a larger target for the potential suicide attacker. Intelligence suggests that maximum crowd density is exactly what the attacker is waiting for. The delay may be playing into the attacker''s hands.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Delayed Evacuation Creates Target Opportunity'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["delay", "investigate", "evacuation"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 2A: Statement Addressing Misinformation
  -- ============================================
  
  -- Inject 7: Statement Partially Effective
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["misinformation", "false", "deny", "clarify"]}, "match_mode": "any"}',
    'media_report',
    'Public Statement Receives Mixed Response',
    'Your statement addressing the misinformation has been published. Some online commentators appreciate the clarification, but others are demanding more specific details. The viral claims continue to circulate, but at a slower rate. The statement needs reinforcement.',
    'medium',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    false,
    false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Public Statement Receives Mixed Response'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["misinformation", "false", "deny", "clarify"]}, "match_mode": "any"}'
  );
  
  -- Inject 8: Statement Backfires (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["misinformation", "false", "deny", "clarify"]}, "match_mode": "any"}',
    'media_report',
    'Statement Misinterpreted, Backfires',
    'Your statement has been misinterpreted by some media outlets. Headlines are twisting your words to suggest you''re "covering up" information. The situation has worsened. You may need to issue a clarification.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    true,
    false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Statement Misinterpreted, Backfires'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["misinformation", "false", "deny", "clarify"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 2B: Statement Without Addressing Misinformation
  -- ============================================
  
  -- Inject 9: Statement Fails to Counter Misinformation
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["statement", "public", "update"]}, "match_mode": "any"}',
    'media_report',
    'Public Statement Fails to Address Viral Claims',
    'Your statement has been published, but it hasn''t addressed the viral claims about Malay involvement. Online commentators are criticizing the lack of clarity. The misinformation continues to spread unchecked. Community tensions are escalating as people interpret your silence as confirmation of the rumors.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Public Statement Fails to Address Viral Claims'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["statement", "public", "update"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 2C: Refuse to Comment
  -- ============================================
  
  -- Inject 10: Media Vacuum Filled by Speculation
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["refuse", "decline", "withhold", "no comment"]}, "match_mode": "any"}',
    'media_report',
    'Media Vacuum Filled by Speculation and Rumors',
    'Your refusal to comment has created an information vacuum. Journalists and online commentators are filling it with speculation. The false narrative about Malay involvement is now being reported as "unconfirmed reports" rather than being debunked. The situation is spiraling out of control.',
    'critical',
    '[]'::jsonb,
    'team_specific',
    ARRAY['media'],
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Media Vacuum Filled by Speculation and Rumors'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["public_statement"], "keywords": ["refuse", "decline", "withhold", "no comment"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 3A: Prioritize Triage Over Evacuation Coordination
  -- ============================================
  
  -- Inject 11: Evacuation Coordination Suffers (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["resource_allocation"], "keywords": ["triage", "medical", "casualties", "priority", "focus", "primary"]}, "match_mode": "any"}',
    'field_update',
    'Lack of Coordination Causes Evacuation Delays',
    'While you focus on triage, the evacuation teams are operating without proper coordination. Exit routes are becoming more congested. The lack of communication between triage and evacuation is creating bottlenecks and confusion.',
    'high',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Lack of Coordination Causes Evacuation Delays'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["resource_allocation"], "keywords": ["triage", "medical", "casualties", "priority", "focus", "primary"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 3B: Allow Filming of Casualty Zone
  -- ============================================
  
  -- Inject 12: Victim Privacy Violated
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["policy_change"], "keywords": ["allow", "permit", "filming", "media", "casualty", "triage"]}, "match_mode": "any"}',
    'media_report',
    'Victim Privacy Violated, Backlash Ensues',
    'Your decision to allow filming of the casualty zone has resulted in graphic images of injured victims being broadcast online. Families are outraged. The violation of victim privacy is creating additional trauma and legal concerns. You''re being criticized for prioritizing media access over victim dignity.',
    'high',
    '[]'::jsonb,
    'team_specific',
    ARRAY['triage', 'media'],
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Victim Privacy Violated, Backlash Ensues'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["policy_change"], "keywords": ["allow", "permit", "filming", "media", "casualty", "triage"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 4A: Ignore Suspicious Individual Report
  -- ============================================
  
  -- Inject 13: Missed Threat Opportunity (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["ignore", "dismiss", "unfounded", "false alarm"]}, "match_mode": "any"}',
    'intel_brief',
    'Suspicious Individual Activity Escalates',
    'The suspicious individual near Exit B is now moving closer to a crowded evacuation route. Volunteers report the person is acting erratically and appears to be waiting for something. You may have missed a critical security threat by dismissing the initial report.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Suspicious Individual Activity Escalates'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["operational_action"], "keywords": ["ignore", "dismiss", "unfounded", "false alarm"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 4B: Coordinate Multi-Team Response
  -- ============================================
  
  -- Inject 14: Coordinated Response Successful (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["coordination_order"], "keywords": ["coordinate", "investigate", "suspicious", "security", "assess"]}, "match_mode": "any"}',
    'field_update',
    'Coordinated Security Assessment Prevents Incident',
    'Your coordinated response to the suspicious individual report has allowed teams to assess the situation safely. The individual has been identified and the threat level has been properly evaluated. This demonstrates effective inter-team coordination.',
    'medium',
    '[]'::jsonb,
    'universal',
    NULL,
    false,
    false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Coordinated Security Assessment Prevents Incident'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["coordination_order"], "keywords": ["coordinate", "investigate", "suspicious", "security", "assess"]}, "match_mode": "any"}'
  );
  
  -- ============================================
  -- DECISION BRANCH 5A: Combined Decision Scenario
  -- ============================================
  
  -- Inject 15: Perfect Storm - Multiple Failures Compound (SUGGESTION)
  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, trigger_condition, type, title, content, severity,
    affected_roles, inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT 
    scenario_uuid,
    NULL,
    '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration", "public_statement"], "keywords": ["evacuate", "together", "statement", "public", "update"]}, "match_mode": "all"}',
    'field_update',
    'Crisis Escalates: Evacuation Fails, Misinformation Spreads Unchecked',
    'The combination of evacuating everyone together (without addressing fears) and failing to counter the misinformation has created a perfect storm. People are refusing to evacuate, creating their own exit routes, and the false narrative is now being treated as fact. The situation is spiraling out of control. Multiple teams need to coordinate an emergency response.',
    'critical',
    '[]'::jsonb,
    'universal',
    NULL,
    true,
    true
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects 
    WHERE scenario_id = scenario_uuid 
      AND title = 'Crisis Escalates: Evacuation Fails, Misinformation Spreads Unchecked'
      AND trigger_condition = '{"type": "decision_based", "match_criteria": {"categories": ["emergency_declaration", "public_statement"], "keywords": ["evacuate", "together", "statement", "public", "update"]}, "match_mode": "all"}'
  );
  
  RAISE NOTICE 'Decision-based injects processed for C2E Bombing scenario!';
  RAISE NOTICE 'Scenario ID: %', scenario_uuid;
  RAISE NOTICE 'Note: Duplicate injects were skipped (if any already existed).';
  
END $$;

-- Display summary
SELECT 
  'Decision-Based Injects Added' as status,
  COUNT(*) as inject_count,
  COUNT(*) FILTER (WHERE si.title LIKE '%SUGGESTION%' OR si.title LIKE '%Suggestion%') as suggestion_count,
  COUNT(*) FILTER (WHERE si.title NOT LIKE '%SUGGESTION%' AND si.title NOT LIKE '%Suggestion%') as core_count
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'C2E Bombing at Community Event'
  AND si.trigger_condition IS NOT NULL
  AND si.trigger_time_minutes IS NULL;

