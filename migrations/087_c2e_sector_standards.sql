-- C2E: Add sector_standards and baseline_escalation_factors to insider_knowledge.
-- Sector standards (ICS/WHO/ICRC-UNOCHA) are used to calibrate robustness, environmental consistency, and relevance.
-- Baseline escalation factors seed session_escalation_factors so impact matrix and AI consider these risks from the start.
-- Idempotent: merges into existing insider_knowledge; safe to re-run.

DO $$
DECLARE
  scenario_uuid UUID;
  sector_text TEXT := 'Evacuation (ICS): marshal-to-evacuee ratio 1:10–20; predefined, congestion-managed routes; assembly area capacity at least 125% of expected evacuees. Triage (WHO MCI): triage staff-to-critical patient ratio 1:5; use START protocol; triage zone capacity ~50 patients; real-time communication with nearby hospitals. Media (ICRC/UNOCHA): one designated spokesperson; safe media zone for briefings; coordinated updates every 1–2 hours.';
  baseline_factors JSONB := '[
    {"id": "EF-baseline-assembly", "name": "Overcrowding at assembly area", "description": "Assembly or holding area capacity or 125% rule not respected; evacuee count exceeds safe capacity, increasing panic and disorder.", "severity": "high"},
    {"id": "EF-baseline-marshal", "name": "No clear marshal-to-evacuee ratio", "description": "Evacuation plan does not specify marshal-to-evacuee ratio (ICS: 1 per 10–20); order at exits and holding areas at risk.", "severity": "medium"},
    {"id": "EF-baseline-triage-ratio", "name": "Triage staff or zone capacity not specified", "description": "No staff-to-critical patient ratio (WHO: 1:5) or triage zone capacity (~50); risk of overload and delayed care.", "severity": "high"},
    {"id": "EF-baseline-media-spokesperson", "name": "No designated media spokesperson", "description": "No single designated spokesperson (ICRC/UNOCHA); mixed or conflicting messages and loss of public trust.", "severity": "medium"}
  ]'::jsonb;
BEGIN
  SELECT id INTO scenario_uuid
  FROM scenarios
  WHERE title = 'C2E Bombing at Community Event'
  LIMIT 1;

  IF scenario_uuid IS NULL THEN
    RAISE NOTICE '087: C2E scenario not found; skipping sector standards.';
    RETURN;
  END IF;

  UPDATE scenarios
  SET insider_knowledge = COALESCE(insider_knowledge, '{}'::jsonb) || jsonb_build_object(
    'sector_standards', sector_text,
    'baseline_escalation_factors', baseline_factors
  )
  WHERE id = scenario_uuid;

  RAISE NOTICE '087: C2E sector_standards and baseline_escalation_factors merged into insider_knowledge.';
END $$;
