-- Rollback base gates: drop required_gate_id, session_gate_progress, scenario_gates

ALTER TABLE scenario_injects
  DROP COLUMN IF EXISTS required_gate_id;

DROP TABLE IF EXISTS session_gate_progress;
DROP TABLE IF EXISTS scenario_gates;
