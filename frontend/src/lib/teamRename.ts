/** Same separator and cap as `composeTeamName` in the organisation model. */
const TEAM_NAME_MAX = 100;
const TEAM_NAME_SEPARATOR = ' \u2014 ';

export interface RenamableTeam {
  team_name: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
  team_uid?: string;
  function_key?: string;
  display_name?: string;
}

export function composeEditedTeamName(functionKey: string, shortName: string, multiOrg: boolean): string {
  if (!multiOrg) return functionKey;
  const budget = TEAM_NAME_MAX - functionKey.length - TEAM_NAME_SEPARATOR.length;
  const short = budget > 0 ? shortName.slice(0, budget) : '';
  return short ? `${functionKey}${TEAM_NAME_SEPARATOR}${short}` : functionKey.slice(0, TEAM_NAME_MAX);
}

function functionKeyOf(team: RenamableTeam): string {
  if (team.function_key?.trim()) return team.function_key.trim();
  const head = team.team_name.split(TEAM_NAME_SEPARATOR)[0]?.trim();
  return head || team.team_name;
}

/** Existing teams take the new short name. New teams are left for the build to name. */
export function withRenamedTeams(
  roster: readonly RenamableTeam[],
  shortName: string,
  multiOrg: boolean,
): RenamableTeam[] {
  return roster.map((team) => {
    if (!team.team_uid) return { ...team };
    return {
      ...team,
      display_name: composeEditedTeamName(functionKeyOf(team), shortName.trim(), multiOrg),
    };
  });
}

export function withoutRenamedTeams(roster: readonly RenamableTeam[]): RenamableTeam[] {
  return roster.map((team) => {
    if (!team.team_uid || !team.display_name) return { ...team };
    const next = { ...team };
    delete next.display_name;
    return next;
  });
}
