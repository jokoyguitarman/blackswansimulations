/**
 * Copies spokesperson links onto the cards the wizard currently holds.
 * Never adds, drops or reorders cards. Matched by display name, case-insensitively.
 * Shared by the wizard and the durable build's pages stage.
 */
export function mergeSpokespersonLinks<
  T extends { display_name: string; org_key?: string; spokesperson_stakeholder_id?: string },
>(
  drafts: T[],
  wire: Array<{ display_name: string; org_key: string; spokesperson_stakeholder_id?: string }>,
): T[] {
  return drafts.map((draft) => {
    const match = wire.find(
      (w) => w.display_name.trim().toLowerCase() === draft.display_name.trim().toLowerCase(),
    );
    return match
      ? {
          ...draft,
          org_key: match.org_key,
          spokesperson_stakeholder_id: match.spokesperson_stakeholder_id,
        }
      : draft;
  });
}
