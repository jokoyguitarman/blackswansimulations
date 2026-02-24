-- Prison Siege to Caliphate Declaration - Scenario Seed Script
-- Run this in your Supabase SQL Editor to create the scenario.
-- Requires: migrations applied, at least one user with role 'trainer' or 'admin' in user_profiles.

-- ============================================
-- PART 1: Create the Scenario
-- ============================================

DO $$
DECLARE
  scenario_uuid UUID;
  trainer_user_id UUID;
BEGIN
  SELECT id INTO trainer_user_id FROM user_profiles WHERE role IN ('trainer', 'admin') LIMIT 1;

  IF trainer_user_id IS NULL THEN
    RAISE EXCEPTION 'No trainer or admin user found. Please create a user with trainer or admin role first.';
  END IF;

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
    'Prison Siege to Caliphate Declaration',
    'This exercise examines how localized tactical success, combined with population coercion, ideological mobilisation, regional synchronisation, and foreign fighter inflows, can generate a rapid morale cascade among fragmented jihadist groups, producing consolidation effects that overwhelm conventional counterterrorism timelines.

A coordinated prison assault occurs at a neighbourhood detention facility. Attackers kill police, breach cell blocks, free and selectively recruit inmates, seize weapons, and withdraw into surrounding communities. The state response is delayed and fragmented; the local population initially displays overwhelming passive and active support. Some villages shelter militants for ideological, coercive, or economic reasons; cash, food, fuel, and intelligence are provided; protests emerge alleging discrimination and collective punishment. Primary node may be Sulu, Basilan, Marawi, or Maguindanao; spillover theatres include Java, Peninsular Malaysia, Sabah, Kalimantan.',
    'terrorism',
    'advanced',
    90,
    '[
      "Contain the siege and prevent spread",
      "Coordinate agencies under asymmetric information",
      "Manage narrative dominance in regional media",
      "Protect population and limit escalation",
      "Secure detention facilities and prevent second breach"
    ]'::jsonb,
    '{
      "primary_node": "Marawi",
      "location": "neighbourhood_detention_facility",
      "inmates_escaped": "unknown",
      "weapons_missing": true,
      "state_response": "delayed_fragmented",
      "population_sentiment": "dynamic"
    }'::jsonb,
    'You are part of a multi-agency response to a prison siege that may escalate toward regional synchronisation and ideological declaration. No single participant holds the full operational picture. Strategic success depends on coordination under asymmetric information. The adversary is modelled as a learning insurgent system that may delay, accelerate, or reconsolidate based on your actions.

**Key challenges:**
- Delayed and fragmented state response; population support and coercion dynamics
- Multiple agencies with different mandates and structural constraints
- Propaganda, foreign fighter flows, and potential second detention facility breach
- Narrative dominance and population compliance vs resentment

**Your role:** Work with your team and other agencies to contain the siege, coordinate effectively, and manage narrative and population safety.',
    '{
      "afp": "Armed Forces of the Philippines. Primary role: kinetic containment, territorial denial, siege response, escalation control. Structural constraints: civilian density and displacement, air-ground coordination delays, political sensitivity to heavy force after siege.",
      "pnp": "Philippines National Police. Primary role: internal security, investigations, detainee control, population interface. Structural constraints: prison system vulnerability, local political pressure, corruption and insider threat risk.",
      "esscom": "Eastern Sabah Security Command. Primary role: maritime interdiction, border security, Sabah littoral defence. Structural constraints: porous maritime borders, civilian maritime traffic, overlapping agency jurisdictions.",
      "special_branch": "Malaysian Special Branch. Primary role: counter-radicalisation, intelligence fusion, foreign fighter interdiction. Structural constraints: legal evidentiary thresholds, reliance on HUMINT, sensitivity of ethnic relations.",
      "densus_88": "Densus 88 (Indonesia). Primary role: tactical counterterrorism, network disruption, arrests. Structural constraints: legal arrest timelines, risk of martyrdom narratives, urban operating environment.",
      "bnpt": "Badan Nasional Penanggulangan Terorisme. Primary role: strategic coordination, prevention, counter-narratives, regional diplomacy. Structural constraints: non-kinetic mandate, inter-agency coordination limits, dependence on political messaging."
    }'::jsonb,
    trainer_user_id,
    true
  ) RETURNING id INTO scenario_uuid;

  -- ============================================
  -- PART 2: Create Team Definitions (6 agencies)
  -- ============================================

  INSERT INTO scenario_teams (scenario_id, team_name, team_description, required_roles, min_participants, max_participants)
  VALUES
    (scenario_uuid, 'afp', 'Armed Forces of the Philippines. Kinetic containment, territorial denial, siege response, escalation control. Constraints: civilian density, air-ground coordination delays, political sensitivity to heavy force.', ARRAY[]::TEXT[], 2, 10),
    (scenario_uuid, 'pnp', 'Philippines National Police. Internal security, investigations, detainee control, population interface. Constraints: prison system vulnerability, local political pressure, corruption/insider threat risk.', ARRAY[]::TEXT[], 2, 8),
    (scenario_uuid, 'esscom', 'Eastern Sabah Security Command. Maritime interdiction, border security, Sabah littoral defence. Constraints: porous maritime borders, civilian maritime traffic, overlapping agency jurisdictions.', ARRAY[]::TEXT[], 2, 6),
    (scenario_uuid, 'special_branch', 'Malaysian Special Branch. Counter-radicalisation, intelligence fusion, foreign fighter interdiction. Constraints: legal evidentiary thresholds, HUMINT reliance, sensitivity of ethnic relations.', ARRAY[]::TEXT[], 2, 6),
    (scenario_uuid, 'densus_88', 'Densus 88 (Indonesia). Tactical counterterrorism, network disruption, arrests. Constraints: legal arrest timelines, martyrdom narrative risk, urban operating environment.', ARRAY[]::TEXT[], 2, 6),
    (scenario_uuid, 'bnpt', 'Badan Nasional Penanggulangan Terorisme. Strategic coordination, prevention, counter-narratives, regional diplomacy. Constraints: non-kinetic mandate, inter-agency coordination limits, dependence on political messaging.', ARRAY[]::TEXT[], 2, 8);

  -- ============================================
  -- PART 3: Universal Injects (29: opening + Phase 1 + Phases 2-6 + international + intensity)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 0, 'field_update', 'Prison Overrun', 'Police units report loss of control at a detention facility. Unknown number of inmates have escaped. Weapons are missing.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 6, 'field_update', 'Community Shielding', 'Local officials report villages refusing entry to security forces, citing fear of abuse.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 20, 'media_report', 'Propaganda Surge', 'Videos circulate portraying the siege as a liberation of the oppressed.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 45, 'intel_brief', 'Second Prison Target Identified', 'Intelligence suggests reconnaissance activity around another detention centre.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  -- Phase 1: Funerals exploited
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 12, 'media_report', 'Funerals of Slain Police Exploited', 'Propaganda is framing the funerals of slain police to inflame grievances. Freed prisoners are being portrayed as "returned mujahidin." The narrative is gaining traction in sympathetic communities.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  -- Phases 2-6, international scope, intensity (T+50 through T+88)
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 50, 'field_update', 'Second Detention Facility Breach', 'A second detention facility has been overrun. Inmates freed, weapons seized. Recruitment and firepower have been amplified. State response is stretched across multiple flashpoints.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 52, 'political_pressure', 'ASEAN Emergency Meeting Convened', 'Regional bloc has called an emergency session. Some members are pushing for a joint statement; others are resisting. Your government is under pressure to align with a regional position.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 54, 'field_update', 'Multiple Flashpoints Simultaneous', 'Java bombing, unrest in a spillover theatre, and a prison incident are being reported in the same operational window. Command and intelligence bandwidth are stretched to the limit.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 55, 'media_report', 'Suicide Bombing in Java', 'A suicide bombing has occurred in Java with casualties. It signals regional momentum and is stretching intelligence and public attention across the region.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 56, 'media_report', 'International Media Spotlight', 'Major global outlets are leading with the siege. "Southeast Asian caliphate" framing is spreading. Diaspora communities and foreign governments are watching closely.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 58, 'intel_brief', 'Knife Attacks in Kuala Lumpur or Johor', 'Attacks on police or symbolic minority targets have been reported in Kuala Lumpur or Johor. The inevitability narrative is being reinforced; regional synchronisation is under way.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 60, 'intel_brief', 'Cross-Border Intelligence Sharing Stalls', 'Bilateral intelligence sharing with neighbours is delayed or conditional. Gaps in travel and border data are making foreign fighter flow harder to track.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 62, 'field_update', 'Armed Violence in Sabah or Kalimantan', 'Armed incidents have been reported in Sabah or Kalimantan. Regional synchronisation is in progress across spillover theatres.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 64, 'intel_brief', 'Propaganda Names Specific Units or Officials', 'Insurgent propaganda is naming specific local units or officials as targets. Personal and institutional risk is rising; morale and family pressure are growing.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 65, 'intel_brief', 'First Wave Foreign Fighter Influx', 'Foreign fighters are arriving via commercial flights, maritime routes (Sulu/Celebes), and overland. Profiles include Malaysians, Indonesians, Singaporeans, and Thais. They are being allocated to training, media, and specialist combat roles.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 66, 'political_pressure', 'Domestic Opposition Demands Statement', 'Parliament or opposition is demanding a government statement. "Who is in charge?" narrative is gaining traction. Political pressure is compounding operational load.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 68, 'political_pressure', 'Foreign Government Travel Advisories', 'Several countries have issued travel advisories or are evacuating staff. Some are threatening aid cuts or sanctions if the situation deteriorates. Diplomatic pressure is mounting.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 70, 'intel_brief', 'Proto-Governance Experiments', 'Militants are testing proto-governance in controlled areas. Interoperability between disparate groups is being tested. The conflict is shifting from pure insurgency toward territorial control.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 72, 'media_report', 'OIC or Human Rights Bodies Issue Statements', 'Regional or international bodies (OIC, human rights mechanisms) have issued statements of concern. Risk of investigations or resolutions is rising. Narrative and legitimacy are at stake.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 74, 'field_update', 'Supply Lines or Key Infrastructure Threatened', 'Roads or key infrastructure linking to the crisis zone are threatened or cut. Logistics and humanitarian access are at risk.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 75, 'media_report', 'Satellite Caliphate Declared', 'The insurgent coalition has declared an Islamic polity and seized a city or district. The declaration is being broadcast. Local support in seized areas is beginning to fracture.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 76, 'intel_brief', 'Foreign Fighter Origins Beyond Region', 'Reporting confirms foreign fighter arrivals from outside Southeast Asia (e.g. UK, EU, Australia, Middle East). The conflict is clearly internationalised.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 78, 'intel_brief', 'Local Support Fracturing', 'Reports indicate that local support in seized areas is fracturing. Displacement and humanitarian pressure are increasing. The militants'' hold is not unchallenged.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 79, 'intel_brief', 'Reports of Civilian Casualties in Seized Area', 'Unverified reports of civilian casualties in areas under insurgent control are emerging. Risk of war-crimes narrative and international scrutiny is rising.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 80, 'citizen_call', 'International NGO or UN Access Request', 'An international humanitarian or monitoring body has requested access to affected areas. Refusal versus access has major reputational and operational trade-offs.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 82, 'intel_brief', 'Second Wave Foreign Fighters', 'Foreign fighters from outside the region (UK, EU, Australia, Middle East) are arriving. Capabilities are increasing.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 84, 'political_pressure', 'Rumours of External Military Assistance', 'Unconfirmed reports suggest a foreign power may offer or has been asked for military or intelligence support. Sovereignty and escalation concerns are acute.', 'high', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 85, 'field_update', 'Militarisation: Tunnels, Snipers, IEDs', 'Tunnel construction to negate air power, snipers controlling urban high ground, and sophisticated IED belts and booby traps have been reported. Militant capabilities have escalated.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 86, 'citizen_call', 'Hostage Family Appeal or Ultimatum', 'Either a hostage family appeal has been broadcast or a militant ultimatum with a deadline has been issued. Time pressure and public emotion are extreme.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (scenario_uuid, 88, 'intel_brief', 'Hostage-Taking for Strategic Leverage', 'Hostages have been taken for strategic leverage. Political support is collapsing while coercive control in militant-held areas is peaking.', 'critical', '[]'::jsonb, 'universal', NULL, true, true);

  -- ============================================
  -- PART 4: AFP Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 8, 'intel_brief', 'Fragmented Battlespace (Early Phase)',
    'Intelligence indicates multiple armed groups moving independently toward the siege area. Numbers unclear. Some appear poorly trained; others display discipline. AI response: Uses dispersion to avoid decisive engagement, testing AFP ISR thresholds.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['afp'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 18, 'field_update', 'Civilian Interference (Mid Phase)',
    'Units report villagers blocking access roads and filming troop movements, claiming "community defence." AI response: Encourages population shielding, embeds fighters deeper.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['afp'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 35, 'intel_brief', 'Airstrike Dilemma (Urban Siege Phase)',
    'Precision strike options emerge, but intelligence suggests fighters are occupying evacuated civilian homes. AI response: Relocates command elements, weaponised civilian harm narratives.',
    'critical', '[]'::jsonb, 'team_specific', ARRAY['afp'], true, true
  );

  -- ============================================
  -- PART 5: PNP Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 2, 'field_update', 'Prison Network Panic (Immediate Aftermath)',
    'Wardens nationwide request reinforcements, citing fear of copycat sieges. AI response: Amplifies fear narratives to stretch PNP thin.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['pnp'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 25, 'intel_brief', 'Intelligence Leakage (Consolidation Phase)',
    'An internal memo appears on extremist channels hours after circulation. AI response: Accelerates second siege timeline.',
    'critical', '[]'::jsonb, 'team_specific', ARRAY['pnp'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 42, 'political_pressure', 'Community Backlash (Post-Caliphate Declaration)',
    'Arrest operations trigger protests accusing PNP of targeting Muslims collectively. AI response: Exploits grievances to deter arrests.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['pnp'], true, true
  );

  -- ============================================
  -- PART 6: ESSCOM Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 12, 'intel_brief', 'Maritime Anomalies (Pre-Foreign Fighter Phase)',
    'Increased small-boat traffic detected at night, but no clear contraband evidence. AI response: Tests enforcement thresholds with mixed legal/illicit movement.',
    'medium', '[]'::jsonb, 'team_specific', ARRAY['esscom'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 28, 'field_update', 'Armed Encounter at Sea (Escalation Phase)',
    'A patrol is fired upon by unknown militants who retreat into Philippine waters. AI response: Exploits jurisdictional seams to maintain routes.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['esscom'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 38, 'intel_brief', 'Sabah Spillover Fear (Urban Siege Phase)',
    'Local leaders warn of panic and rumours of imminent attacks in Sabah. AI response: Uses threat of expansion as deterrence signal.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['esscom'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 67, 'intel_brief', 'Maritime Patrol Request from Neighbour',
    'A neighbouring navy has requested coordinated patrol or handover of suspects in contested waters. Jurisdiction and escalation risks are in play.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['esscom'], true, true
  );

  -- ============================================
  -- PART 7: Malaysian Special Branch Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 14, 'intel_brief', 'Travel Pattern Anomalies (Early Regional Phase)',
    'Individuals with clean records book one-way flights to Mindanao-adjacent hubs. AI response: Diversifies travel methods to evade profiling.',
    'medium', '[]'::jsonb, 'team_specific', ARRAY['special_branch'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 22, 'intel_brief', 'Encrypted Network Expansion (Mid Phase)',
    'New Bahasa-Malay Telegram channels emerge glorifying the prison siege. AI response: Pushes recruitment faster than takedowns.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['special_branch'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 40, 'intel_brief', 'Returnee Risk (Late Phase)',
    'Intelligence suggests some fighters may return to Malaysia for attacks. AI response: Maintains ambiguity to overstretch monitoring.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['special_branch'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 63, 'intel_brief', 'Foreign Partner Requests Evidence for Extraditions',
    'A foreign partner has requested evidence on foreign fighters for potential prosecution or extradition. Legal and diplomatic friction are emerging.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['special_branch'], true, true
  );

  -- ============================================
  -- PART 8: Densus 88 Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 16, 'field_update', 'Spike in Domestic Attacks (Parallel Escalation Phase)',
    'Stabbings and suicide plots emerge, loosely inspired by Mindanao events. AI response: Forces D88 to prioritise domestic defence over external focus.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['densus_88'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 30, 'intel_brief', 'Shared Operatives (Foreign Fighter Phase)',
    'Some Indonesians entering Mindanao have previous arrest histories. AI response: Uses experienced operatives to train others.',
    'medium', '[]'::jsonb, 'team_specific', ARRAY['densus_88'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 44, 'intel_brief', 'Premature Arrest Dilemma (Late Phase)',
    'Acting too early risks exposing sources; waiting risks an attack. AI response: Exploits hesitation windows.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['densus_88'], true, true
  );

  -- ============================================
  -- PART 9: BNPT Injects (3)
  -- ============================================

  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 10, 'media_report', 'Narrative Contagion (Early Phase)',
    'Indonesian online discourse frames the siege as "defensive jihad." AI response: Amplifies grievance framing across platforms.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['bnpt'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 24, 'political_pressure', 'ASEAN Coordination Gap (Mid Phase)',
    'No unified regional position emerges on foreign fighter travel. AI response: Accelerates recruitment while policy lags.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['bnpt'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 42, 'political_pressure', 'Radicalisation vs Suppression Trade-off (Late Phase)',
    'Hard messaging risks backlash; soft messaging appears weak. AI response: Frames restraint as ideological victory.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['bnpt'], true, true
  );
  INSERT INTO scenario_injects (scenario_id, trigger_time_minutes, type, title, content, severity, affected_roles, inject_scope, target_teams, requires_response, requires_coordination)
  VALUES (
    scenario_uuid, 59, 'political_pressure', 'Regional Counter-Narrative Coordination Fails',
    'A proposed joint counter-message with neighbouring countries has fallen apart. Each country''s messaging is contradicting the other. Regional narrative coordination has failed.',
    'high', '[]'::jsonb, 'team_specific', ARRAY['bnpt'], true, true
  );

  -- ============================================
  -- PART 10: Scenario Objectives (5)
  -- ============================================

  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'containment', 'Contain the siege and prevent spread', 'Maintain perimeter, control flow of people/weapons; align with state operational tempo and cohesion.', 25.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'coordination', 'Coordinate agencies under asymmetric information', 'Clear command, shared situational awareness, inter-team coordination; no single participant holds full picture.', 25.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'narrative', 'Manage narrative dominance in regional media', 'Counter misinformation and ideological framing; consistent, responsible messaging.', 20.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'population_safety', 'Protect population and limit escalation', 'Avoid unnecessary escalation; consider population compliance vs resentment.', 15.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;
  INSERT INTO scenario_objectives (scenario_id, objective_id, objective_name, description, weight, success_criteria)
  VALUES (scenario_uuid, 'detention_security', 'Secure detention facilities and prevent second breach', 'Reduce prison system vulnerability; align with PNP/AFP roles.', 15.00, '{}'::jsonb)
  ON CONFLICT (scenario_id, objective_id) DO NOTHING;

  RAISE NOTICE 'Prison Siege to Caliphate Declaration scenario created successfully. Scenario ID: %', scenario_uuid;
  RAISE NOTICE 'Created 6 teams, 50 injects (29 universal + 21 team-specific), 5 objectives.';
END $$;

-- ============================================
-- Summary
-- ============================================

SELECT 'Scenario Created' AS status, title, id AS scenario_id
FROM scenarios
WHERE title = 'Prison Siege to Caliphate Declaration';

SELECT 'Teams' AS status, COUNT(*) AS team_count
FROM scenario_teams st
JOIN scenarios s ON s.id = st.scenario_id
WHERE s.title = 'Prison Siege to Caliphate Declaration';

SELECT 'Injects' AS status, COUNT(*) AS inject_count,
  COUNT(*) FILTER (WHERE inject_scope = 'universal') AS universal_count,
  COUNT(*) FILTER (WHERE inject_scope = 'team_specific') AS team_specific_count
FROM scenario_injects si
JOIN scenarios s ON s.id = si.scenario_id
WHERE s.title = 'Prison Siege to Caliphate Declaration';

SELECT 'Objectives' AS status, COUNT(*) AS objective_count
FROM scenario_objectives so
JOIN scenarios s ON s.id = so.scenario_id
WHERE s.title = 'Prison Siege to Caliphate Declaration';
