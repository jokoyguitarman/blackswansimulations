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
