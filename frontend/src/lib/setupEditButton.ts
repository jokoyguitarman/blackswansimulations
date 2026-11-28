export interface SetupEditButtonInput {
  /** False when the flag is off or migration 274 is absent. */
  enabled: boolean;
  /** Null for an admin, whose edits are unlimited and not counted. */
  remaining: number | null;
  limit: number;
  locked: boolean;
  lockTitle?: string;
}

export interface SetupEditButtonState {
  visible: boolean;
  disabled: boolean;
  label: string;
  title: string;
}

/**
 * Library "Edit setup" control. Decides whether the button shows and why it
 * is disabled. The page opens or resumes the wizard from the click.
 */
export function setupEditButtonState(input: SetupEditButtonInput): SetupEditButtonState {
  if (!input.enabled) {
    return { visible: false, disabled: true, label: '', title: '' };
  }
  if (input.remaining == null) {
    return {
      visible: true,
      disabled: input.locked,
      label: 'Edit setup',
      title: input.locked ? (input.lockTitle ?? 'Editing is locked') : 'Edit setup',
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
  };
}
