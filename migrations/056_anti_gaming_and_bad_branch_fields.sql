-- Migration D: Anti-gaming and bad-branch fields (revertible via 056_down)
-- Adds: if_vague_decision_inject_id, objective_id on scenario_gates; required_gate_not_met_id on scenario_injects

-- scenario_gates: inject to fire when decision is vague and gate is not_met; link to objective for skip progress
ALTER TABLE scenario_gates
  ADD COLUMN IF NOT EXISTS if_vague_decision_inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS objective_id TEXT;

COMMENT ON COLUMN scenario_gates.if_vague_decision_inject_id IS 'When a decision in this gate scope is executed, gate is not_met, and content check fails, publish this inject (rate-limited).';
COMMENT ON COLUMN scenario_gates.objective_id IS 'Objective to block positive progress for when gate is not_met and decision is vague (e.g. evacuation).';

-- scenario_injects: publish at trigger_time only when this gate is NOT met (bad branch timeline)
ALTER TABLE scenario_injects
  ADD COLUMN IF NOT EXISTS required_gate_not_met_id UUID REFERENCES scenario_gates(id) ON DELETE SET NULL;

COMMENT ON COLUMN scenario_injects.required_gate_not_met_id IS 'Publish this inject at trigger_time only when the referenced gate status is not_met for the session.';
