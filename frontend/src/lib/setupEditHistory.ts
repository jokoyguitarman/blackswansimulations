export interface EditHistoryRow {
  id: string;
  status: string;
  opened_by_admin: boolean;
  opened_by_name?: string | null;
  edit_number: number | null;
  created_at: string;
  applied_at: string | null;
  applied_summary?: unknown;
  error?: string | null;
}

const HIDDEN_FROM_TRAINERS = new Set(['abandoned', 'failed']);

/** Applied edits for everyone. Abandoned and failed edits for admins only. */
export function visibleEditHistory<T extends { status: string }>(rows: readonly T[], isAdmin: boolean): T[] {
  return rows.filter((row) => {
    if (row.status === 'open' || row.status === 'applying') return false;
    if (HIDDEN_FROM_TRAINERS.has(row.status)) return isAdmin;
    return row.status === 'applied';
  });
}

export function editHistoryWho(row: { opened_by_admin: boolean; opened_by_name?: string | null }): string {
  if (row.opened_by_admin) return 'Admin edit · not counted';
  const name = row.opened_by_name?.trim();
  return name || 'Trainer';
}

function count(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summaryRecord(summary: unknown): Record<string, unknown> | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  return summary as Record<string, unknown>;
}

/** One line from the stored apply summary. */
export function editHistoryLine(summary: unknown): string {
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  const row = summaryRecord(summary);
  if (!row) return 'Setup updated';
  const added = count(row, 'teams_added');
  const renamed = count(row, 'teams_succeeded');
  const retiredTeams = Math.max(0, count(row, 'teams_retired') - renamed);
  const injects = count(row, 'injects_retired') + count(row, 'injects_patched') + count(row, 'injects_added');
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} ${added === 1 ? 'team' : 'teams'} added`);
  if (renamed > 0) parts.push(`${renamed} renamed`);
  if (retiredTeams > 0) parts.push(`${retiredTeams} ${retiredTeams === 1 ? 'team' : 'teams'} removed`);
  if (injects > 0) parts.push(`${injects} ${injects === 1 ? 'inject' : 'injects'} updated`);
  if (row.primary_swap === true) parts.push('primary organisation changed');
  return parts.length > 0 ? parts.join(', ') : 'Setup updated';
}

export interface LobbyNoticeInput {
  summary: unknown;
}

function namesOrCount(names: unknown, fallback: number): string {
  if (Array.isArray(names)) {
    const listed = names.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    if (listed.length > 0) return listed.join(', ');
  }
  return String(fallback);
}

/**
 * Lobby sentence for edits applied after the session was created.
 * Name lists win when the summary has them; otherwise the apply counts are used.
 */
export function lobbySetupNotice(changes: readonly LobbyNoticeInput[]): string | null {
  if (changes.length === 0) return null;
  let added = 0;
  let renamed = 0;
  let removed = 0;
  let players = 0;
  const addedNames: string[] = [];
  const renamedNames: string[] = [];
  const removedNames: string[] = [];
  for (const change of changes) {
    const row = summaryRecord(change.summary);
    if (!row) continue;
    added += count(row, 'teams_added');
    renamed += count(row, 'teams_succeeded');
    removed += Math.max(0, count(row, 'teams_retired') - count(row, 'teams_succeeded'));
    players += count(row, 'unassigned_players');
    if (Array.isArray(row.new_teams)) addedNames.push(...row.new_teams.filter((item) => typeof item === 'string'));
    if (Array.isArray(row.renamed)) renamedNames.push(...row.renamed.filter((item) => typeof item === 'string'));
    if (Array.isArray(row.removed)) removedNames.push(...row.removed.filter((item) => typeof item === 'string'));
  }
  const parts = [
    `new teams ${namesOrCount(addedNames, added)}`,
    `renamed ${namesOrCount(renamedNames, renamed)}`,
    `removed ${namesOrCount(removedNames, removed)}`,
  ];
  return `Setup changed since this session was created: ${parts.join(', ')} (${players} players unassigned)`;
}
