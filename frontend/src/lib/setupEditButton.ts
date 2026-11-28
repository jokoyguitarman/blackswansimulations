export interface SetupEditButtonInput {
  /** False when the flag is off or migration 274 is absent. */
  enabled: boolean;
  /** Null for an admin, whose edits are unlimited and not counted. */
  remaining: number | null;
  limit: number;
  locked: boolean;
  lockTitle?: string;
  /** Signed-in user. Compared with the open edit's opened_by. */
  viewerId?: string | null;
  /** role === 'admin'. An admin may discard someone else's open edit. */
  isAdmin?: boolean;
  /** The viewer created this scenario, so they may discard someone else's open edit. */
  isCreator?: boolean;
  openEdit?: {
    status: string;
    opened_by: string | null;
    opened_by_name?: string | null;
  } | null;
}

export interface SetupEditButtonState {
  visible: boolean;
  disabled: boolean;
  label: string;
  title: string;
  /**
   * Set when a click must confirm, abandon that edit, then open a fresh one.
   * Null means the click opens or resumes as usual.
   */
  discardConfirm: string | null;
}

const HIDDEN: SetupEditButtonState = {
  visible: false,
  disabled: true,
  label: '',
  title: '',
  discardConfirm: null,
};

/** Display name for the person holding an edit the viewer does not own. */
function setupEditHolderName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : 'another user';
}

function allowanceState(input: SetupEditButtonInput): SetupEditButtonState {
  if (input.remaining == null) {
    return {
      visible: true,
      disabled: input.locked,
      label: 'Edit setup',
      title: input.locked ? (input.lockTitle ?? 'Editing is locked') : 'Edit setup',
      discardConfirm: null,
    };
  }
  const remaining = Math.max(0, input.remaining);
  const usedUp = remaining === 0;
  const disabled = input.locked || usedUp;
  let title = 'Edit setup';
  if (input.locked) title = input.lockTitle ?? 'Editing is locked';
  else if (usedUp) title = `All ${input.limit} setup edits used. Ask an admin.`;
  return {
    visible: true,
    disabled,
    label: `Edit setup · ${remaining} left`,
    title,
    discardConfirm: null,
  };
}

/**
 * Library "Edit setup" control. Decides whether the button shows, why it is
 * disabled, and when a click discards someone else's unapplied edit first.
 * The page opens or resumes the wizard from the click.
 */
export function setupEditButtonState(input: SetupEditButtonInput): SetupEditButtonState {
  if (!input.enabled) return HIDDEN;

  const open = input.openEdit;
  if (open?.status === 'applying') {
    return {
      ...allowanceState(input),
      disabled: true,
      title: 'An edit is being applied',
      discardConfirm: null,
    };
  }

  const mine = !!input.viewerId && open?.opened_by === input.viewerId;
  if (open?.status === 'open' && !mine) {
    const name = setupEditHolderName(open.opened_by_name);
    const label = `Edit in progress · ${name}`;
    const base = allowanceState(input);
    const canDiscard = input.isAdmin === true || input.isCreator === true;
    // A locked card, or a trainer with no edits left, cannot open a replacement.
    // Discarding first would throw the other person's edit away and then fail.
    if (canDiscard && !base.disabled) {
      return {
        visible: true,
        disabled: false,
        label,
        title: label,
        discardConfirm: `Discard ${name}'s unapplied setup edit? Their changes will be lost.`,
      };
    }
    return {
      visible: true,
      disabled: true,
      label,
      title: canDiscard ? base.title : `${name} has a setup edit open`,
      discardConfirm: null,
    };
  }

  return allowanceState(input);
}
