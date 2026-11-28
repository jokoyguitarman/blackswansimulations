export interface OrphanChoiceInput {
  choice: string;
  inject_key?: string;
  team_name?: string;
  org_keys?: string[];
}

/** Orphans that still have no decision. Apply stays disabled while this list is non-empty. */
export function unresolvedOrphanIds(
  orphans: readonly { id: string }[],
  decisions: Readonly<Record<string, OrphanChoiceInput | undefined>>,
): string[] {
  return orphans
    .filter((orphan) => {
      const decision = decisions[orphan.id];
      return !decision || decision.choice.trim().length === 0;
    })
    .map((orphan) => orphan.id);
}

export function applyBlocked(input: { unresolved: readonly string[]; planning: boolean }): boolean {
  return input.planning || input.unresolved.length > 0;
}

export function orphanChoiceLabel(choice: string): string {
  return choice.replaceAll('_', ' ');
}
