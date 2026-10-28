/**
 * Booth links (docs/booth/live-booth-spec.md): fixed join tokens starting `dnx-` that walk-up visitors
 * scan at the D:NEXA booth. Sessions holding one are booth worlds, where the join, briefing and page
 * rules make allowances for visitors who arrive mid-story with no trainer around.
 */
export function isBoothJoinToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith('dnx-');
}

/** The opening paragraph of a scenario description: the situation, without the later developments. */
export function openingParagraph(description: string | null | undefined): string | null {
  const first = (description ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find(Boolean);
  return first || null;
}
