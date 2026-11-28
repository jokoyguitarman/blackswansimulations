/** The link stored on a wizard draft when a setup edit is open. */
export interface SetupEditLink {
  edit_id: string;
  scenario_id: string;
  scenario_title: string;
  /** Null for an admin, whose edits are not counted. */
  remaining: number | null;
  draft_id?: string | null;
}

export interface EditModeFlags {
  editMode: boolean;
  /** An open edit whose draft was never stored. Offer abandon and start again. */
  missingDraft: boolean;
  adminEdit: boolean;
  /** The organisation currently in the primary slot cannot be removed. */
  primaryRemoveDisabled: boolean;
  primaryRemoveTitle: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readSetupEditLink(input: unknown): SetupEditLink | null {
  const row = record(record(input)?.setup_edit);
  if (!row) return null;
  const editId = typeof row.edit_id === 'string' ? row.edit_id.trim() : '';
  const scenarioId = typeof row.scenario_id === 'string' ? row.scenario_id.trim() : '';
  if (!editId || !scenarioId) return null;
  const remaining =
    typeof row.remaining === 'number' && Number.isFinite(row.remaining) ? row.remaining : null;
  return {
    edit_id: editId,
    scenario_id: scenarioId,
    scenario_title: typeof row.scenario_title === 'string' ? row.scenario_title : '',
    remaining,
    draft_id: typeof row.draft_id === 'string' ? row.draft_id : null,
  };
}

export function editModeFlags(input: {
  link: SetupEditLink | null;
  /** True when the open row has no draft to resume. */
  draftMissing: boolean;
  makePrimaryKey: string | null;
}): EditModeFlags {
  const editMode = input.link != null;
  return {
    editMode,
    missingDraft: editMode && input.draftMissing,
    adminEdit: editMode && input.link?.remaining == null,
    primaryRemoveDisabled: editMode,
    primaryRemoveTitle: input.makePrimaryKey
      ? 'The primary organisation cannot be removed.'
      : 'Make another organisation primary first',
  };
}

/** Players-operated cards that are not the current primary can take the primary slot. */
export function canMakePrimary(input: { operation?: string; isCurrentPrimary: boolean }): boolean {
  if (input.isCurrentPrimary) return false;
  return input.operation !== 'ai';
}

/** An organisation that was already on the scenario when the edit opened. */
export function isExistingOrg(orgKey: string | undefined, baselineKeys: ReadonlySet<string>): boolean {
  return typeof orgKey === 'string' && orgKey.length > 0 && baselineKeys.has(orgKey);
}

/** A team that was already on the scenario when the edit opened. */
export function isExistingTeam(teamUid: string | undefined, baselineUids: ReadonlySet<string>): boolean {
  return typeof teamUid === 'string' && teamUid.length > 0 && baselineUids.has(teamUid);
}

/** Baseline teams present in `before` and absent from `after`. New teams are ignored. */
export function removedExistingTeams<T extends { team_uid?: string }>(
  before: readonly T[],
  after: readonly T[],
  baselineUids: ReadonlySet<string>,
): T[] {
  const kept = new Set(after.map((team) => team.team_uid).filter((uid): uid is string => !!uid));
  return before.filter((team) => isExistingTeam(team.team_uid, baselineUids) && !kept.has(team.team_uid as string));
}

function keysOf(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const key = (item as Record<string, unknown>)[field];
    if (typeof key === 'string' && key.trim()) keys.push(key);
  }
  return keys;
}

/** Org keys and team uids frozen on the draft the edit opened with. */
export function baselineIdentity(input: Record<string, unknown>): {
  orgKeys: string[];
  teamUids: string[];
} {
  const orgKeys = [
    ...(typeof input.primary_org_key === 'string' && input.primary_org_key ? [input.primary_org_key] : []),
    ...keysOf(input.extra_organisations, 'org_key'),
    ...keysOf(input.pressure_organisations, 'org_key'),
    ...keysOf(input.competitor_entries, 'org_key'),
  ];
  const teamUids = [
    ...keysOf(input.team_roster, 'team_uid'),
    ...(Array.isArray(input.extra_organisations)
      ? input.extra_organisations.flatMap((org) =>
          org && typeof org === 'object' ? keysOf((org as { team_roster?: unknown }).team_roster, 'team_uid') : [],
        )
      : []),
  ];
  return { orgKeys, teamUids };
}
