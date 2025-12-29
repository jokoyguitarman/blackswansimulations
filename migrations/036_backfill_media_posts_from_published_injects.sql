-- Migration 036: Backfill media posts from previously published injects
-- Creates media posts for injects that were published before the auto-creation feature was added

-- Map inject type to media source and platform (matching the logic in server/routes/injects.ts)
-- Create media posts for injects of type media_report, citizen_call, or political_pressure
-- that were published (have session_events) but don't have corresponding media posts

INSERT INTO media_posts (
  session_id,
  source,
  headline,
  content,
  sentiment,
  is_misinformation,
  platform,
  author,
  ai_generated,
  created_at
)
SELECT DISTINCT
  se.session_id,
  -- Map inject type to source
  CASE 
    WHEN si.type = 'media_report' THEN 'News Media'
    WHEN si.type = 'citizen_call' THEN 'Citizen Report'
    WHEN si.type = 'political_pressure' THEN 'Political News'
    ELSE 'News Media'
  END as source,
  si.title as headline,
  si.content as content,
  'neutral' as sentiment, -- Default to neutral (matches new inject logic)
  false as is_misinformation, -- Default to false
  -- Map inject type to platform for backward compatibility
  CASE 
    WHEN si.type = 'media_report' THEN 'news'
    WHEN si.type = 'citizen_call' THEN 'citizen_report'
    WHEN si.type = 'political_pressure' THEN 'news'
    ELSE 'news'
  END as platform,
  -- Use source as author for backward compatibility
  CASE 
    WHEN si.type = 'media_report' THEN 'News Media'
    WHEN si.type = 'citizen_call' THEN 'Citizen Report'
    WHEN si.type = 'political_pressure' THEN 'Political News'
    ELSE 'News Media'
  END as author,
  COALESCE(si.ai_generated, false) as ai_generated,
  se.created_at -- Use the inject published timestamp
FROM session_events se
INNER JOIN scenario_injects si ON si.id = (se.metadata->>'inject_id')::uuid
WHERE se.event_type = 'inject'
  AND si.type IN ('media_report', 'citizen_call', 'political_pressure')
  -- Only create media posts if one doesn't already exist for this inject in this session
  -- Match by session_id, headline (title), and similar content to avoid duplicates
  AND NOT EXISTS (
    SELECT 1 
    FROM media_posts mp 
    WHERE mp.session_id = se.session_id 
      AND mp.headline = si.title
      AND mp.created_at >= se.created_at - INTERVAL '5 minutes'
      AND mp.created_at <= se.created_at + INTERVAL '5 minutes'
  );

-- Log the results
DO $$
DECLARE
  inserted_count INTEGER;
BEGIN
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Backfill Results for Media Posts:';
  RAISE NOTICE '  Media posts created: %', inserted_count;
  RAISE NOTICE '========================================';
END $$;

