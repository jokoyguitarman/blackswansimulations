-- Double trigger_time_minutes for all scheduled injects except the initial (T+0) ones.
-- This stretches the inject timeline to match the longer expected game duration.
UPDATE scenario_injects
SET    trigger_time_minutes = trigger_time_minutes * 2
WHERE  trigger_time_minutes IS NOT NULL
  AND  trigger_time_minutes > 0
  AND  ai_generated = false;
