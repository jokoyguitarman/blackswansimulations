import type {
  SetupSnapshot,
  SnapshotCompetitor,
  SnapshotOrg,
  SnapshotPressure,
  SnapshotTeam,
} from './setupSnapshotCore.js';

/**
 * What changed between the frozen baseline and the edited setup.
 * Org keys are still the baseline keys: a primary swap is recorded here and
 * re-keyed later by the remap planner.
 */

export interface SetupDelta {
  added_orgs: string[];
  added_teams: Array<{ org_key: string; team_name: string }>;
  added_pressure: string[];
  added_rivals: string[];
  removed_orgs: string[];
  removed_teams: Array<{ team_uid: string; team_name: string }>;
  removed_pressure: string[];
  removed_rivals: string[];
  renamed_orgs: Array<{
    org_key: string;
    from: string;
    to: string;
    short_from?: string;
    short_to?: string;
  }>;
  renamed_teams: Array<{ team_uid: string; from: string; to: string }>;
  relocated_orgs: Array<{ org_key: string; from_country: string; to_country: string }>;
  changed_text: Array<{ key: string; field: string; team_uid?: string }>;
  primary_swap: { from_org_uid: string; to_org_uid: string; to_is_new: boolean } | null;
  brief_changed: boolean;
  new_countries: string[];
  vacated_countries: string[];
  becomes_multi_org: boolean;
  empty: boolean;
}

interface IndexedTeam {
  org_key: string;
  team: SnapshotTeam;
}

export function computeDelta(baseline: SetupSnapshot, edited: SetupSnapshot): SetupDelta {
  const baseOrgs = new Map(baseline.organisations.map((org) => [org.org_key, org]));
  const editOrgs = new Map(edited.organisations.map((org) => [org.org_key, org]));
  const baseTeams = indexTeams(baseline);
  const editTeams = indexTeams(edited);

  const added_orgs = edited.organisations
    .filter((org) => !baseOrgs.has(org.org_key))
    .map((org) => org.org_key);
  const removed_orgs = baseline.organisations
    .filter((org) => !editOrgs.has(org.org_key))
    .map((org) => org.org_key);

  const added_teams: SetupDelta['added_teams'] = [];
  const removed_teams: SetupDelta['removed_teams'] = [];
  const renamed_teams: SetupDelta['renamed_teams'] = [];
  for (const [id, team] of editTeams) {
    if (!baseTeams.has(id)) added_teams.push({ org_key: team.org_key, team_name: team.team.team_name });
  }
  for (const [id, team] of baseTeams) {
    const next = editTeams.get(id);
    if (!next) {
      removed_teams.push({ team_uid: team.team.team_uid || id, team_name: team.team.team_name });
      continue;
    }
    if (next.team.team_name !== team.team.team_name) {
      renamed_teams.push({
        team_uid: team.team.team_uid || id,
        from: team.team.team_name,
        to: next.team.team_name,
      });
    }
  }

  const added_pressure = keysAdded(baseline.pressure_organisations, edited.pressure_organisations);
  const removed_pressure = keysRemoved(baseline.pressure_organisations, edited.pressure_organisations);
  const added_rivals = keysAdded(baseline.competitors, edited.competitors);
  const removed_rivals = keysRemoved(baseline.competitors, edited.competitors);

  const renamed_orgs: SetupDelta['renamed_orgs'] = [];
  const relocated_orgs: SetupDelta['relocated_orgs'] = [];
  const changed_text: SetupDelta['changed_text'] = [];

  for (const org of baseline.organisations) {
    const next = editOrgs.get(org.org_key);
    if (!next) continue;
    if (org.display_name !== next.display_name || org.short_name !== next.short_name) {
      renamed_orgs.push({
        org_key: org.org_key,
        from: org.display_name,
        to: next.display_name,
        ...(org.short_name !== next.short_name
          ? { short_from: org.short_name, short_to: next.short_name }
          : {}),
      });
    }
    if (org.country !== next.country) {
      relocated_orgs.push({
        org_key: org.org_key,
        from_country: org.country,
        to_country: next.country,
      });
    }
    pushText(changed_text, org.org_key, 'city', org.city, next.city);
    pushText(changed_text, org.org_key, 'kind', org.kind, next.kind);
    pushText(changed_text, org.org_key, 'operation', org.operation, next.operation);
    pushText(changed_text, org.org_key, 'facebook_handle', org.facebook_handle, next.facebook_handle);
    pushText(changed_text, org.org_key, 'x_handle', org.x_handle, next.x_handle);
  }

  for (const [id, team] of baseTeams) {
    const next = editTeams.get(id);
    if (!next) continue;
    if (team.team.description !== next.team.description) {
      changed_text.push({
        key: next.org_key,
        field: 'description',
        team_uid: team.team.team_uid || id,
      });
    }
  }

  diffPressure(baseline.pressure_organisations, edited.pressure_organisations, changed_text);
  diffRivals(baseline.competitors, edited.competitors, changed_text);

  if (baseline.crisis.duration !== edited.crisis.duration) {
    changed_text.push({ key: 'crisis', field: 'duration' });
  }
  if (baseline.crisis.auto_antagonist !== edited.crisis.auto_antagonist) {
    changed_text.push({ key: 'crisis', field: 'auto_antagonist' });
  }

  const primary_swap = swapOf(baseline, edited);
  const brief_changed =
    baseline.crisis.crisis_type !== edited.crisis.crisis_type ||
    baseline.crisis.context !== edited.crisis.context ||
    (baseline.crisis.uploaded_doc_text_hash ?? null) !== (edited.crisis.uploaded_doc_text_hash ?? null);
  const baseCountries = countrySet(baseline.organisations);
  const editCountries = countrySet(edited.organisations);
  const new_countries = [...editCountries].filter((country) => !baseCountries.has(country)).sort();
  const vacated_countries = [...baseCountries].filter((country) => !editCountries.has(country)).sort();
  const becomes_multi_org = baseline.organisations.length <= 1 && edited.organisations.length > 1;

  const delta: SetupDelta = {
    added_orgs,
    added_teams,
    added_pressure,
    added_rivals,
    removed_orgs,
    removed_teams,
    removed_pressure,
    removed_rivals,
    renamed_orgs,
    renamed_teams,
    relocated_orgs,
    changed_text,
    primary_swap,
    brief_changed,
    new_countries,
    vacated_countries,
    becomes_multi_org,
    empty: false,
  };
  delta.empty =
    added_orgs.length === 0 &&
    added_teams.length === 0 &&
    added_pressure.length === 0 &&
    added_rivals.length === 0 &&
    removed_orgs.length === 0 &&
    removed_teams.length === 0 &&
    removed_pressure.length === 0 &&
    removed_rivals.length === 0 &&
    renamed_orgs.length === 0 &&
    renamed_teams.length === 0 &&
    relocated_orgs.length === 0 &&
    changed_text.length === 0 &&
    primary_swap === null &&
    !brief_changed &&
    new_countries.length === 0 &&
    vacated_countries.length === 0 &&
    !becomes_multi_org;
  return delta;
}

function indexTeams(snapshot: SetupSnapshot): Map<string, IndexedTeam> {
  const out = new Map<string, IndexedTeam>();
  for (const org of snapshot.organisations) {
    for (const team of org.teams) {
      const id = team.team_uid || `name:${org.org_key}:${team.team_name}`;
      out.set(id, { org_key: org.org_key, team });
    }
  }
  return out;
}

function keysAdded(
  baseline: ReadonlyArray<{ org_key: string }>,
  edited: ReadonlyArray<{ org_key: string }>,
): string[] {
  const have = new Set(baseline.map((org) => org.org_key));
  return edited.filter((org) => !have.has(org.org_key)).map((org) => org.org_key);
}

function keysRemoved(
  baseline: ReadonlyArray<{ org_key: string }>,
  edited: ReadonlyArray<{ org_key: string }>,
): string[] {
  const have = new Set(edited.map((org) => org.org_key));
  return baseline.filter((org) => !have.has(org.org_key)).map((org) => org.org_key);
}

function pushText(
  out: SetupDelta['changed_text'],
  key: string,
  field: string,
  from: string | undefined,
  to: string | undefined,
): void {
  if ((from ?? '') !== (to ?? '')) out.push({ key, field });
}

function diffPressure(
  baseline: readonly SnapshotPressure[],
  edited: readonly SnapshotPressure[],
  out: SetupDelta['changed_text'],
): void {
  const next = new Map(edited.map((org) => [org.org_key, org]));
  for (const org of baseline) {
    const editedOrg = next.get(org.org_key);
    if (!editedOrg) continue;
    pushText(out, org.org_key, 'display_name', org.display_name, editedOrg.display_name);
    pushText(out, org.org_key, 'wants', org.wants, editedOrg.wants);
    pushText(out, org.org_key, 'register', org.register, editedOrg.register);
    pushText(out, org.org_key, 'country', org.country, editedOrg.country);
    pushText(out, org.org_key, 'city', org.city, editedOrg.city);
    pushText(out, org.org_key, 'kind', org.kind, editedOrg.kind);
    pushText(out, org.org_key, 'facebook_handle', org.facebook_handle, editedOrg.facebook_handle);
    pushText(out, org.org_key, 'x_handle', org.x_handle, editedOrg.x_handle);
    if (!sameList(org.targets_org_keys, editedOrg.targets_org_keys)) {
      out.push({ key: org.org_key, field: 'targets_org_keys' });
    }
  }
}

function diffRivals(
  baseline: readonly SnapshotCompetitor[],
  edited: readonly SnapshotCompetitor[],
  out: SetupDelta['changed_text'],
): void {
  const next = new Map(edited.map((org) => [org.org_key, org]));
  for (const org of baseline) {
    const editedOrg = next.get(org.org_key);
    if (!editedOrg) continue;
    pushText(out, org.org_key, 'name', org.name, editedOrg.name);
    pushText(out, org.org_key, 'description', org.description, editedOrg.description);
    pushText(out, org.org_key, 'country', org.country, editedOrg.country);
    pushText(out, org.org_key, 'facebook_handle', org.facebook_handle, editedOrg.facebook_handle);
    pushText(out, org.org_key, 'x_handle', org.x_handle, editedOrg.x_handle);
  }
}

function sameList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function countrySet(orgs: readonly SnapshotOrg[]): Set<string> {
  return new Set(orgs.map((org) => org.country.trim()).filter((country) => country.length > 0));
}

function swapOf(
  baseline: SetupSnapshot,
  edited: SetupSnapshot,
): SetupDelta['primary_swap'] {
  const from = baseline.organisations.find((org) => org.is_primary);
  const to = edited.organisations.find((org) => org.is_primary);
  if (!from || !to) return null;
  const same =
    from.org_uid && to.org_uid ? from.org_uid === to.org_uid : from.org_key === to.org_key;
  if (same) return null;
  return {
    from_org_uid: from.org_uid,
    to_org_uid: to.org_uid,
    to_is_new: !baseline.organisations.some((org) => org.org_key === to.org_key),
  };
}
