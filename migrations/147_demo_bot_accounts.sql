-- Demo bot accounts for the autoplay system.
-- These auth.users rows are used server-side only by DemoActionDispatcher.
-- The handle_new_user() trigger auto-creates user_profiles from raw_user_meta_data.

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at
)
VALUES
  -- Police Commander
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000001', 'authenticated', 'authenticated',
   'demo-bot-police@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"cdr.harris","full_name":"CDR. Harris","role":"police_commander","agency_name":"Metro Police – Tactical Command"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"police_commander"}'::jsonb,
   NOW(), NOW()),

  -- Triage / Health Director
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000002', 'authenticated', 'authenticated',
   'demo-bot-triage@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"dr.okafor","full_name":"Dr. Okafor","role":"health","agency_name":"National Emergency Medical Services"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"health_director"}'::jsonb,
   NOW(), NOW()),

  -- Evacuation / Civil Government
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000003', 'authenticated', 'authenticated',
   'demo-bot-evacuation@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"supt.grant","full_name":"Supt. Grant","role":"civil","agency_name":"City Emergency Management"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"civil_government"}'::jsonb,
   NOW(), NOW()),

  -- Media / PIO
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000004', 'authenticated', 'authenticated',
   'demo-bot-media@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"s.chen","full_name":"Sarah Chen","role":"public_information_officer","agency_name":"Joint Media Information Centre"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"public_information_officer"}'::jsonb,
   NOW(), NOW()),

  -- Fire / HAZMAT
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000005', 'authenticated', 'authenticated',
   'demo-bot-fire@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"chief.mabaso","full_name":"Chief Mabaso","role":"defence","agency_name":"Fire & Rescue Services"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"defence_liaison"}'::jsonb,
   NOW(), NOW()),

  -- Intelligence
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000006', 'authenticated', 'authenticated',
   'demo-bot-intel@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"agent.k","full_name":"Agent Kruger","role":"intelligence","agency_name":"National Intelligence Coordination Centre"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"intelligence_analyst"}'::jsonb,
   NOW(), NOW()),

  -- Negotiation
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000007', 'authenticated', 'authenticated',
   'demo-bot-negotiation@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"insp.viljoen","full_name":"Insp. Viljoen","role":"police_commander","agency_name":"Crisis Negotiation Unit"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"police_commander"}'::jsonb,
   NOW(), NOW()),

  -- Mall Security
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000008', 'authenticated', 'authenticated',
   'demo-bot-security@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"mgr.naidoo","full_name":"Mgr. Naidoo","role":"defence","agency_name":"Venue Security Operations"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"defence_liaison"}'::jsonb,
   NOW(), NOW()),

  -- Demo Trainer (owns demo sessions)
  ('00000000-0000-0000-0000-000000000000',
   'a0000000-de00-b000-0001-000000000099', 'authenticated', 'authenticated',
   'demo-trainer@blackswan.internal',
   crypt('DemoBotNoLogin!2026', gen_salt('bf')), NOW(),
   '{"username":"demo.trainer","full_name":"Demo System","role":"trainer","agency_name":"Black Swan Simulations"}'::jsonb,
   '{"provider":"email","providers":["email"],"role":"trainer"}'::jsonb,
   NOW(), NOW())

ON CONFLICT (id) DO NOTHING;
