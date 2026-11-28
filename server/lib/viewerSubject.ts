/**
 * The view-as subject is the same identity `requireAuth` builds for that player:
 * profile name first, then auth metadata, then email. An empty `full_name` must
 * not collapse to "Player", because messenger threads are keyed by that handle.
 */

export interface ViewerProfile {
  role?: string | null;
  agency_name?: string | null;
  full_name?: string | null;
}

export interface ViewerAccount {
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface ViewerSubject {
  id: string;
  email?: string;
  role?: string;
  agency?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Same merge as `requireAuth`: app metadata wins, then the profile row. */
export function mergeViewerSubject(
  id: string,
  account: ViewerAccount | null,
  profile: ViewerProfile | null,
): ViewerSubject {
  const app = account?.app_metadata ?? undefined;
  const meta = account?.user_metadata ?? undefined;
  let role = text(app?.role) || undefined;
  let agency = text(app?.agency) || undefined;
  if (profile && !role) {
    role = text(profile.role) || undefined;
    agency = text(profile.agency_name) || undefined;
  }
  const displayName = text(profile?.full_name) || text(meta?.full_name) || undefined;
  const email = text(account?.email) || undefined;
  return {
    id,
    email,
    role,
    agency,
    displayName,
    metadata: meta ?? {},
  };
}

export interface StaffViewStamp {
  staffUserId: string;
  lastAt: string;
}

/** One label per staff member, most recently active first. */
export function viewedByLabels(
  rows: readonly StaffViewStamp[],
  names: ReadonlyMap<string, string>,
): string[] {
  const latest = new Map<string, string>();
  for (const row of rows) {
    const prev = latest.get(row.staffUserId);
    if (prev == null || row.lastAt > prev) latest.set(row.staffUserId, row.lastAt);
  }
  return [...latest.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0] < b[0] ? -1 : 1))
    .map(([id]) => names.get(id) || 'Staff');
}
