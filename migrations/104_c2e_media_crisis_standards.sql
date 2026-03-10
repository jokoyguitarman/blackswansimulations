-- C2E: Crisis media management standards – sector_standards, gate content_hints, vague inject.
-- Run after 101. Idempotent.

DO $$
DECLARE
  scenario_uuid UUID;
  current_standards TEXT;
  media_crisis_text TEXT := ' Media (JIC / crisis bombing): Statement within 15 min; one designated spokesperson; verify before release; avoid speculation on perpetrators; regular updates 30–60 min; media zone 100–150 m from incident; no victim names until families notified; no unconfirmed suspect identity; transparent calm tone; correct misinformation promptly.';
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '104: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  -- ============================================
  -- 1. Append crisis media standards to sector_standards
  -- ============================================
  SELECT (insider_knowledge->>'sector_standards')::TEXT INTO current_standards
  FROM scenarios WHERE id = scenario_uuid;

  IF current_standards IS NULL THEN
    current_standards := '';
  END IF;

  IF current_standards NOT LIKE '%verify before release%' AND current_standards NOT LIKE '%designated spokesperson%' THEN
    UPDATE scenarios
    SET insider_knowledge = jsonb_set(
      COALESCE(insider_knowledge, '{}'::jsonb),
      '{sector_standards}',
      to_jsonb((current_standards || media_crisis_text)::TEXT)
    )
    WHERE id = scenario_uuid;
    RAISE NOTICE '104: Appended crisis media standards to sector_standards.';
  END IF;

  -- ============================================
  -- 2. Expand media gate content_hints
  -- ============================================
  UPDATE scenario_gates
  SET condition = jsonb_set(
    COALESCE(condition, '{}'::jsonb),
    '{content_hints}',
    '["statement", "public", "verified", "facts", "misinformation", "spokesperson", "one voice", "confirmed", "cannot confirm", "investigating", "public safety", "avoid area", "next update", "media zone", "100m", "150m", "victim dignity", "no names"]'::jsonb
  )
  WHERE scenario_id = scenario_uuid AND gate_id = 'media_first_statement';

  -- ============================================
  -- 3. Update media vague inject content
  -- ============================================
  UPDATE scenario_injects
  SET content = 'The public statement submitted does not cite verified facts or address misinformation clearly. Please specify: incident confirmation, what is confirmed vs unknown, public safety instructions, next update timing, and designated spokesperson.'
  WHERE scenario_id = scenario_uuid
    AND title = 'Statement too vague – cite verified facts';

  RAISE NOTICE '104: C2E media crisis standards applied.';
END $$;
