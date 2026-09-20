-- Migration 201: stakeholder reconsideration verdicts + new session event types.
-- Runtime plan §3.5. Idempotent.

CREATE TABLE IF NOT EXISTS inject_verdicts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id          UUID NOT NULL REFERENCES scenario_injects(id) ON DELETE CASCADE,
  stakeholder_id     TEXT NOT NULL,
  verdict            TEXT NOT NULL CHECK (verdict IN ('keep', 'modify', 'delay', 'cancel')),
  reason             TEXT NOT NULL,
  criteria_met       JSONB NOT NULL DEFAULT '[]',
  modified_content   TEXT,
  delay_minutes      INTEGER,
  credited_team      TEXT,
  contributing_teams TEXT[] DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inject_verdicts_latest
  ON inject_verdicts (session_id, inject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inject_verdicts_stakeholder
  ON inject_verdicts (session_id, stakeholder_id);

ALTER TABLE inject_verdicts ENABLE ROW LEVEL SECURITY;
-- Service-role only.

-- session_events: full list from migration 190
--   + inject_modified / inject_delayed / stakeholder_verdict (this feature)
--   + the event types the server already inserts but 190 omitted, so those inserts stopped
--     failing silently: trainer_alert (feedEngineService), consequence_inject
--     (ambientContentService — the trainer dashboard queries it), antagonist_post /
--     antagonist_reply (antagonistEngineService), extremist_post / extremist_reply
--     (extremistHiveService), director_action (scenarioDirectorService), evaluator_result
--     (decisionEvaluationOrchestrator).
ALTER TABLE session_events
  DROP CONSTRAINT IF EXISTS session_events_event_type_check;

ALTER TABLE session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    'decision',
    'decision_executed',
    'inject',
    'inject_cancelled',
    'ai_step_start',
    'ai_step_end',
    'communication',
    'resource_change',
    'status_update',
    'incident',
    'media_post',
    'message',
    'bomb_squad_sweep',
    'patient_queue_processed',
    'hazard_queue_processed',
    'quality_failure_inject_fired',
    'zone_skip_violation',
    'friction_inject_fired',
    'state_effect_managed',
    'direction_intent',
    'trainer_alert',
    'consequence_inject',
    'antagonist_post',
    'antagonist_reply',
    'extremist_post',
    'extremist_reply',
    'director_action',
    'evaluator_result',
    'inject_modified',
    'inject_delayed',
    'stakeholder_verdict'
  ));
