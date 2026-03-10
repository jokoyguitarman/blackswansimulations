-- Set decision_types to [] for evac and triage gates so decisions with type=null can satisfy them.
-- The media gate already has decision_types: []; evac and triage had restrictive types that excluded
-- sit reps when the decision.type field was null (e.g. when AI classification runs at execution).

UPDATE scenario_gates
SET condition = jsonb_set(
  COALESCE(condition, '{}'::jsonb),
  '{decision_types}',
  '[]'::jsonb
)
WHERE gate_id IN ('evac_situation_report', 'triage_situation_report')
  AND (
    condition->'decision_types' IS NOT NULL
    AND jsonb_array_length(COALESCE(condition->'decision_types', '[]'::jsonb)) > 0
  );
