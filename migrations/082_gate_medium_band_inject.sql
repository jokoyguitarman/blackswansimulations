-- Add if_medium_band_inject_id to scenario_gates for three-band grading (medium = specific but did not consult Insider or no match).

ALTER TABLE scenario_gates
  ADD COLUMN IF NOT EXISTS if_medium_band_inject_id UUID REFERENCES scenario_injects(id) ON DELETE SET NULL;

COMMENT ON COLUMN scenario_gates.if_medium_band_inject_id IS 'When a decision in this gate scope is executed, gate is not_met, and content is adequate but does not use Insider intel (or team did not consult), publish this inject (rate-limited).';
