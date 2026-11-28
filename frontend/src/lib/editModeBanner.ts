const MODIFY_TOOLTIP = 'Make a separate new scenario (uses a scenario credit)';

/**
 * Banner on every wizard step. An admin edit is not counted. For a trainer,
 * N is this edit's number and M is how many remain after it is applied.
 */
export function editBannerText(input: {
  title: string;
  editNumber: number;
  limit: number;
  remaining: number | null;
}): string {
  const title = input.title.trim() || 'this scenario';
  if (input.remaining == null) return `Editing setup of ${title}: Admin edit: not counted`;
  const number = Math.max(1, input.editNumber);
  const limit = Math.max(0, input.limit);
  const leftAfter = Math.max(0, input.remaining - 1);
  return `Editing setup of ${title}: edit ${number} of ${limit} (${leftAfter} left after this)`;
}

/** This open edit is number `used + 1`. Remaining is the allowance before apply. */
export function editNumberFromAllowance(used: number, remaining: number | null, limit: number): number {
  if (remaining == null) return used + 1;
  return Math.max(1, limit - remaining + 1);
}

export function remainingBesideApply(remaining: number | null): string {
  if (remaining == null) return 'Admin edit: not counted';
  const left = Math.max(0, remaining - 1);
  return left === 1 ? '1 left after this' : `${left} left after this`;
}

export function recompileTooltips(input: {
  enabled: boolean;
  remaining: number | null;
  limit: number;
}): { modify: string; edit: string | null } {
  if (!input.enabled) return { modify: MODIFY_TOOLTIP, edit: null };
  if (input.remaining == null) {
    return { modify: MODIFY_TOOLTIP, edit: 'Change this scenario in place (admin edits are not counted)' };
  }
  const left = Math.max(0, input.remaining);
  const limit = Math.max(0, input.limit);
  return {
    modify: MODIFY_TOOLTIP,
    edit: `Change this scenario in place (${left} of ${limit} edits left)`,
  };
}

export function makePrimaryNote(name: string): string {
  const who = name.trim() || 'this organisation';
  return `The story will be re-centred on ${who}. The War Room revises the narrative, briefing and the content it wrote; your edits are kept and flagged if they conflict. Players assigned to pages keep them.`;
}

export const BRIEF_EDIT_NOTE =
  "Changing the brief revises only content the War Room wrote and you haven't edited.";
