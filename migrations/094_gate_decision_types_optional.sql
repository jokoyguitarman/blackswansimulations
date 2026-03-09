-- Make decision_types optional for all gates. AI content analysis (content_hints) is now the primary classifier.
-- Empty decision_types means any decision from the team can satisfy the gate if it passes the content check.

UPDATE scenario_gates
SET condition = jsonb_set(
  COALESCE(condition, '{}'::jsonb),
  '{decision_types}',
  '[]'::jsonb
)
WHERE condition ? 'decision_types'
  AND jsonb_array_length(COALESCE(condition->'decision_types', '[]'::jsonb)) > 0;
