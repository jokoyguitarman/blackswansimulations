-- Allow duplicate inject titles per scenario (AI can generate similarly-titled injects for different phases)
ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS uq_scenario_injects_secneario_title;
ALTER TABLE scenario_injects DROP CONSTRAINT IF EXISTS uq_scenario_injects_scenario_title;
