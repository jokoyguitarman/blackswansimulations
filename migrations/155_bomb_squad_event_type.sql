-- Allow 'bomb_squad_sweep' in session_events event_type CHECK
ALTER TABLE session_events
  DROP CONSTRAINT IF EXISTS session_events_event_type_check;

ALTER TABLE session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    'decision',
    'inject',
    'inject_cancelled',
    'ai_step_start',
    'ai_step_end',
    'communication',
    'resource_change',
    'status_update',
    'incident',
    'media_post',
    'bomb_squad_sweep'
  ));
