-- C2E Detailed Insider Knowledge: full environment per C2E_INSIDER_INTEL_REFERENCE.md
-- Replaces the minimal layout_ground_truth + custom_facts with granular, team-relevant data.
-- Removes pre-named "Triage zone A" (teams decide where to site triage).
-- Run after 057 + 059. Idempotent: finds scenario by title and overwrites insider_knowledge.

DO $$
DECLARE
  scenario_uuid UUID;
  rows_updated INT;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '061: C2E Bombing scenario not found; skipping. Run demo/seed_c2e_scenario.sql if needed.';
    RETURN;
  END IF;

  UPDATE scenarios
  SET
    vicinity_map_url = COALESCE(vicinity_map_url, 'https://placehold.co/600x400/1a1a2e/eee?text=Vicinity+Map'),
    layout_image_url = COALESCE(layout_image_url, 'https://placehold.co/600x400/1a1a2e/eee?text=Layout'),
    insider_knowledge = jsonb_build_object(

      -- ==============================
      -- LAYOUT GROUND TRUTH (shared)
      -- ==============================
      'layout_ground_truth', jsonb_build_object(
        'evacuee_count', 1000,

        'exits', jsonb_build_array(
          jsonb_build_object('id', 'N',  'label', 'North exit',       'flow_per_min', 120, 'status', 'open',      'width_m', 4,   'notes', 'Main gate to carpark; double gate.'),
          jsonb_build_object('id', 'S',  'label', 'South exit',       'flow_per_min', 80,  'status', 'open',      'width_m', 3,   'notes', 'To playground and HDB blocks; single gate.'),
          jsonb_build_object('id', 'E',  'label', 'East exit',        'flow_per_min', 60,  'status', 'open',      'width_m', 2,   'notes', 'Narrow path beside community club.'),
          jsonb_build_object('id', 'W',  'label', 'West exit',        'flow_per_min', 45,  'status', 'congested', 'width_m', 2.5, 'notes', 'Shared with service vehicles; currently jammed by parked van.'),
          jsonb_build_object('id', 'CC', 'label', 'Community club',   'flow_per_min', 90,  'status', 'open',      'width_m', 3.5, 'notes', 'Indoor route through club lobby to side street.')
        ),

        'blast_site', jsonb_build_object(
          'description', 'Single detonation near the stage/sound system at the north end of the hard court central seating area.',
          'debris_radius_m', 15,
          'structural_damage', 'One covered shelter and sections of perimeter fencing damaged.',
          'inner_cordon_m', 20,
          'cordon_rule', 'No entry except authorised response personnel for casualty pickup at edge of cordon.'
        ),

        'zones', jsonb_build_array(
          jsonb_build_object('id', 'gz',     'label', 'Ground zero',           'capacity', 0,   'type', 'cordon',   'notes', 'Blast epicentre; no entry.'),
          jsonb_build_object('id', 'cordon', 'label', 'Inner cordon perimeter','capacity', 0,   'type', 'cordon',   'notes', 'Inner 20 m ring; authorised response only.')
        )
      ),

      -- ==============================
      -- SITE AREAS (for triage siting decisions – descriptors only, no "triage zone" labels)
      -- ==============================
      'site_areas', jsonb_build_array(
        jsonb_build_object(
          'id', 'north_side',
          'label', 'North side of court',
          'surface', 'concrete',
          'level', true,
          'area_m2', 80,
          'has_cover', true,
          'cover_notes', 'Covered shelter (partially damaged but usable).',
          'capacity_lying', 45,
          'capacity_standing', 120,
          'distance_to_cordon_m', 35,
          'vehicle_access', true,
          'vehicle_notes', 'Carpark access, two lanes to main road; ambulance can reach.',
          'stretcher_route', true,
          'stretcher_notes', 'Wide path to North exit; trolley-friendly.',
          'ambulance_pickup', 'North carpark bay A (2 bays).',
          'water', true,
          'water_notes', 'Tap at court edge.',
          'power', true,
          'power_notes', 'Permanent lights (some damaged by blast).',
          'hazards', 'Partially collapsed shelter overhead; check structural integrity before use.',
          'wind_exposure', 'Upwind of cordon in afternoon (wind from east).'
        ),
        jsonb_build_object(
          'id', 'south_side',
          'label', 'South side of court',
          'surface', 'concrete',
          'level', true,
          'area_m2', 100,
          'has_cover', false,
          'cover_notes', 'Open; no overhead cover.',
          'capacity_lying', 65,
          'capacity_standing', 200,
          'distance_to_cordon_m', 40,
          'vehicle_access', false,
          'vehicle_notes', 'No vehicle access; pedestrian only via South exit.',
          'stretcher_route', true,
          'stretcher_notes', 'Level path to South exit; manageable for stretchers.',
          'ambulance_pickup', 'None directly; nearest pickup at playground 50 m south.',
          'water', false,
          'water_notes', 'No tap on south side.',
          'power', false,
          'power_notes', 'No permanent lighting; would need portable.',
          'hazards', 'Exposed to sun in afternoon; no shade.',
          'wind_exposure', 'Clear of smoke drift.'
        ),
        jsonb_build_object(
          'id', 'east_strip',
          'label', 'East side (along community club)',
          'surface', 'paved',
          'level', true,
          'area_m2', 30,
          'has_cover', true,
          'cover_notes', 'Under club awning; indoor space available (first aid room, toilets).',
          'capacity_lying', 15,
          'capacity_standing', 50,
          'distance_to_cordon_m', 45,
          'vehicle_access', true,
          'vehicle_notes', 'Single lane via club driveway.',
          'stretcher_route', true,
          'stretcher_notes', 'Narrow but passable; trolley requires careful navigation.',
          'ambulance_pickup', 'One bay at club driveway.',
          'water', true,
          'water_notes', 'Tap inside club; first aid room has running water.',
          'power', true,
          'power_notes', 'Club has mains power; indoor lighting available.',
          'hazards', 'Narrow access; could bottleneck if used for both casualty flow and evacuation.',
          'wind_exposure', 'Sheltered by building.'
        ),
        jsonb_build_object(
          'id', 'west_area',
          'label', 'West side (service road area)',
          'surface', 'grass and paved',
          'level', true,
          'area_m2', 150,
          'has_cover', true,
          'cover_notes', 'Partial cover from adjacent block overhang.',
          'capacity_lying', 50,
          'capacity_standing', 200,
          'distance_to_cordon_m', 30,
          'vehicle_access', true,
          'vehicle_notes', 'Service road access but currently congested (parked van blocking).',
          'stretcher_route', false,
          'stretcher_notes', 'Service road jammed; stretcher movement impeded until cleared.',
          'ambulance_pickup', 'Service road bay (blocked until van moved).',
          'water', false,
          'water_notes', 'No tap on west side.',
          'power', false,
          'power_notes', 'Limited after dusk; nearest power from adjacent block.',
          'hazards', 'Moving service vehicles; congested exit; close to cordon (30 m).',
          'wind_exposure', 'Downwind of cordon; smoke may drift this direction.'
        ),
        jsonb_build_object(
          'id', 'adjacent_field',
          'label', 'Adjacent grass field (north-west)',
          'surface', 'grass',
          'level', true,
          'area_m2', 300,
          'has_cover', false,
          'cover_notes', 'Open field; no overhead cover.',
          'capacity_lying', 100,
          'capacity_standing', 500,
          'distance_to_cordon_m', 60,
          'vehicle_access', true,
          'vehicle_notes', 'Accessible from carpark via grass verge; soft ground in rain.',
          'stretcher_route', true,
          'stretcher_notes', 'Wide open; easy stretcher movement on dry ground.',
          'ambulance_pickup', 'Carpark edge 20 m away.',
          'water', false,
          'water_notes', 'No tap; would need portable supply.',
          'power', false,
          'power_notes', 'No permanent power; would need generator.',
          'hazards', 'Uneven ground in places; no lighting after dusk.',
          'wind_exposure', 'Open; check wind before siting.'
        )
      ),

      -- ==============================
      -- OSM VICINITY
      -- ==============================
      'osm_vicinity', jsonb_build_object(
        'center', jsonb_build_object('lat', 1.3521, 'lng', 103.8198),
        'radius_meters', 2000,

        'hospitals', jsonb_build_array(
          jsonb_build_object('name', 'Tan Tock Seng Hospital', 'lat', 1.3264, 'lng', 103.8482, 'address', '11 Jalan Tan Tock Seng', 'notes', 'A&E; major trauma capability.'),
          jsonb_build_object('name', 'Bishan Community Hospital', 'lat', 1.3502, 'lng', 103.8491, 'address', '1 Bishan Place', 'notes', 'Rehab facility; can take overflow for non-critical.'),
          jsonb_build_object('name', 'Toa Payoh Polyclinic', 'lat', 1.3343, 'lng', 103.8494, 'address', '2003 Toa Payoh Lor 8', 'notes', 'First aid and minor injuries only.')
        ),

        'police', jsonb_build_array(
          jsonb_build_object('name', 'Bishan North NPC', 'lat', 1.3506, 'lng', 103.8472, 'address', '510 Bishan Street 13'),
          jsonb_build_object('name', 'Toa Payoh East NPC', 'lat', 1.3345, 'lng', 103.8512, 'address', '157 Lorong 2 Toa Payoh'),
          jsonb_build_object('name', 'Ang Mo Kio Division HQ', 'lat', 1.3752, 'lng', 103.8490, 'address', '2 Ang Mo Kio Ave 4', 'notes', 'Division level; tactical resources.')
        ),

        'cctv_or_surveillance', jsonb_build_array(
          jsonb_build_object('location', 'Hard court main gate (North)', 'lat', 1.3522, 'lng', 103.8196, 'notes', 'Covers main entrance and northern seating area.'),
          jsonb_build_object('location', 'Community club lobby', 'lat', 1.3519, 'lng', 103.8201, 'notes', 'Covers east side and club entrance.'),
          jsonb_build_object('location', 'Multi-storey carpark rooftop', 'lat', 1.3525, 'lng', 103.8189, 'notes', 'Overview of court and approach roads.'),
          jsonb_build_object('location', 'Bus interchange (east)', 'lat', 1.3510, 'lng', 103.8210, 'notes', 'Covers evacuation route to east and bus stop area.')
        ),

        'emergency_routes', jsonb_build_array(
          jsonb_build_object('description', 'Bishan Street 13 – north corridor to hospital zone', 'highway_type', 'primary', 'one_way', false),
          jsonb_build_object('description', 'Lorong 2 Toa Payoh – east access from main road', 'highway_type', 'secondary', 'one_way', false),
          jsonb_build_object('description', 'Service road behind community club – inbound only', 'highway_type', 'service', 'one_way', true)
        )
      ),

      -- ==============================
      -- CUSTOM FACTS (granular, per-topic)
      -- ==============================
      'custom_facts', jsonb_build_array(

        -- Event / blast
        jsonb_build_object(
          'topic', 'event',
          'summary', 'Community event at neighbourhood hard court, ~1000 participants.',
          'detail', 'Large grassroots community event at a neighbourhood hard court. Central seating area near the detonation point. Stage and sound system at north end; food stalls along east side. Multi-ethnic attendance.'
        ),
        jsonb_build_object(
          'topic', 'blast_site',
          'summary', 'Single detonation near centre of seating area; ~10–15 m debris radius.',
          'detail', 'Detonation occurred near the stage/sound system at the north end. Ground zero is cordoned; inner cordon ~20 m. One covered shelter and sections of fencing damaged. Casualty pickup at edge of cordon only.'
        ),
        jsonb_build_object(
          'topic', 'timing',
          'summary', 'Incident occurred during peak of event; evacuation in progress.',
          'detail', 'Blast occurred approximately 45 minutes after event start, during peak attendance. Evacuation and response operations are ongoing. West exit currently congested; other exits open.'
        ),

        -- Ground zero / cordon (evacuation team)
        jsonb_build_object(
          'topic', 'ground_zero_cordon',
          'summary', 'Inner cordon 20 m from epicentre; no entry except authorised response.',
          'detail', 'Inner cordon perimeter is ~20 m from blast epicentre. No unauthorised entry. Casualty pickup at edge of cordon only. Recommended safe distance for any assembly or staging: at least 30 m from cordon edge.'
        ),

        -- Assembly potential (evacuation team)
        jsonb_build_object(
          'topic', 'assembly_potential',
          'summary', 'Several areas around court could hold evacuees; capacity varies.',
          'detail', 'North side: level concrete, ~120 standing capacity, covered (partially damaged shelter). South side: level concrete, ~200 standing, open (no cover). West side: grass/paved, ~200 standing, partially covered but congested and close to cordon. Adjacent field (NW): grass, ~500 standing, open, far from cordon (~60 m) but no utilities. East strip: paved, ~50 standing, club awning cover, limited space.'
        ),

        -- Access for responders (evacuation team)
        jsonb_build_object(
          'topic', 'access_for_responders',
          'summary', 'Vehicle access from north (carpark) and east (club driveway); west blocked.',
          'detail', 'North: carpark access, two lanes to main road; ambulance bay A (2 bays). East: single lane via club driveway; one ambulance bay. South: no vehicle access, pedestrian only. West: service road currently blocked by parked van. Routes from main roads: Bishan Street 13 (north) and Lorong 2 Toa Payoh (east).'
        ),

        -- Space/terrain (triage siting)
        jsonb_build_object(
          'topic', 'space_terrain',
          'summary', 'Flat areas available on all sides of court; surface, cover, and size vary.',
          'detail', 'North side: 80 m², concrete, covered (damaged shelter), ~45 lying capacity. South side: 100 m², concrete, open, ~65 lying. East strip: 30 m², paved, club awning + indoor first aid room, ~15 lying. West area: 150 m², grass/paved, partial cover, ~50 lying but congested and close to cordon. Adjacent field: 300 m², grass, open, ~100 lying but no utilities or cover.'
        ),

        -- Access/egress for casualty movement (triage siting)
        jsonb_build_object(
          'topic', 'access_egress',
          'summary', 'Stretcher and vehicle access varies by area; east and north best for ambulance.',
          'detail', 'North: wide path to North exit, trolley-friendly, ambulance bay at carpark (2 bays). East: narrow but passable, one ambulance bay at club driveway. South: level path for stretchers, no ambulance access (nearest pickup 50 m south at playground). West: service road jammed, stretcher movement impeded until cleared.'
        ),

        -- Safety/hazards (triage siting)
        jsonb_build_object(
          'topic', 'safety_hazards',
          'summary', 'North shelter has collapse risk; west is downwind; south and east are safest.',
          'detail', 'North: partially collapsed shelter overhead—check structural integrity before use; 35 m from cordon. South: 40 m from cordon, clear of smoke, exposed to sun. East: 45 m from cordon, sheltered by building, narrow access could bottleneck. West: 30 m from cordon (closest), downwind (smoke drift possible), service vehicles moving. Adjacent field: 60 m from cordon, open, safest distance but uneven ground.'
        ),

        -- Utilities/resources (triage siting)
        jsonb_build_object(
          'topic', 'utilities_resources',
          'summary', 'Water and power available at north and east; south and west have neither.',
          'detail', 'North: tap at court edge, permanent lights (some damaged). East: tap inside club, first aid room with running water, club has mains power and indoor lighting. South: no tap, no permanent lighting. West: no tap, limited power after dusk. Adjacent field: no tap, no power—would need portable supply and generator.'
        ),

        -- Proximity/flow (triage siting)
        jsonb_build_object(
          'topic', 'proximity_flow',
          'summary', 'North and east areas are closest to high-flow exits; south has moderate flow.',
          'detail', 'North side: 10 m to North exit (120/min). East strip: 15 m to East exit (60/min) and close to Community club exit (90/min). South side: 5 m to South exit (80/min). West area: 10 m to West exit (45/min, currently congested). Adjacent field: 20 m to carpark edge, 30 m to North exit.'
        ),

        -- Media team: verified facts
        jsonb_build_object(
          'topic', 'verified_facts_incident',
          'summary', 'Single detonation at community event, hard court; approximate time known.',
          'detail', 'Confirmed: single detonation at a community event at a neighbourhood hard court. Approximate time of incident known. NOT yet confirmed: exact casualty count, identity or motive of perpetrator, whether secondary devices exist. Do not speculate on unconfirmed details.'
        ),
        jsonb_build_object(
          'topic', 'verified_facts_casualties_evacuation',
          'summary', 'Evacuation in progress; casualty figures not yet confirmed.',
          'detail', 'Evacuation of participants is in progress via multiple exits. Casualty figures are not yet confirmed and should not be released. No official casualty count is available. Emergency services have been notified but are delayed (estimated 15+ minutes).'
        ),

        -- Media team: information environment
        jsonb_build_object(
          'topic', 'information_environment',
          'summary', 'False claims circulating: "second bomb" and "Malay attacker"; journalists on site.',
          'detail', 'Known false claims in circulation: (1) viral WhatsApp voice note claiming a "second bomb" — unverified, no evidence. (2) Telegram posts claiming "Islamist terror attack" and blaming a "Malay attacker" — unverified, no confirmed perpetrator identity. (3) Old social media posts from unrelated incidents resurfacing. Journalists are arriving on site and requesting comment. Bystanders are filming the casualty zone.'
        ),

        -- Media team: sensitivities
        jsonb_build_object(
          'topic', 'sensitivities',
          'summary', 'Multi-ethnic event; risk of ethnic/religious tension; avoid unconfirmed identity claims.',
          'detail', 'This was a multi-ethnic community event. There is an active risk of ethnic and religious tension if unconfirmed claims about perpetrator ethnicity are repeated or amplified. Avoid naming any ethnic or religious group in connection with the attack until officially confirmed. A Malay volunteer has already been confronted by a frightened resident during evacuation—tensions are real and present.'
        ),

        -- Media team: official sources
        jsonb_build_object(
          'topic', 'official_sources',
          'summary', 'C2E Committee is the coordinating body; emergency services delayed.',
          'detail', 'The C2E Committee is the coordinating body for this incident. Emergency services (SCDF, SPF) have been activated but are delayed—estimated 15+ minutes. No designated spokesperson script is provided; the Media team must decide what to say, when, and who speaks. Coordinate with Evacuation and Triage teams before making public statements to ensure accuracy.'
        )
      )
    )
  WHERE id = scenario_uuid;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '061: C2E detailed insider_knowledge applied (rows updated: %)', rows_updated;
END $$;
