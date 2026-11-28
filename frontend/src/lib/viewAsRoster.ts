/** A participant a staff member can open the desktop as. */
export interface ViewAsPlayer {
  userId: string;
  name: string;
  team: string;
  page: string;
}

const NO_TEAM = 'No team';
const NO_PAGE = 'No page';

export function viewAsBannerText(name: string, team: string): string {
  return `Viewing as ${name} (${team}) · read-only`;
}

export function viewAsOptionLabel(player: ViewAsPlayer): string {
  return `${player.name} (${player.team}) · ${player.page}`;
}

/** 200 means ENABLE_STAFF_VIEW_AS is on. Anything else hides the dropdown. */
export function staffViewVisible(status: number | null): boolean {
  return status === 200;
}

interface NamedPlayer {
  userId: string;
  name: string;
}

function rows(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && 'data' in body
      ? (body as { data: unknown }).data
      : null;
  if (!Array.isArray(list)) return [];
  return list.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Participants from the staff-view roster, with team from `/teams/session`
 * and the controlled page from `/social/pages`.
 */
export function buildViewAsRoster(input: {
  players: unknown;
  teams: unknown;
  pages: unknown;
}): ViewAsPlayer[] {
  const named = namedPlayers(input.players);
  const teamByUser = new Map<string, string>();
  for (const row of rows(input.teams)) {
    const userId = text(row.user_id);
    const team = text(row.team_name);
    if (userId && team && !teamByUser.has(userId)) teamByUser.set(userId, team);
  }
  const pageByUser = pageNames(input.pages);
  return named
    .map((player) => ({
      userId: player.userId,
      name: player.name || 'Player',
      team: teamByUser.get(player.userId) || NO_TEAM,
      page: pageByUser.get(player.userId) || NO_PAGE,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
}

function namedPlayers(body: unknown): NamedPlayer[] {
  const source =
    body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
  const list =
    source && typeof source === 'object' && 'players' in source
      ? (source as { players: unknown }).players
      : source;
  const players: NamedPlayer[] = [];
  if (!Array.isArray(list)) return players;
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const userId = text(record.user_id);
    if (!userId) continue;
    players.push({ userId, name: text(record.name) });
  }
  return players;
}

function pageNames(body: unknown): Map<string, string> {
  const names = new Map<string, string>();
  for (const group of rows(body)) {
    const display = text(group.display_name) || text(group.org_key);
    const controllers = Array.isArray(group.controllers) ? group.controllers : [];
    for (const controller of controllers) {
      const userId = text(controller);
      if (userId && display && !names.has(userId)) names.set(userId, display);
    }
  }
  return names;
}

export function viewedByText(names: readonly string[]): string {
  return names.length > 0 ? `Viewed by ${names.join(', ')}` : '';
}
