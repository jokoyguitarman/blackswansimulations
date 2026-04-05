-- Allow patient/hazard queue processing event types + other missing types
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
