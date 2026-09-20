-- Migration 206: scenario_injects.generation_source — admit values the server already writes.
-- The CHECK was last asserted in 162 with 15 values. Four writers have since appeared whose value
-- was never added, so their inserts failed with a logged warning and no row:
--   'stakeholder_modified' — stakeholderReconsiderationService.enforceVerdict (`modify` verdict copy)
--   'decision_consequence' — heatMeterService.generateDecisionConsequence
--   'sentiment_negative'   — heatMeterService.nudgePublicSentiment
--   'transport_outcome'    — transportOutcomeService
-- Full list re-asserted (never drop values). Idempotent.
BEGIN;

ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS scenario_injects_generation_source_check;
ALTER TABLE scenario_injects ADD CONSTRAINT scenario_injects_generation_source_check CHECK (generation_source IN (
  'migration',
  'war_room',
  'trainer',
  'pathway_outcome',
  'inaction_penalty',
  'decision_response',
  'matrix_friction',
  'specificity_feedback',
  'adversary_adaptation',
  'pursuit_branch',
  'witness_relay',
  'deterioration_cycle',
  'sentiment_positive',
  'protocol_violation',
  'editorial_feedback',
  -- admitted by 206
  'stakeholder_modified',
  'decision_consequence',
  'sentiment_negative',
  'transport_outcome'
));

COMMIT;
