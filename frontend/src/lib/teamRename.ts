import { TEAM_NAME_SEPARATOR, composeTeamName } from '@shared/teamNames';

export interface RenamableTeam {
  team_name: string;
  description: string;
  is_custom: boolean;
  is_public_voice: boolean;
  team_uid?: string;
  function_key?: string;
  display_name?: string;
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
      display_name: composeTeamName(functionKeyOf(team), { short_name: shortName.trim() }, multiOrg),
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
