-- Allow session_events to record inject cancellations (AI decided not to publish a scheduled inject)
-- Constraint name may vary; drop by finding the check on event_type
ALTER TABLE session_events
  DROP CONSTRAINT IF EXISTS session_events_event_type_check;

ALTER TABLE session_events
  ADD CONSTRAINT session_events_event_type_check CHECK (event_type IN (
    'decision',
    'inject',
    'inject_cancelled',
    'communication',
    'resource_change',
    'status_update',
    'incident',
    'media_post'
  ));

COMMENT ON COLUMN session_events.event_type IS 'inject_cancelled = scheduled inject was not published because AI determined recent decisions made it obsolete';
