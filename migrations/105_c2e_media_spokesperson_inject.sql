-- C2E: Condition-driven inject asking Media team who is the designated spokesperson.
-- Fires when a statement has been issued but no spokesperson has been designated.

DO $$
DECLARE
  scenario_uuid UUID;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '105: C2E Bombing scenario not found; skipping.';
    RETURN;
  END IF;

  INSERT INTO scenario_injects (
    scenario_id, trigger_time_minutes, conditions_to_appear, conditions_to_cancel,
    eligible_after_minutes, type, title, content, severity,
    inject_scope, target_teams, requires_response, requires_coordination
  )
  SELECT
    scenario_uuid, NULL,
    '{"all": ["media_statement_issued", "media_no_spokesperson_designated"]}'::jsonb,
    '["media_spokesperson_designated"]'::jsonb,
    14,
    'field_update',
    'Coordination centre: Who is the designated spokesperson?',
    'Your statement has been issued, but the coordination centre needs to know: who is the single designated spokesperson for this incident? JIC standards require one voice to avoid mixed or conflicting messages. Please confirm the spokesperson and ensure all media inquiries are channelled through them.',
    'medium',
    'team_specific', ARRAY['media'], true, false
  WHERE NOT EXISTS (
    SELECT 1 FROM scenario_injects
    WHERE scenario_id = scenario_uuid AND title = 'Coordination centre: Who is the designated spokesperson?'
  );

  RAISE NOTICE '105: Added condition-driven media spokesperson inject.';
END $$;
