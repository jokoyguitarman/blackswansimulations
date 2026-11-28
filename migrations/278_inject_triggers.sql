-- Migration 278: inject trigger records and cross-team guard events.
-- NOT APPLIED. Applying this to the shared Supabase project needs the user's explicit approval.
-- Idempotent: safe to run twice.
-- Rollback (branch or local database only, never the shared project):
--   DROP TABLE IF EXISTS inject_triggers;
--   ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;
--   ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
--     'decision', 'decision_executed', 'inject', 'inject_cancelled', 'ai_step_start', 'ai_step_end',
--     'communication', 'resource_change', 'status_update', 'incident', 'media_post', 'message',
--     'bomb_squad_sweep', 'patient_queue_processed', 'hazard_queue_processed',
--     'quality_failure_inject_fired', 'zone_skip_violation', 'friction_inject_fired',
--     'state_effect_managed', 'direction_intent',
--     'trainer_alert', 'consequence_inject', 'antagonist_post', 'antagonist_reply',
--     'extremist_post', 'extremist_reply', 'director_action', 'evaluator_result',
--     'inject_modified', 'inject_delayed', 'stakeholder_verdict',
--     'decision_recorded', 'obligation_met', 'obligation_lapsed',
--     'decision_detected', 'decision_propagated', 'decision_dismissed', 'decision_reversed',
--     'pressure_post', 'pressure_reply', 'pressure_stand_down',
--     'start_with_unfilled', 'call_taker_changed'
--   ));
BEGIN;

CREATE TABLE IF NOT EXISTS inject_triggers (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id         UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inject_id          UUID NOT NULL REFERENCES scenario_injects(id) ON DELETE CASCADE,
  inject_key         TEXT NOT NULL,
  minute             INTEGER NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN (
                       'timed','conditional','dependency','chain','mood','decision','director','trainer'
                     )),
  met_keys           TEXT[] NOT NULL DEFAULT '{}',
  key_details        JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_teams       TEXT[] NOT NULL DEFAULT '{}',
  target_teams       TEXT[] NOT NULL DEFAULT '{}',
  dep_id             TEXT,
  cause_depth        INTEGER NOT NULL DEFAULT 0,
  parent_inject_keys TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, inject_id)
);

CREATE INDEX IF NOT EXISTS idx_inject_triggers_session_minute
  ON inject_triggers (session_id, minute);

ALTER TABLE inject_triggers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inject_triggers FROM anon, authenticated;

-- Full list from migration 271, plus dependency and cross-team guard events.
ALTER TABLE session_events DROP CONSTRAINT IF EXISTS session_events_event_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
  'decision', 'decision_executed', 'inject', 'inject_cancelled', 'ai_step_start', 'ai_step_end',
  'communication', 'resource_change', 'status_update', 'incident', 'media_post', 'message',
  'bomb_squad_sweep', 'patient_queue_processed', 'hazard_queue_processed',
  'quality_failure_inject_fired', 'zone_skip_violation', 'friction_inject_fired',
  'state_effect_managed', 'direction_intent',
  'trainer_alert', 'consequence_inject', 'antagonist_post', 'antagonist_reply',
  'extremist_post', 'extremist_reply', 'director_action', 'evaluator_result',
  'inject_modified', 'inject_delayed', 'stakeholder_verdict',
  'decision_recorded', 'obligation_met', 'obligation_lapsed',
  'decision_detected', 'decision_propagated', 'decision_dismissed', 'decision_reversed',
  'pressure_post', 'pressure_reply', 'pressure_stand_down',
  'start_with_unfilled', 'call_taker_changed',
  'dependency_changed', 'cross_team_deferred', 'cross_team_held'
));

COMMIT;
