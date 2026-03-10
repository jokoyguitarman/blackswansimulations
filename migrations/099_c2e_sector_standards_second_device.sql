-- C2E: Append second-device cordon standard to sector_standards.
-- Run after 087. Idempotent: appends only if not already present.

DO $$
DECLARE
  scenario_uuid UUID;
  current_standards TEXT;
  second_device_text TEXT := ' Second device (suspected device near Exit B): cordon and clear the area before potential detonation. Minimum standoff 50 m; preferred 300 m for person-borne devices. If area is cleared before detonation, no additional casualties.';
BEGIN
  SELECT id, (insider_knowledge->>'sector_standards')::TEXT
  INTO scenario_uuid, current_standards
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '099: C2E scenario not found; skipping.';
    RETURN;
  END IF;

  IF current_standards IS NULL THEN
    current_standards := '';
  END IF;

  IF current_standards LIKE '%Second device%' OR current_standards LIKE '%Exit B%' THEN
    RAISE NOTICE '099: Second-device standard already in sector_standards; skipping.';
    RETURN;
  END IF;

  UPDATE scenarios
  SET insider_knowledge = jsonb_set(
    COALESCE(insider_knowledge, '{}'::jsonb),
    '{sector_standards}',
    to_jsonb((current_standards || second_device_text)::TEXT)
  )
  WHERE id = scenario_uuid;

  RAISE NOTICE '099: Appended second-device cordon standard to sector_standards.';
END $$;
