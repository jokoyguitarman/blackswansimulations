-- Re-assert the session_events event_type CHECK constraint.
--
-- Migration 156 already includes 'message' in this list, but the deployed
-- database was found rejecting 'message' inserts (discovered during the
-- 2026-07-02 load test: every chat message logged
-- "violates check constraint session_events_event_type_check", which also
-- silently suppressed the session-room broadcast until eventService.ts was
-- hardened). The deployed constraint therefore predates the current 156 list.
-- This migration is idempotent and safe to run regardless of which version
-- is live: it simply recreates the constraint with the authoritative list.

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
    'direction_intent'
  ));
