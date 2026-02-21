-- De-escalation factors and pathways: what helps mitigate and how situation improves when mitigated
-- session_escalation_factors: add de_escalation_factors (what helps mitigate)
-- session_escalation_pathways: add de_escalation_pathways (how situation improves; optional emerging_challenges)

ALTER TABLE session_escalation_factors
  ADD COLUMN IF NOT EXISTS de_escalation_factors JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN session_escalation_factors.de_escalation_factors IS 'De-escalation factors (what helps mitigate); array of {id, name, description}';

ALTER TABLE session_escalation_pathways
  ADD COLUMN IF NOT EXISTS de_escalation_pathways JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN session_escalation_pathways.de_escalation_pathways IS 'De-escalation pathways (how situation improves when mitigated); array of {pathway_id, trajectory, mitigating_behaviours[], emerging_challenges[]?}';
