-- Expand content_hints for triage and evac gates so SITREPs with varied phrasing pass.
-- Triage: add sitrep, area, corridor, access, evacuation, ambulance, hospital, capacity
-- Evac: add exits, cordon, assembly, staging, evacuee, marshal, corridor, flow rate

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, scenario_id, gate_id, condition
    FROM scenario_gates
    WHERE gate_id IN ('triage_situation_report', 'evac_situation_report')
  LOOP
    IF r.gate_id = 'triage_situation_report' THEN
      UPDATE scenario_gates
      SET condition = jsonb_set(
        condition,
        '{content_hints}',
        '["triage", "casualty", "zone", "area", "route", "situation report", "sitrep", "corridor", "access", "evacuation", "ambulance", "hospital", "capacity"]'::jsonb
      )
      WHERE id = r.id;
    ELSIF r.gate_id = 'evac_situation_report' THEN
      UPDATE scenario_gates
      SET condition = jsonb_set(
        condition,
        '{content_hints}',
        '["exit", "exits", "ground zero", "situation", "evacuation plan", "flow", "cordon", "assembly", "staging", "evacuee", "marshal", "corridor", "flow rate"]'::jsonb
      )
      WHERE id = r.id;
    END IF;
  END LOOP;
  RAISE NOTICE '095: Expanded content_hints for triage and evac gates';
END $$;
