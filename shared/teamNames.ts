/**
 * Team-name composition shared by the wizard and the organisation model.
 * Pure: no imports, so the frontend (`@shared/teamNames`) and the server
 * (`../../shared/teamNames.js`) can use the same function.
 */

/** scenario_teams.team_name is VARCHAR(100). */
export const TEAM_NAME_MAX = 100;
/** Em dash with spaces, the separator between a function and an org short name. */
export const TEAM_NAME_SEPARATOR = ' \u2014 ';

/**
 * Single-org scenarios keep the bare function. Multi-org appends the org's
 * short name and truncates it so the result fits VARCHAR(100).
 */
export function composeTeamName(
  functionKey: string,
  org: { short_name: string },
  multiOrg: boolean,
): string {
  if (!multiOrg) return functionKey;
  const budget = TEAM_NAME_MAX - functionKey.length - TEAM_NAME_SEPARATOR.length;
  const short = budget > 0 ? org.short_name.slice(0, budget) : '';
  return short
    ? `${functionKey}${TEAM_NAME_SEPARATOR}${short}`
    : functionKey.slice(0, TEAM_NAME_MAX);
}
