-- Enrich scenario cc083638-1865-47c7-9c3b-b4fe380def3f (Abbott Factory Tuas bombing)
-- with facility-aware hazards, casualties, and insider knowledge.
--
-- Abbott Manufacturing Singapore: 26 Tuas South Avenue 10, Singapore 637437
-- 500,000 sq ft nutritional/pharmaceutical manufacturing plant on 16-hectare site
-- Products: infant formula (Similac), nutritional supplements (Ensure, PediaSure), milk powder
-- On-site chemicals: hydrogen peroxide (sanitation), chlorine dioxide (water treatment),
--   glycol ethers (cleaning), ammonia (refrigeration), nitrogen (inerting), CO2 (carbonation)
-- Key risks: milk powder dust explosion, ammonia release, chemical storage fire,
--   structural collapse (large open-plan production halls), cold-chain refrigerant leak

DO $$
DECLARE
  v_scenario_id UUID := 'cc083638-1865-47c7-9c3b-b4fe380def3f';
  v_center_lat NUMERIC := 1.28334;
  v_center_lng NUMERIC := 103.63486;
BEGIN

-- ============================================================
-- 1. DELETE existing data so we can re-insert cleanly
-- ============================================================
DELETE FROM scenario_hazards    WHERE scenario_id = v_scenario_id;
DELETE FROM scenario_casualties WHERE scenario_id = v_scenario_id;
DELETE FROM scenario_locations  WHERE scenario_id = v_scenario_id;

-- ============================================================
-- 2. HAZARDS — facility-aware for Abbott nutritional plant
-- ============================================================

-- H1: Primary blast site — production hall
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description
) VALUES (
  v_scenario_id,
  'explosion',
  v_center_lat + 0.0002,
  v_center_lng - 0.0001,
  'G',
  '{
    "fuel_source": "IED detonated inside main production hall near spray-drying tower",
    "blast_yield_kg_tnt": 15,
    "venue_material_context": "Production hall contains stainless steel spray-drying towers (30m tall), conveyor systems, and fine milk-powder residue on all surfaces. Blast has ruptured spray-dryer feed lines, releasing aerosolised milk powder into the air — creating secondary dust explosion risk.",
    "structural_damage": "Partial roof collapse over 40m section of production hall. Steel I-beam supports buckled. Mezzanine walkway collapsed onto production floor. Loading dock doors blown outward.",
    "fire_risk": "Scattered ignition sources from severed electrical conduits. Milk powder dust cloud in enclosed space is at explosive concentration (>60g/m³).",
    "secondary_hazards": ["dust_explosion_risk", "ammonia_leak", "structural_instability"],
    "estimated_debris_field_m": 80
  }'::jsonb,
  '["Establish 100m exclusion zone immediately", "Do NOT use water fog until dust cloud has settled — electrostatic ignition risk", "Request DART structural assessment before entry", "Ventilate production hall before allowing fire teams inside", "Monitor LEL readings continuously — milk powder dust explosion threshold is 60g/m³"]'::jsonb,
  'active',
  0,
  'The main blast has torn through the heart of Abbott''s production hall, rupturing a 30-metre spray-drying tower and collapsing a 40-metre section of the corrugated steel roof. Twisted steel I-beams hang at acute angles over the production floor, and the mezzanine-level operator walkway has pancaked onto the conveyor belt line below. A choking white haze of aerosolised milk powder fills the hall — the fine particulate (median diameter 30μm) is well above the Minimum Explosible Concentration of 60g/m³, making any spark or friction source capable of triggering a devastating secondary dust explosion. Severed 415V three-phase electrical conduits arc intermittently near the east wall. The spray-dryer feed lines have been sheared, and reconstituted milk formula pools across the floor mixing with hydraulic fluid from the collapsed conveyor system. The smell is an acrid blend of burnt milk protein, scorched insulation, and the metallic tang of hot steel.'
);

-- H2: Ammonia refrigeration leak — cold storage area
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description, resolution_requirements, deterioration_timeline
) VALUES (
  v_scenario_id,
  'chemical_release',
  v_center_lat - 0.0001,
  v_center_lng + 0.0003,
  'G',
  '{
    "chemical_agent": "Anhydrous ammonia (NH3)",
    "source": "Industrial refrigeration system for cold-chain storage of finished nutritional products",
    "estimated_volume_kg": 450,
    "concentration_ppm": 350,
    "idlh_ppm": 300,
    "wind_direction": "NE at 8 km/h",
    "venue_material_context": "Abbott''s cold storage warehouse contains 2 x 500kg ammonia compressor units serving -20°C blast freezers and 4°C cold rooms. Blast shockwave has cracked the high-pressure liquid line on Unit 2, producing a steady vapour release. Cloud is drifting NE toward the staff canteen and visitor carpark.",
    "exposure_symptoms": "Immediate: eye/throat irritation, coughing, chest tightness. >300ppm: pulmonary oedema, chemical burns to airways. >500ppm: potentially fatal within 30 minutes.",
    "ppe_required": "Level B HAZMAT suit with SCBA minimum. Level A if entering vapour cloud directly."
  }'::jsonb,
  '["Evacuate downwind areas immediately — cloud drifting NE toward canteen", "Establish HAZMAT exclusion zone 200m downwind", "Deploy ammonia gas monitors at perimeter", "Do NOT apply water directly to liquid ammonia pool — exothermic reaction", "Isolate compressor Unit 2 at emergency shutoff valve (east wall of cold storage)", "Coordinate with NEA for atmospheric monitoring"]'::jsonb,
  'active',
  3,
  'The blast shockwave has propagated through the factory structure and cracked the high-pressure liquid line on Ammonia Compressor Unit 2 in the cold storage warehouse. Anhydrous ammonia — a colourless gas with an unmistakable acrid stench — is venting at an estimated 2kg/minute through a 15mm fracture in the copper pipe. The cold storage area is rapidly filling with a visible white vapour cloud as the ammonia condenses in the humid tropical air. Readings at the warehouse door already show 350ppm — well above the IDLH of 300ppm. The prevailing NE breeze is pushing the plume across the loading bay toward the staff canteen (120m away) where approximately 80 workers have self-evacuated. Two cold-storage technicians who were inside performing routine checks at the time of the blast are unaccounted for and presumed still inside the contaminated zone.',
  '{
    "personnel": ["HAZMAT team (minimum 4-person entry)", "Ammonia-rated technician to isolate valve", "Medical standby with bronchodilators"],
    "equipment": ["Level B HAZMAT suits with SCBA", "Ammonia gas monitors (Dräger or equivalent)", "Decontamination corridor", "Emergency shutoff tools for refrigeration valves"],
    "procedures": ["Approach from upwind (SW)", "Isolate emergency shutoff valve on east wall", "Establish decon corridor before any personnel exit contaminated zone", "Monitor for 15 minutes after isolation to confirm leak has stopped"],
    "estimated_time_minutes": 45
  }'::jsonb,
  '{
    "if_unaddressed_30min": "Ammonia cloud expands to 300m radius covering canteen, visitor carpark, and reaching Tuas South Avenue 10. Multiple civilian exposure casualties. Concentration in cold storage reaches >1000ppm — lethal for any trapped personnel. NEA activates public health alert for Tuas Biomedical Park II.",
    "escalation_stages": [
      {"at_minutes": 5, "description": "Cloud reaches canteen — 80+ workers experience eye and throat irritation"},
      {"at_minutes": 15, "description": "Concentration at cold storage door exceeds 500ppm. Trapped technicians at risk of fatal exposure"},
      {"at_minutes": 25, "description": "Cloud reaches Tuas South Avenue 10. SCDF activates district-wide HAZMAT alert"},
      {"at_minutes": 40, "description": "Full 450kg charge vents. Cloud visible from 1km. NEA public health emergency declared for Tuas area"}
    ]
  }'::jsonb
);

-- H3: Milk powder dust explosion risk — packaging wing
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description
) VALUES (
  v_scenario_id,
  'dust_explosion',
  v_center_lat + 0.0003,
  v_center_lng + 0.0002,
  'G',
  '{
    "fuel_source": "Milk powder dust (Similac infant formula and Ensure nutritional supplement powder)",
    "mec_gm3": 60,
    "current_concentration_gm3": 85,
    "venue_material_context": "Packaging wing houses 6 high-speed filling lines that pack powdered formula into cans at 400 units/minute. The blast has ruptured 3 bulk powder hoppers (each holding 2 tonnes of finished product), coating every surface in fine powder. Ventilation system is offline — dust cannot dissipate. Any ignition source will trigger a secondary explosion potentially more destructive than the primary IED.",
    "ignition_sources": ["Damaged electrical panels (3-phase 415V)", "Friction from collapsed conveyor bearings", "Static discharge from powder-coated metal surfaces", "Emergency lighting battery packs with exposed terminals"],
    "blast_potential": "Secondary dust explosion in this confined volume could generate overpressure of 7-10 bar — sufficient to demolish remaining structure"
  }'::jsonb,
  '["ABSOLUTE PRIORITY: Eliminate all ignition sources before entry", "Cut power to packaging wing at main distribution board (located in utilities corridor)", "Do NOT use metal tools — non-sparking bronze/beryllium copper only", "Gentle water mist (not jet) to suppress airborne dust — but only AFTER power is isolated", "No radio transmissions inside packaging wing until dust is suppressed below MEC", "Intrinsically safe equipment only"]'::jsonb,
  'delayed',
  0,
  'The packaging wing — a 5,000m² enclosed hall immediately east of the main production area — is a ticking time bomb. Three bulk powder hoppers have been ruptured by the blast shockwave, dumping approximately 6 tonnes of fine milk powder (median particle size 30μm, moisture content <4%) into the air and across every surface. Visibility inside is less than 2 metres. The ventilation and dust extraction systems are offline — both the primary HVAC and the dedicated dust collection system lost power when the blast severed the main electrical trunk. Atmospheric sampling at the doorway reads 85g/m³ — well above the Minimum Explosible Concentration of 60g/m³ for milk powder. Inside the hall, damaged 415V electrical panels still have live circuits, a collapsed conveyor bearing is grinding intermittently, and the emergency lighting battery packs have cracked casings with exposed terminals. Any one of these ignition sources could trigger a secondary dust explosion that, in this confined volume, would generate overpressures of 7-10 bar — enough to flatten the entire wing and propagate blast effects into the adjacent production hall where rescue teams may already be operating.'
);

-- H4: Chemical storage fire — sanitation chemicals area
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description, resolution_requirements
) VALUES (
  v_scenario_id,
  'chemical_fire',
  v_center_lat - 0.0002,
  v_center_lng - 0.0002,
  'G',
  '{
    "fire_class": "D (oxidiser-fed chemical fire)",
    "fuel_source": "Hydrogen peroxide (35% concentration, 4 x 300-gallon storage totes) and chlorine dioxide solution used for CIP sanitation of production equipment",
    "venue_material_context": "Chemical storage area contains sanitation chemicals for Clean-In-Place (CIP) systems. Blast has toppled two hydrogen peroxide totes, mixing H2O2 with organic residues (milk protein) on the floor — exothermic decomposition reaction producing oxygen, heat, and steam. Adjacent chlorine dioxide drums are heating.",
    "toxic_products": ["Chlorine gas (from heated ClO2)", "Oxygen-enriched atmosphere (from H2O2 decomposition)", "Hydrochloric acid vapour"],
    "temperature_c": 180,
    "spread_rate": "Moderate — self-sustaining exothermic reaction, not dependent on external fuel"
  }'::jsonb,
  '["Do NOT apply water — H2O2 decomposition is exothermic and water accelerates it", "Isolate area — toxic chlorine gas generation", "Use dry chemical or CO2 extinguishers only", "Full SCBA mandatory — mixed toxic atmosphere", "Monitor for oxygen enrichment — O2 levels above 23.5% make everything more flammable", "Evacuate 150m radius due to chlorine gas drift"]'::jsonb,
  'active',
  8,
  'Two 300-gallon totes of 35% hydrogen peroxide have toppled in the chemical storage area, flooding the bunded floor with approximately 800 litres of concentrated oxidiser. The H2O2 is reacting violently with organic residues — dried milk protein and cleaning agent surfactants — producing a vigorous exothermic decomposition that generates pure oxygen gas, superheated steam, and heat exceeding 180°C. The reaction is self-sustaining and accelerating. Worse, the radiant heat is warming the adjacent chlorine dioxide drums; if these reach 40°C they will begin to decompose, releasing toxic chlorine gas into the already compromised atmosphere. The area smells of bleach, hot metal, and an acrid chemical burn. A thick white vapour — a mix of steam and oxidiser decomposition products — billows from the storage room door, reducing visibility in the adjacent corridor to near zero.',
  '{
    "personnel": ["HAZMAT team with chemical fire specialist", "Industrial chemist advisor (Abbott site safety officer if available)"],
    "equipment": ["Dry chemical extinguishers (ABC rated)", "CO2 extinguishers for small perimeter fires", "Chlorine gas monitors", "Oxygen monitors", "Level A HAZMAT suits"],
    "procedures": ["Isolate chemical storage area from ventilation system", "Apply dry chemical to suppress reaction", "Cool chlorine dioxide drums with gentle water mist from maximum distance if they have not yet begun decomposing", "Do NOT attempt to right the H2O2 totes — let reaction exhaust itself under suppression"],
    "estimated_time_minutes": 60
  }'::jsonb
);

-- H5: Structural collapse risk — warehouse loading dock
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description
) VALUES (
  v_scenario_id,
  'structural_collapse',
  v_center_lat + 0.0001,
  v_center_lng - 0.0003,
  'G',
  '{
    "structure_type": "Pre-cast concrete tilt-up warehouse with steel portal frame roof",
    "damage_level": "Severe — 3 of 8 tilt-up wall panels displaced from footings, roof truss deflection visible",
    "venue_material_context": "Finished-goods warehouse storing palletised canned formula (Similac, Ensure, PediaSure). 12-metre high racking system partially collapsed. Multiple 40-foot shipping containers at loading dock have shifted on their chassis. Overhead crane rail deformed.",
    "collapse_probability": "High within 2 hours if not shored",
    "trapped_persons_estimated": 4,
    "access_constraints": "Loading dock doors jammed by shifted containers. Pedestrian access via fire escape on north wall only."
  }'::jsonb,
  '["DART structural assessment required before entry", "Shore displaced tilt-up panels before allowing rescue teams inside", "Do NOT use overhead crane — rail is deformed and unsafe", "Access via north fire escape only — loading dock blocked by shifted containers", "Monitor for progressive collapse indicators — cracking sounds, dust puffs from joints", "Limit rescue team size to 6 persons maximum to reduce floor loading"]'::jsonb,
  'active',
  0,
  'The finished-goods warehouse — a 8,000m² pre-cast concrete tilt-up structure — has sustained severe blast damage. Three of the eight tilt-up wall panels on the south face have been displaced from their steel angle footings by up to 300mm, leaving the 12-metre-high walls leaning precariously outward. The steel portal-frame roof trusses above these panels show visible deflection, and ceiling purlins have buckled. Inside, the 4-tier pallet racking system has partially collapsed in a domino effect, burying the aisles under tonnes of canned nutritional formula. Four warehouse workers who were picking orders at the time of the blast are believed trapped under collapsed racking in aisles 3 and 5. The overhead gantry crane rail has deformed, making the crane inoperable and creating an additional overhead hazard. Two 40-foot shipping containers at the loading dock have shifted on their chassis, jamming the roller doors shut.'
);

-- H6: Ruptured gas main — utilities corridor (delayed hazard)
INSERT INTO scenario_hazards (
  scenario_id, hazard_type, location_lat, location_lng, floor_level,
  properties, assessment_criteria, status, appears_at_minutes,
  enriched_description
) VALUES (
  v_scenario_id,
  'gas_leak',
  v_center_lat,
  v_center_lng + 0.0004,
  'B1',
  '{
    "gas_type": "Natural gas (methane) — factory process heating supply",
    "source": "80mm underground gas main fractured by blast ground-shock",
    "flow_rate": "Estimated 50 m³/hour",
    "lel_percent": 35,
    "venue_material_context": "Abbott uses natural gas for process heating (pasteurisation, spray-drying). The underground main runs through the utilities corridor beneath the production hall. Blast ground-shock has fractured the main at a bend. Gas is migrating upward through cable ducts and floor penetrations into the production hall above.",
    "ppe_required": "SCBA, non-sparking tools, intrinsically safe monitors"
  }'::jsonb,
  '["Evacuate production hall immediately — gas migrating upward through floor penetrations", "Contact SP Group for emergency gas shutoff at street valve", "Continuous LEL monitoring at all floor levels", "Absolute ban on ignition sources — no cutting, grinding, or welding", "Ventilate utilities corridor if safe to do so", "This hazard compounds the dust explosion risk in the packaging wing"]'::jsonb,
  'delayed',
  12,
  'A delayed secondary hazard has emerged: the underground 80mm natural gas main that feeds Abbott''s process heating systems (pasteurisation kettles, spray-dryer burners) has been fractured by the blast''s ground-shock wave at a pipe bend in the utilities corridor beneath the production hall. Methane is seeping upward through cable ducts, pipe penetrations, and expansion joints in the concrete floor slab. LEL readings in the utilities corridor are at 35% and climbing. Gas has been detected at floor level in the production hall above — directly compounding the already critical dust explosion risk in the adjacent packaging wing. The smell of mercaptan (gas odorant) is now noticeable to rescue teams in the production area. SP Group''s nearest emergency shutoff valve is at the street boundary, 200 metres from the leak point.'
);


-- ============================================================
-- 3. CASUALTIES — RED triage (critical / immediate)
-- ============================================================

INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00022, v_center_lng - 0.00008, '1F', 1, '{
  "triage_color": "red", "name": "Ahmad bin Ismail", "age": 34, "sex": "M",
  "role": "Spray-dryer operator — was on mezzanine walkway monitoring dryer temperature when blast occurred",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "burn", "severity": "critical", "body_part": "arms, chest, face", "visible_signs": "Full-thickness burns to 40% BSA, charred skin peeling on forearms, face blistered and weeping. Clothing fused to chest."},
    {"type": "fracture", "severity": "severe", "body_part": "left tibia", "visible_signs": "Open fracture with bone visible through torn trouser leg. Moderate bleeding. Foot rotated outward."},
    {"type": "inhalation", "severity": "severe", "body_part": "airway", "visible_signs": "Singed nasal hairs, hoarse voice, audible stridor. Soot deposits around nostrils and mouth."}
  ],
  "visible_description": "Male worker in scorched white coveralls lying at base of collapsed mezzanine walkway. Severe facial burns, left leg at unnatural angle with exposed bone. Speaking hoarsely but coherently. Breathing with audible wheeze.",
  "treatment_requirements": [
    {"intervention": "Advanced airway management", "priority": "critical", "reason": "Impending inhalation oedema will obstruct airway within 20 minutes"},
    {"intervention": "IV fluid resuscitation — Parkland formula", "priority": "critical", "reason": "40% BSA burns require aggressive fluid replacement"},
    {"intervention": "Open fracture splinting", "priority": "high", "reason": "Prevent further neurovascular compromise and contamination"},
    {"intervention": "Burns dressings — do NOT cool with water if >20% BSA", "priority": "high", "reason": "Risk of hypothermia in extensive burns despite tropical climate"}
  ],
  "transport_prerequisites": ["Airway secured", "IV access x2 established", "Fracture splinted and bleeding controlled"],
  "contraindications": ["Do NOT cool burns with water — >20% BSA risks hypothermia", "Do NOT remove clothing fused to skin", "Do NOT apply tight circumferential dressings — risk of compartment syndrome"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Don PPE", "detail": "Nitrile gloves, N95 respirator, eye protection — dust and chemical vapour environment"},
    {"step": 2, "action": "Primary survey DRABC", "detail": "Check airway patency — note stridor indicating impending obstruction"},
    {"step": 3, "action": "Secure airway", "detail": "Prepare for RSI or surgical airway if oedema progresses. Supraglottic airway as bridge."},
    {"step": 4, "action": "Establish IV access", "detail": "Two large-bore IVs. Begin Parkland formula: 4ml x 80kg x 40% BSA = 12,800ml over 24h, half in first 8h."},
    {"step": 5, "action": "Splint fracture", "detail": "Traction splint for open tibial fracture. Cover wound with sterile saline-soaked dressing."},
    {"step": 6, "action": "Package for transport", "detail": "Spine board, thermal blanket, continuous monitoring. Priority 1 transport."}
  ],
  "required_ppe": ["Nitrile gloves", "N95 respirator", "Eye protection", "Gown"],
  "required_equipment": [
    {"item": "Advanced airway kit", "quantity": 1, "purpose": "Secure threatened airway before oedema closes it"},
    {"item": "IV cannula 14G", "quantity": 2, "purpose": "Large-bore access for Parkland fluid resuscitation"},
    {"item": "Normal saline 1L bags", "quantity": 4, "purpose": "Initial fluid resuscitation"},
    {"item": "Traction splint", "quantity": 1, "purpose": "Immobilise open tibial fracture"},
    {"item": "Burns dressings (non-adherent)", "quantity": 6, "purpose": "Cover 40% BSA burns"},
    {"item": "Pulse oximeter", "quantity": 1, "purpose": "Continuous SpO2 monitoring"}
  ],
  "expected_time_to_treat_minutes": 15,
  "recommended_transport": "Singapore General Hospital Burns Centre",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Stridor worsening. Voice now barely audible. Facial oedema increasing."},
    {"at_minutes": 20, "description": "Airway obstruction imminent. Cannot swallow. Drooling. SpO2 dropping rapidly."},
    {"at_minutes": 30, "description": "Complete airway obstruction. Cardiac arrest from hypoxia. Triage upgrades to BLACK."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C2: QC lab technician — chemical exposure to eyes
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00015, v_center_lng + 0.00012, 'G', 1, '{
  "triage_color": "red", "name": "Dr. Priya Venkatesh", "age": 29, "sex": "F",
  "role": "QC microbiologist — testing batch samples when blast shattered chemical cabinet",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "chemical_burn", "severity": "critical", "body_part": "face and eyes", "visible_signs": "Both eyes clamped shut, continuous tearing, skin on forehead and cheeks raw and weeping. Clutching face."},
    {"type": "laceration", "severity": "moderate", "body_part": "arms and torso", "visible_signs": "Multiple glass fragment wounds on both forearms. Lab coat soaked with blood and chemical."},
    {"type": "inhalation", "severity": "severe", "body_part": "lungs", "visible_signs": "Coughing blood-tinged sputum. Speaking in short sentences between coughs."}
  ],
  "visible_description": "Young woman in white lab coat stumbling with hands over eyes. Lab coat torn and blood-stained. Coughing and crying out that she cannot see. Strong chemical smell around her.",
  "treatment_requirements": [
    {"intervention": "Immediate copious eye irrigation — minimum 20 minutes continuous", "priority": "critical", "reason": "H2O2 chemical burn to corneas — every minute of delay increases risk of permanent blindness"},
    {"intervention": "Skin decontamination", "priority": "high", "reason": "Remove residual H2O2 from face and skin"},
    {"intervention": "Oxygen therapy", "priority": "high", "reason": "Chlorine dioxide inhalation causing chemical pneumonitis"},
    {"intervention": "Wound packing for glass lacerations", "priority": "medium", "reason": "Control bleeding but not life-threatening"}
  ],
  "transport_prerequisites": ["Eye irrigation commenced for minimum 10 minutes before transport", "Decontamination of skin completed", "Oxygen therapy established"],
  "contraindications": ["Do NOT let patient rub eyes", "Do NOT apply pressure patches over eyes — chemical still present", "Do NOT delay irrigation for any reason — seconds matter for corneal survival"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Don PPE", "detail": "Nitrile gloves, eye protection — residual H2O2 on patient skin"},
    {"step": 2, "action": "Begin eye irrigation immediately", "detail": "Morgan lens if available, otherwise direct saline stream to both eyes. Minimum 2L saline continuous flush."},
    {"step": 3, "action": "Remove contaminated clothing", "detail": "Cut away lab coat. Flush all exposed skin with copious water."},
    {"step": 4, "action": "Administer oxygen", "detail": "15L/min via non-rebreather mask for chemical inhalation injury."},
    {"step": 5, "action": "Control laceration bleeding", "detail": "Direct pressure with haemostatic gauze on worst forearm wound. Leave glass fragments in situ."},
    {"step": 6, "action": "Transport with ongoing irrigation", "detail": "Continue eye irrigation during transport. Priority 1 to ophthalmology."}
  ],
  "required_ppe": ["Nitrile gloves", "Eye protection", "Gown"],
  "required_equipment": [
    {"item": "Morgan lens or eye irrigation kit", "quantity": 1, "purpose": "Continuous bilateral eye irrigation"},
    {"item": "Normal saline 1L", "quantity": 3, "purpose": "Eye and skin decontamination"},
    {"item": "Non-rebreather mask", "quantity": 1, "purpose": "High-flow oxygen for chemical inhalation"},
    {"item": "Haemostatic gauze", "quantity": 2, "purpose": "Control laceration bleeding"}
  ],
  "expected_time_to_treat_minutes": 12,
  "recommended_transport": "National University Hospital — ophthalmology consult",
  "deterioration_timeline": [
    {"at_minutes": 5, "description": "Without irrigation, corneal opacification beginning. Increasing pain."},
    {"at_minutes": 15, "description": "Corneal perforation risk. Vision loss becoming irreversible."},
    {"at_minutes": 30, "description": "Bilateral corneal destruction. Permanent blindness. Chemical pneumonitis worsening — may need intubation."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C3: Cold storage technician — ammonia exposure (trapped)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00012, v_center_lng + 0.00028, 'G', 1, '{
  "triage_color": "red", "name": "Tan Wei Ming", "age": 42, "sex": "M",
  "role": "Refrigeration technician — trapped in cold storage room with rising ammonia concentration, sheltering behind blast freezer door",
  "mobility": "non_ambulatory", "consciousness": "confused", "breathing": "labored",
  "injuries": [
    {"type": "chemical_exposure", "severity": "critical", "body_part": "lungs", "visible_signs": "Severe bronchospasm, audible wheezing from 3 metres. Lips cyanotic. Drooling — cannot swallow."},
    {"type": "hypothermia", "severity": "moderate", "body_part": "whole body", "visible_signs": "Shivering violently. Skin pale and cold. Sheltering inside -20°C blast freezer to escape ammonia."},
    {"type": "chemical_burn", "severity": "moderate", "body_part": "hands and neck", "visible_signs": "Red, blistered skin on both hands and around collar line. Ammonia contact burns."}
  ],
  "visible_description": "Man in blue coveralls huddled behind blast freezer door inside cold storage. Severe shivering, audible wheezing, lips blue. Calls out weakly but words are incoherent. Strong ammonia smell in area.",
  "treatment_requirements": [
    {"intervention": "HAZMAT extraction — Level B minimum", "priority": "critical", "reason": "Cannot treat in contaminated atmosphere — must extract first"},
    {"intervention": "Nebulised salbutamol", "priority": "critical", "reason": "Severe bronchospasm from ammonia inhalation"},
    {"intervention": "High-flow oxygen 15L/min", "priority": "critical", "reason": "SpO2 82% — chemical pneumonitis developing"},
    {"intervention": "Warm IV fluids", "priority": "high", "reason": "Core temperature dropping from -20°C freezer exposure"},
    {"intervention": "Skin decontamination", "priority": "high", "reason": "Remove residual ammonia from hands and neck"}
  ],
  "transport_prerequisites": ["Extracted from contaminated zone", "Decontamination completed", "Bronchospasm partially controlled", "IV access established"],
  "contraindications": ["Do NOT enter without SCBA — ammonia >300ppm", "Do NOT use warming blankets until decontaminated", "Do NOT delay extraction for treatment — treat after extraction"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Don Level B HAZMAT with SCBA", "detail": "Full HAZMAT protection required — ammonia concentration lethal in this area"},
    {"step": 2, "action": "Extract patient from cold storage", "detail": "Carry patient to decon corridor. Protect your own airway — SCBA mandatory."},
    {"step": 3, "action": "Full decontamination", "detail": "Strip contaminated clothing, flush all skin with water for minimum 5 minutes"},
    {"step": 4, "action": "Nebulised salbutamol", "detail": "5mg salbutamol via nebuliser for severe bronchospasm"},
    {"step": 5, "action": "High-flow oxygen", "detail": "15L/min via non-rebreather mask. Target SpO2 >94%."},
    {"step": 6, "action": "Warm IV fluids", "detail": "Warmed normal saline to address hypothermia. Monitor ECG for arrhythmias."},
    {"step": 7, "action": "Transport", "detail": "Priority 1 to SGH ICU — chemical inhalation injury specialist."}
  ],
  "required_ppe": ["Level B HAZMAT suit", "SCBA", "Chemical-resistant gloves"],
  "required_equipment": [
    {"item": "SCBA set", "quantity": 2, "purpose": "Respiratory protection for extraction team"},
    {"item": "Salbutamol nebules 5mg", "quantity": 3, "purpose": "Bronchospasm treatment"},
    {"item": "Non-rebreather mask", "quantity": 1, "purpose": "High-flow oxygen delivery"},
    {"item": "IV warmer", "quantity": 1, "purpose": "Warm fluids for hypothermia"},
    {"item": "Warming blankets", "quantity": 2, "purpose": "Post-decon rewarming"}
  ],
  "expected_time_to_treat_minutes": 20,
  "recommended_transport": "Singapore General Hospital ICU — chemical inhalation specialist",
  "deterioration_timeline": [
    {"at_minutes": 5, "description": "Bronchospasm worsening. SpO2 dropping below 80%. Becoming less responsive."},
    {"at_minutes": 15, "description": "Pulmonary oedema developing. Pink frothy sputum. May need intubation."},
    {"at_minutes": 25, "description": "Fatal pulmonary oedema if still in contaminated zone. Hypothermia somewhat protective but cardiac arrhythmia risk increasing."}
  ]
}'::jsonb, 'undiscovered', 3);

-- C4: Second cold storage worker — deceased
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00008, v_center_lng + 0.00032, 'G', 1, '{
  "triage_color": "black", "name": "Ravi Subramaniam", "age": 38, "sex": "M",
  "role": "Cold storage inventory clerk — was directly adjacent to ruptured ammonia line when it fractured",
  "mobility": "non_ambulatory", "consciousness": "unresponsive", "breathing": "absent",
  "injuries": [
    {"type": "chemical_exposure", "severity": "critical", "body_part": "lungs and airways", "visible_signs": "No chest movement. Pupils fixed and dilated. Skin mottled grey-blue. Massive ammonia exposure — found face-down near ruptured pipe."}
  ],
  "visible_description": "Male worker in blue coveralls lying face-down near ruptured ammonia pipe. No signs of breathing. Skin discoloured grey-blue. No response to voice or pain stimulus.",
  "treatment_requirements": [
    {"intervention": "Confirm death — check for signs of life", "priority": "critical", "reason": "Confirm expectant status before moving on to salvageable patients"}
  ],
  "transport_prerequisites": ["Confirmation of death", "HAZMAT decon of remains before transport"],
  "contraindications": ["Do NOT attempt resuscitation in contaminated atmosphere", "Do NOT delay treatment of salvageable patients for deceased"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Don Level B HAZMAT with SCBA", "detail": "Ammonia concentration lethal in this area"},
    {"step": 2, "action": "Check for signs of life", "detail": "Pulse check, pupil response, breathing assessment — confirm death"},
    {"step": 3, "action": "Tag BLACK", "detail": "Mark triage tag and note location. Do NOT move until scene is processed."},
    {"step": 4, "action": "Prioritise living patients", "detail": "Focus resources on Tan Wei Ming who is still alive in the freezer area."}
  ],
  "required_ppe": ["Level B HAZMAT suit", "SCBA"],
  "required_equipment": [
    {"item": "Triage tag (black)", "quantity": 1, "purpose": "Mark deceased"},
    {"item": "Body bag", "quantity": 1, "purpose": "Remains recovery after HAZMAT decon"}
  ],
  "expected_time_to_treat_minutes": 2,
  "recommended_transport": "HSA mortuary",
  "deterioration_timeline": []
}'::jsonb, 'undiscovered', 3);

-- C5: Warehouse picker — crush injury
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00012, v_center_lng - 0.00028, 'G', 1, '{
  "triage_color": "red", "name": "Mohammad Farhan", "age": 26, "sex": "M",
  "role": "Warehouse picker — pinned under collapsed pallet racking in aisle 3, buried under cases of canned Similac",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "crush_injury", "severity": "critical", "body_part": "pelvis and both lower limbs", "visible_signs": "Trapped under ~800kg of collapsed steel racking and canned product. Both legs invisible under debris. Pale, diaphoretic, tachycardic."},
    {"type": "internal_bleeding", "severity": "severe", "body_part": "abdomen", "visible_signs": "Abdominal distension and guarding on palpation. Rigid abdomen."}
  ],
  "visible_description": "Young male worker pinned from the waist down under collapsed steel racking and hundreds of cans of infant formula. Alert and talking but pale and sweating heavily. Only upper body visible. Calling out for help.",
  "treatment_requirements": [
    {"intervention": "IV fluid bolus BEFORE extrication", "priority": "critical", "reason": "Crush syndrome will cause lethal hyperkalaemia on release — must pre-load with fluids and bicarbonate"},
    {"intervention": "Sodium bicarbonate 8.4% infusion", "priority": "critical", "reason": "Alkalinise urine to prevent myoglobin-induced renal failure"},
    {"intervention": "Cardiac monitoring during extrication", "priority": "critical", "reason": "Hyperkalaemia can cause fatal cardiac arrhythmia within minutes of crush release"},
    {"intervention": "Pelvic binder", "priority": "high", "reason": "Suspected pelvic fracture from crush weight"},
    {"intervention": "Tourniquet standby for lower limbs", "priority": "high", "reason": "Apply immediately on extrication if massive haemorrhage"}
  ],
  "transport_prerequisites": ["IV fluids running for minimum 30 minutes before extrication", "Bicarbonate infusion commenced", "Cardiac monitor attached", "Tourniquets staged on both thighs ready to apply"],
  "contraindications": ["Do NOT extricate without pre-treatment — crush syndrome will kill within minutes", "Do NOT delay IV access — the longer he is trapped, the worse the crush syndrome on release", "Do NOT give potassium-containing fluids (Hartmanns/Ringers lactate)"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Establish IV access x2", "detail": "Both antecubital fossae. Start normal saline 1L bolus immediately."},
    {"step": 2, "action": "Start bicarbonate infusion", "detail": "50mEq sodium bicarbonate in 1L NS. Goal: alkalinise urine to pH >6.5."},
    {"step": 3, "action": "Attach cardiac monitor", "detail": "Continuous 3-lead ECG. Watch for peaked T-waves (hyperkalaemia)."},
    {"step": 4, "action": "Stage tourniquets", "detail": "Place tourniquets on both thighs above crush line — do NOT tighten yet."},
    {"step": 5, "action": "Coordinate with DART for mechanical extrication", "detail": "Hydraulic spreaders to lift racking. Controlled, slow release."},
    {"step": 6, "action": "Extricate with monitoring", "detail": "Slow lift. Watch ECG continuously. Apply tourniquets if massive bleeding."},
    {"step": 7, "action": "Pelvic binder and transport", "detail": "Apply pelvic binder. Priority 1 transport to SGH Trauma with crush protocol alert."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat", "Safety boots"],
  "required_equipment": [
    {"item": "IV cannula 14G", "quantity": 2, "purpose": "Large-bore access for aggressive fluid resuscitation"},
    {"item": "Normal saline 1L", "quantity": 4, "purpose": "Pre-extrication fluid loading"},
    {"item": "Sodium bicarbonate 8.4%", "quantity": 2, "purpose": "Alkalinise urine — prevent renal failure"},
    {"item": "Cardiac monitor", "quantity": 1, "purpose": "Continuous ECG during extrication"},
    {"item": "CAT tourniquet", "quantity": 2, "purpose": "Standby for both lower limbs on release"},
    {"item": "Pelvic binder", "quantity": 1, "purpose": "Stabilise suspected pelvic fracture"},
    {"item": "Hydraulic spreaders", "quantity": 1, "purpose": "Lift collapsed steel racking"}
  ],
  "expected_time_to_treat_minutes": 45,
  "recommended_transport": "Singapore General Hospital Trauma Centre — crush syndrome protocol",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Increasing pain in trapped limbs. Becoming more tachycardic and anxious."},
    {"at_minutes": 30, "description": "Muscle tissue dying under crush. Myoglobin building up. If extricated now without pre-treatment, cardiac arrest within 5 minutes."},
    {"at_minutes": 60, "description": "Irreversible muscle necrosis in both legs. Even with treatment, bilateral above-knee amputation likely. Renal failure developing."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C6: Warehouse supervisor — femur fracture
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00014, v_center_lng - 0.00032, 'G', 1, '{
  "triage_color": "yellow", "name": "Lim Siew Hwa", "age": 51, "sex": "F",
  "role": "Warehouse supervisor — was in aisle 5 when racking collapsed, partially shielded by forklift",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "fracture", "severity": "moderate", "body_part": "right femur", "visible_signs": "Leg pinned between forklift cage and fallen racking upright. Visible deformity mid-thigh. Swelling."},
    {"type": "laceration", "severity": "minor", "body_part": "scalp", "visible_signs": "Scalp laceration from falling product — bleeding controlled with improvised bandage."},
    {"type": "psychological", "severity": "moderate", "body_part": "mental status", "visible_signs": "Crying. Can hear colleague Mohammad calling for help but cannot reach him. Hyperventilating intermittently."}
  ],
  "visible_description": "Middle-aged woman in hard hat and hi-vis vest sitting against forklift cage. Right leg trapped and visibly deformed. Scalp wound bandaged with torn cloth. Crying and calling out to colleague in adjacent aisle.",
  "treatment_requirements": [
    {"intervention": "Pain management — IV morphine or ketamine", "priority": "high", "reason": "Severe pain from femur fracture limiting assessment"},
    {"intervention": "Traction splint application", "priority": "high", "reason": "Reduce fracture and control internal bleeding into thigh"},
    {"intervention": "Monitor for compartment syndrome", "priority": "medium", "reason": "Closed femur fracture — check distal pulses hourly"},
    {"intervention": "Psychological first aid", "priority": "medium", "reason": "Acute stress reaction — reassurance and information"}
  ],
  "transport_prerequisites": ["Fracture splinted", "Pain controlled", "Distal pulses confirmed present"],
  "contraindications": ["Do NOT attempt to straighten leg without traction splint", "Do NOT delay analgesia — pain is causing tachycardia that may mask other injuries"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Establish IV access", "detail": "Left arm. Administer morphine 5mg IV titrated to pain relief."},
    {"step": 2, "action": "Free trapped leg", "detail": "Coordinate with rescue team to move racking upright. Support leg during release."},
    {"step": 3, "action": "Apply traction splint", "detail": "Sager or Hare traction splint to right leg. Check distal pulses before and after."},
    {"step": 4, "action": "Dress scalp wound", "detail": "Clean and apply pressure dressing to scalp laceration."},
    {"step": 5, "action": "Reassure and update", "detail": "Tell her that colleagues are being helped. Keep her informed."},
    {"step": 6, "action": "Transport", "detail": "Priority 2 — delayed. Ng Teng Fong General Hospital."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat"],
  "required_equipment": [
    {"item": "Traction splint (Sager)", "quantity": 1, "purpose": "Reduce and immobilise femur fracture"},
    {"item": "IV morphine 10mg", "quantity": 1, "purpose": "Pain management"},
    {"item": "Pressure dressing", "quantity": 1, "purpose": "Scalp laceration"}
  ],
  "expected_time_to_treat_minutes": 15,
  "recommended_transport": "Ng Teng Fong General Hospital — orthopaedics",
  "deterioration_timeline": [
    {"at_minutes": 60, "description": "Compartment syndrome developing in right thigh. Increasing pain despite analgesia."},
    {"at_minutes": 120, "description": "If compartment syndrome not addressed, risk of permanent muscle damage and potential limb loss."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C7: Packaging line operator — blast lung
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00028, v_center_lng + 0.00015, 'G', 1, '{
  "triage_color": "red", "name": "Nurul Aisyah bte Abdullah", "age": 23, "sex": "F",
  "role": "Packaging line operator — was operating can sealer when blast wave propagated through packaging wing",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "blast_lung", "severity": "critical", "body_part": "bilateral lungs", "visible_signs": "Coughing up blood-tinged sputum. Rapid shallow breathing. Holding right side of chest."},
    {"type": "penetrating_trauma", "severity": "severe", "body_part": "right flank", "visible_signs": "Multiple metal fragments embedded in right flank. Blood soaking through shirt. Entry wounds visible."},
    {"type": "tympanic_rupture", "severity": "moderate", "body_part": "both ears", "visible_signs": "Blood draining from both ear canals. Cannot hear — keeps asking people to repeat themselves loudly."}
  ],
  "visible_description": "Young woman in powder-dusted factory uniform walking unsteadily, holding right side. Coughing blood into her hand. Blood draining from both ears. Speaking very loudly — cannot hear her own voice. Multiple metal fragments visible in right flank.",
  "treatment_requirements": [
    {"intervention": "High-flow oxygen 15L/min", "priority": "critical", "reason": "Blast lung — bilateral pulmonary contusions causing hypoxia"},
    {"intervention": "Do NOT intubate with positive pressure unless life-threatening", "priority": "critical", "reason": "Positive pressure ventilation dramatically increases pneumothorax risk in blast lung"},
    {"intervention": "Chest seal for penetrating wounds", "priority": "high", "reason": "Multiple fragment penetrations to right flank — risk of haemo/pneumothorax"},
    {"intervention": "Haemostatic dressings to shrapnel wounds", "priority": "high", "reason": "Control ongoing bleeding from fragment wounds"},
    {"intervention": "Needle decompression standby", "priority": "high", "reason": "Tension pneumothorax can develop suddenly in blast lung patients"}
  ],
  "transport_prerequisites": ["Oxygen therapy established", "Chest seals applied", "Bleeding controlled", "Needle decompression kit immediately accessible during transport"],
  "contraindications": ["Do NOT use positive pressure ventilation unless absolutely necessary — will cause pneumothorax", "Do NOT remove embedded metal fragments", "Do NOT assume stability — blast lung patients deteriorate without warning"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Don PPE", "detail": "Gloves, N95 — dust environment with possible chemical contamination"},
    {"step": 2, "action": "High-flow oxygen", "detail": "15L/min via non-rebreather. Sit patient upright if possible."},
    {"step": 3, "action": "Apply chest seals", "detail": "Vented chest seals to all penetrating wounds on right flank."},
    {"step": 4, "action": "Haemostatic dressings", "detail": "Pack and dress fragment wounds. Do NOT remove fragments."},
    {"step": 5, "action": "Assess for pneumothorax", "detail": "Auscultate bilateral. If decreased breath sounds right side, prepare needle decompression."},
    {"step": 6, "action": "Rapid transport", "detail": "Priority 1 to SGH Trauma. CT thorax urgently needed. Keep needle decompression kit accessible."}
  ],
  "required_ppe": ["Nitrile gloves", "N95 respirator"],
  "required_equipment": [
    {"item": "Non-rebreather mask", "quantity": 1, "purpose": "High-flow oxygen delivery"},
    {"item": "Vented chest seal", "quantity": 3, "purpose": "Seal penetrating chest/flank wounds"},
    {"item": "Needle decompression kit (14G)", "quantity": 1, "purpose": "Standby for tension pneumothorax"},
    {"item": "Haemostatic dressings", "quantity": 4, "purpose": "Control fragment wound bleeding"}
  ],
  "expected_time_to_treat_minutes": 10,
  "recommended_transport": "Singapore General Hospital Trauma Centre — CT thorax urgent",
  "deterioration_timeline": [
    {"at_minutes": 5, "description": "SpO2 dropping despite oxygen. Becoming more breathless. Coughing increasing."},
    {"at_minutes": 15, "description": "Tension pneumothorax developing right side. Tracheal deviation. Hypotension."},
    {"at_minutes": 25, "description": "Cardiac arrest from tension pneumothorax if not decompressed. Bilateral lung failure."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C8: Canteen worker — evacuation injuries (GREEN)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00015, v_center_lng - 0.00015, 'G', 1, '{
  "triage_color": "green", "name": "Maria Santos", "age": 45, "sex": "F",
  "role": "Canteen kitchen worker — injured during panicked self-evacuation when blast occurred",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "fracture", "severity": "moderate", "body_part": "right wrist", "visible_signs": "Swollen and deformed right wrist. Holding it against chest. Fell on outstretched hand while running."},
    {"type": "burn", "severity": "minor", "body_part": "left forearm", "visible_signs": "Red, blistered area on left forearm — superficial scald from overturned fryer oil."},
    {"type": "laceration", "severity": "minor", "body_part": "forehead", "visible_signs": "Small laceration above left eyebrow — hit door frame while running. Minor bleeding."}
  ],
  "visible_description": "Middle-aged woman in kitchen apron walking with right arm cradled against chest. Small cut on forehead. Red mark on left forearm. Anxious but coherent. Speaking Tagalog to another worker.",
  "treatment_requirements": [
    {"intervention": "Splint wrist fracture", "priority": "medium", "reason": "Colles fracture — reduce pain and prevent further displacement"},
    {"intervention": "Cool scald burn", "priority": "medium", "reason": "Superficial scald — cool running water for 20 minutes"},
    {"intervention": "Dress forehead laceration", "priority": "low", "reason": "Minor wound — wound closure strips sufficient"},
    {"intervention": "Reassurance", "priority": "low", "reason": "Anxious but stable — psychological first aid"}
  ],
  "transport_prerequisites": ["Wrist splinted", "Scald cooled"],
  "contraindications": ["Do NOT apply ice directly to burn"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Assess and reassure", "detail": "Confirm GREEN triage. Explain she will be treated but is not in immediate danger."},
    {"step": 2, "action": "Splint wrist", "detail": "Apply padded wrist splint in position of comfort. Sling."},
    {"step": 3, "action": "Cool burn", "detail": "Run cool water over left forearm for 20 minutes. Apply burn gel."},
    {"step": 4, "action": "Dress forehead", "detail": "Clean and close with wound closure strips."},
    {"step": 5, "action": "Direct to walking wounded collection point", "detail": "Low priority transport when available."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "Wrist splint", "quantity": 1, "purpose": "Immobilise Colles fracture"},
    {"item": "Burn gel", "quantity": 1, "purpose": "Superficial scald treatment"},
    {"item": "Wound closure strips", "quantity": 3, "purpose": "Close forehead laceration"}
  ],
  "expected_time_to_treat_minutes": 8,
  "recommended_transport": "Ng Teng Fong General Hospital — minor injuries",
  "deterioration_timeline": [
    {"at_minutes": 120, "description": "Wrist swelling worsening if not splinted. Otherwise stable."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C9: Security guard — penetrating chest wound
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00005, v_center_lng - 0.00020, 'G', 1, '{
  "triage_color": "red", "name": "Sgt. K. Balamurugan", "age": 55, "sex": "M",
  "role": "Senior security guard — was at guardhouse near main gate, caught by blast debris propelled through car park",
  "mobility": "non_ambulatory", "consciousness": "confused", "breathing": "labored",
  "injuries": [
    {"type": "penetrating_trauma", "severity": "critical", "body_part": "left chest wall", "visible_signs": "Metal shard embedded in left lateral chest. Sucking chest wound audible. Decreased breath sounds left base."},
    {"type": "spinal_injury", "severity": "severe", "body_part": "cervical spine", "visible_signs": "Propelled into guardhouse wall by blast. Complains of neck pain. Tingling in fingers. DO NOT MOVE without C-spine precautions."},
    {"type": "laceration", "severity": "moderate", "body_part": "right thigh", "visible_signs": "Deep laceration from flying debris. Active bleeding — blood pooling beneath leg."}
  ],
  "visible_description": "Elderly man in security uniform lying on ground near damaged guardhouse. Metal shard protruding from left chest. Drowsy and confused. Blood pooling from right thigh wound. Breathing rapidly and shallowly.",
  "treatment_requirements": [
    {"intervention": "C-spine immobilisation", "priority": "critical", "reason": "Suspected cervical injury from blast propulsion — tingling in extremities"},
    {"intervention": "Chest seal for sucking wound", "priority": "critical", "reason": "Penetrating chest wound with developing haemothorax"},
    {"intervention": "IV fluid resuscitation", "priority": "critical", "reason": "Haemorrhagic shock — BP 80/50, tachycardic"},
    {"intervention": "Haemostatic dressing to thigh", "priority": "high", "reason": "Active bleeding from deep laceration"},
    {"intervention": "Assess for tension pneumothorax", "priority": "high", "reason": "Decreased breath sounds left side — may need decompression"}
  ],
  "transport_prerequisites": ["C-spine immobilised", "Chest seal applied", "IV access x2", "Thigh bleeding controlled"],
  "contraindications": ["Do NOT remove embedded metal shard", "Do NOT move without full spinal precautions", "Do NOT sit upright — maintain supine with C-spine control"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Manual in-line C-spine stabilisation", "detail": "Hold head in neutral alignment. Do not release until collar applied."},
    {"step": 2, "action": "Apply chest seal", "detail": "Vented chest seal over sucking wound on left chest. Monitor for tension pneumothorax."},
    {"step": 3, "action": "IV access x2", "detail": "Large-bore IVs both arms. Start normal saline wide open for shock."},
    {"step": 4, "action": "Haemostatic dressing to thigh", "detail": "Pack wound with haemostatic gauze. Apply direct pressure."},
    {"step": 5, "action": "Apply cervical collar", "detail": "Appropriate-size rigid collar. Maintain in-line stabilisation."},
    {"step": 6, "action": "Log-roll onto spinal board", "detail": "Four-person log roll. Package for transport."},
    {"step": 7, "action": "Priority 1 transport", "detail": "SGH Trauma Centre. Needle decompression kit accessible during transport."}
  ],
  "required_ppe": ["Nitrile gloves", "Eye protection"],
  "required_equipment": [
    {"item": "Cervical collar", "quantity": 1, "purpose": "C-spine immobilisation"},
    {"item": "Spinal board", "quantity": 1, "purpose": "Full spinal immobilisation"},
    {"item": "Vented chest seal", "quantity": 1, "purpose": "Seal penetrating chest wound"},
    {"item": "IV cannula 14G", "quantity": 2, "purpose": "Fluid resuscitation for shock"},
    {"item": "Normal saline 1L", "quantity": 3, "purpose": "Volume replacement"},
    {"item": "Haemostatic gauze", "quantity": 2, "purpose": "Pack thigh laceration"},
    {"item": "Needle decompression kit", "quantity": 1, "purpose": "Standby for tension pneumothorax"}
  ],
  "expected_time_to_treat_minutes": 12,
  "recommended_transport": "Singapore General Hospital Trauma Centre",
  "deterioration_timeline": [
    {"at_minutes": 5, "description": "Haemorrhagic shock worsening. Becoming less responsive. SpO2 dropping."},
    {"at_minutes": 15, "description": "Tension pneumothorax developing — needs immediate decompression. BP critically low."},
    {"at_minutes": 25, "description": "Cardiac arrest from combined haemorrhagic shock and tension pneumothorax."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C10: Visiting auditor — spinal injury (YELLOW)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00018, v_center_lng + 0.00005, '1F', 1, '{
  "triage_color": "yellow", "name": "Jennifer Tan Mei Ling", "age": 33, "sex": "F",
  "role": "External HSA auditor — conducting routine GMP audit in first-floor meeting room when ceiling collapsed",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "spinal_fracture", "severity": "severe", "body_part": "T12 vertebra", "visible_signs": "Lying under desk, refusing to move. Reports severe back pain. Ceiling panel and light fixture on her back."},
    {"type": "laceration", "severity": "minor", "body_part": "face and arms", "visible_signs": "Multiple superficial cuts from shattered window glass. Minor bleeding."},
    {"type": "psychological", "severity": "moderate", "body_part": "mental status", "visible_signs": "Hyperventilating. Claustrophobic panic attacks — trapped under desk in small space with limited visibility."}
  ],
  "visible_description": "Young woman in business attire trapped under desk in damaged first-floor meeting room. Ceiling panel on her back. Crying and hyperventilating. Multiple glass cuts on face. Refusing to move — says her back hurts intensely.",
  "treatment_requirements": [
    {"intervention": "Spinal immobilisation", "priority": "critical", "reason": "Suspected T12 compression fracture — neurologically intact, must preserve spinal cord"},
    {"intervention": "Verbal reassurance and psychological first aid", "priority": "high", "reason": "Acute panic attacks — patient is hyperventilating and needs calming before extrication"},
    {"intervention": "Pain management", "priority": "high", "reason": "Severe back pain limiting cooperation with extrication"},
    {"intervention": "Careful extrication", "priority": "high", "reason": "First-floor access may be compromised — assess structural integrity before entry"}
  ],
  "transport_prerequisites": ["Full spinal immobilisation", "Pain controlled", "Panic attacks managed", "Structural integrity of access route confirmed"],
  "contraindications": ["Do NOT allow patient to sit up or twist", "Do NOT rush extrication — rough handling risks spinal cord injury and permanent paralysis", "Do NOT ignore psychological state — panic can cause patient to move suddenly"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Assess structural safety", "detail": "Check first-floor meeting room access. Confirm floor and ceiling stable before entering."},
    {"step": 2, "action": "Verbal reassurance", "detail": "Calm patient. Explain what you are doing. Coach breathing — slow exhale technique."},
    {"step": 3, "action": "Remove debris from back", "detail": "Carefully lift ceiling panel and light fixture off patient. Do NOT move patient."},
    {"step": 4, "action": "Manual in-line stabilisation", "detail": "Hold C-spine in neutral while colleague applies collar."},
    {"step": 5, "action": "IV analgesia", "detail": "Morphine 5mg IV for pain control before log-roll."},
    {"step": 6, "action": "Log-roll onto spinal board", "detail": "Four-person log-roll. Maintain strict spinal alignment."},
    {"step": 7, "action": "Transport", "detail": "Priority 2 to NUH Spine Unit. Continuous neuro checks during transport."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat"],
  "required_equipment": [
    {"item": "Spinal board with head blocks", "quantity": 1, "purpose": "Full spinal immobilisation"},
    {"item": "Cervical collar", "quantity": 1, "purpose": "C-spine precaution for thoracic fracture"},
    {"item": "IV morphine 10mg", "quantity": 1, "purpose": "Pain management before extrication"},
    {"item": "Wound dressings", "quantity": 5, "purpose": "Glass laceration care"}
  ],
  "expected_time_to_treat_minutes": 20,
  "recommended_transport": "National University Hospital Spine Unit",
  "deterioration_timeline": [
    {"at_minutes": 30, "description": "Pain worsening. If moved incorrectly, risk of spinal cord compression and paralysis."},
    {"at_minutes": 60, "description": "Panic attacks becoming more severe if not addressed. Risk of patient moving suddenly and causing cord injury."}
  ]
}'::jsonb, 'undiscovered', 0);


-- C11: R&D scientist — chemical splash and glass wounds (YELLOW)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00020, v_center_lng + 0.00018, '1F', 1, '{
  "triage_color": "yellow", "name": "Dr. Chen Xiaoming", "age": 41, "sex": "M",
  "role": "Senior formulation scientist — was in R&D pilot lab when blast shattered fume hood and reagent shelves",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "chemical_burn", "severity": "moderate", "body_part": "left hand and forearm", "visible_signs": "Glycol ether splash from broken reagent bottles. Skin red and blistering on dorsum of hand. Dipping hand in emergency eyewash."},
    {"type": "laceration", "severity": "moderate", "body_part": "right shoulder and arm", "visible_signs": "Deep glass cuts from shattered fume hood sash. Shirt sleeve blood-soaked."},
    {"type": "concussion", "severity": "mild", "body_part": "head", "visible_signs": "Dazed expression. Struck by falling shelf. Small haematoma on right temple."}
  ],
  "visible_description": "Man in lab coat holding left hand under running water at eyewash station. Right sleeve soaked with blood. Dazed expression, small bruise on temple. Lab coat stained with chemical.",
  "treatment_requirements": [
    {"intervention": "Continue chemical decontamination", "priority": "high", "reason": "Glycol ether burns — must irrigate for at least 15 minutes"},
    {"intervention": "Control bleeding from glass lacerations", "priority": "high", "reason": "Deep cuts to shoulder and arm — steady bleeding"},
    {"intervention": "Concussion assessment", "priority": "medium", "reason": "Struck by falling shelf — monitor for deterioration"},
    {"intervention": "Tetanus status check", "priority": "low", "reason": "Multiple contaminated glass wounds"}
  ],
  "transport_prerequisites": ["Chemical decontamination completed", "Bleeding controlled", "GCS stable at 15"],
  "contraindications": ["Do NOT apply occlusive dressing over chemical burn until fully irrigated"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Continue irrigation", "detail": "Keep left hand under running water. Minimum 15 minutes total."},
    {"step": 2, "action": "Control bleeding", "detail": "Haemostatic dressing to shoulder. Direct pressure on arm lacerations."},
    {"step": 3, "action": "Neuro assessment", "detail": "GCS check, pupil response, orientation questions. Repeat every 15 minutes."},
    {"step": 4, "action": "Dress wounds", "detail": "Non-adherent dressings to chemical burn after irrigation. Close lacerations."},
    {"step": 5, "action": "Transport", "detail": "Priority 2 — Ng Teng Fong General Hospital."}
  ],
  "required_ppe": ["Nitrile gloves", "Eye protection"],
  "required_equipment": [
    {"item": "Haemostatic gauze", "quantity": 2, "purpose": "Control glass laceration bleeding"},
    {"item": "Non-adherent burn dressing", "quantity": 2, "purpose": "Cover chemical burn after irrigation"},
    {"item": "Wound closure strips", "quantity": 5, "purpose": "Close lacerations"}
  ],
  "expected_time_to_treat_minutes": 15,
  "recommended_transport": "Ng Teng Fong General Hospital",
  "deterioration_timeline": [
    {"at_minutes": 30, "description": "Concussion symptoms may worsen — monitor for vomiting, confusion, unequal pupils."},
    {"at_minutes": 60, "description": "If bleeding not controlled, may upgrade to RED from ongoing haemorrhage."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C12: Maintenance contractor — fall from height (RED)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00025, v_center_lng - 0.00018, '1F', 1, '{
  "triage_color": "red", "name": "Iskandar bin Yusof", "age": 31, "sex": "M",
  "role": "Contract HVAC maintenance technician — was servicing air handling unit on mezzanine when blast collapsed walkway",
  "mobility": "non_ambulatory", "consciousness": "confused", "breathing": "labored",
  "injuries": [
    {"type": "fall_trauma", "severity": "critical", "body_part": "pelvis and lumbar spine", "visible_signs": "Fell 4 metres from mezzanine to production floor when walkway collapsed. Lying on back, cannot feel legs. Pelvis unstable on palpation."},
    {"type": "fracture", "severity": "severe", "body_part": "left radius and ulna", "visible_signs": "Open fracture left forearm — fell on outstretched hand. Bone visible through torn sleeve."},
    {"type": "head_injury", "severity": "moderate", "body_part": "occipital region", "visible_signs": "Landed on back of head. Large haematoma. Confused — keeps asking what happened."}
  ],
  "visible_description": "Young man in orange hi-vis vest lying on production floor amid twisted walkway debris. Cannot move legs. Left forearm at unnatural angle with bone visible. Blood pooling behind head. Confused and repeating questions.",
  "treatment_requirements": [
    {"intervention": "Full spinal immobilisation", "priority": "critical", "reason": "4-metre fall with suspected spinal cord injury — cannot feel legs"},
    {"intervention": "Pelvic binder", "priority": "critical", "reason": "Unstable pelvis — risk of massive internal haemorrhage"},
    {"intervention": "IV fluid resuscitation", "priority": "critical", "reason": "Suspected internal bleeding from pelvic fracture"},
    {"intervention": "Splint open forearm fracture", "priority": "high", "reason": "Cover exposed bone, control bleeding"},
    {"intervention": "Head injury monitoring", "priority": "high", "reason": "Confusion indicates possible intracranial bleeding"}
  ],
  "transport_prerequisites": ["Full spinal immobilisation", "Pelvic binder applied", "IV access x2", "Open fracture covered"],
  "contraindications": ["Do NOT allow patient to sit up", "Do NOT apply traction to forearm with open fracture", "Do NOT give oral fluids — possible surgical abdomen"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Manual in-line C-spine stabilisation", "detail": "Immediately stabilise head and neck. Maintain until boarded."},
    {"step": 2, "action": "Apply pelvic binder", "detail": "Improvised or commercial binder at level of greater trochanters. Tighten firmly."},
    {"step": 3, "action": "IV access x2", "detail": "Large-bore IVs. Start normal saline for volume."},
    {"step": 4, "action": "Splint forearm", "detail": "Cover exposed bone with saline-soaked dressing. Splint in position found."},
    {"step": 5, "action": "Cervical collar and spinal board", "detail": "Full packaging. Four-person log-roll."},
    {"step": 6, "action": "Transport Priority 1", "detail": "SGH Trauma Centre — spinal cord injury and unstable pelvis."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat"],
  "required_equipment": [
    {"item": "Pelvic binder", "quantity": 1, "purpose": "Stabilise pelvic fracture"},
    {"item": "Spinal board with head blocks", "quantity": 1, "purpose": "Full immobilisation"},
    {"item": "IV cannula 14G", "quantity": 2, "purpose": "Fluid resuscitation"},
    {"item": "Normal saline 1L", "quantity": 3, "purpose": "Volume replacement"},
    {"item": "SAM splint", "quantity": 1, "purpose": "Forearm fracture immobilisation"},
    {"item": "Sterile saline-soaked dressing", "quantity": 2, "purpose": "Cover open fracture"}
  ],
  "expected_time_to_treat_minutes": 15,
  "recommended_transport": "Singapore General Hospital Trauma Centre — spinal cord injury",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Becoming more confused. Pelvic haemorrhage ongoing internally. BP dropping."},
    {"at_minutes": 20, "description": "Haemorrhagic shock from pelvic fracture. GCS declining."},
    {"at_minutes": 35, "description": "Cardiac arrest from uncontrolled pelvic haemorrhage if binder not applied."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C13: Forklift operator — trapped in overturned forklift (YELLOW)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00010, v_center_lng - 0.00025, 'G', 1, '{
  "triage_color": "yellow", "name": "Suresh Nair", "age": 37, "sex": "M",
  "role": "Forklift operator — forklift overturned when blast shockwave hit loading dock, legs trapped under roll cage",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "crush_injury", "severity": "moderate", "body_part": "both lower legs", "visible_signs": "Both legs pinned under overturned forklift roll cage. Complains of pain but can wiggle toes. Circulation intact."},
    {"type": "laceration", "severity": "minor", "body_part": "scalp", "visible_signs": "Cut on crown from hitting forklift cage during overturn. Controlled bleeding."}
  ],
  "visible_description": "Man trapped under overturned forklift near loading dock. Upper body free, both legs pinned under roll cage. Alert and talking. Hard hat still on. Asking rescuers to hurry.",
  "treatment_requirements": [
    {"intervention": "Mechanical extrication", "priority": "high", "reason": "Need to right or lift forklift to free legs — requires hydraulic equipment"},
    {"intervention": "Pre-extrication IV access", "priority": "high", "reason": "Crush time <30 minutes but IV access needed before release as precaution"},
    {"intervention": "Bilateral leg assessment post-release", "priority": "high", "reason": "Check for compartment syndrome and fractures after extrication"},
    {"intervention": "Scalp wound care", "priority": "low", "reason": "Minor laceration — dress after extrication"}
  ],
  "transport_prerequisites": ["Extricated from forklift", "Bilateral leg neurovascular check complete", "Fractures splinted if found"],
  "contraindications": ["Do NOT attempt to right forklift manually — use mechanical equipment", "Do NOT delay extrication — crush injury duration increasing"],
  "ideal_response_sequence": [
    {"step": 1, "action": "IV access", "detail": "One large-bore IV in arm. Saline lock."},
    {"step": 2, "action": "Coordinate with DART", "detail": "Hydraulic lifting equipment to right forklift or lift cage off legs."},
    {"step": 3, "action": "Extricate", "detail": "Controlled lift. Support legs during release."},
    {"step": 4, "action": "Full leg assessment", "detail": "Check distal pulses, sensation, motor function bilateral. Look for fractures."},
    {"step": 5, "action": "Splint if needed", "detail": "Apply splints to any fractures found."},
    {"step": 6, "action": "Transport Priority 2", "detail": "Ng Teng Fong General Hospital — orthopaedic review."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat", "Safety boots"],
  "required_equipment": [
    {"item": "Hydraulic jack or airbag", "quantity": 1, "purpose": "Lift overturned forklift"},
    {"item": "IV cannula 18G", "quantity": 1, "purpose": "Precautionary access"},
    {"item": "SAM splint", "quantity": 2, "purpose": "Splint if fractures found post-extrication"}
  ],
  "expected_time_to_treat_minutes": 25,
  "recommended_transport": "Ng Teng Fong General Hospital — orthopaedics",
  "deterioration_timeline": [
    {"at_minutes": 45, "description": "Crush duration increasing — risk of crush syndrome escalating. Pain worsening."},
    {"at_minutes": 90, "description": "Compartment syndrome likely in both lower legs if still trapped."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C14: Pregnant admin worker — stress and minor injuries (GREEN)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00040, v_center_lng - 0.00025, 'G', 1, '{
  "triage_color": "green", "name": "Siti Nurhaliza bte Hassan", "age": 28, "sex": "F",
  "role": "Accounts payable clerk — 32 weeks pregnant, was in admin building when blast occurred, self-evacuated to assembly point",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "abrasion", "severity": "minor", "body_part": "both knees", "visible_signs": "Grazed both knees falling on staircase during evacuation. Minor bleeding."},
    {"type": "psychological", "severity": "moderate", "body_part": "mental status", "visible_signs": "Clutching abdomen protectively. Very anxious about baby. Requesting foetal monitoring."}
  ],
  "visible_description": "Visibly pregnant young woman at assembly point. Hands on belly. Grazed knees. Crying quietly. Repeatedly asking if her baby is okay. Office clothing dusty but intact.",
  "treatment_requirements": [
    {"intervention": "Reassurance and foetal assessment", "priority": "high", "reason": "32 weeks pregnant — need to confirm no placental abruption from fall/blast concussion"},
    {"intervention": "Dress knee abrasions", "priority": "low", "reason": "Minor wounds — cosmetic only"},
    {"intervention": "Monitor for preterm labour signs", "priority": "medium", "reason": "Stress and physical trauma can trigger premature contractions"}
  ],
  "transport_prerequisites": ["No signs of active labour or vaginal bleeding"],
  "contraindications": ["Do NOT give NSAIDs for pain — use paracetamol only", "Do NOT lie flat on back — left lateral position for pregnant patient"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Reassure", "detail": "Calm patient. Explain you will check her and baby."},
    {"step": 2, "action": "Assess for obstetric emergency", "detail": "Check for vaginal bleeding, abdominal pain/rigidity, contractions."},
    {"step": 3, "action": "Dress abrasions", "detail": "Clean and dress knee grazes."},
    {"step": 4, "action": "Position comfortably", "detail": "Left lateral position. Keep warm."},
    {"step": 5, "action": "Transport for CTG", "detail": "Priority 3 to KK Women and Children Hospital for foetal monitoring."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "Wound dressing", "quantity": 2, "purpose": "Dress knee abrasions"},
    {"item": "Blanket", "quantity": 1, "purpose": "Keep warm and provide comfort"}
  ],
  "expected_time_to_treat_minutes": 5,
  "recommended_transport": "KK Women and Children Hospital — obstetric assessment and CTG",
  "deterioration_timeline": [
    {"at_minutes": 30, "description": "If placental abruption present (occult), abdominal pain increasing. Vaginal bleeding may appear."},
    {"at_minutes": 60, "description": "Premature contractions possible from stress. Need CTG monitoring."}
  ]
}'::jsonb, 'identified', 0);

-- C15: Delivery driver — pinned by shifted container (RED)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00008, v_center_lng - 0.00035, 'G', 1, '{
  "triage_color": "red", "name": "Loh Kian Beng", "age": 48, "sex": "M",
  "role": "External delivery truck driver — was unloading at loading dock when blast shifted 40-foot shipping container onto his truck cab",
  "mobility": "non_ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "crush_injury", "severity": "critical", "body_part": "chest and abdomen", "visible_signs": "Pinned in truck cab by displaced shipping container crushing roof down onto driver seat. Only head and right arm visible. Difficulty breathing — chest compressed."},
    {"type": "fracture", "severity": "severe", "body_part": "multiple ribs bilateral", "visible_signs": "Paradoxical chest movement visible. Flail segment likely. Crepitus on palpation of accessible chest wall."}
  ],
  "visible_description": "Truck cab crushed by displaced shipping container. Driver pinned inside — only head and right arm visible through broken windscreen. Gasping for breath. Pale and sweating. Calling out for help.",
  "treatment_requirements": [
    {"intervention": "Oxygen therapy through windscreen access", "priority": "critical", "reason": "Chest compression limiting ventilation — SpO2 dropping"},
    {"intervention": "Heavy rescue extrication", "priority": "critical", "reason": "Need crane or heavy hydraulics to shift 20-tonne container off cab"},
    {"intervention": "IV access via right arm", "priority": "high", "reason": "Only accessible limb — start fluids for shock"},
    {"intervention": "Pain management", "priority": "high", "reason": "Severe pain from rib fractures limiting breathing further"}
  ],
  "transport_prerequisites": ["Extricated from vehicle", "Chest stabilised", "IV access established"],
  "contraindications": ["Do NOT attempt to pull patient out — chest is compressed, sudden release may cause cardiac arrest", "Do NOT delay oxygen — any oxygenation improvement while trapped is critical"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Oxygen via windscreen", "detail": "Thread non-rebreather mask through broken windscreen. 15L/min."},
    {"step": 2, "action": "IV access right arm", "detail": "Only accessible limb. Start normal saline."},
    {"step": 3, "action": "IV morphine for pain", "detail": "2mg titrated — pain is limiting breathing."},
    {"step": 4, "action": "Request heavy rescue", "detail": "Crane needed to shift 40-foot container. Coordinate with DART."},
    {"step": 5, "action": "Prepare for extrication", "detail": "Stage spinal board, chest stabilisation equipment, tourniquets."},
    {"step": 6, "action": "Controlled extrication", "detail": "Lift container. Extract patient with C-spine precautions. Immediate chest assessment."},
    {"step": 7, "action": "Priority 1 transport", "detail": "SGH Trauma — flail chest, possible internal injuries."}
  ],
  "required_ppe": ["Hard hat", "Nitrile gloves", "Safety boots"],
  "required_equipment": [
    {"item": "Non-rebreather mask with long tubing", "quantity": 1, "purpose": "Oxygen delivery through windscreen"},
    {"item": "IV cannula 14G", "quantity": 1, "purpose": "Access via right arm"},
    {"item": "Normal saline 1L", "quantity": 2, "purpose": "Fluid resuscitation"},
    {"item": "Morphine 10mg", "quantity": 1, "purpose": "Pain management"},
    {"item": "Heavy crane or hydraulic lift", "quantity": 1, "purpose": "Shift shipping container"}
  ],
  "expected_time_to_treat_minutes": 60,
  "recommended_transport": "Singapore General Hospital Trauma Centre — flail chest",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Breathing becoming more laboured. Chest compression worsening ventilation. SpO2 below 85%."},
    {"at_minutes": 30, "description": "Respiratory failure from prolonged chest compression. May lose consciousness."},
    {"at_minutes": 45, "description": "Cardiac arrest from hypoxia and crush injury if not extricated."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C16: Cleanroom operator — burns from flash fire (YELLOW)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00024, v_center_lng + 0.00008, 'G', 1, '{
  "triage_color": "yellow", "name": "Ang Wei Ting", "age": 35, "sex": "M",
  "role": "Cleanroom operator in Similac powder filling line — flash fire from ignited powder dust singed through cleanroom suit",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "burn", "severity": "moderate", "body_part": "both arms and chest", "visible_signs": "Partial-thickness burns to ~15% BSA. Cleanroom suit melted in patches. Red, blistered skin on forearms and anterior chest. Significant pain."},
    {"type": "inhalation", "severity": "mild", "body_part": "upper airway", "visible_signs": "Mild cough. No stridor. Inhaled briefly before escaping flash fire area."}
  ],
  "visible_description": "Man in partially melted cleanroom suit walking toward exit. Both forearms red and blistered. Chest skin visible through burnt suit patches. Wincing in pain but walking steadily. Mild cough.",
  "treatment_requirements": [
    {"intervention": "Cool burns with room-temp water", "priority": "high", "reason": "15% BSA partial-thickness — cool for 20 minutes to limit tissue damage"},
    {"intervention": "Remove burnt clothing carefully", "priority": "high", "reason": "Cleanroom suit melted in patches — cut away non-adherent sections"},
    {"intervention": "IV analgesia", "priority": "high", "reason": "Significant pain from partial-thickness burns"},
    {"intervention": "Non-adherent burn dressings", "priority": "medium", "reason": "Cover after cooling"},
    {"intervention": "Monitor airway", "priority": "medium", "reason": "Brief inhalation exposure — watch for delayed oedema"}
  ],
  "transport_prerequisites": ["Burns cooled for 20 minutes", "Pain controlled", "Airway assessed and stable"],
  "contraindications": ["Do NOT apply ice", "Do NOT burst blisters", "Do NOT apply adhesive dressings to burn surface"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Remove from hazard area", "detail": "Move away from packaging wing — dust explosion risk."},
    {"step": 2, "action": "Cool burns", "detail": "Room-temperature running water for 20 minutes on arms and chest."},
    {"step": 3, "action": "Remove clothing", "detail": "Cut away cleanroom suit. Leave any melted sections adherent to skin."},
    {"step": 4, "action": "IV access and analgesia", "detail": "IV morphine 5mg titrated for pain."},
    {"step": 5, "action": "Apply non-adherent dressings", "detail": "Cling film or burns dressings over cooled areas."},
    {"step": 6, "action": "Transport Priority 2", "detail": "SGH Burns Centre for specialist assessment."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "Burns dressings (non-adherent)", "quantity": 4, "purpose": "Cover 15% BSA burns"},
    {"item": "IV morphine 10mg", "quantity": 1, "purpose": "Pain management"},
    {"item": "Cling film", "quantity": 1, "purpose": "Temporary burn covering"}
  ],
  "expected_time_to_treat_minutes": 25,
  "recommended_transport": "Singapore General Hospital Burns Centre",
  "deterioration_timeline": [
    {"at_minutes": 30, "description": "If not cooled, tissue damage deepening. Partial-thickness may convert to full-thickness burns."},
    {"at_minutes": 120, "description": "Burn oedema developing. Fluid losses increasing. May need IV fluids if delayed."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C17: Elderly visitor — cardiac event triggered by blast (RED)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00020, v_center_lng - 0.00010, 'G', 1, '{
  "triage_color": "red", "name": "Tan Ah Kow", "age": 72, "sex": "M",
  "role": "Retired employee visiting former colleagues — was in lobby when blast occurred, stress triggered acute cardiac event",
  "mobility": "non_ambulatory", "consciousness": "confused", "breathing": "labored",
  "injuries": [
    {"type": "cardiac", "severity": "critical", "body_part": "heart", "visible_signs": "Clutching chest. Diaphoretic. Grey complexion. History of previous MI (medication in pocket — aspirin, GTN spray)."},
    {"type": "laceration", "severity": "minor", "body_part": "face", "visible_signs": "Small cut on chin from falling when chest pain began. Minor bleeding."}
  ],
  "visible_description": "Elderly man sitting on lobby floor leaning against wall. Grey-faced, sweating profusely, clutching chest with both hands. Breathing rapidly and shallowly. Medication bottles scattered from dropped bag nearby.",
  "treatment_requirements": [
    {"intervention": "12-lead ECG if available", "priority": "critical", "reason": "Suspected STEMI — need to confirm and activate cath lab early"},
    {"intervention": "Aspirin 300mg chewed", "priority": "critical", "reason": "Antiplatelet therapy for acute coronary syndrome"},
    {"intervention": "GTN sublingual", "priority": "critical", "reason": "Vasodilation for angina relief — patient carries his own"},
    {"intervention": "High-flow oxygen", "priority": "high", "reason": "Respiratory distress from cardiac failure"},
    {"intervention": "IV access", "priority": "high", "reason": "Route for morphine and emergency drugs"}
  ],
  "transport_prerequisites": ["Aspirin given", "GTN administered", "IV access", "Defibrillator accessible during transport"],
  "contraindications": ["Do NOT give GTN if systolic BP <90mmHg", "Do NOT delay transport for non-essential interventions — time is myocardium"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Sit patient upright", "detail": "Position of comfort — semi-recumbent. Do NOT lay flat."},
    {"step": 2, "action": "Give aspirin 300mg", "detail": "Chew and swallow. Check allergy first."},
    {"step": 3, "action": "Administer GTN spray", "detail": "1 puff sublingual. Check BP first — withhold if <90 systolic."},
    {"step": 4, "action": "High-flow oxygen", "detail": "15L/min via non-rebreather mask."},
    {"step": 5, "action": "IV access", "detail": "One IV in left arm. Morphine 2mg for chest pain if GTN insufficient."},
    {"step": 6, "action": "Rapid transport", "detail": "Priority 1 to NHCS — suspected STEMI. Pre-alert cath lab."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "Aspirin 300mg", "quantity": 1, "purpose": "Antiplatelet for ACS"},
    {"item": "GTN spray", "quantity": 1, "purpose": "Sublingual vasodilation"},
    {"item": "Non-rebreather mask", "quantity": 1, "purpose": "High-flow oxygen"},
    {"item": "IV cannula 18G", "quantity": 1, "purpose": "Drug access"},
    {"item": "AED/defibrillator", "quantity": 1, "purpose": "Standby for cardiac arrest"}
  ],
  "expected_time_to_treat_minutes": 8,
  "recommended_transport": "National Heart Centre Singapore — cath lab activation",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Chest pain worsening despite GTN. ST elevation progressing. Risk of arrhythmia."},
    {"at_minutes": 20, "description": "VF/VT arrest possible. Defibrillator must be immediately accessible."},
    {"at_minutes": 40, "description": "Myocardial necrosis extending. Cardiogenic shock developing. Every minute of delay reduces survival."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C18: Contract cleaner — ammonia exposure during evacuation (YELLOW)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat - 0.00025, v_center_lng + 0.00040, 'G', 1, '{
  "triage_color": "yellow", "name": "Myint Thein", "age": 39, "sex": "M",
  "role": "Contract cleaner (Myanmar national) — was cleaning near cold storage when ammonia leak began, ran through edge of plume during evacuation",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "labored",
  "injuries": [
    {"type": "chemical_inhalation", "severity": "moderate", "body_part": "lungs", "visible_signs": "Persistent coughing. Watery eyes. Voice hoarse. Ran through ammonia plume edge for approximately 30 seconds."},
    {"type": "chemical_burn", "severity": "mild", "body_part": "eyes", "visible_signs": "Both eyes red, swollen, tearing continuously. Rubbing eyes despite being told not to."}
  ],
  "visible_description": "Man in blue cleaning uniform coughing continuously. Eyes swollen and red, tearing. Speaking limited English — colleague translating from Burmese. Agitated and distressed. Wet towel around neck.",
  "treatment_requirements": [
    {"intervention": "Eye irrigation", "priority": "high", "reason": "Ammonia contact irritation — irrigate for 15 minutes"},
    {"intervention": "Oxygen therapy", "priority": "high", "reason": "Ammonia inhalation — chemical bronchitis developing"},
    {"intervention": "Bronchodilator", "priority": "medium", "reason": "Wheezing from chemical irritation of airways"},
    {"intervention": "Language assistance", "priority": "medium", "reason": "Limited English — needs Burmese interpreter for consent and history"}
  ],
  "transport_prerequisites": ["Eye irrigation commenced", "Oxygen therapy started", "Breathing stable"],
  "contraindications": ["Do NOT let patient rub eyes further — worsening corneal damage"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Move upwind", "detail": "Ensure patient is upwind of ammonia cloud."},
    {"step": 2, "action": "Eye irrigation", "detail": "Saline flush to both eyes for minimum 15 minutes."},
    {"step": 3, "action": "Oxygen therapy", "detail": "High-flow O2 via mask. Monitor SpO2."},
    {"step": 4, "action": "Nebulised salbutamol", "detail": "If wheezing persists — 5mg via nebuliser."},
    {"step": 5, "action": "Arrange interpreter", "detail": "Burmese interpreter needed for informed consent and history."},
    {"step": 6, "action": "Transport Priority 2", "detail": "NTFGH — chemical exposure monitoring. Chest X-ray needed."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "Normal saline 1L", "quantity": 2, "purpose": "Eye irrigation"},
    {"item": "Non-rebreather mask", "quantity": 1, "purpose": "Oxygen therapy"},
    {"item": "Salbutamol nebules", "quantity": 2, "purpose": "Bronchospasm treatment"}
  ],
  "expected_time_to_treat_minutes": 15,
  "recommended_transport": "Ng Teng Fong General Hospital — chemical exposure monitoring",
  "deterioration_timeline": [
    {"at_minutes": 60, "description": "Delayed pulmonary oedema possible 6-24 hours after ammonia exposure — must be monitored."},
    {"at_minutes": 360, "description": "Chemical pneumonitis can develop hours later even if initial symptoms seem mild."}
  ]
}'::jsonb, 'undiscovered', 5);

-- C19: Production line supervisor — traumatic amputation (RED)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00019, v_center_lng - 0.00005, 'G', 1, '{
  "triage_color": "red", "name": "Krishnan Muthu", "age": 46, "sex": "M",
  "role": "Production line supervisor — was near conveyor system when blast caused catastrophic mechanical failure, severing right hand",
  "mobility": "ambulatory", "consciousness": "alert", "breathing": "normal",
  "injuries": [
    {"type": "traumatic_amputation", "severity": "critical", "body_part": "right hand at wrist", "visible_signs": "Complete traumatic amputation of right hand at wrist by conveyor mechanism. Stump bleeding controlled by co-worker with belt tourniquet. Amputated hand recovered by colleague in plastic bag."},
    {"type": "laceration", "severity": "moderate", "body_part": "right forearm", "visible_signs": "Multiple lacerations from conveyor chain above amputation level. Moderate bleeding."}
  ],
  "visible_description": "Man walking out of production area supported by colleague. Right arm elevated, wrist stump wrapped in blood-soaked cloth with belt tourniquet above. Pale but walking. Colleague carrying plastic bag with amputated hand.",
  "treatment_requirements": [
    {"intervention": "Upgrade tourniquet to commercial CAT", "priority": "critical", "reason": "Improvised belt tourniquet may not be fully occlusive"},
    {"intervention": "Cool amputated hand properly", "priority": "critical", "reason": "Wrap in saline-soaked gauze, place in bag, place on ice — do NOT put directly on ice"},
    {"intervention": "IV fluid resuscitation", "priority": "high", "reason": "Blood loss from amputation — may be more than visible"},
    {"intervention": "Dress stump", "priority": "high", "reason": "Clean dressing over stump — do not pack or probe"},
    {"intervention": "Rapid transport for reimplantation", "priority": "critical", "reason": "Replantation window is 6-8 hours — every minute counts"}
  ],
  "transport_prerequisites": ["Commercial tourniquet applied", "IV access", "Amputated part preserved correctly", "Pain controlled"],
  "contraindications": ["Do NOT remove improvised tourniquet until commercial one applied proximal", "Do NOT put amputated hand directly on ice — tissue damage", "Do NOT attempt to reattach in field"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Apply commercial tourniquet", "detail": "CAT tourniquet above improvised belt. Tighten until bleeding stops. Mark time."},
    {"step": 2, "action": "Preserve amputated hand", "detail": "Wrap in saline-soaked gauze, seal in plastic bag, place bag on ice. Label with patient name and time."},
    {"step": 3, "action": "IV access", "detail": "Left arm — 14G. Start normal saline bolus."},
    {"step": 4, "action": "IV analgesia", "detail": "Morphine 5mg IV for pain. Patient appears calm but likely in shock."},
    {"step": 5, "action": "Dress stump", "detail": "Sterile non-adherent dressing over stump. Elevate."},
    {"step": 6, "action": "Rapid transport", "detail": "Priority 1 to SGH Hand Surgery — replantation team. Bring amputated part."}
  ],
  "required_ppe": ["Nitrile gloves"],
  "required_equipment": [
    {"item": "CAT tourniquet", "quantity": 1, "purpose": "Replace improvised tourniquet"},
    {"item": "Normal saline 1L", "quantity": 2, "purpose": "Fluid resuscitation and gauze wetting"},
    {"item": "Sterile plastic bag", "quantity": 2, "purpose": "Wrap amputated hand for transport on ice"},
    {"item": "Ice", "quantity": 1, "purpose": "Cool amputated part — bag on ice, not direct contact"},
    {"item": "IV morphine 10mg", "quantity": 1, "purpose": "Pain management"}
  ],
  "expected_time_to_treat_minutes": 10,
  "recommended_transport": "Singapore General Hospital — Hand Surgery Unit for replantation",
  "deterioration_timeline": [
    {"at_minutes": 10, "description": "Improvised tourniquet loosening — bleeding may resume."},
    {"at_minutes": 60, "description": "Ischaemia time increasing for amputated hand. Replantation success dropping."},
    {"at_minutes": 360, "description": "Beyond 6 hours warm ischaemia, replantation unlikely to succeed."}
  ]
}'::jsonb, 'undiscovered', 0);

-- C20: Night-shift worker found late — hidden in collapsed storeroom (RED, delayed discovery)
INSERT INTO scenario_casualties (scenario_id, casualty_type, location_lat, location_lng, floor_level, headcount, conditions, status, appears_at_minutes) VALUES
(v_scenario_id, 'patient', v_center_lat + 0.00030, v_center_lng - 0.00010, 'G', 1, '{
  "triage_color": "red", "name": "Roslan bin Ahmad", "age": 52, "sex": "M",
  "role": "Night-shift quality inspector — was sleeping in storeroom during unauthorised break when blast collapsed ceiling, not on headcount",
  "mobility": "non_ambulatory", "consciousness": "unconscious", "breathing": "labored",
  "injuries": [
    {"type": "head_injury", "severity": "critical", "body_part": "head", "visible_signs": "Large haematoma on left parietal region. Unconscious. Left pupil dilated — possible epidural haematoma. GCS 7."},
    {"type": "crush_injury", "severity": "moderate", "body_part": "legs", "visible_signs": "Both legs trapped under collapsed shelving and ceiling tiles. Cannot assess fully."},
    {"type": "hypothermia", "severity": "mild", "body_part": "whole body", "visible_signs": "Lying on cold concrete floor for extended period. Skin cool to touch."}
  ],
  "visible_description": "Unconscious man found in collapsed storeroom during secondary search. Lying on concrete floor under ceiling debris and shelving. Large bruise on side of head. Not on any evacuation headcount — unknown to rescuers. Barely breathing.",
  "treatment_requirements": [
    {"intervention": "Secure airway", "priority": "critical", "reason": "GCS 7 — cannot protect own airway. Risk of aspiration."},
    {"intervention": "C-spine immobilisation", "priority": "critical", "reason": "Unconscious with head injury — assume spinal injury until proven otherwise"},
    {"intervention": "Extricate from debris", "priority": "high", "reason": "Legs trapped under shelving — need manual removal"},
    {"intervention": "IV access and fluids", "priority": "high", "reason": "Prolonged period unconscious — assess hydration and treat shock if present"},
    {"intervention": "Neurosurgical assessment urgently", "priority": "critical", "reason": "Unilateral dilated pupil suggests expanding intracranial haematoma"}
  ],
  "transport_prerequisites": ["Airway secured", "C-spine immobilised", "Extricated from debris", "IV access"],
  "contraindications": ["Do NOT delay transport for non-essential care — this is a neurosurgical emergency", "Do NOT lie flat — elevate head 30 degrees to reduce ICP"],
  "ideal_response_sequence": [
    {"step": 1, "action": "Jaw thrust", "detail": "Open airway without moving C-spine. Suction if needed."},
    {"step": 2, "action": "Manual C-spine hold", "detail": "Maintain in-line stabilisation throughout."},
    {"step": 3, "action": "Clear debris from legs", "detail": "Remove shelving and ceiling tiles. Assess leg injuries."},
    {"step": 4, "action": "Apply cervical collar", "detail": "Appropriate size. Maintain manual hold until boarded."},
    {"step": 5, "action": "IV access", "detail": "One large-bore IV. Saline at maintenance rate unless hypotensive."},
    {"step": 6, "action": "Package for transport", "detail": "Spinal board. Head elevated 30 degrees. Priority 1 transport."},
    {"step": 7, "action": "Pre-alert neurosurgery", "detail": "NUH Neurosurgery — possible epidural haematoma, GCS 7, dilated left pupil."}
  ],
  "required_ppe": ["Nitrile gloves", "Hard hat"],
  "required_equipment": [
    {"item": "Oropharyngeal airway", "quantity": 1, "purpose": "Maintain airway in unconscious patient"},
    {"item": "Suction unit", "quantity": 1, "purpose": "Clear airway secretions"},
    {"item": "Cervical collar", "quantity": 1, "purpose": "C-spine immobilisation"},
    {"item": "Spinal board", "quantity": 1, "purpose": "Full immobilisation"},
    {"item": "IV cannula 14G", "quantity": 1, "purpose": "Drug and fluid access"}
  ],
  "expected_time_to_treat_minutes": 12,
  "recommended_transport": "National University Hospital — Neurosurgery for possible evacuation of epidural haematoma",
  "deterioration_timeline": [
    {"at_minutes": 5, "description": "ICP rising. Breathing pattern becoming irregular — Cushing response."},
    {"at_minutes": 15, "description": "Brain herniation beginning. Bilateral pupils dilating."},
    {"at_minutes": 25, "description": "Brain death if epidural haematoma not evacuated surgically."}
  ]
}'::jsonb, 'undiscovered', 15);


-- ============================================================
-- 4. CROWD / EVACUEE GROUPS
-- ============================================================

-- Self-evacuated production staff at assembly point
INSERT INTO scenario_casualties (
  scenario_id, casualty_type, location_lat, location_lng, floor_level,
  headcount, conditions, status, appears_at_minutes
) VALUES (
  v_scenario_id, 'evacuee_group',
  v_center_lat - 0.0005, v_center_lng - 0.0003,
  'G', 85,
  '{
    "group_description": "Production and office staff who self-evacuated to the designated assembly point at the visitor carpark. Mix of day-shift operators, admin staff, and R&D personnel. Several are in cleanroom gowns and hairnets. Approximately 15 have minor injuries (cuts, bruises, smoke inhalation symptoms). Group is anxious — they know colleagues are still inside.",
    "mobility": "ambulatory",
    "panic_level": "high",
    "special_needs": ["3 persons reporting breathing difficulty — likely mild inhalation injury", "2 persons in wheelchairs (pre-existing mobility issues)", "1 pregnant woman (32 weeks) — requesting medical check"],
    "behavior": "Cooperative but increasingly agitated. Some attempting to re-enter building to find colleagues. Assembly point is 150m from ammonia cloud — may need to relocate."
  }'::jsonb,
  'identified', 0
);

-- Canteen crowd moving away from ammonia plume
INSERT INTO scenario_casualties (
  scenario_id, casualty_type, location_lat, location_lng, floor_level,
  headcount, conditions, status, appears_at_minutes
) VALUES (
  v_scenario_id, 'crowd',
  v_center_lat - 0.0003, v_center_lng + 0.0005,
  'G', 60,
  '{
    "group_description": "Staff from the canteen and adjacent break rooms. Initially sheltered in canteen but now evacuating as ammonia smell becomes noticeable. Moving east along Tuas South Avenue 10 toward Tuas Biomedical Park gate. Several have wet towels over faces. Mix of Abbott employees and contract workers (cleaners, security, maintenance).",
    "mobility": "ambulatory",
    "panic_level": "moderate",
    "special_needs": ["8 persons reporting eye irritation and coughing from ammonia exposure — need decontamination assessment", "Several contract workers do not speak English — Mandarin and Tamil interpretation needed"],
    "behavior": "Moving away from facility but no clear direction. Some heading toward main road — traffic hazard. Need to be directed to upwind assembly point."
  }'::jsonb,
  'undiscovered', 5
);

-- Convergent crowd — family members arriving
INSERT INTO scenario_casualties (
  scenario_id, casualty_type, location_lat, location_lng, floor_level,
  headcount, conditions, status, appears_at_minutes
) VALUES (
  v_scenario_id, 'convergent_crowd',
  v_center_lat - 0.0008, v_center_lng - 0.0005,
  'G', 35,
  '{
    "group_description": "Family members of Abbott workers arriving at the Tuas South Avenue 10 entrance after news of the explosion spread on social media and WhatsApp. Emotional, demanding information about specific individuals. Some attempting to drive into the restricted area. Two local TV news vans have also arrived.",
    "mobility": "ambulatory",
    "panic_level": "high",
    "behavior": "Confrontational with security. Several families calling out names of workers. Two women hysterical — their husbands work in the warehouse (where workers are trapped). Media crews setting up live broadcast positions. Group growing — estimated 10-15 more arriving every 10 minutes."
  }'::jsonb,
  'undiscovered', 15
);

-- Workers from neighbouring Tuas factories gathering
INSERT INTO scenario_casualties (
  scenario_id, casualty_type, location_lat, location_lng, floor_level,
  headcount, conditions, status, appears_at_minutes
) VALUES (
  v_scenario_id, 'convergent_crowd',
  v_center_lat - 0.0006, v_center_lng + 0.0008,
  'G', 45,
  '{
    "group_description": "Workers from neighbouring factories on Tuas South Avenue 10 (semiconductor plants, logistics warehouses) who heard the explosion and came to see what happened. Mix of curious onlookers and some offering to help. Several filming with phones for social media.",
    "mobility": "ambulatory",
    "panic_level": "low",
    "behavior": "Mostly observing from a distance but some approaching perimeter. Need to be kept back due to ammonia drift risk. Several posting live video to TikTok and Instagram — uncontrolled information flow. Some willing to assist if directed."
  }'::jsonb,
  'undiscovered', 10
);


-- ============================================================
-- 5. SCENARIO LOCATIONS — hospitals, fire stations, police, entry/exit
-- ============================================================

-- Nearby hospitals with accepted conditions
INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'hospital', 'Singapore General Hospital (SGH)', '{"lat": 1.2793, "lng": 103.8355}'::jsonb,
 '{"distance_km": 22, "travel_time_min": 25, "accepted_conditions": ["burns", "trauma", "crush_syndrome", "spinal_cord_injury", "penetrating_trauma", "blast_injury", "haemothorax"], "specialties": ["Burns Centre", "Trauma Centre", "Hand Surgery Unit", "ICU"], "helicopter_pad": true}'::jsonb, 'hospital');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'hospital', 'National University Hospital (NUH)', '{"lat": 1.2937, "lng": 103.7831}'::jsonb,
 '{"distance_km": 18, "travel_time_min": 20, "accepted_conditions": ["spinal_fracture", "chemical_burn", "ophthalmology", "neurosurgery", "head_injury", "epidural_haematoma"], "specialties": ["Spine Unit", "Ophthalmology", "Neurosurgery", "Emergency Medicine"], "helicopter_pad": true}'::jsonb, 'hospital');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'hospital', 'Ng Teng Fong General Hospital (NTFGH)', '{"lat": 1.3339, "lng": 103.7456}'::jsonb,
 '{"distance_km": 10, "travel_time_min": 12, "accepted_conditions": ["fracture", "laceration", "minor_burns", "chemical_inhalation_mild", "orthopaedics", "minor_injuries"], "specialties": ["Emergency Department", "Orthopaedics", "General Surgery"], "helicopter_pad": false}'::jsonb, 'hospital');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'hospital', 'National Heart Centre Singapore (NHCS)', '{"lat": 1.2790, "lng": 103.8365}'::jsonb,
 '{"distance_km": 22, "travel_time_min": 25, "accepted_conditions": ["cardiac_arrest", "STEMI", "acute_coronary_syndrome", "arrhythmia"], "specialties": ["Cath Lab", "Cardiac ICU", "Interventional Cardiology"], "helicopter_pad": true}'::jsonb, 'hospital');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'hospital', 'KK Women''s and Children''s Hospital', '{"lat": 1.3100, "lng": 103.8465}'::jsonb,
 '{"distance_km": 25, "travel_time_min": 28, "accepted_conditions": ["obstetric_emergency", "paediatric", "premature_labour", "placental_abruption"], "specialties": ["Obstetrics", "Neonatal ICU", "Paediatric Emergency"], "helicopter_pad": false}'::jsonb, 'hospital');

-- Fire stations
INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'fire_station', 'Tuas Fire Station (SCDF 4th Division)', '{"lat": 1.3160, "lng": 103.6380}'::jsonb,
 '{"distance_km": 4, "travel_time_min": 6, "resources": ["2x Red Rhino pumpers", "1x HAZMAT vehicle", "1x rescue tender", "1x Medical Support Vehicle"], "is_primary_responder": true}'::jsonb, 'fire_station');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'fire_station', 'Jurong Fire Station (SCDF)', '{"lat": 1.3270, "lng": 103.7080}'::jsonb,
 '{"distance_km": 9, "travel_time_min": 12, "resources": ["2x pumpers", "1x rescue tender", "1x aerial platform"], "is_primary_responder": false, "role": "Second alarm reinforcement"}'::jsonb, 'fire_station');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'fire_station', 'SCDF DART Base (Civil Defence Academy)', '{"lat": 1.3445, "lng": 103.7590}'::jsonb,
 '{"distance_km": 16, "travel_time_min": 20, "resources": ["DART heavy rescue team", "K9 unit", "Structural assessment engineers", "Heavy lifting crane"], "is_primary_responder": false, "role": "DART deployment for structural collapse and heavy rescue"}'::jsonb, 'fire_station');

-- Police
INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'police_station', 'Jurong Police Division HQ', '{"lat": 1.3396, "lng": 103.7051}'::jsonb,
 '{"distance_km": 10, "travel_time_min": 14, "resources": ["Patrol cars", "SOC team", "Bomb disposal unit coordination"], "role": "Perimeter security, bomb scene investigation, traffic management"}'::jsonb, 'police_station');

-- Entry/exit points
INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'entry_point', 'Main Gate — Tuas South Avenue 10', '{"lat": 1.2830, "lng": 103.6340}'::jsonb,
 '{"access_status": "restricted", "notes": "Primary vehicle entry. Currently blocked by emergency vehicles. Guardhouse damaged by blast. Media and family members gathering here."}'::jsonb, 'entry_exit');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'entry_point', 'Rear Service Gate — Tuas Bay Close', '{"lat": 1.2840, "lng": 103.6360}'::jsonb,
 '{"access_status": "open", "notes": "Secondary vehicle access for heavy rescue equipment and HAZMAT teams. Less congested than main gate."}'::jsonb, 'entry_exit');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'assembly_point', 'Primary Assembly Point — Visitor Car Park', '{"lat": 1.2828, "lng": 103.6345}'::jsonb,
 '{"capacity": 200, "notes": "85 evacuees currently here. Upwind of ammonia plume. Designated muster point in Abbott ERP. May need to relocate if wind shifts."}'::jsonb, 'assembly_point');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'assembly_point', 'Secondary Assembly Point — Tuas Biomedical Park Gate', '{"lat": 1.2825, "lng": 103.6370}'::jsonb,
 '{"capacity": 150, "notes": "Alternative assembly point if primary becomes compromised by ammonia drift. 400m east of facility."}'::jsonb, 'assembly_point');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'staging_area', 'Emergency Staging Area — Loading Bay East', '{"lat": 1.2836, "lng": 103.6355}'::jsonb,
 '{"notes": "Designated staging area for incoming SCDF units. Clear access from Tuas Bay Close. Flat concrete apron suitable for ambulance marshalling and HAZMAT decon corridor."}'::jsonb, 'staging_area');

INSERT INTO scenario_locations (scenario_id, location_type, label, coordinates, conditions, pin_category) VALUES
(v_scenario_id, 'helipad', 'Helicopter LZ — Empty Lot Adjacent to Factory', '{"lat": 1.2822, "lng": 103.6340}'::jsonb,
 '{"notes": "Vacant lot south of Abbott complex. Flat grass area suitable for RSAF medevac helicopter. 50m x 50m clear area. Confirm no overhead power lines."}'::jsonb, 'helipad');


-- ============================================================
-- 6. UPDATE insider_knowledge with doctrines and facility intel
-- ============================================================

UPDATE scenarios
SET insider_knowledge = jsonb_build_object(
  'team_doctrines', jsonb_build_object(
    'Evacuation', jsonb_build_array(
      jsonb_build_object(
        'source', 'Singapore Civil Defence Force (SCDF) Emergency Response Plan (ERP) Evacuation Guidelines',
        'domain', 'Emergency Management',
        'key_points', jsonb_build_array(
          'Establish a Fire Safety Committee responsible for planning and executing evacuation procedures',
          'Ensure all staff are familiar with the locations of fire alarms and evacuation routes',
          'Conduct regular fire evacuation drills to maintain preparedness'
        ),
        'decision_thresholds', 'Immediate evacuation upon hearing fire alarm; assembly at designated points; no re-entry until clearance given by authorities',
        'site_requirements', jsonb_build_object('min_assembly_area_m2', 500, 'requires_upwind_position', true, 'requires_headcount_capability', true)
      ),
      jsonb_build_object(
        'source', 'National Incident Management System (NIMS) Incident Command System (ICS)',
        'domain', 'Incident Command',
        'key_points', jsonb_build_array(
          'Implement a standardized on-scene emergency management structure to coordinate response efforts',
          'Assign an Incident Commander to oversee operations and ensure clear communication among all teams',
          'Utilize ICS forms and protocols to document actions and decisions during the incident'
        ),
        'decision_thresholds', 'Activation of ICS upon incident occurrence; regular briefings and updates as the situation evolves',
        'site_requirements', jsonb_build_object('requires_command_post', true, 'requires_comms_equipment', true)
      ),
      jsonb_build_object(
        'source', 'Singapore Fire Safety Engineering Guidelines 2015',
        'domain', 'Fire Safety Engineering',
        'key_points', jsonb_build_array(
          'Provide smoke management systems to maintain tenable conditions during evacuation',
          'Ensure adequate ventilation in escape routes to prevent smoke accumulation',
          'Design evacuation routes to remain below thermal and toxicity thresholds for human safety'
        ),
        'decision_thresholds', 'Evacuation routes must maintain visibility >10m and air quality standards throughout the evacuation process; reroute if compromised',
        'site_requirements', jsonb_build_object('requires_ventilation', true, 'max_smoke_density', 0.5)
      )
    ),
    'Medical Triage', jsonb_build_array(
      jsonb_build_object(
        'source', 'Simple Triage and Rapid Treatment (START) Protocol',
        'domain', 'Emergency Medical Services',
        'key_points', jsonb_build_array(
          'Rapid assessment of victims based on respiration, perfusion, and mental status',
          'Categorization into four color-coded groups: Immediate (red), Delayed (yellow), Minor (green), and Deceased/Expectant (black)',
          'Designed for quick application by first responders to prioritize care in mass casualty incidents'
        ),
        'decision_thresholds', 'RED if respiratory rate >30/min, capillary refill >2s, or cannot follow commands; GREEN if ambulatory; BLACK if not breathing after airway repositioning',
        'site_requirements', jsonb_build_object('min_area_m2', 200, 'requires_water', true, 'requires_lighting', true)
      ),
      jsonb_build_object(
        'source', 'JumpSTART Pediatric Triage Algorithm',
        'domain', 'Emergency Medical Services',
        'key_points', jsonb_build_array(
          'Adaptation of START for pediatric patients, considering developmental differences',
          'Assessment includes ability to walk, respiratory rate, palpable pulse, and mental status'
        ),
        'decision_thresholds', 'RED if respiratory rate <15 or >45/min, no palpable pulse, or inappropriate response to pain',
        'site_requirements', jsonb_build_object('requires_paediatric_equipment', true)
      ),
      jsonb_build_object(
        'source', 'Singapore Civil Defence Force (SCDF) Medical Protocols',
        'domain', 'Emergency Medical Services',
        'key_points', jsonb_build_array(
          'Deployment of Medical Support Vehicles (MSVs) equipped to handle mass casualty incidents',
          'On-site stabilization and critical invasive medical treatment capabilities',
          'Capacity to treat up to 400 patients per vehicle'
        ),
        'decision_thresholds', 'Activate MSVs when casualty count exceeds 20 or local hospital surge capacity exceeded',
        'site_requirements', jsonb_build_object('min_area_m2', 400, 'requires_vehicle_access', true, 'requires_power', true)
      )
    ),
    'Media & Communications', jsonb_build_array(
      jsonb_build_object(
        'source', 'SS ISO 22320:2022 Security and Resilience — Emergency Management — Guidelines for Incident Management',
        'domain', 'Emergency Management',
        'key_points', jsonb_build_array(
          'Establishes principles for effective incident management, including clear communication channels and coordination among agencies',
          'Emphasizes the importance of timely and accurate information dissemination to the public during emergencies',
          'Provides guidelines for structuring incident management processes'
        ),
        'decision_thresholds', 'Immediate activation of communication protocols upon incident detection; continuous information updates at regular intervals as situation evolves',
        'site_requirements', jsonb_build_object('requires_media_staging_area', true, 'min_distance_from_scene_m', 200)
      ),
      jsonb_build_object(
        'source', 'ISO 22329:2022 Security and Resilience — Emergency Management — Guidelines for the Use of Social Media in Emergencies',
        'domain', 'Public Communication',
        'key_points', jsonb_build_array(
          'Provides guidance on leveraging social media platforms for effective public communication during emergencies',
          'Highlights the need for monitoring social media to counter misinformation and provide accurate updates',
          'Recommends establishing pre-defined social media strategies'
        ),
        'decision_thresholds', 'Activate social media communication within 15 minutes of incident confirmation; updates every 30 minutes or as new information becomes available',
        'site_requirements', jsonb_build_object('requires_internet_access', true, 'requires_spokesperson', true)
      ),
      jsonb_build_object(
        'source', 'SS 546:2022 Code of Practice for Emergency Voice Communication Systems in Buildings',
        'domain', 'Emergency Voice Communication Systems',
        'key_points', jsonb_build_array(
          'Sets requirements for planning, design, installation, maintenance, and testing of emergency voice communication systems',
          'Specifies protocols for broadcasting pre-recorded messages such as alert, evacuation, emergency, safe-to-stay, and false alarm',
          'Emphasizes importance of clear and consistent messaging to guide occupants'
        ),
        'decision_thresholds', 'Initiate appropriate pre-recorded message within 60 seconds of alarm activation; continuous broadcasting until situation resolved or re-evaluated',
        'site_requirements', jsonb_build_object('requires_pa_system', true, 'requires_backup_power', true)
      )
    ),
    'Hazards / Fire / Rescue', jsonb_build_array(
      jsonb_build_object(
        'source', 'Singapore Civil Defence Force (SCDF) Fire and Rescue Protocols',
        'domain', 'Fire and Rescue Operations',
        'key_points', jsonb_build_array(
          'Conduct immediate fire suppression to prevent escalation',
          'Perform search and rescue operations to locate and extricate victims',
          'Assess structural integrity to ensure safety for responders and survivors'
        ),
        'decision_thresholds', 'Initiate fire suppression within 5 minutes of arrival; complete primary search within 30 minutes; withdraw if structural integrity compromised',
        'site_requirements', jsonb_build_object('requires_water_supply', true, 'min_access_width_m', 3.5, 'requires_staging_area', true)
      ),
      jsonb_build_object(
        'source', 'SCDF Disaster Assistance and Rescue Team (DART) Guidelines',
        'domain', 'Urban Search and Rescue (USAR)',
        'key_points', jsonb_build_array(
          'Deploy specialized equipment for complex rescue scenarios',
          'Utilize K9 units for victim detection in debris',
          'Coordinate with medical teams for immediate casualty care post-extrication'
        ),
        'decision_thresholds', 'Deploy DART within 1 hour of incident notification; complete secondary search within 12 hours; abort if further collapse imminent',
        'site_requirements', jsonb_build_object('requires_heavy_equipment_access', true, 'requires_structural_engineer', true, 'min_area_m2', 500)
      ),
      jsonb_build_object(
        'source', 'SCDF Incident Management System (IMS)',
        'domain', 'Incident Command Structure',
        'key_points', jsonb_build_array(
          'Establish a unified command to coordinate all response teams',
          'Implement sectorization of the incident site for efficient management',
          'Ensure continuous communication between command and operational units'
        ),
        'decision_thresholds', 'Unified command established within 10 minutes of arrival; sectorization completed within 20 minutes; re-evaluate sector boundaries as situation evolves',
        'site_requirements', jsonb_build_object('requires_command_post', true, 'requires_radio_comms', true)
      )
    )
  ),
  'custom_facts', jsonb_build_array(
    jsonb_build_object(
      'topic', 'Milk Powder Dust Explosion Risk',
      'summary', 'Abbott''s packaging wing contains tonnes of fine milk powder (Similac, Ensure, PediaSure) with particle sizes around 30μm. The Minimum Explosible Concentration for milk powder is 60g/m³. A secondary dust explosion in the damaged packaging wing could be more destructive than the primary IED.',
      'detail', 'OSHA has documented multiple fatalities from milk powder dust explosions in manufacturing facilities. The 1980 incident at a milk replacer plant killed 1 and injured 8 when a conveyor ignited dust in a hopper. The confined volume of Abbott''s packaging hall would amplify overpressure to 7-10 bar — sufficient to demolish remaining structure and propagate into adjacent areas where rescue teams may be operating.'
    ),
    jsonb_build_object(
      'topic', 'Ammonia Refrigeration System',
      'summary', 'The cold storage area uses anhydrous ammonia (NH3) as a refrigerant — two 500kg compressor units. The IDLH for ammonia is 300ppm. One unit has a cracked high-pressure line venting at approximately 2kg/minute.',
      'detail', 'Ammonia at concentrations above 300ppm causes immediate pulmonary oedema and chemical burns to airways. At 500ppm+ it is rapidly fatal. Two cold storage technicians are trapped inside the contaminated zone. The prevailing NE wind is pushing the plume toward the staff canteen where 80+ workers have gathered.'
    ),
    jsonb_build_object(
      'topic', 'Chemical Storage — Hydrogen Peroxide and Chlorine Dioxide',
      'summary', 'Abbott uses 35% hydrogen peroxide and chlorine dioxide for Clean-In-Place (CIP) sanitation of production equipment. Multiple storage totes have toppled, creating an exothermic chemical reaction.',
      'detail', 'H2O2 reacting with organic residues (dried milk protein) generates pure oxygen, superheated steam, and temperatures exceeding 180°C. Adjacent chlorine dioxide drums will decompose at 40°C, releasing toxic chlorine gas. Standard water-based fire suppression will accelerate the H2O2 decomposition.'
    ),
    jsonb_build_object(
      'topic', 'Natural Gas Process Heating',
      'summary', 'Abbott uses natural gas piped underground for pasteurisation and spray-drying process heating. The blast ground-shock has fractured the 80mm main in the utilities corridor beneath the production hall.',
      'detail', 'Gas is migrating upward through cable ducts and floor penetrations. LEL readings in the utilities corridor are at 35% and climbing. This directly compounds the dust explosion risk. SP Group emergency shutoff is at the street boundary, 200m away.'
    ),
    jsonb_build_object(
      'topic', 'Workforce Profile',
      'summary', 'Abbott Tuas employs 1,100+ staff across multiple shifts. The workforce is highly diverse — Singaporean, Malaysian, Indian, Filipino, and Chinese PRC workers. Several contract worker teams (cleaning, security, maintenance) have limited English proficiency.',
      'detail', 'Communication during evacuation must account for Mandarin, Tamil, Malay, and Tagalog speakers. The night/weekend shift is smaller (~200 persons) while the day shift during production hours can have 400+ on-site including contractors and visitors.'
    ),
    jsonb_build_object(
      'topic', 'Abbott Product Sensitivity — Infant Formula Supply Chain',
      'summary', 'Abbott Tuas is Singapore''s primary Similac infant formula production facility and a major regional export hub. Extended shutdown has public health supply chain implications.',
      'detail', 'The 2022 Abbott Sturgis (Michigan) infant formula recall caused nationwide shortages in the US. A similar disruption at the Tuas plant would affect infant formula supply across Southeast Asia. This will generate intense media and political pressure for rapid resolution. HSA and MOH will be closely monitoring. This fact is for trainer awareness only — it should NOT be communicated to media during the incident.'
    )
  ),
  'baseline_escalation_factors', jsonb_build_array(
    jsonb_build_object(
      'id', 'dust_explosion_cascade',
      'name', 'Secondary Dust Explosion',
      'description', 'If ignition sources in the packaging wing are not eliminated before rescue teams enter, a secondary milk powder dust explosion could kill or injure rescue personnel and cause catastrophic structural collapse across multiple building sections.',
      'severity', 'critical'
    ),
    jsonb_build_object(
      'id', 'ammonia_cloud_spread',
      'name', 'Ammonia Cloud Expansion',
      'description', 'If the cracked ammonia line is not isolated within 45 minutes, the full 450kg charge will vent. The cloud will expand beyond the factory perimeter to Tuas South Avenue 10 and adjacent industrial premises, triggering a district-wide HAZMAT emergency.',
      'severity', 'critical'
    ),
    jsonb_build_object(
      'id', 'crush_syndrome_deaths',
      'name', 'Preventable Crush Syndrome Deaths',
      'description', 'Four warehouse workers are trapped under collapsed racking. If extricated without pre-treatment (IV fluids + bicarbonate), crush syndrome will cause fatal cardiac arrhythmias from hyperkalaemia within minutes of release.',
      'severity', 'high'
    ),
    jsonb_build_object(
      'id', 'gas_main_ignition',
      'name', 'Gas Main Ignition',
      'description', 'Natural gas leaking into the production hall through floor penetrations creates a compound risk with the existing milk powder dust cloud. If both are present when an ignition source activates, the resulting explosion would be orders of magnitude more powerful than the original IED.',
      'severity', 'critical'
    )
  )
)
WHERE id = v_scenario_id;

END $$;
