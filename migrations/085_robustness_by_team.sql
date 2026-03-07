-- Add robustness_by_team to session_impact_matrix for evac/triage rate modulation.
-- Shape: { "Evacuation": 7, "Triage": 6, "Media": 8 } (average robustness per team in the window).

ALTER TABLE session_impact_matrix
  ADD COLUMN IF NOT EXISTS robustness_by_team JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN session_impact_matrix.robustness_by_team IS 'Per-team average robustness (1-10) from decisions in this evaluation window; used by inject scheduler for evac rate and triage rate modulation.';
