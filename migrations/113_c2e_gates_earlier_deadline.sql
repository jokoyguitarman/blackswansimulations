-- Move C2E gate deadlines to within the first 5 minutes.
-- Previously: evac T+8, triage T+10, media T+12 — too late in a 60-min game.
-- Now all three team gates check at T+5 so teams must act immediately.
-- The second_device_defused gate (T+20) is unchanged since it's a mid-game event.

UPDATE scenario_gates
SET check_at_minutes = 5
WHERE gate_id IN ('evac_situation_report', 'triage_situation_report', 'media_first_statement');
