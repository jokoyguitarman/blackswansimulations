-- Rollback Migration D: remove anti-gaming and bad-branch columns

ALTER TABLE scenario_injects
  DROP COLUMN IF EXISTS required_gate_not_met_id;

ALTER TABLE scenario_gates
  DROP COLUMN IF EXISTS if_vague_decision_inject_id,
  DROP COLUMN IF EXISTS objective_id;
