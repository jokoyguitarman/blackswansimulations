/** session_teams.team_name is stored without leading or trailing whitespace. */
export function normalizeSessionTeamName(name: string): string {
  return name.trim();
}
