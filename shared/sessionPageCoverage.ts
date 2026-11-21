// Pure; no imports. Used by the session start gate (server) and the lobby (frontend).

export const PAGES_UNASSIGNED = 'PAGES_UNASSIGNED';

export interface CoveragePageInput {
  org_key: string;
  display_name?: string | null;
  page_name?: string | null;
  is_primary?: boolean | null;
  role?: string | null;
  control_mode?: string | null;
  operation?: string | null;
}

export interface CoverageControllerInput {
  user_id: string;
  org_key: string;
}

export interface CoverageParticipantInput {
  user_id: string;
  role?: string | null;
  full_name?: string | null;
  is_bot?: boolean | null;
}

export interface PageAssignee {
  user_id: string;
  full_name: string;
  is_bot: boolean;
}

export interface PageCoverageItem {
  org_key: string;
  display_name: string;
  is_primary: boolean;
  assignees: PageAssignee[];
}

export interface PageCoverage {
  covered: boolean;
  pages: PageCoverageItem[];
  uncovered: PageCoverageItem[];
}

/** Protagonist pages run by players. Rival, pressure and AI-operated pages never need a player. */
export function isPlayerRunPage(page: CoveragePageInput): boolean {
  return (
    (page.role ?? 'protagonist') === 'protagonist' &&
    page.operation !== 'ai' &&
    page.control_mode !== 'ai'
  );
}

export function computePageCoverage(input: {
  pages: readonly CoveragePageInput[];
  controllers: readonly CoverageControllerInput[];
  participants: readonly CoverageParticipantInput[];
  trainerId?: string | null;
}): PageCoverage {
  const eligible = new Map<string, CoverageParticipantInput>();
  for (const p of input.participants) {
    if (p.role === 'observer') continue;
    if (input.trainerId && p.user_id === input.trainerId) continue;
    eligible.set(p.user_id, p);
  }

  const byKey = new Map<string, PageCoverageItem>();
  for (const page of input.pages) {
    if (!page.org_key || !isPlayerRunPage(page)) continue;
    const existing = byKey.get(page.org_key);
    if (existing) {
      if (page.is_primary) existing.is_primary = true;
      continue;
    }
    byKey.set(page.org_key, {
      org_key: page.org_key,
      display_name: page.display_name || page.page_name || page.org_key,
      is_primary: Boolean(page.is_primary),
      assignees: [],
    });
  }

  for (const c of input.controllers) {
    const item = byKey.get(c.org_key);
    const who = eligible.get(c.user_id);
    if (!item || !who || item.assignees.some((a) => a.user_id === c.user_id)) continue;
    item.assignees.push({
      user_id: c.user_id,
      full_name: who.full_name || 'Unknown',
      is_bot: Boolean(who.is_bot),
    });
  }

  const pages = [...byKey.values()].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) || a.display_name.localeCompare(b.display_name),
  );
  const uncovered = pages.filter((p) => p.assignees.length === 0);
  return { covered: uncovered.length === 0, pages, uncovered };
}

/** One sentence for banners and API errors. Names up to three pages. */
export function pageCoverageMessage(uncovered: readonly { display_name: string }[]): string {
  const n = uncovered.length;
  if (n === 0) return '';
  const names = uncovered
    .slice(0, 3)
    .map((p) => p.display_name)
    .join(', ');
  const more = n > 3 ? ` and ${n - 3} more` : '';
  return `Can't start yet: ${n} page${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} nobody assigned (${names}${more}). Assign a player or an AI teammate to every page.`;
}
