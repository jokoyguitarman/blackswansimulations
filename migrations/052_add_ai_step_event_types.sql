-- Allow session_events to record AI step start/end for backend activity visibility
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
    'media_post'
  ));

COMMENT ON COLUMN session_events.event_type IS 'ai_step_start/ai_step_end = AI pipeline step visibility for trainer backend activity panel';
