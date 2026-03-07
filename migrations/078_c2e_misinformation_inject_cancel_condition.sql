-- Phase 5: Allow "Misinformation still unaddressed" inject to cancel when Media team has addressed misinformation.
-- Condition key media_misinformation_addressed is true when media_state.misinformation_addressed === true
-- (set by updateTeamStateFromDecision when Media decision is classified as misinformation_management or matches keywords).

UPDATE scenario_injects
SET conditions_to_cancel = COALESCE(conditions_to_cancel, '[]'::jsonb) || '["media_misinformation_addressed"]'::jsonb
WHERE scenario_id = (SELECT id FROM scenarios WHERE title = 'C2E Bombing at Community Event' LIMIT 1)
  AND title = 'Misinformation still unaddressed'
  AND (conditions_to_cancel IS NULL OR NOT (conditions_to_cancel @> '["media_misinformation_addressed"]'::jsonb));
