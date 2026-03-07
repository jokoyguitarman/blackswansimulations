-- Short, generic team briefs for C2E lobby (no clues on what to ask or deliver).
-- Used when briefing API returns team-based brief from session_teams.

UPDATE scenarios
SET role_specific_briefs = jsonb_build_object(
  'evacuation', 'You are on the Evacuation team. Your role will become clearer as the scenario progresses.',
  'triage', 'You are on the Triage team. Your role will become clearer as the scenario progresses.',
  'media', 'You are on the Media team. Your role will become clearer as the scenario progresses.'
)
WHERE title = 'C2E Bombing at Community Event';
