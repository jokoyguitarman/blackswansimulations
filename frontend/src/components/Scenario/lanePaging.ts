/** Cards drawn before the lane asks the trainer to show another page. */
export const LANE_PAGE_SIZE = 12;

/** Rosters longer than this start collapsed. */
export const ROSTER_COLLAPSE_AT = 8;

export interface LaneCardRef {
  id: string;
  /** `data-field` prefixes that belong to this card (`org:id`, `team:id`). */
  fieldPrefixes: string[];
  search: string;
  teamCount?: number;
}

export type LaneName = 'orgs' | 'pressure' | 'rivals';

export interface FieldPlacement {
  lane: LaneName;
  /** 0-based page inside the unfiltered lane. */
  page: number;
  /** Organisation whose roster must be expanded before the field can scroll into view. */
  rosterId: string | null;
}

function matchesPrefix(field: string, prefix: string): boolean {
  return field === prefix || field.startsWith(`${prefix}:`);
}

/** 0-based page containing `index`, or null when the field is not on this lane. */
export function pageForField(
  field: string,
  cards: LaneCardRef[],
  pageSize = LANE_PAGE_SIZE,
): number | null {
  const index = cards.findIndex((card) =>
    card.fieldPrefixes.some((prefix) => matchesPrefix(field, prefix)),
  );
  if (index < 0) return null;
  const size = pageSize > 0 ? pageSize : LANE_PAGE_SIZE;
  return Math.floor(index / size);
}

/** Team-field or roster-field owner, when the jump has to open that roster. */
export function rosterIdForField(field: string): string | null {
  const team = /^team:([^:]+):/.exec(field);
  if (team) return team[1];
  const roster = /^org:([^:]+):roster$/.exec(field);
  return roster ? roster[1] : null;
}

/**
 * Which lane page holds a Setup issue. Pages are counted on the full lane,
 * so the caller clears a search before scrolling.
 */
export function locateField(
  field: string,
  lanes: Record<LaneName, LaneCardRef[]>,
  pageSize = LANE_PAGE_SIZE,
): FieldPlacement | null {
  const order: LaneName[] = ['orgs', 'pressure', 'rivals'];
  for (const lane of order) {
    const page = pageForField(field, lanes[lane], pageSize);
    if (page == null) continue;
    const rosterId = rosterIdForField(field);
    const card = rosterId ? lanes[lane].find((item) => item.id === rosterId) : undefined;
    const needsRoster = card != null && (card.teamCount ?? 0) > ROSTER_COLLAPSE_AT;
    return { lane, page, rosterId: needsRoster ? rosterId : null };
  }
  return null;
}

export function filterLane<T extends { search: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.search.toLowerCase().includes(q));
}

/** First `pagesShown` pages. `pagesShown` is how many times the lane has been opened, starting at 1. */
export function takeLanePages<T>(items: T[], pagesShown: number, pageSize = LANE_PAGE_SIZE): T[] {
  const pages = Number.isFinite(pagesShown) && pagesShown >= 1 ? Math.floor(pagesShown) : 1;
  const size = pageSize > 0 ? pageSize : LANE_PAGE_SIZE;
  return items.slice(0, pages * size);
}

export function laneShowsSearch(count: number, pageSize = LANE_PAGE_SIZE): boolean {
  return count > pageSize;
}
