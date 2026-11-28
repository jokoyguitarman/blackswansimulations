import {
  estimateBuildCalls,
  type BuildEstimateInput,
  type BuildEstimateOptions,
} from '@shared/buildEstimate';
import { spilloverCountryNames, type SpilloverCountry } from '@shared/generationBudgets';
import type { OrganisationDraft, RosterEntry } from './OrganisationRosterBuilder';
import { PRESET_TEAM_NAMES, isSendablePressureOrg, type SetupSnapshot } from './setupValidation';

export interface SetupCost {
  calls: number;
  playerTeams: number;
  input: BuildEstimateInput;
}

function isCustomTeam(team: RosterEntry): boolean {
  const name = team.team_name.trim();
  return team.is_custom || !PRESET_TEAM_NAMES.includes(name);
}

function customCount(roster: RosterEntry[]): number {
  return roster.filter(isCustomTeam).length;
}

/**
 * Counts for `estimateBuildCalls` from the Setup the trainer is looking at.
 * Response-branch parents do not exist yet, so `injectsEstimate` is 0 and the
 * line does not include those compile calls.
 */
export function setupEstimateInput(
  snapshot: SetupSnapshot,
  footprint?: { countries: readonly SpilloverCountry[] } | null,
): BuildEstimateInput {
  const extras: OrganisationDraft[] = snapshot.extras;
  const rosters = [snapshot.primary.roster, ...extras.map((org) => org.team_roster)];
  const teams = rosters.reduce((sum, roster) => sum + roster.length, 0);
  const protagonistCountries = [snapshot.primary.country, ...extras.map((org) => org.country)]
    .map((country) => country.trim())
    .filter(Boolean);
  const pressure = snapshot.pressure.filter(isSendablePressureOrg);
  const pressureCountries = new Set(
    pressure.map((group) => group.country.trim()).filter(Boolean),
  );
  return {
    countries: new Set(protagonistCountries).size,
    orgs: extras.length + 1,
    teams,
    customTeams: rosters.reduce((sum, roster) => sum + customCount(roster), 0),
    alliesAndRivals: extras.length + snapshot.competitors.length,
    pressureCountries: pressureCountries.size,
    pressureOrgs: pressure.length,
    spilloverCountries: spilloverCountryNames(
      footprint?.countries ?? [],
      protagonistCountries,
      pressure.map((group) => group.country.trim()),
    ).length,
    injectsEstimate: 0,
  };
}

/** Player-run teams: the headquarters roster plus every office that is not AI-operated. */
export function playerRunTeams(snapshot: SetupSnapshot): number {
  const extras = snapshot.extras
    .filter((org) => org.operation !== 'ai')
    .reduce((sum, org) => sum + org.team_roster.length, 0);
  return snapshot.primary.roster.length + extras;
}

export function formatSetupCost(calls: number, playerTeams: number): string {
  const callWord = calls === 1 ? 'AI call' : 'AI calls';
  const teamWord = playerTeams === 1 ? 'player-run team' : 'player-run teams';
  const playerWord = playerTeams === 1 ? 'player' : 'players';
  return `About ${calls} ${callWord} · ${playerTeams} ${teamWord} (needs at least ${playerTeams} ${playerWord})`;
}

export function setupCost(
  snapshot: SetupSnapshot,
  options?: Partial<BuildEstimateOptions>,
  footprint?: { countries: readonly SpilloverCountry[] } | null,
): SetupCost {
  const input = setupEstimateInput(snapshot, footprint);
  return {
    calls: estimateBuildCalls(input, options),
    playerTeams: playerRunTeams(snapshot),
    input,
  };
}
