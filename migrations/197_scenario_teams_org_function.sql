-- Migration 197: multi-organisation team identity (generator-owned; contract §5.2)
-- (a) org_key: which organisation (initial_state.orgs[].org_key, protagonist) a team belongs to.
--     NULL = single-org scenario / team spans all organisations / field-ops scenario.
-- (b) function_key: what kind of team it is, independent of its (possibly composed) name:
--     a catalog name (Communications, Procurement, Sales, Legal, Executive) or a stable slug for
--     a recurring custom function (Investigations, Operations, ...). NULL = custom team without a
--     recognised function. Runtime resolves everything about a team via
--     resolveTeamFunction(team) = function_key ?? team_name.
-- team_name stays the identity; UNIQUE(scenario_id, team_name) is unchanged.
BEGIN;

ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS org_key TEXT;
ALTER TABLE scenario_teams ADD COLUMN IF NOT EXISTS function_key TEXT;

-- Legacy rows: catalog-named teams get their function; everything else stays NULL (custom).
UPDATE scenario_teams
   SET function_key = team_name
 WHERE function_key IS NULL
   AND team_name IN ('Communications', 'Procurement', 'Sales', 'Legal');

CREATE INDEX IF NOT EXISTS idx_scenario_teams_org ON scenario_teams(scenario_id, org_key);

COMMIT;
