-- Remove keyword-based area_cleared / area_not_cleared branching from the
-- second device detonation injects. The AI adversary engine now determines
-- the outcome (populated vs cleared) by reading all player decisions.
--
-- 1. "Second device detonates (area populated)" keeps only gate_not_met condition.
-- 2. "Second device detonates (area cleared)" is deleted — the adversary engine
--    generates an appropriate adaptation inject when teams cleared the area.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '119: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  -- Remove area_not_cleared from the populated variant's conditions
  UPDATE scenario_injects
  SET conditions_to_appear = '{"all": ["gate_not_met:second_device_defused"]}'::jsonb
  WHERE scenario_id = scenario_uuid
    AND title = 'Second device detonates (area populated)';

  -- Delete the cleared variant — adversary engine handles this outcome
  DELETE FROM scenario_injects
  WHERE scenario_id = scenario_uuid
    AND title = 'Second device detonates (area cleared)';

  RAISE NOTICE '119: Removed area_cleared branching from C2E second device injects.';
END $$;
